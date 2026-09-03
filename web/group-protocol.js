// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export const TCG_MAGIC = new Uint8Array([0x54, 0x43, 0x47, 0x31]); // TCG1
export const GROUP_PROTOCOL_VERSION = 1;
export const GROUP_FRAME_MAX_BYTES = 128 * 1024;
export const GROUP_SEND_MAX_FRAMES = 64;
export const GROUP_SEND_MAX_BYTES = 1024 * 1024;
export const GROUP_BATCH_MAX_BYTES = 1024 * 1024 * 1024;

function concatBytes(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function encodedLength(value) {
  return UTF8_ENCODER.encode(JSON.stringify(value)).length;
}

export function normalizeGroupDisplayName(value) {
  const normalized = String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  const points = Array.from(normalized);
  if (!points.length || points.length > 24 || CONTROL_OR_BIDI.test(normalized)) {
    throw new Error("display name must contain 1 through 24 safe Unicode characters");
  }
  return normalized;
}

export function randomBase64URL(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 64) throw new Error("invalid random identifier size");
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function validBase64URL(value, bytes) {
  if (typeof value !== "string" || !Number.isSafeInteger(bytes) || bytes < 1) return false;
  const expectedLength = Math.ceil((bytes * 8) / 6);
  return value.length === expectedLength && /^[A-Za-z0-9_-]+$/u.test(value);
}

export function makeGroupInviteURL(baseURL, { address, roomId, joinToken, appVersion = 1 }) {
  if (!validBase64URL(roomId, 16) || !validBase64URL(joinToken, 32)) throw new Error("invalid group invitation secrets");
  const url = new URL(baseURL);
  url.hash = new URLSearchParams({
    v: String(appVersion),
    mode: "group",
    gv: String(GROUP_PROTOCOL_VERSION),
    invite: String(address || ""),
    room: roomId,
    join: joinToken,
  }).toString();
  return url.toString();
}

export function parseGroupInviteFragment(raw, { appVersion = 1, validAddress = () => true } = {}) {
  try {
    const params = raw instanceof URLSearchParams ? raw : new URLSearchParams(String(raw || ""));
    const required = ["v", "mode", "gv", "invite", "room", "join"];
    const keys = [...params.keys()];
    if (keys.length !== required.length
      || required.some((key) => params.getAll(key).length !== 1)
      || keys.some((key) => !required.includes(key))) return null;
    if (params.get("mode") !== "group") return null;
    const address = params.get("invite") || "";
    const roomId = params.get("room") || "";
    const joinToken = params.get("join") || "";
    if (params.get("v") !== String(appVersion)
      || params.get("gv") !== String(GROUP_PROTOCOL_VERSION)
      || !validAddress(address)
      || !validBase64URL(roomId, 16)
      || !validBase64URL(joinToken, 32)) return null;
    return Object.freeze({ address, roomId, joinToken });
  } catch (_) {
    return null;
  }
}

export function groupBatchBytes(files, recipientCount, maximum = GROUP_BATCH_MAX_BYTES) {
  if (!Number.isSafeInteger(recipientCount) || recipientCount < 1) throw new Error("at least one recipient is required");
  let total = 0;
  for (const file of files || []) {
    const size = Number(file?.size ?? file);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid file size");
    const cost = size * recipientCount;
    if (!Number.isSafeInteger(cost) || cost > maximum - total) throw new Error("group transfer batch exceeds its limit");
    total += cost;
  }
  return total;
}

export function encodeGroupFrame(frame, maximum = GROUP_FRAME_MAX_BYTES) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("group frame must be an object");
  const payload = UTF8_ENCODER.encode(JSON.stringify(frame));
  if (!payload.length || payload.length > maximum) throw new Error("group frame exceeds its limit");
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, payload.length, false);
  return concatBytes(header, payload);
}

export class GroupFrameReader {
  constructor(connection, { maximum = GROUP_FRAME_MAX_BYTES } = {}) {
    this.connection = connection;
    this.maximum = maximum;
    this.buffer = new Uint8Array(0);
    this.offset = 0;
    this.started = false;
    this.ended = false;
  }

  async readExact(length, { eof = false } = {}) {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("invalid group frame length");
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const available = this.buffer.length - this.offset;
      if (available) {
        const count = Math.min(available, length - written);
        output.set(this.buffer.subarray(this.offset, this.offset + count), written);
        this.offset += count;
        written += count;
        if (this.offset === this.buffer.length) {
          this.buffer = new Uint8Array(0);
          this.offset = 0;
        }
        continue;
      }
      const chunk = await this.connection.read();
      if (chunk === null) {
        this.ended = true;
        if (eof && written === 0) return null;
        throw new Error("unexpected end of group stream");
      }
      if (!(chunk instanceof Uint8Array)) throw new Error("group stream returned an invalid chunk");
      if (!chunk.length) continue;
      this.buffer = chunk;
      this.offset = 0;
    }
    return output;
  }

  async start() {
    if (this.started) return;
    const magic = await this.readExact(TCG_MAGIC.length);
    if (!magic.every((byte, index) => byte === TCG_MAGIC[index])) throw new Error("unsupported group stream protocol");
    this.started = true;
  }

  async read() {
    if (this.ended) return null;
    await this.start();
    const header = await this.readExact(4, { eof: true });
    if (header === null) return null;
    const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0, false);
    if (!length || length > this.maximum) throw new Error("group frame exceeds its limit");
    const payload = await this.readExact(length);
    let frame;
    try {
      frame = JSON.parse(UTF8_DECODER.decode(payload));
    } catch (_) {
      throw new Error("group frame is not valid UTF-8 JSON");
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("group frame must be an object");
    return frame;
  }
}

export class GroupFrameWriter {
  constructor(connection, {
    maximum = GROUP_FRAME_MAX_BYTES,
    maxFrames = GROUP_SEND_MAX_FRAMES,
    maxBytes = GROUP_SEND_MAX_BYTES,
  } = {}) {
    this.connection = connection;
    this.maximum = maximum;
    this.maxFrames = maxFrames;
    this.maxBytes = maxBytes;
    this.pendingFrames = 0;
    this.pendingBytes = 0;
    this.closed = false;
    const start = Promise.resolve().then(() => connection.write(new Uint8Array(TCG_MAGIC)));
    this.tail = start.catch((error) => {
      this.close();
      throw error;
    });
    // A pending join writer may legitimately receive no later send call. Keep
    // the failed preamble observable to send()/closeWrite(), while also
    // preventing a standalone unhandled rejection.
    void this.tail.catch(() => {});
  }

  send(frame) {
    if (this.closed) return Promise.reject(new Error("group writer is closed"));
    let bytes;
    try {
      bytes = encodeGroupFrame(frame, this.maximum);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.pendingFrames + 1 > this.maxFrames || this.pendingBytes + bytes.length > this.maxBytes) {
      this.close();
      return Promise.reject(new Error("group member send queue exceeded its limit"));
    }
    this.pendingFrames += 1;
    this.pendingBytes += bytes.length;
    const write = this.tail.then(() => {
      if (this.closed) throw new Error("group writer is closed");
      return this.connection.write(bytes);
    });
    this.tail = write.catch(() => {}).finally(() => {
      this.pendingFrames = Math.max(0, this.pendingFrames - 1);
      this.pendingBytes = Math.max(0, this.pendingBytes - bytes.length);
    });
    write.catch(() => this.close());
    return write;
  }

  async closeWrite() {
    if (this.closed) return;
    await this.tail;
    await this.connection.closeWrite();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
  }
}

export class RecentEventDeduper {
  constructor(maximum = 256) {
    this.maximum = maximum;
    this.values = new Map();
  }

  get(id) {
    return this.values.get(id);
  }

  remember(id, sequence) {
    if (typeof id !== "string" || !id || !Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error("invalid deduplication entry");
    }
    if (this.values.has(id)) this.values.delete(id);
    this.values.set(id, sequence);
    while (this.values.size > this.maximum) this.values.delete(this.values.keys().next().value);
  }
}

export class GroupReplayBuffer {
  constructor({ maxItems = 100, maxBytes = 8 * 1024 * 1024 } = {}) {
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
    this.items = [];
    this.bytes = 0;
    this.latestSequence = 0;
  }

  push(event) {
    if (!Number.isSafeInteger(event?.seq) || event.seq !== this.latestSequence + 1) {
      throw new Error("group event sequence is not contiguous");
    }
    const bytes = encodedLength(event);
    if (bytes > this.maxBytes) throw new Error("group event cannot fit in replay buffer");
    this.items.push({ event, bytes });
    this.bytes += bytes;
    this.latestSequence = event.seq;
    while (this.items.length > this.maxItems || this.bytes > this.maxBytes) {
      const removed = this.items.shift();
      this.bytes -= removed.bytes;
    }
  }

  after(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.latestSequence) return null;
    if (sequence === this.latestSequence) return [];
    const first = this.items[0]?.event.seq;
    if (!first || sequence < first - 1) return null;
    return this.items.filter(({ event }) => event.seq > sequence).map(({ event }) => event);
  }

  clear() {
    this.items.length = 0;
    this.bytes = 0;
    this.latestSequence = 0;
  }
}
