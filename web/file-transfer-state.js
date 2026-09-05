// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

const ID = /^[0-9a-f]{32}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const RETRYABLE = new Set(["CHANNEL_CLOSED", "CHANNEL_ERROR", "TRANSFER_STALLED"]);
const keyFor = ({ room, peer, logicalTransferId }) => JSON.stringify([room, peer, logicalTransferId]);

function validateIdentity(value) {
  if (!value || typeof value.room !== "string" || !value.room || value.room.length > 512
    || typeof value.peer !== "string" || !value.peer || value.peer.length > 512
    || !ID.test(value.logicalTransferId) || !Number.isSafeInteger(value.size)
    || value.size < 0 || value.size > 1024 ** 3) throw new Error("INVALID_TRANSFER_IDENTITY");
}

// Memory only. Call clear() when the room ends, not on connection retries.
export class CompletedFileReceipts {
  constructor({ now = Date.now, limit = 256, ttlMs = 30 * 60_000 } = {}) {
    this.now = now;
    this.limit = limit;
    this.ttlMs = ttlMs;
    this.receipts = new Map();
  }
  prune() {
    for (const [key, value] of this.receipts) if (value.expires <= this.now()) this.receipts.delete(key);
  }
  commit(identity, sha256) {
    validateIdentity(identity);
    if (!HASH.test(sha256)) throw new Error("INVALID_FILE_HASH");
    this.prune();
    const key = keyFor(identity);
    const previous = this.receipts.get(key);
    if (previous && (previous.size !== identity.size || previous.sha256 !== sha256)) {
      throw new Error("TRANSFER_ID_REUSE");
    }
    this.receipts.delete(key);
    this.receipts.set(key, { size: identity.size, sha256, expires: this.now() + this.ttlMs });
    while (this.receipts.size > this.limit) this.receipts.delete(this.receipts.keys().next().value);
  }
  query(identity, sha256) {
    validateIdentity(identity);
    this.prune();
    const result = this.receipts.get(keyFor(identity));
    if (!result) return { state: "unknown" };
    if (result.size !== identity.size || (sha256 && result.sha256 !== sha256)) {
      throw new Error("TRANSFER_ID_REUSE");
    }
    return { state: "committed", size: result.size, sha256: result.sha256 };
  }
  clear() { this.receipts.clear(); }
}

export function newFileAttemptId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// A receiver returns "restart-ready" only after the old writer is joined and
// its partial file removed/reset. An absent receipt is NOT restart permission.
// Hooks must validate session + peer + attempt and group tickets themselves.
export async function runFileAttempts({ identity, direct, relay, queryResult, prepareRestart,
  expectedDigest, signal, onState = () => {}, queryTimeoutMs = 15_000 }) {
  validateIdentity(identity);
  const check = () => { if (signal?.aborted) throw new Error("CANCELLED"); };
  const attempt = (transport, retry) => ({ ...identity, attemptId: newFileAttemptId(), transport, retry });
  const send = async (operation, context) => {
    check();
    onState(context.transport === "webrtc" ? "direct-transfer" : "derp-transfer");
    const result = await operation(context);
    check();
    if (result?.state !== "committed" || result.size !== identity.size || !HASH.test(result.sha256)) {
      throw new Error("INVALID_COMPLETION");
    }
    onState("verified");
    return result;
  };
  const first = attempt(direct ? "webrtc" : "derp", false);
  try {
    return await send(direct || relay, first);
  } catch (error) {
    check();
    if (!direct || !RETRYABLE.has(error.code)) { onState("failed"); throw error; }
    onState("confirming-result");
    const queryAbort = new AbortController();
    let timer;
    let cancel;
    let result;
    try {
      result = await Promise.race([
        queryResult(first, queryAbort.signal),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("RESULT_UNCONFIRMED")), queryTimeoutMs); }),
        new Promise((_, reject) => {
          cancel = () => reject(new Error("CANCELLED"));
          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) cancel();
        }),
      ]);
    } catch (queryError) {
      onState(signal?.aborted ? "cancelled" : "result-unconfirmed");
      throw queryError;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      queryAbort.abort();
    }
    check();
    if (result?.state === "committed" && result.size === identity.size && HASH.test(result.sha256)) {
      const digest = expectedDigest?.();
      if (!HASH.test(digest) || digest !== result.sha256) {
        onState("result-unconfirmed");
        throw new Error("RESULT_UNCONFIRMED");
      }
      onState("verified");
      return result;
    }
    if (result?.state !== "incomplete" || result.attemptId !== first.attemptId) {
      onState("result-unconfirmed");
      throw new Error("RESULT_UNCONFIRMED");
    }
    onState("preparing-retry");
    const next = attempt("derp", true);
    const prepared = await prepareRestart(first, next, signal);
    check();
    if (prepared?.state !== "restart-ready" || prepared.attemptId !== next.attemptId) {
      onState("failed");
      throw new Error("RESTART_NOT_CONFIRMED");
    }
    // No recursion: a relay failure can never cause a third attempt.
    try { return await send(relay, next); }
    catch (retryError) { onState(signal?.aborted ? "cancelled" : "failed"); throw retryError; }
  }
}
