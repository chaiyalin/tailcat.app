import { test } from "node:test";
import assert from "node:assert/strict";
import { FileCoordination } from "../../web/file-coordination.js";

function connections() {
  const sides = [0, 1].map(() => ({ queue: [], waiting: null, closed: false }));
  return sides.map((side, index) => ({
    async read(maximum) {
      while (!side.queue.length && !side.closed) await new Promise((resolve) => { side.waiting = resolve; });
      if (!side.queue.length) return null;
      const bytes = side.queue[0];
      const result = bytes.slice(0, maximum);
      if (result.length === bytes.length) side.queue.shift(); else side.queue[0] = bytes.slice(maximum);
      return result;
    },
    async write(bytes) {
      if (side.closed) throw new Error("closed");
      const peer = sides[1 - index]; peer.queue.push(bytes.slice()); peer.waiting?.(); peer.waiting = null;
    },
    close() { for (const peer of sides) { peer.closed = true; peer.waiting?.(); peer.waiting = null; } },
  }));
}

test("coordination multiplexes bounded relay bytes and bidirectional RPC", async () => {
  const [left, right] = connections();
  const a = new FileCoordination(left), b = new FileCoordination(right);
  try {
    a.handlers.set("QUERY", async () => ({ state: "incomplete" }));
    b.handlers.set("QUERY", async () => ({ state: "committed" }));
    assert.deepEqual(await Promise.all([a.rpc("QUERY"), b.rpc("QUERY")]), [{ state: "committed" }, { state: "incomplete" }]);
    const aa = a.relay("a".repeat(32)), bb = b.relay("a".repeat(32));
    const receive = (async () => {
      let total = 0;
      while (total < 2 * 1024 * 1024) { const bytes = await bb.read(); total += bytes.length; bb.acknowledgeRead(); }
      return total;
    })();
    for (let i = 0; i < 32; i++) await aa.write(new Uint8Array(64 * 1024));
    assert.equal(await receive, 2 * 1024 * 1024);
    assert.ok(bb.snapshot().peakUnconsumedBytes <= 1024 * 1024);
    assert.equal(aa.transport, "derp");
    aa.close(); bb.close();
  } finally { a.close(); b.close(); }
});

test("closed coordination rejects outstanding result queries", async () => {
  const [left, right] = connections();
  const a = new FileCoordination(left), b = new FileCoordination(right);
  let entered;
  const received = new Promise((resolve) => { entered = resolve; });
  b.handlers.set("QUERY", async () => { entered(); return new Promise(() => {}); });
  const pending = assert.rejects(a.rpc("QUERY"), /RESULT_UNCONFIRMED/u);
  await received;
  a.close(); b.close(); await pending;
  assert.equal(a.pending.size, 0);
});
