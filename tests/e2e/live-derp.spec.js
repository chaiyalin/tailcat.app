import { expect, test } from "@playwright/test";
import { installMockSavePicker } from "./mock-tailcat.js";

test("exchanges text and a verified file through the live Tokyo DERP relay", async ({ browser }) => {
  test.skip(process.env.LIVE_DERP !== "1", "live public-relay smoke test is opt-in");
  test.setTimeout(300_000);
  const context = await browser.newContext({ locale: "en-US" });
  try {
    const host = await context.newPage();
    const guest = await context.newPage();
    await Promise.all([host.goto("/"), guest.goto("/")]);
    await Promise.all([
      host.waitForFunction(() => globalThis.tcTest?.ready === true),
      guest.waitForFunction(() => globalThis.tcTest?.ready === true),
    ]);
    await installMockSavePicker(host);

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
    await offer.locator(".save-file").click();
    await expect(guest.locator(".transfer-item", { hasText: "live-one-byte.bin" })).toContainText(/received and SHA-256 verified/i, { timeout: 90_000 });
    expect(await host.evaluate(() => globalThis.__mockSave)).toEqual(expect.objectContaining({
      totalBytes: 1,
      closed: true,
      aborted: false,
    }));
  } finally {
    await context.close();
  }
});
