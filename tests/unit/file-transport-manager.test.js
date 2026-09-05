import { test } from "node:test";
import assert from "node:assert/strict";
import { FileTransportManager, FILE_STUN_URL, supportsNativeFiles, openFileTransfer } from "../../web/file-transport-manager.js";

function fixture(extra = {}) {
  const configurations = [], signals = [], pcs = [];
  const manager = new FileTransportManager({ room: "room", localId: "a", peerId: "b", isAuthorized: () => true,
    sendSignal: async (message) => { signals.push(message); },
    createPeerConnection: (config) => {
      configurations.push(config);
      const pc = {
        closed: false, connectionState: "new", localDescription: null,
        createDataChannel: () => ({ close() {} }),
        createOffer: async () => ({ type: "offer", sdp: "test" }),
        setLocalDescription: async function (value) { this.localDescription = { toJSON: () => value }; },
        close() { this.closed = true; },
      };
      pcs.push(pc); return pc;
    }, ...extra,
  });
  return { manager, configurations, signals, pcs };
}

test("old capabilities never advertise native compatibility", () => {
  assert.equal(supportsNativeFiles({ file: { protocol: "TCF1" } }), false);
  assert.equal(supportsNativeFiles({ file: { protocol: "TCF1", transports: ["tailcat", "webrtc-dc-v1"] } }), true);
});

test("default-off, forceDerp and legacy capability paths never create a PC", async () => {
  for (const overrides of [{}, { enabled: true, forceDerp: true }, { enabled: true, capabilities: {} }]) {
    let opened = 0;
    const stream = await openFileTransfer({
      capabilities: { file: { protocol: "TCF1", transports: ["webrtc-dc-v1"] } },
      manager: { openTransfer: () => assert.fail("must not create a native connection") },
      openDerp: async () => { opened++; return {}; }, ...overrides,
    });
    assert.equal(stream.transport, "derp"); assert.equal(opened, 1);
  }
});

test("pre-body timeout may fall back but authorization failure cannot", async () => {
  const parameters = { enabled: true, capabilities: { file: { protocol: "TCF1", transports: ["webrtc-dc-v1"] } },
    openDerp: async () => ({}) };
  const manager = { openTransfer: async () => { throw Object.assign(new Error("timeout"), { code: "DIRECT_TIMEOUT" }); } };
  assert.equal((await openFileTransfer({ ...parameters, manager })).transport, "derp");
  manager.openTransfer = async () => { throw Object.assign(new Error("revoked"), { code: "AUTHORIZATION_EXPIRED" }); };
  await assert.rejects(openFileTransfer({ ...parameters, manager }), /revoked/u);
});

test("lazy setup uses only Cloudflare STUN and times out as a whole", async () => {
  const { manager, configurations, pcs } = fixture({ setupMs: 10 });
  assert.equal(pcs.length, 0);
  await assert.rejects(manager.openTransfer("a".repeat(32)), /DIRECT_TIMEOUT/u);
  assert.deepEqual(configurations, [{ iceServers: [{ urls: FILE_STUN_URL }] }]);
  assert.equal(pcs[0].closed, true);
  await assert.rejects(manager.openTransfer("b".repeat(32)), /DIRECT_UNAVAILABLE/u);
  manager.close();
});

test("closing wakes pending setup and closes the peer exactly once", async () => {
  const { manager, pcs } = fixture();
  const pending = assert.rejects(manager.openTransfer("a".repeat(32)), /AUTHORIZATION_EXPIRED/u);
  await new Promise((resolve) => setImmediate(resolve));
  manager.close(); manager.close();
  await pending;
  assert.equal(manager.waiters.size, 0);
  assert.equal(pcs[0].closed, true);
});

test("signaling is bound to room and authenticated pair", async () => {
  const { manager, pcs } = fixture();
  const valid = { v: 1, room: "room", from: "b", to: "a", generation: 0, type: "REQUEST" };
  for (const invalid of [{ room: "other" }, { from: "impostor" }, { to: "other" }, { v: 2 }, { generation: -1 }]) {
    await assert.rejects(manager.handleSignal({ ...valid, ...invalid }), /SIGNAL_BINDING/u);
  }
  assert.equal(pcs.length, 0);
  await manager.handleSignal(valid);
  assert.equal(pcs.length, 1);
  manager.close();
});

test("stale ICE is ignored and current candidate queues are bounded", async () => {
  const { manager } = fixture();
  await manager.startOffer();
  const message = { v: 1, room: "room", from: "b", to: "a", generation: 0, type: "ICE", candidate: { candidate: "candidate:test" } };
  await manager.handleSignal(message);
  assert.equal(manager.state.candidates.length, 0);
  message.generation = 1;
  for (let i = 0; i < 64; i++) await manager.handleSignal(message);
  assert.equal(manager.state.candidates.length, 64);
  await assert.rejects(manager.handleSignal(message), /INVALID_CANDIDATE/u);
  manager.close();
});

test("an incoming DataChannel requires a preauthorized transfer", async () => {
  const { manager } = fixture();
  await manager.startOffer();
  let closed = 0;
  manager.state.pc.ondatachannel({ channel: { label: "a".repeat(32), close: () => { closed++; } } });
  assert.equal(closed, 1);
  const cancel = manager.expectTransfer("a".repeat(32), () => {});
  assert.throws(() => manager.expectTransfer("b".repeat(32), () => {}), /TRANSFER_NOT_AUTHORIZED/u);
  cancel(); assert.equal(manager.expected.size, 0);
  manager.close();
});

test("authorization revocation prohibits signaling without constructing a PC", async () => {
  const { manager, pcs } = fixture({ isAuthorized: () => false });
  await assert.rejects(manager.openTransfer("a".repeat(32)), /AUTHORIZATION_EXPIRED/u);
  assert.equal(pcs.length, 0);
  manager.close();
});
