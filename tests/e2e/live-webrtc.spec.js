import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { installMockSavePicker } from "./mock-tailcat.js";

// A failed live run must not persist a trace or screenshot containing the
// one-time room address. The test reports only the app's sanitized path enum.
test.use({ trace: "off", screenshot: "off", video: "off" });

const cloudflareSTUNURL = "stun:stun.cloudflare.com:3478";
const bilateralWebRTC = Object.freeze([
  Object.freeze({ local: "webrtc", peer: "webrtc", bilateral: "webrtc" }),
  Object.freeze({ local: "webrtc", peer: "webrtc", bilateral: "webrtc" }),
]);
const commitSHA = /^[0-9a-f]{40}$/u;

async function readPinnedForkSHA() {
  const explicit = String(process.env.WEBRTC_FORK_SHA || "").trim().toLowerCase();
  if (commitSHA.test(explicit)) return explicit;

  const artifactRoot = dirname(resolve(process.env.E2E_DIST_DIR || "dist"));
  const candidates = [
    resolve("WEBRTC_FORK.lock"),
    join(artifactRoot, "WEBRTC_FORK.lock"),
    join(artifactRoot, "build-evidence", "go-version-m-dist-webrtc.txt"),
    join(artifactRoot, "build-evidence", "go-modules.txt"),
  ];
  for (const candidate of candidates) {
    let text;
    try {
      text = await readFile(candidate, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const labelled = text.match(
      /(?:webrtc[_ -]?fork|fork[_ -]?(?:commit|sha))[^\r\n0-9a-f]{0,80}([0-9a-f]{40})\b/iu,
    );
    if (labelled) return labelled[1].toLowerCase();
  }
  throw new Error("the complete 40-character WebRTC fork commit evidence is unavailable");
}

async function assertExperimentalRuntime(page) {
  const runtime = await page.evaluate((expectedSTUNURL) => {
    const transport = globalThis.tcTest?.runtime?.transportConfiguration;
    return {
      labBuild: globalThis.__TAILCAT_WEBRTC_LAB__ === true,
      mockTransport: Boolean(globalThis.tcTest?.mockTransport || globalThis.__mockTailcat),
      compiled: transport?.compiled === true,
      enabled: transport?.enabled === true,
      exactSTUN: Array.isArray(transport?.stunURLs)
        && transport.stunURLs.length === 1
        && transport.stunURLs[0] === expectedSTUNURL,
    };
  }, cloudflareSTUNURL);
  expect(runtime).toEqual({
    labBuild: true,
    mockTransport: false,
    compiled: true,
    enabled: true,
    exactSTUN: true,
  });
}

async function installDiagnosticsCapture(page) {
  await page.evaluate(() => {
    const connect = globalThis.tailcatConnect;
    if (typeof connect !== "function") throw new Error("persistent Tailcat client API is unavailable");
    let readLatest = null;
    globalThis.tailcatConnect = async function captureDiagnostics(...args) {
      const client = await connect.apply(this, args);
      if (typeof client?.diagnostics !== "function") {
        client?.close?.();
        throw new Error("experimental client diagnostics API is unavailable");
      }
      readLatest = client.diagnostics.bind(client);
      return client;
    };
    Object.defineProperty(globalThis, "__readLiveWebRTCDiagnostics", {
      configurable: true,
      value: () => {
        if (!readLatest) throw new Error("persistent client diagnostics are not ready");
        return readLatest();
      },
    });
  });
}

async function readNumericDiagnostics(page) {
  return page.evaluate(() => {
    const read = globalThis.__readLiveWebRTCDiagnostics;
    if (typeof read !== "function") throw new Error("diagnostics capture is unavailable");
    const raw = read();
    const result = {
      webRTCTxBytes: raw?.webRTCTxBytes,
      webRTCRxBytes: raw?.webRTCRxBytes,
      dataChannelBufferedBytes: raw?.dataChannelBufferedBytes,
      dataChannelPeakBufferedBytes: raw?.dataChannelPeakBufferedBytes,
    };
    if (!Object.values(result).every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error("diagnostics snapshot is not a set of safe non-negative integers");
    }
    return result;
  });
}

async function readSanitizedPaths(pages) {
  return Promise.all(pages.map((page) => page.evaluate(() => ({
    local: globalThis.tcTest.state.localPath,
    peer: globalThis.tcTest.state.peerPath,
    bilateral: globalThis.tcTest.state.bilateralPath,
  }))));
}

async function connectTokyoPair(host, guest) {
  await Promise.all([
    host.locator("#region-select").selectOption("tok"),
    guest.locator("#region-select").selectOption("tok"),
  ]);
  await host.locator("#listen-btn").click();
  await expect.poll(
    () => host.evaluate(() => globalThis.tcTest.state.room),
    { timeout: 60_000 },
  ).toBe("open");

  let address = await host.locator("#listen-addr").textContent();
  if (!/^tc\S{32,}$/u.test(address || "")) {
    throw new Error("host did not create a valid Tailcat room address");
  }
  await guest.evaluate((roomAddress) => {
    const input = document.querySelector("#send-addr");
    if (!(input instanceof HTMLInputElement)) throw new Error("room address input is unavailable");
    input.value = roomAddress;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, address);
  address = "";
  await guest.locator("#connect-btn").click();
  await expect.poll(
    () => guest.evaluate(() => globalThis.tcTest.state.peer),
    { timeout: 240_000 },
  ).toBe("connected");
  await expect.poll(
    () => host.evaluate(() => globalThis.tcTest.state.peer),
    { timeout: 60_000 },
  ).toBe("connected");
}

async function waitForBilateralWebRTC(host, guest) {
  await expect.poll(() => readSanitizedPaths([host, guest]), {
    timeout: 60_000,
    message: "both pages should authenticate a bilateral WebRTC path",
  }).toEqual(bilateralWebRTC);
}

function numericDelta(after, before, key) {
  const delta = after[key] - before[key];
  if (!Number.isSafeInteger(delta) || delta < 0) {
    throw new Error("a numeric transport counter regressed");
  }
  return delta;
}

function webSocketPayloadByteLength(frame) {
  const payload = frame?.payloadData;
  if (typeof payload !== "string") return 0;
  if (frame.opcode === 1) return Buffer.byteLength(payload, "utf8");
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
}

function isIPNDevWebSocket(rawURL) {
  try {
    const parsed = new URL(rawURL);
    return parsed.protocol === "wss:"
      && parsed.hostname.length > ".ipn.dev".length
      && parsed.hostname.endsWith(".ipn.dev");
  } catch (_) {
    return false;
  }
}

async function attachDERPWebSocketMeter(context, page) {
  const session = await context.newCDPSession(page);
  const trackedSockets = new Map();
  const matchedSocketIDs = new Set();
  let sentBytes = 0;
  let receivedBytes = 0;

  session.on("Network.webSocketCreated", ({ requestId, url }) => {
    // Persist only a request identifier and a classification bit. The URL is
    // inspected on this stack frame and is never retained or reported.
    const isDERP = isIPNDevWebSocket(url);
    trackedSockets.set(requestId, isDERP);
    if (isDERP) matchedSocketIDs.add(requestId);
  });
  session.on("Network.webSocketClosed", ({ requestId }) => {
    trackedSockets.delete(requestId);
  });
  session.on("Network.webSocketFrameSent", ({ requestId, response }) => {
    if (trackedSockets.get(requestId) === true) sentBytes += webSocketPayloadByteLength(response);
  });
  session.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
    if (trackedSockets.get(requestId) === true) receivedBytes += webSocketPayloadByteLength(response);
  });
  await session.send("Network.enable");

  return {
    snapshot: () => Object.freeze({
      sentBytes,
      receivedBytes,
      matchedSocketCount: matchedSocketIDs.size,
    }),
    close: async () => {
      trackedSockets.clear();
      matchedSocketIDs.clear();
      await session.detach();
    },
  };
}

function derpByteTotal(snapshots) {
  return snapshots.reduce((total, snapshot) => total + snapshot.sentBytes + snapshot.receivedBytes, 0);
}

function combinedDERPDelta(after, before) {
  return after.reduce((total, snapshot, index) => (
    total
      + numericDelta(snapshot, before[index], "sentBytes")
      + numericDelta(snapshot, before[index], "receivedBytes")
  ), 0);
}

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

    await Promise.all([host, guest].map(async (page) => {
      await assertExperimentalRuntime(page);
      await installDiagnosticsCapture(page);
    }));

    // The picker fixture only captures locally written bytes. Tailcat,
    // magicsock, DERP, ICE, and WebRTC remain the real WASM implementations.
    await installMockSavePicker(host);
    await connectTokyoPair(host, guest);
    await waitForBilateralWebRTC(host, guest);

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
    const [senderDiagnosticsBefore, receiverDiagnosticsBefore] = await Promise.all([
      readNumericDiagnostics(guest),
      readNumericDiagnostics(host),
    ]);
    const offerCount = await host.locator(".incoming-transfer").count();
    await guest.locator("#send-file").setInputFiles({
      name: "payload.bin",
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
    const offer = host.locator(".incoming-transfer").nth(offerCount);
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
    const [senderDiagnosticsAfter, receiverDiagnosticsAfter] = await Promise.all([
      readNumericDiagnostics(guest),
      readNumericDiagnostics(host),
    ]);
    expect(numericDelta(senderDiagnosticsAfter, senderDiagnosticsBefore, "webRTCTxBytes"))
      .toBeGreaterThanOrEqual(bytes.length);
    expect(numericDelta(receiverDiagnosticsAfter, receiverDiagnosticsBefore, "webRTCRxBytes"))
      .toBeGreaterThanOrEqual(bytes.length);

    // The application protocol traffic must not have replaced or downgraded
    // the authenticated path after the transfer.
    expect(await readSanitizedPaths([host, guest])).toEqual(bilateralWebRTC);
  } finally {
    await context.close();
  }
});

test("live WebRTC Gate 2 keeps a verified 100 MiB transfer off DERP", async ({ browser }, testInfo) => {
  test.skip(process.env.LIVE_WEBRTC_GATE2 !== "1", "live WebRTC Gate 2 evidence is opt-in");
  test.skip(testInfo.project.name !== "chrome", "live WebRTC Gate 2 uses Chromium CDP counters");
  test.setTimeout(900_000);

  const payloadBytes = 100 * 1024 * 1024;
  const forkSHA = await readPinnedForkSHA();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "tc-webrtc-g2-"));
  const payloadPath = join(temporaryDirectory, "payload.bin");
  let hostContext;
  let guestContext;
  let hostMeter;
  let guestMeter;
  try {
    let payload = Buffer.alloc(payloadBytes, 0x3c);
    const digest = createHash("sha256").update(payload).digest("hex");
    await writeFile(payloadPath, payload);
    payload = null;

    hostContext = await browser.newContext({ locale: "en-US" });
    guestContext = await browser.newContext({ locale: "en-US" });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    [hostMeter, guestMeter] = await Promise.all([
      attachDERPWebSocketMeter(hostContext, host),
      attachDERPWebSocketMeter(guestContext, guest),
    ]);
    await Promise.all([host.goto("/"), guest.goto("/")]);
    await Promise.all([
      host.waitForFunction(() => globalThis.tcTest?.ready === true),
      guest.waitForFunction(() => globalThis.tcTest?.ready === true),
    ]);
    await Promise.all([host, guest].map(async (page) => {
      await assertExperimentalRuntime(page);
      await installDiagnosticsCapture(page);
    }));
    const [hostAppSHA, guestAppSHA] = await Promise.all([host, guest].map((page) => (
      page.evaluate(() => String(globalThis.__TAILCAT_BUILD_SHA__ || "").toLowerCase())
    )));
    expect(commitSHA.test(hostAppSHA), "host application build SHA").toBe(true);
    expect(guestAppSHA, "both pages must run the same reviewed application build").toBe(hostAppSHA);

    await installMockSavePicker(host);
    await connectTokyoPair(host, guest);
    await waitForBilateralWebRTC(host, guest);

    const offerCount = await host.locator(".incoming-transfer").count();
    // These identity-free counters are captured after the authenticated path
    // is WebRTC and directly before the file picker starts the transfer.
    const [senderDiagnosticsBefore, receiverDiagnosticsBefore] = await Promise.all([
      readNumericDiagnostics(guest),
      readNumericDiagnostics(host),
    ]);
    const derpBefore = [hostMeter.snapshot(), guestMeter.snapshot()];
    for (const snapshot of derpBefore) {
      expect(snapshot.matchedSocketCount, "each page must expose a measured DERP WebSocket").toBeGreaterThanOrEqual(1);
    }
    const derpBaselineBytes = derpByteTotal(derpBefore);
    expect(derpBaselineBytes, "DERP instrumentation must observe pre-transfer signaling bytes").toBeGreaterThan(0);

    await guest.locator("#send-file").setInputFiles(payloadPath);
    const offer = host.locator(".incoming-transfer").nth(offerCount);
    await expect(offer).toBeVisible({ timeout: 120_000 });
    await offer.locator(".save-file").click();
    await expect.poll(
      () => guest.evaluate(() => globalThis.tcTest.sendDone),
      { timeout: 600_000 },
    ).toBe(true);
    await expect.poll(
      () => host.evaluate(() => globalThis.tcTest.recvDone),
      { timeout: 600_000 },
    ).toBe(true);

    expect(await guest.evaluate(() => ({
      bytes: globalThis.tcTest.sentBytes,
      digest: globalThis.tcTest.sentSha256,
    }))).toEqual({ bytes: payloadBytes, digest });
    expect(await host.evaluate(() => ({
      bytes: globalThis.tcTest.recvBytes,
      digest: globalThis.tcTest.recvSha256,
    }))).toEqual({ bytes: payloadBytes, digest });
    expect(await host.evaluate(() => ({
      totalBytes: globalThis.__mockSave?.totalBytes,
      closed: globalThis.__mockSave?.closed,
      aborted: globalThis.__mockSave?.aborted,
    }))).toEqual({ totalBytes: payloadBytes, closed: true, aborted: false });

    // Let Network-domain events already emitted by the browser drain to the
    // test process before taking the terminal numeric snapshot.
    await host.waitForTimeout(250);
    const [senderDiagnosticsAfter, receiverDiagnosticsAfter] = await Promise.all([
      readNumericDiagnostics(guest),
      readNumericDiagnostics(host),
    ]);
    const senderWebRTCTxDelta = numericDelta(
      senderDiagnosticsAfter,
      senderDiagnosticsBefore,
      "webRTCTxBytes",
    );
    const receiverWebRTCRxDelta = numericDelta(
      receiverDiagnosticsAfter,
      receiverDiagnosticsBefore,
      "webRTCRxBytes",
    );
    expect(senderWebRTCTxDelta).toBeGreaterThanOrEqual(payloadBytes);
    expect(receiverWebRTCRxDelta).toBeGreaterThanOrEqual(payloadBytes);

    const derpAfter = [hostMeter.snapshot(), guestMeter.snapshot()];
    const derpDelta = combinedDERPDelta(derpAfter, derpBefore);
    const derpFraction = derpDelta / payloadBytes;
    expect(derpDelta, "combined DERP WebSocket payload bytes").toBeLessThan(2 * 1024 * 1024);
    expect(derpFraction, "combined DERP fraction").toBeLessThan(0.02);
    const paths = await readSanitizedPaths([host, guest]);
    expect(paths).toEqual(bilateralWebRTC);

    const evidence = {
      schemaVersion: 1,
      scope: "same-host Chromium two-context smoke",
      physicalGate2: false,
      appSHA: hostAppSHA,
      forkSHA,
      payload: {
        bytes: payloadBytes,
        sha256: digest,
      },
      webRTC: {
        senderTxBytes: senderWebRTCTxDelta,
        receiverRxBytes: receiverWebRTCRxDelta,
        senderBufferCurrentBytes: senderDiagnosticsAfter.dataChannelBufferedBytes,
        senderBufferPeakBytes: senderDiagnosticsAfter.dataChannelPeakBufferedBytes,
        receiverBufferCurrentBytes: receiverDiagnosticsAfter.dataChannelBufferedBytes,
        receiverBufferPeakBytes: receiverDiagnosticsAfter.dataChannelPeakBufferedBytes,
      },
      derp: {
        baselineBytes: derpBaselineBytes,
        transferBytes: derpDelta,
        transferFraction: derpFraction,
        matchedSocketCounts: derpBefore.map((snapshot) => snapshot.matchedSocketCount),
      },
      paths,
    };
    await testInfo.attach("sanitized-webrtc-gate2-evidence.json", {
      body: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
      contentType: "application/json",
    });
  } finally {
    await Promise.allSettled([hostMeter?.close(), guestMeter?.close()]);
    await Promise.allSettled([hostContext?.close(), guestContext?.close()]);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
