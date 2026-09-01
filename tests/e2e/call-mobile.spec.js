import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  connectMockPeer,
  installMockTailcat,
  startMockRoom,
} from "./mock-tailcat.js";

test.beforeEach(async ({ context }) => {
  // WebKit upgrades loopback subresources because the production CSP includes
  // upgrade-insecure-requests. Keep the deterministic local server HTTP-only.
  await context.route("https://127.0.0.1:4173/**", async (route) => {
    const response = await context.request.fetch(route.request().url().replace(/^https:/u, "http:"));
    await route.fulfill({ response });
  });
});

async function installMockRTC(context) {
  await context.addInitScript(() => {
    let sequence = 0;
    const tracks = [];
    const streams = [];
    const connections = [];
    const userMediaCalls = [];

    function clone(value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function makeTrack(kind, facingMode = null) {
      const listeners = new Map();
      const track = {
        id: `${kind}-${++sequence}`,
        kind,
        enabled: true,
        stopped: false,
        stopCalls: 0,
        facingMode,
        stop() {
          this.stopped = true;
          this.stopCalls += 1;
          for (const listener of listeners.get("ended") || []) listener.callback.call(this, new Event("ended"));
        },
        addEventListener(type, callback, options = {}) {
          const entries = listeners.get(type) || [];
          entries.push({ callback, once: Boolean(options?.once) });
          listeners.set(type, entries);
        },
        removeEventListener(type, callback) {
          listeners.set(type, (listeners.get(type) || []).filter((entry) => entry.callback !== callback));
        },
        getSettings() {
          return facingMode ? { facingMode } : {};
        },
      };
      tracks.push(track);
      return track;
    }

    function makeStream(constraints) {
      const streamTracks = [];
      if (constraints?.audio) streamTracks.push(makeTrack("audio"));
      if (constraints?.video) {
        const requested = constraints.video?.facingMode;
        const facingMode = typeof requested === "string" ? requested : requested?.ideal || "user";
        streamTracks.push(makeTrack("video", facingMode));
      }
      const stream = {
        id: `stream-${++sequence}`,
        tracks: streamTracks,
        getTracks() {
          return [...this.tracks];
        },
        getAudioTracks() {
          return this.tracks.filter((track) => track.kind === "audio");
        },
        getVideoTracks() {
          return this.tracks.filter((track) => track.kind === "video");
        },
        addTrack(track) {
          if (!this.tracks.includes(track)) this.tracks.push(track);
        },
        removeTrack(track) {
          this.tracks = this.tracks.filter((candidate) => candidate !== track);
        },
      };
      streams.push(stream);
      return stream;
    }

    const mediaDevices = {
      async getUserMedia(constraints) {
        userMediaCalls.push(clone(constraints));
        return makeStream(constraints);
      },
      async enumerateDevices() {
        return [];
      },
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });

    // Fake streams are sufficient for the application logic under test. Avoid
    // asking WebKit/Chromium to type-check them as native MediaStream objects.
    try {
      Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
        configurable: true,
        get() {
          return this.__mockSrcObject || null;
        },
        set(value) {
          this.__mockSrcObject = value;
        },
      });
    } catch (_) {
      // Current supported engines expose a configurable srcObject descriptor.
    }

    class MockRTCPeerConnection extends EventTarget {
      constructor(configuration) {
        super();
        this.id = `pc-${++sequence}`;
        this.configuration = clone(configuration);
        this.connectionState = "new";
        this.iceGatheringState = "complete";
        this.localDescription = null;
        this.remoteDescription = null;
        this.senders = [];
        this.offers = [];
        this.answers = 0;
        this.restartIceCalls = 0;
        this.remoteDescriptions = [];
        this.replacements = [];
        this.closed = false;
        this.ontrack = null;
        this.onconnectionstatechange = null;
        connections.push(this);
      }

      addTrack(track) {
        const owner = this;
        const sender = {
          track,
          async replaceTrack(replacement) {
            owner.replacements.push({ from: this.track?.id || null, to: replacement?.id || null });
            this.track = replacement;
          },
        };
        this.senders.push(sender);
        return sender;
      }

      getSenders() {
        return [...this.senders];
      }

      async createOffer(options = {}) {
        this.offers.push(clone(options));
        return { type: "offer", sdp: `mock-offer-${this.id}-${this.offers.length}` };
      }

      async createAnswer() {
        this.answers += 1;
        return { type: "answer", sdp: `mock-answer-${this.id}-${this.answers}` };
      }

      async setLocalDescription(description) {
        const plain = clone(description);
        this.localDescription = {
          ...plain,
          toJSON() {
            return { ...plain };
          },
        };
      }

      async setRemoteDescription(description) {
        const plain = clone(description);
        this.remoteDescription = plain;
        this.remoteDescriptions.push(plain);
      }

      restartIce() {
        this.restartIceCalls += 1;
      }

      close() {
        this.closed = true;
        this.connectionState = "closed";
      }

      transition(nextState) {
        this.connectionState = nextState;
        this.onconnectionstatechange?.(new Event("connectionstatechange"));
      }
    }

    Object.defineProperty(globalThis, "RTCPeerConnection", {
      configurable: true,
      value: MockRTCPeerConnection,
    });

    globalThis.__rtcMock = {
      transitionLatest(state) {
        connections.at(-1)?.transition(state);
      },
      snapshot() {
        return {
          userMediaCalls: clone(userMediaCalls),
          tracks: tracks.map((track) => ({
            id: track.id,
            kind: track.kind,
            enabled: track.enabled,
            stopped: track.stopped,
            stopCalls: track.stopCalls,
            facingMode: track.facingMode,
          })),
          streams: streams.map((stream) => ({
            id: stream.id,
            trackIds: stream.getTracks().map((track) => track.id),
          })),
          connections: connections.map((connection) => ({
            id: connection.id,
            configuration: clone(connection.configuration),
            state: connection.connectionState,
            offers: clone(connection.offers),
            answers: connection.answers,
            restartIceCalls: connection.restartIceCalls,
            remoteDescriptions: clone(connection.remoteDescriptions),
            replacements: clone(connection.replacements),
            senderTrackIds: connection.getSenders().map((sender) => sender.track?.id || null),
            closed: connection.closed,
          })),
        };
      },
    };
  });
}

async function openCallPage(context, namespace) {
  const page = await context.newPage();
  await page.goto("/");
  await installMockTailcat(page, namespace);
  return page;
}

async function establishVideoCall(context, { fakeCallerClock = false } = {}) {
  const namespace = randomUUID();
  const receiver = await openCallPage(context, namespace);
  const caller = await openCallPage(context, namespace);
  const address = await startMockRoom(receiver);
  await connectMockPeer(caller, address);
  await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.state.peer)).toBe("connected");

  await caller.locator("#mobile-menu-btn").click();
  await expect(caller.locator("#video-call-btn")).toBeEnabled();
  await caller.locator("#video-call-btn").click();
  await expect(receiver.locator("#incoming-call-dialog")).toBeVisible();
  await receiver.locator("#accept-call").click();
  await expect.poll(() => caller.evaluate(
    () => globalThis.__rtcMock.snapshot().connections.at(-1)?.remoteDescriptions.length || 0,
  )).toBeGreaterThan(0);
  await expect(caller.locator("#media-dock")).toBeVisible();
  await expect(receiver.locator("#media-dock")).toBeVisible();
  // WebKit cannot reliably navigate with an installed fake clock, so install
  // it only after signaling. The disconnect timers under test are created
  // after this point.
  if (fakeCallerClock) await caller.clock.install();
  return { caller, receiver };
}

test("mobile video controls mute audio, disable video, and switch both cameras", async ({ context }) => {
  await installMockRTC(context);
  const { caller } = await establishVideoCall(context);

  const initial = await caller.evaluate(() => globalThis.__rtcMock.snapshot());
  expect(initial.userMediaCalls[0]).toEqual({
    audio: true,
    video: { facingMode: { ideal: "user" } },
  });
  const initialAudio = initial.tracks.find((track) => track.kind === "audio");
  const initialVideo = initial.tracks.find((track) => track.kind === "video");
  expect(initialAudio).toBeTruthy();
  expect(initialVideo?.facingMode).toBe("user");

  const mute = caller.locator("#media-mute");
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => caller.evaluate(
    (id) => globalThis.__rtcMock.snapshot().tracks.find((track) => track.id === id)?.enabled,
    initialAudio.id,
  )).toBe(false);
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  expect(await caller.evaluate(
    (id) => globalThis.__rtcMock.snapshot().tracks.find((track) => track.id === id)?.enabled,
    initialAudio.id,
  )).toBe(true);

  const camera = caller.locator("#media-camera");
  await expect(camera).toBeVisible();
  await camera.click();
  await expect(camera).toHaveAttribute("aria-pressed", "true");
  expect(await caller.evaluate(
    (id) => globalThis.__rtcMock.snapshot().tracks.find((track) => track.id === id)?.enabled,
    initialVideo.id,
  )).toBe(false);
  await camera.click();
  await expect(camera).toHaveAttribute("aria-pressed", "false");
  expect(await caller.evaluate(
    (id) => globalThis.__rtcMock.snapshot().tracks.find((track) => track.id === id)?.enabled,
    initialVideo.id,
  )).toBe(true);

  const switchCamera = caller.locator("#media-switch-camera");
  await expect(switchCamera).toBeVisible();
  await switchCamera.click();
  await expect.poll(() => caller.evaluate(
    () => globalThis.__rtcMock.snapshot().userMediaCalls.length,
  )).toBe(2);
  let afterSwitch = await caller.evaluate(() => globalThis.__rtcMock.snapshot());
  expect(afterSwitch.userMediaCalls[1]).toEqual({
    audio: false,
    video: { facingMode: { ideal: "environment" } },
  });
  expect(afterSwitch.tracks.find((track) => track.id === initialVideo.id)).toMatchObject({
    stopped: true,
    stopCalls: 1,
  });
  expect(afterSwitch.connections[0].replacements).toHaveLength(1);
  const rearCameraId = afterSwitch.connections[0].replacements[0].to;
  expect(afterSwitch.tracks.find((track) => track.id === rearCameraId)).toMatchObject({
    facingMode: "environment",
    enabled: true,
    stopped: false,
  });

  await switchCamera.click();
  await expect.poll(() => caller.evaluate(
    () => globalThis.__rtcMock.snapshot().userMediaCalls.length,
  )).toBe(3);
  afterSwitch = await caller.evaluate(() => globalThis.__rtcMock.snapshot());
  expect(afterSwitch.userMediaCalls[2]).toEqual({
    audio: false,
    video: { facingMode: { ideal: "user" } },
  });
  expect(afterSwitch.tracks.find((track) => track.id === rearCameraId)).toMatchObject({
    stopped: true,
    stopCalls: 1,
  });
  expect(afterSwitch.connections[0].replacements).toHaveLength(2);
});

test("a disconnected mobile call performs at most one automatic ICE restart", async ({ context }) => {
  await installMockRTC(context);
  const { caller } = await establishVideoCall(context, { fakeCallerClock: true });

  await caller.evaluate(() => globalThis.__rtcMock.transitionLatest("connected"));
  await expect(caller.locator("#media-status")).toContainText(/Live|通话中/u);

  await caller.evaluate(() => globalThis.__rtcMock.transitionLatest("disconnected"));
  await expect(caller.locator("#media-status")).toContainText(/reconnecting|正在重新连接/iu);
  await caller.clock.runFor(8_001);
  await expect.poll(() => caller.evaluate(
    () => globalThis.__rtcMock.snapshot().connections[0]?.restartIceCalls || 0,
  )).toBe(1);
  await expect.poll(() => caller.evaluate(
    () => globalThis.__rtcMock.snapshot().connections[0]?.remoteDescriptions.length || 0,
  )).toBeGreaterThanOrEqual(2);

  let snapshot = await caller.evaluate(() => globalThis.__rtcMock.snapshot());
  expect(snapshot.connections[0].offers.filter((offer) => offer.iceRestart === true)).toHaveLength(1);
  await caller.evaluate(() => globalThis.__rtcMock.transitionLatest("connected"));
  await expect(caller.locator("#media-status")).toContainText(/Live|通话中/u);

  await caller.evaluate(() => globalThis.__rtcMock.transitionLatest("disconnected"));
  await caller.clock.runFor(8_001);
  await expect(caller.locator("#media-dock")).toBeHidden();
  await expect(caller.locator("#app")).toHaveAttribute("data-mobile-state", "connected");
  snapshot = await caller.evaluate(() => globalThis.__rtcMock.snapshot());
  expect(snapshot.connections[0].restartIceCalls).toBe(1);
  expect(snapshot.connections[0].offers.filter((offer) => offer.iceRestart === true)).toHaveLength(1);
  expect(snapshot.connections[0].closed).toBe(true);
});
