import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  connectMockPeer,
  installMockSavePicker,
  installMockTailcat,
  openMockPage,
  startMockRoom,
} from "./mock-tailcat.js";

test("locks a room after HELLO and carries text in both directions", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const host = await openMockPage(context, namespace);
    const guest = await openMockPage(context, namespace);
    const address = await startMockRoom(host);

    await connectMockPeer(guest, address);
    await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.peer)).toBe("connected");

    const guestTransport = await guest.evaluate(() => globalThis.__mockTailcat.snapshot());
    const hostTransport = await host.evaluate(() => globalThis.__mockTailcat.snapshot());
    expect(guestTransport.records.map(({ envelope }) => envelope?.type)).toContain("HELLO");
    expect(guestTransport.records.map(({ envelope }) => envelope?.type)).toContain("HELLO_CONFIRM");
    expect(hostTransport.records.map(({ envelope }) => envelope?.type)).toContain("HELLO_ACK");

    const fromGuest = "guest → host · encrypted text";
    await guest.locator("#send-text").fill(fromGuest);
    await guest.locator("#send-text-btn").click();
    await expect(host.locator(".message:not(.mine):not(.system) .bubble", { hasText: fromGuest })).toHaveText(fromGuest);
    await expect.poll(async () => {
      const snapshot = await host.evaluate(() => globalThis.__mockTailcat.snapshot());
      return snapshot.records.find(({ direction, port }) => direction === "inbound" && port === 101)?.envelope?.type;
    }).toBe("TEXT_ACK");
    await expect(guest.locator(".message.mine .bubble", { hasText: fromGuest })).toHaveText(fromGuest);

    const fromHost = "host → guest · reply";
    await host.locator("#send-text").fill(fromHost);
    await host.locator("#send-text-btn").click();
    await expect(guest.locator(".message:not(.mine):not(.system) .bubble", { hasText: fromHost })).toHaveText(fromHost);
    await expect(host.locator(".message.mine .bubble", { hasText: fromHost })).toHaveText(fromHost);

    const intruder = await openMockPage(context, namespace);
    await intruder.locator("#send-addr").fill(address);
    await intruder.locator("#connect-btn").click();
    await expect(intruder.locator("#status")).toContainText("already has a peer");
    expect(await intruder.evaluate(() => globalThis.tcTest.state.peer)).toBe("none");
    expect(await host.evaluate(() => globalThis.tcTest.state.peer)).toBe("connected");
    expect(await guest.evaluate(() => globalThis.tcTest.state.peer)).toBe("connected");

    await expect.poll(async () => {
      const snapshot = await host.evaluate(() => globalThis.__mockTailcat.snapshot());
      return snapshot.records.some(({ envelope }) => envelope?.type === "HELLO_REJECT" && envelope.reason === "BUSY");
    }).toBe(true);
  } finally {
    await context.close();
  }
});

test("keeps temporary addresses ephemeral and remembered addresses stable", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const page = await openMockPage(context, namespace);

    const temporaryOne = await startMockRoom(page);
    await page.locator("#stop-listen-btn").click();
    await expect.poll(() => page.evaluate(() => globalThis.tcTest.state.room)).toBe("closed");
    const temporaryTwo = await startMockRoom(page);
    expect(temporaryTwo).not.toBe(temporaryOne);
    await page.locator("#stop-listen-btn").click();

    await page.locator("#persist-key").check();
    const remembered = await startMockRoom(page);
    await page.locator("#stop-listen-btn").click();
    const reopened = await startMockRoom(page);
    expect(reopened).toBe(remembered);
    await page.locator("#stop-listen-btn").click();

    await page.reload();
    await installMockTailcat(page, namespace);
    await expect(page.locator("#persist-key")).toBeChecked();
    const afterReload = await startMockRoom(page);
    expect(afterReload).toBe(remembered);

    await page.locator("#forget-key").click();
    await expect(page.locator("#persist-key")).not.toBeChecked();
    await page.locator("#stop-listen-btn").click();
    const afterForget = await startMockRoom(page);
    expect(afterForget).not.toBe(remembered);
  } finally {
    await context.close();
  }
});

test("requires a save decision and streams a 64 KiB + 1 file in two data chunks", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const receiver = await openMockPage(context, namespace);
    const sender = await openMockPage(context, namespace);
    await installMockSavePicker(receiver);
    const address = await startMockRoom(receiver);
    await connectMockPeer(sender, address);
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.state.peer)).toBe("connected");

    await sender.locator("#send-file").setInputFiles({
      name: "reject.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("do not save"),
    });
    const rejectedOffer = receiver.locator(".incoming-transfer", { hasText: "reject.bin" });
    await expect(rejectedOffer).toBeVisible();
    expect(await receiver.evaluate(() => globalThis.__mockSave.pickerCalls)).toBe(0);
    await rejectedOffer.locator(".reject-file").click();
    await expect(sender.locator(".transfer-item", { hasText: "reject.bin" })).toContainText(/declined|rejected/i);
    expect(await receiver.evaluate(() => globalThis.__mockSave.pickerCalls)).toBe(0);

    const bytes = Buffer.alloc(64 * 1024 + 1);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const expectedDigest = createHash("sha256").update(bytes).digest("hex");
    await sender.locator("#send-file").setInputFiles({
      name: "boundary-64k-plus-one.bin",
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
    const acceptedOffer = receiver.locator(".incoming-transfer", { hasText: "boundary-64k-plus-one.bin" });
    await expect(acceptedOffer).toBeVisible();
    expect(await receiver.evaluate(() => globalThis.tcTest.recvBytes)).toBe(0);
    await acceptedOffer.locator(".save-file").click();

    await expect.poll(() => sender.evaluate(() => globalThis.tcTest.sendDone)).toBe(true);
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.recvDone)).toBe(true);
    expect(await sender.evaluate(() => globalThis.tcTest.sentBytes)).toBe(bytes.length);
    expect(await receiver.evaluate(() => globalThis.tcTest.recvBytes)).toBe(bytes.length);
    expect(await sender.evaluate(() => globalThis.tcTest.sentSha256)).toBe(expectedDigest);
    expect(await receiver.evaluate(() => globalThis.tcTest.recvSha256)).toBe(expectedDigest);
    expect(await receiver.evaluate(() => globalThis.__mockSave)).toEqual(expect.objectContaining({
      pickerCalls: 1,
      writes: [64 * 1024, 1],
      totalBytes: bytes.length,
      closed: true,
      aborted: false,
    }));

    const transport = await sender.evaluate(() => globalThis.__mockTailcat.snapshot());
    const fileWrites = transport.records
      .filter(({ direction, port }) => direction === "outbound" && port === 102)
      .flatMap(({ writeSizes }) => writeSizes);
    expect(fileWrites).toEqual(expect.arrayContaining([64 * 1024 + 5, 6]));
  } finally {
    await context.close();
  }
});

test("streams 0 B, 1 B, 64 KiB, and 100 MiB boundaries without whole-file fallback", async ({ browser }) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "tailcat-e2e-"));
  try {
    const receiver = await openMockPage(context, namespace);
    const sender = await openMockPage(context, namespace);
    await installMockSavePicker(receiver);
    const address = await startMockRoom(receiver);
    await connectMockPeer(sender, address);

    let cumulativeBytes = 0;
    for (const [name, size, fill] of [
      ["empty.bin", 0, 0],
      ["one-byte.bin", 1, 0x5a],
      ["exact-64k.bin", 64 * 1024, 0xa5],
      ["hundred-megabytes.bin", 100 * 1024 * 1024, 0x3c],
    ]) {
      const bytes = Buffer.alloc(size, fill);
      const expectedDigest = createHash("sha256").update(bytes).digest("hex");
      cumulativeBytes += size;
      if (size > 50 * 1024 * 1024) {
        const filePath = join(temporaryDirectory, name);
        await writeFile(filePath, bytes);
        await sender.locator("#send-file").setInputFiles(filePath);
      } else {
        await sender.locator("#send-file").setInputFiles({
          name,
          mimeType: "application/octet-stream",
          buffer: bytes,
        });
      }
      const offer = receiver.locator(".incoming-transfer", { hasText: name });
      await expect(offer).toBeVisible();
      await offer.locator(".save-file").click();
      await expect(sender.locator(".transfer-item", { hasText: name })).toContainText(/saved and verified/i);
      await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.recvSha256)).toBe(expectedDigest);
      await expect.poll(() => receiver.evaluate(() => globalThis.__mockSave.totalBytes)).toBe(cumulativeBytes);
      expect(await receiver.evaluate(() => globalThis.tcTest.recvBytes)).toBe(size);
    }
  } finally {
    await context.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("aborts the destination when the streamed file hash is corrupted", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const receiver = await openMockPage(context, namespace);
    const sender = await openMockPage(context, namespace);
    await installMockSavePicker(receiver);
    const address = await startMockRoom(receiver);
    await connectMockPeer(sender, address);
    await sender.evaluate(() => globalThis.__mockTailcat.setCorruptNextFileData());

    await sender.locator("#send-file").setInputFiles({
      name: "corrupt-me.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("the transport fixture mutates one byte"),
    });
    const offer = receiver.locator(".incoming-transfer", { hasText: "corrupt-me.bin" });
    await expect(offer).toBeVisible();
    await offer.locator(".save-file").click();

    await expect.poll(() => receiver.evaluate(() => globalThis.__mockSave.aborted)).toBe(true);
    expect(await receiver.evaluate(() => globalThis.__mockSave.closed)).toBe(false);
    expect(await receiver.evaluate(() => globalThis.tcTest.recvDone)).toBe(false);
    expect(await sender.evaluate(() => globalThis.tcTest.sendDone)).toBe(false);
    await expect(offer).toContainText(/integrity|hash/i);
    const transport = await sender.evaluate(() => globalThis.__mockTailcat.snapshot());
    expect(transport.records.some(({ port, corrupted }) => port === 102 && corrupted)).toBe(true);
  } finally {
    await context.close();
  }
});

test("continues the ordered file queue after one item is rejected", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const receiver = await openMockPage(context, namespace);
    const sender = await openMockPage(context, namespace);
    await installMockSavePicker(receiver);
    const address = await startMockRoom(receiver);
    await connectMockPeer(sender, address);

    await sender.locator("#send-file").setInputFiles([
      { name: "queue-first.bin", mimeType: "application/octet-stream", buffer: Buffer.from("first") },
      { name: "queue-second.bin", mimeType: "application/octet-stream", buffer: Buffer.from("second") },
    ]);
    const first = receiver.locator(".incoming-transfer", { hasText: "queue-first.bin" });
    await first.locator(".reject-file").click();
    await expect(sender.locator(".transfer-item", { hasText: "queue-first.bin" })).toContainText(/declined|rejected/i);

    const second = receiver.locator(".incoming-transfer", { hasText: "queue-second.bin" });
    await expect(second).toBeVisible();
    await second.locator(".save-file").click();
    await expect(sender.locator(".transfer-item", { hasText: "queue-second.bin" })).toContainText(/saved and verified/i);
    expect(await receiver.evaluate(() => globalThis.__mockSave.totalBytes)).toBe(6);
  } finally {
    await context.close();
  }
});
