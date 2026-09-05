import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  connectMockPeer,
  installMockSavePicker,
  installMockVoiceMedia,
  openMockPage,
  startMockRoom,
} from "./mock-tailcat.js";

test("rejects an incompatible handshake and fails closed when the relay peer is unreachable", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const host = await openMockPage(context, namespace);
    const incompatible = await openMockPage(context, namespace);
    const hostAddress = await startMockRoom(host);
    const replyAddress = await startMockRoom(incompatible);
    const nonce = "a".repeat(32);

    await incompatible.evaluate(({ hostAddress: addr, replyAddress: reply, nonce: value }) => (
      globalThis.__mockTailcat.sendEnvelope(addr, {
        type: "HELLO",
        v: 999,
        replyTo: reply,
        nonce: value,
        capabilities: {},
      })
    ), { hostAddress, replyAddress, nonce });

    await expect.poll(async () => {
      const snapshot = await host.evaluate(() => globalThis.__mockTailcat.snapshot());
      return snapshot.records.some(({ envelope }) => (
        envelope?.type === "HELLO_REJECT" && envelope.reason === "PROTOCOL"
      ));
    }).toBe(true);
    expect(await host.evaluate(() => globalThis.tcTest.state.peer)).toBe("none");

    await incompatible.locator("#send-addr").fill(`tc${"f".repeat(64)}`);
    await incompatible.locator("#connect-btn").click();
    await expect(incompatible.locator("#status")).toContainText(/could not connect|连接失败/i, { timeout: 10_000 });
    expect(await incompatible.evaluate(() => globalThis.tcTest.state.peer)).toBe("none");
  } finally {
    await context.close();
  }
});

test("rejects a cancelled fallback picker and aborts on a fallback disk write failure", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const receiver = await openMockPage(context, namespace, { disableOPFS: true });
    const sender = await openMockPage(context, namespace);
    await installMockSavePicker(receiver);
    const address = await startMockRoom(receiver);
    await connectMockPeer(sender, address);

    await receiver.evaluate(() => { globalThis.__mockSave.cancelNextPicker = true; });
    await sender.locator("#send-file").setInputFiles({
      name: "cancel-picker.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("not accepted"),
    });
    const cancelled = receiver.locator(".incoming-transfer", { hasText: "cancel-picker.bin" });
    await cancelled.locator(".save-file").click();
    await expect(sender.locator(".transfer-item", { hasText: "cancel-picker.bin" })).toContainText(/declined|rejected/i);

    await receiver.evaluate(() => {
      globalThis.__mockSave.aborted = false;
      globalThis.__mockSave.failNextWrite = true;
    });
    await sender.locator("#send-file").setInputFiles({
      name: "disk-failure.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(128 * 1024, 0x7b),
    });
    const failed = receiver.locator(".incoming-transfer", { hasText: "disk-failure.bin" });
    await failed.locator(".save-file").click();
    await expect.poll(() => receiver.evaluate(() => globalThis.__mockSave.aborted)).toBe(true);
    await expect(sender.locator(".transfer-item", { hasText: "disk-failure.bin" })).toContainText(/failed/i);
    expect(await sender.evaluate(() => globalThis.tcTest.sendDone)).toBe(false);
  } finally {
    await context.close();
  }
});

test("aborts a partial destination when the sender page closes", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const receiver = await openMockPage(context, namespace, { disableOPFS: true });
    const sender = await openMockPage(context, namespace);
    await installMockSavePicker(receiver);
    const address = await startMockRoom(receiver);
    await connectMockPeer(sender, address);
    await sender.evaluate(() => globalThis.__mockTailcat.setFileWriteDelay(8));

    await sender.locator("#send-file").setInputFiles({
      name: "sender-closes.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(8 * 1024 * 1024, 0x2d),
    });
    const offer = receiver.locator(".incoming-transfer", { hasText: "sender-closes.bin" });
    await offer.locator(".save-file").click();
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.recvBytes)).toBeGreaterThan(0);
    await sender.close();
    await expect.poll(() => receiver.evaluate(() => globalThis.__mockSave.aborted)).toBe(true);
    expect(await receiver.evaluate(() => globalThis.tcTest.recvDone)).toBe(false);
  } finally {
    await context.close();
  }
});

test("does not report success when the receiver page closes mid-transfer", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const receiver = await openMockPage(context, namespace, { disableOPFS: true });
    const sender = await openMockPage(context, namespace);
    await installMockSavePicker(receiver);
    const address = await startMockRoom(receiver);
    await connectMockPeer(sender, address);
    await sender.evaluate(() => globalThis.__mockTailcat.setFileWriteDelay(8));

    await sender.locator("#send-file").setInputFiles({
      name: "receiver-closes.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(8 * 1024 * 1024, 0x4e),
    });
    const offer = receiver.locator(".incoming-transfer", { hasText: "receiver-closes.bin" });
    await offer.locator(".save-file").click();
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.recvBytes)).toBeGreaterThan(0);
    await receiver.close();
    await expect(sender.locator(".transfer-item", { hasText: "receiver-closes.bin" })).toContainText(/failed|cancelled/i);
    expect(await sender.evaluate(() => globalThis.tcTest.sendDone)).toBe(false);
  } finally {
    await context.close();
  }
});

test("cancels an active file stream and discards the partial destination", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const receiver = await openMockPage(context, namespace, { disableOPFS: true });
    const sender = await openMockPage(context, namespace);
    await installMockSavePicker(receiver);
    const address = await startMockRoom(receiver);
    await connectMockPeer(sender, address);
    await sender.evaluate(() => globalThis.__mockTailcat.setFileWriteDelay(8));

    await sender.locator("#send-file").setInputFiles({
      name: "cancel-active.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(8 * 1024 * 1024, 0x6f),
    });
    const incoming = receiver.locator(".incoming-transfer", { hasText: "cancel-active.bin" });
    await incoming.locator(".save-file").click();
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.recvBytes)).toBeGreaterThan(0);
    const outgoing = sender.locator(".transfer-item", { hasText: "cancel-active.bin" });
    await outgoing.locator("button").click();
    await expect.poll(() => receiver.evaluate(() => globalThis.__mockSave.aborted)).toBe(true);
    await expect(outgoing).toContainText(/cancelled/i);
    expect(await sender.evaluate(() => globalThis.tcTest.sendDone)).toBe(false);
  } finally {
    await context.close();
  }
});

test("lets the receiver cancel an active file stream", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const receiver = await openMockPage(context, namespace, { disableOPFS: true });
    const sender = await openMockPage(context, namespace);
    await installMockSavePicker(receiver);
    const address = await startMockRoom(receiver);
    await connectMockPeer(sender, address);
    await sender.evaluate(() => globalThis.__mockTailcat.setFileWriteDelay(8));

    await sender.locator("#send-file").setInputFiles({
      name: "receiver-cancels.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(8 * 1024 * 1024, 0x70),
    });
    const incoming = receiver.locator(".incoming-transfer", { hasText: "receiver-cancels.bin" });
    await incoming.locator(".save-file").click();
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.recvBytes)).toBeGreaterThan(0);
    await incoming.locator(".cancel-file").click();
    await expect.poll(() => receiver.evaluate(() => globalThis.__mockSave.aborted)).toBe(true);
    await expect(sender.locator(".transfer-item", { hasText: "receiver-cancels.bin" })).toContainText(/failed|cancelled/i);
    expect(await receiver.evaluate(() => globalThis.tcTest.recvDone)).toBe(false);
  } finally {
    await context.close();
  }
});

test("records and delivers a bounded voice note", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const receiver = await openMockPage(context, namespace);
    const sender = await openMockPage(context, namespace);
    await installMockVoiceMedia(receiver);
    await installMockVoiceMedia(sender);
    const address = await startMockRoom(receiver);
    await connectMockPeer(sender, address);

    await sender.locator("#ptt-btn").dispatchEvent("pointerdown", { pointerId: 1 });
    await expect(sender.locator("#status")).toContainText(/recording/i);
    await sender.locator("body").dispatchEvent("pointerup", { pointerId: 1 });
    await expect(sender.locator(".message.mine audio")).toHaveCount(1);
    await expect(receiver.locator(".message:not(.mine) audio")).toHaveCount(1);
    await expect(sender.locator("#status")).toContainText(/delivered/i);
  } finally {
    await context.close();
  }
});

test("stops the room after thirty minutes without activity", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const page = await openMockPage(context, namespace);
    await page.clock.install();
    await startMockRoom(page);
    await page.clock.fastForward(30 * 60 * 1000 + 1);
    await expect.poll(() => page.evaluate(() => globalThis.tcTest.state.room)).toBe("closed");
    await expect(page.locator("#status")).toContainText(/30 minutes|30 分钟/i);
  } finally {
    await context.close();
  }
});

test("releases the peer lock after an explicit close or missed heartbeats", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const firstHost = await openMockPage(context, namespace);
    const firstGuest = await openMockPage(context, namespace);
    const firstAddress = await startMockRoom(firstHost);
    await connectMockPeer(firstGuest, firstAddress);
    await firstHost.locator("#stop-listen-btn").click();
    await expect.poll(() => firstGuest.evaluate(() => globalThis.tcTest.state.peer)).toBe("none");

    const secondHost = await openMockPage(context, namespace);
    const secondGuest = await openMockPage(context, namespace);
    await secondGuest.clock.install();
    const secondAddress = await startMockRoom(secondHost);
    await connectMockPeer(secondGuest, secondAddress);
    await secondHost.close();
    await secondGuest.clock.fastForward(60_000);
    await secondGuest.clock.fastForward(3_100);
    await expect.poll(async () => {
      const snapshot = await secondGuest.evaluate(() => globalThis.__mockTailcat.snapshot());
      return snapshot.records.filter(({ direction, port }) => direction === "outbound" && port === 100).length;
    }).toBeGreaterThanOrEqual(3);
    await secondGuest.clock.fastForward(56_900);
    await secondGuest.clock.fastForward(3_100);
    await expect.poll(() => secondGuest.evaluate(() => globalThis.tcTest.state.peer)).toBe("none");
    await expect(secondGuest.locator("#status")).toContainText(/listening|room is listening/i);
  } finally {
    await context.close();
  }
});

test("keeps a live room when authenticated traffic succeeds between failed heartbeats", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const host = await openMockPage(context, namespace);
    const guest = await openMockPage(context, namespace);
    await guest.clock.install();
    const address = await startMockRoom(host);
    await connectMockPeer(guest, address);
    await guest.evaluate(() => globalThis.__mockTailcat.setFailControlDials(true));

    await guest.clock.fastForward(60_000);
    await guest.waitForTimeout(50);
    await guest.locator("#send-text").fill("the existing data path is still alive");
    await guest.locator("#send-text-btn").click();
    await expect(host.locator(".message:not(.mine)", { hasText: "the existing data path is still alive" })).toHaveCount(1);
    await expect(guest.locator("#status")).toContainText(/delivered/i);

    await guest.clock.fastForward(60_000);
    await guest.waitForTimeout(50);
    expect(await guest.evaluate(() => globalThis.tcTest.state.peer)).toBe("connected");
    await guest.evaluate(() => globalThis.__mockTailcat.setFailControlDials(false));
  } finally {
    await context.close();
  }
});

test("bounds one bulk file selection to one hundred pending items", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const receiver = await openMockPage(context, namespace, { disableOPFS: true });
    const sender = await openMockPage(context, namespace);
    await installMockSavePicker(receiver);
    const address = await startMockRoom(receiver);
    await connectMockPeer(sender, address);
    const files = Array.from({ length: 101 }, (_, index) => ({
      name: `bulk-${String(index).padStart(3, "0")}.bin`,
      mimeType: "application/octet-stream",
      buffer: Buffer.from([index % 251]),
    }));
    await sender.locator("#send-file").setInputFiles(files);
    await expect(sender.locator("#status")).toContainText(/at most 100/i);
    expect(await sender.locator("#transfer-list > li").count()).toBe(100);
    await sender.locator("#stop-listen-btn").click();
  } finally {
    await context.close();
  }
});
