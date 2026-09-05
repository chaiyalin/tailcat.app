// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

import {
  GROUP_PROTOCOL_VERSION,
  GroupFrameReader,
  GroupFrameWriter,
  GroupReplayBuffer,
  RecentEventDeduper,
  groupBatchBytes,
  normalizeGroupDisplayName,
  randomBase64URL,
  validBase64URL,
} from "./group-protocol.js";

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 30_000;

function noop() {}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, milliseconds, message, onTimeout = noop) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error(message));
      }, milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function safeClose(connection) {
  try {
    connection?.close();
  } catch (_) {
    // Closing is best effort during teardown.
  }
}

function publicCapabilities(capabilities) {
  const playTypes = [];
  if (Array.isArray(capabilities?.voice?.playTypes)) {
    for (const candidate of capabilities.voice.playTypes.slice(0, 8)) {
      if (typeof candidate !== "string") continue;
      const mime = candidate.trim().toLowerCase();
      if (!mime
        || mime.length > 128
        || /[\u0000-\u001f\u007f]/u.test(mime)
        || !mime.includes("/")) continue;
      if (!playTypes.includes(mime)) playTypes.push(mime);
    }
  }
  const fileMaxBytes = Number.isSafeInteger(capabilities?.file?.maxBytes)
    && capabilities.file.maxBytes >= 0
    ? capabilities.file.maxBytes
    : 0;
  const voiceMaxBytes = Number.isSafeInteger(capabilities?.voice?.maxBytes)
    && capabilities.voice.maxBytes >= 0
    ? capabilities.voice.maxBytes
    : 0;
  return Object.freeze({
    file: Object.freeze({
      protocol: capabilities?.file?.protocol === "TCF1" ? "TCF1" : "",
      receive: capabilities?.file?.receive === true,
      maxBytes: fileMaxBytes,
      transports: Object.freeze(Array.isArray(capabilities?.file?.transports)
        ? ["tailcat", "webrtc-dc-v1"].filter((value) => capabilities.file.transports.includes(value))
        : ["tailcat"]),
    }),
    voice: Object.freeze({
      enabled: capabilities?.voice?.enabled === true,
      maxBytes: voiceMaxBytes,
      playTypes: Object.freeze(playTypes),
    }),
  });
}

function publicMember(member) {
  return Object.freeze({
    id: member.id,
    code: member.code,
    displayName: member.displayName,
    role: member.role,
    status: member.status,
    capabilities: publicCapabilities(member.capabilities),
  });
}

function validID(value, bytes) {
  return validBase64URL(value, bytes);
}

function validEventID(value) {
  return validID(value, 16);
}

function validTransferID(value) {
  return validEventID(value) || (typeof value === "string" && /^[0-9a-f]{32}$/u.test(value));
}

function validCapabilities(value) {
  return publicCapabilities(value && typeof value === "object" && !Array.isArray(value) ? value : {});
}

function normalizeItems(items, kind, limits) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error("invalid group transfer items");
  const maximum = kind === "file" ? limits.fileBytes : limits.voiceBytes;
  const normalized = items.map((item) => {
    const transferId = item?.transferId;
    const size = Number(item?.size);
    if (!validTransferID(transferId) || !Number.isSafeInteger(size) || size < 0 || size > maximum) {
      throw new Error("invalid group transfer item");
    }
    return Object.freeze({ transferId, size });
  });
  if (new Set(normalized.map(({ transferId }) => transferId)).size !== normalized.length) {
    throw new Error("duplicate group transfer item");
  }
  return normalized;
}

function isExpectedIdentity(frame, memberID) {
  return (frame.senderId === undefined || frame.senderId === memberID)
    && (frame.memberId === undefined || frame.memberId === memberID);
}

/**
 * The GroupRoomController owns only in-memory Group Beta state. It deliberately
 * does not persist room, member, invitation, ticket, or message data.
 */
export class GroupRoomController {
  constructor({
    config,
    appVersion = 1,
    port = 104,
    limits,
    validAddress,
    capabilities,
    connect,
    now = () => Date.now(),
    onState = noop,
    onPending = noop,
    onEvent = noop,
    onStatus = noop,
    onClosed = noop,
  }) {
    if (!config || typeof connect !== "function" || typeof validAddress !== "function") {
      throw new Error("incomplete group room controller options");
    }
    this.config = config;
    this.appVersion = appVersion;
    this.port = port;
    this.limits = limits;
    this.validAddress = validAddress;
    this.capabilities = capabilities;
    this.connect = connect;
    this.now = now;
    this.callbacks = { onState, onPending, onEvent, onStatus, onClosed };
    this.transports = new Map();
    this.memberTransportAddresses = new Map();
    this.mode = "none";
    this.closed = false;
    this.lifecycleEpoch = 0;
    this.resetState();
  }

  resetState() {
    // Every room/join lifecycle gets a distinct epoch. Async work from a
    // closed room may still settle later, but it must never read credentials
    // from, write through, or mutate the replacement room.
    this.lifecycleEpoch += 1;
    this.memberTransportAddresses.clear();
    this.roomId = "";
    this.joinToken = "";
    this.hostAddress = "";
    this.localAddress = "";
    this.ownerId = "";
    this.memberId = "";
    this.sessionToken = "";
    this.displayName = "";
    this.members = new Map();
    this.pending = new Map();
    this.tickets = new Map();
    this.issuedTickets = new Map();
    this.spentTickets = new Map();
    this.ticketWaiters = new Map();
    this.ticketArmWaiters = new Map();
    this.ticketConsumeWaiters = new Map();
    this.consumingTickets = new Set();
    this.cancelledTicketRequests = new Map();
    this.pendingEvents = new Map();
    this.pendingEventSizes = new Map();
    this.pendingEventBytes = 0;
    this.joinPolicyGeneration = 0;
    this.nextSeq = 0;
    this.lastSeq = 0;
    this.replay = new GroupReplayBuffer({
      maxItems: this.config.replayMaxItems,
      maxBytes: this.config.replayMaxBytes,
    });
    this.connection = null;
    this.reader = null;
    this.writer = null;
    this.currentJoin = null;
    this.joinOutcome = null;
    this.joinsPaused = false;
    this.roomPaused = false;
    this.pauseReason = "";
    this.heartbeatTimer = null;
    this.ownerWatchdog = null;
    this.recoveryTimer = null;
    this.recoveryExpiryTimer = null;
    this.recoveryActive = false;
    this.recoveryDeadline = 0;
    this.lastOwnerPingAt = 0;
    this.closing = false;
  }

  get active() {
    return this.mode !== "none";
  }

  get isOwner() {
    return this.mode === "owner";
  }

  get canSend() {
    if (this.closing || this.roomPaused) return false;
    if (this.mode === "owner") return true;
    return this.mode === "member" && !this.recoveryActive && Boolean(this.writer) && !this.writer.closed;
  }

  snapshot() {
    return Object.freeze({
      mode: this.mode,
      roomId: this.roomId,
      hostAddress: this.hostAddress,
      ownerId: this.ownerId,
      memberId: this.memberId,
      joinsPaused: this.joinsPaused,
      roomPaused: this.roomPaused,
      pauseReason: this.pauseReason,
      sequence: this.mode === "owner" ? this.nextSeq : this.lastSeq,
      members: [...this.members.values()].map(publicMember),
      pending: this.mode === "owner" ? [...this.pending.values()].map((entry) => Object.freeze({
        requestId: entry.requestId,
        code: entry.code,
        displayName: entry.displayName,
        expiresAt: entry.expiresAt,
        state: entry.state,
      })) : [],
    });
  }

  emitState() {
    this.callbacks.onState(this.snapshot());
    if (this.mode === "owner") this.callbacks.onPending(this.snapshot().pending);
  }

  status(code, detail = {}) {
    this.callbacks.onStatus(code, detail);
  }

  getTransport(address) {
    if (!this.validAddress(address)) throw new Error("invalid Tailcat address");
    let pending = this.transports.get(address);
    if (!pending) {
      const controller = new AbortController();
      pending = Promise.resolve(this.connect({ addr: address, signal: controller.signal })).catch((error) => {
        if (this.transports.get(address) === pending) this.transports.delete(address);
        throw error;
      });
      pending.abortController = controller;
      this.transports.set(address, pending);
    }
    return pending;
  }

  async dial(address) {
    // Keep the exact cache entry that supplied this transport. A late failure
    // from an older dial must not evict a replacement transport for the same
    // address that a newer room or recovery attempt has already installed.
    const pending = this.getTransport(address);
    const transport = await pending;
    try {
      return await transport.dial({ port: this.port });
    } catch (error) {
      this.dropTransport(address, pending);
      throw error;
    }
  }

  dropTransport(address, expected = null) {
    const pending = this.transports.get(address);
    if (!pending || (expected && pending !== expected)) return false;
    this.transports.delete(address);
    pending?.abortController?.abort();
    Promise.resolve(pending).then((transport) => transport?.close(), noop);
    return true;
  }

  closeTransports() {
    for (const address of this.transports.keys()) this.dropTransport(address);
  }

  startOwner({ address, displayName }) {
    if (this.active) throw new Error("a room is already active");
    if (!this.validAddress(address)) throw new Error("invalid local Tailcat address");
    this.resetState();
    this.closed = false;
    this.mode = "owner";
    this.roomId = randomBase64URL(16);
    this.joinToken = randomBase64URL(32);
    this.hostAddress = address;
    this.localAddress = address;
    this.ownerId = randomBase64URL(16);
    this.memberId = this.ownerId;
    this.displayName = displayName;
    this.members.set(this.ownerId, {
      id: this.ownerId,
      code: randomBase64URL(4).slice(0, 6).toUpperCase(),
      displayName,
      role: "owner",
      status: "online",
      address,
      capabilities: validCapabilities(this.capabilities()),
      sessionToken: "",
      connection: null,
      reader: null,
      writer: null,
      streamEntry: null,
      deduper: new RecentEventDeduper(this.config.dedupeMaxItems),
      outstandingPings: new Set(),
      stalePings: new Set(),
      heartbeatFailures: 0,
      admissionSeq: 0,
      resumeAttempt: null,
      graceTimer: null,
      reconnectDeadline: 0,
      removed: false,
    });
    this.startOwnerHeartbeat();
    this.emitState();
    this.status("OWNER_READY");
    return this.snapshot();
  }

  async requestJoin({ invite, address, displayName }) {
    if (this.active) throw new Error("a room is already active");
    if (!invite || !this.validAddress(invite.address) || !this.validAddress(address)) {
      throw new Error("invalid group invitation");
    }
    this.resetState();
    this.closed = false;
    this.mode = "pending";
    this.roomId = invite.roomId;
    this.joinToken = invite.joinToken;
    this.hostAddress = invite.address;
    this.localAddress = address;
    this.displayName = displayName;
    const requestId = randomBase64URL(16);
    const clientNonce = randomBase64URL(32);
    const epoch = this.lifecycleEpoch;
    const roomId = this.roomId;
    const joinToken = this.joinToken;
    const hostAddress = this.hostAddress;
    const localAddress = this.localAddress;
    this.currentJoin = { requestId, clientNonce };
    this.joinOutcome = deferred();
    const outcome = this.joinOutcome;
    this.emitState();
    this.status("JOIN_CONNECTING");

    let connection = null;
    let reader = null;
    let writer = null;
    try {
      connection = await this.dial(hostAddress);
      if (this.lifecycleEpoch !== epoch
        || this.mode !== "pending"
        || this.roomId !== roomId
        || this.currentJoin?.requestId !== requestId) {
        safeClose(connection);
        throw new Error("join request cancelled");
      }
      this.connection = connection;
      reader = new GroupFrameReader(connection);
      writer = new GroupFrameWriter(connection, this.writerOptions());
      this.reader = reader;
      this.writer = writer;
      await writer.send({
        type: "JOIN_REQUEST",
        gv: GROUP_PROTOCOL_VERSION,
        roomId,
        joinToken,
        requestId,
        clientNonce,
        replyTo: localAddress,
        displayName,
        capabilities: validCapabilities(this.capabilities()),
      });
      if (this.lifecycleEpoch !== epoch
        || this.mode !== "pending"
        || this.roomId !== roomId
        || this.connection !== connection
        || this.reader !== reader
        || this.writer !== writer
        || this.currentJoin?.requestId !== requestId) {
        throw new Error("join request cancelled");
      }
      this.status("JOIN_PENDING");
      void this.guestLoop(connection, requestId, epoch, reader);
    } catch (error) {
      writer?.close();
      safeClose(connection);
      if (this.lifecycleEpoch !== epoch) {
        outcome.reject(error);
        return outcome.promise;
      }
      this.finishJoin(error);
      // No control stream exists to clean this attempt up later. close() has
      // no notification writes for a pending guest, so its state/transport
      // teardown runs synchronously before this method returns.
      void this.close("JOIN_FAILED", { notify: false });
    }
    return outcome.promise;
  }

  writerOptions() {
    return {
      maxFrames: this.config.sendQueueMaxFrames,
      maxBytes: this.config.sendQueueMaxBytes,
    };
  }

  async handleIncoming(connection) {
    const epoch = this.lifecycleEpoch;
    const roomId = this.roomId;
    const reader = new GroupFrameReader(connection);
    let first;
    try {
      first = await withTimeout(
        reader.read(),
        DEFAULT_FIRST_FRAME_TIMEOUT_MS,
        "group handshake timed out",
        () => safeClose(connection),
      );
      if (this.lifecycleEpoch !== epoch || this.roomId !== roomId) {
        throw new Error("stale group listener connection");
      }
      if (!first) throw new Error("empty group stream");
      if (this.mode === "owner" && first.type === "JOIN_REQUEST") {
        return await this.acceptJoinRequest(connection, reader, first);
      }
      if (this.mode === "owner" && first.type === "RESUME_REQUEST") {
        return await this.acceptResume(connection, reader, first);
      }
      if ((this.mode === "pending" || this.mode === "member") && first.type === "ADDRESS_CHALLENGE") {
        return await this.answerAddressChallenge(connection, reader, first);
      }
      throw new Error("unexpected group stream");
    } catch (error) {
      safeClose(connection);
      throw error;
    }
  }

  validateBaseFrame(frame) {
    return frame?.gv === GROUP_PROTOCOL_VERSION && frame.roomId === this.roomId;
  }

  async rejectFreshConnection(connection, reason, requestId = "") {
    const writer = new GroupFrameWriter(connection, this.writerOptions());
    try {
      await withTimeout((async () => {
        await writer.send({
          type: "JOIN_REJECT",
          gv: GROUP_PROTOCOL_VERSION,
          roomId: this.roomId,
          requestId,
          reason,
        });
        await writer.closeWrite();
      })(), 750, "join rejection timed out", () => safeClose(connection));
    } catch (_) {
      // Rejection is best effort; closing the stream is also terminal.
    } finally {
      writer.close();
    }
  }

  async acceptJoinRequest(connection, reader, frame) {
    const epoch = this.lifecycleEpoch;
    const roomId = this.roomId;
    const requestId = frame?.requestId;
    let safeDisplayName = "";
    try {
      safeDisplayName = normalizeGroupDisplayName(frame?.displayName);
    } catch (_) {
      safeDisplayName = "";
    }
    const structurallyValid = this.validateBaseFrame(frame)
      && frame.joinToken === this.joinToken
      && validEventID(requestId)
      && validID(frame.clientNonce, 32)
      && this.validAddress(frame.replyTo)
      && safeDisplayName === frame.displayName;
    let reason = "INVALID";
    if (!structurallyValid) reason = frame?.joinToken === this.joinToken ? "INVALID" : "INVITE_INVALID";
    else if (this.roomPaused || this.joinsPaused) reason = "PAUSED";
    else if (this.members.size >= this.config.maxMembers) reason = "FULL";
    else if (this.pending.size >= this.config.maxPendingJoins) reason = "BUSY";
    else if (this.pending.has(requestId)) reason = "DUPLICATE";
    else reason = "";
    if (reason) {
      await this.rejectFreshConnection(connection, reason, validEventID(requestId) ? requestId : "");
      return;
    }

    const writer = new GroupFrameWriter(connection, this.writerOptions());
    const expiresAt = this.now() + this.config.joinRequestTTLms;
    const entry = {
      epoch,
      roomId,
      requestId,
      clientNonce: frame.clientNonce,
      address: frame.replyTo,
      displayName: safeDisplayName,
      code: randomBase64URL(4).slice(0, 6).toUpperCase(),
      capabilities: validCapabilities(frame.capabilities),
      expiresAt,
      state: "pending",
      connection,
      reader,
      writer,
      member: null,
      closed: false,
      cancelReason: "",
      cancelSignal: deferred(),
      verificationConnection: null,
      timer: null,
    };
    this.pending.set(requestId, entry);
    entry.timer = setTimeout(() => {
      if (this.lifecycleEpoch === epoch && this.pending.get(requestId) === entry) {
        void this.rejectPending(requestId, "EXPIRED");
      }
    }, this.config.joinRequestTTLms);
    this.emitState();
    this.status("JOIN_REQUESTED", { requestId });
    await this.ownerStreamLoop(entry);
  }

  async ownerStreamLoop(entry) {
    const isCurrentLifecycle = () => this.lifecycleEpoch === entry.epoch
      && this.mode === "owner"
      && this.roomId === entry.roomId;
    const isCurrent = () => {
      if (!isCurrentLifecycle() || entry.closed) return false;
      if (!entry.member) return this.pending.get(entry.requestId) === entry;
      const member = entry.member;
      return this.members.get(member.id) === member
        && member.status === "online"
        && member.streamEntry === entry
        && member.reader === entry.reader
        && member.writer === entry.writer
        && member.connection === entry.connection;
    };
    try {
      for (;;) {
        const frame = await entry.reader.read();
        if (!isCurrent()) return;
        if (!frame) break;
        if (!entry.member) {
          if (frame.type === "JOIN_CANCEL"
            && this.validateBaseFrame(frame)
            && frame.requestId === entry.requestId) {
            await this.rejectPending(entry.requestId, "CANCELLED", { notify: false });
            return;
          }
          throw new Error("pending member sent an unauthorized frame");
        }
        await this.handleMemberFrame(entry.member, frame);
        if (!isCurrent()) return;
      }
    } catch (error) {
      if (isCurrent() && !entry.closed) {
        this.status("MEMBER_STREAM_ERROR", { error, memberId: entry.member?.id || "" });
      }
    } finally {
      if (!isCurrent() || entry.closed) return;
      if (!entry.member) {
        this.dropPending(entry.requestId, entry);
      } else if (entry.member.streamEntry === entry) {
        this.markMemberReconnecting(entry.member, "DISCONNECTED");
      }
    }
  }

  dropPending(requestId, expected = null) {
    const entry = this.pending.get(requestId);
    if (!entry || (expected && entry !== expected)) return;
    entry.closed = true;
    entry.cancelReason = entry.cancelReason || "DISCONNECTED";
    entry.cancelSignal?.resolve(entry.cancelReason);
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    safeClose(entry.connection);
    this.emitState();
  }

  async rejectPending(requestId, reason = "REJECTED", { notify = true, force = false } = {}) {
    const entry = this.pending.get(requestId);
    if (!entry || entry.member || (entry.state === "committing" && !force)) return false;
    const epoch = entry.epoch;
    const roomId = entry.roomId;
    const wasCommitting = entry.state === "committing";
    entry.closed = true;
    entry.cancelReason = reason;
    entry.cancelSignal?.resolve(reason);
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    safeClose(entry.verificationConnection);
    if (notify && !wasCommitting) {
      try {
        const remaining = Math.max(1, Math.min(750, entry.expiresAt - this.now()));
        await withTimeout((async () => {
          await entry.writer.send({
            type: "JOIN_REJECT",
            gv: GROUP_PROTOCOL_VERSION,
            roomId,
            requestId,
            reason,
          });
          await entry.writer.closeWrite();
        })(), remaining, "pending join rejection timed out", () => safeClose(entry.connection));
      } catch (_) {
        // The requester may already have left.
      }
    }
    entry.writer.close();
    if (this.lifecycleEpoch === epoch && this.mode === "owner" && this.roomId === roomId) {
      this.emitState();
    }
    return true;
  }

  occupiedSeats() {
    let reserved = 0;
    for (const entry of this.pending.values()) {
      if (entry.state === "approving" || entry.state === "committing") reserved += 1;
    }
    return this.members.size + reserved;
  }

  approvePending(requestId) {
    // Seat reservation happens synchronously before the first await, so
    // address verification can proceed concurrently without oversubscription.
    return this.approvePendingTransaction(requestId);
  }

  async approvePendingTransaction(requestId) {
    const entry = this.pending.get(requestId);
    if (!entry || entry.member || entry.state !== "pending") return false;
    const epoch = entry.epoch;
    const roomId = entry.roomId;
    const isCurrentEntry = () => this.lifecycleEpoch === epoch
      && this.mode === "owner"
      && this.roomId === roomId
      && this.pending.get(requestId) === entry;
    entry.cancelSignal ||= deferred();
    if (this.now() >= entry.expiresAt) {
      await this.rejectPending(requestId, "EXPIRED");
      return false;
    }
    if (this.roomPaused || this.joinsPaused) {
      await this.rejectPending(requestId, "PAUSED");
      return false;
    }
    const approvalGeneration = this.joinPolicyGeneration;
    entry.state = "approving";
    if (this.occupiedSeats() > this.config.maxMembers) {
      entry.state = "pending";
      await this.rejectPending(requestId, "FULL");
      return false;
    }
    this.emitState();
    let admittedMember = null;
    try {
      const verificationBudget = Math.max(1, entry.expiresAt - this.now());
      const cancelledVerification = entry.cancelSignal.promise.then((reason) => {
        throw new Error(`join approval cancelled: ${reason}`);
      });
      await withTimeout(
        Promise.race([this.verifyAddress(entry), cancelledVerification]),
        verificationBudget,
        "address verification expired",
        () => {
          entry.closed = true;
          entry.cancelReason = "EXPIRED";
          safeClose(entry.verificationConnection);
          this.dropTransport(entry.address);
        },
      );
      if (!isCurrentEntry() || entry.closed) throw new Error("join request no longer pending");
      if (this.now() >= entry.expiresAt) {
        await this.rejectPending(requestId, "EXPIRED");
        return false;
      }
      if (this.closing
        || this.roomPaused
        || this.joinsPaused
        || this.joinPolicyGeneration !== approvalGeneration) {
        this.dropTransport(entry.address);
        await this.rejectPending(requestId, "PAUSED");
        return false;
      }
      const member = {
        id: randomBase64URL(16),
        code: entry.code,
        displayName: entry.displayName,
        role: "member",
        status: "online",
        address: entry.address,
        capabilities: entry.capabilities,
        sessionToken: randomBase64URL(32),
        connection: entry.connection,
        reader: entry.reader,
        writer: entry.writer,
        streamEntry: entry,
        deduper: new RecentEventDeduper(this.config.dedupeMaxItems),
        outstandingPings: new Set(),
        stalePings: new Set(),
        heartbeatFailures: 0,
        admissionSeq: this.nextSeq,
        resumeAttempt: null,
        graceTimer: null,
        reconnectDeadline: 0,
        removed: false,
      };
      admittedMember = member;
      // Invitation rotation and the expiry timer must not close the stream
      // after JOIN_ACCEPT starts writing but before admission commits.
      entry.state = "committing";
      clearTimeout(entry.timer);
      const acceptanceBudget = Math.max(1, entry.expiresAt - this.now());
      const cancelledAcceptance = entry.cancelSignal.promise.then((reason) => {
        throw new Error(`join admission cancelled: ${reason}`);
      });
      await withTimeout(Promise.race([member.writer.send({
          type: "JOIN_ACCEPT",
          gv: GROUP_PROTOCOL_VERSION,
          roomId,
          requestId,
          memberId: member.id,
          ownerId: this.ownerId,
          sessionToken: member.sessionToken,
          seq: this.nextSeq,
          roster: [...this.members.values(), member].map(publicMember),
          heartbeatMs: this.config.heartbeatIntervalMs,
        }), cancelledAcceptance]), acceptanceBudget, "join acceptance expired", () => {
          entry.closed = true;
          entry.cancelReason = "EXPIRED";
          safeClose(entry.connection);
        });
      if (this.mode !== "owner"
        || this.closing
        || this.roomPaused
        || this.joinsPaused
        || this.joinPolicyGeneration !== approvalGeneration
        || this.pending.get(requestId) !== entry
        || entry.closed) {
        throw new Error("join request closed while admission was committing");
      }
      // Frames on this stream remain unauthorized until the acceptance frame
      // has actually been written. This is the admission commit point.
      entry.member = member;
      this.pending.delete(requestId);
      this.members.set(member.id, member);
      this.commitEvent({ type: "MEMBER_JOINED", member: publicMember(member) });
      if (this.roomPaused) this.safeSend(member, {
        type: "ROOM_PAUSE",
        gv: GROUP_PROTOCOL_VERSION,
        roomId: this.roomId,
        paused: true,
        reason: this.pauseReason,
      });
      this.safeSend(member, {
        type: "JOIN_POLICY",
        gv: GROUP_PROTOCOL_VERSION,
        roomId: this.roomId,
        paused: this.joinsPaused,
      });
      this.emitState();
      return true;
    } catch (error) {
      if (!isCurrentEntry()) {
        entry.closed = true;
        entry.writer?.close();
        safeClose(entry.verificationConnection);
        safeClose(entry.connection);
        return false;
      }
      this.status("ADDRESS_VERIFY_FAILED", { requestId, error });
      this.dropTransport(entry.address);
      if (admittedMember && this.members.get(admittedMember.id) === admittedMember) {
        admittedMember.removed = true;
        if (admittedMember.streamEntry) admittedMember.streamEntry.closed = true;
        admittedMember.writer?.close();
        safeClose(admittedMember.connection);
        this.members.delete(admittedMember.id);
        this.dropTransport(admittedMember.address);
        this.emitState();
      }
      if (this.pending.get(requestId) === entry) {
        entry.state = "approving";
        const rejectionReason = entry.cancelReason
          || (this.now() >= entry.expiresAt ? "EXPIRED" : "VERIFY_FAILED");
        await this.rejectPending(requestId, rejectionReason);
      }
      return false;
    }
  }

  async verifyAddress(entry) {
    const epoch = entry.epoch;
    const roomId = entry.roomId;
    const isCurrentEntry = () => this.lifecycleEpoch === epoch
      && this.mode === "owner"
      && this.roomId === roomId
      && this.pending.get(entry.requestId) === entry
      && !entry.closed;
    let connection = null;
    let writer = null;
    let transportEntry = null;
    try {
      // Capture the cache identity before either initialization or dialing can
      // yield. Looking it up afterwards could mistake a replacement room's
      // same-address transport for this stale verification attempt.
      transportEntry = this.getTransport(entry.address);
      const transport = await transportEntry;
      try {
        connection = await transport.dial({ port: this.port });
      } catch (error) {
        this.dropTransport(entry.address, transportEntry);
        throw error;
      }
      if (!isCurrentEntry()) throw new Error("stale address verification");
      entry.verificationConnection = connection;
      if (this.now() >= entry.expiresAt) throw new Error("address verification expired");
      writer = new GroupFrameWriter(connection, this.writerOptions());
      const reader = new GroupFrameReader(connection);
      const challenge = randomBase64URL(32);
      await writer.send({
        type: "ADDRESS_CHALLENGE",
        gv: GROUP_PROTOCOL_VERSION,
        roomId,
        requestId: entry.requestId,
        clientNonce: entry.clientNonce,
        challenge,
      });
      if (!isCurrentEntry()) throw new Error("stale address verification");
      const proof = await withTimeout(
        reader.read(),
        DEFAULT_FIRST_FRAME_TIMEOUT_MS,
        "address proof timed out",
        () => safeClose(connection),
      );
      if (!isCurrentEntry()
        || proof?.gv !== GROUP_PROTOCOL_VERSION
        || proof.roomId !== roomId
        || proof.type !== "ADDRESS_PROOF"
        || proof.requestId !== entry.requestId
        || proof.clientNonce !== entry.clientNonce
        || proof.challenge !== challenge) throw new Error("address proof rejected");
    } catch (error) {
      if (transportEntry) this.dropTransport(entry.address, transportEntry);
      throw error;
    } finally {
      if (this.lifecycleEpoch === epoch && entry.verificationConnection === connection) {
        entry.verificationConnection = null;
      }
      if (writer) writer.close();
      else safeClose(connection);
    }
  }

  async answerAddressChallenge(connection, reader, frame) {
    const join = this.currentJoin;
    if (!join
      || !this.validateBaseFrame(frame)
      || frame.requestId !== join.requestId
      || frame.clientNonce !== join.clientNonce
      || !validID(frame.challenge, 32)) throw new Error("address challenge rejected");
    this.status("ADDRESS_VERIFYING");
    const writer = new GroupFrameWriter(connection, this.writerOptions());
    try {
      await writer.send({
        type: "ADDRESS_PROOF",
        gv: GROUP_PROTOCOL_VERSION,
        roomId: this.roomId,
        requestId: join.requestId,
        clientNonce: join.clientNonce,
        challenge: frame.challenge,
      });
      await writer.closeWrite();
    } finally {
      writer.close();
    }
  }

  finishJoin(error = null) {
    const outcome = this.joinOutcome;
    this.joinOutcome = null;
    if (!outcome) return;
    if (error) outcome.reject(error);
    else outcome.resolve(this.snapshot());
  }

  async guestLoop(
    connection,
    requestId = "",
    epoch = this.lifecycleEpoch,
    reader = this.reader,
  ) {
    const roomId = this.roomId;
    const isCurrent = () => this.lifecycleEpoch === epoch
      && this.roomId === roomId
      && this.connection === connection
      && this.reader === reader;
    let expectedClose = false;
    let terminalError = null;
    try {
      for (;;) {
        const frame = await reader.read();
        if (!isCurrent()) return;
        if (!frame) break;
        if (frame?.gv !== GROUP_PROTOCOL_VERSION || frame.roomId !== roomId) {
          throw new Error("cross-room group frame rejected");
        }
        if (this.mode === "pending") {
          if (frame.type === "JOIN_REJECT" && frame.requestId === requestId) {
            expectedClose = true;
            throw new Error(`join rejected: ${frame.reason || "REJECTED"}`);
          }
          if (frame.type !== "JOIN_ACCEPT"
            || frame.requestId !== requestId
            || !validEventID(frame.memberId)
            || !validEventID(frame.ownerId)
            || !validID(frame.sessionToken, 32)
            || !Number.isSafeInteger(frame.seq)
            || !Array.isArray(frame.roster)) throw new Error("invalid join response");
          this.mode = "member";
          this.memberId = frame.memberId;
          this.ownerId = frame.ownerId;
          this.sessionToken = frame.sessionToken;
          this.lastSeq = frame.seq;
          this.applyRoster(frame.roster);
          this.lastOwnerPingAt = this.now();
          this.currentJoin = null;
          this.startOwnerWatchdog();
          this.emitState();
          this.status("JOINED");
          this.finishJoin();
          continue;
        }
        if (this.mode !== "member") throw new Error("member stream is no longer active");
        await this.handleOwnerFrame(frame);
        if (!isCurrent()) return;
        if (frame.type === "ROOM_CLOSED" || frame.type === "REMOVED") expectedClose = true;
      }
    } catch (error) {
      if (!isCurrent()) return;
      terminalError = error;
      if (this.mode === "pending") this.finishJoin(error);
      else if (!expectedClose && this.mode === "member" && this.connection === connection) {
        this.status("RECOVERING", { error });
      }
    } finally {
      if (!isCurrent()) {
        safeClose(connection);
        return;
      }
      safeClose(connection);
      if (this.mode === "pending") {
        const error = terminalError || new Error("group join stream closed before admission");
        this.finishJoin(error);
        await this.close("JOIN_FAILED", { notify: false });
      } else if (!expectedClose && this.mode === "member" && !this.closing) {
        this.beginRecovery();
      }
    }
  }

  applyRoster(roster) {
    const previousMembers = this.members;
    const members = new Map();
    for (const item of roster) {
      if (!validEventID(item?.id)
        || typeof item.code !== "string"
        || typeof item.displayName !== "string"
        || !["owner", "member"].includes(item.role)
        || !["online", "reconnecting"].includes(item.status)) throw new Error("invalid group roster");
      members.set(item.id, {
        id: item.id,
        code: item.code,
        displayName: item.displayName,
        role: item.role,
        status: item.status,
        capabilities: publicCapabilities(item.capabilities),
      });
    }
    if (!members.has(this.ownerId) || !members.has(this.memberId)) throw new Error("incomplete group roster");
    for (const memberId of previousMembers.keys()) {
      if (members.has(memberId)) continue;
      this.invalidateMemberTickets(memberId);
      this.status("MEMBER_TICKETS_REVOKED", { memberId });
    }
    this.members = members;
  }

  publicRoster() {
    return [...this.members.values()].map(publicMember);
  }

  async handleOwnerFrame(frame) {
    if (frame.type === "PING") {
      if (!validEventID(frame.pingId)) throw new Error("invalid group heartbeat");
      this.lastOwnerPingAt = this.now();
      await this.writer.send({
        type: "PONG",
        gv: GROUP_PROTOCOL_VERSION,
        roomId: this.roomId,
        pingId: frame.pingId,
      });
      return;
    }
    if (frame.type === "ROOM_EVENT") {
      this.acceptEvent(frame.event);
      return;
    }
    if (frame.type === "ROOM_PAUSE") {
      this.roomPaused = Boolean(frame.paused);
      this.pauseReason = this.roomPaused ? String(frame.reason || "HOST") : "";
      if (this.roomPaused) this.invalidateAllTickets("group room paused");
      this.emitState();
      this.status(this.roomPaused ? "ROOM_PAUSED" : "ROOM_RESUMED", { reason: this.pauseReason });
      return;
    }
    if (frame.type === "JOIN_POLICY") {
      this.joinsPaused = Boolean(frame.paused);
      this.emitState();
      return;
    }
    if (frame.type === "TRANSFER_ARM") {
      this.armTicket(frame);
      await this.writer.send({
        type: "TRANSFER_ARMED",
        gv: GROUP_PROTOCOL_VERSION,
        roomId: this.roomId,
        ticket: frame.ticket,
        ticketSenderId: frame.senderId,
        ticketRecipientId: frame.recipientId,
        transferId: frame.transferId,
      });
      return;
    }
    if (frame.type === "TRANSFER_TICKET_RESPONSE") {
      this.resolveTicketRequest(frame);
      return;
    }
    if (frame.type === "TRANSFER_CONSUME_RESPONSE") {
      this.resolveTicketConsume(frame);
      return;
    }
    if (frame.type === "TICKETS_REVOKED") {
      if (!validEventID(frame.memberId)) throw new Error("invalid ticket revocation");
      this.invalidateMemberTickets(frame.memberId);
      this.status("MEMBER_TICKETS_REVOKED", { memberId: frame.memberId });
      return;
    }
    if (frame.type === "ACTION_REJECTED") {
      if (frame.requestId) this.deletePendingEvent(frame.requestId);
      this.status("ACTION_REJECTED", { reason: frame.reason || "REJECTED", requestId: frame.requestId || "" });
      return;
    }
    if (frame.type === "RESYNC_REQUIRED") {
      if (!Number.isSafeInteger(frame.seq) || !Array.isArray(frame.roster)) throw new Error("invalid resync frame");
      this.lastSeq = frame.seq;
      this.applyRoster(frame.roster);
      this.emitState();
      this.status("MESSAGE_GAP", { sequence: frame.seq });
      return;
    }
    if (frame.type === "ROOM_CLOSED" || frame.type === "REMOVED") {
      const reason = frame.type === "REMOVED" ? "REMOVED" : String(frame.reason || "HOST_CLOSED");
      await this.close(reason, { notify: false });
      return;
    }
    if (frame.type === "RESUME_ACCEPT") {
      // Handled by the recovery handshake before guestLoop starts.
      return;
    }
    throw new Error("unsupported owner group frame");
  }

  acceptEvent(event) {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 1 || typeof event.type !== "string") {
      throw new Error("invalid group event");
    }
    if (event.seq <= this.lastSeq) return;
    if (event.seq !== this.lastSeq + 1) {
      this.status("MESSAGE_GAP", { expected: this.lastSeq + 1, received: event.seq });
      safeClose(this.connection);
      throw new Error("group event sequence gap");
    }
    if (event.type === "TEXT") {
      if (!this.members.has(event.senderId)
        || typeof event.text !== "string"
        || !event.text.trim()
        || new TextEncoder().encode(event.text).length > this.limits.textBytes) throw new Error("invalid group text event");
    } else if (event.type === "MEMBER_JOINED") {
      const member = event.member;
      if (!validEventID(member?.id)) throw new Error("invalid member event");
      this.members.set(member.id, { ...member });
    } else if (event.type === "MEMBER_LEFT") {
      if (!validEventID(event.memberId)) throw new Error("invalid member event");
      this.invalidateMemberTickets(event.memberId);
      this.status("MEMBER_TICKETS_REVOKED", { memberId: event.memberId });
      this.members.delete(event.memberId);
    } else if (event.type === "MEMBER_STATE") {
      const member = this.members.get(event.memberId);
      if (!member || !["online", "reconnecting"].includes(event.status)) throw new Error("invalid member state event");
      member.status = event.status;
    } else {
      throw new Error("unsupported group event");
    }
    this.lastSeq = event.seq;
    if (event.senderId === this.memberId && event.clientEventId) this.deletePendingEvent(event.clientEventId);
    this.callbacks.onEvent(Object.freeze({ ...event }));
    this.emitState();
  }

  async handleMemberFrame(member, frame) {
    if (this.closing
      || member?.removed
      || this.members.get(member?.id) !== member
      || member.status !== "online"
      || !this.validateBaseFrame(frame)
      || !isExpectedIdentity(frame, member.id)) {
      throw new Error("forged or cross-room member frame rejected");
    }
    if (frame.type === "PONG") {
      if (!validEventID(frame.pingId)) {
        throw new Error("cross-member heartbeat acknowledgement rejected");
      }
      member.outstandingPings ||= new Set();
      member.stalePings ||= new Set();
      if (member.outstandingPings.delete(frame.pingId)) {
        member.heartbeatFailures = 0;
        member.stalePings.clear();
        return;
      }
      // A PONG can arrive after the next heartbeat cycle has already counted
      // that ping as missed. Ignore only that member's bounded stale IDs;
      // another member still cannot acknowledge them.
      if (member.stalePings.delete(frame.pingId)) return;
      throw new Error("cross-member heartbeat acknowledgement rejected");
    }
    if (frame.type === "LEAVE") {
      await this.removeMember(member.id, "LEFT", { notify: false });
      return;
    }
    if (frame.type === "TRANSFER_ARMED") {
      this.resolveTicketArm(member, frame);
      return;
    }
    if (frame.type === "TRANSFER_TICKET_REQUEST") {
      await this.handleTicketRequest(member, frame);
      return;
    }
    if (frame.type === "TRANSFER_CONSUME_REQUEST") {
      await this.handleTicketConsume(member, frame);
      return;
    }
    if (this.roomPaused) {
      this.safeSend(member, {
        type: "ACTION_REJECTED",
        gv: GROUP_PROTOCOL_VERSION,
        roomId: this.roomId,
        requestId: frame.clientEventId || frame.requestId || "",
        reason: "PAUSED",
      });
      return;
    }
    if (frame.type === "TEXT_SUBMIT") {
      if (!validEventID(frame.clientEventId)
        || typeof frame.text !== "string"
        || !frame.text.trim()
        || new TextEncoder().encode(frame.text).length > this.limits.textBytes) throw new Error("invalid group text submission");
      const prior = member.deduper.get(frame.clientEventId);
      if (prior) {
        const replay = this.replay.after(prior - 1);
        const event = replay?.find((candidate) => candidate.seq === prior);
        if (event) this.safeSend(member, { type: "ROOM_EVENT", gv: GROUP_PROTOCOL_VERSION, roomId: this.roomId, event });
        else this.safeSend(member, {
          type: "ACTION_REJECTED",
          gv: GROUP_PROTOCOL_VERSION,
          roomId: this.roomId,
          requestId: frame.clientEventId,
          reason: "DUPLICATE_EXPIRED",
        });
        return;
      }
      const event = this.commitEvent({
        type: "TEXT",
        senderId: member.id,
        clientEventId: frame.clientEventId,
        text: frame.text,
      });
      member.deduper.remember(frame.clientEventId, event.seq);
      return;
    }
    throw new Error("unsupported member frame");
  }

  commitEvent(event) {
    if (this.mode !== "owner" || this.closing) throw new Error("only an active owner can commit room events");
    const committed = Object.freeze({ ...event, seq: ++this.nextSeq });
    this.replay.push(committed);
    this.callbacks.onEvent(committed);
    for (const member of this.members.values()) {
      if (member.role === "member" && member.status === "online") {
        this.safeSend(member, { type: "ROOM_EVENT", gv: GROUP_PROTOCOL_VERSION, roomId: this.roomId, event: committed });
      }
    }
    this.emitState();
    return committed;
  }

  safeSend(member, frame) {
    if (!member?.writer || member.status !== "online") return;
    const epoch = this.lifecycleEpoch;
    const roomId = this.roomId;
    const writer = member.writer;
    void writer.send(frame).catch((error) => {
      if (this.lifecycleEpoch !== epoch
        || this.mode !== "owner"
        || this.roomId !== roomId
        || this.members.get(member.id) !== member
        || member.writer !== writer) return;
      this.status("SLOW_MEMBER", { memberId: member.id, error });
      if (member.status === "online") this.markMemberReconnecting(member, "SLOW");
    });
  }

  async sendText(text, clientEventId = randomBase64URL(16)) {
    if (!this.canSend) throw new Error("group room is paused or disconnected");
    if (!validEventID(clientEventId)
      || typeof text !== "string"
      || !text.trim()
      || new TextEncoder().encode(text).length > this.limits.textBytes) {
      throw new Error("invalid group text message");
    }
    if (this.mode === "owner") {
      const owner = this.members.get(this.ownerId);
      const prior = owner?.deduper.get(clientEventId);
      if (prior) {
        const replay = this.replay.after(prior - 1);
        const event = replay?.find((candidate) => candidate.seq === prior);
        if (event) return event;
        throw new Error("duplicate group event is no longer recoverable");
      }
      const event = this.commitEvent({ type: "TEXT", senderId: this.ownerId, clientEventId, text });
      owner.deduper.remember(clientEventId, event.seq);
      return event;
    }
    if (!this.writer) throw new Error("group owner is unavailable");
    const epoch = this.lifecycleEpoch;
    const roomId = this.roomId;
    const writer = this.writer;
    const connection = this.connection;
    const pendingEvent = Object.freeze({
      type: "TEXT_SUBMIT",
      gv: GROUP_PROTOCOL_VERSION,
      roomId,
      clientEventId,
      text,
    });
    const pendingBytes = new TextEncoder().encode(JSON.stringify(pendingEvent)).length + 4;
    if (this.pendingEvents.size + 1 > this.config.sendQueueMaxFrames
      || this.pendingEventBytes + pendingBytes > this.config.sendQueueMaxBytes) {
      throw new Error("group pending event queue exceeded its limit");
    }
    this.pendingEvents.set(clientEventId, pendingEvent);
    this.pendingEventSizes.set(clientEventId, pendingBytes);
    this.pendingEventBytes += pendingBytes;
    try {
      await writer.send(pendingEvent);
      if (this.lifecycleEpoch !== epoch
        || this.mode !== "member"
        || this.roomId !== roomId
        || this.writer !== writer
        || this.connection !== connection) {
        throw new Error("group room changed while sending text");
      }
      return Object.freeze({ clientEventId, pending: true });
    } catch (error) {
      if (this.lifecycleEpoch !== epoch
        || this.mode !== "member"
        || this.roomId !== roomId
        || this.writer !== writer
        || this.connection !== connection) throw error;
      // A failed stream write is ambiguous: the host may have received the
      // complete frame. Preserve it for exactly-once replay and enter recovery
      // instead of reporting a permanent failure followed by a silent resend.
      safeClose(connection);
      this.beginRecovery();
      this.status("RECOVERING", { error });
      return Object.freeze({ clientEventId, pending: true, recovering: true });
    }
  }

  deletePendingEvent(clientEventId) {
    const size = this.pendingEventSizes.get(clientEventId) || 0;
    this.pendingEventSizes.delete(clientEventId);
    this.pendingEventBytes = Math.max(0, this.pendingEventBytes - size);
    return this.pendingEvents.delete(clientEventId);
  }

  startOwnerHeartbeat() {
    clearInterval(this.heartbeatTimer);
    const epoch = this.lifecycleEpoch;
    const roomId = this.roomId;
    const timer = setInterval(() => {
      if (this.lifecycleEpoch !== epoch || this.mode !== "owner" || this.roomId !== roomId) {
        clearInterval(timer);
        return;
      }
      for (const member of this.members.values()) {
        if (member.role !== "member" || member.status !== "online") continue;
        member.outstandingPings ||= new Set();
        member.stalePings ||= new Set();
        member.heartbeatFailures ||= 0;
        if (member.outstandingPings.size) {
          member.heartbeatFailures += 1;
          for (const pingId of member.outstandingPings) member.stalePings.add(pingId);
          member.outstandingPings.clear();
          while (member.stalePings.size > this.config.heartbeatFailureLimit * 2) {
            member.stalePings.delete(member.stalePings.values().next().value);
          }
        }
        if (member.heartbeatFailures >= this.config.heartbeatFailureLimit) {
          this.markMemberReconnecting(member, "HEARTBEAT");
          continue;
        }
        const pingId = randomBase64URL(16);
        member.outstandingPings.add(pingId);
        this.safeSend(member, {
          type: "PING",
          gv: GROUP_PROTOCOL_VERSION,
          roomId: this.roomId,
          pingId,
        });
      }
      this.pruneTickets();
    }, this.config.heartbeatIntervalMs);
    this.heartbeatTimer = timer;
  }

  startOwnerWatchdog() {
    clearInterval(this.ownerWatchdog);
    const epoch = this.lifecycleEpoch;
    const roomId = this.roomId;
    const timer = setInterval(() => {
      if (this.lifecycleEpoch !== epoch || this.roomId !== roomId) {
        clearInterval(timer);
        return;
      }
      if (this.mode !== "member" || this.closing) return;
      const maximumSilence = this.config.heartbeatIntervalMs * this.config.heartbeatFailureLimit
        + Math.min(this.config.heartbeatIntervalMs, 20_000);
      if (this.now() - this.lastOwnerPingAt > maximumSilence) safeClose(this.connection);
      this.pruneTickets();
    }, Math.min(this.config.heartbeatIntervalMs, 10_000));
    this.ownerWatchdog = timer;
  }

  markMemberReconnecting(member, reason) {
    if (this.closing
      || this.mode !== "owner"
      || this.members.get(member?.id) !== member
      || member.role !== "member"
      || member.removed
      || member.status === "reconnecting") return;
    member.status = "reconnecting";
    member.outstandingPings?.clear();
    member.stalePings?.clear();
    member.heartbeatFailures = 0;
    member.reconnectDeadline = this.now() + this.config.reconnectGraceMs;
    if (member.streamEntry) member.streamEntry.closed = true;
    member.writer?.close();
    safeClose(member.connection);
    member.connection = null;
    member.reader = null;
    member.writer = null;
    member.streamEntry = null;
    clearTimeout(member.graceTimer);
    const epoch = this.lifecycleEpoch;
    member.graceTimer = setTimeout(() => {
      if (this.lifecycleEpoch === epoch && this.members.get(member.id) === member) {
        void this.removeMember(member.id, "TIMEOUT", { notify: false });
      }
    }, this.config.reconnectGraceMs);
    this.commitEvent({ type: "MEMBER_STATE", memberId: member.id, status: "reconnecting", reason });
  }

  beginRecovery() {
    if (this.mode !== "member" || this.recoveryActive || this.closing) return;
    const epoch = this.lifecycleEpoch;
    const roomId = this.roomId;
    const memberId = this.memberId;
    const sessionToken = this.sessionToken;
    const hostAddress = this.hostAddress;
    const localAddress = this.localAddress;
    const isCurrent = () => this.lifecycleEpoch === epoch
      && this.mode === "member"
      && this.roomId === roomId
      && this.memberId === memberId
      && this.sessionToken === sessionToken
      && this.hostAddress === hostAddress
      && this.localAddress === localAddress;
    this.recoveryActive = true;
    const recoveryDeadline = this.now() + this.config.reconnectGraceMs;
    this.recoveryDeadline = recoveryDeadline;
    clearTimeout(this.recoveryExpiryTimer);
    this.recoveryExpiryTimer = setTimeout(() => {
      if (isCurrent() && this.recoveryActive && !this.closing) {
        void this.close("RECOVERY_TIMEOUT", { notify: false });
      }
    }, this.config.reconnectGraceMs);
    clearInterval(this.ownerWatchdog);
    this.ownerWatchdog = null;
    this.emitState();
    let attempt = 0;
    const run = async () => {
      if (!isCurrent() || this.closing || !this.recoveryActive) return;
      if (this.now() >= recoveryDeadline) {
        await this.close("RECOVERY_TIMEOUT", { notify: false });
        return;
      }
      attempt += 1;
      let connection = null;
      let writer = null;
      try {
        this.dropTransport(hostAddress);
        connection = await this.dial(hostAddress);
        if (!isCurrent() || this.closing || !this.recoveryActive) {
          safeClose(connection);
          return;
        }
        const reader = new GroupFrameReader(connection);
        writer = new GroupFrameWriter(connection, this.writerOptions());
        const lastSeq = this.lastSeq;
        await writer.send({
          type: "RESUME_REQUEST",
          gv: GROUP_PROTOCOL_VERSION,
          roomId,
          memberId,
          sessionToken,
          replyTo: localAddress,
          lastSeq,
        });
        if (!isCurrent() || this.closing || !this.recoveryActive) {
          throw new Error("stale group recovery attempt");
        }
        const response = await withTimeout(reader.read(), DEFAULT_FIRST_FRAME_TIMEOUT_MS, "resume timed out", () => safeClose(connection));
        if (!isCurrent() || this.closing || !this.recoveryActive) {
          throw new Error("stale group recovery attempt");
        }
        if (response?.gv !== GROUP_PROTOCOL_VERSION
          || response.roomId !== roomId
          || response.type !== "RESUME_ACCEPT"
          || response.memberId !== memberId
          || !Number.isSafeInteger(response.currentSeq)
          || response.currentSeq < lastSeq
          || typeof response.roomPaused !== "boolean"
          || typeof response.pauseReason !== "string"
          || typeof response.joinsPaused !== "boolean") {
          throw new Error(`resume rejected: ${response?.reason || "INVALID"}`);
        }
        const pendingEvents = [...this.pendingEvents.values()];
        for (const pendingEvent of pendingEvents) {
          await writer.send(pendingEvent);
          if (!isCurrent() || this.closing || !this.recoveryActive) {
            throw new Error("stale group recovery attempt");
          }
        }
        if (!isCurrent() || this.closing || this.now() >= recoveryDeadline) {
          throw new Error("resume attempt expired");
        }
        this.connection = connection;
        this.reader = reader;
        this.writer = writer;
        this.roomPaused = response.roomPaused;
        this.pauseReason = this.roomPaused ? (response.pauseReason || "HOST") : "";
        this.joinsPaused = response.joinsPaused;
        if (this.roomPaused) this.invalidateAllTickets("group room paused");
        this.lastOwnerPingAt = this.now();
        this.recoveryTimer = null;
        this.recoveryActive = false;
        clearTimeout(this.recoveryExpiryTimer);
        this.recoveryExpiryTimer = null;
        this.startOwnerWatchdog();
        this.emitState();
        this.status("RECOVERED");
        void this.guestLoop(connection, "", epoch, reader);
        return;
      } catch (error) {
        writer?.close();
        safeClose(connection);
        if (!isCurrent()) return;
        this.status("RECOVERY_RETRY", { attempt, error });
      }
      if (!isCurrent() || this.closing || !this.recoveryActive) return;
      const delay = Math.min(8_000, 500 * (2 ** Math.min(attempt, 4)));
      this.recoveryTimer = setTimeout(() => {
        if (!isCurrent()) return;
        this.recoveryTimer = null;
        void run();
      }, delay);
    };
    void run();
  }

  async acceptResume(connection, reader, frame) {
    const member = this.members.get(frame?.memberId);
    const resumableStatus = member?.status === "online"
      || (member?.status === "reconnecting" && this.now() <= member.reconnectDeadline);
    const valid = this.mode === "owner"
      && !this.closing
      && this.validateBaseFrame(frame)
      && member?.role === "member"
      && resumableStatus
      && !member.removed
      && !member.resumeAttempt
      && frame.sessionToken === member.sessionToken
      && frame.replyTo === member.address
      && Number.isSafeInteger(frame.lastSeq)
      && Number.isSafeInteger(member.admissionSeq)
      && frame.lastSeq >= member.admissionSeq
      && frame.lastSeq <= this.nextSeq;
    if (!valid) {
      const writer = new GroupFrameWriter(connection, this.writerOptions());
      try {
        await withTimeout((async () => {
          await writer.send({
            type: "RESUME_REJECT",
            gv: GROUP_PROTOCOL_VERSION,
            roomId: this.roomId,
            memberId: validEventID(frame?.memberId) ? frame.memberId : "",
            reason: "INVALID_SESSION",
          });
          await writer.closeWrite();
        })(), 750, "resume rejection timed out", () => safeClose(connection));
      } catch (_) {
        // Rejection is best effort; closing the stream is also terminal.
      } finally {
        writer.close();
      }
      return;
    }

    // The guest can observe a one-way failure before the host's heartbeat
    // does. A valid session token may therefore supersede its still-online
    // control stream instead of waiting beyond the guest's recovery window.
    if (member.status === "online") this.markMemberReconnecting(member, "CLIENT_RESUME");

    const writer = new GroupFrameWriter(connection, this.writerOptions());
    const entry = {
      epoch: this.lifecycleEpoch,
      roomId: this.roomId,
      requestId: "",
      connection,
      reader,
      writer,
      member,
      closed: false,
    };
    const attempt = { connection, reader, writer, entry };
    member.resumeAttempt = attempt;
    let activated = false;
    const ensureCurrentAttempt = () => {
      if (this.mode !== "owner"
        || this.closing
        || member.resumeAttempt !== attempt
        || member.removed
        || this.members.get(member.id) !== member
        || this.now() > member.reconnectDeadline) throw new Error("resume attempt expired");
    };
    try {
      await writer.send({
        type: "RESUME_ACCEPT",
        gv: GROUP_PROTOCOL_VERSION,
        roomId: this.roomId,
        memberId: member.id,
        currentSeq: this.nextSeq,
        roomPaused: this.roomPaused,
        pauseReason: this.pauseReason,
        joinsPaused: this.joinsPaused,
      });
      ensureCurrentAttempt();

      let cursor = frame.lastSeq;
      while (cursor < this.nextSeq) {
        const events = this.replay.after(cursor);
        if (events === null) {
          const resyncSeq = this.nextSeq;
          const roster = this.publicRoster();
          await writer.send({
            type: "RESYNC_REQUIRED",
            gv: GROUP_PROTOCOL_VERSION,
            roomId: this.roomId,
            seq: resyncSeq,
            roster,
          });
          cursor = resyncSeq;
          ensureCurrentAttempt();
          continue;
        }
        for (const event of events) {
          await writer.send({ type: "ROOM_EVENT", gv: GROUP_PROTOCOL_VERSION, roomId: this.roomId, event });
          cursor = event.seq;
          ensureCurrentAttempt();
        }
      }

      ensureCurrentAttempt();
      member.connection = connection;
      member.reader = reader;
      member.writer = writer;
      member.streamEntry = entry;
      member.status = "online";
      member.outstandingPings ||= new Set();
      member.stalePings ||= new Set();
      member.outstandingPings.clear();
      member.stalePings.clear();
      member.heartbeatFailures = 0;
      member.reconnectDeadline = 0;
      member.resumeAttempt = null;
      clearTimeout(member.graceTimer);
      member.graceTimer = null;
      activated = true;
      this.commitEvent({ type: "MEMBER_STATE", memberId: member.id, status: "online", reason: "RESUMED" });
      await this.ownerStreamLoop(entry);
    } catch (error) {
      if (!activated && member.resumeAttempt === attempt) member.resumeAttempt = null;
      throw error;
    } finally {
      if (!activated) {
        entry.closed = true;
        writer.close();
        safeClose(connection);
      }
    }
  }

  abortResumeAttempt(member) {
    const attempt = member?.resumeAttempt;
    if (!attempt) return;
    member.resumeAttempt = null;
    attempt.entry.closed = true;
    attempt.writer.close();
    safeClose(attempt.connection);
  }

  async removeMember(memberId, reason = "REMOVED", { notify = true } = {}) {
    if (this.mode !== "owner" || this.closing || memberId === this.ownerId) return false;
    const member = this.members.get(memberId);
    if (!member) return false;
    const transportEntry = this.transports.get(member.address) || null;
    member.removed = true;
    clearTimeout(member.graceTimer);
    this.abortResumeAttempt(member);
    if (member.streamEntry) member.streamEntry.closed = true;
    // Revoke authority synchronously. The best-effort REMOVED notification
    // below must never leave a slow member able to submit events or tickets.
    this.members.delete(memberId);
    this.invalidateMemberTickets(memberId);
    for (const other of this.members.values()) {
      if (other.role === "member" && other.id !== memberId && other.status === "online") this.safeSend(other, {
        type: "TICKETS_REVOKED",
        gv: GROUP_PROTOCOL_VERSION,
        roomId: this.roomId,
        memberId,
      });
    }
    this.status("MEMBER_TICKETS_REVOKED", { memberId });
    let removalNotice = null;
    if (notify && member.writer && member.status === "online") {
      removalNotice = member.writer.send({
        type: "REMOVED",
        gv: GROUP_PROTOCOL_VERSION,
        roomId: this.roomId,
        reason,
      });
    }
    this.commitEvent({ type: "MEMBER_LEFT", memberId, member: publicMember(member), reason });
    this.emitState();
    if (removalNotice) {
      try {
        await withTimeout(removalNotice, 750, "member removal notice timed out", () => safeClose(member.connection));
      } catch (_) {
        // The member may have disconnected while removal was sent.
      }
    }
    member.writer?.close();
    safeClose(member.connection);
    if (transportEntry) this.dropTransport(member.address, transportEntry);
    return true;
  }

  cancelPendingApprovals(reason, { all = false } = {}) {
    for (const [requestId, entry] of [...this.pending]) {
      if (!all && entry.state === "pending") continue;
      // rejectPending revokes the entry synchronously before its optional
      // best-effort network notice, so policy changes take effect now.
      void this.rejectPending(requestId, reason, { notify: false, force: true });
    }
  }

  setJoinsPaused(paused) {
    if (this.mode !== "owner") return false;
    const requested = Boolean(paused);
    if (requested !== this.joinsPaused) this.joinPolicyGeneration += 1;
    this.joinsPaused = requested;
    if (requested) this.cancelPendingApprovals("PAUSED");
    for (const member of this.members.values()) {
      if (member.role === "member") this.safeSend(member, {
        type: "JOIN_POLICY",
        gv: GROUP_PROTOCOL_VERSION,
        roomId: this.roomId,
        paused: this.joinsPaused,
      });
    }
    this.emitState();
    return true;
  }

  async setRoomPaused(paused, reason = "HOST_BACKGROUND") {
    if (this.mode !== "owner") return false;
    const requestedPaused = Boolean(paused);
    const requestedReason = requestedPaused ? reason : "";
    if (requestedPaused !== this.roomPaused) this.joinPolicyGeneration += 1;
    this.roomPaused = requestedPaused;
    this.pauseReason = requestedReason;
    if (requestedPaused) {
      this.cancelPendingApprovals("PAUSED");
      this.invalidateAllTickets("group room paused");
    }
    // Publish the local transition before awaiting any member queue. A rapid
    // hidden/visible pair must still observe the pause generation even if the
    // earlier network writes settle after the later resume call begins.
    this.emitState();
    this.status(requestedPaused ? "ROOM_PAUSED" : "ROOM_RESUMED", { reason: requestedReason });
    const sends = [];
    for (const member of this.members.values()) {
      if (member.role === "member" && member.status === "online") sends.push(member.writer.send({
        type: "ROOM_PAUSE",
        gv: GROUP_PROTOCOL_VERSION,
        roomId: this.roomId,
        paused: requestedPaused,
        reason: requestedReason,
      }));
    }
    await Promise.allSettled(sends);
    return true;
  }

  async rotateInvitation() {
    if (this.mode !== "owner") throw new Error("only the owner can rotate invitations");
    const epoch = this.lifecycleEpoch;
    const roomId = this.roomId;
    this.joinPolicyGeneration += 1;
    this.joinToken = randomBase64URL(32);
    const joinToken = this.joinToken;
    const requests = [...this.pending.keys()];
    await Promise.all(requests.map((requestId) => this.rejectPending(
      requestId,
      "INVITE_ROTATED",
      { force: true },
    )));
    if (this.lifecycleEpoch !== epoch || this.mode !== "owner" || this.roomId !== roomId) {
      throw new Error("group room changed while rotating invitation");
    }
    this.emitState();
    return joinToken;
  }

  async cancelJoin() {
    if (this.mode !== "pending") return false;
    const epoch = this.lifecycleEpoch;
    const roomId = this.roomId;
    const join = this.currentJoin;
    const writer = this.writer;
    const connection = this.connection;
    try {
      if (writer && join) await writer.send({
        type: "JOIN_CANCEL",
        gv: GROUP_PROTOCOL_VERSION,
        roomId,
        requestId: join.requestId,
      });
    } catch (_) {
      // Closing the stream also cancels a pending request.
    }
    if (this.lifecycleEpoch !== epoch
      || this.mode !== "pending"
      || this.roomId !== roomId
      || this.currentJoin !== join
      || this.writer !== writer
      || this.connection !== connection) {
      writer?.close();
      safeClose(connection);
      return false;
    }
    this.finishJoin(new Error("join request cancelled"));
    await this.close("CANCELLED", { notify: false });
    return true;
  }

  async leave() {
    return this.close("LEFT", { notify: true });
  }

  async close(reason = "CLOSED", { notify = true } = {}) {
    if (this.mode === "none" || this.closing) return;
    this.closing = true;
    const wasOwner = this.mode === "owner";
    const closedRoomId = this.roomId;
    // Revoke all local authority before any best-effort closing write can
    // block. No text, join, or transfer action may commit after ROOM_CLOSED.
    this.roomPaused = true;
    this.joinsPaused = true;
    this.joinPolicyGeneration += 1;
    this.cancelPendingApprovals(reason, { all: true });
    this.invalidateAllTickets("group room closed");
    for (const member of this.members.values()) this.abortResumeAttempt(member);
    const sends = [];
    if (notify && wasOwner) {
      for (const member of this.members.values()) {
        if (member.role === "member" && member.status === "online" && member.writer) sends.push(member.writer.send({
          type: "ROOM_CLOSED",
          gv: GROUP_PROTOCOL_VERSION,
          roomId: this.roomId,
          reason,
        }));
      }
    } else if (notify && this.mode === "member" && this.writer) {
      sends.push(this.writer.send({
        type: "LEAVE",
        gv: GROUP_PROTOCOL_VERSION,
        roomId: this.roomId,
      }));
    }
    if (sends.length) await Promise.race([
      Promise.allSettled(sends),
      new Promise((resolve) => setTimeout(resolve, 750)),
    ]);
    this.finishJoin(new Error(`group room closed: ${reason}`));
    clearInterval(this.heartbeatTimer);
    clearInterval(this.ownerWatchdog);
    clearTimeout(this.recoveryTimer);
    clearTimeout(this.recoveryExpiryTimer);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.closed = true;
      entry.writer?.close();
      safeClose(entry.connection);
    }
    for (const member of this.members.values()) {
      clearTimeout(member.graceTimer);
      this.abortResumeAttempt(member);
      if (member.streamEntry) member.streamEntry.closed = true;
      member.writer?.close();
      safeClose(member.connection);
    }
    this.writer?.close();
    safeClose(this.connection);
    this.closeTransports();
    const callback = this.callbacks.onClosed;
    this.mode = "none";
    this.resetState();
    this.closed = true;
    this.closing = false;
    this.emitState();
    callback(reason, { wasOwner, roomId: closedRoomId });
  }

  async requestTransferTickets({ kind, items, recipientIds, targetTransferId, targetRecipientId }) {
    if (!this.canSend || !["file", "voice"].includes(kind)) throw new Error("group transfer unavailable");
    const normalizedItems = normalizeItems(items, kind, this.limits);
    const uniqueRecipients = [...new Set(recipientIds || [])];
    if (!uniqueRecipients.length
      || uniqueRecipients.length > this.config.maxMembers - 1
      || uniqueRecipients.some((memberId) => !validEventID(memberId))) {
      throw new Error("invalid group transfer recipients");
    }
    if (uniqueRecipients.includes(this.memberId)) throw new Error("cannot transfer to yourself");
    if (!validTransferID(targetTransferId)
      || !validEventID(targetRecipientId)
      || !normalizedItems.some(({ transferId }) => transferId === targetTransferId)
      || !uniqueRecipients.includes(targetRecipientId)) throw new Error("invalid group transfer target");
    groupBatchBytes(normalizedItems, uniqueRecipients.length, this.config.maxBatchBytes);
    const request = {
      type: "TRANSFER_TICKET_REQUEST",
      gv: GROUP_PROTOCOL_VERSION,
      roomId: this.roomId,
      requestId: randomBase64URL(16),
      kind,
      items: normalizedItems,
      recipientIds: uniqueRecipients,
      targetTransferId,
      targetRecipientId,
    };
    if (this.mode === "owner") return this.issueTransferTickets(this.members.get(this.ownerId), request);
    if (!this.writer || this.recoveryActive) throw new Error("group owner is unavailable");
    const epoch = this.lifecycleEpoch;
    const roomId = this.roomId;
    const memberId = this.memberId;
    const writer = this.writer;
    const connection = this.connection;
    const waiters = this.ticketWaiters;
    const cancelledRequests = this.cancelledTicketRequests;
    const isCurrent = () => this.lifecycleEpoch === epoch
      && this.mode === "member"
      && this.roomId === roomId
      && this.memberId === memberId
      && this.writer === writer
      && this.connection === connection;
    const pending = deferred();
    pending.request = request;
    pending.timer = null;
    waiters.set(request.requestId, pending);
    try {
      const send = Promise.resolve().then(() => writer.send(request));
      const operation = Promise.all([send, pending.promise])
        .then(([, response]) => response);
      const response = await withTimeout(
        operation,
        this.config.ticketControlTimeoutMs || DEFAULT_FIRST_FRAME_TIMEOUT_MS,
        "transfer ticket request timed out",
        () => {
          if (waiters.get(request.requestId) === pending) waiters.delete(request.requestId);
          this.rememberTombstone(cancelledRequests, request.requestId);
          pending.reject(new Error("transfer ticket request timed out"));
          writer.close();
          safeClose(connection);
        },
      );
      if (!isCurrent()) throw new Error("group room changed during transfer ticket request");
      return response;
    } catch (error) {
      pending.reject(error);
      clearTimeout(pending.timer);
      if (waiters.get(request.requestId) === pending) waiters.delete(request.requestId);
      this.rememberTombstone(cancelledRequests, request.requestId);
      throw error;
    } finally {
      clearTimeout(pending.timer);
      if (waiters.get(request.requestId) === pending) waiters.delete(request.requestId);
    }
  }

  async handleTicketRequest(member, frame) {
    const epoch = this.lifecycleEpoch;
    const roomId = this.roomId;
    const writer = member?.writer;
    const connection = member?.connection;
    const isCurrent = () => this.lifecycleEpoch === epoch
      && this.mode === "owner"
      && this.roomId === roomId
      && this.members.get(member?.id) === member
      && member.writer === writer
      && member.connection === connection;
    let response;
    try {
      response = await this.issueTransferTickets(member, frame);
    } catch (error) {
      response = { error: "REJECTED", grants: [], failures: [] };
    }
    if (!isCurrent()) return;
    try {
      await withTimeout(writer.send({
        type: "TRANSFER_TICKET_RESPONSE",
        gv: GROUP_PROTOCOL_VERSION,
        roomId,
        requestId: validEventID(frame?.requestId) ? frame.requestId : "",
        ...response,
      }), this.config.ticketControlTimeoutMs || DEFAULT_FIRST_FRAME_TIMEOUT_MS, "transfer ticket response timed out", () => {
        writer?.close();
        safeClose(connection);
      });
    } catch (error) {
      if (isCurrent()) this.markMemberReconnecting(member, "TICKET_CONTROL");
      throw error;
    }
  }

  async issueTransferTickets(sender, frame) {
    this.pruneTickets();
    if (this.closing
      || this.roomPaused
      || !sender
      || this.members.get(sender.id) !== sender
      || sender.removed
      || sender.status !== "online"
      || !this.validateBaseFrame(frame)
      || !validEventID(frame?.requestId)
      || !["file", "voice"].includes(frame.kind)) {
      throw new Error("invalid transfer ticket request");
    }
    const epoch = this.lifecycleEpoch;
    const roomId = this.roomId;
    const issuedTickets = this.issuedTickets;
    const localTickets = this.tickets;
    const spentTickets = this.spentTickets;
    const armWaiters = this.ticketArmWaiters;
    const senderWriter = sender.writer || null;
    const senderConnection = sender.connection || null;
    const items = normalizeItems(frame.items, frame.kind, this.limits);
    const recipientIds = [...new Set(frame.recipientIds || [])];
    if (!recipientIds.length
      || recipientIds.length > this.config.maxMembers - 1
      || recipientIds.includes(sender.id)
      || recipientIds.some((memberId) => !validEventID(memberId))
      || !validTransferID(frame.targetTransferId)
      || !validEventID(frame.targetRecipientId)
      || !recipientIds.includes(frame.targetRecipientId)) {
      throw new Error("invalid transfer ticket recipients");
    }
    groupBatchBytes(items, recipientIds.length, this.config.maxBatchBytes);
    const item = items.find(({ transferId }) => transferId === frame.targetTransferId);
    if (!item) throw new Error("invalid transfer ticket target");
    const recipientId = frame.targetRecipientId;
    const recipient = this.members.get(recipientId);
    const recipientWriter = recipient?.writer || null;
    const recipientConnection = recipient?.connection || null;
    const isCurrent = () => this.lifecycleEpoch === epoch
      && this.mode === "owner"
      && this.roomId === roomId
      && this.members.get(sender.id) === sender
      && this.members.get(recipientId) === recipient
      && (sender.role === "owner"
        || (sender.writer === senderWriter && (sender.connection || null) === senderConnection))
      && (recipient.role === "owner"
        || (recipient.writer === recipientWriter && (recipient.connection || null) === recipientConnection));
    const fail = (reason) => Object.freeze({
      grants: [],
      failures: [Object.freeze({ recipientId, transferId: item.transferId, reason })],
    });
    if (!recipient || recipient.status !== "online") return fail("UNAVAILABLE");
    if (frame.kind === "file"
      && (recipient.capabilities?.file?.protocol !== "TCF1"
        || recipient.capabilities?.file?.receive !== true)) return fail("UNSUPPORTED");
    if (frame.kind === "voice" && recipient.capabilities?.voice?.enabled !== true) return fail("UNSUPPORTED");
    const recipientLimit = frame.kind === "file"
      ? Number(recipient.capabilities?.file?.maxBytes)
      : Number(recipient.capabilities?.voice?.maxBytes);
    if (!Number.isSafeInteger(recipientLimit) || item.size > recipientLimit) return fail("TOO_LARGE");
    let outstanding = 0;
    for (const issued of issuedTickets.values()) if (issued.senderId === sender.id) outstanding += 1;
    if (outstanding >= (this.config.maxOutstandingTicketsPerMember || 4)) return fail("BUSY");

    const expiresAt = this.now() + this.config.ticketTTLms;
    const ticket = randomBase64URL(32);
    const grant = Object.freeze({
      ticket,
      expiresAt,
      roomId,
      kind: frame.kind,
      senderId: sender.id,
      recipientId,
      transferId: item.transferId,
      size: item.size,
      address: recipient.address,
      gv: GROUP_PROTOCOL_VERSION,
    });
    issuedTickets.set(ticket, grant);
    try {
      if (recipient.role === "owner") {
        this.armTicket(grant);
      } else {
        const armed = deferred();
        armed.grant = grant;
        armed.timer = null;
        armWaiters.set(ticket, armed);
        try {
          const operation = Promise.all([
            Promise.resolve().then(() => recipientWriter.send({
              type: "TRANSFER_ARM",
              gv: GROUP_PROTOCOL_VERSION,
              ...grant,
              address: undefined,
            })),
            armed.promise,
          ]);
          await withTimeout(
            operation,
            this.config.ticketControlTimeoutMs || DEFAULT_FIRST_FRAME_TIMEOUT_MS,
            "transfer ticket arm timed out",
            () => {
              if (armWaiters.get(ticket) === armed) armWaiters.delete(ticket);
              armed.reject(new Error("transfer ticket arm timed out"));
              recipientWriter?.close();
              safeClose(recipientConnection);
            },
          );
        } catch (error) {
          armed.reject(error);
          if (isCurrent() && recipient.writer === recipientWriter) {
            this.markMemberReconnecting(recipient, "TICKET_CONTROL");
          }
          throw error;
        } finally {
          clearTimeout(armed.timer);
          if (armWaiters.get(ticket) === armed) armWaiters.delete(ticket);
        }
      }
      if (!isCurrent()
        || this.roomPaused
        || issuedTickets.get(ticket) !== grant
        || this.members.get(sender.id) !== sender
        || sender.status !== "online"
        || this.members.get(recipientId) !== recipient
        || recipient.status !== "online") throw new Error("transfer ticket invalidated while arming");
      return Object.freeze({ grants: [grant], failures: [] });
    } catch (_) {
      issuedTickets.delete(ticket);
      localTickets.delete(ticket);
      this.rememberTombstone(spentTickets, ticket);
      return fail("UNAVAILABLE");
    }
  }

  armTicket(frame) {
    if (!this.validateBaseFrame(frame)
      || this.roomPaused
      || !validID(frame.ticket, 32)
      || !validEventID(frame.senderId)
      || frame.recipientId !== this.memberId
      || !validTransferID(frame.transferId)
      || !["file", "voice"].includes(frame.kind)
      || !Number.isSafeInteger(frame.size)
      || frame.size < 0
      || !Number.isSafeInteger(frame.expiresAt)
      || frame.expiresAt < 1
      || this.tickets.has(frame.ticket)
      || this.spentTickets.has(frame.ticket)
      || this.members.get(frame.senderId)?.status !== "online"
      || this.members.get(frame.recipientId)?.status !== "online") throw new Error("invalid transfer ticket");
    const stored = Object.freeze({
      ticket: frame.ticket,
      // Host wall-clock time is not comparable to this browser's clock. The
      // online host remains the authority at consumption; this local deadline
      // only bounds retained state from the moment the arm arrives.
      expiresAt: this.now() + this.config.ticketTTLms,
      roomId: frame.roomId,
      kind: frame.kind,
      senderId: frame.senderId,
      recipientId: frame.recipientId,
      transferId: frame.transferId,
      size: frame.size,
    });
    this.tickets.set(frame.ticket, stored);
    // The owner is both the ticket authority and a possible receiver. Keeping
    // its local arm in the authority map makes the same validation path apply.
    if (this.mode === "owner" && !this.issuedTickets.has(frame.ticket)) this.issuedTickets.set(frame.ticket, stored);
    return stored;
  }

  resolveTicketArm(member, frame) {
    if (!this.validateBaseFrame(frame) || !validID(frame?.ticket, 32)) throw new Error("invalid transfer arm acknowledgement");
    const waiter = this.ticketArmWaiters.get(frame.ticket);
    if (!waiter) throw new Error("unknown or cross-member transfer arm acknowledgement");
    const grant = waiter.grant;
    if (member.id !== grant.recipientId
      || frame.ticketSenderId !== grant.senderId
      || frame.ticketRecipientId !== grant.recipientId
      || frame.transferId !== grant.transferId) throw new Error("cross-member transfer arm acknowledgement rejected");
    clearTimeout(waiter.timer);
    this.ticketArmWaiters.delete(frame.ticket);
    waiter.resolve();
  }

  consumeIssuedTicket(meta, recipientId) {
    this.pruneTickets();
    const ticket = this.issuedTickets.get(meta?.ticket);
    const sender = ticket ? this.members.get(ticket.senderId) : null;
    const recipient = ticket ? this.members.get(ticket.recipientId) : null;
    const valid = ticket
      && !this.roomPaused
      && ticket.roomId === this.roomId
      && meta.roomId === this.roomId
      && ticket.kind === meta.kind
      && ticket.senderId === meta.senderId
      && ticket.recipientId === recipientId
      && ticket.recipientId === meta.recipientId
      && ticket.transferId === meta.transferId
      && ticket.size === meta.size
      && this.now() <= ticket.expiresAt
      && sender?.status === "online"
      && recipient?.status === "online";
    if (!valid) throw new Error("invalid, expired, or replayed transfer ticket");
    this.issuedTickets.delete(ticket.ticket);
    this.rememberSpentTicket(ticket.ticket);
    return ticket;
  }

  async consumeTransferTicket(meta, kind, size) {
    this.pruneTickets();
    const epoch = this.lifecycleEpoch;
    const mode = this.mode;
    const roomId = this.roomId;
    const memberId = this.memberId;
    const writer = this.writer;
    const connection = this.connection;
    const tickets = this.tickets;
    const spentTickets = this.spentTickets;
    const consumingTickets = this.consumingTickets;
    const consumeWaiters = this.ticketConsumeWaiters;
    const cancelledRequests = this.cancelledTicketRequests;
    const isCurrent = () => this.lifecycleEpoch === epoch
      && this.mode === mode
      && this.roomId === roomId
      && this.memberId === memberId
      && (mode !== "member" || (this.writer === writer && this.connection === connection));
    const ticket = tickets.get(meta?.ticket);
    const sender = ticket ? this.members.get(ticket.senderId) : null;
    const recipient = ticket ? this.members.get(ticket.recipientId) : null;
    const valid = ticket
      && !this.roomPaused
      && meta?.gv === GROUP_PROTOCOL_VERSION
      && meta.roomId === this.roomId
      && ticket.roomId === this.roomId
      && ticket.kind === kind
      && ticket.senderId === meta.senderId
      && ticket.recipientId === this.memberId
      && ticket.recipientId === meta.recipientId
      && ticket.transferId === meta.transferId
      && ticket.size === size
      && ticket.size === meta.size
      && this.now() <= ticket.expiresAt
      && sender?.status === "online"
      && recipient?.status === "online"
      && !consumingTickets.has(ticket.ticket);
    if (!valid) throw new Error("invalid, expired, or replayed transfer ticket");
    consumingTickets.add(ticket.ticket);
    try {
      if (mode === "owner") {
        this.consumeIssuedTicket({ ...meta, kind, size }, this.ownerId);
      } else {
        if (mode !== "member" || !writer || this.recoveryActive) throw new Error("group owner is unavailable");
        const requestId = randomBase64URL(16);
        const pending = deferred();
        pending.ticket = ticket;
        pending.timer = null;
        consumeWaiters.set(requestId, pending);
        try {
          const operation = Promise.all([
            Promise.resolve().then(() => writer.send({
              type: "TRANSFER_CONSUME_REQUEST",
              gv: GROUP_PROTOCOL_VERSION,
              roomId,
              requestId,
              ticket: ticket.ticket,
              ticketSenderId: ticket.senderId,
              ticketRecipientId: ticket.recipientId,
              transferId: ticket.transferId,
              kind,
              size,
            })),
            pending.promise,
          ]);
          await withTimeout(
            operation,
            this.config.ticketControlTimeoutMs || DEFAULT_FIRST_FRAME_TIMEOUT_MS,
            "transfer ticket validation timed out",
            () => {
              if (consumeWaiters.get(requestId) === pending) consumeWaiters.delete(requestId);
              this.rememberTombstone(cancelledRequests, requestId);
              pending.reject(new Error("transfer ticket validation timed out"));
              writer.close();
              safeClose(connection);
            },
          );
          if (!isCurrent()) throw new Error("group room changed during transfer ticket validation");
        } catch (error) {
          pending.reject(error);
          this.rememberTombstone(cancelledRequests, requestId);
          throw error;
        } finally {
          clearTimeout(pending.timer);
          if (consumeWaiters.get(requestId) === pending) consumeWaiters.delete(requestId);
        }
      }
      tickets.delete(ticket.ticket);
      this.rememberTombstone(spentTickets, ticket.ticket);
      return ticket;
    } catch (error) {
      tickets.delete(ticket.ticket);
      this.rememberTombstone(spentTickets, ticket.ticket);
      throw error;
    } finally {
      consumingTickets.delete(ticket.ticket);
    }
  }

  async handleTicketConsume(member, frame) {
    if (!validEventID(frame?.requestId)) throw new Error("invalid transfer ticket validation request");
    const epoch = this.lifecycleEpoch;
    const roomId = this.roomId;
    const writer = member?.writer;
    const connection = member?.connection;
    const isCurrent = () => this.lifecycleEpoch === epoch
      && this.mode === "owner"
      && this.roomId === roomId
      && this.members.get(member?.id) === member
      && member.writer === writer
      && member.connection === connection;
    let accepted = false;
    let reason = "INVALID";
    try {
      this.consumeIssuedTicket({
        ticket: frame.ticket,
        roomId: frame.roomId,
        kind: frame.kind,
        senderId: frame.ticketSenderId,
        recipientId: frame.ticketRecipientId,
        transferId: frame.transferId,
        size: frame.size,
      }, member.id);
      accepted = true;
      reason = "";
    } catch (_) {
      accepted = false;
    }
    if (!isCurrent()) return;
    try {
      await withTimeout(writer.send({
        type: "TRANSFER_CONSUME_RESPONSE",
        gv: GROUP_PROTOCOL_VERSION,
        roomId,
        requestId: frame.requestId,
        ticket: validID(frame?.ticket, 32) ? frame.ticket : "",
        accepted,
        reason,
      }), this.config.ticketControlTimeoutMs || DEFAULT_FIRST_FRAME_TIMEOUT_MS, "transfer ticket validation response timed out", () => {
        writer?.close();
        safeClose(connection);
      });
    } catch (error) {
      if (isCurrent()) this.markMemberReconnecting(member, "TICKET_CONTROL");
      throw error;
    }
  }

  resolveTicketConsume(frame) {
    const waiter = this.ticketConsumeWaiters.get(frame?.requestId);
    if (!waiter) {
      if (this.cancelledTicketRequests.has(frame?.requestId)) return;
      throw new Error("unknown or cross-member transfer ticket validation response");
    }
    if (frame.ticket !== waiter.ticket.ticket || typeof frame.accepted !== "boolean") {
      throw new Error("invalid transfer ticket validation response");
    }
    clearTimeout(waiter.timer);
    this.ticketConsumeWaiters.delete(frame.requestId);
    if (frame.accepted) waiter.resolve();
    else waiter.reject(new Error(`transfer ticket rejected: ${String(frame.reason || "INVALID")}`));
  }

  pruneTickets() {
    const now = this.now();
    for (const [ticket, value] of this.tickets) if (value.expiresAt < now) this.tickets.delete(ticket);
    for (const [ticket, value] of this.issuedTickets) if (value.expiresAt < now) this.issuedTickets.delete(ticket);
    for (const [ticket, expiresAt] of this.spentTickets) if (expiresAt < now) this.spentTickets.delete(ticket);
    for (const [requestId, expiresAt] of this.cancelledTicketRequests) {
      if (expiresAt < now) this.cancelledTicketRequests.delete(requestId);
    }
  }

  rememberTombstone(map, key) {
    if (typeof key !== "string" || !key) return;
    // Tombstones only absorb late/replayed control frames. Keep them for one
    // local ticket lifetime and cap the LRU so sustained transfers cannot
    // grow browser memory without bound.
    if (map.has(key)) map.delete(key);
    map.set(key, this.now() + this.config.ticketTTLms);
    const configuredMaximum = Number(this.config.ticketTombstoneMaxItems);
    const maximum = Number.isSafeInteger(configuredMaximum) && configuredMaximum > 0
      ? configuredMaximum
      : 256;
    while (map.size > maximum) map.delete(map.keys().next().value);
  }

  rememberSpentTicket(ticket) {
    this.rememberTombstone(this.spentTickets, ticket);
  }

  rememberCancelledTicketRequest(requestId) {
    this.rememberTombstone(this.cancelledTicketRequests, requestId);
  }

  invalidateMemberTickets(memberId) {
    const addresses = this.memberTransportAddresses.get(memberId);
    if (addresses) {
      for (const address of addresses) this.dropTransport(address);
      this.memberTransportAddresses.delete(memberId);
    }
    for (const [ticket, value] of this.tickets) {
      if (value.senderId === memberId || value.recipientId === memberId) {
        this.tickets.delete(ticket);
        this.rememberSpentTicket(ticket);
      }
    }
    for (const [ticket, value] of this.issuedTickets) {
      if (value.senderId === memberId || value.recipientId === memberId) {
        this.issuedTickets.delete(ticket);
        this.rememberSpentTicket(ticket);
      }
    }
    for (const [ticket, waiter] of this.ticketArmWaiters) {
      if (waiter.grant.senderId === memberId || waiter.grant.recipientId === memberId) {
        clearTimeout(waiter.timer);
        this.ticketArmWaiters.delete(ticket);
        this.rememberSpentTicket(ticket);
        waiter.reject(new Error("transfer ticket revoked"));
      }
    }
    for (const [requestId, waiter] of this.ticketConsumeWaiters) {
      if (waiter.ticket.senderId === memberId || waiter.ticket.recipientId === memberId) {
        clearTimeout(waiter.timer);
        this.ticketConsumeWaiters.delete(requestId);
        this.rememberCancelledTicketRequest(requestId);
        waiter.reject(new Error("transfer ticket revoked"));
      }
    }
  }

  invalidateAllTickets(reason = "transfer tickets revoked") {
    for (const [ticket, value] of this.tickets) {
      this.rememberSpentTicket(ticket);
    }
    for (const [ticket, value] of this.issuedTickets) {
      this.rememberSpentTicket(ticket);
    }
    this.tickets.clear();
    this.issuedTickets.clear();
    this.consumingTickets.clear();
    for (const [requestId, waiter] of this.ticketWaiters) {
      clearTimeout(waiter.timer);
      this.rememberCancelledTicketRequest(requestId);
      waiter.reject(new Error(reason));
    }
    this.ticketWaiters.clear();
    for (const [ticket, waiter] of this.ticketArmWaiters) {
      clearTimeout(waiter.timer);
      this.rememberSpentTicket(ticket);
      waiter.reject(new Error(reason));
    }
    this.ticketArmWaiters.clear();
    for (const [requestId, waiter] of this.ticketConsumeWaiters) {
      clearTimeout(waiter.timer);
      this.rememberCancelledTicketRequest(requestId);
      waiter.reject(new Error(reason));
    }
    this.ticketConsumeWaiters.clear();
  }

  resolveTicketRequest(frame) {
    const waiter = this.ticketWaiters.get(frame?.requestId);
    if (!waiter) {
      if (this.cancelledTicketRequests.has(frame?.requestId)) return;
      throw new Error("unknown or cross-member ticket response");
    }
    clearTimeout(waiter.timer);
    this.ticketWaiters.delete(frame.requestId);
    if (frame.error) waiter.reject(new Error(String(frame.error)));
    else {
      const grants = Array.isArray(frame.grants) ? frame.grants : [];
      const failures = Array.isArray(frame.failures) ? frame.failures : [];
      const request = waiter.request;
      const item = request.items.find(({ transferId }) => transferId === request.targetTransferId);
      if (grants.length > 1
        || failures.length > 1
        || grants.length + failures.length !== 1
        || grants.some((grant) => !validID(grant?.ticket, 32)
          || grant.gv !== GROUP_PROTOCOL_VERSION
          || grant.roomId !== this.roomId
          || grant.kind !== request.kind
          || grant.senderId !== this.memberId
          || grant.recipientId !== request.targetRecipientId
          || grant.transferId !== request.targetTransferId
          || grant.size !== item.size
          || !this.validAddress(grant.address)
          || !Number.isSafeInteger(grant.expiresAt)
          || grant.expiresAt < 1)
        || failures.some((failure) => failure?.recipientId !== request.targetRecipientId
          || failure?.transferId !== request.targetTransferId
          || typeof failure?.reason !== "string")) {
        waiter.reject(new Error("invalid transfer ticket response"));
        return;
      }
      for (const grant of grants) {
        let addresses = this.memberTransportAddresses.get(grant.recipientId);
        if (!addresses) {
          addresses = new Set();
          this.memberTransportAddresses.set(grant.recipientId, addresses);
        }
        addresses.add(grant.address);
      }
      waiter.resolve(Object.freeze({ grants, failures }));
    }
  }
}
