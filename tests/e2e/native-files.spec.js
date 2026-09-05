import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMockPage, startMockRoom, connectMockPeer, installMockSavePicker } from "./mock-tailcat.js";

async function enable(context) {
  await context.addInitScript(() => {
    globalThis.__TAILCAT_NATIVE_FILES__ = true;
    globalThis.__nativeTest = { bytes: 0, pcs: 0, channels: 0, failures: 0, failAfter: 0, dropDone: false };
    const NativePC = RTCPeerConnection;
    globalThis.RTCPeerConnection = class extends NativePC {
      constructor(config) {
        super(config); __nativeTest.pcs++;
        this.addEventListener("datachannel", ({ channel }) => watch(channel));
      }
      createDataChannel(...args) { const channel = super.createDataChannel(...args); watch(channel); return channel; }
    };
    const watched = new WeakSet();
    function watch(channel) {
      if (watched.has(channel)) return; watched.add(channel); __nativeTest.channels++;
      const send = channel.send.bind(channel);
      channel.send = (bytes) => {
        if (bytes instanceof Uint8Array && bytes[1] === 1) {
          if (__nativeTest.dropDone && new TextDecoder().decode(bytes).includes('"DONE"')) {
            __nativeTest.dropDone = false; __nativeTest.failures++; channel.close(); return;
          }
          __nativeTest.bytes += bytes.length;
          if (__nativeTest.failAfter && __nativeTest.bytes >= __nativeTest.failAfter) {
            __nativeTest.failAfter = 0; __nativeTest.failures++; channel.close();
            throw new Error("injected data channel failure");
          }
        }
        return send(bytes);
      };
    }
  });
}

async function pair(context, { picker = false, duplex = false } = {}) {
  await enable(context);
  const namespace = randomUUID();
  const receiver = await openMockPage(context, namespace, { disableOPFS: picker || duplex });
  if (picker || duplex) await installMockSavePicker(receiver);
  const sender = await openMockPage(context, namespace, { disableOPFS: duplex });
  if (duplex) await installMockSavePicker(sender);
  await connectMockPeer(sender, await startMockRoom(receiver));
  return { sender, receiver };
}

async function send(sender, receiver, size, name = "native.bin", picker = false) {
  const bytes = Buffer.alloc(size, 73), hash = createHash("sha256").update(bytes).digest("hex");
  let directory;
  try {
  await sender.evaluate(() => { tcTest.sendDone = false; });
  if (size > 50 * 1024 * 1024) {
    directory = await mkdtemp(join(tmpdir(), "tailcat-native-test-"));
      const path = join(directory, name); await writeFile(path, bytes);
      await sender.locator("#send-file").setInputFiles(path);
  } else await sender.locator("#send-file").setInputFiles({ name, mimeType: "application/octet-stream", buffer: bytes });
  if (picker) await receiver.locator(".incoming-transfer", { hasText: name }).locator(".save-file").click();
  await expect.poll(() => sender.evaluate(() => ({ done: tcTest.sendDone, errors: tcTest.errors })), { timeout: 45_000 })
    .toMatchObject({ done: true });
  expect(await sender.evaluate(() => tcTest.sentSha256)).toBe(hash);
  expect(await receiver.evaluate(() => tcTest.recvSha256)).toBe(hash);
  await expect(receiver.locator(".incoming-transfer", { hasText: name })).toHaveCount(1);
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}

test("private TCF1 native files retain acceptance, hashes and a reusable PC", async ({ context }) => {
  const { sender, receiver } = await pair(context);
  for (const size of [0, 1, 16 * 1024, 64 * 1024, 64 * 1024 + 1]) await send(sender, receiver, size, `native-${size}.bin`);
  expect((await sender.evaluate(() => __nativeTest)).bytes).toBeGreaterThan(0);
  expect((await sender.evaluate(() => __nativeTest)).pcs).toBe(1);
  const pipes = await sender.evaluate(() => __mockTailcat.snapshot().records.filter((record) =>
    record.direction === "outbound" && record.envelope?.type === "NATIVE_FILE_SIGNAL_PIPE"));
  expect(pipes).toHaveLength(1);
  await sender.locator("#stop-listen-btn").click();
  await expect.poll(() => sender.evaluate(() => __mockTailcat.snapshot().records.filter((record) =>
    record.envelope?.type === "NATIVE_FILE_SIGNAL_PIPE").every((record) => record.closed))).toBe(true);
});

test("forceDerp preserves negotiated streaming without creating a PC", async ({ context }) => {
  const { sender, receiver } = await pair(context);
  await sender.locator("#force-derp").check();
  await send(sender, receiver, 2 * 1024 * 1024);
  expect((await sender.evaluate(() => __nativeTest)).pcs).toBe(0);
});

test("unavailable native signaling still permits an authorized DERP file", async ({ context }) => {
  const { sender, receiver } = await pair(context);
  await sender.evaluate(() => __mockTailcat.setFailControlDials(true));
  await send(sender, receiver, 64 * 1024);
  await expect(sender.locator(".transfer-item", { hasText: "native.bin" })).toHaveAttribute("data-route", "derp");
});

test("direct failure restarts OPFS once without a second receive item", async ({ context }) => {
  const { sender, receiver } = await pair(context);
  await sender.evaluate(() => { __nativeTest.failAfter = 128 * 1024; });
  await send(sender, receiver, 2 * 1024 * 1024);
  expect((await sender.evaluate(() => __nativeTest)).failures).toBe(1);
  const entries = await receiver.evaluate(async () => {
    const directory = await navigator.storage.getDirectory();
    const children = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === "directory") for await (const [file] of handle.entries()) children.push(file);
    }
    return children;
  });
  expect(entries.length).toBe(1);
});

test("lost native DONE queries the committed result rather than duplicating a save", async ({ context }) => {
  const { sender, receiver } = await pair(context);
  await receiver.evaluate(() => { __nativeTest.dropDone = true; });
  await send(sender, receiver, 1024 * 1024);
  expect((await receiver.evaluate(() => __nativeTest)).failures).toBe(1);
});

test("picker retry truncates the original uncommitted transaction without prompting twice", async ({ context }) => {
  const { sender, receiver } = await pair(context, { picker: true });
  await sender.evaluate(() => { __nativeTest.failAfter = 256 * 1024; });
  await send(sender, receiver, 2 * 1024 * 1024, "picker-retry.bin", true);
  expect(await receiver.evaluate(() => __mockSave)).toMatchObject({ pickerCalls: 1, resets: 1, totalBytes: 2 * 1024 * 1024, closed: true, aborted: false });
});

test("native 100 MiB file verifies SHA-256 and does not put the body on Tailcat", async ({ context }) => {
  const { sender, receiver } = await pair(context);
  await send(sender, receiver, 100 * 1024 * 1024);
  const count = await sender.evaluate(() => __mockTailcat.snapshot().records
    .filter((record) => record.direction === "outbound")
    .reduce((total, record) => total + record.writeSizes.reduce((sum, bytes) => sum + bytes, 0), 0));
  expect(count).toBeLessThan(2 * 1024 * 1024);
});

test("a legacy recipient receives TCF1 without native negotiation", async ({ context }) => {
  await enable(context);
  const namespace = randomUUID();
  const receiver = await context.newPage();
  await receiver.addInitScript(() => { globalThis.__TAILCAT_NATIVE_FILES__ = false; });
  await receiver.goto("/");
  const { installMockTailcat } = await import("./mock-tailcat.js");
  await installMockTailcat(receiver, namespace);
  const sender = await openMockPage(context, namespace);
  await connectMockPeer(sender, await startMockRoom(receiver));
  await send(sender, receiver, 64 * 1024 + 1);
  expect((await sender.evaluate(() => __nativeTest)).pcs).toBe(0);
});

test("picker disk failures do not trigger an automatic retry or false success", async ({ context }) => {
  const { sender, receiver } = await pair(context, { picker: true });
  await receiver.evaluate(() => { __mockSave.failNextWrite = true; });
  await sender.locator("#send-file").setInputFiles({ name: "disk-error.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(1024 * 1024) });
  await receiver.locator(".incoming-transfer .save-file").click();
  await expect(sender.locator(".transfer-item .transfer-detail")).toContainText(/fail|closed|unconfirmed/i, { timeout: 45_000 });
  expect(await sender.evaluate(() => tcTest.sendDone)).toBe(false);
  expect(await receiver.evaluate(() => __mockSave)).toMatchObject({ pickerCalls: 1, aborted: true, closed: false });
});

test("group owner tickets authorize direct recipient transfers", async ({ context }) => {
  await enable(context);
  const namespace = randomUUID();
  const host = await openMockPage(context, namespace, { group: true });
  await host.locator("#group-create-entry-btn").click();
  await host.locator("#group-create-nickname").fill("Host");
  await host.locator("#group-create-btn").click();
  await expect.poll(() => host.evaluate(() => tcTest.group.mode)).toBe("owner");
  const invitation = await host.locator("#group-invite-link").textContent();
  const receiver = await openMockPage(context, namespace, { group: true });
  await receiver.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const consume = GroupRoomController.prototype.consumeTransferTicket;
    const tickets = new Set();
    GroupRoomController.prototype.consumeTransferTicket = async function (...args) {
      const result = await consume.apply(this, args); tickets.add(args[0].ticket);
      globalThis.__nativeConsumedTickets = tickets.size; return result;
    };
  });
  await installMockSavePicker(receiver);
  await receiver.evaluate((url) => { location.hash = new URL(url).hash; }, invitation);
  await receiver.locator("#group-join-nickname").fill("Recipient");
  await receiver.locator("#group-join-btn").click();
  await host.locator(".group-pending-item .group-approve-join").click();
  await expect.poll(() => receiver.evaluate(() => tcTest.group.mode)).toBe("member");
  await host.locator("#group-recipient-list input").check();
  await host.evaluate(() => { __nativeTest.failAfter = 256 * 1024; });
  await host.locator("#send-file").setInputFiles({ name: "group-native.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(1024 * 1024, 7) });
  await receiver.locator(".incoming-transfer .save-file").click();
  await expect(host.locator(".group-transfer-recipient")).toHaveAttribute("data-status", "complete", { timeout: 45_000 });
  expect((await host.evaluate(() => __nativeTest)).bytes).toBeGreaterThan(0);
  expect(await receiver.evaluate(() => __nativeConsumedTickets)).toBe(2);
  expect(await receiver.evaluate(() => __mockSave.resets)).toBe(1);
});

test("both private peers can send files concurrently", async ({ context }) => {
  const { sender, receiver } = await pair(context, { duplex: true });
  await Promise.all([
    send(sender, receiver, 2 * 1024 * 1024, "a-to-b.bin", true),
    send(receiver, sender, 2 * 1024 * 1024, "b-to-a.bin", true),
  ]);
});

test("a group member transfers directly to two authorized recipients independently", async ({ context }) => {
  await enable(context);
  const namespace = randomUUID();
  const owner = await openMockPage(context, namespace, { group: true });
  await installMockSavePicker(owner);
  await owner.locator("#group-create-entry-btn").click();
  await owner.locator("#group-create-nickname").fill("Owner");
  await owner.locator("#group-create-btn").click();
  await expect.poll(() => owner.evaluate(() => tcTest.group.mode)).toBe("owner");
  const invitation = await owner.locator("#group-invite-link").textContent();
  const members = [];
  for (const nickname of ["Sender", "Recipient"]) {
    const page = await openMockPage(context, namespace, { group: true, disableOPFS: true });
    await installMockSavePicker(page);
    await page.evaluate((url) => { location.hash = new URL(url).hash; }, invitation);
    await page.locator("#group-join-nickname").fill(nickname);
    await page.locator("#group-join-btn").click();
    await owner.locator(".group-pending-item .group-approve-join").click();
    await expect.poll(() => page.evaluate(() => tcTest.group.mode)).toBe("member");
    members.push(page);
  }
  const [sender, receiver] = members;
  await expect(sender.locator("#group-recipient-list input")).toHaveCount(2);
  for (const input of await sender.locator("#group-recipient-list input").all()) await input.check();
  await sender.locator("#send-file").setInputFiles({ name: "two-recipients.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(2 * 1024 * 1024, 83) });
  await Promise.all([owner, receiver].map((page) => page.locator(".incoming-transfer .save-file").click()));
  await expect(sender.locator('.group-transfer-recipient[data-status="complete"]')).toHaveCount(2, { timeout: 45_000 });
  await expect(sender.locator('.group-transfer-recipient[data-route="webrtc"]')).toHaveCount(2);
  for (const page of [owner, receiver]) expect(await page.evaluate(() => __mockSave)).toMatchObject({ totalBytes: 2 * 1024 * 1024, closed: true });
  expect((await sender.evaluate(() => __nativeTest)).pcs).toBe(2);
});
