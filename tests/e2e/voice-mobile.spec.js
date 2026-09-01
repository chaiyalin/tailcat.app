import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  connectMockPeer,
  installMockTailcat,
  startMockRoom,
} from "./mock-tailcat.js";

test.beforeEach(async ({ context }) => {
  // WebKit upgrades loopback subresources because the production CSP includes
  // upgrade-insecure-requests. Keep this deterministic local server on HTTP.
  await context.route("https://127.0.0.1:4173/**", async (route) => {
    const response = await context.request.fetch(route.request().url().replace(/^https:/u, "http:"));
    await route.fulfill({ response });
  });
});

async function installVoiceFixture(page, { observeWakeLock = false } = {}) {
  await page.evaluate(({ observeWakeLock: shouldObserveWakeLock }) => {
    globalThis.__voiceTrackStops = 0;
    globalThis.__wakeRequests = 0;
    globalThis.__wakeReleases = 0;

    const track = {
      enabled: true,
      kind: "audio",
      stop() {
        globalThis.__voiceTrackStops += 1;
      },
    };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
      getVideoTracks: () => [],
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => stream,
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "canPlayType", {
      configurable: true,
      value(type) {
        const compact = String(type).toLowerCase().replace(/\s+/gu, "");
        return compact === "audio/webm" || compact === "audio/webm;codecs=opus" ? "probably" : "";
      },
    });

    class MockMediaRecorder {
      static isTypeSupported(type) {
        return type === "audio/webm" || type === "audio/webm;codecs=opus";
      }

      constructor(_stream, options = {}) {
        this.mimeType = options.mimeType || "audio/webm";
        this.state = "inactive";
        this.ondataavailable = null;
        this.onstop = null;
      }

      start() {
        this.state = "recording";
        globalThis.__activeVoiceRecorder = this;
      }

      stop() {
        if (this.state !== "recording") return;
        this.state = "inactive";
        queueMicrotask(() => {
          this.ondataavailable?.({ data: new Blob(["mobile voice"], { type: this.mimeType }) });
          this.onstop?.();
        });
      }
    }
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: MockMediaRecorder,
    });

    if (shouldObserveWakeLock) {
      Object.defineProperty(navigator, "wakeLock", {
        configurable: true,
        value: {
          async request() {
            globalThis.__wakeRequests += 1;
            return {
              released: false,
              addEventListener() {},
              async release() {
                if (this.released) return;
                this.released = true;
                globalThis.__wakeReleases += 1;
              },
            };
          },
        },
      });
    }
  }, { observeWakeLock });
}

async function openVoicePage(context, namespace, options) {
  const page = await context.newPage();
  await page.goto("/");
  await installVoiceFixture(page, options);
  await installMockTailcat(page, namespace);
  return page;
}

async function openLargeTabletVoicePage(context, namespace) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1366, height: 1024 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
    });
  });
  await page.goto("/");
  await installVoiceFixture(page);
  await installMockTailcat(page, namespace);
  return page;
}

function dispatchPageHide(page, persisted) {
  return page.evaluate((isPersisted) => {
    let event;
    try {
      event = new PageTransitionEvent("pagehide", { persisted: isPersisted });
    } catch (_) {
      event = new Event("pagehide");
      Object.defineProperty(event, "persisted", { value: isPersisted });
    }
    dispatchEvent(event);
  }, persisted);
}

test("strictly normalizes voice MIME types and requires an exact mutual codec", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => globalThis.tcTest?.ready === true);
  const result = await page.evaluate(() => globalThis.tcTest.runProtocolSelfTests());
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.checks).toContain("voice-mime");
});

test("peer cleanup cancels an active recording, microphone, and wake lock", async ({ context }) => {
  const namespace = randomUUID();
  const recorderPage = await openVoicePage(context, namespace, { observeWakeLock: true });
  const peerPage = await openVoicePage(context, namespace);
  const address = await startMockRoom(recorderPage);
  await connectMockPeer(peerPage, address);

  const wakeBaseline = await recorderPage.evaluate(() => globalThis.__wakeReleases);
  await recorderPage.locator("#ptt-btn").click();
  await expect(recorderPage.locator("#status")).toContainText(/recording|tap again|录音/iu);
  await expect.poll(() => recorderPage.evaluate(() => globalThis.__wakeRequests)).toBeGreaterThan(0);

  await peerPage.locator("#stop-listen-btn").click();
  await expect.poll(() => recorderPage.evaluate(() => globalThis.tcTest.state.peer)).toBe("none");
  await expect.poll(() => recorderPage.evaluate(() => globalThis.__voiceTrackStops)).toBeGreaterThan(0);
  await expect.poll(() => recorderPage.evaluate(() => globalThis.__wakeReleases)).toBeGreaterThan(wakeBaseline);
  expect(await recorderPage.evaluate(() => globalThis.__activeVoiceRecorder?.state)).toBe("inactive");
  await expect(recorderPage.locator("#mobile-recording-controls")).toBeHidden();
});

test("keeps voice object URLs across BFCache pagehide and revokes them on final exit", async ({ context }) => {
  const namespace = randomUUID();
  const sender = await openVoicePage(context, namespace);
  const receiver = await openVoicePage(context, namespace);
  const address = await startMockRoom(receiver);
  await connectMockPeer(sender, address);

  await sender.evaluate(() => {
    globalThis.__revokedVoiceURLs = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (value) => {
      globalThis.__revokedVoiceURLs.push(String(value));
      revoke(value);
    };
  });
  await sender.locator("#ptt-btn").click();
  await expect(sender.locator("#mobile-recording-controls")).toBeVisible();
  await sender.locator("#mobile-record-send").click();
  await expect(sender.locator(".message.mine audio")).toHaveCount(1);

  const before = await sender.evaluate(() => globalThis.__revokedVoiceURLs.length);
  await dispatchPageHide(sender, true);
  expect(await sender.evaluate(() => globalThis.__revokedVoiceURLs.length)).toBe(before);
  await expect(sender.locator(".message.mine audio")).toHaveAttribute("src", /^blob:/u);

  await dispatchPageHide(sender, false);
  await expect.poll(() => sender.evaluate(() => globalThis.__revokedVoiceURLs.length)).toBeGreaterThan(before);
});

test("keeps tap-record send and cancel controls operable on a large landscape tablet", async ({ context }) => {
  const namespace = randomUUID();
  const tablet = await openLargeTabletVoicePage(context, namespace);
  const peer = await openVoicePage(context, namespace);
  const address = await startMockRoom(peer);
  await connectMockPeer(tablet, address);

  const assertRecordingControlsFit = async () => {
    const controls = tablet.locator("#mobile-recording-controls");
    const cancel = tablet.locator("#mobile-record-cancel");
    const send = tablet.locator("#mobile-record-send");
    await expect(controls).toBeVisible();
    await expect(cancel).toBeVisible();
    await expect(send).toBeVisible();
    await expect(cancel).toBeEnabled();
    await expect(send).toBeEnabled();

    const geometry = await tablet.evaluate(() => {
      const rectFor = (id) => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        cancel: rectFor("mobile-record-cancel"),
        send: rectFor("mobile-record-send"),
      };
    });
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport.width + 1);
    expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewport.width + 1);
    for (const button of [geometry.cancel, geometry.send]) {
      expect(button.left).toBeGreaterThanOrEqual(-1);
      expect(button.right).toBeLessThanOrEqual(geometry.viewport.width + 1);
      expect(button.top).toBeGreaterThanOrEqual(-1);
      expect(button.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1);
      expect(button.width).toBeGreaterThanOrEqual(44);
      expect(button.height).toBeGreaterThanOrEqual(44);
    }
  };

  await tablet.locator("#ptt-btn").click();
  await assertRecordingControlsFit();
  await tablet.locator("#mobile-record-cancel").click();
  await expect(tablet.locator("#mobile-recording-controls")).toBeHidden();
  await expect(tablet.locator(".message.mine audio")).toHaveCount(0);

  await tablet.locator("#ptt-btn").click();
  await assertRecordingControlsFit();
  await tablet.locator("#mobile-record-send").click();
  await expect(tablet.locator("#mobile-recording-controls")).toBeHidden();
  await expect(tablet.locator(".message.mine audio")).toHaveCount(1);
  await expect(peer.locator(".message:not(.mine) audio")).toHaveCount(1);
});
