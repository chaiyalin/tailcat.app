import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  connectMockPeer,
  installMockTailcat,
  openMockPage,
  startMockRoom,
} from "./mock-tailcat.js";

const MOBILE_VIEWPORTS = Object.freeze([
  { label: "small portrait", width: 320, height: 568 },
  { label: "iPhone portrait", width: 390, height: 844 },
  { label: "Android portrait", width: 412, height: 915 },
  { label: "mobile landscape", width: 915, height: 412 },
]);

test.beforeEach(async ({ context }) => {
  // WebKit applies `upgrade-insecure-requests` to loopback subresources while
  // Chromium exempts localhost. Production is HTTPS; this route keeps the
  // HTTP-only deterministic test server usable without weakening the CSP.
  await context.route("https://127.0.0.1:4173/**", async (route) => {
    const response = await context.request.fetch(route.request().url().replace(/^https:/u, "http:"));
    await route.fulfill({ response });
  });
});

function expectedChannel(projectName) {
  if (projectName === "android-chrome") return "android-chrome";
  if (projectName === "ios-safari") return "ios-safari";
  throw new Error(`unexpected mobile project: ${projectName}`);
}

async function expectMobileState(page, state) {
  await expect.poll(() => page.locator("#app").getAttribute("data-mobile-state")).toBe(state);
}

async function installMockAsyncOPFS(context) {
  await context.addInitScript(() => {
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
        for (const [name, entry] of stored.entries()) yield [name, entry];
      },
    };
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
          return { quota: 2 * 1024 * 1024 * 1024, usage };
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
  });
}

async function expectConnectedShellFits(page, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  await expect(page.locator("#chat, #content").first()).toBeVisible();
  await expect(page.locator("#send-text")).toBeVisible();
  await expect(page.locator("#mobile-menu-btn")).toBeVisible();

  const metrics = await page.evaluate(() => {
    const viewportWidth = globalThis.visualViewport?.width ?? innerWidth;
    const viewportHeight = globalThis.visualViewport?.height ?? innerHeight;
    const input = document.getElementById("send-text").getBoundingClientRect();
    const composer = document.getElementById("composer").getBoundingClientRect();
    const menu = document.getElementById("mobile-menu-btn").getBoundingClientRect();
    const controls = ["attach-btn", "ptt-btn", "send-text-btn"].map((id) => {
      const element = document.getElementById(id);
      const rect = element.getBoundingClientRect();
      return { id, width: rect.width, height: rect.height };
    });
    return {
      viewportWidth,
      viewportHeight,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      input: { left: input.left, right: input.right, top: input.top, bottom: input.bottom, height: input.height },
      composer: { left: composer.left, right: composer.right, bottom: composer.bottom },
      menu: { width: menu.width, height: menu.height },
      controls,
    };
  });

  expect(metrics.documentWidth, `${viewport.label}: document overflow`).toBeLessThanOrEqual(Math.ceil(metrics.viewportWidth) + 1);
  expect(metrics.bodyWidth, `${viewport.label}: body overflow`).toBeLessThanOrEqual(Math.ceil(metrics.viewportWidth) + 1);
  expect(metrics.input.left, `${viewport.label}: input starts on-screen`).toBeGreaterThanOrEqual(-1);
  expect(metrics.input.right, `${viewport.label}: input ends on-screen`).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.input.top, `${viewport.label}: input starts in the viewport`).toBeGreaterThanOrEqual(-1);
  expect(metrics.input.bottom, `${viewport.label}: soft-keyboard-safe input`).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.input.height, `${viewport.label}: input touch height`).toBeGreaterThanOrEqual(44);
  expect(metrics.composer.left, `${viewport.label}: composer starts on-screen`).toBeGreaterThanOrEqual(-1);
  expect(metrics.composer.right, `${viewport.label}: composer ends on-screen`).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.composer.bottom, `${viewport.label}: composer is visible`).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.menu.width, `${viewport.label}: room menu touch width`).toBeGreaterThanOrEqual(44);
  expect(metrics.menu.height, `${viewport.label}: room menu touch height`).toBeGreaterThanOrEqual(44);
  for (const control of metrics.controls) {
    expect(control.width, `${viewport.label}: ${control.id} touch width`).toBeGreaterThanOrEqual(44);
    expect(control.height, `${viewport.label}: ${control.id} touch height`).toBeGreaterThanOrEqual(44);
  }
}

test("admits the official mobile platform only when every core capability is present", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.waitForFunction(() => globalThis.tcTest?.ready === true);

  await expect(page.locator("#browser-blocker")).toHaveClass(/hidden/u);
  await expect(page.locator("#app")).not.toHaveClass(/hidden/u);
  expect(await page.evaluate(() => globalThis.tcTest.runtime)).toEqual(expect.objectContaining({
    channel: expectedChannel(testInfo.project.name),
    coreReady: true,
    missing: [],
    officiallySupported: true,
  }));
});

test("fails closed for an official mobile UA when a core capability is missing", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "DecompressionStream", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("/");

  await expect(page.locator("#browser-blocker")).not.toHaveClass(/hidden/u);
  await expect(page.locator("#app")).toHaveClass(/hidden/u);
  expect(await page.evaluate(() => globalThis.tcTest.runtime)).toEqual(expect.objectContaining({
    channel: expectedChannel(testInfo.project.name),
    coreReady: false,
  }));
  expect(await page.evaluate(() => globalThis.tcTest.runtime.missing)).toContain("decompressionStream");
  expect(await page.evaluate(() => globalThis.tcTest.state.transport)).toBe("unsupported");
});

test("uses the phased mobile shell through landing, waiting, connected, and call", async ({ context }) => {
  const namespace = randomUUID();
  const host = await openMockPage(context, namespace);
  const guest = await openMockPage(context, namespace);

  await expectMobileState(host, "landing");
  await expect(host.locator("#mobile-controls-sheet")).toBeVisible();
  await expect(host.locator("#content")).toBeHidden();

  const address = await startMockRoom(host);
  await expectMobileState(host, "waiting");
  await expect(host.locator("#listen-info")).toBeVisible();
  await expect(host.locator("#share-invite")).toBeVisible();
  await expect(host.locator("#content")).toBeHidden();

  await connectMockPeer(guest, address);
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.peer)).toBe("connected");
  await expectMobileState(host, "connected");
  await expectMobileState(guest, "connected");

  for (const viewport of MOBILE_VIEWPORTS) {
    await expectConnectedShellFits(guest, viewport);
  }

  await guest.setViewportSize({ width: 412, height: 915 });
  await guest.evaluate(() => {
    const original = navigator.mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => new Promise(() => {}),
        getDisplayMedia: original?.getDisplayMedia?.bind(original),
        enumerateDevices: original?.enumerateDevices?.bind(original),
      },
    });
  });
  await guest.locator("#mobile-menu-btn").click();
  await expect(guest.locator("#app")).toHaveAttribute("data-mobile-sheet", "open");
  await guest.locator("#video-call-btn").click();
  await expect.poll(() => guest.evaluate(
    () => document.getElementById("app").dataset.mobileState,
  )).toBe("call");
  // A late connection/status render must not collapse an in-progress media
  // permission request back into the connected chat shell.
  await guest.evaluate(() => {
    const language = document.getElementById("language-select");
    language.value = language.value === "en" ? "zh" : "en";
    language.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expectMobileState(guest, "call");
  await expect(guest.locator("#media-dock")).toBeVisible();
  await expect(guest.locator("#media-hangup")).toBeVisible();
  await guest.locator("#media-hangup").click();
  await expectMobileState(guest, "connected");
});

test("does not send Enter while an IME composition is active", async ({ context }) => {
  const namespace = randomUUID();
  const receiver = await openMockPage(context, namespace);
  const sender = await openMockPage(context, namespace);
  const address = await startMockRoom(receiver);
  await connectMockPeer(sender, address);

  const composedText = "拼音输入尚未确认";
  await sender.locator("#send-text").fill(composedText);
  const dispatched = await sender.locator("#send-text").evaluate((field) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      isComposing: true,
    });
    field.dispatchEvent(event);
    return { composing: event.isComposing, prevented: event.defaultPrevented };
  });
  expect(dispatched).toEqual({ composing: true, prevented: false });
  await expect(sender.locator("#send-text")).toHaveValue(composedText);
  await expect(receiver.locator(".message:not(.system) .bubble", { hasText: composedText })).toHaveCount(0);

  await sender.locator("#send-text").press("Enter");
  await expect(receiver.locator(".message:not(.mine):not(.system) .bubble", { hasText: composedText })).toHaveText(composedText);
});

test("falls back to a temporary room without IndexedDB and copies when Web Share is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
  });
  const namespace = randomUUID();
  await page.goto("/");
  await installMockTailcat(page, namespace);

  await expect(page.locator("#persist-key").locator("xpath=..")).toBeHidden();
  await expect(page.locator("#persistent-unavailable")).toBeVisible();

  const firstAddress = await startMockRoom(page);
  await expectMobileState(page, "waiting");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value) {
          globalThis.__copiedMobileInvite = value;
        },
      },
    });
  });
  await page.locator("#share-invite").click();
  await expect.poll(() => page.evaluate(() => globalThis.__copiedMobileInvite || "")).toContain("https://tailcat.app/#v=1&invite=tc");

  await page.locator("#stop-listen-btn").click();
  await expect.poll(() => page.evaluate(() => globalThis.tcTest.state.room)).toBe("closed");
  const secondAddress = await startMockRoom(page);
  expect(secondAddress).not.toBe(firstAddress);
  await page.locator("#stop-listen-btn").click();
  await expectMobileState(page, "landing");
  await expect(page.locator("#persistent-unavailable")).toBeVisible();
});

test("stages an iOS OPFS receive under an opaque id and deletes the local copy", async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== "ios-safari", "OPFS export is the iOS Safari receive path");
  await installMockAsyncOPFS(context);
  const namespace = randomUUID();
  const receiver = await openMockPage(context, namespace);
  const sender = await openMockPage(context, namespace);
  const support = await receiver.evaluate(() => globalThis.tcTest.runtime.fileSink);
  expect(support).toMatchObject({ kind: "opfs-export", opfs: true });
  await receiver.evaluate(() => {
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => {
        throw new DOMException("Share target unavailable", "NotAllowedError");
      },
    });
    globalThis.__fallbackDownloads = 0;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function clickDownload() {
      if (this.download) {
        globalThis.__fallbackDownloads += 1;
        return;
      }
      return click.call(this);
    };
  });

  const address = await startMockRoom(receiver);
  await connectMockPeer(sender, address);
  const name = "ios-opfs-staged.txt";
  const contents = Buffer.from("streamed through the iOS OPFS staging sink");
  await sender.locator("#send-file").setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: contents,
  });
  const incoming = receiver.locator(".incoming-transfer", { hasText: name });
  await expect(incoming).toBeVisible();

  await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.recvDone)).toBe(true);
  await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.recvBytes)).toBe(contents.length);
  await expect(incoming.locator(".export-file")).toBeVisible();
  await expect(incoming.locator(".delete-file")).toBeVisible();
  await expect(incoming.locator(".transfer-local-note")).toContainText(/Verified|已校验/u);

  await incoming.locator(".export-file").click();
  await expect(incoming.locator(".transfer-detail")).toContainText(/sharing failed|系统分享失败/iu);
  await incoming.locator(".export-file").click();
  await expect.poll(() => receiver.evaluate(() => globalThis.__fallbackDownloads)).toBe(1);
  await expect(incoming.locator(".transfer-detail")).toContainText(/Download started|已开始下载/iu);

  const stagedNames = await receiver.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("tailcat-transfers");
    const names = [];
    for await (const [entryName] of directory.entries()) names.push(entryName);
    return names;
  });
  expect(stagedNames).toHaveLength(1);
  expect(stagedNames[0]).toMatch(/^[0-9a-f]{32}$/u);
  expect(stagedNames[0]).not.toBe(name);

  await sender.locator("#stop-listen-btn").click();
  await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.state.peer)).toBe("none");
  await expect(incoming.locator(".export-file")).toBeVisible();
  await expect(incoming.locator(".delete-file")).toBeVisible();

  await incoming.locator(".delete-file").click();
  await expect(incoming.locator(".transfer-detail")).toContainText(/temporary local copy was deleted|已删除浏览器中的临时副本/iu);
  await expect(incoming.locator(".export-file")).toBeHidden();
  await expect(incoming.locator(".delete-file")).toBeHidden();
  await expect.poll(() => receiver.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("tailcat-transfers");
    let count = 0;
    for await (const _ of directory.entries()) count += 1;
    return count;
  })).toBe(0);
});

test("keeps Safari private-mode rooms usable while disabling only file receive", async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== "ios-safari", "Private-mode storage fallback is specific to iOS Safari.");
  const namespace = randomUUID();
  const privateSafari = await context.newPage();
  await privateSafari.addInitScript(() => {
    Object.defineProperty(navigator, "storage", { configurable: true, value: undefined });
  });
  await privateSafari.goto("/");
  await installMockTailcat(privateSafari, namespace);

  const peer = await context.newPage();
  await peer.addInitScript(() => {
    globalThis.__privateModePeerSave = { bytes: 0, closed: false };
    Object.defineProperty(navigator, "storage", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "showSaveFilePicker", {
      configurable: true,
      value: async () => ({
        async createWritable() {
          return {
            async write(value) {
              const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
              globalThis.__privateModePeerSave.bytes += bytes.byteLength;
            },
            async close() {
              globalThis.__privateModePeerSave.closed = true;
            },
            async abort() {},
          };
        },
      }),
    });
  });
  await peer.goto("/");
  await installMockTailcat(peer, namespace);

  expect(await privateSafari.evaluate(() => globalThis.tcTest.runtime.fileSink)).toMatchObject({
    kind: null,
    maxBytes: 0,
    opfs: false,
  });
  await expect(privateSafari.locator("#capability-note")).toContainText(/cannot (?:safely )?receive files|不能接收文件/iu);

  const address = await startMockRoom(privateSafari);
  await connectMockPeer(peer, address);
  await privateSafari.locator("#send-text").fill("private mode text still works");
  await privateSafari.locator("#send-text").press("Enter");
  await expect(peer.locator(".message:not(.mine):not(.system) .bubble")).toContainText("private mode text still works");

  const payload = Buffer.from("Safari private mode can still send a file");
  await privateSafari.locator("#send-file").setInputFiles({
    name: "private-mode-send.txt",
    mimeType: "text/plain",
    buffer: payload,
  });
  const incoming = peer.locator(".incoming-transfer", { hasText: "private-mode-send.txt" });
  await incoming.locator(".save-file").click();
  await expect.poll(() => peer.evaluate(() => globalThis.tcTest.recvDone)).toBe(true);
  expect(await peer.evaluate(() => globalThis.__privateModePeerSave)).toEqual({
    bytes: payload.length,
    closed: true,
  });
});
