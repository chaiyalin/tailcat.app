import { expect, test } from "@playwright/test";

test("pending admission expires without exposing a roster", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const config = {
      maxMembers: 10,
      maxPendingJoins: 9,
      joinRequestTTLms: 25,
      reconnectGraceMs: 120_000,
      heartbeatIntervalMs: 60_000,
      heartbeatFailureLimit: 2,
      replayMaxItems: 100,
      replayMaxBytes: 8 * 1024 * 1024,
      dedupeMaxItems: 256,
      sendQueueMaxFrames: 64,
      sendQueueMaxBytes: 1024 * 1024,
      maxBatchBytes: 1024 * 1024 * 1024,
      maxParallelRecipients: 2,
      ticketTTLms: 120_000,
    };
    const limits = { textBytes: 64 * 1024, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 };
    const validAddress = (value) => /^tc[a-z0-9]{64}$/u.test(value);
    const ownerAddress = `tc${"a".repeat(64)}`;
    const guestAddress = `tc${"b".repeat(64)}`;
    const connections = new Set();

    function pair() {
      const states = [
        { queue: [], waiters: [], ended: false, closed: false },
        { queue: [], waiters: [], ended: false, closed: false },
      ];
      const endpoints = states.map((state, index) => ({
        port: 104,
        async read() {
          if (state.queue.length) return state.queue.shift();
          if (state.ended || state.closed) return null;
          return new Promise((resolve) => state.waiters.push(resolve));
        },
        async write(bytes) {
          if (state.closed) throw new Error("closed");
          const remote = states[1 - index];
          const copy = bytes.slice();
          if (remote.waiters.length) remote.waiters.shift()(copy);
          else remote.queue.push(copy);
        },
        async closeWrite() {
          const remote = states[1 - index];
          remote.ended = true;
          while (remote.waiters.length) remote.waiters.shift()(null);
        },
        close() {
          if (state.closed) return;
          state.closed = true;
          while (state.waiters.length) state.waiters.shift()(null);
          const remote = states[1 - index];
          remote.ended = true;
          while (remote.waiters.length) remote.waiters.shift()(null);
        },
      }));
      connections.add(endpoints[0]);
      connections.add(endpoints[1]);
      return endpoints;
    }

    let owner;
    owner = new GroupRoomController({
      config,
      limits,
      validAddress,
      capabilities: () => ({ file: { protocol: "TCF1", receive: true, maxBytes: limits.fileBytes }, voice: { enabled: true, maxBytes: limits.voiceBytes } }),
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
    });
    owner.startOwner({ address: ownerAddress, displayName: "Owner" });
    const invite = { address: ownerAddress, roomId: owner.roomId, joinToken: owner.joinToken };
    const guest = new GroupRoomController({
      config,
      limits,
      validAddress,
      capabilities: () => ({}),
      connect: async () => ({
        async dial() {
          const [client, server] = pair();
          queueMicrotask(() => void owner.handleIncoming(server));
          return client;
        },
        close() { for (const connection of connections) connection.close(); },
      }),
    });
    let rejection = "";
    try {
      await guest.requestJoin({ invite, address: guestAddress, displayName: "Waiting" });
    } catch (error) {
      rejection = error.message;
    }
    const output = {
      rejection,
      pending: owner.snapshot().pending.length,
      guestMode: guest.snapshot().mode,
      guestMembers: guest.snapshot().members.length,
    };
    await owner.close("TEST", { notify: false });
    return output;
  });
  expect(result.rejection).toContain("EXPIRED");
  expect(result.pending).toBe(0);
  expect(result.guestMode).toBe("none");
  expect(result.guestMembers).toBe(0);
});

test("a transfer ticket is bound to both members and can be consumed only once", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    let now = 10_000;

    const controller = new GroupRoomController({
      config: {
        maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
        heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
        replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
        sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
        ticketTTLms: 120_000,
      },
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
      now: () => now,
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    const senderId = "B".repeat(22);
    controller.members.set(senderId, {
      id: senderId,
      code: "SENDER",
      displayName: "Sender",
      role: "member",
      status: "online",
      capabilities: {},
    });
    const frame = {
      gv: 1,
      roomId: controller.roomId,
      ticket: "C".repeat(43),
      expiresAt: now + 120_000,
      kind: "file",
      senderId,
      recipientId: controller.memberId,
      transferId: "d".repeat(32),
      size: 42,
    };
    controller.armTicket(frame);
    let wrongMemberRejected = false;
    try { await controller.consumeTransferTicket({ ...frame, senderId: "E".repeat(22) }, "file", 42); } catch (_) { wrongMemberRejected = true; }
    const accepted = await controller.consumeTransferTicket(frame, "file", 42);
    let replayRejected = false;
    try { await controller.consumeTransferTicket(frame, "file", 42); } catch (_) { replayRejected = true; }

    const expiredFrame = { ...frame, ticket: "F".repeat(43), expiresAt: now + 100 };
    controller.armTicket(expiredFrame);
    // Receiver clocks are not comparable to the host's expiresAt. The local
    // arm is retained for one full ticket TTL and the online host remains the
    // authority when it is consumed.
    now += 120_001;
    let expiredRejected = false;
    try { await controller.consumeTransferTicket(expiredFrame, "file", 42); } catch (_) { expiredRejected = true; }
    await controller.close("TEST", { notify: false });
    return { wrongMemberRejected, replayRejected, expiredRejected, acceptedSender: accepted.senderId };
  });
  expect(result).toEqual({
    wrongMemberRejected: true,
    replayRejected: true,
    expiredRejected: true,
    acceptedSender: "B".repeat(22),
  });
});

test("resume enforces the admission baseline and serializes transactional attempts", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const { GroupFrameReader } = await import("/group-protocol.js");
    const config = {
      maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
      heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
      replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
      sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
      ticketTTLms: 120_000,
    };
    const limits = { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 };
    const address = `tc${"a".repeat(64)}`;
    const memberAddress = `tc${"b".repeat(64)}`;
    const memberId = "B".repeat(22);
    const sessionToken = "S".repeat(43);
    let now = 10_000;

    const bounded = (promise, label) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out: ${label}`)), 1_000)),
    ]);

    function makeConnection({ blockWrite = 0 } = {}) {
      const writes = [];
      let writeCount = 0;
      let rejectBlocked;
      let resolveBlockedStarted;
      let resolveRead;
      const blockedStarted = new Promise((resolve) => { resolveBlockedStarted = resolve; });
      const connection = {
        closed: false,
        writes,
        async read() {
          if (connection.closed) return null;
          return new Promise((resolve) => { resolveRead = resolve; });
        },
        async write(bytes) {
          writeCount += 1;
          writes.push(bytes.slice());
          if (writeCount === blockWrite) {
            resolveBlockedStarted();
            return new Promise((_, reject) => { rejectBlocked = reject; });
          }
        },
        async closeWrite() {},
        close() {
          connection.closed = true;
          resolveRead?.(null);
        },
        blockedStarted,
        get writeCount() { return writeCount; },
        failBlocked() { rejectBlocked?.(new Error("injected replay failure")); },
      };
      return connection;
    }

    async function firstFrame(connection) {
      const chunks = connection.writes.map((bytes) => bytes.slice());
      const reader = new GroupFrameReader({ async read() { return chunks.shift() ?? null; } });
      return reader.read();
    }

    const statuses = [];
    const owner = new GroupRoomController({
      config,
      limits,
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
      now: () => now,
      onStatus: (code) => statuses.push(code),
    });
    owner.startOwner({ address, displayName: "Owner" });
    for (let index = 0; index < 3; index += 1) owner.commitEvent({
      type: "TEXT",
      senderId: owner.ownerId,
      clientEventId: String(index).padStart(22, "A"),
      text: `before-${index}`,
    });
    const graceTimer = setTimeout(() => {}, 120_000);
    const originalConnection = { marker: "original" };
    const originalReader = { marker: "original" };
    const originalWriter = { marker: "original" };
    const member = {
      id: memberId,
      code: "MEMBER",
      displayName: "Member",
      role: "member",
      status: "reconnecting",
      address: memberAddress,
      capabilities: {},
      sessionToken,
      connection: originalConnection,
      reader: originalReader,
      writer: originalWriter,
      streamEntry: null,
      deduper: { get() {}, remember() {} },
      outstandingPings: new Set(),
      admissionSeq: 3,
      resumeAttempt: null,
      graceTimer,
      reconnectDeadline: now + 120_000,
      removed: false,
    };
    owner.members.set(memberId, member);
    const baseFrame = {
      type: "RESUME_REQUEST",
      gv: 1,
      roomId: owner.roomId,
      memberId,
      sessionToken,
      replyTo: memberAddress,
    };

    const preJoin = makeConnection();
    await owner.acceptResume(preJoin, { async read() { return null; } }, { ...baseFrame, lastSeq: 2 });
    const preJoinResponse = await bounded(firstFrame(preJoin), "decode baseline rejection");
    const baselineRejected = preJoinResponse.type === "RESUME_REJECT"
      && member.status === "reconnecting"
      && member.graceTimer === graceTimer;

    owner.commitEvent({
      type: "TEXT",
      senderId: owner.ownerId,
      clientEventId: "Z".repeat(22),
      text: "after admission",
    });
    owner.roomPaused = true;
    owner.pauseReason = "HOST_BACKGROUND";
    owner.joinsPaused = true;

    const first = makeConnection({ blockWrite: 3 });
    const firstAttempt = owner.acceptResume(first, first, { ...baseFrame, lastSeq: 3 });
    await bounded(first.blockedStarted, `reach blocked replay write (${first.writeCount})`);
    const untouchedDuringSetup = member.connection === originalConnection
      && member.reader === originalReader
      && member.writer === originalWriter
      && member.graceTimer === graceTimer
      && member.status === "reconnecting";

    const concurrent = makeConnection();
    await owner.acceptResume(concurrent, concurrent, { ...baseFrame, lastSeq: 3 });
    const concurrentResponse = await bounded(firstFrame(concurrent), "decode concurrent rejection");
    const concurrentRejected = concurrentResponse.type === "RESUME_REJECT" && member.resumeAttempt !== null;

    first.failBlocked();
    let setupFailed = false;
    try { await firstAttempt; } catch (_) { setupFailed = true; }
    const rolledBack = setupFailed
      && member.resumeAttempt === null
      && member.connection === originalConnection
      && member.writer === originalWriter
      && member.graceTimer === graceTimer
      && member.status === "reconnecting";

    const retry = makeConnection();
    const retryAttempt = owner.acceptResume(retry, retry, { ...baseFrame, lastSeq: 3 });
    for (let index = 0; index < 50 && member.status !== "online"; index += 1) await Promise.resolve();
    const retryResponse = await bounded(firstFrame(retry), "decode successful resume");
    const activatedAfterSetup = member.status === "online"
      && member.connection === retry
      && member.graceTimer === null
      && retryResponse.roomPaused === true
      && retryResponse.pauseReason === "HOST_BACKGROUND"
      && retryResponse.joinsPaused === true;
    retry.close();
    await bounded(retryAttempt, "finish successful stream");
    clearTimeout(graceTimer);
    await bounded(owner.close("TEST", { notify: false }), "close owner");
    return { baselineRejected, untouchedDuringSetup, concurrentRejected, rolledBack, activatedAfterSetup };
  });
  expect(result).toEqual({
    baselineRejected: true,
    untouchedDuringSetup: true,
    concurrentRejected: true,
    rolledBack: true,
    activatedAfterSetup: true,
  });
});

test("a recovered guest applies current room and join pause state", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const { TCG_MAGIC, encodeGroupFrame } = await import("/group-protocol.js");
    const config = {
      maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
      heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
      replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
      sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
      ticketTTLms: 120_000,
    };
    const roomId = "R".repeat(22);
    const ownerId = "O".repeat(22);
    const memberId = "M".repeat(22);
    const hostAddress = `tc${"a".repeat(64)}`;
    const localAddress = `tc${"b".repeat(64)}`;
    let resolveRead;
    const chunks = [
      TCG_MAGIC.slice(),
      encodeGroupFrame({
        type: "RESUME_ACCEPT",
        gv: 1,
        roomId,
        memberId,
        currentSeq: 7,
        roomPaused: true,
        pauseReason: "HOST_BACKGROUND",
        joinsPaused: true,
      }),
    ];
    const connection = {
      closed: false,
      async read() {
        if (chunks.length) return chunks.shift();
        if (connection.closed) return null;
        return new Promise((resolve) => { resolveRead = resolve; });
      },
      async write() {},
      async closeWrite() {},
      close() {
        connection.closed = true;
        resolveRead?.(null);
      },
    };
    let resolveRecovered;
    let dials = 0;
    const recovered = new Promise((resolve) => { resolveRecovered = resolve; });
    const guest = new GroupRoomController({
      config,
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => ({ async dial() { dials += 1; return connection; }, close() { connection.close(); } }),
      onStatus: (code) => { if (code === "RECOVERED") resolveRecovered(); },
    });
    guest.mode = "member";
    guest.roomId = roomId;
    guest.ownerId = ownerId;
    guest.memberId = memberId;
    guest.sessionToken = "S".repeat(43);
    guest.hostAddress = hostAddress;
    guest.localAddress = localAddress;
    guest.lastSeq = 7;
    guest.roomPaused = false;
    guest.pauseReason = "";
    guest.joinsPaused = false;
    guest.beginRecovery();
    guest.beginRecovery();
    await Promise.race([
      recovered,
      new Promise((_, reject) => setTimeout(() => reject(new Error("recovery did not finish")), 1_000)),
    ]);
    const snapshot = guest.snapshot();
    const output = {
      roomPaused: snapshot.roomPaused,
      pauseReason: snapshot.pauseReason,
      joinsPaused: snapshot.joinsPaused,
      canSend: guest.canSend,
      dials,
    };
    await guest.close("TEST", { notify: false });
    return output;
  });
  expect(result).toEqual({
    roomPaused: true,
    pauseReason: "HOST_BACKGROUND",
    joinsPaused: true,
    canSend: false,
    dials: 1,
  });
});

test("member departure and roster resync revoke local tickets", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const statuses = [];
    const controller = new GroupRoomController({
      config: {
        maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
        heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
        replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
        sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
        ticketTTLms: 120_000,
      },
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
      now: () => 10_000,
      onStatus: (code, detail) => statuses.push({ code, memberId: detail.memberId || "" }),
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    const makeMember = (id) => ({
      id, code: "MEMBER", displayName: id.slice(0, 2), role: "member", status: "online", capabilities: {},
    });
    const departed = "B".repeat(22);
    controller.members.set(departed, makeMember(departed));
    const firstTicket = {
      gv: 1, roomId: controller.roomId, ticket: "C".repeat(43), expiresAt: 20_000,
      kind: "file", senderId: departed, recipientId: controller.memberId, transferId: "d".repeat(32), size: 42,
    };
    controller.armTicket(firstTicket);
    controller.acceptEvent({ type: "MEMBER_LEFT", seq: 1, memberId: departed });
    let departureRevoked = false;
    try { await controller.consumeTransferTicket(firstTicket, "file", 42); } catch (_) { departureRevoked = true; }

    const disappeared = "D".repeat(22);
    controller.members.set(disappeared, makeMember(disappeared));
    const secondTicket = {
      ...firstTicket,
      ticket: "E".repeat(43),
      senderId: disappeared,
      transferId: "f".repeat(32),
    };
    controller.armTicket(secondTicket);
    await controller.handleOwnerFrame({
      type: "RESYNC_REQUIRED",
      gv: 1,
      roomId: controller.roomId,
      seq: 2,
      roster: controller.snapshot().members.filter((member) => member.id === controller.ownerId),
    });
    let resyncRevoked = false;
    try { await controller.consumeTransferTicket(secondTicket, "file", 42); } catch (_) { resyncRevoked = true; }
    const revokedMembers = statuses
      .filter(({ code }) => code === "MEMBER_TICKETS_REVOKED")
      .map(({ memberId }) => memberId);
    await controller.close("TEST", { notify: false });
    return { departureRevoked, resyncRevoked, revokedMembers };
  });
  expect(result).toEqual({
    departureRevoked: true,
    resyncRevoked: true,
    revokedMembers: ["B".repeat(22), "D".repeat(22)],
  });
});
