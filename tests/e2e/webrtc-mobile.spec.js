import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  connectMockPeer,
  openMockPage,
  startMockRoom,
} from "./mock-tailcat.js";

const experimentalBuild = process.env.TAILCAT_WEBRTC_EXPERIMENT === "1";

test.beforeEach(async ({ context }) => {
  // WebKit applies production's upgrade-insecure-requests policy to loopback
  // subresources. Keep this deterministic fixture on its local HTTP server.
  await context.route("https://127.0.0.1:4173/**", async (route) => {
    const response = await context.request.fetch(route.request().url().replace(/^https:/u, "http:"));
    await route.fulfill({ response });
  });
  // The transport is a BroadcastChannel fixture. Fail closed if a regression
  // tries to reach a real DERP, STUN, or other network service in Gate 1.
  await context.route(/^(?:https?|wss):\/\/(?!127\.0\.0\.1:4173(?:\/|$))/u, (route) => (
    route.abort("blockedbyclient")
  ));
});

function expectedChannel(projectName) {
  if (projectName === "android-chrome") return "android-chrome";
  if (projectName === "ios-safari") return "ios-safari";
  throw new Error(`unexpected mobile project: ${projectName}`);
}

async function sendText(page, text) {
  await page.locator("#send-text").fill(text);
  await page.locator("#send-text-btn").click();
}

async function stopRoomFromMobileShell(page) {
  const stopButton = page.locator("#stop-listen-btn");
  if (!(await stopButton.isVisible())) await page.locator("#mobile-menu-btn").click();
  await expect(stopButton).toBeVisible();
  await stopButton.click();
}

async function expectTransportClosed(page) {
  await expect.poll(async () => {
    const snapshot = await page.evaluate(() => globalThis.__mockTailcat.snapshot());
    const client = snapshot.clients[0];
    const clientStreams = snapshot.records.filter(({ clientId }) => clientId === client?.id);
    return Boolean(client?.closed)
      && Boolean(client?.aborted)
      && clientStreams.every(({ closed }) => closed);
  }).toBe(true);
}

test("mobile WebRTC lab reuses one client, advances path revisions, falls back, and cleans up", async ({ context }, testInfo) => {
  test.skip(!experimentalBuild, "requires the WebRTC-tagged WASM artifact");
  const namespace = randomUUID();
  const host = await openMockPage(context, namespace, { webRTCLab: true });
  const guest = await openMockPage(context, namespace, { webRTCLab: true });

  for (const page of [host, guest]) {
    expect(await page.evaluate(() => globalThis.tcTest.runtime)).toEqual(expect.objectContaining({
      channel: expectedChannel(testInfo.project.name),
      magicsockWebRTC: true,
      transportConfiguration: {
        compiled: true,
        enabled: true,
        stunURLs: ["stun:stun.cloudflare.com:3478"],
      },
    }));
  }

  const address = await startMockRoom(host);
  await connectMockPeer(guest, address);
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.bilateralPath)).toBe("webrtc");
  await expect.poll(() => guest.evaluate(() => globalThis.tcTest.state.bilateralPath)).toBe("webrtc");

  await sendText(guest, "mobile persistent transport");
  await expect(host.locator(".message:not(.mine)", { hasText: "mobile persistent transport" })).toHaveCount(1);
  await sendText(host, "mobile persistent transport reply");
  await expect(guest.locator(".message:not(.mine)", { hasText: "mobile persistent transport reply" })).toHaveCount(1);

  for (const page of [host, guest]) {
    const snapshot = await page.evaluate(() => globalThis.__mockTailcat.snapshot());
    expect(snapshot.clients).toHaveLength(1);
    expect(snapshot.clients[0]).toMatchObject({
      closed: false,
      signalProvided: true,
      aborted: false,
    });
    expect(snapshot.clients[0].dialPorts).toContain(100);
    expect(snapshot.clients[0].dialPorts).toContain(101);
    expect(new Set(snapshot.records
      .filter(({ direction, clientId }) => direction === "outbound" && clientId)
      .map(({ clientId }) => clientId))).toEqual(new Set([snapshot.clients[0].id]));
  }

  const directRevision = await host.evaluate(() => globalThis.tcTest.state.peerPathRevision);
  expect(directRevision).toBeGreaterThanOrEqual(1);

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
  }, { addr: address, revision: directRevision + 100 });
  expect(await host.evaluate(() => globalThis.tcTest.state.peerPathRevision)).toBe(directRevision);
  await guest.evaluate(async ({ addr, activeSession, revision }) => {
    await globalThis.__mockTailcat.sendEnvelope(addr, {
      type: "PATH_STATUS",
      v: 1,
      session: activeSession,
      revision,
      path: "derp",
    });
  }, { addr: address, activeSession: session, revision: directRevision });
  expect(await host.evaluate(() => globalThis.tcTest.state.peerPathRevision)).toBe(directRevision);

  await guest.evaluate(() => {
    globalThis.__mockTailcat.setPath("derp");
    document.dispatchEvent(new Event("freeze"));
    document.dispatchEvent(new Event("resume"));
  });
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.peerPath)).toBe("derp");
  const fallbackRevision = await host.evaluate(() => globalThis.tcTest.state.peerPathRevision);
  expect(fallbackRevision).toBeGreaterThan(directRevision);
  await expect(host.locator("#peer-path-label")).toHaveAttribute("data-path", "derp");
  expect(await host.evaluate(() => globalThis.tcTest.state.bilateralPath)).toBe("mixed");
  await host.locator("#mobile-menu-btn").click();
  await expect(host.locator("#local-path-label")).toBeVisible();
  await expect(host.locator("#peer-path-label")).toBeVisible();
  await expect(host.locator("#transport-path-note")).toHaveText(/\S/u);

  await guest.evaluate(() => {
    globalThis.__mockTailcat.setPath("webrtc");
    document.dispatchEvent(new Event("freeze"));
    document.dispatchEvent(new Event("resume"));
  });
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.peerPath)).toBe("webrtc");
  expect(await host.evaluate(() => globalThis.tcTest.state.peerPathRevision)).toBeGreaterThan(fallbackRevision);
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.bilateralPath)).toBe("webrtc");

  await stopRoomFromMobileShell(host);
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.room)).toBe("closed");
  await expect.poll(() => guest.evaluate(() => globalThis.tcTest.state.peer)).toBe("none");
  await expectTransportClosed(host);
  await expectTransportClosed(guest);
});

test("mobile DERP fallback preserves messaging and the normal build kill switch", async ({ context }, testInfo) => {
  const namespace = randomUUID();
  const host = await openMockPage(context, namespace, { webRTCLab: experimentalBuild });
  const guest = await openMockPage(context, namespace, { webRTCLab: experimentalBuild });
  await host.evaluate(() => globalThis.__mockTailcat.setPath("derp"));
  await guest.evaluate(() => globalThis.__mockTailcat.setPath("derp"));

  expect(await host.evaluate(() => globalThis.tcTest.runtime.channel)).toBe(expectedChannel(testInfo.project.name));
  const address = await startMockRoom(host);
  await connectMockPeer(guest, address);
  await sendText(guest, "mobile DERP fallback");
  await expect(host.locator(".message:not(.mine)", { hasText: "mobile DERP fallback" })).toHaveCount(1);
  await sendText(host, "mobile DERP fallback reply");
  await expect(guest.locator(".message:not(.mine)", { hasText: "mobile DERP fallback reply" })).toHaveCount(1);

  for (const page of [host, guest]) {
    const snapshot = await page.evaluate(() => globalThis.__mockTailcat.snapshot());
    if (experimentalBuild) {
      expect(snapshot.clients).toHaveLength(1);
      expect(snapshot.clients[0].dialPorts).toEqual(expect.arrayContaining([100, 101]));
      await expect.poll(() => page.evaluate(() => globalThis.tcTest.state.bilateralPath)).toBe("derp");
      await expect(page.locator("#local-path-label")).toHaveAttribute("data-path", "derp");
      await expect(page.locator("#peer-path-label")).toHaveAttribute("data-path", "derp");
    } else {
      expect(snapshot.clients).toHaveLength(0);
      expect(snapshot.legacyDialCount).toBeGreaterThan(0);
      expect(await page.evaluate(() => globalThis.tcTest.runtime.magicsockWebRTC)).toBe(false);
      expect(await page.evaluate(() => globalThis.tcTest.state.localPath)).toBe("derp");
      await expect(page.locator("#peer-path-label")).toHaveAttribute("data-path", "unsupported");
    }
  }

  const hello = (await guest.evaluate(() => globalThis.__mockTailcat.snapshot())).records
    .find(({ envelope }) => envelope?.type === "HELLO")?.envelope;
  if (experimentalBuild) {
    expect(hello?.capabilities?.transport).toEqual({ magicsockWebRTC: true, pathStatus: 1 });
  } else {
    expect(hello?.capabilities?.transport).toBeUndefined();
  }

  await stopRoomFromMobileShell(host);
  await expect.poll(() => guest.evaluate(() => globalThis.tcTest.state.peer)).toBe("none");
  if (experimentalBuild) {
    await expectTransportClosed(host);
    await expectTransportClosed(guest);
  }
});
