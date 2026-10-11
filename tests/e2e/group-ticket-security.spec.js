import { expect, test } from "@playwright/test";

test("a 100 by 9 manifest issues one fresh target grant below the frame limit", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const { encodeGroupFrame } = await import("/group-protocol.js");
    const ticketTTLms = 120_000;
    let now = 5_000;
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
      ticketTTLms,
      maxOutstandingTicketsPerMember: 4,
      ticketControlTimeoutMs: 1_000,
    };
    const limits = { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 };
    const fileCapabilities = {
      file: { protocol: "TCF1", receive: true, maxBytes: limits.fileBytes },
      voice: { enabled: true, maxBytes: limits.voiceBytes, playTypes: [] },
    };
    const controller = new GroupRoomController({
      config,
      limits,
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => fileCapabilities,
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
      now: () => now,
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });

    const recipientIds = [];
    let armCount = 0;
    for (let index = 0; index < 9; index += 1) {
      const memberId = `${"M".repeat(21)}${index}`;
      const member = {
        id: memberId,
        code: `M${index}`,
        displayName: `Member ${index}`,
        role: "member",
        status: "online",
        address: `tc${String.fromCharCode(98 + index).repeat(64)}`,
        capabilities: fileCapabilities,
        sessionToken: `${"S".repeat(42)}${index}`,
        connection: null,
        reader: null,
        writer: {
          async send(frame) {
            if (frame.type !== "TRANSFER_ARM") return;
            armCount += 1;
            controller.resolveTicketArm(member, {
              type: "TRANSFER_ARMED",
              gv: 1,
              roomId: controller.roomId,
              ticket: frame.ticket,
              ticketSenderId: frame.senderId,
              ticketRecipientId: frame.recipientId,
              transferId: frame.transferId,
            });
          },
          close() {},
        },
        streamEntry: null,
        deduper: { get() { return undefined; }, remember() {} },
        outstandingPings: new Set(),
        admissionSeq: 0,
        resumeAttempt: null,
        graceTimer: null,
        reconnectDeadline: 0,
        removed: false,
      };
      controller.members.set(memberId, member);
      recipientIds.push(memberId);
    }

    const items = Array.from({ length: 100 }, (_, index) => ({
      transferId: index.toString(16).padStart(32, "0"),
      size: 1,
    }));
    now += ticketTTLms + 1;
    const requestedAt = now;
    const response = await controller.requestTransferTickets({
      kind: "file",
      items,
      recipientIds,
      targetTransferId: items[99].transferId,
      targetRecipientId: recipientIds[8],
    });
    const encoded = encodeGroupFrame({
      type: "TRANSFER_TICKET_RESPONSE",
      gv: 1,
      roomId: controller.roomId,
      requestId: "R".repeat(22),
      ...response,
    });
    const output = {
      grants: response.grants.length,
      failures: response.failures.length,
      targetTransferId: response.grants[0]?.transferId,
      targetRecipientId: response.grants[0]?.recipientId,
      expiresAt: response.grants[0]?.expiresAt,
      expectedExpiry: requestedAt + ticketTTLms,
      encodedBytes: encoded.length,
      armCount,
      issuedCount: controller.issuedTickets.size,
    };
    await controller.close("TEST", { notify: false });
    return output;
  });

  expect(result.grants).toBe(1);
  expect(result.failures).toBeLessThanOrEqual(1);
  expect(result.grants + result.failures).toBe(1);
  expect(result.targetTransferId).toBe((99).toString(16).padStart(32, "0"));
  expect(result.targetRecipientId).toBe(`${"M".repeat(21)}8`);
  expect(result.expiresAt).toBe(result.expectedExpiry);
  expect(result.encodedBytes).toBeLessThan(128 * 1024);
  expect(result.armCount).toBe(1);
  expect(result.issuedCount).toBe(1);
});

test("ticket binding rejects wrong room, type, recipient, transfer, size, and replay", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    let now = 10_000;
    const config = {
      maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
      heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
      replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
      sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
      ticketTTLms: 120_000, maxOutstandingTicketsPerMember: 4, ticketControlTimeoutMs: 1_000,
    };
    const limits = { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 };
    const controller = new GroupRoomController({
      config,
      limits,
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({ file: { protocol: "TCF1", receive: true, maxBytes: limits.fileBytes } }),
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
      now: () => now,
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    const sender = {
      id: "B".repeat(22),
      code: "SENDER",
      displayName: "Sender",
      role: "member",
      status: "online",
      address: `tc${"b".repeat(64)}`,
      capabilities: {},
      writer: { async send() {}, close() {} },
      outstandingPings: new Set(),
      removed: false,
    };
    controller.members.set(sender.id, sender);
    const transferId = "1".repeat(32);
    const response = await controller.issueTransferTickets(sender, {
      type: "TRANSFER_TICKET_REQUEST",
      gv: 1,
      roomId: controller.roomId,
      requestId: "Q".repeat(22),
      kind: "file",
      items: [{ transferId, size: 42 }],
      recipientIds: [controller.ownerId],
      targetTransferId: transferId,
      targetRecipientId: controller.ownerId,
    });
    const grant = response.grants[0];
    const rejected = {};
    const attempt = async (name, meta, kind, size) => {
      try {
        await controller.consumeTransferTicket(meta, kind, size);
        rejected[name] = false;
      } catch (_) {
        rejected[name] = true;
      }
    };
    await attempt("room", { ...grant, roomId: "Z".repeat(22) }, "file", 42);
    await attempt("type", { ...grant, kind: "voice" }, "voice", 42);
    await attempt("recipient", { ...grant, recipientId: "Z".repeat(22) }, "file", 42);
    await attempt("transfer", { ...grant, transferId: "2".repeat(32) }, "file", 42);
    await attempt("size", { ...grant, size: 43 }, "file", 43);
    const accepted = await controller.consumeTransferTicket(grant, "file", 42);
    await attempt("replay", grant, "file", 42);
    const output = {
      rejected,
      acceptedTicket: accepted.ticket,
      localTicketGone: !controller.tickets.has(grant.ticket),
      authorityTicketGone: !controller.issuedTickets.has(grant.ticket),
    };
    await controller.close("TEST", { notify: false });
    return output;
  });

  expect(result.rejected).toEqual({
    room: true,
    type: true,
    recipient: true,
    transfer: true,
    size: true,
    replay: true,
  });
  expect(result.acceptedTicket).toHaveLength(43);
  expect(result.localTicketGone).toBe(true);
  expect(result.authorityTicketGone).toBe(true);
});

test("a member receiver must obtain live owner validation after authority revocation", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const config = {
      maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
      heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
      replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
      sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
      ticketTTLms: 120_000, maxOutstandingTicketsPerMember: 4, ticketControlTimeoutMs: 1_000,
    };
    const limits = { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 };
    const validAddress = (value) => /^tc[a-z0-9]{64}$/u.test(value);
    const capabilities = {
      file: { protocol: "TCF1", receive: true, maxBytes: limits.fileBytes },
      voice: { enabled: true, maxBytes: limits.voiceBytes, playTypes: [] },
    };
    const options = {
      config,
      limits,
      validAddress,
      capabilities: () => capabilities,
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
    };
    const owner = new GroupRoomController(options);
    owner.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    const receiver = new GroupRoomController(options);
    receiver.mode = "member";
    receiver.roomId = owner.roomId;
    receiver.ownerId = owner.ownerId;
    receiver.memberId = "C".repeat(22);
    receiver.hostAddress = owner.hostAddress;
    receiver.localAddress = `tc${"c".repeat(64)}`;
    receiver.members.set(owner.ownerId, {
      id: owner.ownerId,
      code: "OWNER1",
      displayName: "Owner",
      role: "owner",
      status: "online",
      capabilities,
    });
    receiver.members.set(receiver.memberId, {
      id: receiver.memberId,
      code: "MEMBER",
      displayName: "Receiver",
      role: "member",
      status: "online",
      capabilities,
    });

    let consumeRequests = 0;
    const ownerMember = {
      id: receiver.memberId,
      code: "MEMBER",
      displayName: "Receiver",
      role: "member",
      status: "online",
      address: receiver.localAddress,
      capabilities,
      sessionToken: "S".repeat(43),
      connection: null,
      reader: null,
      writer: {
        async send(frame) { await receiver.handleOwnerFrame(frame); },
        close() {},
      },
      streamEntry: null,
      deduper: { get() { return undefined; }, remember() {} },
      outstandingPings: new Set(),
      admissionSeq: 0,
      resumeAttempt: null,
      graceTimer: null,
      reconnectDeadline: 0,
      removed: false,
    };
    owner.members.set(ownerMember.id, ownerMember);
    receiver.writer = {
      async send(frame) {
        if (frame.type === "TRANSFER_CONSUME_REQUEST") consumeRequests += 1;
        await owner.handleMemberFrame(ownerMember, frame);
      },
      close() {},
    };

    const transferId = "3".repeat(32);
    const response = await owner.requestTransferTickets({
      kind: "file",
      items: [{ transferId, size: 64 }],
      recipientIds: [receiver.memberId],
      targetTransferId: transferId,
      targetRecipientId: receiver.memberId,
    });
    const grant = response.grants[0];
    const armedLocally = receiver.tickets.has(grant.ticket);
    const issuedBeforeRevocation = owner.issuedTickets.has(grant.ticket);

    // Simulate removal reaching the authority before its notification reaches
    // the receiver. The stale local ticket must still fail online validation.
    owner.invalidateMemberTickets(receiver.memberId);
    owner.members.delete(receiver.memberId);
    const staleTicketStillLocal = receiver.tickets.has(grant.ticket);
    let rejected = false;
    try {
      await receiver.consumeTransferTicket(grant, "file", 64);
    } catch (_) {
      rejected = true;
    }
    const output = {
      armedLocally,
      issuedBeforeRevocation,
      authorityRevoked: !owner.issuedTickets.has(grant.ticket),
      staleTicketStillLocal,
      consumeRequests,
      rejected,
      staleTicketDiscarded: !receiver.tickets.has(grant.ticket),
    };
    await receiver.close("TEST", { notify: false });
    await owner.close("TEST", { notify: false });
    return output;
  });

  expect(result).toEqual({
    armedLocally: true,
    issuedBeforeRevocation: true,
    authorityRevoked: true,
    staleTicketStillLocal: true,
    consumeRequests: 1,
    rejected: true,
    staleTicketDiscarded: true,
  });
});

test("the authority enforces the per-sender outstanding ticket cap", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const config = {
      maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
      heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
      replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
      sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
      ticketTTLms: 120_000, maxOutstandingTicketsPerMember: 2, ticketControlTimeoutMs: 1_000,
    };
    const limits = { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 };
    const capabilities = { file: { protocol: "TCF1", receive: true, maxBytes: limits.fileBytes } };
    const controller = new GroupRoomController({
      config,
      limits,
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => capabilities,
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    const recipientIds = [];
    for (let index = 0; index < 3; index += 1) {
      const memberId = `${"D".repeat(21)}${index}`;
      const member = {
        id: memberId,
        code: `R${index}`,
        displayName: `Receiver ${index}`,
        role: "member",
        status: "online",
        address: `tc${String.fromCharCode(98 + index).repeat(64)}`,
        capabilities,
        writer: {
          async send(frame) {
            if (frame.type === "TRANSFER_ARM") controller.resolveTicketArm(member, {
              type: "TRANSFER_ARMED",
              gv: 1,
              roomId: controller.roomId,
              ticket: frame.ticket,
              ticketSenderId: frame.senderId,
              ticketRecipientId: frame.recipientId,
              transferId: frame.transferId,
            });
          },
          close() {},
        },
        outstandingPings: new Set(),
        removed: false,
      };
      controller.members.set(member.id, member);
      recipientIds.push(member.id);
    }
    const responses = [];
    for (let index = 0; index < 3; index += 1) {
      const transferId = String(index + 4).repeat(32);
      responses.push(await controller.requestTransferTickets({
        kind: "file",
        items: [{ transferId, size: 1 }],
        recipientIds: [recipientIds[index]],
        targetTransferId: transferId,
        targetRecipientId: recipientIds[index],
      }));
    }
    const output = {
      grants: responses.map((response) => response.grants.length),
      failures: responses.map((response) => response.failures.map(({ reason }) => reason)),
      issuedCount: controller.issuedTickets.size,
    };
    await controller.close("TEST", { notify: false });
    return output;
  });

  expect(result).toEqual({
    grants: [1, 1, 0],
    failures: [[], [], ["BUSY"]],
    issuedCount: 2,
  });
});

test("a wrong member cannot acknowledge an already-spent transfer arm", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { GroupRoomController } = await import("/group-room.js");
    const controller = new GroupRoomController({
      config: {
        maxMembers: 10, maxPendingJoins: 9, joinRequestTTLms: 60_000, reconnectGraceMs: 120_000,
        heartbeatIntervalMs: 60_000, heartbeatFailureLimit: 2, replayMaxItems: 100,
        replayMaxBytes: 8 * 1024 * 1024, dedupeMaxItems: 256, sendQueueMaxFrames: 64,
        sendQueueMaxBytes: 1024 * 1024, maxBatchBytes: 1024 ** 3, maxParallelRecipients: 2,
        ticketTTLms: 120_000, ticketTombstoneMaxItems: 256, ticketControlTimeoutMs: 1_000,
      },
      limits: { textBytes: 65_536, fileBytes: 1024 ** 3, voiceBytes: 10 * 1024 ** 2 },
      validAddress: (value) => /^tc[a-z0-9]{64}$/u.test(value),
      capabilities: () => ({}),
      connect: async () => ({ dial: async () => { throw new Error("unused"); }, close() {} }),
    });
    controller.startOwner({ address: `tc${"a".repeat(64)}`, displayName: "Owner" });
    const makeMember = (id, address) => ({
      id,
      code: id.slice(0, 6),
      displayName: id === "A".repeat(22) ? "Intended recipient" : "Wrong member",
      role: "member",
      status: "online",
      address,
      capabilities: {},
      sessionToken: "S".repeat(43),
      connection: { close() {} },
      reader: null,
      writer: { async send() {}, close() {} },
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
    });
    const intendedRecipient = makeMember("A".repeat(22), `tc${"b".repeat(64)}`);
    const wrongMember = makeMember("B".repeat(22), `tc${"c".repeat(64)}`);
    controller.members.set(intendedRecipient.id, intendedRecipient);
    controller.members.set(wrongMember.id, wrongMember);

    const ticket = "T".repeat(43);
    controller.rememberSpentTicket(ticket);
    let rejected = false;
    try {
      await controller.handleMemberFrame(wrongMember, {
        type: "TRANSFER_ARMED",
        gv: 1,
        roomId: controller.roomId,
        ticket,
        ticketSenderId: controller.ownerId,
        ticketRecipientId: intendedRecipient.id,
        transferId: "f".repeat(32),
      });
    } catch (_) {
      rejected = true;
    }
    const output = {
      rejected,
      ticketRemainsSpent: controller.spentTickets.has(ticket),
      armWaiters: controller.ticketArmWaiters.size,
    };
    await controller.close("TEST", { notify: false });
    return output;
  });

  expect(result).toEqual({ rejected: true, ticketRemainsSpent: true, armWaiters: 0 });
});
