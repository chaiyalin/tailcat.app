import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node tests/e2e/server.mjs",
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    { name: "chrome", testIgnore: /mobile\.spec\.js/u, use: { channel: "chrome" } },
    { name: "edge", testIgnore: /mobile\.spec\.js/u, use: { channel: "msedge" } },
    {
      name: "android-chrome",
      testMatch: /mobile\.spec\.js/u,
      use: {
        channel: "chrome",
        userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36",
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 2.625,
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: "ios-safari",
      testMatch: /mobile\.spec\.js/u,
      use: {
        // Safari upgrades loopback subresources under the production CSP. Use
        // one synthetic HTTPS origin from the first navigation so classic
        // wasm_exec.js cannot race the module graph while test routes proxy
        // requests to the local HTTP fixture.
        baseURL: "https://127.0.0.1:4173",
        browserName: "webkit",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
