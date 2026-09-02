import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  connectMockPeer,
  openMockPage,
  startMockRoom,
} from "./mock-tailcat.js";

const experimentalBuild = process.env.TAILCAT_WEBRTC_EXPERIMENT === "1";

async function openLabPair(context, namespace) {
  return Promise.all([
    openMockPage(context, namespace, { webRTCLab: true }),
    openMockPage(context, namespace, { webRTCLab: true }),
  ]);
}

async function sendText(page, text) {
  await page.locator("#send-text").fill(text);
  await page.locator("#send-text-btn").click();
}

async function installInviteSinks(page) {
  await page.evaluate(() => {
    globalThis.__inviteEffects = { copied: "", shared: null };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value) {
          globalThis.__inviteEffects.copied = String(value);
        },
      },
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (details) => {
        globalThis.__inviteEffects.shared = { ...details };
      },
    });
  });
}

async function qrMatches(page, expectedURL) {
  return page.evaluate(async (value) => {
    const { encode } = await import("/vendor/uqr.js");
    const expected = encode(value, { ecc: "M", border: 4 });
    const canvas = document.getElementById("qr-canvas");
    const scale = Math.max(2, Math.floor(512 / expected.size));
    if (canvas.width !== expected.size * scale || canvas.height !== expected.size * scale) return false;
    const pixels = canvas.getContext("2d", { alpha: false }).getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    ).data;
    for (let y = 0; y < expected.size; y += 1) {
      for (let x = 0; x < expected.size; x += 1) {
        const sampleX = x * scale + Math.floor(scale / 2);
        const sampleY = y * scale + Math.floor(scale / 2);
        const offset = (sampleY * canvas.width + sampleX) * 4;
        const black = pixels[offset] < 128 && pixels[offset + 1] < 128 && pixels[offset + 2] < 128;
        if (black !== Boolean(expected.data[y][x])) return false;
      }
    }
    return true;
  }, expectedURL);
}

test("keeps lab invitations on the protected preview origin for copy, share, and QR", async ({ browser }) => {
  test.skip(!experimentalBuild, "requires the WebRTC-tagged WASM artifact");
  const context = await browser.newContext({ locale: "en-US" });
  try {
    const host = await openMockPage(context, randomUUID(), { webRTCLab: true });
    const address = await startMockRoom(host);
    const previewOrigin = new URL(host.url()).origin;
    const expectedURL = `${previewOrigin}/#${new URLSearchParams({ v: "1", invite: address })}`;
    await installInviteSinks(host);

    await host.locator("#copy-invite").click();
    await expect.poll(() => host.evaluate(() => globalThis.__inviteEffects.copied)).toBe(expectedURL);
    // The native-share control is intentionally mobile-only; invoke the same
    // DOM activation handler here while retaining the deterministic desktop
    // transport fixture used by the rest of this suite.
    await host.locator("#share-invite").evaluate((button) => button.click());
    await expect.poll(() => host.evaluate(() => globalThis.__inviteEffects.shared?.url)).toBe(expectedURL);
    await host.locator("#show-qr").click();
    await expect(host.locator("#qr-dialog")).toBeVisible();
    expect(await qrMatches(host, expectedURL)).toBe(true);

    const requestedURLs = [];
    const joiner = await context.newPage();
    await joiner.addInitScript(() => {
      // Keep this page in the deterministic unsupported state: fragment
      // consumption happens before browser admission or any transport starts.
      Object.defineProperty(globalThis, "DecompressionStream", {
        configurable: true,
        value: undefined,
      });
    });
    joiner.on("request", (request) => requestedURLs.push(request.url()));
    await joiner.goto(expectedURL);
    await joiner.waitForFunction(() => location.hash === "" && globalThis.tcTest?.inviteConsumed === true);
    expect(await joiner.evaluate(() => globalThis.tcTest.inviteConsumed)).toBe(true);
    expect(requestedURLs.every((url) => !url.includes("#") && !url.includes(address))).toBe(true);
  } finally {
    await context.close();
  }
});

test("reuses one persistent peer client across control and message ports, then closes it", async ({ browser }) => {
  test.skip(!experimentalBuild, "requires the WebRTC-tagged WASM artifact");
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const [host, guest] = await openLabPair(context, namespace);
    expect(await host.evaluate(() => globalThis.tcTest.runtime.transportConfiguration)).toEqual({
      compiled: true,
      enabled: true,
      stunURLs: ["stun:stun.cloudflare.com:3478"],
    });
    const address = await startMockRoom(host);
    await connectMockPeer(guest, address);
    await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.bilateralPath)).toBe("webrtc");
    await expect.poll(() => guest.evaluate(() => globalThis.tcTest.state.bilateralPath)).toBe("webrtc");

    await sendText(guest, "persistent guest message");
    await expect(host.locator(".message:not(.mine)", { hasText: "persistent guest message" })).toHaveCount(1);
    await sendText(host, "persistent host message");
    await expect(guest.locator(".message:not(.mine)", { hasText: "persistent host message" })).toHaveCount(1);

    for (const page of [host, guest]) {
      const snapshot = await page.evaluate(() => globalThis.__mockTailcat.snapshot());
      expect(snapshot.clients).toHaveLength(1);
      expect(snapshot.clients[0].closed).toBe(false);
      expect(snapshot.clients[0].signalProvided).toBe(true);
      expect(snapshot.clients[0].aborted).toBe(false);
      expect(snapshot.clients[0].dialPorts).toContain(100);
      expect(snapshot.clients[0].dialPorts).toContain(101);
      expect(new Set(snapshot.records
        .filter(({ direction, clientId }) => direction === "outbound" && clientId)
        .map(({ clientId }) => clientId))).toEqual(new Set([snapshot.clients[0].id]));
    }

    await host.locator("#stop-listen-btn").click();
    await expect.poll(() => guest.evaluate(() => globalThis.tcTest.state.peer)).toBe("none");
    await expect.poll(async () => {
      const snapshot = await host.evaluate(() => globalThis.__mockTailcat.snapshot());
      return snapshot.clients[0]?.closed && snapshot.clients[0]?.aborted;
    }).toBe(true);
  } finally {
    await context.close();
  }
});

test("publishes authenticated monotonic path status on the locked probe schedule", async ({ browser }) => {
  test.skip(!experimentalBuild, "requires the WebRTC-tagged WASM artifact");
  test.setTimeout(60_000);
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const [host, guest] = await openLabPair(context, namespace);
    const address = await startMockRoom(host);
    await connectMockPeer(guest, address);
    await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.bilateralPath)).toBe("webrtc");

    // The absolute probe sequence starts at 0, 2, and 5 seconds. Reaching
    // three calls proves it is not creating a fresh client for each probe.
    await expect.poll(async () => {
      const snapshot = await guest.evaluate(() => globalThis.__mockTailcat.snapshot());
      return snapshot.clients[0]?.statusCalls || 0;
    }, { timeout: 8_000 }).toBeGreaterThanOrEqual(3);
    const before = await host.evaluate(() => ({ ...globalThis.tcTest.state }));
    expect(before.peerPath).toBe("webrtc");
    expect(before.peerPathRevision).toBe(1);
    expect(await guest.evaluate(() => globalThis.tcTest.state.localPathRevision)).toBe(1);

    const session = await guest.evaluate(() => globalThis.__mockTailcat.snapshot().records
      .find(({ envelope }) => envelope?.type === "HELLO_CONFIRM")?.envelope?.session);
    expect(session).toMatch(/^[0-9a-f]{32}$/u);

    await guest.evaluate(async ({ addr, revision }) => {
      await globalThis.__mockTailcat.sendEnvelope(addr, {
        type: "PATH_STATUS",
        v: 1,
        session: "f".repeat(32),
        revision,
        path: "derp",
      });
    }, { addr: address, revision: before.peerPathRevision + 100 });
    await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.peerPath)).toBe("webrtc");

    await guest.evaluate(async ({ addr, session: activeSession, revision }) => {
      await globalThis.__mockTailcat.sendEnvelope(addr, {
        type: "PATH_STATUS",
        v: 1,
        session: activeSession,
        revision,
        path: "derp",
      });
    }, { addr: address, session, revision: before.peerPathRevision });
    expect(await host.evaluate(() => globalThis.tcTest.state.peerPath)).toBe("webrtc");

    await guest.evaluate(async ({ addr, session: activeSession, revision }) => {
      await globalThis.__mockTailcat.sendEnvelope(addr, {
        type: "PATH_STATUS",
        v: 1,
        session: activeSession,
        revision,
        path: "peer-relay",
      });
    }, { addr: address, session, revision: before.peerPathRevision + 1 });
    expect(await host.evaluate(() => ({
      path: globalThis.tcTest.state.peerPath,
      revision: globalThis.tcTest.state.peerPathRevision,
    }))).toEqual({ path: "webrtc", revision: 1 });

    await guest.evaluate(() => globalThis.__mockTailcat.setPath("derp"));
    await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.peerPath)).toBe("derp");
    expect(await host.evaluate(() => globalThis.tcTest.state.peerPathRevision)).toBe(2);
    await expect(host.locator("#peer-path-label")).toHaveAttribute("data-path", "derp");

    const callsBeforeResume = await guest.evaluate(
      () => globalThis.__mockTailcat.snapshot().clients[0]?.statusCalls || 0,
    );
    await guest.evaluate(() => {
      document.dispatchEvent(new Event("freeze"));
      document.dispatchEvent(new Event("resume"));
    });
    await expect.poll(async () => {
      const snapshot = await guest.evaluate(() => globalThis.__mockTailcat.snapshot());
      return snapshot.clients[0]?.statusCalls || 0;
    }).toBeGreaterThan(callsBeforeResume);
    await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.peerPathRevision)).toBe(3);
    expect(await guest.evaluate(() => globalThis.tcTest.state.localPathRevision)).toBe(3);

    await guest.evaluate(() => globalThis.__mockTailcat.setPath("webrtc"));
    await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.peerPath)).toBe("webrtc");
    expect(await host.evaluate(() => globalThis.tcTest.state.peerPathRevision)).toBe(4);
  } finally {
    await context.close();
  }
});

test("aborts a persistent client that is still initializing when the room closes", async ({ browser }) => {
  test.skip(!experimentalBuild, "requires the WebRTC-tagged WASM artifact");
  const context = await browser.newContext({ locale: "en-US" });
  try {
    const page = await openMockPage(context, randomUUID(), { webRTCLab: true });
    await page.evaluate(() => globalThis.__mockTailcat.setConnectDelay(60_000));
    await page.locator("#send-addr").fill(`tc${"a".repeat(64)}`);
    await page.locator("#connect-btn").click();
    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => globalThis.__mockTailcat.snapshot());
      return snapshot.clients.length;
    }).toBe(1);
    await expect(page.locator("#stop-listen-btn")).toBeVisible();
    await page.locator("#stop-listen-btn").click();
    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => globalThis.__mockTailcat.snapshot());
      return snapshot.clients[0]?.aborted && snapshot.clients[0]?.closed;
    }).toBe(true);
  } finally {
    await context.close();
  }
});

test("sends handshake cancellation on an isolated one-shot dial before client teardown", async ({ browser }) => {
  test.skip(!experimentalBuild, "requires the WebRTC-tagged WASM artifact");
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const [host, guest] = await openLabPair(context, namespace);
    const address = await startMockRoom(host);
    await guest.evaluate(() => globalThis.__mockTailcat.failNextHelloConfirmCloseWrite());
    await guest.locator("#send-addr").fill(address);
    await guest.locator("#connect-btn").click();

    await expect.poll(async () => {
      const snapshot = await guest.evaluate(() => globalThis.__mockTailcat.snapshot());
      return snapshot.records.some(({ envelope }) => envelope?.type === "HELLO_CANCEL");
    }).toBe(true);
    const snapshot = await guest.evaluate(() => globalThis.__mockTailcat.snapshot());
    const cancel = snapshot.records.find(({ envelope }) => envelope?.type === "HELLO_CANCEL");
    expect(cancel?.clientId).toBeNull();
    expect(snapshot.legacyDialCount).toBeGreaterThan(0);
    expect(snapshot.clients[0]?.aborted).toBe(true);
    await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.peer)).toBe("none");
  } finally {
    await context.close();
  }
});

test("keeps a new page compatible with a peer that has no persistent transport capability", async ({ browser }) => {
  test.skip(!experimentalBuild, "requires the WebRTC-tagged WASM artifact");
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const [host, legacyPeer] = await openLabPair(context, namespace);
    await host.evaluate(() => globalThis.__mockTailcat.setPath("derp"));
    await legacyPeer.evaluate(() => { delete globalThis.tailcatConnect; });
    const address = await startMockRoom(host);
    await connectMockPeer(legacyPeer, address);
    await sendText(legacyPeer, "legacy fallback works");
    await expect(host.locator(".message:not(.mine)", { hasText: "legacy fallback works" })).toHaveCount(1);

    const hostSnapshot = await host.evaluate(() => globalThis.__mockTailcat.snapshot());
    const legacySnapshot = await legacyPeer.evaluate(() => globalThis.__mockTailcat.snapshot());
    const hello = legacySnapshot.records.find(({ envelope }) => envelope?.type === "HELLO")?.envelope;
    expect(hello?.capabilities?.transport).toBeUndefined();
    expect(hostSnapshot.clients).toHaveLength(1);
    expect(legacySnapshot.clients).toHaveLength(0);
    expect(legacySnapshot.legacyDialCount).toBeGreaterThan(0);
    await expect(host.locator("#peer-path-label")).toHaveAttribute("data-path", "unsupported");
    await expect(host.locator("#transport-path-note")).toContainText("does not support authenticated path reporting");
  } finally {
    await context.close();
  }
});

test("the normal-build kill switch suppresses the experiment and uses legacy DERP dials", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = randomUUID();
  try {
    const host = await openMockPage(context, namespace, { webRTCLab: false });
    const guest = await openMockPage(context, namespace, { webRTCLab: false });
    await expect(host.locator("#experiment-banner")).toBeHidden();
    expect(await host.evaluate(() => globalThis.tcTest.runtime.magicsockWebRTC)).toBe(false);

    const address = await startMockRoom(host);
    await installInviteSinks(host);
    await host.locator("#copy-invite").click();
    await expect.poll(() => host.evaluate(() => globalThis.__inviteEffects.copied)).toBe(
      `https://tailcat.app/#${new URLSearchParams({ v: "1", invite: address })}`,
    );
    await connectMockPeer(guest, address);
    await sendText(guest, "kill switch fallback");
    await expect(host.locator(".message:not(.mine)", { hasText: "kill switch fallback" })).toHaveCount(1);

    for (const page of [host, guest]) {
      const snapshot = await page.evaluate(() => globalThis.__mockTailcat.snapshot());
      expect(snapshot.clients).toHaveLength(0);
      expect(snapshot.legacyDialCount).toBeGreaterThan(0);
      expect(await page.evaluate(() => globalThis.tcTest.state.localPath)).toBe("derp");
      await expect(page.locator("#peer-path-label")).toHaveAttribute("data-path", "unsupported");
    }
    const hello = (await guest.evaluate(() => globalThis.__mockTailcat.snapshot())).records
      .find(({ envelope }) => envelope?.type === "HELLO")?.envelope;
    expect(hello?.capabilities?.transport).toBeUndefined();
  } finally {
    await context.close();
  }
});
