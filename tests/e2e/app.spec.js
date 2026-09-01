import { expect, test } from "@playwright/test";

async function waitForTransport(page) {
  await page.waitForFunction(() => globalThis.tcTest?.ready === true);
  const errors = await page.evaluate(() => globalThis.tcTest.errors);
  expect(errors).toEqual([]);
}

test("loads the local-only application shell and WASM bridge", async ({ page }) => {
  const remoteScripts = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.resourceType() === "script" && url.origin !== "http://127.0.0.1:4173") {
      remoteScripts.push(url.href);
    }
  });

  await page.goto("/");
  await waitForTransport(page);

  await expect(page.locator("#browser-blocker")).toHaveClass(/hidden/);
  await expect(page.locator("#listen-btn")).toBeEnabled();
  await expect(page.locator("footer")).toContainText(/Unofficial|非 Tailscale 官方/);
  expect(remoteScripts).toEqual([]);
});

test("consumes an invitation fragment before any request can contain it", async ({ page }) => {
  const requestedURLs = [];
  page.on("request", (request) => requestedURLs.push(request.url()));

  await page.goto("/#v=1&invite=tc-test-only-address");
  await page.waitForFunction(() => location.hash === "");
  await waitForTransport(page);

  expect(await page.evaluate(() => globalThis.tcTest.inviteConsumed)).toBe(true);
  expect(requestedURLs.every((url) => !url.includes("#") && !url.includes("tc-test-only-address"))).toBe(true);
});

test("passes deterministic protocol and boundary self-checks", async ({ page }) => {
  await page.goto("/");
  await waitForTransport(page);

  const result = await page.evaluate(() => globalThis.tcTest.runProtocolSelfTests());
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.checks).toEqual(expect.arrayContaining([
    "fragment",
    "frame-boundaries",
    "file-name",
    "file-sizes",
    "sha256",
    "session-lock",
  ]));
});

test("blocks Safari before starting an encrypted room", async ({ browser }) => {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  });
  const page = await context.newPage();
  await page.goto("/");

  await expect(page.locator("#browser-blocker")).not.toHaveClass(/hidden/);
  await expect(page.locator("#app")).toHaveClass(/hidden/);
  expect(await page.evaluate(() => globalThis.tcTest?.unsupported)).toBe(true);
  expect(await page.evaluate(() => globalThis.tcTest?.listenerStarted || false)).toBe(false);
  await context.close();
});

test("blocks Firefox before starting an encrypted room", async ({ browser }) => {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0",
  });
  const page = await context.newPage();
  await page.goto("/");

  await expect(page.locator("#browser-blocker")).not.toHaveClass(/hidden/);
  await expect(page.locator("#app")).toHaveClass(/hidden/);
  expect(await page.evaluate(() => globalThis.tcTest?.unsupported)).toBe(true);
  expect(await page.evaluate(() => globalThis.tcTest?.listenerStarted || false)).toBe(false);
  await context.close();
});

test("all policy links resolve without a SPA fallback", async ({ page }) => {
  for (const path of ["/privacy/", "/terms/", "/acceptable-use/", "/security/", "/licenses/"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.locator("body")).toContainText("tailcat.app");
  }

  for (const path of ["/LICENSE", "/THIRD_PARTY_NOTICES.md", "/licenses/APACHE-2.0.txt"]) {
    const artifact = await page.request.get(path);
    expect(artifact.status(), path).toBe(200);
    expect((await artifact.body()).length, path).toBeGreaterThan(1000);
  }

  const response = await page.goto("/does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.locator("body")).toContainText("404");
});
