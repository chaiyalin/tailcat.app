import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

// Live invitations and transport endpoints must not enter retained artifacts.
test.use({ trace: "off", screenshot: "off",
  ...(process.env.LIVE_BASE_URL ? { baseURL: process.env.LIVE_BASE_URL } : {}) });

test("exchanges text and a verified file through the live Tokyo DERP relay", async ({ browser }) => {
  test.skip(process.env.LIVE_DERP !== "1", "live public-relay smoke test is opt-in");
  test.setTimeout(300_000);
  const context = await browser.newContext({ locale: "en-US" });
  try {
    if (process.env.LIVE_NATIVE === "1") await context.addInitScript(() => {
      globalThis.__TAILCAT_NATIVE_FILES__ = true;
      globalThis.__liveFilePCs = [];
      const NativePC = RTCPeerConnection;
      globalThis.RTCPeerConnection = class extends NativePC {
        constructor(config) {
          super(config);
          const start = performance.now();
          const diagnostic = { candidates: 0, timeline: [] }; __liveFilePCs.push(diagnostic);
          const state = () => diagnostic.timeline.push({ ms: Math.round(performance.now() - start),
            connection: this.connectionState, ice: this.iceConnectionState, signaling: this.signalingState,
            local: Boolean(this.localDescription), remote: Boolean(this.remoteDescription) });
          this.addEventListener("connectionstatechange", state);
          this.addEventListener("signalingstatechange", state);
          this.addEventListener("iceconnectionstatechange", state);
          this.addEventListener("icecandidate", ({ candidate }) => { if (candidate) diagnostic.candidates++; });
        }
      };
    });
    const host = await context.newPage();
    await host.goto("/");
    await host.waitForFunction(() => globalThis.tcTest?.ready === true);
    const guest = await context.newPage();
    await guest.goto("/");
    await guest.waitForFunction(() => globalThis.tcTest?.ready === true);
    expect(await host.evaluate(() => globalThis.tcTest.runtime.fileSink)).toMatchObject({
      opfs: true,
    });

    await host.locator("#region-select").selectOption("tok");
    await host.locator("#listen-btn").click();
    await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.room), { timeout: 60_000 }).toBe("open");
    const address = await host.locator("#listen-addr").textContent();
    expect(address).toMatch(/^tc\S{32,}$/u);

    await guest.locator("#send-addr").fill(address);
    await guest.locator("#connect-btn").click();
    await expect.poll(() => guest.evaluate(() => globalThis.tcTest.state.peer), { timeout: 240_000 }).toBe("connected");
    await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.peer)).toBe("connected");

    const text = `live DERP smoke ${Date.now()}`;
    await guest.locator("#send-text").fill(text);
    await guest.locator("#send-text-btn").click();
    await expect(host.locator(".message:not(.mine):not(.system) .bubble", { hasText: text })).toHaveText(text);
    await expect(guest.locator(".message.mine .bubble", { hasText: text })).toHaveText(text);

    await guest.locator("#send-file").setInputFiles({
      name: "live-one-byte.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0x5a]),
    });
    const offer = host.locator(".incoming-transfer", { hasText: "live-one-byte.bin" });
    await expect(offer).toBeVisible({ timeout: 90_000 });
    await expect(guest.locator(".transfer-item", { hasText: "live-one-byte.bin" })).toContainText(/received and SHA-256 verified/i, { timeout: 90_000 });
    await expect(offer.locator(".save-file")).toBeHidden();
    await expect(offer.locator(".export-file")).toBeVisible();
    expect(await host.evaluate(() => globalThis.tcTest.recvBytes)).toBe(1);
    if (process.env.LIVE_NATIVE === "1") {
      const bytes = Buffer.alloc(1024 * 1024, 47);
      const digest = createHash("sha256").update(bytes).digest("hex");
      await guest.locator("#send-file").setInputFiles({ name: "live-native.bin", mimeType: "application/octet-stream", buffer: bytes });
      const outgoing = guest.locator(".transfer-item", { hasText: "live-native.bin" });
      await expect(outgoing).toHaveAttribute("data-transport", "verified", { timeout: 90_000 });
      const diagnostics = await Promise.all([host, guest].map((page) => page.evaluate(() => ({ pcs: __liveFilePCs, errors: tcTest.errors }))));
      expect(await outgoing.getAttribute("data-route"), JSON.stringify(diagnostics)).toBe("webrtc");
      expect(await host.evaluate(() => tcTest.recvSha256)).toBe(digest);
      await guest.locator("#force-derp").check();
      await guest.locator("#send-file").setInputFiles({ name: "live-relay.bin", mimeType: "application/octet-stream", buffer: bytes });
      const relay = guest.locator(".transfer-item", { hasText: "live-relay.bin" });
      await expect(relay).toHaveAttribute("data-transport", "verified", { timeout: 90_000 });
      await expect(relay).toHaveAttribute("data-route", "derp");
      expect(await host.evaluate(() => tcTest.recvSha256)).toBe(digest);
    }
  } finally {
    await context.close();
  }
});
