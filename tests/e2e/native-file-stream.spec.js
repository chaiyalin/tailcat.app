import { test, expect } from "@playwright/test";

// Real browser SCTP/DTLS. The in-memory signaling relay in this fixture is
// intentionally NOT evidence of Tailcat room authorization or app integration.
test("native file manager reuses a real PC and streams 100 MiB within credit bounds", async ({ page, context }) => {
  await context.route("https://127.0.0.1:4173/**", async (route) => {
    const response = await context.request.fetch(route.request().url().replace(/^https:/u, "http:"));
    await route.fulfill({ response });
  });
  await page.goto("/404.html");
  const result = await page.evaluate(async () => {
    const { FileTransportManager } = await import("/file-transport-manager.js");
    let created = 0;
    const connections = [];
    const createPeerConnection = (config) => { created++; const pc = new RTCPeerConnection(config); connections.push(pc); return pc; };
    const peers = {};
    const errors = [];
    let authorized = true;
    for (const [localId, peerId] of [["a", "b"], ["b", "a"]]) {
      peers[localId] = new FileTransportManager({ room: "test-room", localId, peerId,
        createPeerConnection, isAuthorized: () => authorized,
        sendSignal: async (message) => {
          // Like Tailcat, delivery is asynchronous, without reentrant request
          // / answer callbacks sharing a signaling lock.
          setTimeout(() => { peers[peerId].handleSignal(message).catch((error) => errors.push(error.code)); }, 0);
        },
      });
    }
    const sizes = [0, 1, 16 * 1024, 64 * 1024, 64 * 1024 + 1, 100 * 1024 * 1024];
    const results = [];
    try {
      for (let i = 0; i < sizes.length; i++) {
        const size = sizes[i];
        const from = i % 2 ? "b" : "a", to = from === "a" ? "b" : "a";
        const attemptId = i.toString(16).padStart(32, "0");
        let resolveIncoming;
        const incoming = new Promise((resolve) => { resolveIncoming = resolve; });
        peers[to].expectTransfer(attemptId, resolveIncoming);
        const outbound = await peers[from].openTransfer(attemptId);
        const inbound = await incoming;
        const receive = (async () => {
          let count = 0;
          for (;;) {
            const data = await inbound.read();
            if (!data) break;
            for (let j = 0; j < data.length; j++) if (data[j] !== ((count + j) % 251)) throw new Error("corruption");
            count += data.length;
            inbound.acknowledgeRead();
          }
          return count;
        })();
        for (let offset = 0; offset < size;) {
          const block = new Uint8Array(Math.min(64 * 1024, size - offset));
          for (let j = 0; j < block.length; j++) block[j] = (offset + j) % 251;
          await outbound.write(block); offset += block.length;
        }
        await outbound.closeWrite();
        const count = await receive;
        results.push({ size, count, send: outbound.snapshot(), receive: inbound.snapshot() });
        outbound.close(); inbound.close();
      }
      authorized = false;
      let rejection;
      try { await peers.a.openTransfer("f".repeat(32)); } catch (error) { rejection = error.code; }
      return { created, results, errors, rejection };
    } catch (error) {
      const candidateCounts = [];
      for (const pc of connections) {
        const counts = {};
        try {
          for (const stat of (await pc.getStats()).values()) {
            if (stat.type === "local-candidate" || stat.type === "remote-candidate") {
              const key = `${stat.type}:${stat.candidateType}`;
              counts[key] = (counts[key] || 0) + 1;
            }
          }
        } catch (_) { /* closed peer may have no statistics */ }
        candidateCounts.push(counts);
      }
      return { failure: error.code || "TEST_FAILURE", errors,
        candidateCounts,
        connections: connections.map((pc) => ({ connection: pc.connectionState,
          ice: pc.iceConnectionState, gathering: pc.iceGatheringState, signaling: pc.signalingState })) };
    } finally { peers.a.close(); peers.b.close(); }
  });
  expect(result.failure, JSON.stringify(result)).toBeUndefined();
  expect(result.errors).toEqual([]);
  expect(result.created).toBe(2);
  expect(result.rejection).toBe("AUTHORIZATION_EXPIRED");
  for (const entry of result.results) {
    expect(entry.count).toBe(entry.size);
    expect(entry.send.peakBufferedAmount).toBeLessThanOrEqual(512 * 1024);
    expect(entry.receive.peakUnconsumedBytes).toBeLessThanOrEqual(1024 * 1024);
  }
});
