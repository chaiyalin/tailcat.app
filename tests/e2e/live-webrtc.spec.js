import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { installMockSavePicker } from "./mock-tailcat.js";

// A failed live run must not persist a trace or screenshot containing the
// one-time room address. The test reports only the app's sanitized path enum.
test.use({ trace: "off", screenshot: "off", video: "off" });

test("live WebRTC upgrades both peers and transfers verified data", async ({ browser }) => {
  test.skip(process.env.LIVE_WEBRTC !== "1", "live WebRTC smoke test is opt-in");
  test.setTimeout(360_000);

  const context = await browser.newContext({ locale: "en-US" });
  try {
    const host = await context.newPage();
    const guest = await context.newPage();
    await Promise.all([host.goto("/"), guest.goto("/")]);
    await Promise.all([
      host.waitForFunction(() => globalThis.tcTest?.ready === true),
      guest.waitForFunction(() => globalThis.tcTest?.ready === true),
    ]);

    for (const page of [host, guest]) {
      const runtime = await page.evaluate(() => ({
        labBuild: globalThis.__TAILCAT_WEBRTC_LAB__ === true,
        mockTransport: Boolean(globalThis.tcTest?.mockTransport || globalThis.__mockTailcat),
        transport: globalThis.tcTest?.runtime?.transportConfiguration || null,
      }));
      expect(runtime).toEqual({
        labBuild: true,
        mockTransport: false,
        transport: {
          compiled: true,
          enabled: true,
          stunURLs: ["stun:stun.cloudflare.com:3478"],
        },
      });
    }

    // The picker fixture only captures locally written bytes. Tailcat,
    // magicsock, DERP, ICE, and WebRTC remain the real WASM implementations.
    await installMockSavePicker(host);
    await Promise.all([
      host.locator("#region-select").selectOption("tok"),
      guest.locator("#region-select").selectOption("tok"),
    ]);
    await host.locator("#listen-btn").click();
    await expect.poll(
      () => host.evaluate(() => globalThis.tcTest.state.room),
      { timeout: 60_000 },
    ).toBe("open");

    const address = await host.locator("#listen-addr").textContent();
    if (!/^tc\S{32,}$/u.test(address || "")) {
      throw new Error("host did not create a valid Tailcat room address");
    }
    await guest.evaluate((roomAddress) => {
      const input = document.querySelector("#send-addr");
      if (!(input instanceof HTMLInputElement)) throw new Error("room address input is unavailable");
      input.value = roomAddress;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, address);
    await guest.locator("#connect-btn").click();
    await expect.poll(
      () => guest.evaluate(() => globalThis.tcTest.state.peer),
      { timeout: 240_000 },
    ).toBe("connected");
    await expect.poll(
      () => host.evaluate(() => globalThis.tcTest.state.peer),
      { timeout: 60_000 },
    ).toBe("connected");

    const sanitizedPaths = async () => Promise.all([host, guest].map((page) => page.evaluate(() => ({
      local: globalThis.tcTest.state.localPath,
      peer: globalThis.tcTest.state.peerPath,
      bilateral: globalThis.tcTest.state.bilateralPath,
    }))));
    await expect.poll(sanitizedPaths, {
      timeout: 60_000,
      message: "both pages should authenticate a bilateral WebRTC path",
    }).toEqual([
      { local: "webrtc", peer: "webrtc", bilateral: "webrtc" },
      { local: "webrtc", peer: "webrtc", bilateral: "webrtc" },
    ]);

    const guestText = `live WebRTC guest message ${Date.now()}`;
    await guest.locator("#send-text").fill(guestText);
    await guest.locator("#send-text-btn").click();
    await expect(host.locator(".message:not(.mine):not(.system) .bubble", { hasText: guestText })).toHaveText(guestText);

    const hostText = `live WebRTC host reply ${Date.now()}`;
    await host.locator("#send-text").fill(hostText);
    await host.locator("#send-text-btn").click();
    await expect(guest.locator(".message:not(.mine):not(.system) .bubble", { hasText: hostText })).toHaveText(hostText);

    const bytes = Buffer.alloc(64 * 1024 + 1);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const digest = createHash("sha256").update(bytes).digest("hex");
    const fileName = "live-webrtc-64k-plus-one.bin";
    await guest.locator("#send-file").setInputFiles({
      name: fileName,
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
    const offer = host.locator(".incoming-transfer", { hasText: fileName });
    await expect(offer).toBeVisible({ timeout: 90_000 });
    await offer.locator(".save-file").click();

    await expect.poll(
      () => guest.evaluate(() => globalThis.tcTest.sendDone),
      { timeout: 90_000 },
    ).toBe(true);
    await expect.poll(
      () => host.evaluate(() => globalThis.tcTest.recvDone),
      { timeout: 90_000 },
    ).toBe(true);
    expect(await guest.evaluate(() => ({
      bytes: globalThis.tcTest.sentBytes,
      digest: globalThis.tcTest.sentSha256,
    }))).toEqual({ bytes: bytes.length, digest });
    expect(await host.evaluate(() => ({
      bytes: globalThis.tcTest.recvBytes,
      digest: globalThis.tcTest.recvSha256,
    }))).toEqual({ bytes: bytes.length, digest });
    expect(await host.evaluate(() => ({ ...globalThis.__mockSave }))).toEqual(expect.objectContaining({
      writes: [64 * 1024, 1],
      totalBytes: bytes.length,
      closed: true,
      aborted: false,
    }));

    // The application protocol traffic must not have replaced or downgraded
    // the authenticated path after the transfer.
    expect(await sanitizedPaths()).toEqual([
      { local: "webrtc", peer: "webrtc", bilateral: "webrtc" },
      { local: "webrtc", peer: "webrtc", bilateral: "webrtc" },
    ]);
  } finally {
    await context.close();
  }
});
