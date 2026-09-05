// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause
import { NativeFileError, NativeFileStream } from "./native-file-stream.js";

const ID = /^[0-9a-f]{32}$/u;
export const FILE_TRANSPORT = "webrtc-dc-v1";
export const FILE_STUN_URL = "stun:stun.cloudflare.com:3478";

export function supportsNativeFiles(capabilities) {
  return capabilities?.file?.protocol === "TCF1"
    && Array.isArray(capabilities.file.transports)
    && capabilities.file.transports.includes(FILE_TRANSPORT);
}

// Selection happens before writing TCF1 or file bytes. Mid-transfer failure is
// never handled here: it must go through the result-query/retry state machine.
export async function openFileTransfer({ manager, attemptId, capabilities,
  enabled = false, forceDerp = false, openDerp }) {
  if (enabled === true && forceDerp !== true && supportsNativeFiles(capabilities) && manager) {
    try { return await manager.openTransfer(attemptId); }
    catch (error) {
      if (!["DIRECT_TIMEOUT", "DIRECT_UNAVAILABLE"].includes(error.code)) throw error;
    }
  }
  const connection = await openDerp();
  return {
    transport: "derp",
    read: (maximum) => connection.read(maximum),
    write: (bytes) => connection.write(bytes),
    closeWrite: () => connection.closeWrite(),
    close: () => connection.close(),
    abort: () => connection.close(),
    acknowledgeRead: () => {},
  };
}

// One instance per authenticated peer in one room. The caller must bind the
// signaling callback to that peer's Tailcat channel (not to a public bus),
// register consent/tickets with expectTransfer, and close on room revocation.
export class FileTransportManager {
  constructor({ room, localId, peerId, sendSignal, isAuthorized,
    createPeerConnection = (config) => new RTCPeerConnection(config),
    setupMs = 10_000, idleMs = 30_000, cooldownMs = 60_000, now = Date.now }) {
    if (![room, localId, peerId].every((id) => typeof id === "string" && id.length > 0 && id.length <= 512)
      || localId === peerId || typeof isAuthorized !== "function" || typeof sendSignal !== "function") {
      throw new NativeFileError("PEER_BINDING");
    }
    Object.assign(this, { room, localId, peerId, sendSignal, isAuthorized, createPeerConnection, setupMs, idleMs, cooldownMs, now });
    this.offerer = localId < peerId;
    this.generation = 0;
    this.state = null;
    this.closed = false;
    this.cooldownUntil = 0;
    this.expected = new Map();
    this.serial = Promise.resolve();
    this.pendingSignals = 0;
    this.waiters = new Set();
  }

  check() {
    if (this.closed || !this.isAuthorized()) throw new NativeFileError("AUTHORIZATION_EXPIRED");
  }
  wake() { for (const callback of [...this.waiters]) callback(); }
  async waitFor(predicate, milliseconds = this.setupMs) {
    this.check();
    if (predicate()) return;
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer); this.waiters.delete(check);
        if (error) reject(error); else resolve();
      };
      const check = () => {
        try {
          this.check();
          if (predicate()) finish();
          else if (this.now() < this.cooldownUntil) finish(new NativeFileError("DIRECT_UNAVAILABLE"));
        } catch (error) { finish(error); }
      };
      const timer = setTimeout(() => finish(new NativeFileError("DIRECT_TIMEOUT")), milliseconds);
      this.waiters.add(check); check();
    });
  }

  emit(type, fields = {}, generation = this.generation) {
    this.check();
    return this.sendSignal({ v: 1, room: this.room, from: this.localId, to: this.peerId, generation, type, ...fields });
  }

  expectTransfer(attemptId, onStream) {
    this.check();
    if (!ID.test(attemptId) || this.expected.has(attemptId) || this.expected.size >= 1) {
      throw new NativeFileError("TRANSFER_NOT_AUTHORIZED");
    }
    const timer = setTimeout(() => this.expected.delete(attemptId), this.setupMs);
    this.expected.set(attemptId, { onStream, timer });
    return () => { clearTimeout(timer); this.expected.delete(attemptId); };
  }

  attach(state, channel) {
    this.check();
    if (this.state !== state || state.streams.size >= 2) { channel.close(); throw new NativeFileError("STREAM_LIMIT"); }
    clearTimeout(state.idleTimer);
    const stream = new NativeFileStream(channel, {
      maxMessageSize: state.pc.sctp?.maxMessageSize,
      onClose: () => { state.streams.delete(stream); this.scheduleIdle(state); },
    });
    state.streams.add(stream);
    return stream;
  }

  makeState(generation) {
    this.dropState();
    this.generation = generation;
    const pc = this.createPeerConnection({ iceServers: [{ urls: FILE_STUN_URL }] });
    const state = { pc, generation, candidates: [], sentCandidates: 0, receivedCandidates: 0,
      streams: new Set(), idleTimer: null, signalingReady: false, outgoingCandidates: [] };
    this.state = state;
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || this.state !== state) return;
      if (++state.sentCandidates > 64) { this.fail(); return; }
      const value = candidate.toJSON();
      if (!state.signalingReady) state.outgoingCandidates.push(value);
      else void this.emit("ICE", { candidate: value }, generation).catch(() => this.failIfCurrent(state));
    };
    pc.onconnectionstatechange = () => {
      if (this.state !== state) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.fail();
      else if (pc.connectionState === "connected") this.scheduleIdle(state);
      this.wake();
    };
    pc.ondatachannel = ({ channel }) => {
      if (this.state !== state || !this.isAuthorized() || !ID.test(channel.label)) { channel.close(); return; }
      const expected = this.expected.get(channel.label);
      if (!expected) { channel.close(); return; }
      clearTimeout(expected.timer);
      this.expected.delete(channel.label);
      try { expected.onStream(this.attach(state, channel)); }
      catch (_) { channel.close(); this.failIfCurrent(state); }
    };
    return state;
  }

  async flushCandidates(state) {
    if (this.state !== state) throw new NativeFileError("STALE_GENERATION");
    state.signalingReady = true;
    for (const candidate of state.outgoingCandidates.splice(0)) await this.emit("ICE", { candidate }, state.generation);
  }

  async startOffer() {
    this.check();
    if (!this.offerer || this.state) return;
    const state = this.makeState(this.generation + 1);
    // Establish the SCTP m-line without reserving a file transfer channel.
    const bootstrap = state.pc.createDataChannel("bootstrap", { ordered: true });
    bootstrap.onopen = () => bootstrap.close();
    await state.pc.setLocalDescription(await state.pc.createOffer());
    if (this.state !== state) throw new NativeFileError("STALE_GENERATION");
    await this.emit("OFFER", { description: state.pc.localDescription.toJSON() });
    await this.flushCandidates(state);
  }

  handleSignal(message) {
    if (this.pendingSignals >= 64) return Promise.reject(new NativeFileError("SIGNAL_QUEUE_FULL"));
    this.pendingSignals++;
    const operation = this.serial.then(() => this.receiveSignal(message)).catch((error) => {
      // Browser SDP errors are deliberately not exposed to diagnostic callers.
      if (error instanceof NativeFileError) throw error;
      this.fail();
      throw new NativeFileError("INVALID_SIGNAL");
    }).finally(() => { this.pendingSignals--; });
    this.serial = operation.catch(() => {});
    return operation;
  }

  async receiveSignal(message) {
    this.check();
    if (!message || message.v !== 1 || message.room !== this.room || message.from !== this.peerId
      || message.to !== this.localId || !Number.isSafeInteger(message.generation) || message.generation < 0
      || JSON.stringify(message).length > 64 * 1024) throw new NativeFileError("SIGNAL_BINDING");
    if (message.type === "REQUEST") {
      if (!this.offerer || this.now() < this.cooldownUntil || message.generation !== this.generation) return;
      await this.startOffer();
      return;
    }
    if (message.type === "OFFER") {
      if (this.offerer || message.generation <= this.generation || this.now() < this.cooldownUntil) return;
      if (message.description?.type !== "offer") throw new NativeFileError("INVALID_DESCRIPTION");
      const state = this.makeState(message.generation);
      await state.pc.setRemoteDescription(message.description);
      if (this.state !== state) throw new NativeFileError("STALE_GENERATION");
      await state.pc.setLocalDescription(await state.pc.createAnswer());
      if (this.state !== state) throw new NativeFileError("STALE_GENERATION");
      await this.emit("ANSWER", { description: state.pc.localDescription.toJSON() });
      await this.flushCandidates(state);
      return;
    }
    const state = this.state;
    if (!state || message.generation !== state.generation) return;
    if (message.type === "ANSWER") {
      if (!this.offerer || message.description?.type !== "answer" || state.pc.remoteDescription) {
        throw new NativeFileError("INVALID_DESCRIPTION");
      }
      await state.pc.setRemoteDescription(message.description);
      if (this.state !== state) throw new NativeFileError("STALE_GENERATION");
      for (const candidate of state.candidates.splice(0)) await state.pc.addIceCandidate(candidate);
    } else if (message.type === "ICE") {
      if (++state.receivedCandidates > 64 || typeof message.candidate?.candidate !== "string"
        || message.candidate.candidate.length > 4096) throw new NativeFileError("INVALID_CANDIDATE");
      if (state.pc.remoteDescription) await state.pc.addIceCandidate(message.candidate);
      else state.candidates.push(message.candidate);
    } else throw new NativeFileError("INVALID_SIGNAL");
  }

  async openTransfer(attemptId) {
    this.check();
    if (!ID.test(attemptId)) throw new NativeFileError("INVALID_ATTEMPT");
    if (this.now() < this.cooldownUntil) throw new NativeFileError("DIRECT_UNAVAILABLE");
    const deadline = this.now() + this.setupMs;
    try {
      // Bound the *whole* setup, including Tailcat signaling and browser SDP.
      const setup = (async () => {
        if (!this.state) {
          if (this.offerer) await this.startOffer();
          else await this.emit("REQUEST");
        }
        await this.waitFor(() => this.state?.pc.connectionState === "connected", Math.max(1, deadline - this.now()));
        const state = this.state;
        const channel = state.pc.createDataChannel(attemptId, { ordered: true });
        const stream = this.attach(state, channel);
        await stream.waitFor(() => channel.readyState === "open");
        return stream;
      })();
      let timer;
      try {
        return await Promise.race([setup, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new NativeFileError("DIRECT_TIMEOUT")), Math.max(1, deadline - this.now()));
        })]);
      } finally { clearTimeout(timer); }
    } catch (error) {
      this.fail();
      throw error instanceof NativeFileError ? error : new NativeFileError("DIRECT_UNAVAILABLE");
    }
  }

  scheduleIdle(state) {
    if (this.state !== state || state.streams.size) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => { if (this.state === state && !state.streams.size) this.dropState(); }, this.idleMs);
  }
  failIfCurrent(state) { if (this.state === state) this.fail(); }
  fail() { this.cooldownUntil = this.now() + this.cooldownMs; this.dropState(); this.wake(); }
  dropState() {
    const state = this.state;
    this.state = null;
    if (!state) return;
    clearTimeout(state.idleTimer);
    state.pc.onicecandidate = state.pc.onconnectionstatechange = state.pc.ondatachannel = null;
    for (const stream of [...state.streams]) stream.close();
    state.pc.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.dropState();
    for (const { timer } of this.expected.values()) clearTimeout(timer);
    this.expected.clear();
    this.wake();
  }
}
