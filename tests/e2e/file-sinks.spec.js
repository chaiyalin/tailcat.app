import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  connectMockPeer,
  installMockSavePicker,
  installMockTailcat,
  startMockRoom,
} from "./mock-tailcat.js";

async function openConnectedOPFSReceiver(context, { failCloseWriteAfterDone = false } = {}) {
  const namespace = randomUUID();
  const receiver = await context.newPage();
  await receiver.addInitScript(() => {
    Object.defineProperty(globalThis, "showSaveFilePicker", {
      configurable: true,
      value: undefined,
    });
  });
  await receiver.goto("/");
  await installMockTailcat(receiver, namespace);

  if (failCloseWriteAfterDone) {
    await receiver.evaluate(() => {
      const originalListen = globalThis.tailcatListen;
      globalThis.tailcatListen = (options = {}) => originalListen({
        ...options,
        onConnection(connection) {
          if (connection.port === 102) {
            const originalWrite = connection.write.bind(connection);
            const originalCloseWrite = connection.closeWrite.bind(connection);
            let doneWritten = false;
            connection.write = async (input) => {
              const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
              if (bytes[0] === 3 && bytes.byteLength >= 5) {
                const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                  .getUint32(1, false);
                if (length === bytes.byteLength - 5) {
                  const frame = JSON.parse(new TextDecoder().decode(bytes.subarray(5)));
                  doneWritten = frame.type === "DONE";
                }
              }
              return originalWrite(input);
            };
            connection.closeWrite = async () => {
              if (!doneWritten) return originalCloseWrite();
              globalThis.__fileCloseWriteFailure = { attempted: true, doneWritten };
              throw new Error("mock closeWrite failed after DONE");
            };
          }
          return options.onConnection(connection);
        },
      });
    });
  }

  const peer = await context.newPage();
  await peer.goto("/");
  await installMockTailcat(peer, namespace);
  await installMockSavePicker(peer);

  const address = await startMockRoom(receiver);
  await connectMockPeer(peer, address);
  expect(await receiver.evaluate(() => globalThis.tcTest.runtime.fileSink)).toMatchObject({
    kind: "opfs-export",
    opfs: true,
  });
  return { receiver, peer };
}

async function listStagedFiles(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("tailcat-transfers", { create: true });
    const files = [];
    for await (const [name, handle] of directory.entries()) {
      const file = await handle.getFile();
      files.push({
        name,
        size: file.size,
        bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
      });
    }
    return files;
  });
}

async function listStagedFileSizes(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("tailcat-transfers", { create: true });
    const sizes = [];
    for await (const [, handle] of directory.entries()) {
      sizes.push((await handle.getFile()).size);
    }
    return sizes;
  });
}

async function createSparseFile(directory, name, size) {
  const path = join(directory, name);
  const handle = await open(path, "w");
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
  return path;
}

test.describe("streaming file sinks", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "chrome", "OPFS backend coverage runs once in desktop Chrome.");
  });

  test("streams into async OPFS, reads the closed file, and removes it", async ({ page }) => {
    await page.goto("/404.html");

    const result = await page.evaluate(async () => {
      const sinks = await import("/file-sinks.js");
      const transferId = "0123456789abcdef0123456789abcdef";
      const first = new Uint8Array(sinks.FILE_SINK_CHUNK_BYTES);
      first.forEach((_, index) => { first[index] = index % 251; });
      const second = new Uint8Array([251, 252, 253, 254, 255]);
      const expected = new Uint8Array(first.byteLength + second.byteLength);
      expected.set(first);
      expected.set(second, first.byteLength);

      const initialized = await sinks.initializeFileSinks();
      const sink = await sinks.createFileSink({
        kind: sinks.FILE_SINK_KIND.OPFS_EXPORT,
        transferId,
        name: "../received.bin",
        size: expected.byteLength,
        mime: "application/octet-stream",
      });
      const storageId = sink.transferId;

      const firstOffset = await sink.write(first);
      const finalOffset = await sink.write(second.buffer);
      await sink.close();
      const received = new Uint8Array(await (await sink.getFile()).arrayBuffer());
      const beforeRemoval = {
        state: sink.state,
        bytesWritten: sink.bytesWritten,
        name: sink.name,
        matches: received.length === expected.length
          && received.every((byte, index) => byte === expected[index]),
      };
      const removed = await sink.remove();

      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle("tailcat-transfers", { create: true });
      let entryExists = true;
      try {
        await directory.getFileHandle(storageId);
      } catch (error) {
        if (error.name === "NotFoundError") entryExists = false;
        else throw error;
      }

      return {
        initialized,
        storageId,
        protocolTransferId: transferId,
        firstOffset,
        finalOffset,
        beforeRemoval,
        removed,
        afterRemovalState: sink.state,
        entryExists,
      };
    });

    expect(result.initialized).toMatchObject({ opfs: true, opfsMode: "async" });
    expect(result.storageId).toMatch(/^[0-9a-f]{32}$/u);
    expect(result.storageId).not.toBe(result.protocolTransferId);
    expect(result.firstOffset).toBe(64 * 1024);
    expect(result.finalOffset).toBe((64 * 1024) + 5);
    expect(result.beforeRemoval).toEqual({
      state: "closed",
      bytesWritten: (64 * 1024) + 5,
      name: "received.bin",
      matches: true,
    });
    expect(result.removed).toBe(true);
    expect(result.afterRemovalState).toBe("removed");
    expect(result.entryExists).toBe(false);
  });

  test("rejects an OPFS receive when the reported quota lacks required headroom", async ({ page }) => {
    await page.goto("/404.html");

    const result = await page.evaluate(async () => {
      const minimumHeadroom = 64 * 1024 * 1024;
      Object.defineProperty(navigator.storage, "estimate", {
        configurable: true,
        value: async () => ({ quota: minimumHeadroom, usage: 0 }),
      });
      const sinks = await import("/file-sinks.js");
      const capacity = await sinks.getReceiveCapacity(1, {
        kind: sinks.FILE_SINK_KIND.OPFS_EXPORT,
      });
      return {
        ...capacity,
        insufficientReason: sinks.FILE_SINK_REASON.INSUFFICIENT_SPACE,
      };
    });

    expect(result).toMatchObject({
      ok: false,
      reason: result.insufficientReason,
      kind: "opfs-export",
      size: 1,
      maxBytes: 0,
      requiredBytes: (64 * 1024 * 1024) + 1,
      availableBytes: 64 * 1024 * 1024,
    });
  });

  test("does not let a second live tab clean or own the first tab's OPFS transfer", async ({ context }) => {
    const owner = await context.newPage();
    const second = await context.newPage();
    await owner.goto("/404.html");
    await second.goto("/404.html");
    const transferId = "11111111111111111111111111111111";

    const ownerState = await owner.evaluate(async ({ transferId: id }) => {
      const sinks = await import("/file-sinks.js");
      const initialized = await sinks.initializeFileSinks();
      const sink = await sinks.createFileSink({
        kind: sinks.FILE_SINK_KIND.OPFS_EXPORT,
        transferId: id,
        name: "owner.bin",
        size: 1,
      });
      await sink.write(new Uint8Array([42]));
      await sink.close();
      globalThis.__ownerSink = sink;
      return { ...initialized, storageId: sink.transferId };
    }, { transferId });
    expect(ownerState).toMatchObject({ opfs: true, opfsOwned: true });
    expect(ownerState.storageId).not.toBe(transferId);

    const secondState = await second.evaluate(async () => {
      const sinks = await import("/file-sinks.js");
      return sinks.initializeFileSinks();
    });
    expect(secondState).toMatchObject({ opfs: false, opfsOwned: false });

    expect(await owner.evaluate(async ({ transferId: id }) => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle("tailcat-transfers");
      return (await (await directory.getFileHandle(id)).getFile()).size;
    }, { transferId: ownerState.storageId })).toBe(1);
    await owner.evaluate(() => globalThis.__ownerSink.remove());
    await owner.close();
    await second.close();
  });

  test("isolates repeated peer transfer IDs behind distinct local OPFS names", async ({ page }) => {
    await page.goto("/404.html");

    const result = await page.evaluate(async () => {
      const sinks = await import("/file-sinks.js");
      const protocolTransferId = "33333333333333333333333333333333";
      const create = async (byte) => {
        const sink = await sinks.createFileSink({
          kind: sinks.FILE_SINK_KIND.OPFS_EXPORT,
          transferId: protocolTransferId,
          name: "repeated.bin",
          size: 1,
        });
        await sink.write(new Uint8Array([byte]));
        await sink.close();
        return sink;
      };
      const first = await create(11);
      const second = await create(22);
      const firstByte = new Uint8Array(await (await first.getFile()).arrayBuffer())[0];
      const secondByteBefore = new Uint8Array(await (await second.getFile()).arrayBuffer())[0];
      await first.remove();
      const secondByteAfter = new Uint8Array(await (await second.getFile()).arrayBuffer())[0];
      const storageIds = [first.transferId, second.transferId];
      await second.remove();
      return { protocolTransferId, storageIds, firstByte, secondByteBefore, secondByteAfter };
    });

    expect(result.storageIds[0]).not.toBe(result.protocolTransferId);
    expect(result.storageIds[1]).not.toBe(result.protocolTransferId);
    expect(result.storageIds[0]).not.toBe(result.storageIds[1]);
    expect(result).toMatchObject({ firstByte: 11, secondByteBefore: 22, secondByteAfter: 22 });
  });

  test("keeps a verified OPFS file available for local download when system sharing fails", async ({ page }) => {
    await page.goto("/404.html");

    const result = await page.evaluate(async () => {
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      let shareAttempts = 0;
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async () => {
          shareAttempts += 1;
          throw new DOMException("No share target", "NotAllowedError");
        },
      });
      let downloads = 0;
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function clickDownload() {
        if (this.download) {
          downloads += 1;
          return;
        }
        return originalClick.call(this);
      };

      const sinks = await import("/file-sinks.js");
      const transferId = "22222222222222222222222222222222";
      const sink = await sinks.createFileSink({
        kind: sinks.FILE_SINK_KIND.OPFS_EXPORT,
        transferId,
        name: "verified.txt",
        size: 3,
        mime: "text/plain",
      });
      try {
        await sink.write(new Uint8Array([1, 2, 3]));
        await sink.close();
        const prepared = await sink.prepareExport();
        let shareError = "";
        try {
          await prepared.share();
        } catch (error) {
          shareError = error.name;
        }
        prepared.download();
        const retainedSize = prepared.file.size;
        prepared.dispose();
        return {
          canShare: prepared.canShare,
          shareAttempts,
          shareError,
          downloads,
          retainedSize,
          released: prepared.file === null,
        };
      } finally {
        await sink.remove();
      }
    });

    expect(result).toEqual({
      canShare: true,
      shareAttempts: 1,
      shareError: "NotAllowedError",
      downloads: 1,
      retainedSize: 3,
      released: true,
    });
  });

  test("automatically receives a common private file into OPFS without a consent click", async ({ context }) => {
    const { receiver, peer } = await openConnectedOPFSReceiver(context);
    const name = "private-auto-receive.txt";
    const contents = Buffer.from("private files at or below the threshold are staged automatically");
    await receiver.evaluate(() => {
      globalThis.__mockOpenClicks = [];
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function clickStagedFile() {
        if (this.target === "_blank") {
          globalThis.__mockOpenClicks.push({ href: this.href, rel: this.rel });
          return;
        }
        return originalClick.call(this);
      };
    });

    await peer.locator("#send-file").setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: contents,
    });

    const incoming = receiver.locator(".incoming-transfer", { hasText: name });
    await expect(incoming).toBeVisible();
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.recvDone)).toBe(true);
    await expect(incoming.locator(".save-file")).toBeHidden();
    await expect(incoming.locator(".reject-file")).toBeHidden();
    await expect(incoming.locator(".open-file")).toBeVisible();
    await expect(incoming.locator(".export-file")).toBeVisible();
    await expect(peer.locator(".transfer-item", { hasText: name })).toContainText(/received and SHA-256 verified/iu);
    expect(await listStagedFiles(receiver)).toEqual([
      expect.objectContaining({ size: contents.length, bytes: [...contents] }),
    ]);

    await incoming.locator(".open-file").click();
    expect(await receiver.evaluate(() => globalThis.__mockOpenClicks)).toEqual([
      expect.objectContaining({ href: expect.stringMatching(/^blob:/u), rel: "noopener noreferrer" }),
    ]);
    await expect(incoming.locator(".open-file")).toBeVisible();
    await expect(incoming.locator(".export-file")).toBeVisible();
    expect(await listStagedFiles(receiver)).toEqual([
      expect.objectContaining({ size: contents.length, bytes: [...contents] }),
    ]);

    await incoming.locator(".delete-file").click();
    await expect.poll(() => listStagedFiles(receiver)).toEqual([]);
    await peer.close();
    await receiver.close();
  });

  test("does not offer inline opening for automatically staged active content", async ({ context }) => {
    const { receiver, peer } = await openConnectedOPFSReceiver(context);
    for (const [name, mimeType, contents] of [
      ["unsafe-document.html", "text/html", "<script>location='https://example.invalid'</script>"],
      ["unsafe-vector.svg", "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"],
      ["unsafe-program.exe", "application/x-msdownload", "MZ"],
    ]) {
      await peer.locator("#send-file").setInputFiles({
        name,
        mimeType,
        buffer: Buffer.from(contents),
      });
      const incoming = receiver.locator(".incoming-transfer", { hasText: name });
      await expect(incoming).toHaveAttribute("data-finished", "true");
      await expect(incoming.locator(".open-file")).toBeHidden();
      await expect(incoming.locator(".export-file")).toBeVisible();
      await incoming.locator(".delete-file").click();
    }
    await expect.poll(() => listStagedFileSizes(receiver)).toEqual([]);
    await peer.close();
    await receiver.close();
  });

  test("limits one private session to twenty automatic receive items including zero-byte files", async ({ context }) => {
    const { receiver, peer } = await openConnectedOPFSReceiver(context);
    const files = Array.from({ length: 21 }, (_, index) => ({
      name: `zero-byte-${String(index + 1).padStart(2, "0")}.bin`,
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(0),
    }));

    await peer.locator("#send-file").setInputFiles(files);

    const automatic = receiver.locator(
      '.incoming-transfer[data-receive-mode="automatic"][data-finished="true"]',
    );
    await expect(automatic).toHaveCount(20);
    for (let index = 0; index < 20; index += 1) {
      const incoming = receiver.locator(".incoming-transfer", { hasText: files[index].name });
      await expect(incoming).toHaveAttribute("data-receive-mode", "automatic");
      await expect(incoming.locator(".save-file")).toBeHidden();
      await expect(incoming.locator(".export-file")).toBeVisible();
    }
    expect(await listStagedFileSizes(receiver)).toEqual(Array(20).fill(0));

    const twentyFirst = receiver.locator(".incoming-transfer", { hasText: files[20].name });
    await expect(twentyFirst).toHaveAttribute("data-receive-mode", "manual");
    await expect(twentyFirst.locator(".save-file")).toBeVisible();
    await expect(twentyFirst.locator(".reject-file")).toBeVisible();
    await receiver.waitForTimeout(300);
    expect(await receiver.evaluate(() => globalThis.tcTest.recvBytes)).toBe(0);
    expect(await peer.evaluate(() => globalThis.tcTest.sentBytes)).toBe(0);
    await expect(twentyFirst).not.toHaveAttribute("data-finished", "true");

    await twentyFirst.locator(".reject-file").click();
    await expect(peer.locator(".transfer-item", { hasText: files[20].name })).toContainText(/declined|rejected/iu);
    await peer.close();
    await receiver.close();
  });

  test("automatically receives a private file of exactly 100 MiB", async ({ context }) => {
    test.setTimeout(300_000);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "tailcat-auto-boundary-"));
    const exactThreshold = 100 * 1024 * 1024;
    try {
      const { receiver, peer } = await openConnectedOPFSReceiver(context);
      const name = "exactly-100-mib.bin";
      const path = await createSparseFile(temporaryDirectory, name, exactThreshold);

      await peer.locator("#send-file").setInputFiles(path);

      const incoming = receiver.locator(".incoming-transfer", { hasText: name });
      await expect(incoming).toBeVisible();
      await expect.poll(
        () => receiver.evaluate(() => globalThis.tcTest.recvDone),
        { timeout: 240_000 },
      ).toBe(true);
      await expect(incoming.locator(".save-file")).toBeHidden();
      await expect(incoming.locator(".export-file")).toBeVisible();
      await expect(peer.locator(".transfer-item", { hasText: name })).toContainText(
        /received and SHA-256 verified/iu,
        { timeout: 240_000 },
      );
      expect(await listStagedFileSizes(receiver)).toEqual([exactThreshold]);

      await incoming.locator(".delete-file").click();
      await expect.poll(() => listStagedFileSizes(receiver)).toEqual([]);
      await peer.close();
      await receiver.close();
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("requires manual confirmation for a private file one byte above 100 MiB", async ({ context }) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "tailcat-manual-boundary-"));
    const aboveThreshold = (100 * 1024 * 1024) + 1;
    try {
      const { receiver, peer } = await openConnectedOPFSReceiver(context);
      await installMockSavePicker(receiver);
      const name = "100-mib-plus-one.bin";
      const path = await createSparseFile(temporaryDirectory, name, aboveThreshold);

      await peer.locator("#send-file").setInputFiles(path);

      const incoming = receiver.locator(".incoming-transfer", { hasText: name });
      await expect(incoming).toBeVisible();
      await expect(incoming.locator(".save-file")).toBeVisible();
      await expect(incoming.locator(".reject-file")).toBeVisible();
      await receiver.waitForTimeout(300);
      expect(await receiver.evaluate(() => globalThis.tcTest.recvBytes)).toBe(0);
      expect(await peer.evaluate(() => globalThis.tcTest.sentBytes)).toBe(0);
      expect(await receiver.evaluate(() => globalThis.__mockSave.pickerCalls)).toBe(0);

      await incoming.locator(".reject-file").click();
      await expect(peer.locator(".transfer-item", { hasText: name })).toContainText(/declined|rejected/iu);
      expect(await receiver.evaluate(() => globalThis.__mockSave.totalBytes)).toBe(0);
      await peer.close();
      await receiver.close();
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("falls back to a manual picker when automatic OPFS creation fails", async ({ context }) => {
    const { receiver, peer } = await openConnectedOPFSReceiver(context);
    await installMockSavePicker(receiver);
    await receiver.evaluate(() => {
      const prototype = FileSystemFileHandle.prototype;
      const originalCreateWritable = prototype.createWritable;
      globalThis.__mockOPFSCreateFailures = 0;
      Object.defineProperty(prototype, "createWritable", {
        configurable: true,
        value: async function createWritable(...args) {
          if (globalThis.__mockOPFSCreateFailures === 0) {
            globalThis.__mockOPFSCreateFailures += 1;
            throw new DOMException("Injected OPFS create failure", "InvalidStateError");
          }
          return originalCreateWritable.apply(this, args);
        },
      });
    });
    const name = "opfs-fallback.txt";
    const contents = Buffer.from("save with the explicit picker after OPFS fails");

    await peer.locator("#send-file").setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: contents,
    });

    const incoming = receiver.locator(".incoming-transfer", { hasText: name });
    await expect(incoming).toBeVisible();
    await expect.poll(() => receiver.evaluate(() => globalThis.__mockOPFSCreateFailures)).toBe(1);
    await expect(incoming.locator(".save-file")).toBeVisible();
    await expect(incoming.locator(".save-file")).toBeEnabled();
    await expect(incoming.locator(".reject-file")).toBeVisible();
    expect(await receiver.evaluate(() => globalThis.tcTest.recvBytes)).toBe(0);
    expect(await receiver.evaluate(() => globalThis.__mockSave.pickerCalls)).toBe(0);

    await incoming.locator(".save-file").click();
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.recvDone)).toBe(true);
    expect(await receiver.evaluate(() => globalThis.__mockSave)).toEqual(expect.objectContaining({
      pickerCalls: 1,
      totalBytes: contents.length,
      closed: true,
      aborted: false,
    }));
    await expect(peer.locator(".transfer-item", { hasText: name })).toContainText(/received and SHA-256 verified/iu);
    await peer.close();
    await receiver.close();
  });

  test("does not evict an unexported OPFS file after more than 100 completed transfers", async ({ context }) => {
    test.setTimeout(180_000);
    const { receiver, peer } = await openConnectedOPFSReceiver(context);
    const stagedName = "keep-until-exported.bin";
    const stagedBytes = Buffer.from([11, 22, 33, 44]);

    await peer.locator("#send-file").setInputFiles({
      name: stagedName,
      mimeType: "application/octet-stream",
      buffer: stagedBytes,
    });
    const staged = receiver.locator(".incoming-transfer", { hasText: stagedName });
    await expect(staged).toBeVisible();
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.recvDone)).toBe(true);
    await expect(staged.locator(".export-file")).toBeVisible();
    const [initialFile] = await listStagedFiles(receiver);
    expect(initialFile).toMatchObject({ size: stagedBytes.length, bytes: [...stagedBytes] });

    const historyFiles = Array.from({ length: 100 }, (_, index) => ({
      name: `history-${String(index).padStart(3, "0")}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.alloc(0),
    }));
    await receiver.locator("#send-file").setInputFiles(historyFiles);

    for (const file of historyFiles) {
      const incoming = peer.locator(".incoming-transfer", { hasText: file.name });
      await expect(incoming).toBeVisible();
      await incoming.locator(".save-file").click();
      const outgoing = receiver.locator(".transfer-item", { hasText: file.name });
      await expect(outgoing).toHaveAttribute("data-finished", "true");
    }

    await expect(staged, "staged transfer remains in the tray until explicit export/delete").toBeAttached();
    await expect(staged.locator(".export-file")).toBeVisible();
    await expect(staged.locator(".delete-file")).toBeVisible();
    const retainedFiles = await listStagedFiles(receiver);
    expect(retainedFiles).toEqual([initialFile]);

    await staged.locator(".delete-file").click();
    await expect.poll(() => listStagedFiles(receiver)).toEqual([]);
    await peer.close();
    await receiver.close();
  });

  test("retains a verified staged file when closeWrite fails after DONE", async ({ context }) => {
    const { receiver, peer } = await openConnectedOPFSReceiver(context, {
      failCloseWriteAfterDone: true,
    });
    const name = "done-before-half-close.bin";
    const contents = Buffer.from("verified bytes survive a failed half-close");

    await peer.locator("#send-file").setInputFiles({
      name,
      mimeType: "application/octet-stream",
      buffer: contents,
    });
    const incoming = receiver.locator(".incoming-transfer", { hasText: name });
    await expect(incoming).toBeVisible();

    await expect.poll(() => receiver.evaluate(
      () => globalThis.__fileCloseWriteFailure || null,
    )).toEqual({ attempted: true, doneWritten: true });
    await expect.poll(() => peer.evaluate(() => globalThis.tcTest.sendDone)).toBe(true);
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.recvDone)).toBe(true);
    await expect(incoming.locator(".export-file")).toBeVisible();
    await expect(incoming.locator(".delete-file")).toBeVisible();
    expect(await listStagedFiles(receiver)).toEqual([
      expect.objectContaining({ size: contents.length, bytes: [...contents] }),
    ]);

    await incoming.locator(".delete-file").click();
    await expect.poll(() => listStagedFiles(receiver)).toEqual([]);
    await peer.close();
    await receiver.close();
  });

  test("implements the dedicated OPFS worker INIT, WRITE, CLOSE, and DELETE protocol", async ({ page }) => {
    await page.goto("/404.html");

    const result = await page.evaluate(async () => {
      const worker = new Worker("/opfs-worker.js", { name: "tailcat-opfs-test" });
      let sequence = 0;
      const pending = new Map();
      worker.addEventListener("message", ({ data }) => {
        const request = pending.get(data?.id);
        if (!request) return;
        pending.delete(data.id);
        if (data.ok) request.resolve(data.result);
        else request.reject(Object.assign(new Error(data.error?.message || "Worker request failed"), data.error));
      });
      worker.addEventListener("error", (event) => {
        for (const request of pending.values()) request.reject(new Error(event.message));
        pending.clear();
      });
      const request = (type, payload = {}, transfer = []) => new Promise((resolve, reject) => {
        const id = `request-${++sequence}`;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${type}`));
        }, 10_000);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timeout); resolve(value); },
          reject: (error) => { clearTimeout(timeout); reject(error); },
        });
        worker.postMessage({ id, type, ...payload }, transfer);
      });

      const transferId = "fedcba9876543210fedcba9876543210";
      try {
        await request("CLEANUP");
        const initialized = await request("INIT", { transferId });
        const chunk = new Uint8Array([0, 1, 2, 3, 127, 128, 254, 255]);
        const written = await request(
          "WRITE",
          { transferId, chunk: chunk.buffer },
          [chunk.buffer],
        );
        const closed = await request("CLOSE", { transferId });

        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle("tailcat-transfers", { create: true });
        const file = await (await directory.getFileHandle(transferId)).getFile();
        const stored = Array.from(new Uint8Array(await file.arrayBuffer()));
        let collisionCode = "";
        try {
          await request("INIT", { transferId });
        } catch (error) {
          collisionCode = error.code;
        }
        const storedAfterCollision = Array.from(new Uint8Array(
          await (await (await directory.getFileHandle(transferId)).getFile()).arrayBuffer(),
        ));
        const deleted = await request("DELETE", { transferId });
        let entryExists = true;
        try {
          await directory.getFileHandle(transferId);
        } catch (error) {
          if (error.name === "NotFoundError") entryExists = false;
          else throw error;
        }
        return { initialized, written, closed, stored, collisionCode, storedAfterCollision, deleted, entryExists };
      } finally {
        worker.terminate();
      }
    });

    expect(result).toEqual({
      initialized: { offset: 0 },
      written: { offset: 8 },
      closed: { size: 8 },
      stored: [0, 1, 2, 3, 127, 128, 254, 255],
      collisionCode: "STORAGE_FAILED",
      storedAfterCollision: [0, 1, 2, 3, 127, 128, 254, 255],
      deleted: { removed: true },
      entryExists: false,
    });
  });
});
