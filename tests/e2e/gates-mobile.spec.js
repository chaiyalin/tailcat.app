import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  connectMockPeer,
  installMockTailcat,
  openMockPage,
  startMockRoom,
} from "./mock-tailcat.js";

const OPFS_HEADROOM_BYTES = 64 * 1024 * 1024;

test.beforeEach(async ({ context }) => {
  // WebKit upgrades loopback subresources because production's CSP includes
  // upgrade-insecure-requests. Keep the deterministic local fixture on HTTP.
  await context.route("https://127.0.0.1:4173/**", async (route) => {
    const response = await context.request.fetch(route.request().url().replace(/^https:/u, "http:"));
    await route.fulfill({ response });
  });
});

async function installMockOPFS(page, { maximumFileBytes, abortShare = false }) {
  await page.addInitScript(({ quotaBytes, shouldAbortShare }) => {
    const stored = new Map();
    const notFound = () => new DOMException("Entry not found", "NotFoundError");
    const directory = {
      async getFileHandle(name, options = {}) {
        if (!stored.has(name)) {
          if (!options.create) throw notFound();
          stored.set(name, { blob: new Blob([]) });
        }
        const entry = stored.get(name);
        return {
          name,
          async createWritable() {
            const parts = [];
            return {
              async write(value) {
                const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
                parts.push(bytes.slice());
              },
              async close() {
                entry.blob = new Blob(parts);
              },
              async abort() {
                stored.delete(name);
              },
            };
          },
          async getFile() {
            return new File([entry.blob], name, { type: "application/octet-stream" });
          },
        };
      },
      async removeEntry(name) {
        if (!stored.delete(name)) throw notFound();
      },
      async *entries() {
        for (const entry of stored.entries()) yield entry;
      },
    };

    Object.defineProperty(globalThis, "showSaveFilePicker", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        async getDirectory() {
          return {
            async getDirectoryHandle() {
              return directory;
            },
          };
        },
        async estimate() {
          let usage = 0;
          for (const entry of stored.values()) usage += entry.blob.size;
          return { quota: quotaBytes, usage };
        },
      },
    });
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        async request(name, options, callback) {
          return callback({ name, mode: options.mode || "exclusive" });
        },
      },
    });
    if (shouldAbortShare) {
      Object.defineProperty(navigator, "canShare", {
        configurable: true,
        value: () => true,
      });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async () => {
          throw new DOMException("Share cancelled", "AbortError");
        },
      });
    }
  }, {
    quotaBytes: OPFS_HEADROOM_BYTES + maximumFileBytes,
    shouldAbortShare: abortShare,
  });
}

async function countStagedFiles(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("tailcat-transfers");
    let count = 0;
    for await (const _ of directory.entries()) count += 1;
    return count;
  });
}

test("checks the session immediately after foregrounding and closes it when the peer is gone", async ({ context }) => {
  const namespace = randomUUID();
  const host = await openMockPage(context, namespace);
  const guest = await openMockPage(context, namespace);
  const address = await startMockRoom(host);
  await connectMockPeer(guest, address);

  await guest.evaluate(() => {
    document.dispatchEvent(new Event("freeze"));
    document.dispatchEvent(new Event("resume"));
  });
  await expect.poll(async () => {
    const snapshot = await guest.evaluate(() => globalThis.__mockTailcat.snapshot());
    return snapshot.records.some(({ direction, port, envelope }) => (
      direction === "outbound" && port === 100 && envelope?.type === "SESSION_PING"
    ));
  }).toBe(true);
  await expect.poll(() => guest.evaluate(() => globalThis.tcTest.state.peer)).toBe("connected");

  await guest.evaluate(() => {
    globalThis.__mockTailcat.setFailControlDials(true);
    document.dispatchEvent(new Event("freeze"));
    document.dispatchEvent(new Event("resume"));
  });
  await expect.poll(() => guest.evaluate(() => globalThis.tcTest.state.peer)).toBe("none");
  await expect(guest.locator("#status")).toContainText(/session (?:was lost|ended)|会话已失效/iu);
});

test("enforces the peer-advertised dynamic file limit before opening a file stream", async ({ context }) => {
  const namespace = randomUUID();
  const receiver = await context.newPage();
  const advertisedMaximum = 8;
  await installMockOPFS(receiver, { maximumFileBytes: advertisedMaximum });
  await receiver.goto("/");
  await installMockTailcat(receiver, namespace);
  expect(await receiver.evaluate(() => globalThis.tcTest.runtime.fileSink)).toMatchObject({
    kind: "opfs-export",
    maxBytes: advertisedMaximum,
    opfs: true,
  });

  const sender = await openMockPage(context, namespace);
  const address = await startMockRoom(receiver);
  await connectMockPeer(sender, address);
  await expect.poll(async () => {
    const snapshot = await receiver.evaluate(() => globalThis.__mockTailcat.snapshot());
    return snapshot.records.find(({ envelope }) => envelope?.type === "HELLO_ACK")
      ?.envelope?.capabilities?.file?.maxBytes;
  }).toBe(advertisedMaximum);

  const fileConnectionsBefore = await sender.evaluate(() => (
    globalThis.__mockTailcat.snapshot().records.filter(({ port }) => port === 102).length
  ));
  await sender.locator("#send-file").setInputFiles({
    name: "over-peer-limit.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(advertisedMaximum + 1, 0x5a),
  });

  await expect(sender.locator("#status")).toContainText(/receiver's current 8 B limit|对方当前最多可接收/iu);
  await expect(sender.locator("#transfer-list > li")).toHaveCount(0);
  expect(await sender.evaluate(() => (
    globalThis.__mockTailcat.snapshot().records.filter(({ port }) => port === 102).length
  ))).toBe(fileConnectionsBefore);
  expect(await sender.evaluate(() => globalThis.tcTest.sentBytes)).toBe(0);
  expect(await sender.evaluate(() => globalThis.tcTest.sendDone)).toBe(false);
});

test("deletes a verified OPFS file when the user cancels system sharing", async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== "ios-safari", "OPFS export and Web Share are the iOS receive path.");
  const namespace = randomUUID();
  const receiver = await context.newPage();
  await installMockOPFS(receiver, { maximumFileBytes: 1024, abortShare: true });
  await receiver.goto("/");
  await installMockTailcat(receiver, namespace);
  const sender = await openMockPage(context, namespace);
  const address = await startMockRoom(receiver);
  await connectMockPeer(sender, address);

  await sender.locator("#send-file").setInputFiles({
    name: "cancelled-share.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("verified before share cancellation"),
  });
  const incoming = receiver.locator(".incoming-transfer", { hasText: "cancelled-share.txt" });
  await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.recvDone)).toBe(true);
  await expect.poll(() => countStagedFiles(receiver)).toBe(1);

  await incoming.locator(".export-file").click();
  await expect.poll(() => countStagedFiles(receiver)).toBe(0);
  await expect(incoming.locator(".transfer-detail")).toContainText(/temporary local copy was deleted|已删除浏览器中的临时副本/iu);
  await expect(incoming.locator(".export-file")).toBeHidden();
  await expect(incoming.locator(".delete-file")).toBeHidden();
});
