import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("publishes the production security and compressed-WASM headers", async ({ request }) => {
  const configured = await readFile(resolve(process.cwd(), "dist/_headers"), "utf8");
  expect(configured).toContain("Content-Security-Policy:");
  expect(configured).toContain("connect-src 'self' https://tailcat.dev https://*.ipn.dev wss://*.ipn.dev");
  expect(configured).toContain("frame-ancestors 'none'");
  expect(configured).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(configured).toContain("worker-src 'self' blob:");
  expect(configured).toContain("upgrade-insecure-requests");
  expect(configured).toContain("X-Robots-Tag: noindex, nofollow, noarchive");
  expect(configured).toMatch(/\/main\.wasm\.gz\s+[\s\S]*Content-Type: application\/gzip/u);
  expect(configured).toMatch(/\/main\.wasm\.gz\s+[\s\S]*! Content-Encoding/u);

  const home = await request.get("/");
  expect(home.status()).toBe(200);
  expect(home.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(home.headers()["content-security-policy"]).toContain("wss://*.ipn.dev");
  expect(home.headers()["content-security-policy"]).toContain("https://*.ipn.dev");
  expect(home.headers()["content-security-policy"]).not.toContain("upgrade-insecure-requests");
  expect(home.headers()["x-robots-tag"]).toContain("noindex");
  expect(home.headers()["x-frame-options"]).toBe("DENY");
  expect(home.headers()["referrer-policy"]).toBe("no-referrer");

  const wasm = await request.head("/main.wasm.gz");
  expect(wasm.status()).toBe(200);
  expect(wasm.headers()["content-type"]).toBe("application/gzip");
  expect(wasm.headers()["content-encoding"]).toBeUndefined();
  expect(wasm.headers()["cache-control"]).toContain("no-transform");

  const uncompressedWasm = await request.get("/main.wasm");
  expect(uncompressedWasm.status()).toBe(404);

  const opfsWorker = await request.get("/opfs-worker.js");
  expect(opfsWorker.status()).toBe(200);

  const missing = await request.get("/definitely-not-a-real-route");
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain("Page not found");
});
