import { expect, test } from "@playwright/test";

test("pending approval is blocked while joins or the room are paused", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const config = {
      maxMembers: 10,
      maxPendingJoins: 9,
      joinRequestTTLms: 60_000,
      reconnectGraceMs: 120_000,
      heartbeatIntervalMs: 60_000,
      heartbeatFailureLimit: 2,
      replayMaxItems: 100,
      replayMaxBytes: 8 * 1024 * 1024,
      dedupeMaxItems: 256,
      sendQueueMaxFrames: 64,
      sendQueueMaxBytes: 1024 * 1024,
      maxBatchBytes: 1024 ** 3,
      maxParallelRecipients: 2,
      ticketTTLms: 120_000,
    };
    const limits = { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 };
    const ownerAddress = `tc${"a".repeat(64)}`;
    const guestAddress = `tc${"b".repeat(64)}`;

    const makeOwner = () => {
      const controller = new GroupRoomController({
        config,
        limits,
        validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
        capabilities: () => ({}),
        connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
      });
      controller.startOwner({ address: ownerAddress, displayName: "Owner" });
      return controller;
    };

    const addPending = (controller, requestId) => {
      const sent = [];
      const entry = {
        epoch: controller.lifecycleEpoch,
        roomId: controller.roomId,
        requestId,
        clientNonce: "N".repeat(43),
        address: guestAddress,
        displayName: "Guest",
        code: "GUEST1",
        capabilities: {},
        expiresAt: Date.now() + 60_000,
        state: "pending",
        connection: { close() {} },
        reader: { async read() { return null; } },
        writer: {
          async send(frame) { sent.push(frame); },
          async closeWrite() {},
          close() {},
        },
        member: null,
        closed: false,
        timer: null,
      };
      controller.pending.set(requestId, entry);
      return { entry, sent };
    };

    const roomPaused = makeOwner();
    const roomPending = addPending(roomPaused, "R".repeat(22));
    let roomVerifyCalls = 0;
    roomPaused.verifyAddress = async () => { roomVerifyCalls += 1; };
    roomPaused.roomPaused = true;
    const roomApproved = await roomPaused.approvePending(roomPending.entry.requestId);
    const roomOutcome = {
      approved: roomApproved,
      verifyCalls: roomVerifyCalls,
      memberCount: roomPaused.members.size,
      sequence: roomPaused.nextSeq,
      accepted: roomPending.sent.some((frame) => frame.type === "JOIN_ACCEPT"),
    };

    const joinsPaused = makeOwner();
    const joinsPending = addPending(joinsPaused, "J".repeat(22));
    let joinsVerifyCalls = 0;
    joinsPaused.verifyAddress = async () => { joinsVerifyCalls += 1; };
    joinsPaused.joinsPaused = true;
    const joinsApproved = await joinsPaused.approvePending(joinsPending.entry.requestId);
    const joinsOutcome = {
      approved: joinsApproved,
      verifyCalls: joinsVerifyCalls,
      memberCount: joinsPaused.members.size,
      sequence: joinsPaused.nextSeq,
      accepted: joinsPending.sent.some((frame) => frame.type === "JOIN_ACCEPT"),
    };

    const pausedDuringProof = makeOwner();
    const racingPending = addPending(pausedDuringProof, "V".repeat(22));
    let racingVerifyCalls = 0;
    pausedDuringProof.verifyAddress = async () => {
      racingVerifyCalls += 1;
      pausedDuringProof.roomPaused = true;
    };
    const racingApproved = await pausedDuringProof.approvePending(racingPending.entry.requestId);
    const racingOutcome = {
      approved: racingApproved,
      verifyCalls: racingVerifyCalls,
      memberCount: pausedDuringProof.members.size,
      sequence: pausedDuringProof.nextSeq,
      accepted: racingPending.sent.some((frame) => frame.type === "JOIN_ACCEPT"),
    };

    await Promise.all([
      roomPaused.close("TEST", { notify: false }),
      joinsPaused.close("TEST", { notify: false }),
      pausedDuringProof.close("TEST", { notify: false }),
    ]);
    return { roomOutcome, joinsOutcome, racingOutcome };
  });

  expect(result).toEqual({
    roomOutcome: { approved: false, verifyCalls: 0, memberCount: 1, sequence: 0, accepted: false },
    joinsOutcome: { approved: false, verifyCalls: 0, memberCount: 1, sequence: 0, accepted: false },
    racingOutcome: { approved: false, verifyCalls: 1, memberCount: 1, sequence: 0, accepted: false },
  });
});

test("blank member text is rejected without consuming a room sequence", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const events = [];
    const replies = [];
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
      onEvent: (event) => events.push(event),
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    const member = {
      id: "M".repeat(22),
      code: "MEMBER",
      displayName: "Member",
      role: "member",
      status: "online",
      address: `tc${"b".repeat(64)}`,
      capabilities: {},
      sessionToken: "S".repeat(43),
      connection: { close() {} },
      reader: null,
      writer: { async send(frame) { replies.push(frame); }, close() {} },
      streamEntry: null,
      deduper: { get() { return undefined; }, remember() {} },
      outstandingPings: new Set(),
      admissionSeq: 0,
      resumeAttempt: null,
      graceTimer: null,
      reconnectDeadline: 0,
      removed: false,
    };
    controller.members.set(member.id, member);

    let threw = false;
    try {
      await controller.handleMemberFrame(member, {
        type: "TEXT_SUBMIT",
        gv: 1,
        roomId: controller.roomId,
        clientEventId: "E".repeat(22),
        text: " \t\n ",
      });
    } catch (_) {
      threw = true;
    }
    await Promise.resolve();
    const output = {
      rejected: threw || replies.some((frame) => frame.type === "ACTION_REJECTED"),
      sequence: controller.nextSeq,
      eventCount: events.length,
      replayCount: controller.replay.after(0)?.length ?? -1,
    };
    await controller.close("TEST", { notify: false });
    return output;
  });

  expect(result).toEqual({ rejected: true, sequence: 0, eventCount: 0, replayCount: 0 });
});

test("failed address verification evicts and closes its cached transport", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const guestAddress = `tc${"b".repeat(64)}`;
    let connectCalls = 0;
    let transportCloses = 0;
    let connectionCloses = 0;
    const connection = {
      async read() { return null; },
      async write() {},
      async closeWrite() {},
      close() { connectionCloses += 1; },
    };
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
      connect: async () => {
        connectCalls += 1;
        return {
          async dial() { return connection; },
          close() { transportCloses += 1; },
        };
      },
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    const rejectionFrames = [];
    const requestId = "R".repeat(22);
    controller.pending.set(requestId, {
      epoch: controller.lifecycleEpoch,
      roomId: controller.roomId,
      requestId,
      clientNonce: "N".repeat(43),
      address: guestAddress,
      displayName: "Guest",
      code: "GUEST1",
      capabilities: {},
      expiresAt: Date.now() + 60_000,
      state: "pending",
      connection: { close() {} },
      reader: { async read() { return null; } },
      writer: {
        async send(frame) { rejectionFrames.push(frame); },
        async closeWrite() {},
        close() {},
      },
      member: null,
      closed: false,
      timer: null,
    });
    const approved = await controller.approvePending(requestId);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const output = {
      rejected: approved === false
        && rejectionFrames.some((frame) => frame.type === "JOIN_REJECT" && frame.reason === "VERIFY_FAILED"),
      connectCalls,
      connectionCloses,
      transportCloses,
      stillCached: controller.transports.has(guestAddress),
    };
    await controller.close("TEST", { notify: false });
    return output;
  });

  expect(result).toEqual({
    rejected: true,
    connectCalls: 1,
    connectionCloses: 1,
    transportCloses: 1,
    stillCached: false,
  });
});

test("a stalled callback verification cannot head-of-line block another approval", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const config = {
      maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
      heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
      replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
      sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
      ticketTTLms: 120_000, ticketTombstoneMaxItems: 256,
    };
    const controller = new GroupRoomController({
      config,
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    const makePending = (requestId, addressCharacter) => ({
      epoch: controller.lifecycleEpoch,
      roomId: controller.roomId,
      requestId,
      clientNonce: "N".repeat(43),
      address: `tc${addressCharacter.repeat(64)}`,
      displayName: `Guest ${addressCharacter}`,
      code: `GUEST${addressCharacter}`,
      capabilities: {},
      expiresAt: Date.now() + 60_000,
      state: "pending",
      connection: { close() {} },
      reader: { async read() { return null; } },
      writer: { async send() {}, async closeWrite() {}, close() {} },
      member: null,
      closed: false,
      timer: null,
    });
    const firstId = "A".repeat(22);
    const secondId = "B".repeat(22);
    controller.pending.set(firstId, makePending(firstId, "b"));
    controller.pending.set(secondId, makePending(secondId, "c"));
    controller.verifyAddress = (entry) => entry.requestId === firstId
      ? new Promise(() => {})
      : Promise.resolve();

    const firstApproval = controller.approvePending(firstId);
    await Promise.resolve();
    const secondApproved = await Promise.race([
      controller.approvePending(secondId),
      new Promise((_, reject) => setTimeout(() => reject(new Error("second approval blocked")), 250)),
    ]);
    controller.setJoinsPaused(true);
    const firstApproved = await Promise.race([
      firstApproval,
      new Promise((_, reject) => setTimeout(() => reject(new Error("cancelled approval did not settle")), 250)),
    ]);
    const output = {
      firstApproved,
      secondApproved,
      members: controller.members.size,
      pending: controller.pending.size,
    };
    await controller.close("TEST", { notify: false });
    return output;
  });

  expect(result).toEqual({ firstApproved: false, secondApproved: true, members: 2, pending: 0 });
});

test("invitation rotation revokes an admission whose JOIN_ACCEPT write is still pending", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const controller = new GroupRoomController({
      config: {
        maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
        heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
        replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
        sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
        ticketTTLms: 120_000, ticketTombstoneMaxItems: 256,
      },
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    const requestId = "R".repeat(22);
    let acceptanceStarted;
    const started = new Promise((resolve) => { acceptanceStarted = resolve; });
    controller.pending.set(requestId, {
      epoch: controller.lifecycleEpoch,
      roomId: controller.roomId,
      requestId,
      clientNonce: "N".repeat(43),
      address: `tc${"b".repeat(64)}`,
      displayName: "Guest",
      code: "GUEST1",
      capabilities: {},
      expiresAt: Date.now() + 60_000,
      state: "pending",
      connection: { close() {} },
      reader: { async read() { return null; } },
      writer: {
        async send(frame) {
          if (frame.type === "JOIN_ACCEPT") {
            acceptanceStarted();
            return new Promise(() => {});
          }
        },
        async closeWrite() {},
        close() {},
      },
      member: null,
      closed: false,
      timer: null,
    });
    controller.verifyAddress = async () => {};
    const approval = controller.approvePending(requestId);
    await started;
    const oldToken = controller.joinToken;
    await controller.rotateInvitation();
    const approved = await Promise.race([
      approval,
      new Promise((_, reject) => setTimeout(() => reject(new Error("revoked admission did not settle")), 250)),
    ]);
    const output = {
      approved,
      tokenRotated: controller.joinToken !== oldToken,
      members: controller.members.size,
      pending: controller.pending.size,
      sequence: controller.nextSeq,
    };
    await controller.close("TEST", { notify: false });
    return output;
  });

  expect(result).toEqual({ approved: false, tokenRotated: true, members: 1, pending: 0, sequence: 0 });
});

test("ticket and request tombstones use a bounded expiring LRU", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    let now = 1_000;
    const controller = new GroupRoomController({
      config: {
        maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
        heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
        replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
        sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
        ticketTTLms: 100, ticketTombstoneMaxItems: 8,
      },
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
      now: () => now,
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    for (let index = 0; index < 20; index += 1) {
      controller.rememberSpentTicket(`ticket-${index}`);
      controller.rememberCancelledTicketRequest(`request-${index}`);
    }
    const bounded = {
      tickets: controller.spentTickets.size,
      requests: controller.cancelledTicketRequests.size,
      oldestEvicted: !controller.spentTickets.has("ticket-0") && !controller.cancelledTicketRequests.has("request-0"),
      newestRetained: controller.spentTickets.has("ticket-19") && controller.cancelledTicketRequests.has("request-19"),
    };
    now += 101;
    controller.pruneTickets();
    const expired = {
      tickets: controller.spentTickets.size,
      requests: controller.cancelledTicketRequests.size,
    };
    await controller.close("TEST", { notify: false });
    return { bounded, expired };
  });

  expect(result).toEqual({
    bounded: { tickets: 8, requests: 8, oldestEvicted: true, newestRetained: true },
    expired: { tickets: 0, requests: 0 },
  });
});

test("closing revokes text and ticket authority before ROOM_CLOSED finishes writing", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const controller = new GroupRoomController({
      config: {
        maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
        heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
        replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
        sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
        ticketTTLms: 120_000, ticketTombstoneMaxItems: 256,
      },
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    let releaseNotice;
    let noticeStarted;
    const notice = new Promise((resolve) => { releaseNotice = resolve; });
    const started = new Promise((resolve) => { noticeStarted = resolve; });
    const member = {
      id: "M".repeat(22), code: "MEMBER", displayName: "Member", role: "member", status: "online",
      address: `tc${"b".repeat(64)}`,
      capabilities: { file: { protocol: "TCF1", receive: true, maxBytes: 1024 ** 3 } },
      sessionToken: "S".repeat(43), connection: { close() {} }, reader: null,
      writer: {
        send(frame) {
          if (frame.type === "ROOM_CLOSED") {
            noticeStarted();
            return notice;
          }
          return Promise.resolve();
        },
        close() { releaseNotice(); },
      },
      streamEntry: null,
      deduper: { get() { return undefined; }, remember() {} },
      outstandingPings: new Set(), stalePings: new Set(), heartbeatFailures: 0,
      admissionSeq: 0, resumeAttempt: null, graceTimer: null, reconnectDeadline: 0, removed: false,
    };
    controller.members.set(member.id, member);
    const closing = controller.close("HOST_CLOSED", { notify: true });
    await started;
    let textRejected = false;
    try {
      await controller.handleMemberFrame(member, {
        type: "TEXT_SUBMIT", gv: 1, roomId: controller.roomId,
        clientEventId: "E".repeat(22), text: "must not commit",
      });
    } catch (_) { textRejected = true; }
    let ticketRejected = false;
    try {
      await controller.issueTransferTickets(member, {
        type: "TRANSFER_TICKET_REQUEST", gv: 1, roomId: controller.roomId,
        requestId: "Q".repeat(22), kind: "file",
        items: [{ transferId: "f".repeat(32), size: 1 }],
        recipientIds: [controller.ownerId], targetTransferId: "f".repeat(32), targetRecipientId: controller.ownerId,
      });
    } catch (_) { ticketRejected = true; }
    const sequenceDuringClose = controller.nextSeq;
    releaseNotice();
    await closing;
    return { textRejected, ticketRejected, sequenceDuringClose };
  });

  expect(result).toEqual({ textRejected: true, ticketRejected: true, sequenceDuringClose: 0 });
});

test("closing rejects resume and removal while ROOM_CLOSED is still writing", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const events = [];
    const controller = new GroupRoomController({
      config: {
        maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
        heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
        replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
        sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
        ticketTTLms: 120_000, ticketTombstoneMaxItems: 256,
      },
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
      onEvent: (event) => events.push(event),
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    const roomId = controller.roomId;

    let releaseNotice;
    let noticeStarted;
    const notice = new Promise((resolve) => { releaseNotice = resolve; });
    const started = new Promise((resolve) => { noticeStarted = resolve; });
    const memberBase = ({ id, address, status, writer = null }) => ({
      id,
      code: id.slice(0, 6),
      displayName: id[0],
      role: "member",
      status,
      address,
      capabilities: {},
      sessionToken: "S".repeat(43),
      connection: writer ? { close() {} } : null,
      reader: null,
      writer,
      streamEntry: null,
      deduper: { get() { return undefined; }, remember() {} },
      outstandingPings: new Set(),
      stalePings: new Set(),
      heartbeatFailures: 0,
      admissionSeq: 0,
      resumeAttempt: null,
      graceTimer: null,
      reconnectDeadline: Date.now() + 120_000,
      removed: false,
    });
    const blocker = memberBase({
      id: "B".repeat(22),
      address: `tc${"b".repeat(64)}`,
      status: "online",
      writer: {
        send(frame) {
          if (frame.type === "ROOM_CLOSED") {
            noticeStarted();
            return notice;
          }
          return Promise.resolve();
        },
        close() { releaseNotice(); },
      },
    });
    const reconnecting = memberBase({
      id: "R".repeat(22),
      address: `tc${"r".repeat(64)}`,
      status: "reconnecting",
    });
    controller.members.set(blocker.id, blocker);
    controller.members.set(reconnecting.id, reconnecting);

    const closing = controller.close("HOST_CLOSED", { notify: true });
    await started;

    const resumeWrites = [];
    let resumeClosed = 0;
    const resumeConnection = {
      async write(bytes) { resumeWrites.push(bytes.slice()); },
      async closeWrite() {},
      close() { resumeClosed += 1; },
    };
    await controller.acceptResume(resumeConnection, { async read() { return null; } }, {
      type: "RESUME_REQUEST",
      gv: 1,
      roomId,
      memberId: reconnecting.id,
      sessionToken: reconnecting.sessionToken,
      replyTo: reconnecting.address,
      lastSeq: 0,
    });
    const encodedReject = resumeWrites[1];
    const rejectLength = new DataView(
      encodedReject.buffer,
      encodedReject.byteOffset,
      4,
    ).getUint32(0, false);
    const rejectFrame = JSON.parse(new TextDecoder().decode(encodedReject.subarray(4, 4 + rejectLength)));
    const removed = await controller.removeMember(reconnecting.id);
    const duringClose = {
      closing: controller.closing,
      rejectType: rejectFrame.type,
      rejectReason: rejectFrame.reason,
      resumeClosed: resumeClosed > 0,
      resumed: reconnecting.status === "online" || reconnecting.resumeAttempt !== null,
      removed,
      memberPresent: controller.members.get(reconnecting.id) === reconnecting,
      sequence: controller.nextSeq,
      eventCount: events.length,
    };

    releaseNotice();
    await closing;
    return duringClose;
  });

  expect(result).toEqual({
    closing: true,
    rejectType: "RESUME_REJECT",
    rejectReason: "INVALID_SESSION",
    resumeClosed: true,
    resumed: false,
    removed: false,
    memberPresent: true,
    sequence: 0,
    eventCount: 0,
  });
});

test("ticket control writes time out without leaking waiters or rejections", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const controlBudgetMs = 25;
    const watchdogMs = 250;
    const config = {
      maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
      heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
      replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
      sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
      ticketTTLms: 120_000, ticketTombstoneMaxItems: 256, ticketControlTimeoutMs: controlBudgetMs,
    };
    const limits = { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 };
    const capabilities = { file: { protocol: "TCF1", receive: true, maxBytes: limits.fileBytes } };
    const { GroupRoomController } = await import("/group-room.js");
    const makeController = () => new GroupRoomController({
      config,
      limits,
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => capabilities,
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
    });
    const settleWithinWatchdog = async (promise) => {
      const startedAt = performance.now();
      return Promise.race([
        promise.then(
          (value) => ({ state: "resolved", value, elapsedMs: performance.now() - startedAt }),
          (error) => ({ state: "rejected", message: String(error?.message || error), elapsedMs: performance.now() - startedAt }),
        ),
        new Promise((resolve) => setTimeout(() => resolve({
          state: "watchdog",
          elapsedMs: performance.now() - startedAt,
        }), watchdogMs)),
      ]);
    };
    const unhandled = [];
    const captureUnhandled = (event) => {
      event.preventDefault();
      unhandled.push(String(event.reason?.message || event.reason));
    };
    window.addEventListener("unhandledrejection", captureUnhandled);

    const memberController = makeController();
    memberController.mode = "member";
    memberController.roomId = "G".repeat(22);
    memberController.ownerId = "O".repeat(22);
    memberController.memberId = "M".repeat(22);
    let memberWrites = 0;
    let memberWriterCloses = 0;
    let memberConnectionCloses = 0;
    memberController.writer = {
      send() {
        memberWrites += 1;
        return new Promise(() => {});
      },
      close() { memberWriterCloses += 1; },
    };
    memberController.connection = { close() { memberConnectionCloses += 1; } };
    const memberTransferId = "a".repeat(32);
    const memberOperation = memberController.requestTransferTickets({
      kind: "file",
      items: [{ transferId: memberTransferId, size: 1 }],
      recipientIds: [memberController.ownerId],
      targetTransferId: memberTransferId,
      targetRecipientId: memberController.ownerId,
    });
    const memberOutcome = await settleWithinWatchdog(memberOperation);
    const memberState = {
      outcome: memberOutcome.state,
      timedOut: memberOutcome.message === "transfer ticket request timed out",
      withinWatchdog: memberOutcome.elapsedMs < watchdogMs,
      writes: memberWrites,
      writerClosed: memberWriterCloses > 0,
      connectionClosed: memberConnectionCloses > 0,
      waiters: memberController.ticketWaiters.size,
    };

    const ownerController = makeController();
    ownerController.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    let armWrites = 0;
    let recipientWriterCloses = 0;
    let recipientConnectionCloses = 0;
    const recipient = {
      id: "R".repeat(22),
      code: "RECV01",
      displayName: "Recipient",
      role: "member",
      status: "online",
      address: `tc${"r".repeat(64)}`,
      capabilities,
      sessionToken: "S".repeat(43),
      connection: { close() { recipientConnectionCloses += 1; } },
      reader: null,
      writer: {
        send(frame) {
          if (frame.type === "TRANSFER_ARM") armWrites += 1;
          return new Promise(() => {});
        },
        close() { recipientWriterCloses += 1; },
      },
      streamEntry: null,
      deduper: { get() { return undefined; }, remember() {} },
      outstandingPings: new Set(),
      stalePings: new Set(),
      heartbeatFailures: 0,
      admissionSeq: 0,
      resumeAttempt: null,
      graceTimer: null,
      reconnectDeadline: 0,
      removed: false,
    };
    ownerController.members.set(recipient.id, recipient);
    const ownerTransferId = "b".repeat(32);
    const ownerOperation = ownerController.issueTransferTickets(ownerController.members.get(ownerController.ownerId), {
      type: "TRANSFER_TICKET_REQUEST",
      gv: 1,
      roomId: ownerController.roomId,
      requestId: "Q".repeat(22),
      kind: "file",
      items: [{ transferId: ownerTransferId, size: 1 }],
      recipientIds: [recipient.id],
      targetTransferId: ownerTransferId,
      targetRecipientId: recipient.id,
    });
    const ownerOutcome = await settleWithinWatchdog(ownerOperation);
    const ownerState = {
      outcome: ownerOutcome.state,
      failedUnavailable: ownerOutcome.value?.grants?.length === 0
        && ownerOutcome.value?.failures?.[0]?.reason === "UNAVAILABLE",
      withinWatchdog: ownerOutcome.elapsedMs < watchdogMs,
      armWrites,
      writerClosed: recipientWriterCloses > 0,
      connectionClosed: recipientConnectionCloses > 0,
      waiters: ownerController.ticketArmWaiters.size,
      issuedTickets: ownerController.issuedTickets.size,
      recipientStatus: recipient.status,
    };

    await memberController.close("TEST", { notify: false });
    await ownerController.close("TEST", { notify: false });
    await Promise.allSettled([memberOperation, ownerOperation]);
    await new Promise((resolve) => setTimeout(resolve, controlBudgetMs * 2));
    window.removeEventListener("unhandledrejection", captureUnhandled);
    return { memberState, ownerState, unhandled };
  });

  expect(result).toEqual({
    memberState: {
      outcome: "rejected",
      timedOut: true,
      withinWatchdog: true,
      writes: 1,
      writerClosed: true,
      connectionClosed: true,
      waiters: 0,
    },
    ownerState: {
      outcome: "resolved",
      failedUnavailable: true,
      withinWatchdog: true,
      armWrites: 1,
      writerClosed: true,
      connectionClosed: true,
      waiters: 0,
      issuedTickets: 0,
      recipientStatus: "reconnecting",
    },
    unhandled: [],
  });
});

test("a late reconnect callback from an old room cannot commit into the replacement room", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const events = [];
    let rejectOldWrite;
    const oldWrite = new Promise((_, reject) => { rejectOldWrite = reject; });
    const controller = new GroupRoomController({
      config: {
        maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
        heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
        replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
        sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
        ticketTTLms: 120_000, ticketTombstoneMaxItems: 256,
      },
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
      onEvent: (event) => events.push(event),
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "First Owner" });
    const firstRoomId = controller.roomId;
    const oldMember = {
      id: "M".repeat(22),
      code: "MEMBER",
      displayName: "Old Member",
      role: "member",
      status: "online",
      address: `tc${"b".repeat(64)}`,
      capabilities: {},
      sessionToken: "S".repeat(43),
      connection: { close() {} },
      reader: null,
      writer: { send: () => oldWrite, close() {} },
      streamEntry: null,
      deduper: { get() { return undefined; }, remember() {} },
      outstandingPings: new Set(),
      stalePings: new Set(),
      heartbeatFailures: 0,
      admissionSeq: 0,
      resumeAttempt: null,
      graceTimer: null,
      reconnectDeadline: 0,
      removed: false,
    };
    controller.members.set(oldMember.id, oldMember);
    controller.commitEvent({
      type: "TEXT",
      senderId: controller.ownerId,
      clientEventId: "E".repeat(22),
      text: "old room event",
    });

    await controller.close("REPLACE", { notify: false });
    controller.startOwner({ address: `tc${"c".repeat(64)}`, displayName: "Second Owner" });
    const secondRoomId = controller.roomId;
    events.length = 0;
    rejectOldWrite(new Error("late old-room send failure"));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const output = {
      roomReplaced: firstRoomId !== secondRoomId,
      sequence: controller.nextSeq,
      replay: controller.replay.after(0)?.length ?? -1,
      newEvents: events.length,
      oldMemberStatus: oldMember.status,
    };
    await controller.close("TEST", { notify: false });
    return output;
  });

  expect(result).toEqual({
    roomReplaced: true,
    sequence: 0,
    replay: 0,
    newEvents: 0,
    oldMemberStatus: "online",
  });
});

test("a late dial failure cannot evict or close a replacement transport at the same address", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const peerAddress = `tc${"b".repeat(64)}`;
    let connectCalls = 0;
    let oldCloses = 0;
    let replacementCloses = 0;
    let replacementDials = 0;
    let rejectOldDial;
    let signalOldDialStarted;
    const oldDialStarted = new Promise((resolve) => { signalOldDialStarted = resolve; });
    const oldTransport = {
      dial() {
        signalOldDialStarted();
        return new Promise((_, reject) => { rejectOldDial = reject; });
      },
      close() { oldCloses += 1; },
    };
    const replacementTransport = {
      async dial() {
        replacementDials += 1;
        return { close() {} };
      },
      close() { replacementCloses += 1; },
    };
    const controller = new GroupRoomController({
      config: {
        maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
        heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
        replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
        sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
        ticketTTLms: 120_000, ticketTombstoneMaxItems: 256,
      },
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => {
        connectCalls += 1;
        if (connectCalls === 1) return oldTransport;
        if (connectCalls === 2) return replacementTransport;
        throw new Error("replacement transport was unexpectedly evicted");
      },
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });

    const lateDial = controller.dial(peerAddress).then(
      () => "resolved",
      (error) => error.message,
    );
    await oldDialStarted;
    const oldEntry = controller.transports.get(peerAddress);
    const droppedOld = controller.dropTransport(peerAddress, oldEntry);
    const replacementEntry = controller.getTransport(peerAddress);
    const replacement = await replacementEntry;
    rejectOldDial(new Error("old dial failed late"));
    const lateOutcome = await lateDial;
    await Promise.resolve();

    const output = {
      lateOutcome,
      droppedOld,
      connectCalls,
      oldCloses,
      replacementCloses,
      replacementDials,
      replacementResolved: replacement === replacementTransport,
      replacementStillCached: controller.transports.get(peerAddress) === replacementEntry,
      lookupStillUsesReplacement: controller.getTransport(peerAddress) === replacementEntry,
    };
    await controller.close("TEST", { notify: false });
    return output;
  });

  expect(result).toEqual({
    lateOutcome: "old dial failed late",
    droppedOld: true,
    connectCalls: 2,
    oldCloses: 1,
    replacementCloses: 0,
    replacementDials: 0,
    replacementResolved: true,
    replacementStillCached: true,
    lookupStillUsesReplacement: true,
  });
});

test("late member text and join-cancel writes cannot touch replacement rooms", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const config = {
      maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
      heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
      replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
      sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
      ticketTTLms: 120_000, ticketTombstoneMaxItems: 256,
    };
    const makeController = () => new GroupRoomController({
      config,
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
    });
    const enterMemberState = (controller, suffix, writer, connection) => {
      controller.closed = false;
      controller.mode = "member";
      controller.roomId = suffix.repeat(22);
      controller.ownerId = "O".repeat(22);
      controller.memberId = "M".repeat(22);
      controller.sessionToken = suffix.repeat(43);
      controller.hostAddress = `tc${suffix.toLowerCase().repeat(64)}`;
      controller.localAddress = `tc${"l".repeat(64)}`;
      controller.writer = writer;
      controller.connection = connection;
    };

    let rejectOldText;
    let oldTextWrites = 0;
    const oldTextWriter = {
      closed: false,
      send() {
        oldTextWrites += 1;
        return new Promise((_, reject) => { rejectOldText = reject; });
      },
      close() { this.closed = true; },
    };
    const textController = makeController();
    enterMemberState(textController, "s", oldTextWriter, { close() {} });
    const oldText = textController.sendText("old room text", "E".repeat(22)).then(
      () => "resolved",
      (error) => error.message,
    );
    await Promise.resolve();
    await textController.close("REPLACE", { notify: false });
    textController.startOwner({ address: `tc${"n".repeat(64)}`, displayName: "New Text Owner" });
    const textRoomId = textController.roomId;
    let newTextConnectionCloses = 0;
    let newTextWriterCloses = 0;
    let newTextWrites = 0;
    const newTextConnection = { close() { newTextConnectionCloses += 1; } };
    const newTextWriter = {
      async send() { newTextWrites += 1; },
      close() { newTextWriterCloses += 1; },
    };
    textController.connection = newTextConnection;
    textController.writer = newTextWriter;
    rejectOldText(new Error("old text write failed late"));
    const oldTextOutcome = await oldText;
    await Promise.resolve();
    const textState = {
      oldTextOutcome,
      oldTextWrites,
      mode: textController.mode,
      roomUnchanged: textController.roomId === textRoomId,
      newConnectionIsCurrent: textController.connection === newTextConnection,
      newWriterIsCurrent: textController.writer === newTextWriter,
      newTextConnectionCloses,
      newTextWriterCloses,
      newTextWrites,
      sequence: textController.nextSeq,
      replay: textController.replay.after(0)?.length ?? -1,
      recovering: textController.recoveryActive,
    };
    await textController.close("TEST", { notify: false });

    let releaseOldCancel;
    let oldCancelWrites = 0;
    const oldCancelWriter = {
      send() {
        oldCancelWrites += 1;
        return new Promise((resolve) => { releaseOldCancel = resolve; });
      },
      close() {},
    };
    const cancelController = makeController();
    cancelController.closed = false;
    cancelController.mode = "pending";
    cancelController.roomId = "J".repeat(22);
    cancelController.currentJoin = { requestId: "R".repeat(22), clientNonce: "N".repeat(43) };
    cancelController.writer = oldCancelWriter;
    cancelController.connection = { close() {} };
    const oldCancel = cancelController.cancelJoin();
    await Promise.resolve();
    await cancelController.close("REPLACE", { notify: false });
    cancelController.startOwner({ address: `tc${"q".repeat(64)}`, displayName: "New Cancel Owner" });
    const cancelRoomId = cancelController.roomId;
    let newCancelConnectionCloses = 0;
    let newCancelWriterCloses = 0;
    let newCancelWrites = 0;
    const newCancelConnection = { close() { newCancelConnectionCloses += 1; } };
    const newCancelWriter = {
      async send() { newCancelWrites += 1; },
      close() { newCancelWriterCloses += 1; },
    };
    cancelController.connection = newCancelConnection;
    cancelController.writer = newCancelWriter;
    releaseOldCancel();
    const oldCancelOutcome = await oldCancel;
    await Promise.resolve();
    const cancelState = {
      oldCancelOutcome,
      oldCancelWrites,
      mode: cancelController.mode,
      roomUnchanged: cancelController.roomId === cancelRoomId,
      newConnectionIsCurrent: cancelController.connection === newCancelConnection,
      newWriterIsCurrent: cancelController.writer === newCancelWriter,
      newCancelConnectionCloses,
      newCancelWriterCloses,
      newCancelWrites,
      sequence: cancelController.nextSeq,
      replay: cancelController.replay.after(0)?.length ?? -1,
    };
    await cancelController.close("TEST", { notify: false });
    return { textState, cancelState };
  });

  expect(result).toEqual({
    textState: {
      oldTextOutcome: "old text write failed late",
      oldTextWrites: 1,
      mode: "owner",
      roomUnchanged: true,
      newConnectionIsCurrent: true,
      newWriterIsCurrent: true,
      newTextConnectionCloses: 0,
      newTextWriterCloses: 0,
      newTextWrites: 0,
      sequence: 0,
      replay: 0,
      recovering: false,
    },
    cancelState: {
      oldCancelOutcome: false,
      oldCancelWrites: 1,
      mode: "owner",
      roomUnchanged: true,
      newConnectionIsCurrent: true,
      newWriterIsCurrent: true,
      newCancelConnectionCloses: 0,
      newCancelWriterCloses: 0,
      newCancelWrites: 0,
      sequence: 0,
      replay: 0,
    },
  });
});

test("a late recovery dial cannot send replacement credentials or replace its connection", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    let resolveOldDial;
    let signalDialStarted;
    let transportCloses = 0;
    const dialStarted = new Promise((resolve) => { signalDialStarted = resolve; });
    const delayedConnection = {
      reads: 0,
      writes: [],
      closeWrites: 0,
      closes: 0,
      async read() { this.reads += 1; return null; },
      async write(bytes) { this.writes.push(bytes.slice()); },
      async closeWrite() { this.closeWrites += 1; },
      close() { this.closes += 1; },
    };
    const transport = {
      dial() {
        signalDialStarted();
        return new Promise((resolve) => { resolveOldDial = resolve; });
      },
      close() { transportCloses += 1; },
    };
    const controller = new GroupRoomController({
      config: {
        maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
        heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
        replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
        sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
        ticketTTLms: 120_000, ticketTombstoneMaxItems: 256,
      },
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => transport,
    });
    controller.closed = false;
    controller.mode = "member";
    controller.roomId = "A".repeat(22);
    controller.ownerId = "O".repeat(22);
    controller.memberId = "M".repeat(22);
    controller.sessionToken = "s".repeat(43);
    controller.hostAddress = `tc${"h".repeat(64)}`;
    controller.localAddress = `tc${"l".repeat(64)}`;
    controller.lastSeq = 7;
    controller.beginRecovery();
    await dialStarted;

    await controller.close("REPLACE", { notify: false });
    controller.closed = false;
    controller.mode = "member";
    controller.roomId = "B".repeat(22);
    controller.ownerId = "P".repeat(22);
    controller.memberId = "N".repeat(22);
    controller.sessionToken = "n".repeat(43);
    controller.hostAddress = `tc${"z".repeat(64)}`;
    controller.localAddress = `tc${"y".repeat(64)}`;
    controller.lastSeq = 3;
    let newConnectionCloses = 0;
    let newWriterCloses = 0;
    let newWrites = 0;
    const newConnection = { close() { newConnectionCloses += 1; } };
    const newReader = { async read() { throw new Error("new reader must remain untouched"); } };
    const newWriter = {
      closed: false,
      async send() { newWrites += 1; },
      close() { newWriterCloses += 1; },
    };
    controller.connection = newConnection;
    controller.reader = newReader;
    controller.writer = newWriter;
    const newRoomId = controller.roomId;
    const newSessionToken = controller.sessionToken;

    resolveOldDial(delayedConnection);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const output = {
      mode: controller.mode,
      roomUnchanged: controller.roomId === newRoomId,
      tokenUnchanged: controller.sessionToken === newSessionToken,
      connectionIsCurrent: controller.connection === newConnection,
      readerIsCurrent: controller.reader === newReader,
      writerIsCurrent: controller.writer === newWriter,
      recoveryActive: controller.recoveryActive,
      newConnectionCloses,
      newWriterCloses,
      newWrites,
      delayedReads: delayedConnection.reads,
      delayedWrites: delayedConnection.writes.length,
      delayedCloseWrites: delayedConnection.closeWrites,
      delayedCloses: delayedConnection.closes,
      transportCloses,
    };
    await controller.close("TEST", { notify: false });
    return output;
  });

  expect(result).toEqual({
    mode: "member",
    roomUnchanged: true,
    tokenUnchanged: true,
    connectionIsCurrent: true,
    readerIsCurrent: true,
    writerIsCurrent: true,
    recoveryActive: false,
    newConnectionCloses: 0,
    newWriterCloses: 0,
    newWrites: 0,
    delayedReads: 0,
    delayedWrites: 0,
    delayedCloseWrites: 0,
    delayedCloses: 1,
    transportCloses: 1,
  });
});

test("member capabilities use a fixed schema and keep a ten-person roster frame bounded", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const { encodeGroupFrame, GROUP_FRAME_MAX_BYTES } = await import("/group-protocol.js");
    const limits = { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 };
    const oversizedMime = `audio/${"x".repeat(129)}`;
    const injected = "z".repeat(160 * 1024);
    const hostileCapabilities = {
      injected,
      file: {
        protocol: "TCF1",
        receive: true,
        maxBytes: limits.fileBytes,
        injected,
      },
      voice: {
        enabled: true,
        maxBytes: limits.voiceBytes,
        playTypes: [
          " Audio/WebM;Codecs=Opus ",
          "audio/webm;codecs=opus",
          oversizedMime,
          "audio/\u0000evil",
          "not-a-mime",
          7,
          "audio/ogg",
          "video/webm",
          "audio/mpeg",
          ...Array.from({ length: 2_000 }, (_, index) => `audio/x-tail-${index}`),
        ],
        injected,
      },
    };
    const controller = new GroupRoomController({
      config: {
        maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
        heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
        replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
        sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
        ticketTTLms: 120_000, ticketTombstoneMaxItems: 256,
      },
      limits,
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => hostileCapabilities,
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    for (let index = 0; index < 9; index += 1) {
      const id = String.fromCharCode(66 + index).repeat(22);
      controller.members.set(id, {
        id,
        code: `M${index}`,
        displayName: `Member ${index}`,
        role: "member",
        status: "online",
        capabilities: hostileCapabilities,
      });
    }

    const roster = controller.publicRoster();
    const encoded = encodeGroupFrame({
      type: "JOIN_ACCEPT",
      gv: 1,
      roomId: controller.roomId,
      requestId: "R".repeat(22),
      memberId: "B".repeat(22),
      ownerId: controller.ownerId,
      sessionToken: "S".repeat(43),
      seq: 0,
      roster,
      heartbeatMs: 60_000,
    });
    const normalized = roster[1].capabilities;
    const output = {
      rosterSize: roster.length,
      topLevelKeys: Object.keys(normalized),
      fileKeys: Object.keys(normalized.file),
      voiceKeys: Object.keys(normalized.voice),
      playTypes: normalized.voice.playTypes,
      oversizedMimeDropped: !normalized.voice.playTypes.includes(oversizedMime),
      tailTypesDropped: !normalized.voice.playTypes.includes("audio/mpeg")
        && !normalized.voice.playTypes.some((value) => value.startsWith("audio/x-tail-")),
      rawCapabilitiesExceedFrameLimit: new TextEncoder().encode(JSON.stringify(hostileCapabilities)).length
        > GROUP_FRAME_MAX_BYTES,
      encodedBytes: encoded.length,
      maximumBytes: GROUP_FRAME_MAX_BYTES,
    };
    await controller.close("TEST", { notify: false });
    return output;
  });

  expect(result).toEqual({
    rosterSize: 10,
    topLevelKeys: ["file", "voice"],
    fileKeys: ["protocol", "receive", "maxBytes", "transports"],
    voiceKeys: ["enabled", "maxBytes", "playTypes"],
    playTypes: ["audio/webm;codecs=opus", "audio/ogg", "video/webm"],
    oversizedMimeDropped: true,
    tailTypesDropped: true,
    rawCapabilitiesExceedFrameLimit: true,
    encodedBytes: expect.any(Number),
    maximumBytes: 128 * 1024,
  });
  expect(result.encodedBytes).toBeLessThanOrEqual(result.maximumBytes);
});

test("a detached member stream cannot commit a late text frame", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    let releaseRead;
    let signalReadStarted;
    let reads = 0;
    const readStarted = new Promise((resolve) => { signalReadStarted = resolve; });
    const reader = {
      read() {
        reads += 1;
        if (reads === 1) {
          signalReadStarted();
          return new Promise((resolve) => { releaseRead = resolve; });
        }
        return Promise.resolve(null);
      },
    };
    const events = [];
    const controller = new GroupRoomController({
      config: {
        maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
        heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
        replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
        sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
        ticketTTLms: 120_000, ticketTombstoneMaxItems: 256,
      },
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
      onEvent: (event) => events.push(event),
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    const entry = {
      epoch: controller.lifecycleEpoch,
      roomId: controller.roomId,
      requestId: "R".repeat(22),
      connection: { close() {} },
      reader,
      writer: { async send() {}, close() {} },
      member: null,
      closed: false,
    };
    const member = {
      id: "M".repeat(22),
      code: "MEMBR1",
      displayName: "Member",
      role: "member",
      status: "online",
      address: `tc${"b".repeat(64)}`,
      capabilities: {},
      sessionToken: "S".repeat(43),
      connection: entry.connection,
      reader,
      writer: entry.writer,
      streamEntry: entry,
      deduper: { get() { return undefined; }, remember() {} },
      outstandingPings: new Set(),
      stalePings: new Set(),
      heartbeatFailures: 0,
      admissionSeq: 0,
      resumeAttempt: null,
      graceTimer: null,
      reconnectDeadline: 0,
      removed: false,
    };
    entry.member = member;
    controller.members.set(member.id, member);
    const loop = controller.ownerStreamLoop(entry);
    await readStarted;
    controller.markMemberReconnecting(member, "TEST_DISCONNECT");
    const sequenceAfterDetach = controller.nextSeq;
    releaseRead({
      type: "TEXT_SUBMIT",
      gv: 1,
      roomId: controller.roomId,
      clientEventId: "E".repeat(22),
      text: "must not be accepted from the detached stream",
    });
    await loop;
    const output = {
      memberStatus: member.status,
      entryClosed: entry.closed,
      streamDetached: member.streamEntry === null,
      sequenceAfterDetach,
      sequenceAfterLateRead: controller.nextSeq,
      committedTypes: events.map(({ type }) => type),
      staleTextCommitted: events.some(({ type }) => type === "TEXT"),
    };
    await controller.close("TEST", { notify: false });
    return output;
  });

  expect(result).toEqual({
    memberStatus: "reconnecting",
    entryClosed: true,
    streamDetached: true,
    sequenceAfterDetach: 1,
    sequenceAfterLateRead: 1,
    committedTypes: ["MEMBER_STATE"],
    staleTextCommitted: false,
  });
});

test("a stale address verification cannot evict a replacement-room transport", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    let connectCalls = 0;
    let resolveOldDial;
    let signalOldDialStarted;
    let oldTransportCloses = 0;
    let oldConnectionCloses = 0;
    let replacementCloses = 0;
    const oldDialStarted = new Promise((resolve) => { signalOldDialStarted = resolve; });
    const oldTransport = {
      dial() {
        signalOldDialStarted();
        return new Promise((resolve) => { resolveOldDial = resolve; });
      },
      close() { oldTransportCloses += 1; },
    };
    const replacementTransport = {
      async dial() { return { close() {} }; },
      close() { replacementCloses += 1; },
    };
    const controller = new GroupRoomController({
      config: {
        maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
        heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
        replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
        sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
        ticketTTLms: 120_000, ticketTombstoneMaxItems: 256,
      },
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => {
        connectCalls += 1;
        return connectCalls === 1 ? oldTransport : replacementTransport;
      },
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    const guestAddress = `tc${"b".repeat(64)}`;
    const entry = {
      epoch: controller.lifecycleEpoch,
      roomId: controller.roomId,
      requestId: "R".repeat(22),
      clientNonce: "N".repeat(43),
      address: guestAddress,
      displayName: "Guest",
      code: "GUEST1",
      capabilities: {},
      expiresAt: Date.now() + 60_000,
      state: "approving",
      member: null,
      closed: false,
      cancelReason: "",
      cancelSignal: { resolve() {} },
      timer: null,
      verificationConnection: null,
      connection: { close() {} },
      reader: { async read() { return null; } },
      writer: { async send() {}, async closeWrite() {}, close() {} },
    };
    controller.pending.set(entry.requestId, entry);
    const verification = controller.verifyAddress(entry).then(
      () => "resolved",
      (error) => error.message,
    );
    await oldDialStarted;

    await controller.close("REPLACE", { notify: false });
    controller.startOwner({ address: `tc${"c".repeat(64)}`, displayName: "Replacement owner" });
    const replacementEntry = controller.getTransport(guestAddress);
    await replacementEntry;
    resolveOldDial({ close() { oldConnectionCloses += 1; } });
    const verificationOutcome = await verification;
    await Promise.resolve();
    const output = {
      verificationOutcome,
      connectCalls,
      oldTransportCloses,
      oldConnectionCloses,
      replacementCloses,
      replacementStillCached: controller.transports.get(guestAddress) === replacementEntry,
      lookupStillUsesReplacement: controller.getTransport(guestAddress) === replacementEntry,
    };
    await controller.close("TEST", { notify: false });
    return output;
  });

  expect(result).toEqual({
    verificationOutcome: "stale address verification",
    connectCalls: 2,
    oldTransportCloses: 1,
    oldConnectionCloses: 1,
    replacementCloses: 0,
    replacementStillCached: true,
    lookupStillUsesReplacement: true,
  });
});
