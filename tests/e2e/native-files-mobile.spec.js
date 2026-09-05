import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMockPage, startMockRoom, connectMockPeer } from "./mock-tailcat.js";
import { installOPFSFixture } from "./mock-opfs.js";

test("mobile native files integrate with OPFS export and preserve the first-screen composer", async ({ context, browserName }) => {
  // Keep real DataChannels on both engines. Only WebKit storage is a fixture;
  // its ephemeral runner rejects OPFS before our application touches a file.
  if (browserName === "webkit") await installOPFSFixture(context);
  await context.route("https://127.0.0.1:4173/**", async (route) => {
    const response = await context.request.fetch(route.request().url().replace(/^https:/u, "http:"));
    await route.fulfill({ response });
  });
  await context.addInitScript(() => { globalThis.__TAILCAT_NATIVE_FILES__ = true; });
  const namespace = randomUUID();
  const receiver = await openMockPage(context, namespace, { url: "https://127.0.0.1:4173/" });
  const capability = await receiver.evaluate(async () => {
    let directory;
    try { await navigator.storage.getDirectory(); directory = "ok"; } catch (error) { directory = error.name + ": " + error.message; }
    return { ...tcTest.runtime.fileSink, directory };
  });
  expect(capability, JSON.stringify(capability)).toMatchObject({ opfs: true });
  const sender = await openMockPage(context, namespace, { url: "https://127.0.0.1:4173/" });
  await connectMockPeer(sender, await startMockRoom(receiver));
  const directory = await mkdtemp(join(tmpdir(), "tailcat-native-mobile-"));
  try {
    const bytes = Buffer.alloc(100 * 1024 * 1024, 37);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(directory, "mobile-100m.bin"); await writeFile(path, bytes);
    await sender.locator("#send-file").setInputFiles(path);
    await expect.poll(() => sender.evaluate(() => tcTest.sendDone), { timeout: 60_000 }).toBe(true);
    expect(await sender.evaluate(() => tcTest.sentSha256)).toBe(sha256);
    expect(await receiver.evaluate(() => tcTest.recvSha256)).toBe(sha256);
    await expect(receiver.locator(".incoming-transfer .export-file")).toBeVisible();
    expect(await sender.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const composer = await sender.locator("#send-text").boundingBox();
    expect(composer.y + composer.height).toBeLessThanOrEqual(await sender.evaluate(() => innerHeight));
    await sender.locator("#mobile-menu-btn").click();
    await expect(sender.locator("#force-derp")).toBeVisible();
    await sender.locator("#force-derp").check();
    expect(await sender.evaluate(() => localStorage.getItem("tailcat.forceDerp"))).toBe("1");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
