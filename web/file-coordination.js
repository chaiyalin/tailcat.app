// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause
import { NativeFileStream, NativeFileError } from "./native-file-stream.js";
import { newFileAttemptId } from "./file-transfer-state.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ID = /^[0-9a-f]{32}$/u;
const NETWORK_ERRORS = new Set(["CHANNEL_CLOSED", "CHANNEL_ERROR", "TRANSFER_STALLED"]);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
export function deadline(promise, ms, code = "RESULT_UNCONFIRMED") {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new NativeFileError(code)), ms);
  })]).finally(() => clearTimeout(timer));
}

// A dedicated, already-authorized Tailcat file stream. Only negotiated peers
// enter this envelope after TCF1 ACCEPT. RPCs and bounded relay bytes share it;
// the file body remains TCF1 on either returned byte stream.
export class FileCoordination {
  constructor(connection, { signal = () => {}, authorized = () => true, readInitial = null } = {}) {
    this.connection = connection;
    this.signal = signal;
    this.authorized = authorized;
    this.readInitial = readInitial;
    this.pending = new Map();
    this.handlers = new Map();
    this.channels = new Map();
    this.writeTail = Promise.resolve();
    this.queuedBytes = 0;
    this.closed = false;
    this.finished = deferred();
    this.ended = deferred();
    this.pump = this.readLoop().catch(() => this.close());
  }
  async exact(size) {
    const result = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const chunk = await this.connection.read(Math.min(64 * 1024, size - offset));
      if (!(chunk instanceof Uint8Array) || !chunk.length || chunk.length > size - offset) throw new Error("COORDINATION_EOF");
      result.set(chunk, offset); offset += chunk.length;
    }
    return result;
  }
  async readLoop() {
    while (!this.closed) {
      let frame;
      if (this.readInitial) {
        const initial = this.readInitial; this.readInitial = null;
        frame = await initial();
      } else {
        const header = await this.exact(5);
        const length = new DataView(header.buffer).getUint32(1);
        if (header[0] !== 1 || length < 2 || length > 65536) throw new Error("COORDINATION_FRAME");
        frame = await this.exact(length);
      }
      if (!this.authorized()) throw new Error("AUTHORIZATION_EXPIRED");
      if (frame[0] === 1) {
        const meta = JSON.parse(decoder.decode(frame.subarray(1)));
        if (meta.v !== 1) throw new Error("COORDINATION_VERSION");
        if (meta.response) {
          const pending = this.pending.get(meta.response);
          if (pending) {
            this.pending.delete(meta.response);
            if (meta.error) pending.reject(new NativeFileError("PEER_REJECTED"));
            else pending.resolve(meta.value);
          }
        } else if (meta.notify === "SIGNAL") {
          Promise.resolve(this.signal(meta.value)).catch(() => this.close());
        } else if (meta.notify === "FINISHED") {
          this.finished.resolve();
        } else if (ID.test(meta.request) && this.handlers.has(meta.method)) {
          // Never await a handler on the read pump: a handler may need a
          // response or an old writer to stop before replying.
          if ((this.handling || 0) >= 8) throw new Error("COORDINATION_BUSY");
          this.handling = (this.handling || 0) + 1;
          void Promise.resolve().then(() => this.handlers.get(meta.method)(meta.value))
            .then((value) => this.control({ response: meta.request, value }),
              () => this.control({ response: meta.request, error: true }))
            .catch(() => this.close()).finally(() => { this.handling--; });
        } else throw new Error("COORDINATION_METHOD");
      } else if ((frame[0] === 2 || frame[0] === 3) && frame.length >= 33) {
        const id = decoder.decode(frame.subarray(1, 33));
        if (!ID.test(id)) throw new Error("COORDINATION_ATTEMPT");
        const channel = this.channels.get(id);
        // Delayed bytes from retired attempts can never enter a new writer.
        if (!channel) continue;
        if (frame[0] === 3) channel.remoteClose();
        else channel.dispatchEvent(new MessageEvent("message", { data: frame.slice(33).buffer }));
      } else throw new Error("COORDINATION_FRAME");
    }
  }
  packet(bytes) {
    if (this.closed || !this.authorized()) return Promise.reject(new NativeFileError("CHANNEL_CLOSED"));
    if (bytes.length > 65536 || this.queuedBytes + bytes.length > 1024 * 1024) {
      this.close(); return Promise.reject(new NativeFileError("TRANSFER_STALLED"));
    }
    this.queuedBytes += bytes.length;
    const operation = this.writeTail.then(async () => {
      if (this.closed || !this.authorized()) throw new NativeFileError("CHANNEL_CLOSED");
      const header = new Uint8Array(5); header[0] = 1;
      new DataView(header.buffer).setUint32(1, bytes.length);
      await deadline(this.connection.write(header), 30_000, "TRANSFER_STALLED");
      await deadline(this.connection.write(bytes), 30_000, "TRANSFER_STALLED");
    }).finally(() => { this.queuedBytes -= bytes.length; });
    this.writeTail = operation.catch(() => this.close());
    return operation;
  }
  control(meta) {
    const json = encoder.encode(JSON.stringify({ v: 1, ...meta }));
    const frame = new Uint8Array(json.length + 1); frame[0] = 1; frame.set(json, 1);
    return this.packet(frame);
  }
  notify(notify, value) { return this.control({ notify, value }); }
  async rpc(method, value, ms = 15_000) {
    if (this.pending.size >= 8) throw new Error("COORDINATION_BUSY");
    const id = newFileAttemptId(), outcome = deferred();
    this.pending.set(id, outcome);
    try {
      return await deadline((async () => {
        await this.control({ request: id, method, value });
        return outcome.promise;
      })(), ms);
    } finally { this.pending.delete(id); }
  }
  relay(id) {
    if (!ID.test(id) || this.channels.has(id) || this.channels.size >= 2) throw new Error("COORDINATION_ATTEMPT");
    const parent = this;
    class Channel extends EventTarget {
      ordered = true;
      maxRetransmits = null;
      maxPacketLifeTime = null;
      readyState = "open";
      bufferedAmount = 0;
      send(bytes) {
        if (this.readyState !== "open") throw new Error("CLOSED");
        const frame = new Uint8Array(33 + bytes.length);
        frame[0] = 2; frame.set(encoder.encode(id), 1); frame.set(bytes, 33);
        this.bufferedAmount += bytes.length;
        void parent.packet(frame).then(() => {
          this.bufferedAmount -= bytes.length;
          this.dispatchEvent(new Event("bufferedamountlow"));
        }, () => this.remoteClose());
      }
      remoteClose() {
        if (this.readyState === "closed") return;
        this.readyState = "closed"; parent.channels.delete(id);
        this.dispatchEvent(new Event("close"));
      }
      close() {
        if (this.readyState === "closed") return;
        this.remoteClose();
        const frame = new Uint8Array(33); frame[0] = 3; frame.set(encoder.encode(id), 1);
        void parent.packet(frame).catch(() => {});
      }
    }
    const channel = new Channel(); this.channels.set(id, channel);
    const stream = new NativeFileStream(channel);
    stream.transport = "derp";
    return stream;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const channel of [...this.channels.values()]) channel.remoteClose();
    for (const pending of this.pending.values()) pending.reject(new NativeFileError("RESULT_UNCONFIRMED"));
    this.pending.clear();
    this.ended.resolve();
    this.connection.close();
  }
}

export async function sendCoordinatedFile({ mux, manager, attemptId, sendBody, retryGrant,
  expectedDigest, onPath = () => {}, authorized = () => true, forceDerp = false }) {
  let stream, current = attemptId;
  void mux.ended.promise.then(() => stream?.close());
  try {
    onPath("preparing");
    if (!forceDerp) {
      try { stream = await manager.openTransfer(current); }
      catch (error) {
        if (!["DIRECT_TIMEOUT", "DIRECT_UNAVAILABLE"].includes(error.code)) throw error;
      }
    }
    if (!authorized()) throw new Error("CANCELLED");
    if (!stream) stream = mux.relay(current);
    await mux.rpc("SELECT", { attemptId: current, transport: stream.transport });
    onPath(stream.transport);
    try {
      return await sendBody(stream, current);
    } catch (error) {
      if (stream.transport !== "webrtc" || !NETWORK_ERRORS.has(error.code) || !authorized()) throw error;
      stream.close();
      onPath("confirming");
      const result = await mux.rpc("QUERY", { attemptId: current });
      if (result?.state === "committed") {
        if (!expectedDigest() || expectedDigest() !== result.sha256) throw new NativeFileError("RESULT_UNCONFIRMED");
        return result;
      }
      if (result?.state !== "incomplete" || !authorized()) throw new NativeFileError("RESULT_UNCONFIRMED");
      const next = newFileAttemptId();
      const grant = await retryGrant(next);
      if (!authorized()) throw new Error("CANCELLED");
      onPath("retrying");
      await mux.rpc("RESET", { previous: current, attemptId: next, grant }, 60_000);
      current = next;
      stream = mux.relay(current);
      return await sendBody(stream, current);
    }
  } finally {
    stream?.close();
    await mux.notify("FINISHED").catch(() => {});
    mux.close();
  }
}

export async function receiveCoordinatedFile({ mux, manager, attemptId, receiveBody, reset,
  queryReceipt = null, onPath = () => {}, authorized = () => true }) {
  let current = attemptId, stream = null, state = "waiting", receipt = null, retry = false;
  let settled = deferred(), selected = deferred();
  void mux.ended.promise.then(() => stream?.close());
  const incoming = deferred();
  const unexpect = manager.expectTransfer(attemptId, (value) => incoming.resolve(value));
  mux.handlers.set("SELECT", async (value) => {
    if (state !== "waiting" || value?.attemptId !== current || !authorized()) throw new Error("ATTEMPT_REJECTED");
    state = "selecting";
    if (value.transport === "webrtc") stream = await deadline(incoming.promise, 10_000, "DIRECT_TIMEOUT");
    else if (value.transport === "derp") { unexpect(); stream = mux.relay(current); }
    else throw new Error("TRANSPORT_REJECTED");
    state = "receiving"; onPath(value.transport); selected.resolve(stream);
    return { state: "ready" };
  });
  mux.handlers.set("QUERY", async (value) => {
    if (value?.attemptId !== current || !authorized()) throw new Error("ATTEMPT_REJECTED");
    if (state === "receiving") {
      stream?.close();
      await deadline(settled.promise, 14_000);
    }
    return state === "committed" ? (queryReceipt ? queryReceipt() : receipt) : { state };
  });
  mux.handlers.set("RESET", async (value) => {
    if (retry || state !== "incomplete" || value?.previous !== current || !ID.test(value.attemptId)
      || value.attemptId === current || !authorized()) throw new Error("RESTART_REJECTED");
    retry = true; state = "resetting";
    try {
      await reset(value.attemptId, value.grant);
      if (!authorized()) throw new Error("AUTHORIZATION_EXPIRED");
      current = value.attemptId;
      settled = deferred();
      stream = mux.relay(current);
      state = "receiving"; onPath("retrying"); selected.resolve(stream);
      return { state: "restart-ready" };
    } catch (error) { state = "failed"; selected.reject(error); throw error; }
  });
  try {
    for (;;) {
      stream = await deadline(Promise.race([
        selected.promise,
        mux.ended.promise.then(() => { throw new NativeFileError("CHANNEL_CLOSED"); }),
      ]), 90_000, "TRANSFER_STALLED");
      selected = deferred();
      try {
        receipt = await receiveBody(stream, current);
        state = "committed"; settled.resolve();
        await deadline(Promise.race([mux.finished.promise, mux.ended.promise]), 15_000).catch(() => {});
        return receipt;
      } catch (error) {
        state = stream.transport === "webrtc" && NETWORK_ERRORS.has(error.code) && authorized() && !retry ? "incomplete" : "failed";
        stream.close(); settled.resolve();
        if (state !== "incomplete") throw error;
        onPath("confirming");
      }
    }
  } finally { unexpect(); stream?.close(); mux.close(); }
}
