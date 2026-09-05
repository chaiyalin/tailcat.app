import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { CompletedFileReceipts, runFileAttempts } from "../../web/file-transfer-state.js";
globalThis.crypto ??= webcrypto;
const identity = { room: "room", peer: "peer", logicalTransferId: "a".repeat(32), size: 1 };
const receipt = { state: "committed", size: 1, sha256: "b".repeat(64) };
const broken = () => { throw Object.assign(new Error("closed"), { code: "CHANNEL_CLOSED" }); };

test("completion receipts bind peer, room, size and hash, expire and evict", () => {
  let time = 0;
  const cache = new CompletedFileReceipts({ now: () => time, limit: 2, ttlMs: 10 });
  cache.commit(identity, receipt.sha256);
  assert.deepEqual(cache.query(identity), receipt);
  assert.deepEqual(cache.query({ ...identity, peer: "other" }), { state: "unknown" });
  assert.throws(() => cache.query({ ...identity, size: 2 }), /TRANSFER_ID_REUSE/u);
  assert.throws(() => cache.commit(identity, "c".repeat(64)), /TRANSFER_ID_REUSE/u);
  cache.commit({ ...identity, logicalTransferId: "b".repeat(32) }, receipt.sha256);
  cache.commit({ ...identity, logicalTransferId: "c".repeat(32) }, receipt.sha256);
  assert.deepEqual(cache.query(identity), { state: "unknown" });
  time = 11;
  assert.deepEqual(cache.query({ ...identity, logicalTransferId: "b".repeat(32) }), { state: "unknown" });
  cache.clear(); assert.equal(cache.receipts.size, 0);
});

test("lost DONE uses committed receipt without a second file", async () => {
  let retries = 0;
  const result = await runFileAttempts({ identity, direct: broken, relay: () => { retries++; },
    expectedDigest: () => receipt.sha256,
    queryResult: async () => receipt, prepareRestart: () => { throw new Error("must not reset saved file"); } });
  assert.deepEqual(result, receipt); assert.equal(retries, 0);
});

test("a cached completion must match the sender's own digest", async () => {
  await assert.rejects(runFileAttempts({ identity, direct: broken,
    expectedDigest: () => "c".repeat(64), queryResult: async () => receipt,
    relay: () => assert.fail("must not duplicate saved file") }), /RESULT_UNCONFIRMED/u);
});

test("only one fresh DERP attempt, after old writer cleanup", async () => {
  let stopped = false, retries = 0, first;
  const result = await runFileAttempts({ identity,
    direct: (context) => { first = context; return broken(); },
    queryResult: async (context) => ({ state: "incomplete", attemptId: context.attemptId }),
    prepareRestart: async (_, next) => { stopped = true; return { state: "restart-ready", attemptId: next.attemptId }; },
    relay: async (next) => {
      assert.equal(stopped, true); assert.notEqual(next.attemptId, first.attemptId);
      assert.equal(next.logicalTransferId, first.logicalTransferId); assert.equal(next.retry, true);
      retries++; return receipt;
    },
  });
  assert.deepEqual(result, receipt); assert.equal(retries, 1);
});

test("unknown result, dropped query and lost control never permit retry", async () => {
  for (const queryResult of [async () => ({ state: "unknown" }), async () => new Promise(() => {})]) {
    await assert.rejects(runFileAttempts({ identity, direct: broken, queryResult, queryTimeoutMs: 10,
      relay: () => assert.fail("duplicate save"), prepareRestart: () => assert.fail("unconfirmed reset") }), /RESULT_UNCONFIRMED/u);
  }
});

test("disk, hash, quota, authorization and user refusal are never retried", async () => {
  for (const code of ["CANCELLED", "HASH_MISMATCH", "DISK_ERROR", "INSUFFICIENT_SPACE", "AUTHORIZATION_EXPIRED", "REJECTED"]) {
    await assert.rejects(runFileAttempts({ identity,
      direct: () => { throw Object.assign(new Error(code), { code }); },
      queryResult: () => assert.fail("must not query"), relay: () => assert.fail("must not retry") }), new RegExp(code, "u"));
  }
});

test("a failed DERP retry cannot loop", async () => {
  let retries = 0;
  await assert.rejects(runFileAttempts({ identity, direct: broken,
    queryResult: async (context) => ({ state: "incomplete", attemptId: context.attemptId }),
    prepareRestart: async (_, next) => ({ state: "restart-ready", attemptId: next.attemptId }),
    relay: () => { retries++; return broken(); } }), /closed/u);
  assert.equal(retries, 1);
});

test("cancellation during result query aborts it without a duplicate", async () => {
  const controller = new AbortController();
  const pending = runFileAttempts({ identity, direct: broken, signal: controller.signal,
    queryResult: async () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); },
    relay: () => assert.fail("must not retry") });
  await assert.rejects(pending, /CANCELLED/u);
});
