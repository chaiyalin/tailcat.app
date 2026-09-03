import { expect, test } from "@playwright/test";

test("group invitation is fragment-only, versioned, and strictly validated", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const protocol = await import("/group-protocol.js");
    const address = `tc${"a".repeat(64)}`;
    const roomId = "A".repeat(22);
    const joinToken = "B".repeat(43);
    const url = protocol.makeGroupInviteURL("https://tailcat.app/", { address, roomId, joinToken });
    const parsed = protocol.parseGroupInviteFragment(new URL(url).hash.slice(1), {
      validAddress: (value) => value === address,
    });
    const rotated = protocol.parseGroupInviteFragment(
      `v=1&mode=group&gv=1&invite=${address}&room=${roomId}&join=${"C".repeat(42)}`,
      { validAddress: () => true },
    );
    const duplicate = protocol.parseGroupInviteFragment(
      `v=1&mode=group&gv=1&invite=${address}&room=${roomId}&join=${joinToken}&join=${joinToken}`,
      { validAddress: () => true },
    );
    const extra = protocol.parseGroupInviteFragment(
      `v=1&mode=group&gv=1&invite=${address}&room=${roomId}&join=${joinToken}&debug=1`,
      { validAddress: () => true },
    );
    return { url, parsed, rotated, duplicate, extra };
  });
  expect(result.url).toBe(`https://tailcat.app/#v=1&mode=group&gv=1&invite=tc${"a".repeat(64)}&room=${"A".repeat(22)}&join=${"B".repeat(43)}`);
  expect(result.parsed).toEqual({
    address: `tc${"a".repeat(64)}`,
    roomId: "A".repeat(22),
    joinToken: "B".repeat(43),
  });
  expect(result.rotated).toBeNull();
  expect(result.duplicate).toBeNull();
  expect(result.extra).toBeNull();
});

test("TCG1 reader handles split and coalesced frames and rejects malformed lengths", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupFrameReader, TCG_MAGIC, encodeGroupFrame } = await import("/group-protocol.js");
    const one = encodeGroupFrame({ type: "ONE", value: "猫" });
    const two = encodeGroupFrame({ type: "TWO", value: 2 });
    const wire = new Uint8Array(TCG_MAGIC.length + one.length + two.length);
    wire.set(TCG_MAGIC);
    wire.set(one, TCG_MAGIC.length);
    wire.set(two, TCG_MAGIC.length + one.length);
    const chunks = [wire.slice(0, 1), wire.slice(1, 7), wire.slice(7)];
    const reader = new GroupFrameReader({ read: async () => chunks.shift() ?? null });
    const decoded = [await reader.read(), await reader.read(), await reader.read()];

    const badLength = new Uint8Array(8);
    badLength.set(TCG_MAGIC);
    new DataView(badLength.buffer).setUint32(4, 128 * 1024 + 1, false);
    const badReader = new GroupFrameReader({ read: async () => badLength });
    let malformed = "";
    try { await badReader.read(); } catch (error) { malformed = error.message; }

    const failures = {};
    const cases = {
      magic: new Uint8Array([0, 0, 0, 0]),
      zero: new Uint8Array([...TCG_MAGIC, 0, 0, 0, 0]),
      truncated: new Uint8Array([...TCG_MAGIC, 0, 0, 0, 4, 0x7b]),
      utf8: new Uint8Array([...TCG_MAGIC, 0, 0, 0, 2, 0xc3, 0x28]),
      json: new Uint8Array([...TCG_MAGIC, 0, 0, 0, 1, 0x7b]),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      const chunks = [bytes];
      const candidate = new GroupFrameReader({ read: async () => chunks.shift() ?? null });
      try { await candidate.read(); } catch (error) { failures[name] = error.message; }
    }
    return { decoded, malformed, failures };
  });
  expect(result.decoded).toEqual([
    { type: "ONE", value: "猫" },
    { type: "TWO", value: 2 },
    null,
  ]);
  expect(result.malformed).toContain("exceeds");
  expect(result.failures.magic).toContain("protocol");
  expect(result.failures.zero).toContain("exceeds");
  expect(result.failures.truncated).toContain("end");
  expect(result.failures.utf8).toContain("UTF-8 JSON");
  expect(result.failures.json).toContain("UTF-8 JSON");
});

test("TCV1 slow-drip input is stopped by an absolute frame deadline", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => globalThis.tcTest?.ready === true);
  const result = await page.evaluate(() => globalThis.tcTest.runGroupVoiceDeadlineSelfTest());
  expect(result.closed).toBe(true);
  expect(result.reads).toBeLessThan(4);
  expect(result.error).toContain("absolute deadline");
});

test("bounded writer disconnects one slow stream without accepting an oversized queue", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupFrameWriter } = await import("/group-protocol.js");
    let release;
    let writes = 0;
    let closed = false;
    const gate = new Promise((resolve) => { release = resolve; });
    const connection = {
      write: async () => { writes += 1; await gate; },
      closeWrite: async () => {},
      close: () => { closed = true; release(); },
    };
    const writer = new GroupFrameWriter(connection, { maxFrames: 2, maxBytes: 4096 });
    const first = writer.send({ type: "A" }).catch((error) => error.message);
    const second = writer.send({ type: "B" }).catch((error) => error.message);
    let third = "";
    try { await writer.send({ type: "C" }); } catch (error) { third = error.message; }
    await Promise.all([first, second]);
    const healthyWrites = [];
    const healthy = new GroupFrameWriter({
      write: async (bytes) => healthyWrites.push(bytes.slice()),
      closeWrite: async () => {},
      close() {},
    });
    await healthy.send({ type: "HEALTHY", value: 1 });
    await healthy.closeWrite();
    return { third, closed, writes, healthyWrites: healthyWrites.length };
  });
  expect(result.third).toContain("queue");
  expect(result.closed).toBe(true);
  expect(result.writes).toBeGreaterThanOrEqual(1);
  expect(result.healthyWrites).toBe(2);
});

test("nickname, aggregate batch, dedupe, and replay boundaries are enforced", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const {
      GroupReplayBuffer,
      RecentEventDeduper,
      groupBatchBytes,
      normalizeGroupDisplayName,
    } = await import("/group-protocol.js");
    const name = normalizeGroupDisplayName("  Alice\nCat  ");
    let bidiRejected = false;
    try { normalizeGroupDisplayName("safe\u202Ename"); } catch (_) { bidiRejected = true; }
    const exact = groupBatchBytes([{ size: 1024 * 1024 * 1024 }], 1);
    let overRejected = false;
    try { groupBatchBytes([{ size: 1024 * 1024 * 1024 + 1 }], 1); } catch (_) { overRejected = true; }

    const dedupe = new RecentEventDeduper(2);
    dedupe.remember("one", 1);
    dedupe.remember("two", 2);
    dedupe.remember("three", 3);
    const replay = new GroupReplayBuffer({ maxItems: 2, maxBytes: 4096 });
    replay.push({ seq: 1, type: "TEXT", text: "one" });
    replay.push({ seq: 2, type: "TEXT", text: "two" });
    replay.push({ seq: 3, type: "TEXT", text: "three" });
    return {
      name,
      bidiRejected,
      exact,
      overRejected,
      dedupe: [dedupe.get("one") ?? null, dedupe.get("two"), dedupe.get("three")],
      replayGap: replay.after(0),
      replayAfter: replay.after(1),
    };
  });
  expect(result).toEqual({
    name: "Alice Cat",
    bidiRejected: true,
    exact: 1024 * 1024 * 1024,
    overRejected: true,
    dedupe: [null, 2, 3],
    replayGap: null,
    replayAfter: [
      { seq: 2, type: "TEXT", text: "two" },
      { seq: 3, type: "TEXT", text: "three" },
    ],
  });
});
