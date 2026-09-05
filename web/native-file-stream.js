// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

// NFD1 outer framing. Credit measures TCF1 bytes, including its headers.
// Reading does NOT return credit: the caller must call acknowledgeRead() only
// after validation and, for DATA, the serial sink write and hash update.
export const NATIVE_FILE_LIMITS = Object.freeze({
  messageBytes: 16 * 1024,
  highWater: 512 * 1024,
  lowWater: 128 * 1024,
  windowBytes: 1024 * 1024,
  creditBatch: 256 * 1024,
  stallMs: 30_000,
});
const HEADER = 6;
const DATA = 1;
const CREDIT = 2;
const FIN = 3;
const FIN_ACK = 4;

export class NativeFileError extends Error {
  constructor(code) {
    super(code);
    this.name = "NativeFileError";
    this.code = code;
  }
}

export class NativeFileStream {
  constructor(channel, { maxMessageSize, stallMs = NATIVE_FILE_LIMITS.stallMs, onClose = () => {} } = {}) {
    if (channel.ordered !== true || channel.maxRetransmits != null || channel.maxPacketLifeTime != null) {
      throw new NativeFileError("UNRELIABLE_CHANNEL");
    }
    this.transport = "webrtc";
    this.channel = channel;
    this.messageBytes = Math.min(NATIVE_FILE_LIMITS.messageBytes,
      Number.isSafeInteger(maxMessageSize) && maxMessageSize > 0 ? maxMessageSize : NATIVE_FILE_LIMITS.messageBytes);
    if (this.messageBytes <= HEADER) throw new NativeFileError("MESSAGE_SIZE");
    this.stallMs = stallMs;
    this.onClose = onClose;
    this.queue = [];
    this.queueOffset = 0;
    this.credit = NATIVE_FILE_LIMITS.windowBytes;
    this.inFlight = 0;
    this.readPendingAck = 0;
    this.consumed = 0;
    this.receiveAllowance = NATIVE_FILE_LIMITS.windowBytes;
    this.waiters = new Set();
    this.error = null;
    this.remoteFin = false;
    this.localFin = false;
    this.finAck = false;
    this.closed = false;
    this.reading = false;
    this.writing = false;
    this.metrics = { sentBytes: 0, receivedBytes: 0, peakBufferedAmount: 0, peakUnconsumedBytes: 0 };
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = NATIVE_FILE_LIMITS.lowWater;
    this.handlers = {
      message: (event) => {
        try { this.receive(event.data); } catch (error) { this.abort(error); }
      },
      bufferedamountlow: () => this.wake(),
      open: () => this.wake(),
      close: () => this.abort(new NativeFileError("CHANNEL_CLOSED")),
      error: () => this.abort(new NativeFileError("CHANNEL_ERROR")),
    };
    for (const [type, handler] of Object.entries(this.handlers)) channel.addEventListener(type, handler);
  }

  wake() { for (const callback of [...this.waiters]) callback(); }

  async waitFor(predicate) {
    if (this.error) throw this.error;
    if (predicate()) return;
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        if (error) reject(error); else resolve();
      };
      const check = () => {
        if (this.error) finish(this.error);
        else if (predicate()) finish();
      };
      const timer = setTimeout(() => this.abort(new NativeFileError("TRANSFER_STALLED")), this.stallMs);
      this.waiters.add(check);
      check();
    });
  }

  frame(kind, payload = new Uint8Array()) {
    const frame = new Uint8Array(HEADER + payload.byteLength);
    frame[0] = 1;
    frame[1] = kind;
    new DataView(frame.buffer).setUint32(2, payload.byteLength);
    frame.set(payload, HEADER);
    return frame;
  }

  sendControl(kind, amount) {
    const data = amount === undefined ? new Uint8Array() : new Uint8Array(4);
    if (amount !== undefined) new DataView(data.buffer).setUint32(0, amount);
    // At most one credit frame per 256 KiB consumed, plus terminal frames.
    // Control cannot be held behind DATA credit, which would deadlock.
    if (this.error) throw this.error;
    if (this.channel.readyState !== "open"
      || this.channel.bufferedAmount + HEADER + data.length > NATIVE_FILE_LIMITS.highWater) {
      throw new NativeFileError("CONTROL_BACKPRESSURE");
    }
    this.channel.send(this.frame(kind, data));
  }

  receive(value) {
    if (this.closed) return;
    if (!(value instanceof ArrayBuffer) || value.byteLength < HEADER || value.byteLength > this.messageBytes) {
      throw new NativeFileError("INVALID_FRAME");
    }
    const bytes = new Uint8Array(value);
    const length = new DataView(value).getUint32(2);
    if (bytes[0] !== 1 || length !== bytes.length - HEADER) throw new NativeFileError("INVALID_FRAME");
    switch (bytes[1]) {
      case DATA:
        if (this.remoteFin || !length || length > this.receiveAllowance) throw new NativeFileError("CREDIT_EXCEEDED");
        this.receiveAllowance -= length;
        this.queue.push(bytes.subarray(HEADER));
        this.metrics.receivedBytes += length;
        this.metrics.peakUnconsumedBytes = Math.max(this.metrics.peakUnconsumedBytes,
          NATIVE_FILE_LIMITS.windowBytes - this.receiveAllowance);
        break;
      case CREDIT: {
        if (length !== 4) throw new NativeFileError("INVALID_CREDIT");
        const amount = new DataView(value).getUint32(HEADER);
        if (!amount || amount > this.inFlight || amount > NATIVE_FILE_LIMITS.windowBytes - this.credit) {
          throw new NativeFileError("INVALID_CREDIT");
        }
        this.inFlight -= amount;
        this.credit += amount;
        break;
      }
      case FIN:
        if (length || this.remoteFin) throw new NativeFileError("INVALID_FIN");
        this.remoteFin = true;
        this.sendControl(FIN_ACK);
        break;
      case FIN_ACK:
        if (length || !this.localFin || this.finAck) throw new NativeFileError("INVALID_FIN_ACK");
        this.finAck = true;
        break;
      default: throw new NativeFileError("INVALID_FRAME");
    }
    this.wake();
  }

  async write(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > 128 * 1024) throw new NativeFileError("WRITE_SIZE");
    if (this.writing || this.localFin) throw new NativeFileError("WRITE_STATE");
    this.writing = true;
    try {
      for (let offset = 0; offset < bytes.length;) {
        const length = Math.min(bytes.length - offset, this.messageBytes - HEADER);
        await this.waitFor(() => this.channel.readyState === "open"
          && this.credit >= length
          && this.channel.bufferedAmount + length + HEADER <= NATIVE_FILE_LIMITS.highWater - 16);
        const frame = this.frame(DATA, bytes.subarray(offset, offset + length));
        this.credit -= length;
        this.inFlight += length;
        this.channel.send(frame);
        this.metrics.sentBytes += length;
        this.metrics.peakBufferedAmount = Math.max(this.metrics.peakBufferedAmount, this.channel.bufferedAmount);
        offset += length;
      }
    } catch (error) {
      this.abort(error);
      throw this.error;
    } finally { this.writing = false; }
  }

  async read(maxBytes = 64 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 || this.reading) {
      throw new NativeFileError("READ_STATE");
    }
    this.reading = true;
    try {
      await this.waitFor(() => this.queue.length > 0 || this.remoteFin);
      if (!this.queue.length) return null;
      const head = this.queue[0];
      const size = Math.min(maxBytes, head.length - this.queueOffset);
      const result = head.slice(this.queueOffset, this.queueOffset + size);
      this.queueOffset += size;
      if (this.queueOffset === head.length) { this.queue.shift(); this.queueOffset = 0; }
      this.readPendingAck += size;
      return result;
    } finally { this.reading = false; }
  }

  acknowledgeRead() {
    if (this.error) throw this.error;
    this.consumed += this.readPendingAck;
    this.readPendingAck = 0;
    if (this.consumed >= NATIVE_FILE_LIMITS.creditBatch) {
      const amount = this.consumed;
      this.consumed = 0;
      this.receiveAllowance += amount;
      try { this.sendControl(CREDIT, amount); } catch (error) { this.abort(error); throw error; }
    }
  }

  async closeWrite() {
    if (this.writing) throw new NativeFileError("WRITE_STATE");
    if (!this.localFin) { this.localFin = true; this.sendControl(FIN); }
    await this.waitFor(() => this.finAck);
  }

  abort(error = new NativeFileError("CANCELLED")) {
    if (this.closed) return;
    this.closed = true;
    // Do not retain browser-generated errors which can contain remote details.
    this.error = error instanceof NativeFileError ? error : new NativeFileError("CHANNEL_ERROR");
    this.queue.length = 0;
    for (const [type, handler] of Object.entries(this.handlers)) this.channel.removeEventListener(type, handler);
    this.wake();
    this.channel.close();
    this.onClose();
  }

  close() { this.abort(new NativeFileError("CHANNEL_CLOSED")); }
  snapshot() { return { ...this.metrics, bufferedAmount: this.channel.bufferedAmount, transport: this.transport }; }
}
