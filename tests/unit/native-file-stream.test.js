import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NativeFileStream, NATIVE_FILE_LIMITS } from "../../web/native-file-stream.js";

class Channel extends EventTarget {
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  readyState = "open";
  bufferedAmount = 0;
  sent = [];
  send(value) {
    if (this.readyState !== "open") throw new Error("closed");
    const buffer = value.slice().buffer;
    this.sent.push(value.length);
    this.bufferedAmount += value.length;
    queueMicrotask(() => {
      this.bufferedAmount -= value.length;
      this.dispatchEvent(new Event("bufferedamountlow"));
      if (this.peer.readyState === "open") this.peer.dispatchEvent(new MessageEvent("message", { data: buffer }));
    });
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}
function pair(options) {
  const a = new Channel(), b = new Channel(); a.peer = b; b.peer = a;
  return [new NativeFileStream(a, options), new NativeFileStream(b, options)];
}

for (const size of [0, 1, 16 * 1024, 64 * 1024, 64 * 1024 + 1, 100 * 1024 * 1024]) {
  test(`bounded reliable byte stream ${size} bytes`, async () => {
    const [a, b] = pair();
    try {
      const input = createHash("sha256"), output = createHash("sha256");
      const send = (async () => {
        for (let offset = 0; offset < size;) {
          const block = new Uint8Array(Math.min(64 * 1024, size - offset)).fill(offset % 251);
          input.update(block); await a.write(block); offset += block.length;
        }
        await a.closeWrite();
      })();
      let received = 0;
      for (;;) {
        const block = await b.read(7919);
        if (!block) break;
        output.update(block); received += block.length;
        b.acknowledgeRead();
      }
      await send;
      assert.equal(received, size);
      assert.equal(output.digest("hex"), input.digest("hex"));
      assert.ok(Math.max(...a.channel.sent) <= 16 * 1024);
      assert.ok(b.snapshot().peakUnconsumedBytes <= NATIVE_FILE_LIMITS.windowBytes);
    } finally { a.close(); b.close(); }
  });
}

test("reading without committing to disk does not return credit", async () => {
  const [a, b] = pair();
  try {
    for (let i = 0; i < 16; i++) {
      await a.write(new Uint8Array(64 * 1024));
      let read = 0;
      while (read < 64 * 1024) read += (await b.read()).length;
    }
    assert.equal(a.credit, 0);
    let finished = false;
    const blocked = a.write(new Uint8Array(1)).then(() => { finished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    b.acknowledgeRead();
    await blocked;
    assert.equal(finished, true);
  } finally { a.close(); b.close(); }
});

test("blocked reads and writes wake immediately on cancellation", async () => {
  const [a, b] = pair();
  try {
    a.credit = 0;
    const write = assert.rejects(a.write(new Uint8Array(1)), /CANCELLED/u);
    const read = assert.rejects(a.read(), /CANCELLED/u);
    a.abort();
    await Promise.all([write, read]);
    assert.equal(a.waiters.size, 0);
  } finally { a.close(); b.close(); }
});

test("stall closes stream and rejects pending write", async () => {
  const [a, b] = pair({ stallMs: 10 });
  try {
    a.credit = 0;
    await assert.rejects(a.write(new Uint8Array(1)), /TRANSFER_STALLED/u);
    assert.equal(a.closed, true);
  } finally { a.close(); b.close(); }
});

test("negotiated SCTP size includes the outer header", async () => {
  const [a, b] = pair({ maxMessageSize: 1024 });
  try {
    await a.write(new Uint8Array(4096));
    assert.ok(a.channel.sent.every((size) => size <= 1024));
  } finally { a.close(); b.close(); }
});

test("malformed frames, excess credit and unreliable channels fail closed", () => {
  const [a, b] = pair();
  assert.throws(() => a.receive(new Uint8Array(8).buffer), /INVALID_FRAME/u);
  const credit = a.frame(2, new Uint8Array([0, 0, 0, 1]));
  assert.throws(() => a.receive(credit.buffer), /INVALID_CREDIT/u);
  const channel = new Channel(); channel.ordered = false;
  assert.throws(() => new NativeFileStream(channel), /UNRELIABLE_CHANNEL/u);
  a.close(); b.close();
});

test("browser bufferedAmount is checked before each send", async () => {
  const [a, b] = pair();
  try {
    a.channel.bufferedAmount = NATIVE_FILE_LIMITS.highWater;
    let done = false;
    const write = a.write(new Uint8Array(10)).then(() => { done = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, false);
    a.channel.bufferedAmount = NATIVE_FILE_LIMITS.lowWater;
    a.channel.dispatchEvent(new Event("bufferedamountlow"));
    await write;
    assert.ok(a.snapshot().peakBufferedAmount <= NATIVE_FILE_LIMITS.highWater);
  } finally { a.close(); b.close(); }
});
