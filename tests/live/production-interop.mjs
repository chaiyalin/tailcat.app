// Opt-in, real-network compatibility acceptance. No mocked Tailcat transport,
// trace, screenshot, video, SDP, invitations or browser-console collection.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Protocol/action debug logs can include values filled into invitation inputs.
delete process.env.DEBUG;
delete process.env.PWDEBUG;

const enabled = process.env.LIVE_PRODUCTION_INTEROP === "1";
const withGroups = process.env.LIVE_INTEROP_GROUP !== "0";
const productionURL = "https://tailcat.app/";
const fileBytes = Number(process.env.TAILCAT_INTEROP_BYTES || 32 * 1024);
const timeout = { startup: 90_000, connect: 240_000, transfer: 180_000 };
let stage = "configuration";

function previewURL(value) {
  const url = new URL(value);
  assert(url.protocol === "https:" && !url.username && !url.password,
    "candidate must use public HTTPS");
  assert(url.hostname !== "tailcat.app" && url.hostname !== "www.tailcat.app",
    "candidate must be a separate preview");
  assert(url.pathname === "/" && !url.search && !url.hash,
    "candidate must be an origin without invitation parameters");
  return url.href;
}

async function buildInfo(page, expectedTailcat) {
  try {
    const response = await page.request.get(new URL("build-manifest.json", page.url()).href,
      { timeout: 20_000 });
    if (!response.ok()) return { sourceSHA: null, tailcatVersion: null, provenanceVerified: false };
    const manifest = await response.json();
    const tailcatLine = Array.isArray(manifest.modules)
      ? manifest.modules.find((line) => /^github\.com\/tailscale\/tailcat\s/u.test(line))
      : null;
    const tailcatVersion = tailcatLine?.trim().split(/\s+/u)[1] || null;
    if (!tailcatVersion) return { sourceSHA: null, tailcatVersion: null, provenanceVerified: false };
    assert.equal(tailcatVersion, expectedTailcat, "unexpected Tailcat dependency");
    assert.equal(manifest.dirty, false, "only a clean committed build may be accepted");
    assert.match(manifest.sourceSHA || "", /^[a-f0-9]{40}$/u, "missing verifiable source SHA");
    return {
      sourceSHA: /^[a-f0-9]{40}$/u.test(manifest.sourceSHA || "") ? manifest.sourceSHA : null,
      tailcatVersion,
      provenanceVerified: true,
    };
  } catch (error) {
    if (error?.code === "ERR_ASSERTION") throw error;
    return { sourceSHA: null, tailcatVersion: null, provenanceVerified: false };
  }
}

async function openPage(context, url, label) {
  const page = await context.newPage();
  const relay = { sentBytes: 0, receivedBytes: 0, sockets: 0 };
  page.on("websocket", (socket) => {
    let official = false;
    try { official = new URL(socket.url()).hostname.endsWith(".ipn.dev"); } catch (_) {}
    if (!official) return;
    relay.sockets += 1;
    socket.on("framesent", ({ payload }) => {
      relay.sentBytes += typeof payload === "string" ? Buffer.byteLength(payload) : payload.length;
    });
    socket.on("framereceived", ({ payload }) => {
      relay.receivedBytes += typeof payload === "string" ? Buffer.byteLength(payload) : payload.length;
    });
  });
  stage = `${label}-startup`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeout.startup });
  await page.waitForFunction(() => globalThis.tcTest?.ready === true, null,
    { timeout: timeout.startup });
  await page.locator("#language-select").selectOption("en");
  const sink = await page.evaluate(() => globalThis.tcTest.runtime.fileSink);
  assert(sink?.opfs === true, "real OPFS receiving must be available");
  return { page, relay, label };
}

async function sendText(sender, receiver, text, expect) {
  await sender.locator("#send-text").fill(text);
  await sender.locator("#send-text-btn").click();
  await expect(receiver.locator(".message:not(.mine):not(.system) .bubble", { hasText: text }))
    .toHaveText(text, { timeout: timeout.connect });
}

async function temporaryFiles(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let directory;
    try { directory = await root.getDirectoryHandle("tailcat-transfers"); }
    catch (error) { if (error?.name === "NotFoundError") return []; throw error; }
    const result = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== "file") continue;
      const file = await handle.getFile();
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      result.push({
        size: file.size,
        sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      });
    }
    return result;
  });
}

async function sendFile(sender, receiver, label, group, expect) {
  stage = label;
  const bytes = Buffer.alloc(fileBytes, label.length);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const name = `${label}.bin`;
  assert.deepEqual(await temporaryFiles(receiver), [], "receiver should start with no staged files");
  await sender.evaluate(() => { globalThis.tcTest.sendDone = false; });
  await sender.locator("#send-file").setInputFiles({
    name, mimeType: "application/octet-stream", buffer: bytes,
  });
  const incoming = receiver.locator(".incoming-transfer", { hasText: name });
  const outgoing = sender.locator(".transfer-item", { hasText: name });
  await expect(incoming).toBeVisible({ timeout: timeout.transfer });
  // Private small files may already be receiving automatically. Group files
  // retain the real user-consent click, and use actual OPFS rather than a picker fixture.
  const accept = incoming.locator(".save-file");
  if (await accept.isVisible()) await accept.click();
  await expect(incoming.locator(".export-file")).toBeVisible({ timeout: timeout.transfer });
  if (group) {
    await expect(outgoing.locator('[data-status="complete"]')).toHaveCount(1,
      { timeout: timeout.transfer });
  } else {
    await expect.poll(() => sender.evaluate(() => globalThis.tcTest.sendDone),
      { timeout: timeout.transfer }).toBe(true);
    assert.equal(await sender.evaluate(() => globalThis.tcTest.sentSha256), sha256,
      "sender completion digest mismatch");
    assert.equal(await receiver.evaluate(() => globalThis.tcTest.recvSha256), sha256,
      "receiver completion digest mismatch");
  }
  assert.deepEqual(await temporaryFiles(receiver), [{ size: bytes.length, sha256 }],
    "committed OPFS bytes must match independently calculated SHA-256");
  await incoming.locator(".delete-file").click();
  await expect.poll(() => temporaryFiles(receiver), { timeout: 30_000 }).toEqual([]);
}

async function privateRoom(host, guest, expect) {
  stage = "private-create";
  await host.locator("#region-select").selectOption("tok");
  await host.locator("#listen-btn").click();
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.state.room),
    { timeout: timeout.connect }).toBe("open");
  const address = await host.locator("#listen-addr").textContent();
  assert(/^tc\S{32,}$/u.test(address || ""), "listener did not return a valid address");
  stage = "private-join";
  await guest.locator("#send-addr").fill(address);
  await guest.locator("#connect-btn").click();
  for (const page of [host, guest]) {
    await expect.poll(() => page.evaluate(() => globalThis.tcTest.state.peer),
      { timeout: timeout.connect }).toBe("connected");
  }
}

async function groupRoom(host, guest, hostName, guestName, expect) {
  stage = "group-create";
  await expect(host.locator("#group-create-entry-btn")).toBeVisible();
  await host.locator("#region-select").selectOption("tok");
  await host.locator("#group-create-entry-btn").click();
  await host.locator("#group-create-nickname").fill(hostName);
  await host.locator("#group-create-btn").click();
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.mode),
    { timeout: timeout.connect }).toBe("owner");
  const invitation = await host.locator("#group-invite-link").textContent();
  const fragment = new URL(invitation).hash;
  assert(fragment.startsWith("#v=1&mode=group&"), "group invitation format mismatch");
  stage = "group-admission";
  await guest.evaluate((value) => { location.hash = value; }, fragment);
  await expect(guest.locator("#group-join-dialog")).toBeVisible();
  await guest.locator("#group-join-nickname").fill(guestName);
  await guest.locator("#group-join-btn").click();
  const request = host.locator(".group-pending-item", { hasText: guestName });
  await expect(request).toBeVisible({ timeout: timeout.connect });
  await request.locator(".group-approve-join").click();
  await expect.poll(() => guest.evaluate(() => globalThis.tcTest.group.mode),
    { timeout: timeout.connect }).toBe("member");
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.members),
    { timeout: timeout.connect }).toBe(2);
  await guest.waitForFunction(() => location.hash === "");
  await host.locator("#group-recipient-list .group-recipient-option", { hasText: guestName })
    .locator("input").check();
  await guest.locator("#group-recipient-list .group-recipient-option", { hasText: hostName })
    .locator("input").check();
}

async function main() {
  if (!enabled) {
    console.log(JSON.stringify({ result: "skipped", reason: "LIVE_PRODUCTION_INTEROP is not 1" }));
    return;
  }
  const candidateURL = previewURL(process.env.TAILCAT_CANDIDATE_URL);
  assert(Number.isSafeInteger(fileBytes) && fileBytes > 0 && fileBytes <= 1024 * 1024,
    "synthetic file size must be 1 through 1048576 bytes");
  const { chromium, expect } = await import("@playwright/test");
  const browser = await chromium.launch({ channel: process.env.TAILCAT_BROWSER_CHANNEL || "chrome", headless: true });
  let passed = 0;
  let failed = 0;
  const modes = withGroups ? ["private", "group"] : ["private"];
  try {
    for (const mode of modes) {
      for (const hostLabel of ["candidate", "production"]) {
        const check = `${mode}-${hostLabel}-host`;
        const context = await browser.newContext({ locale: "en-US", acceptDownloads: false });
        try {
          await context.addInitScript(() => {
            // Change only browser save selection, never network or hashing:
            // receiving goes into the real origin-private filesystem.
            delete globalThis.showSaveFilePicker;
            localStorage.setItem("tailcat.forceDerp", "1");
            globalThis.__interopFilePCs = 0;
            const Original = RTCPeerConnection;
            globalThis.RTCPeerConnection = class extends Original {
              constructor(options) { super(options); globalThis.__interopFilePCs += 1; }
            };
          });
          const candidate = await openPage(context, candidateURL, "candidate");
          const production = await openPage(context, productionURL, "production");
          stage = "build-provenance";
          const provenance = {
            candidate: await buildInfo(candidate.page, "v0.7.0"),
            production: await buildInfo(production.page, "v0.4.0"),
          };
          assert.equal(provenance.candidate.provenanceVerified, true,
            "candidate build provenance is required");
          const host = hostLabel === "candidate" ? candidate : production;
          const guest = hostLabel === "candidate" ? production : candidate;
          if (mode === "private") await privateRoom(host.page, guest.page, expect);
          else await groupRoom(host.page, guest.page, `Interop ${host.label}`,
            `Interop ${guest.label}`, expect);
          for (const [sender, receiver] of [[candidate, production], [production, candidate]]) {
            const label = `${check}-${sender.label}-to-${receiver.label}`;
            stage = `${label}-text`;
            await sendText(sender.page, receiver.page, `Compatibility ${label}`, expect);
            await sendFile(sender.page, receiver.page, label, mode === "group", expect);
          }
          for (const endpoint of [candidate, production]) {
            assert.equal(await endpoint.page.evaluate(() => globalThis.__interopFilePCs), 0,
              "DERP acceptance must not create a file PeerConnection");
            assert(endpoint.relay.sockets > 0 && endpoint.relay.sentBytes > 0
              && endpoint.relay.receivedBytes > 0, "official DERP WebSocket traffic must be observed");
          }
          passed += 1;
          console.log(JSON.stringify({ check, result: "passed", directions: 2, bytesEach: fileBytes,
            sha256Verified: true, stagedFilesDeleted: true, filePeerConnections: 0, provenance,
            relay: { candidate: candidate.relay, production: production.relay } }));
        } catch (_) {
          failed += 1;
          // Do not print raw Playwright errors: call logs can contain input values.
          console.error(JSON.stringify({ check, result: "failed", stage }));
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ result: failed ? "failed" : "passed", passed, failed,
    groupChecks: withGroups ? "included" : "not-run", syntheticBytesEach: fileBytes }));
  if (failed) process.exitCode = 1;
}

await main().catch(() => {
  console.error(JSON.stringify({ result: "failed", stage }));
  process.exitCode = 1;
});
