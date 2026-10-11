// Real-WASM, disposable identities only. No raw error, invitation or key output.
import assert from "node:assert/strict";
delete process.env.DEBUG;
delete process.env.PWDEBUG;

let stage = "configuration";
const legacyURL = "https://6c2748cd.tailcat-app.pages.dev/";
const bounded = (promise, milliseconds = 30_000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("stage timeout")), milliseconds);
  })]).finally(() => clearTimeout(timer));
};

async function main() {
  if (process.env.LIVE_PERSISTENCE_LIFECYCLE !== "1") {
    console.log(JSON.stringify({ result: "skipped" }));
    return;
  }
  const url = new URL(process.env.TAILCAT_CANDIDATE_URL);
  assert.equal(url.protocol, "https:");
  assert(!url.username && !url.password && !url.search && !url.hash);
  const { chromium, expect } = await import("@playwright/test");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const legacy = await browser.newContext();
  const candidate = await browser.newContext();
  try {
    stage = "startup";
    const oldPage = await legacy.newPage();
    const page = await candidate.newPage();
    let active = 0;
    let peak = 0;
    page.on("websocket", (socket) => {
      if (!new URL(socket.url()).hostname.endsWith(".ipn.dev")) return;
      active += 1;
      peak = Math.max(peak, active);
      socket.on("close", () => { active -= 1; });
    });
    for (const [surface, location] of [[oldPage, legacyURL], [page, url.href]]) {
      await surface.goto(location, { timeout: 60_000 });
      await surface.waitForFunction(() => globalThis.tcTest?.ready === true, null, { timeout: 90_000 });
    }
    const manifest = await (await page.request.get(new URL("build-manifest.json", url).href)).json();
    assert.equal(manifest.dirty, false);
    assert.match(manifest.sourceSHA, /^[a-f0-9]{40}$/u);
    assert(manifest.modules.includes("github.com/tailscale/tailcat v0.7.0"));
    assert.match(await (await oldPage.request.get(new URL("config.js", legacyURL).href)).text(),
      /version:\s*"0\.3\.0-beta\.1"/u);

    stage = "legacy-identity";
    const fixture = await bounded(oldPage.evaluate(async () => {
      const listener = await tailcatListen({ derpMapURL: "https://tailcat.dev/derpmap.json",
        regionID: 304, verbose: false, onConnection(conn) { conn.close(); } });
      return { key: listener.privateKeyJSON, addr: listener.addr };
    }), 45_000);
    // Legacy JS close can deadlock during DERP initialization. Destroy only
    // this disposable old context; exercise the repaired close on the candidate.
    await bounded(legacy.close());
    for (let cycle = 0; cycle < 5; cycle += 1) {
      stage = cycle === 0 ? "restore-legacy-identity" : "ephemeral-create";
      const identity = await bounded(page.evaluate(async (key) => {
        globalThis.lifecycleListener = await tailcatListen({
          privateKey: key, derpMapURL: "https://tailcat.dev/derpmap.json",
          regionID: 304, verbose: false, onConnection(conn) { conn.close(); },
        });
        return { addr: lifecycleListener.addr, regionID: lifecycleListener.regionID };
      }, cycle === 0 ? fixture.key : ""), 45_000);
      if (cycle === 0) assert.equal(identity.addr, fixture.addr);
      assert.equal(identity.regionID, 304);
      stage = "immediate-close-and-event-loop";
      await bounded(page.evaluate(async () => {
        lifecycleListener.close();
        lifecycleListener.close();
        if (lifecycleListener.close !== Boolean) throw new Error("close shim not released");
        await new Promise((resolve) => setTimeout(resolve, 25));
        globalThis.lifecycleListener = null;
      }), 5_000);
      stage = "socket-cleanup";
      await expect.poll(() => active, { timeout: 15_000 }).toBe(0);
    }
    console.log(JSON.stringify({ result: "passed", sourceSHA: manifest.sourceSHA,
      legacyIdentityRestored: true, addressBytesUnchanged: true, closeCycles: 5,
      activeOfficialWebSockets: active, peakOfficialWebSockets: peak }));
  } finally {
    await bounded(legacy.close()).catch(() => {});
    await bounded(candidate.close()).catch(() => {});
    await bounded(browser.close());
  }
}

await main().catch(() => {
  console.error(JSON.stringify({ result: "failed", stage }));
  process.exitCode = 1;
});
