import { APP_CONFIG, defaultRegionCode, regionByCode } from "./config.js";
import { FileTransportManager, supportsNativeFiles } from "./file-transport-manager.js";
import { FileCoordination, sendCoordinatedFile, receiveCoordinatedFile } from "./file-coordination.js";
import { CompletedFileReceipts } from "./file-transfer-state.js";
import {
  FILE_SINK_KIND,
  FILE_SINK_REASON,
  createFileSink,
  getReceiveCapacity,
  initializeFileSinks,
  probeFileSinkSupport,
  resetFileSink,
} from "./file-sinks.js";
import { createI18n } from "./i18n.js";
import {
  GROUP_PROTOCOL_VERSION,
  GroupFrameReader,
  GroupFrameWriter,
  GroupReplayBuffer,
  RecentEventDeduper,
  groupBatchBytes,
  makeGroupInviteURL,
  normalizeGroupDisplayName,
  parseGroupInviteFragment,
  randomBase64URL,
  validBase64URL,
} from "./group-protocol.js";
import { GroupRoomController } from "./group-room.js";
import {
  createScreenWakeLockManager,
  inspectMobileRuntime,
  subscribePageLifecycle,
  syncVisualViewportCSSVariables,
} from "./mobile-runtime.js";
import { encode as encodeQR } from "./vendor/uqr.js";

const $ = (id) => document.getElementById(id);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const i18n = createI18n();
const { t } = i18n;
const TCH_MAGIC = new Uint8Array([0x54, 0x43, 0x48, 0x31]); // TCH1
const TCF_MAGIC = new Uint8Array([0x54, 0x43, 0x46, 0x31]); // TCF1
const TCV_MAGIC = new Uint8Array([0x54, 0x43, 0x56, 0x31]); // TCV1 group voice
const FILE_FRAME = Object.freeze({ META: 1, DATA: 2, FINAL: 3, CANCEL: 4 });
const nativeFilePeers = new Map();
const nativeFileReceipts = new CompletedFileReceipts();

function nativeFilesEnabled() {
  return APP_CONFIG.nativeFileTransfer.enabled && typeof RTCPeerConnection === "function";
}

function forceDerpFiles() {
  try { return localStorage.getItem("tailcat.forceDerp") === "1"; } catch (_) { return false; }
}

function nativeFileSupported(context, peerId) {
  if (!nativeFilesEnabled()) return false;
  if (context.mode !== "group") return supportsNativeFiles(peerCapabilities);
  const snapshot = groupRoom?.snapshot();
  return Boolean(snapshot && supportsNativeFiles(snapshot.members.find((member) => member.id === snapshot.ownerId)?.capabilities)
    && supportsNativeFiles(snapshot.members.find((member) => member.id === peerId)?.capabilities));
}

function closeNativeFilePeers(groupOnly = false) {
  for (const [key, peer] of nativeFilePeers) {
    if (groupOnly && !peer.group) continue;
    peer.manager.close();
    peer.controlClient?.close();
    for (const mux of peer.muxes) mux.close();
    nativeFilePeers.delete(key);
  }
  nativeFileReceipts.clear();
}

function nativeFilePeer(context, incoming) {
  const group = context.mode === "group";
  const room = group ? context.roomId : context.session;
  const localId = group ? groupRoom.memberId : listener?.addr;
  const peerId = group ? (incoming ? context.senderId : context.recipientId) : activePeerAddress;
  const key = JSON.stringify([room, peerId]);
  let peer = nativeFilePeers.get(key);
  if (peer) return peer;
  const controller = groupRoom, epoch = controller?.lifecycleEpoch;
  const authorized = () => group
    ? groupRoom === controller && controller.active && controller.lifecycleEpoch === epoch && controller.roomId === room
      && !controller.snapshot().roomPaused && controller.snapshot().members.some((member) => member.id === peerId && member.status === "online")
    : activeSession === room && activePeerAddress === peerId && listener?.addr === localId;
  peer = { group, room, peerId, authorized, muxes: new Set(), manager: null, controlClient: null, controlStarting: null };
  peer.manager = new FileTransportManager({ room, localId, peerId, isAuthorized: authorized,
    sendSignal: (signal) => {
      if (!group) return sendNativeFileSignal(peer, signal);
      const mux = [...peer.muxes].find((item) => !item.closed);
      if (!mux) throw new Error("native file coordinator closed");
      return mux.notify("SIGNAL", signal);
    },
  });
  nativeFilePeers.set(key, peer);
  return peer;
}

async function nativeFileControlClient(peer) {
  if (!peer.authorized()) throw new Error("AUTHORIZATION_EXPIRED");
  // A cold Tailcat Client per ICE candidate spends the direct-setup deadline
  // repeatedly establishing relay identity. Reuse a room-bound Client for
  // native signaling, while preserving the authenticated port-100 envelope.
  if (!peer.controlStarting) {
    peer.controlStarting = tailcatConnect({ addr: peer.peerId, derpMapURL: APP_CONFIG.derpMapURL }).then((client) => {
      if (!peer.authorized()) { client.close(); throw new Error("AUTHORIZATION_EXPIRED"); }
      peer.controlClient = client; return client;
    });
    peer.controlStarting.catch(() => { peer.controlStarting = null; });
  }
  return peer.controlStarting;
}

function attachNativeSignalPipe(peer, connection) {
  if (peer.signalPipes?.size >= 2) throw new Error("native signal pipe limit");
  peer.signalPipes ||= new Set();
  const mux = new FileCoordination(connection, { authorized: peer.authorized,
    signal: (signal) => peer.manager.handleSignal(signal) });
  mux.handlers.set("READY", () => true);
  peer.signalPipes.add(mux);
  peer.muxes.add(mux);
  if (!peer.signalPipe || peer.signalPipe.closed) peer.signalPipe = mux;
  void mux.ended.promise.then(() => {
    peer.signalPipes.delete(mux); peer.muxes.delete(mux);
    if (peer.signalPipe === mux) peer.signalPipe = null;
  });
  return mux;
}

async function nativeFileSignalPipe(peer) {
  if (peer.signalPipe && !peer.signalPipe.closed) return peer.signalPipe;
  if (!peer.signalOpening) {
    peer.signalOpening = (async () => {
      const client = await nativeFileControlClient(peer);
      if (peer.signalPipe && !peer.signalPipe.closed) return peer.signalPipe;
      const connection = await client.dial({ port: APP_CONFIG.ports.control });
      let mux;
      try {
        if (!peer.authorized()) throw new Error("AUTHORIZATION_EXPIRED");
        await writeChunked(connection, packChatEnvelope({ v: APP_CONFIG.protocolVersion,
          session: peer.room, type: "NATIVE_FILE_SIGNAL_PIPE" }, new Uint8Array()));
        mux = attachNativeSignalPipe(peer, connection);
        await mux.rpc("READY", null);
        return mux;
      } catch (error) { mux?.close(); connection.close(); throw error; }
    })().finally(() => { peer.signalOpening = null; });
  }
  return peer.signalOpening;
}

async function sendNativeFileSignal(peer, signal) {
  const mux = await nativeFileSignalPipe(peer);
  return mux.notify("SIGNAL", signal);
}

function nativeFilePath(ui, path, recipientId = "") {
  const item = recipientId ? ui.statuses.get(recipientId)?.item : ui.item;
  if (!item) return;
  item.classList.add("native-file-transfer");
  item.dataset.transport = path;
  if (path === "webrtc" || path === "derp") item.dataset.route = path;
  if (path === "retrying") item.dataset.route = "derp";
  let label = item.querySelector(".native-file-path");
  if (!label) { label = document.createElement("span"); label.className = "native-file-path"; item.append(label); }
  label.dataset.i18n = `file_path_${path}`;
  label.textContent = t(`file_path_${path}`);
  if (recipientId) {
    let progress = item.querySelector("progress");
    if (!progress) {
      progress = document.createElement("progress"); progress.max = 1; progress.value = 0;
      progress.setAttribute("aria-label", t("transfer_progress")); item.append(progress);
    }
    if (path === "retrying") progress.value = 0;
    if (path === "verified") progress.value = 1;
  } else if (path === "retrying") ui.progress.value = 0;
}

function makeFileCoordination(connection, peer, authorized, readInitial) {
  const mux = new FileCoordination(connection, { authorized,
    signal: (value) => peer.manager.handleSignal(value), readInitial });
  peer.muxes.add(mux);
  void mux.ended.promise.then(() => peer.muxes.delete(mux));
  return mux;
}

async function sendNativeFileBody(entry, connection, context, onDigest) {
  const reader = new ConnectionReader(connection);
  const hasher = tailcatNewSHA256();
  let sent = 0;
  try {
    while (sent < entry.file.size) {
      if (entry.cancelled) throw new Error("CANCELLED");
      const end = Math.min(sent + APP_CONFIG.limits.fileChunkBytes, entry.file.size);
      const chunk = new Uint8Array(await entry.file.slice(sent, end).arrayBuffer());
      if (chunk.length !== end - sent) throw new Error("FILE_CHANGED");
      await hasher.update(chunk);
      await connection.write(packFileFrame(FILE_FRAME.DATA, chunk));
      sent = end;
      if (context.mode !== "group") {
        tcTest.sentBytes = sent;
        entry.ui.progress.value = entry.file.size ? sent / entry.file.size : 1;
        entry.ui.detail.textContent = format("file_sending", { name: entry.name, sent: humanSize(sent), total: humanSize(entry.file.size) });
      } else {
        const progress = entry.ui.statuses.get(context.recipientId)?.item.querySelector("progress");
        if (progress) progress.value = entry.file.size ? sent / entry.file.size : 1;
      }
      noteFileTraffic(context);
    }
    const digest = await hasher.digestHex(); onDigest(digest);
    await connection.write(packFileJSON(FILE_FRAME.FINAL, fileWireMeta(context, "FINAL", { size: sent, sha256: digest })));
    const done = decodeFileJSON(await readFileFrame(reader), [FILE_FRAME.FINAL, FILE_FRAME.CANCEL]);
    if (!fileWireMatches(done, context) || done.type !== "DONE" || done.size !== sent || done.sha256 !== digest) {
      throw new Error("RECEIVER_VERIFICATION_FAILED");
    }
    connection.acknowledgeRead();
    return { state: "committed", size: sent, sha256: digest };
  } finally { hasher.close(); }
}

async function sendNativeAcceptedFile(entry, connection, context, incomingResponse, grant = null) {
  const peer = nativeFilePeer(context, false);
  const current = () => peer.authorized() && !entry.cancelled
    && (!grant || !entry.invalidRecipients.has(grant.recipientId));
  const mux = makeFileCoordination(connection, peer, current);
  let digest = "";
  let result;
  try { result = await sendCoordinatedFile({ mux, manager: peer.manager, attemptId: context.transferId,
    forceDerp: forceDerpFiles() || incomingResponse.forceDerp === true,
    authorized: current, expectedDigest: () => digest,
    onPath: (path) => nativeFilePath(entry.ui, path, grant?.recipientId),
    sendBody: (stream, attemptId) => {
      digest = "";
      return sendNativeFileBody(entry, stream, { ...context, transferId: attemptId }, (value) => { digest = value; });
    },
    retryGrant: async (attemptId) => {
      if (!grant) return null;
      const response = await groupRoom.requestTransferTickets({ kind: "file",
        items: [{ transferId: attemptId, size: entry.file.size }], recipientIds: [grant.recipientId],
        targetTransferId: attemptId, targetRecipientId: grant.recipientId });
      const next = response.grants[0];
      if (!next) throw new Error("RETRY_TICKET_REJECTED");
      return next;
    },
  }); } catch (error) {
    nativeFilePath(entry.ui, error.code === "RESULT_UNCONFIRMED" ? "unconfirmed" : (entry.cancelled ? "cancelled" : "failed"), grant?.recipientId);
    throw error;
  }
  if (result.size !== entry.file.size || result.sha256 !== digest) throw new Error("RECEIVER_VERIFICATION_FAILED");
  nativeFilePath(entry.ui, "verified", grant?.recipientId);
  if (!grant) {
    tcTest.sendDone = true; tcTest.sentSha256 = digest; tcTest.sentBytes = entry.file.size;
    entry.ui.progress.value = 1; entry.ui.detail.textContent = t("file_sent");
    addMessage({ type: "file", mine: true, name: entry.name, size: entry.file.size, status: t("file_sent") });
    setStatus(t("file_sent"), "connected");
  }
}
const DB_NAME = "tailcat-app";
const DB_STORE = "private-settings";
const DB_KEY = "remembered-listener";
const CANONICAL_ORIGIN = "https://tailcat.app/";
const STREAM_READ_TIMEOUT_MS = 30_000;
// The Go/WASM bridge intentionally exposes at most one 64 KiB network read.
// Exact protocol reads pass their remaining length as a smaller bound so a
// frame body can never be pulled into JavaScript before its header is accepted.
const CONNECTION_READ_MAX_BYTES = 64 * 1024;
const FILE_DECISION_TIMEOUT_MS = 2 * 60 * 1000;
const GROUP_TICKET_CONTROL_TIMEOUT_MS = APP_CONFIG.group.ticketControlTimeoutMs || STREAM_READ_TIMEOUT_MS;
// Covers offer parsing, ticket validation, bounded local capacity checks, the
// complete user decision window, and the response write. A sender must never
// time out before a receiver's legitimate 120-second consent window ends.
const TRANSFER_DECISION_DEADLINE_MS = FILE_DECISION_TIMEOUT_MS
  + GROUP_TICKET_CONTROL_TIMEOUT_MS
  + (3 * STREAM_READ_TIMEOUT_MS)
  + 5_000;
const VOICE_DECISION_DEADLINE_MS = TRANSFER_DECISION_DEADLINE_MS;
const VOICE_DATA_DEADLINE_MS = APP_CONFIG.limits.voiceSeconds * 1000 + STREAM_READ_TIMEOUT_MS;
const FILE_DATA_MIN_BYTES_PER_SECOND = 64 * 1024;
const FILE_DATA_MAX_DEADLINE_MS = 2 * 60 * 60 * 1000;
const TRANSFER_CANCEL_MAX_BYTES = 2 * 1024;
// A complete handshake can require three sequential Tailcat dials. Each dial
// may take up to roughly one minute while a DERP path is established.
const HANDSHAKE_TIMEOUT_MS = 4 * 60 * 1000;
const HANDSHAKE_CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;
const MESSAGE_HISTORY_MAX_ITEMS = 100;
const MESSAGE_HISTORY_MAX_BYTES = 32 * 1024 * 1024;
const HANDSHAKE_REPLY_LIMIT = 8;
const HANDSHAKE_REPLY_WINDOW_MS = 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_FAILURE_LIMIT = 2;
const HEARTBEAT_RESPONSE_TIMEOUT_MS = 20 * 1000;
const MAX_PENDING_FILES = 100;
const MAX_TRANSFER_HISTORY_ITEMS = 100;
const DB_PROBE_KEY = `${DB_KEY}-probe`;
const VOICE_MIME_CANDIDATES = Object.freeze([
  "audio/webm;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm",
]);

// Read the invite before any transport starts, then immediately remove it from
// the visible URL. Fragments never travel in HTTP requests, Referer headers, or
// Cloudflare logs; removing it also avoids leaking it in screenshots/history.
function consumeInviteFragment() {
  const raw = location.hash.slice(1);
  if (!raw) return Object.freeze({ address: "", group: null });
  let address = "";
  let group = null;
  try {
    const fragment = new URLSearchParams(raw);
    if (!fragment.has("invite") && !fragment.has("v")) return Object.freeze({ address: "", group: null });
    group = parseGroupInviteFragment(fragment, {
      appVersion: APP_CONFIG.protocolVersion,
      validAddress,
    });
    if (!group
      && fragment.get("mode") !== "group"
      && fragment.get("v") === String(APP_CONFIG.protocolVersion)) {
      address = fragment.get("invite") || "";
    }
  } catch (_) {
    return Object.freeze({ address: "", group: null });
  }
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return Object.freeze({ address: validAddress(address) ? address : "", group });
}

const hadInviteFragment = Boolean(location.hash);
const consumedInvite = consumeInviteFragment();
let pendingInviteAddress = consumedInvite.address;
let pendingGroupInvite = consumedInvite.group;
let groupRoom = null;
let listenerMode = "none";

function validAddress(value) {
  return typeof value === "string"
    && value.length >= 32
    && value.length <= 8192
    && value.startsWith("tc")
    && !/[\s\u0000-\u001f\u007f#]/u.test(value);
}

function inviteURL(address) {
  const url = new URL(invitationOrigin());
  url.hash = new URLSearchParams({ v: String(APP_CONFIG.protocolVersion), invite: address }).toString();
  return url.toString();
}

function invitationOrigin() {
  if (APP_CONFIG.previewInvitesEnabled && location.protocol === "https:") {
    return new URL("/", location.origin).toString();
  }
  return CANONICAL_ORIGIN;
}

function groupInviteURL() {
  if (!groupRoom?.roomId || !groupRoom.joinToken || !groupRoom.hostAddress) return "";
  return makeGroupInviteURL(invitationOrigin(), {
    address: groupRoom.hostAddress,
    roomId: groupRoom.roomId,
    joinToken: groupRoom.joinToken,
    appVersion: APP_CONFIG.protocolVersion,
  });
}

function browserSupport() {
  const runtime = inspectMobileRuntime();
  const { platform } = runtime;
  const ua = navigator.userAgent || "";
  const android = platform.os === "android";
  const ios = platform.os === "ios";
  const safari = platform.browser === "safari";
  const firefox = platform.browser === "firefox";
  const edge = platform.browser === "edge";
  const chrome = platform.browser === "chrome";
  const androidChromeVersion = Number(/Chrome\/(\d+)/u.exec(ua)?.[1] || 0);
  const iosSafariVersion = Number(/Version\/(\d+)/u.exec(ua)?.[1] || 0);
  const minimumVersionMet = platform.channel === "android-chrome"
    ? androidChromeVersion >= 132
    : platform.channel === "ios-safari"
      ? iosSafariVersion >= 17
      : true;
  const compactTouchLayout = window.matchMedia?.("(max-width: 1024px) and (pointer: coarse)").matches === true;
  const channelEnabled = (!android || APP_CONFIG.mobile.androidEnabled)
    && (!ios || APP_CONFIG.mobile.iosEnabled);
  return {
    runtime,
    platform,
    android,
    edge,
    chrome,
    ios,
    safari,
    firefox,
    mobile: platform.isMobile || compactTouchLayout,
    minimumVersionMet,
    limited: !platform.officiallySupported || !minimumVersionMet,
    ok: runtime.coreReady && channelEnabled,
  };
}

const support = browserSupport();

const tcTest = {
  ready: false,
  inviteConsumed: hadInviteFragment && location.hash === "",
  unsupported: !support.ok,
  runtime: {
    coreReady: support.runtime.coreReady,
    missing: [...support.runtime.capabilities.missing],
    channel: support.platform.channel,
    officiallySupported: support.platform.officiallySupported && support.minimumVersionMet,
  },
  listenAddr: null,
  recvBytes: 0,
  recvSha256: null,
  recvDone: false,
  sentBytes: 0,
  sentSha256: null,
  sendDone: false,
  errors: [],
  state: {
    transport: "loading",
    room: "closed",
    peer: "none",
    file: "idle",
  },
  protocol: Object.freeze({
    version: APP_CONFIG.protocolVersion,
    file: "TCF1",
    chunkBytes: APP_CONFIG.limits.fileChunkBytes,
    privateFileAutoReceiveBytes: APP_CONFIG.limits.privateFileAutoReceiveBytes,
    ports: APP_CONFIG.ports,
  }),
};
Object.defineProperty(window, "tcTest", { value: tcTest, enumerable: false, configurable: false });

let persistenceAvailable = typeof globalThis.indexedDB !== "undefined";
let fileSinkSupport = Object.freeze({
  preferredKind: null,
  maxBytes: 0,
  picker: Object.freeze({ supported: false, maxBytes: 0 }),
  opfs: Object.freeze({ supported: false, receivable: false, maxBytes: 0, reason: FILE_SINK_REASON.NO_SINK }),
});
let pageWasBackgrounded = false;
let resumeCheckInFlight = null;
let groupCreateOperation = 0;
let groupJoinOperation = 0;
let groupWakeLockFailed = false;
let qrScope = null;
const transferItemCleanups = new WeakMap();
const stagedTransferItems = new Set();
const groupTransferItems = new Set();
const groupTransferRooms = new WeakMap();
const wakeLocks = createScreenWakeLockManager({ onError: handleWakeLockError });
const visualViewportSync = syncVisualViewportCSSVariables();

function redact(value) {
  return String(value || "")
    .replace(/tc[^\s"']{8,}/g, "[tailcat-address]")
    .replace(/#(?:[^\s"']+)/g, "#[invite-removed]");
}

function groupErrorCategory(error) {
  const raw = String(error?.message || error);
  if (/(?:timed? out|timeout|expired)/iu.test(raw)) return "GROUP_TIMEOUT";
  if (/(?:queue|slow|backpressure|busy)/iu.test(raw)) return "GROUP_BACKPRESSURE";
  if (/(?:invalid|reject|forg|cross-|protocol|ticket|session)/iu.test(raw)) return "GROUP_PROTOCOL_REJECTED";
  return "GROUP_RUNTIME_ERROR";
}

function recordError(error, scope = "auto") {
  const groupScoped = scope === "group"
    || (scope === "auto" && (groupRoom?.active || listenerMode === "group"));
  const message = groupScoped ? groupErrorCategory(error) : redact(error?.message || error);
  tcTest.errors.push(message.slice(0, 500));
  if (tcTest.errors.length > 30) tcTest.errors.shift();
}

function recordGroupError(error) {
  recordError(error, "group");
}

function handleWakeLockError(error) {
  if (support.mobile && groupRoom?.mode === "owner") {
    recordGroupError(error);
    groupWakeLockFailed = true;
    $("group-wake-lock-alert").classList.remove("hidden");
    setStatus(t("group_wake_lock_failed"), "error");
  } else {
    recordError(error);
  }
}

window.addEventListener("error", (event) => recordError(event.error || event.message));
window.addEventListener("unhandledrejection", (event) => recordError(event.reason));

function format(templateKey, values = {}) {
  return t(templateKey, values);
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function equalBytes(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function concatBytes(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function randomID(bytes = 16) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sanitizeFileName(input) {
  const leaf = String(input || "file").split(/[\\/]/u).pop() || "file";
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+$/u, "");
  return Array.from(cleaned || "file").slice(0, APP_CONFIG.limits.fileNameChars).join("");
}

function safeMime(input, prefix = "") {
  const value = String(input || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value)) {
    return prefix === "audio/" ? "audio/webm" : "application/octet-stream";
  }
  if (prefix && !value.startsWith(prefix)) return prefix === "audio/" ? "audio/webm" : "application/octet-stream";
  return value;
}

function safeVoiceMime(input) {
  const value = String(input || "").trim().toLowerCase();
  if (VOICE_MIME_CANDIDATES.includes(value)) return value;
  const parameterized = /^(audio\/(?:webm|mp4))[ \t]*;[ \t]*codecs[ \t]*=[ \t]*(?:"(opus|mp4a\.40\.2)"|(opus|mp4a\.40\.2))[ \t]*$/u.exec(value);
  if (!parameterized) return "";
  const [, container, quotedCodec, bareCodec] = parameterized;
  const codec = quotedCodec || bareCodec;
  if (container === "audio/webm" && codec === "opus") return "audio/webm;codecs=opus";
  if (container === "audio/mp4" && codec === "mp4a.40.2") return "audio/mp4;codecs=mp4a.40.2";
  return "";
}

function recordableVoiceTypes() {
  if (!window.MediaRecorder) return [];
  if (typeof MediaRecorder.isTypeSupported !== "function") return ["audio/webm"];
  return VOICE_MIME_CANDIDATES.filter((type) => MediaRecorder.isTypeSupported(type));
}

function playableVoiceTypes() {
  const audio = document.createElement("audio");
  return VOICE_MIME_CANDIDATES.filter((type) => audio.canPlayType(type) !== "");
}

function selectMutualVoiceType(localTypes, remoteTypes) {
  const local = Array.isArray(localTypes) ? localTypes.map(safeVoiceMime).filter(Boolean) : [];
  if (!Array.isArray(remoteTypes)) return local[0] || "";
  const remote = new Set(remoteTypes.map(safeVoiceMime).filter(Boolean));
  return local.find((type) => remote.has(type)) || "";
}

function selectedVoiceRecordType() {
  return selectMutualVoiceType(recordableVoiceTypes(), peerCapabilities?.voice?.playTypes);
}

function groupMemberSupportsVoiceMime(member, mime) {
  const normalized = safeVoiceMime(mime);
  return Boolean(normalized && (member?.capabilities?.voice?.playTypes || [])
    .map(safeVoiceMime)
    .includes(normalized));
}

function selectedGroupVoiceRecordType(recipients = selectedGroupMembers()) {
  const capable = recipients.filter((member) => groupMemberCanReceive(member, "voice"));
  const localTypes = recordableVoiceTypes().map(safeVoiceMime).filter(Boolean);
  let best = "";
  let bestCount = 0;
  for (const type of localTypes) {
    const count = capable.filter((member) => groupMemberSupportsVoiceMime(member, type)).length;
    if (count > bestCount) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}

function validFileSize(size) {
  return Number.isSafeInteger(size) && size >= 0 && size <= APP_CONFIG.limits.fileBytes;
}

function resetPrivateAutoReceiveBudget(session = "") {
  privateAutoReceiveBudget = { session, bytes: 0, items: 0 };
}

function canAutoReceivePrivateFile(size, session) {
  return Number.isSafeInteger(size)
    && size >= 0
    && size <= APP_CONFIG.limits.privateFileAutoReceiveBytes
    && privateAutoReceiveBudget.session === session
    && privateAutoReceiveBudget.items < APP_CONFIG.limits.privateFileAutoReceiveSessionItems
    && privateAutoReceiveBudget.bytes + size <= APP_CONFIG.limits.privateFileAutoReceiveSessionBytes
    && stagedTransferItems.size < APP_CONFIG.limits.privateFileAutoReceiveSessionItems
    && fileSinkSupport.opfs.receivable === true
    && Number(fileSinkSupport.opfs.maxBytes) >= size;
}

function consumePrivateAutoReceiveBudget(size, session) {
  if (privateAutoReceiveBudget.session !== session) return false;
  if (privateAutoReceiveBudget.items >= APP_CONFIG.limits.privateFileAutoReceiveSessionItems
    || privateAutoReceiveBudget.bytes + size > APP_CONFIG.limits.privateFileAutoReceiveSessionBytes) return false;
  privateAutoReceiveBudget.items += 1;
  privateAutoReceiveBudget.bytes += size;
  return true;
}

function setStatus(message, state = "loading") {
  $("status").textContent = message;
  $("status-dot").className = `status-dot ${state}`;
}

function setMobileSheet(open) {
  const hasRoomControls = Boolean(activeSession || groupRoom?.active || stagedTransferItems.size);
  const expanded = Boolean(open && support.mobile && hasRoomControls);
  $("app").dataset.mobileSheet = expanded ? "open" : "closed";
  $("mobile-menu-btn")?.setAttribute("aria-expanded", String(expanded));
  $("mobile-controls-sheet")?.setAttribute("aria-hidden", String(support.mobile && hasRoomControls && !expanded));
}

function setMobileState(state) {
  if (!["landing", "waiting", "connecting", "connected", "call"].includes(state)) return;
  $("app").dataset.mobileState = state;
  if (state !== "connected") setMobileSheet(false);
}

function restingMobileState() {
  if (stagedTransferItems.size) return "connected";
  if (groupRoom?.active) return groupRoom.mode === "pending" ? "connecting" : "connected";
  return listener ? "waiting" : "landing";
}

function setPersistenceAvailable(available) {
  persistenceAvailable = Boolean(available);
  const checkbox = $("persist-key");
  checkbox.disabled = !persistenceAvailable || tcTest.state.room !== "closed";
  if (!persistenceAvailable) checkbox.checked = false;
  checkbox.closest(".check-row")?.classList.toggle("hidden", !persistenceAvailable);
  $("persist-risk").classList.toggle("hidden", !persistenceAvailable || !checkbox.checked);
  if (!persistenceAvailable) $("forget-key").classList.add("hidden");
  $("persistent-unavailable").classList.toggle("hidden", persistenceAvailable);
}

function renderRuntimeCapabilityNote() {
  const notes = [];
  if (support.limited) notes.push(t("capability_limited"));
  if (!fileSinkSupport.preferredKind) notes.push(t("file_receive_unavailable"));
  const note = $("capability-note");
  note.textContent = notes.join(" ");
  note.classList.toggle("hidden", notes.length === 0);
}

async function refreshFileSinkSupport() {
  try {
    await initializeFileSinks();
    fileSinkSupport = await probeFileSinkSupport({ hardMaxBytes: APP_CONFIG.limits.fileBytes });
  } catch (error) {
    recordError(error);
  }
  tcTest.runtime.fileSink = {
    kind: fileSinkSupport.preferredKind,
    maxBytes: fileSinkSupport.maxBytes,
    picker: fileSinkSupport.picker.supported,
    opfs: fileSinkSupport.opfs.receivable,
    privateAutoReceiveMaxBytes: fileSinkSupport.opfs.receivable
      ? Math.min(APP_CONFIG.limits.privateFileAutoReceiveBytes, fileSinkSupport.opfs.maxBytes)
      : 0,
  };
  renderRuntimeCapabilityNote();
  return fileSinkSupport;
}

function setMediaStatus(message) {
  $("media-status").textContent = message;
}

function setComposerEnabled(enabled) {
  for (const id of ["send-text", "send-text-btn"]) {
    $(id).disabled = !enabled;
  }
  const capabilities = localCapabilities();
  if (groupRoom?.active) {
    const recipients = selectedGroupMembers();
    $("voice-call-btn").disabled = true;
    $("video-call-btn").disabled = true;
    $("screen-share-btn").disabled = true;
    $("attach-btn").disabled = !enabled || !recipients.some((member) => groupMemberCanReceive(member, "file"));
    $("ptt-btn").disabled = !enabled
      || !capabilities.voice.enabled
      || !recipients.some((member) => groupMemberCanReceive(member, "voice"));
    return;
  }
  $("voice-call-btn").disabled = !enabled || !capabilities.rtc.voice || peerCapabilities?.rtc?.voice !== true;
  $("video-call-btn").disabled = !enabled || !capabilities.rtc.video || peerCapabilities?.rtc?.video !== true;
  $("attach-btn").disabled = !enabled || !peerCanReceiveFiles();
  $("ptt-btn").disabled = !enabled || !capabilities.voice.enabled || peerCapabilities?.voice?.enabled !== true;
  const screenEnabled = enabled
    && capabilities.rtc.screen
    && (peerCapabilities?.rtc?.screenReceive === true || peerCapabilities?.rtc?.video === true);
  $("screen-share-btn").disabled = !screenEnabled;
}

function rebuildRegions() {
  const current = $("region-select").value || defaultRegionCode();
  $("region-select").replaceChildren(...APP_CONFIG.regions.map((region) => {
    const option = document.createElement("option");
    option.value = region.code;
    option.textContent = t(region.labelKey);
    return option;
  }));
  $("region-select").value = regionByCode(current).code;
}

function applyLanguage(language) {
  i18n.setLanguage(language);
  $("language-select").value = i18n.language;
  $("blocked-language-select").value = i18n.language;
  rebuildRegions();
  renderConnectionState();
  renderRuntimeCapabilityNote();
  if (support.mobile) {
    $("ptt-btn").title = t("voice_tap_start");
    $("ptt-btn").setAttribute("aria-label", t("voice_tap_start"));
  }
  updateMediaControls();
}

i18n.apply();
$("language-select").value = i18n.language;
$("blocked-language-select").value = i18n.language;
$("language-select").addEventListener("change", (event) => applyLanguage(event.target.value));
$("blocked-language-select").addEventListener("change", (event) => applyLanguage(event.target.value));
rebuildRegions();
$("region-select").value = defaultRegionCode();
$("android-note").classList.toggle("hidden", support.platform.channel !== "android-chrome");
$("ios-note").classList.toggle("hidden", support.platform.channel !== "ios-safari");
$("screen-share-btn").classList.toggle("hidden", support.mobile || !navigator.mediaDevices?.getDisplayMedia);
if (support.mobile) {
  $("ptt-btn").title = t("voice_tap_start");
  $("ptt-btn").setAttribute("aria-label", t("voice_tap_start"));
}
renderRuntimeCapabilityNote();

if (!support.ok) {
  $("app").classList.add("hidden");
  $("browser-blocker").classList.remove("hidden");
  $("blocked-invite-copy").classList.toggle("hidden", !pendingInviteAddress && !pendingGroupInvite);
  $("copy-blocked-invite").addEventListener("click", () => {
    const value = pendingGroupInvite ? groupInviteFor(pendingGroupInvite) : inviteURL(pendingInviteAddress);
    if (value) {
      void copyWithFeedback($("copy-blocked-invite"), value, "copy_preserved_invite");
    }
  });
  tcTest.state.transport = "unsupported";
} else {
  bootstrap().catch((error) => {
    recordError(error);
    tcTest.state.transport = "failed";
    setStatus(format("generic_error", { message: redact(error.message) }), "error");
  });
}

// ---- IndexedDB key persistence -----------------------------------------

function openSettingsDB() {
  if (typeof globalThis.indexedDB === "undefined") return Promise.reject(new Error("IndexedDB unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB unavailable"));
  });
}

async function dbRead() {
  const db = await openSettingsDB();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(DB_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function dbWrite(value) {
  const db = await openSettingsDB();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readwrite");
      transaction.objectStore(DB_STORE).put(value, DB_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB write aborted"));
    });
  } finally {
    db.close();
  }
}

async function dbDelete() {
  const db = await openSettingsDB();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readwrite");
      transaction.objectStore(DB_STORE).delete(DB_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

async function probePersistence() {
  if (!persistenceAvailable) {
    setPersistenceAvailable(false);
    return false;
  }
  try {
    const db = await openSettingsDB();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(DB_STORE, "readwrite");
        const store = transaction.objectStore(DB_STORE);
        store.put({ checkedAt: Date.now() }, DB_PROBE_KEY);
        store.delete(DB_PROBE_KEY);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB probe aborted"));
      });
    } finally {
      db.close();
    }
    setPersistenceAvailable(true);
    return true;
  } catch (error) {
    recordError(error);
    setPersistenceAvailable(false);
    return false;
  }
}

// ---- Byte-stream framing ------------------------------------------------

class ConnectionReader {
  constructor(connection, timeoutMs = STREAM_READ_TIMEOUT_MS) {
    this.connection = connection;
    this.timeoutMs = timeoutMs;
    this.buffer = new Uint8Array(0);
    this.offset = 0;
    this.ended = false;
  }

  async readExact(length) {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("invalid frame length");
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const available = this.buffer.length - this.offset;
      if (available > 0) {
        const count = Math.min(available, length - written);
        output.set(this.buffer.subarray(this.offset, this.offset + count), written);
        this.offset += count;
        written += count;
        if (this.offset === this.buffer.length) {
          this.buffer = new Uint8Array(0);
          this.offset = 0;
        }
        continue;
      }
      const chunk = await readConnectionChunk(
        this.connection,
        this.timeoutMs,
        Math.min(length - written, CONNECTION_READ_MAX_BYTES),
      );
      if (chunk === null) {
        this.ended = true;
        throw new Error("unexpected end of stream");
      }
      if (!(chunk instanceof Uint8Array) || chunk.length === 0) continue;
      this.buffer = chunk;
      this.offset = 0;
    }
    return output;
  }
}

async function readConnectionChunk(connection, timeoutMs = STREAM_READ_TIMEOUT_MS, maximumBytes = 0) {
  let timer = null;
  try {
    const read = Number.isSafeInteger(maximumBytes) && maximumBytes > 0
      ? connection.read(maximumBytes)
      : connection.read();
    return await Promise.race([
      read,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          connection.close();
          reject(new Error("stream read timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withConnectionDeadline(connection, operation, timeoutMs, message) {
  let timer = null;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          safeConnectionClose(connection);
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fileDataDeadlineMs(size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid file size for deadline");
  const transferMs = Math.ceil(size / FILE_DATA_MIN_BYTES_PER_SECOND * 1000);
  return Math.min(FILE_DATA_MAX_DEADLINE_MS, STREAM_READ_TIMEOUT_MS + transferMs);
}

function withConnectionUntil(connection, operation, deadlineAt, message) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    safeConnectionClose(connection);
    // Observe a late failure from an operation that was started by the caller.
    void Promise.resolve(operation).catch(() => {});
    return Promise.reject(new Error(message));
  }
  return withConnectionDeadline(connection, operation, remaining, message);
}

function packChatEnvelope(meta, payload = new Uint8Array()) {
  const json = encoder.encode(JSON.stringify({ ...meta, v: APP_CONFIG.protocolVersion }));
  if (json.length > APP_CONFIG.limits.controlBytes) throw new Error("message header too large");
  const header = new Uint8Array(8);
  header.set(TCH_MAGIC);
  new DataView(header.buffer).setUint32(4, json.length, false);
  return concatBytes(header, json, payload);
}

function unpackChatEnvelope(bytes) {
  if (bytes.length < 8 || !equalBytes(bytes.subarray(0, 4), TCH_MAGIC)) throw new Error("invalid TCH1 envelope");
  const jsonLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false);
  if (jsonLength > APP_CONFIG.limits.controlBytes || 8 + jsonLength > bytes.length) throw new Error("invalid TCH1 header length");
  const meta = JSON.parse(decoder.decode(bytes.subarray(8, 8 + jsonLength)));
  return { meta, payload: bytes.subarray(8 + jsonLength) };
}

async function readChatEnvelopeStream(connection, maximumPayload, totalTimeoutMs, inspectMeta = null) {
  const reader = new ConnectionReader(connection);
  const magic = await reader.readExact(4);
  if (!equalBytes(magic, TCH_MAGIC)) throw new Error("invalid TCH1 envelope");
  return readChatEnvelopeStreamBody(connection, reader, maximumPayload, totalTimeoutMs, inspectMeta);
}

async function readChatEnvelopeStreamBody(connection, reader, maximumPayload, totalTimeoutMs, inspectMeta = null) {
  const lengthBytes = await reader.readExact(4);
  const jsonLength = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0, false);
  if (jsonLength > APP_CONFIG.limits.controlBytes) throw new Error("invalid TCH1 header length");
  const meta = JSON.parse(decoder.decode(await reader.readExact(jsonLength)));
  if (inspectMeta) await inspectMeta(meta);
  const chunks = [];
  let total = 0;
  const buffered = reader.buffer.subarray(reader.offset);
  if (buffered.length) {
    if (buffered.length > maximumPayload) throw new Error("message payload exceeds its limit");
    chunks.push(buffered.slice());
    total += buffered.length;
    reader.buffer = new Uint8Array(0);
    reader.offset = 0;
  }
  const deadline = Date.now() + totalTimeoutMs;
  while (!reader.ended) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("message deadline exceeded");
    const chunk = await readConnectionChunk(connection, Math.min(STREAM_READ_TIMEOUT_MS, remaining));
    if (chunk === null) break;
    if (chunk.length > maximumPayload - total) throw new Error("message payload exceeds its limit");
    chunks.push(chunk);
    total += chunk.length;
  }
  return { meta, payload: concatBytes(...chunks) };
}

function packGroupVoiceFrame(meta, payload = new Uint8Array()) {
  if (!(payload instanceof Uint8Array)) throw new TypeError("voice payload must be Uint8Array");
  if (payload.length > APP_CONFIG.limits.voiceBytes) throw new Error("voice payload exceeds its limit");
  const json = encoder.encode(JSON.stringify({ ...meta, v: APP_CONFIG.protocolVersion }));
  if (!json.length || json.length > APP_CONFIG.limits.controlBytes) throw new Error("voice header exceeds its limit");
  const header = new Uint8Array(12);
  header.set(TCV_MAGIC);
  const view = new DataView(header.buffer);
  view.setUint32(4, json.length, false);
  view.setUint32(8, payload.length, false);
  return concatBytes(header, json, payload);
}

async function readGroupVoiceFrameHead(reader, maximumPayload, { magicRead = false } = {}) {
  if (!magicRead) {
    const magic = await reader.readExact(4);
    if (!equalBytes(magic, TCV_MAGIC)) throw new Error("invalid TCV1 voice frame");
  }
  const lengths = await reader.readExact(8);
  const view = new DataView(lengths.buffer, lengths.byteOffset, lengths.byteLength);
  const jsonLength = view.getUint32(0, false);
  const payloadLength = view.getUint32(4, false);
  if (!jsonLength
    || jsonLength > APP_CONFIG.limits.controlBytes
    || payloadLength > maximumPayload) throw new Error("invalid TCV1 voice frame length");
  let meta;
  try {
    meta = JSON.parse(decoder.decode(await reader.readExact(jsonLength)));
  } catch (_) {
    throw new Error("invalid TCV1 voice metadata");
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("invalid TCV1 voice metadata");
  return Object.freeze({ meta, payloadLength });
}

async function readGroupVoiceFramePayload(reader, head) {
  if (!head || !Number.isSafeInteger(head.payloadLength) || head.payloadLength < 0) {
    throw new Error("invalid TCV1 voice frame header");
  }
  const payload = head.payloadLength ? await reader.readExact(head.payloadLength) : new Uint8Array();
  return { meta: head.meta, payload };
}

async function readGroupVoiceFrame(reader, maximumPayload, options = {}) {
  return readGroupVoiceFramePayload(reader, await readGroupVoiceFrameHead(reader, maximumPayload, options));
}

function packFileFrame(kind, payload = new Uint8Array()) {
  if (!(payload instanceof Uint8Array)) throw new TypeError("frame payload must be Uint8Array");
  const header = new Uint8Array(5);
  header[0] = kind;
  new DataView(header.buffer).setUint32(1, payload.length, false);
  return concatBytes(header, payload);
}

function packFileJSON(kind, value) {
  const payload = encoder.encode(JSON.stringify(value));
  if (payload.length > APP_CONFIG.limits.controlBytes) throw new Error("TCF1 metadata too large");
  return packFileFrame(kind, payload);
}

async function readFileFrameHeader(reader) {
  const header = await reader.readExact(5);
  const kind = header[0];
  const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(1, false);
  const maximum = kind === FILE_FRAME.DATA ? APP_CONFIG.limits.fileChunkBytes : APP_CONFIG.limits.controlBytes;
  if (![FILE_FRAME.META, FILE_FRAME.DATA, FILE_FRAME.FINAL, FILE_FRAME.CANCEL].includes(kind) || length > maximum) {
    throw new Error("invalid TCF1 frame");
  }
  return Object.freeze({ kind, length });
}

async function readFileFramePayload(reader, header) {
  if (!header || !Number.isSafeInteger(header.length) || header.length < 0) throw new Error("invalid TCF1 frame header");
  return { kind: header.kind, payload: await reader.readExact(header.length) };
}

async function readFileFrame(reader) {
  return readFileFramePayload(reader, await readFileFrameHeader(reader));
}

function decodeFileJSON(frame, allowedKinds = [FILE_FRAME.META, FILE_FRAME.FINAL, FILE_FRAME.CANCEL]) {
  if (!allowedKinds.includes(frame.kind)) throw new Error("unexpected TCF1 frame kind");
  return JSON.parse(decoder.decode(frame.payload));
}

async function readAllBounded(
  connection,
  maximum,
  timeoutMs = STREAM_READ_TIMEOUT_MS,
  totalTimeoutMs = timeoutMs,
) {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("invalid message limit");
  const output = new Uint8Array(maximum);
  let total = 0;
  const deadline = Date.now() + totalTimeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      connection.close();
      throw new Error("message deadline exceeded");
    }
    const chunk = await readConnectionChunk(connection, Math.min(timeoutMs, remaining));
    if (chunk === null) break;
    if (chunk.length > maximum - total) throw new Error("incoming message exceeds its limit");
    output.set(chunk, total);
    total += chunk.length;
  }
  return output.subarray(0, total);
}

async function writeChunked(connection, bytes, chunkSize = APP_CONFIG.limits.fileChunkBytes) {
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    await connection.write(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
}

async function sendChatEnvelopeTo(address, meta, payload, port, responseTimeoutMs = STREAM_READ_TIMEOUT_MS) {
  const connection = await tailcatDial({
    addr: address,
    derpMapURL: APP_CONFIG.derpMapURL,
    port,
  });
  try {
    await writeChunked(connection, packChatEnvelope(meta, payload));
    await connection.closeWrite();
    return await readAllBounded(connection, 1024, responseTimeoutMs);
  } finally {
    connection.close();
  }
}

// ---- Room and handshake -------------------------------------------------

let listener = null;
let listenerStarting = null;
let listenerStartingMode = "none";
let localAddress = "";
let activePeerAddress = "";
let activePeerNonce = "";
let activeSession = "";
let privateAutoReceiveBudget = { session: "", bytes: 0, items: 0 };
let peerCapabilities = null;
let pendingPeerAddress = "";
let pendingHandshakeNonce = "";
let handshakeWaiter = null;
let pendingInboundHandshake = null;
let idleTimer = null;
let stoppedForIdle = false;
let heartbeatTimer = null;
let heartbeatGeneration = 0;
let heartbeatInFlight = 0;
let heartbeatFailures = 0;
let lastAuthenticatedPeerTrafficAt = 0;
const inboundConnectionCounts = new Map();
const handshakeReplyTimes = [];
let activeHandshakeRejects = 0;
let groupPendingTicker = null;
let groupBackgroundedAt = 0;
let groupBackgroundCloseTimer = null;
const groupTransferConnections = new Set();
const groupOutgoingTransfers = new Set();
let groupTransferGeneration = 0;
let groupTextEventCount = 0;
let previousGroupMode = "none";

function canSendHandshakeReply() {
  const cutoff = Date.now() - HANDSHAKE_REPLY_WINDOW_MS;
  while (handshakeReplyTimes.length && handshakeReplyTimes[0] < cutoff) handshakeReplyTimes.shift();
  if (handshakeReplyTimes.length >= HANDSHAKE_REPLY_LIMIT) return false;
  handshakeReplyTimes.push(Date.now());
  return true;
}

async function sendHandshakeReply(address, meta) {
  // A room can have only one pending ACK, while rejects are attacker-driven
  // and therefore share a small token bucket.
  const isReject = meta?.type === "HELLO_REJECT";
  if (isReject && (!canSendHandshakeReply() || activeHandshakeRejects >= 2)) return false;
  if (isReject) activeHandshakeRejects += 1;
  try {
    await sendControlTo(address, meta);
  } finally {
    if (isReject) activeHandshakeRejects -= 1;
  }
  return true;
}

function localCapabilities() {
  const voiceRecordTypes = recordableVoiceTypes();
  const voicePlayTypes = playableVoiceTypes();
  return {
    text: { maxBytes: APP_CONFIG.limits.textBytes },
    file: {
      protocol: "TCF1",
      transports: nativeFilesEnabled() ? ["tailcat", "webrtc-dc-v1"] : ["tailcat"],
      maxBytes: fileSinkSupport.maxBytes,
      chunkBytes: APP_CONFIG.limits.fileChunkBytes,
      receive: Boolean(fileSinkSupport.preferredKind && fileSinkSupport.maxBytes >= 0),
      sink: fileSinkSupport.preferredKind,
    },
    voice: {
      maxBytes: APP_CONFIG.limits.voiceBytes,
      maxSeconds: APP_CONFIG.limits.voiceSeconds,
      enabled: Boolean(
        window.MediaRecorder
        && navigator.mediaDevices?.getUserMedia
        && voiceRecordTypes.length
        && voicePlayTypes.length,
      ),
      recordTypes: voiceRecordTypes,
      playTypes: voicePlayTypes,
    },
    rtc: {
      voice: Boolean(window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia),
      video: Boolean(window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia),
      screen: !support.mobile && Boolean(window.RTCPeerConnection && navigator.mediaDevices?.getDisplayMedia),
      screenShare: !support.mobile && Boolean(window.RTCPeerConnection && navigator.mediaDevices?.getDisplayMedia),
      screenReceive: Boolean(window.RTCPeerConnection),
      turn: false,
    },
  };
}

function validCapabilities(value) {
  return value && typeof value === "object" ? value : {};
}

function groupFeatureAvailable() {
  return APP_CONFIG.groupRoomsEnabled && APP_CONFIG.group.enabled;
}

function ensureGroupRoom() {
  if (groupRoom) return groupRoom;
  groupRoom = new GroupRoomController({
    config: APP_CONFIG.group,
    appVersion: APP_CONFIG.protocolVersion,
    port: APP_CONFIG.group.port,
    limits: APP_CONFIG.limits,
    validAddress,
    capabilities: localCapabilities,
    connect: ({ addr, signal }) => tailcatConnect({ addr, derpMapURL: APP_CONFIG.derpMapURL, signal }),
    onState: renderGroupState,
    onPending: renderGroupPending,
    onEvent: renderGroupEvent,
    onStatus: handleGroupStatus,
    onClosed: handleGroupClosed,
  });
  return groupRoom;
}

function groupInviteFor(invite) {
  if (!invite) return "";
  return makeGroupInviteURL(invitationOrigin(), {
    address: invite.address,
    roomId: invite.roomId,
    joinToken: invite.joinToken,
    appVersion: APP_CONFIG.protocolVersion,
  });
}

function groupMemberById(memberId) {
  return groupRoom?.snapshot().members.find((member) => member.id === memberId) || null;
}

function groupMemberIdentity(member) {
  if (!member) return `${t("group_role_member")} · #??????`;
  return `${member.displayName} · #${member.code}${member.role === "owner" ? ` · ${t("group_role_owner")}` : ""}`;
}

function selectedGroupRecipientIds() {
  return [...document.querySelectorAll("#group-recipient-list .group-recipient-checkbox:checked")]
    .map((input) => input.value)
    .filter(Boolean);
}

function selectedGroupMembers() {
  const selected = new Set(selectedGroupRecipientIds());
  return groupRoom?.snapshot().members.filter((member) => selected.has(member.id)) || [];
}

function groupMemberCanReceive(member, kind, size = 0) {
  if (!member || member.status !== "online") return false;
  if (kind === "file") {
    return member.capabilities?.file?.protocol === "TCF1"
      && member.capabilities.file.receive === true
      && Number(member.capabilities.file.maxBytes) >= size;
  }
  return member.capabilities?.voice?.enabled === true
    && Number(member.capabilities.voice.maxBytes) >= size;
}

function updateGroupRecipientSummary() {
  const count = selectedGroupRecipientIds().length;
  $("group-recipient-summary").textContent = count
    ? format("group_recipient_summary", { count })
    : t("group_no_recipients");
  const choices = [...document.querySelectorAll("#group-recipient-list .group-recipient-checkbox:not(:disabled)")];
  $("group-recipient-all").checked = Boolean(choices.length && choices.every((input) => input.checked));
  $("group-recipient-all").indeterminate = Boolean(count && !$("group-recipient-all").checked);
  if (groupRoom?.active) setComposerEnabled(groupRoom.canSend);
}

function renderGroupRecipients(snapshot) {
  const selected = new Set(selectedGroupRecipientIds());
  const container = $("group-recipient-list");
  container.replaceChildren();
  for (const member of snapshot.members) {
    if (member.id === snapshot.memberId) continue;
    const fragment = $("group-recipient-template").content.cloneNode(true);
    const input = fragment.querySelector(".group-recipient-checkbox");
    input.value = member.id;
    input.checked = selected.has(member.id) && member.status === "online";
    input.disabled = member.status !== "online"
      || (!groupMemberCanReceive(member, "file") && !groupMemberCanReceive(member, "voice"));
    fragment.querySelector(".group-recipient-name").textContent = member.displayName;
    fragment.querySelector(".group-recipient-code").textContent = `#${member.code}`;
    input.addEventListener("change", updateGroupRecipientSummary);
    container.append(fragment);
  }
  updateGroupRecipientSummary();
}

function renderGroupMembers(snapshot) {
  const list = $("group-members-list");
  list.replaceChildren();
  for (const member of snapshot.members) {
    const fragment = $("group-member-template").content.cloneNode(true);
    i18n.apply(fragment);
    const item = fragment.querySelector(".group-member-item");
    item.dataset.memberId = member.id;
    fragment.querySelector(".group-member-avatar").textContent = Array.from(member.displayName)[0]?.toUpperCase() || "?";
    fragment.querySelector(".group-member-name").textContent = member.displayName;
    fragment.querySelector(".group-member-code").textContent = `#${member.code}`;
    fragment.querySelector(".group-member-role").textContent = member.role === "owner"
      ? t("group_role_owner")
      : t("group_role_member");
    const memberState = fragment.querySelector(".group-member-state");
    memberState.dataset.state = member.status;
    memberState.textContent = member.status === "online"
      ? t("group_member_online")
      : t("group_member_reconnecting");
    const remove = fragment.querySelector(".group-remove-member");
    remove.classList.toggle("hidden", snapshot.mode !== "owner" || member.role === "owner");
    remove.addEventListener("click", () => void groupRoom?.removeMember(member.id));
    list.append(fragment);
  }
}

function renderGroupPending(pending) {
  if (groupRoom?.mode !== "owner") return;
  clearInterval(groupPendingTicker);
  groupPendingTicker = null;
  const list = $("group-pending-list");
  const updateExpiry = (item, request) => {
    item.querySelector(".group-pending-expiry").textContent = format("group_request_expires", {
      seconds: Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000)),
    });
  };
  const render = (current) => {
    $("group-pending-count").textContent = format("group_pending_count", { count: current.length });
    $("group-pending-panel").classList.toggle("hidden", current.length === 0);
    const existing = new Map([...list.children].map((item) => [item.dataset.requestId, item]));
    for (const request of current) {
      let item = existing.get(request.requestId);
      if (!item) {
        const fragment = $("group-pending-template").content.cloneNode(true);
        i18n.apply(fragment);
        item = fragment.querySelector(".group-pending-item");
        item.dataset.requestId = request.requestId;
        const approve = item.querySelector(".group-approve-join");
        const reject = item.querySelector(".group-reject-join");
        approve.addEventListener("click", () => {
          approve.disabled = true;
          reject.disabled = true;
          void groupRoom?.approvePending(request.requestId);
        });
        reject.addEventListener("click", () => {
          approve.disabled = true;
          reject.disabled = true;
          void groupRoom?.rejectPending(request.requestId);
        });
        list.append(fragment);
      }
      existing.delete(request.requestId);
      item.querySelector(".group-pending-name").textContent = request.displayName;
      item.querySelector(".group-pending-code").textContent = `#${request.code}`;
      updateExpiry(item, request);
      const approve = item.querySelector(".group-approve-join");
      const reject = item.querySelector(".group-reject-join");
      approve.disabled = request.state !== "pending";
      reject.disabled = request.state !== "pending";
    }
    for (const item of existing.values()) item.remove();
  };
  render(groupRoom?.snapshot().pending || pending);
  if (pending.length) groupPendingTicker = setInterval(() => {
    const current = groupRoom?.snapshot().pending || [];
    const byId = new Map(current.map((request) => [request.requestId, request]));
    for (const item of list.children) {
      const request = byId.get(item.dataset.requestId);
      if (request) updateExpiry(item, request);
    }
  }, 1000);
}

function updateGroupTestState(snapshot) {
  tcTest.group = {
    enabled: groupFeatureAvailable(),
    mode: snapshot.mode,
    members: snapshot.members.length,
    online: snapshot.members.filter((member) => member.status === "online").length,
    pending: snapshot.pending.length,
    sequence: snapshot.sequence,
    paused: snapshot.roomPaused,
    textEvents: groupTextEventCount,
  };
}

function renderGroupState(snapshot) {
  for (const [key, peer] of nativeFilePeers) {
    if (peer.group && !peer.authorized()) {
      peer.manager.close(); for (const mux of peer.muxes) mux.close(); nativeFilePeers.delete(key);
    }
  }
  if (previousGroupMode === "none" && snapshot.mode !== "none") groupTextEventCount = 0;
  previousGroupMode = snapshot.mode;
  updateGroupTestState(snapshot);
  const active = snapshot.mode !== "none";
  const admitted = snapshot.mode === "owner" || snapshot.mode === "member";
  document.querySelector(".room-panel")?.classList.toggle("hidden", active);
  document.querySelector(".join-panel")?.classList.toggle("hidden", active);
  document.querySelector(".live-panel")?.classList.toggle("hidden", active);
  const secureLabel = document.querySelector(".secure-badge [data-i18n]");
  if (secureLabel) {
    const key = active ? "group_secure" : "secure";
    secureLabel.dataset.i18n = key;
    secureLabel.textContent = t(key);
  }
  const encryptionNote = $("encryption-note");
  if (encryptionNote) {
    const key = active ? "group_trust_body" : "encryption_note";
    encryptionNote.dataset.i18n = key;
    encryptionNote.textContent = t(key);
  }
  $("send-text").placeholder = t(active ? "group_message_placeholder" : "message_placeholder");
  const composerHint = document.querySelector(".composer-hint");
  if (composerHint) {
    const key = active ? "group_composer_hint" : "composer_hint";
    composerHint.dataset.i18n = key;
    composerHint.textContent = t(key);
  }
  $("private-file-auto-note").classList.toggle("hidden", active);
  $("group-room-panel").classList.toggle("hidden", !admitted);
  $("group-wake-lock-alert").classList.toggle(
    "hidden",
    !(groupWakeLockFailed && support.mobile && snapshot.mode === "owner"),
  );
  $("group-waiting-panel").classList.toggle("hidden", snapshot.mode !== "pending");
  $("group-recipient-panel").classList.toggle("hidden", !admitted);
  $("group-create-entry").classList.toggle("hidden", active || !tcTest.ready || !groupFeatureAvailable());
  if (!active) {
    clearInterval(groupPendingTicker);
    groupPendingTicker = null;
    $("group-members-list").replaceChildren();
    $("group-pending-list").replaceChildren();
    $("group-recipient-list").replaceChildren();
    $("peer-label").textContent = t("waiting_peer");
    setComposerEnabled(Boolean(activeSession));
    return;
  }
  if (snapshot.mode === "pending") {
    setMobileState("connecting");
    setComposerEnabled(false);
    return;
  }
  const online = snapshot.members.filter((member) => member.status === "online").length;
  $("group-room-count").textContent = `${online} / ${APP_CONFIG.group.maxMembers}`;
  $("group-room-role").textContent = snapshot.mode === "owner" ? t("group_role_owner") : t("group_role_member");
  $("group-room-status").textContent = snapshot.roomPaused ? t("group_status_paused") : t("group_status_active");
  $("group-invite-card").classList.toggle("hidden", snapshot.mode !== "owner");
  document.querySelector(".group-owner-controls")?.classList.toggle("hidden", snapshot.mode !== "owner");
  $("group-leave-room-btn").classList.toggle("hidden", snapshot.mode !== "member");
  if (snapshot.mode === "owner") {
    const value = groupInviteURL();
    $("group-invite-link").textContent = value;
    $("group-pause-joins-btn").textContent = snapshot.joinsPaused ? t("group_resume_joins") : t("group_pause_joins");
  }
  renderGroupMembers(snapshot);
  renderGroupRecipients(snapshot);
  if (snapshot.mode === "owner") renderGroupPending(snapshot.pending);
  $("peer-label").textContent = snapshot.mode === "owner" ? t("group_role_owner") : t("group_role_member");
  setMobileState("connected");
  setStatus(snapshot.roomPaused ? t("group_status_paused") : t("group_status_active"), snapshot.roomPaused ? "loading" : "connected");
  setComposerEnabled(groupRoom.canSend);
}

function renderGroupEvent(event) {
  if (event.type === "TEXT") {
    groupTextEventCount += 1;
    if (tcTest.group) tcTest.group.textEvents = groupTextEventCount;
    const member = groupMemberById(event.senderId);
    if (!member) return;
    const mine = event.senderId === groupRoom?.memberId;
    const submitted = mine ? pendingGroupDrafts.get(event.clientEventId) : null;
    if (submitted?.roomId === groupRoom?.roomId && submitted.text === event.text) {
      pendingGroupDrafts.delete(event.clientEventId);
      if (isRenderedMessage(submitted.message)) {
        updateMessageDelivery(submitted.message, "delivered");
      } else {
        addMessage({
          type: "text",
          text: event.text,
          mine: true,
          senderName: member.displayName,
          senderCode: member.code,
          senderRole: member.role,
          deliveryState: "delivered",
          deliveryContext: "group",
          groupOrdered: true,
        });
      }
      setStatus(t("group_message_committed"), "connected");
    } else {
      if (submitted) {
        pendingGroupDrafts.delete(event.clientEventId);
        updateMessageDelivery(submitted.message, "failed");
      }
      addMessage({
        type: "text",
        text: event.text,
        mine,
        senderName: member.displayName,
        senderCode: member.code,
        senderRole: member.role,
        deliveryState: mine ? "delivered" : "",
        deliveryContext: mine ? "group" : "",
        groupOrdered: true,
      });
    }
    return;
  }
  const member = event.member || groupMemberById(event.memberId);
  const identity = groupMemberIdentity(member);
  if (event.type === "MEMBER_JOINED" && event.member?.id !== groupRoom?.memberId) {
    addMessage({ type: "system", text: format("group_system_joined", { identity }), groupOrdered: true });
  } else if (event.type === "MEMBER_LEFT") {
    addMessage({ type: "system", text: format("group_system_left", { identity }), groupOrdered: true });
  }
}

function handleGroupStatus(code, detail = {}) {
  if (code === "JOIN_CONNECTING") {
    $("group-waiting-status").textContent = t("status_connecting");
  } else if (code === "JOIN_PENDING") {
    $("group-waiting-status").textContent = t("group_waiting_status");
  } else if (code === "ADDRESS_VERIFYING") {
    $("group-waiting-status").textContent = t("group_callback_verifying");
  } else if (code === "RECOVERING" || code === "RECOVERY_RETRY") {
    updatePendingGroupMessages("reconnecting");
    $("group-room-status").textContent = t("group_status_reconnecting");
    setStatus(t("group_status_reconnecting"), "loading");
  } else if (code === "RECOVERED") {
    updatePendingGroupMessages("sending");
  } else if (code === "ACTION_REJECTED" && detail.requestId) {
    failPendingGroupMessage(detail.requestId, detail.reason || "REJECTED");
  } else if (code === "MESSAGE_GAP") {
    addMessage({ type: "system", text: t("group_message_gap") });
    setStatus(t("group_message_gap"), "error");
  } else if (code === "ROOM_PAUSED") {
    // Transfers already on the wire may finish, but queued recipients from an
    // earlier generation must never start while/after this pause transition.
    groupTransferGeneration += 1;
    if (groupRoom?.roomId) {
      groupRecipientTransferScheduler.cancelScope(groupRoom.roomId, "group room paused");
    }
    if (recorder || activeVoiceStream || voicePointerHeld) cancelActiveVoiceRecording();
    setStatus(t("group_status_paused"), "loading");
  } else if (code === "SLOW_MEMBER" && detail.memberId) {
    renderGroupState(groupRoom.snapshot());
  } else if (code === "MEMBER_TICKETS_REVOKED" && detail.memberId) {
    cancelGroupTransferConnections(detail.memberId);
  }
}

function cancelGroupTransferConnections(memberId = "") {
  for (const entry of groupOutgoingTransfers) {
    if (memberId) entry.invalidRecipients.add(memberId);
    else entry.cancelled = true;
  }
  for (const entry of groupTransferConnections) {
    if (memberId && entry.senderId !== memberId && entry.recipientId !== memberId) continue;
    entry.cancelled = true;
    entry.cancelDecision?.();
    safeConnectionClose(entry.connection);
  }
  if (incomingFileTransfer?.group
    && (!memberId || incomingFileTransfer.senderId === memberId || incomingFileTransfer.recipientId === memberId)) {
    incomingFileTransfer.cancelled = true;
    incomingFileTransfer.cancelDecision?.();
    safeConnectionClose(incomingFileTransfer.connection);
  }
}

function safeConnectionClose(connection) {
  try { connection?.close(); } catch (_) {}
}

function handleGroupClosed(reason, { roomId = "" } = {}) {
  closeNativeFilePeers(true);
  clearTimeout(groupBackgroundCloseTimer);
  groupBackgroundCloseTimer = null;
  groupBackgroundedAt = 0;
  groupWakeLockFailed = false;
  groupTransferGeneration += 1;
  if (roomId) groupRecipientTransferScheduler.cancelScope(roomId, "group room closed");
  pendingGroupDrafts.clear();
  cancelActiveVoiceRecording();
  cancelGroupTransferConnections();
  discardGroupTransferItems(roomId);
  $("group-invite-link").textContent = "";
  clearGroupInviteQR(roomId);
  closeGroupListener();
  tcTest.listenAddr = null;
  tcTest.state.room = "closed";
  void wakeLocks.release("group-host");
  const key = reason === "REMOVED"
    ? "group_member_removed"
    : reason === "HOST_CLOSED" || reason === "BACKGROUND_TIMEOUT" || reason === "RECOVERY_TIMEOUT"
      ? "group_host_left"
      : "group_status_closed";
  setStatus(t(key), "error");
  clearMessageHistory();
  renderGroupState(groupRoom.snapshot());
  $("region-select").disabled = false;
  $("persist-key").disabled = !persistenceAvailable;
  $("listen-btn").disabled = !tcTest.ready;
  $("connect-btn").disabled = !tcTest.ready;
  setMobileState(restingMobileState());
}

function markActivity() {
  if (!listener || listenerMode === "group") return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => stopRoom({ idle: true }), APP_CONFIG.idleTimeoutMs);
}

function noteAuthenticatedPeerTraffic() {
  if (!activeSession) return;
  lastAuthenticatedPeerTrafficAt = Date.now();
  heartbeatFailures = 0;
  markActivity();
}

function renderConnectionState() {
  if (groupRoom?.active) {
    renderGroupState(groupRoom.snapshot());
    return;
  }
  if (activeSession && activePeerAddress) {
    $("peer-label").textContent = t("connected_peer");
    setStatus(t("status_connected"), "connected");
    setComposerEnabled(true);
    setMobileState(peerConnection || pendingCallOffer || currentCallId ? "call" : "connected");
    tcTest.state.peer = "connected";
    return;
  }
  $("peer-label").textContent = t("waiting_peer");
  setComposerEnabled(false);
  tcTest.state.peer = "none";
  if (handshakeWaiter || pendingHandshakeNonce || pendingInboundHandshake) {
    setMobileState("connecting");
    setStatus(t("status_connecting"), "loading");
  } else if (listener) {
    setMobileState(restingMobileState());
    setStatus(format("status_listening", { region: listener.regionName || listener.regionCode || t("region_auto") }), "ready");
  } else if (tcTest.ready) {
    setMobileState(restingMobileState());
    setStatus(stoppedForIdle ? t("status_idle_closed") : t("status_ready"), "ready");
  }
}

function stopPeerHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  heartbeatGeneration += 1;
  heartbeatInFlight = 0;
  heartbeatFailures = 0;
}

function releaseLostPeer() {
  endLiveLink(false, t("call_ended"));
  cancelAllTransfers();
  clearPeer();
  addMessage({ type: "system", text: t("system_left") });
}

async function runPeerHeartbeat(generation) {
  if (generation !== heartbeatGeneration || heartbeatInFlight || !activeSession || !activePeerAddress) return;
  const session = activeSession;
  const address = activePeerAddress;
  const pingId = randomID();
  heartbeatInFlight = generation;
  try {
    const response = await sendChatEnvelopeTo(
      address,
      { type: "SESSION_PING", v: APP_CONFIG.protocolVersion, session, pingId },
      new Uint8Array(),
      APP_CONFIG.ports.control,
      HEARTBEAT_RESPONSE_TIMEOUT_MS,
    );
    const pong = unpackChatEnvelope(response);
    if (pong.payload.length
      || pong.meta.type !== "SESSION_PONG"
      || !sessionMatches(pong.meta, session)
      || pong.meta.pingId !== pingId) throw new Error("heartbeat acknowledgement rejected");
    if (generation === heartbeatGeneration && session === activeSession && address === activePeerAddress) {
      heartbeatFailures = 0;
    }
  } catch (_) {
    if (generation === heartbeatGeneration && session === activeSession && address === activePeerAddress) {
      const activeFileRecentlyMoved = Boolean(activeFileTransfer || incomingFileTransfer)
        && Date.now() - lastAuthenticatedPeerTrafficAt < HEARTBEAT_INTERVAL_MS + HEARTBEAT_RESPONSE_TIMEOUT_MS;
      const liveCallStillConnected = peerConnection?.connectionState === "connected";
      if (activeFileRecentlyMoved || liveCallStillConnected) {
        heartbeatFailures = 0;
      } else {
        heartbeatFailures += 1;
        if (heartbeatFailures >= HEARTBEAT_FAILURE_LIMIT) releaseLostPeer();
      }
    }
  } finally {
    if (heartbeatInFlight === generation) heartbeatInFlight = 0;
  }
}

function startPeerHeartbeat() {
  stopPeerHeartbeat();
  const generation = heartbeatGeneration;
  heartbeatTimer = setInterval(() => runPeerHeartbeat(generation), HEARTBEAT_INTERVAL_MS);
}

async function verifySessionAfterResume() {
  if (resumeCheckInFlight || !activeSession || !activePeerAddress) return resumeCheckInFlight;
  const session = activeSession;
  const address = activePeerAddress;
  const pingId = randomID();
  resumeCheckInFlight = (async () => {
    try {
      const response = await sendChatEnvelopeTo(
        address,
        { type: "SESSION_PING", v: APP_CONFIG.protocolVersion, session, pingId },
        new Uint8Array(),
        APP_CONFIG.ports.control,
        HEARTBEAT_RESPONSE_TIMEOUT_MS,
      );
      const pong = unpackChatEnvelope(response);
      if (pong.payload.length
        || pong.meta.type !== "SESSION_PONG"
        || !sessionMatches(pong.meta, session)
        || pong.meta.pingId !== pingId) throw new Error("resume heartbeat rejected");
      if (session === activeSession && address === activePeerAddress) {
        noteAuthenticatedPeerTraffic();
        setStatus(t("background_reconnected"), "connected");
      }
      return true;
    } catch (error) {
      if (session === activeSession && address === activePeerAddress) {
        releaseLostPeer();
        setStatus(t("session_lost"), "error");
      }
      recordError(error);
      return false;
    } finally {
      $("background-risk").classList.add("hidden");
      resumeCheckInFlight = null;
    }
  })();
  return resumeCheckInFlight;
}

function notePageBackgrounded() {
  pageWasBackgrounded = true;
  if (support.mobile && (recorder || activeVoiceStream || voicePointerHeld)) cancelActiveVoiceRecording();
  if (support.mobile && groupRoom?.mode === "owner") {
    if (!groupBackgroundedAt) groupBackgroundedAt = Date.now();
    void groupRoom.setRoomPaused(true, "HOST_BACKGROUND");
    clearTimeout(groupBackgroundCloseTimer);
    const remaining = APP_CONFIG.group.reconnectGraceMs - (Date.now() - groupBackgroundedAt);
    if (remaining <= 0) {
      void groupRoom.close("BACKGROUND_TIMEOUT", { notify: true });
    } else {
      groupBackgroundCloseTimer = setTimeout(() => {
        if (groupRoom?.mode === "owner" && groupBackgroundedAt) {
          void groupRoom.close("BACKGROUND_TIMEOUT", { notify: true });
        }
      }, remaining);
    }
    $("background-risk").classList.remove("hidden");
  }
  if (support.mobile && (activeSession || activeFileTransfer || incomingFileTransfer || recorder || peerConnection || handshakeWaiter)) {
    $("background-risk").classList.remove("hidden");
  }
}

function resumeForegroundSession() {
  if (!pageWasBackgrounded) return;
  pageWasBackgrounded = false;
  void wakeLocks.request();
  if (support.mobile && groupRoom?.mode === "owner" && groupBackgroundedAt) {
    const elapsed = Date.now() - groupBackgroundedAt;
    groupBackgroundedAt = 0;
    clearTimeout(groupBackgroundCloseTimer);
    groupBackgroundCloseTimer = null;
    if (elapsed >= APP_CONFIG.group.reconnectGraceMs) {
      void groupRoom.close("BACKGROUND_TIMEOUT", { notify: true });
      return;
    }
    void groupRoom.setRoomPaused(false, "");
    $("background-risk").classList.add("hidden");
    return;
  }
  if (activeSession) void verifySessionAfterResume();
  else $("background-risk").classList.add("hidden");
}

function clearPeer() {
  closeNativeFilePeers();
  cancelActiveVoiceRecording();
  stopPeerHeartbeat();
  lastAuthenticatedPeerTrafficAt = 0;
  if (activeSession) closePrivateTextQueue(activeSession);
  activePeerAddress = "";
  activePeerNonce = "";
  activeSession = "";
  resetPrivateAutoReceiveBudget();
  peerCapabilities = null;
  if (handshakeWaiter) {
    settleHandshake(new Error("room closed"));
  }
  pendingPeerAddress = "";
  pendingHandshakeNonce = "";
  clearPendingInboundHandshake();
  renderConnectionState();
}

async function loadRememberedKey() {
  if (!persistenceAvailable) return null;
  try {
    const saved = await dbRead();
    if (!saved?.privateKeyJSON) return null;
    $("persist-key").checked = true;
    $("persist-risk").classList.remove("hidden");
    $("forget-key").classList.remove("hidden");
    if (saved.regionCode) $("region-select").value = regionByCode(saved.regionCode).code;
    $("send-progress").textContent = t("persistent_loaded");
    return saved;
  } catch (error) {
    recordError(error);
    setPersistenceAvailable(false);
    return null;
  }
}

async function startRoom() {
  if (!support.ok) throw new Error("unsupported browser");
  if (!APP_CONFIG.roomsEnabled) throw new Error(t("rooms_disabled"));
  if (groupRoom?.active || listenerMode === "group") throw new Error(t("status_busy"));
  if (listener) return listener;
  if (listenerStarting) {
    if (listenerStartingMode === "private") return listenerStarting;
    throw new Error(t("status_busy"));
  }
  stoppedForIdle = false;
  $("listen-btn").disabled = true;
  $("region-select").disabled = true;
  $("persist-key").disabled = true;
  setStatus(t("status_starting"), "loading");
  setMobileState("connecting");
  tcTest.state.room = "starting";
  listenerStartingMode = "private";
  const starting = (async () => {
    let created = null;
    try {
      await refreshFileSinkSupport();
      let remember = persistenceAvailable && $("persist-key").checked;
      let saved = null;
      if (remember) {
        try {
          saved = await dbRead();
        } catch (error) {
          recordError(error);
          setPersistenceAvailable(false);
          remember = false;
        }
      }
      const requestedRegion = regionByCode($("region-select").value);
      created = await tailcatListen({
        derpMapURL: APP_CONFIG.derpMapURL,
        privateKey: saved?.privateKeyJSON || "",
        regionID: requestedRegion.id,
        onConnection: routeIncomingConnection,
      });
      listener = created;
      listenerMode = "private";
      localAddress = created.addr;
      tcTest.listenAddr = created.addr;
      tcTest.state.room = "open";
      $("listen-addr").textContent = created.addr;
      $("listen-info").classList.remove("hidden");
      $("listen-btn").classList.add("hidden");
      $("stop-listen-btn").classList.remove("hidden");
      $("group-create-entry").classList.add("hidden");
      $("region-select").value = regionByCode(created.regionCode || requestedRegion.code).code;
      if (remember) {
        try {
          await dbWrite({
            privateKeyJSON: created.privateKeyJSON,
            regionID: created.regionID,
            regionCode: created.regionCode || requestedRegion.code,
            savedAt: new Date().toISOString(),
          });
          $("forget-key").classList.remove("hidden");
          $("send-progress").textContent = t("persistent_saved");
        } catch (error) {
          recordError(error);
          setPersistenceAvailable(false);
          $("send-progress").textContent = t("persistent_unavailable");
        }
      }
      markActivity();
      renderConnectionState();
      return created;
    } catch (error) {
      created?.close();
      listener = null;
      listenerMode = "none";
      localAddress = "";
      tcTest.listenAddr = null;
      tcTest.state.room = "closed";
      $("listen-info").classList.add("hidden");
      $("listen-addr").textContent = "";
      $("listen-btn").classList.remove("hidden");
      $("stop-listen-btn").classList.add("hidden");
      $("listen-btn").disabled = false;
      $("region-select").disabled = false;
      $("persist-key").disabled = !persistenceAvailable;
      setMobileState(restingMobileState());
      setStatus(format("status_failed", { message: redact(error.message) }), "error");
      recordError(error);
      throw error;
    } finally {
      if (listenerStarting === starting) {
        listenerStarting = null;
        listenerStartingMode = "none";
      }
    }
  })();
  listenerStarting = starting;
  return listenerStarting;
}

function showGroupDialogError(id, message) {
  const element = $(id);
  element.textContent = message;
  element.classList.toggle("hidden", !message);
}

async function startGroupListener() {
  if (!support.ok || !groupFeatureAvailable()) throw new Error(t("group_rooms_disabled"));
  if (listener || listenerStarting || activeSession) throw new Error(t("status_busy"));
  listenerStartingMode = "group";
  const starting = (async () => {
    let created = null;
    try {
      await refreshFileSinkSupport();
      const requestedRegion = regionByCode($("region-select").value);
      created = await tailcatListen({
        derpMapURL: APP_CONFIG.derpMapURL,
        privateKey: "",
        regionID: requestedRegion.id,
        onConnection: routeIncomingConnection,
      });
      listener = created;
      listenerMode = "group";
      localAddress = created.addr;
      // Group diagnostics expose counts only; never copy the ephemeral address.
      tcTest.listenAddr = null;
      tcTest.state.room = "open";
      $("region-select").value = regionByCode(created.regionCode || requestedRegion.code).code;
      return created;
    } catch (error) {
      created?.close();
      listener = null;
      listenerMode = "none";
      localAddress = "";
      tcTest.listenAddr = null;
      tcTest.state.room = "closed";
      throw error;
    } finally {
      if (listenerStarting === starting) {
        listenerStarting = null;
        listenerStartingMode = "none";
      }
    }
  })();
  listenerStarting = starting;
  return listenerStarting;
}

function closeGroupListener(expected = null) {
  if (listenerMode !== "group" || !listener || (expected && listener !== expected)) return false;
  listener.close();
  listener = null;
  listenerMode = "none";
  localAddress = "";
  tcTest.listenAddr = null;
  tcTest.state.room = "closed";
  return true;
}

async function createGroupRoom() {
  showGroupDialogError("group-create-status", "");
  groupWakeLockFailed = false;
  $("group-wake-lock-alert").classList.add("hidden");
  if (!groupFeatureAvailable()) {
    showGroupDialogError("group-create-status", t("group_rooms_disabled"));
    return false;
  }
  if (support.mobile && !APP_CONFIG.mobileGroupHostingEnabled) {
    showGroupDialogError("group-create-status", t("group_mobile_hosting_disabled"));
    return false;
  }
  if (support.mobile && !$("group-mobile-host-confirm").checked) {
    showGroupDialogError("group-create-status", t("group_mobile_host_required"));
    return false;
  }
  let displayName;
  try {
    displayName = normalizeGroupDisplayName($("group-create-nickname").value);
  } catch (_) {
    showGroupDialogError("group-create-status", t("group_nickname_invalid"));
    return false;
  }
  $("group-create-btn").disabled = true;
  setStatus(t("group_status_starting"), "loading");
  const operation = ++groupCreateOperation;
  let ownedListener = null;
  try {
    ownedListener = await startGroupListener();
    if (operation !== groupCreateOperation || !$("group-create-dialog").open) {
      closeGroupListener(ownedListener);
      return false;
    }
    ensureGroupRoom().startOwner({ address: localAddress, displayName });
    $("group-create-dialog").close();
    clearMessageHistory();
    addMessage({ type: "system", text: t("group_status_active") });
    if (support.mobile && document.visibilityState !== "visible") notePageBackgrounded();
    const wakeHeld = await wakeLocks.acquire("group-host");
    if (support.mobile && document.visibilityState === "visible" && !wakeHeld) {
      groupWakeLockFailed = true;
      $("group-wake-lock-alert").classList.remove("hidden");
      setStatus(t("group_wake_lock_failed"), "error");
    }
    return true;
  } catch (error) {
    if (groupRoom?.active) await groupRoom.close("CREATE_FAILED", { notify: false });
    else closeGroupListener(ownedListener);
    showGroupDialogError("group-create-status", format("generic_error", { message: redact(error.message) }));
    recordGroupError(error);
    return false;
  } finally {
    $("group-create-btn").disabled = false;
  }
}

function groupJoinErrorKey(error) {
  const message = String(error?.message || error);
  if (message.includes("FULL")) return "group_room_full";
  if (message.includes("EXPIRED")) return "group_request_expired";
  if (message.includes("REJECTED")) return "group_request_rejected";
  if (message.includes("PAUSED")) return "group_joins_paused";
  if (message.includes("CANCELLED") || message.includes("cancelled")) return "group_request_cancelled";
  if (message.includes("INVITE")) return "group_invite_invalid";
  return "group_invite_invalid";
}

async function requestGroupJoin() {
  showGroupDialogError("group-join-status", "");
  if (!groupFeatureAvailable() || !pendingGroupInvite) {
    showGroupDialogError("group-join-status", t("group_rooms_disabled"));
    return false;
  }
  let displayName;
  try {
    displayName = normalizeGroupDisplayName($("group-join-nickname").value);
  } catch (_) {
    showGroupDialogError("group-join-status", t("group_nickname_invalid"));
    return false;
  }
  const invite = pendingGroupInvite;
  $("group-join-btn").disabled = true;
  const operation = ++groupJoinOperation;
  let ownedListener = null;
  try {
    ownedListener = await startGroupListener();
    if (operation !== groupJoinOperation || !$("group-join-dialog").open) {
      closeGroupListener(ownedListener);
      return false;
    }
    pendingGroupInvite = null;
    $("group-join-dialog").close();
    const joined = ensureGroupRoom().requestJoin({ invite, address: localAddress, displayName });
    renderGroupState(groupRoom.snapshot());
    await joined;
    clearMessageHistory();
    addMessage({ type: "system", text: t("group_status_active") });
    return true;
  } catch (error) {
    const key = groupJoinErrorKey(error);
    if (groupRoom?.active) await groupRoom.close(key, { notify: false });
    else closeGroupListener(ownedListener);
    setStatus(t(key), "error");
    recordGroupError(error);
    return false;
  } finally {
    $("group-join-btn").disabled = false;
  }
}

function presentGroupInvitation(invite) {
  pendingGroupInvite = invite;
  if (!groupFeatureAvailable()) {
    setStatus(t("group_rooms_disabled"), "error");
    return;
  }
  showGroupDialogError("group-join-status", "");
  $("group-join-nickname").value = "";
  $("group-join-btn").disabled = true;
  $("group-join-dialog").showModal();
  $("group-join-nickname").focus();
}

async function stopRoom({ idle = false } = {}) {
  if (groupRoom?.active) {
    await groupRoom.close(idle ? "IDLE" : "HOST_CLOSED", { notify: true });
    return;
  }
  stoppedForIdle = idle;
  clearTimeout(idleTimer);
  idleTimer = null;
  if (activeSession && activePeerAddress) {
    void sendControl("SESSION_END", { reason: idle ? "IDLE" : "CLOSED" }).catch(() => {});
  }
  cancelVoiceNote();
  endLiveLink(false);
  cancelAllTransfers();
  listener?.close();
  listener = null;
  listenerStarting = null;
  listenerMode = "none";
  localAddress = "";
  tcTest.listenAddr = null;
  tcTest.state.room = "closed";
  $("listen-info").classList.add("hidden");
  $("listen-addr").textContent = "";
  $("listen-btn").classList.remove("hidden");
  $("listen-btn").disabled = !tcTest.ready;
  $("stop-listen-btn").classList.add("hidden");
  $("group-create-entry").classList.toggle("hidden", !tcTest.ready || !groupFeatureAvailable());
  $("region-select").disabled = false;
  $("persist-key").disabled = !persistenceAvailable;
  clearPeer();
  setMobileState(restingMobileState());
  setStatus(idle ? t("status_idle_closed") : t("status_stopped"), idle ? "error" : "ready");
}

function setPeerConnected(address, session, capabilities, nonce = "") {
  activePeerAddress = address;
  activeSession = session;
  resetPrivateAutoReceiveBudget(session);
  activePeerNonce = nonce;
  peerCapabilities = validCapabilities(capabilities);
  lastAuthenticatedPeerTrafficAt = Date.now();
  pendingPeerAddress = "";
  pendingHandshakeNonce = "";
  startPeerHeartbeat();
  markActivity();
  renderConnectionState();
}

function sessionMeta(type, extra = {}) {
  if (!activeSession) throw new Error(t("need_peer"));
  return { type, session: activeSession, ...extra };
}

function sessionMatches(meta, expectedSession) {
  return meta?.v === APP_CONFIG.protocolVersion
    && typeof meta.session === "string"
    && meta.session.length === 32
    && meta.session === expectedSession;
}

function hasSession(meta) {
  return sessionMatches(meta, activeSession);
}

async function sendControlTo(address, meta) {
  const responseTimeout = meta?.type === "HELLO"
    ? HANDSHAKE_TIMEOUT_MS
    : meta?.type === "HELLO_ACK"
      ? HANDSHAKE_CONFIRM_TIMEOUT_MS
      : STREAM_READ_TIMEOUT_MS;
  await sendChatEnvelopeTo(
    address,
    meta,
    new Uint8Array(),
    APP_CONFIG.ports.control,
    responseTimeout,
  );
}

async function sendControl(type, extra = {}) {
  if (!activePeerAddress) throw new Error(t("need_peer"));
  await sendControlTo(activePeerAddress, sessionMeta(type, extra));
  if (type !== "SESSION_END") noteAuthenticatedPeerTraffic();
}

function waitForHandshake(address, nonce) {
  if (handshakeWaiter) {
    settleHandshake(new Error("superseded handshake"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (handshakeWaiter?.nonce === nonce) settleHandshake(new Error("handshake timed out"));
    }, HANDSHAKE_TIMEOUT_MS);
    handshakeWaiter = { address, nonce, resolve, reject, timer, confirm: null };
  });
}

function cancelRemoteHandshake(waiter) {
  const confirm = waiter?.confirm;
  if (!confirm) return;
  // If the remote accepted CONFIRM just before this page stopped or timed out,
  // release that candidate/session too. This is best effort because the relay
  // path itself may be the reason the handshake failed.
  void sendControlTo(confirm.address, {
    type: "HELLO_CANCEL",
    v: APP_CONFIG.protocolVersion,
    replyTo: confirm.replyTo,
    nonce: confirm.nonce,
    session: confirm.session,
  }).catch(() => {});
}

function settleHandshake(error = null) {
  if (!handshakeWaiter) return;
  const waiter = handshakeWaiter;
  handshakeWaiter = null;
  clearTimeout(waiter.timer);
  if (error) {
    cancelRemoteHandshake(waiter);
    waiter.reject(error);
  }
  else waiter.resolve();
}

async function connectToPeer(address) {
  if (!support.ok || !APP_CONFIG.roomsEnabled) return false;
  const normalized = String(address || "").trim();
  if (!validAddress(normalized)) {
    setStatus(t("invalid_address"), "error");
    $("send-addr").focus();
    return false;
  }
  if (activeSession) {
    if (activePeerAddress === normalized) return true;
    setStatus(t("status_busy"), "error");
    return false;
  }
  if (handshakeWaiter || pendingHandshakeNonce) {
    setStatus(t("status_connecting"), "loading");
    return false;
  }
  pendingPeerAddress = normalized;
  pendingHandshakeNonce = randomID();
  $("send-addr").value = normalized;
  $("connect-btn").disabled = true;
  setMobileState("connecting");
  setStatus(t("status_connecting"), "loading");
  await wakeLocks.acquire("handshake");
  try {
    await startRoom();
  } catch (_) {
    pendingPeerAddress = "";
    pendingHandshakeNonce = "";
    $("connect-btn").disabled = !tcTest.ready;
    await wakeLocks.release("handshake");
    return false;
  }
  const wait = waitForHandshake(normalized, pendingHandshakeNonce);
  try {
    const nonce = pendingHandshakeNonce;
    void sendControlTo(normalized, {
      type: "HELLO",
      v: APP_CONFIG.protocolVersion,
      replyTo: localAddress,
      nonce: pendingHandshakeNonce,
      capabilities: localCapabilities(),
    }).then(() => {
      // A valid peer keeps the HELLO stream open through ACK and CONFIRM, so
      // an early clean EOF means no confirmation will arrive.
      if (handshakeWaiter?.nonce === nonce) settleHandshake(new Error("handshake ended without confirmation"));
    }, (error) => {
      // Once CONFIRM has settled the waiter, a late FIN/read error on the
      // original HELLO stream must not undo the established session.
      if (handshakeWaiter?.nonce === nonce) settleHandshake(error);
    });
    await wait;
    addMessage({ type: "system", text: t("system_connected") });
    return true;
  } catch (error) {
    pendingPeerAddress = "";
    pendingHandshakeNonce = "";
    settleHandshake(error);
    setStatus(format("status_failed", { message: redact(error.message) }), "error");
    recordError(error);
    return false;
  } finally {
    await wakeLocks.release("handshake");
    $("connect-btn").disabled = !tcTest.ready;
    if (!activeSession) setMobileState(restingMobileState());
  }
}

function routeIncomingConnection(connection) {
  if (!listener) {
    connection.close();
    return;
  }
  const routes = new Map([
    [APP_CONFIG.ports.control, { handler: receiveControl, limit: 12 }],
    [APP_CONFIG.ports.text, { handler: receiveText, limit: 8 }],
    [APP_CONFIG.ports.file, { handler: receiveFile, limit: 2 }],
    [APP_CONFIG.ports.voice, { handler: receiveVoice, limit: 2 }],
    [APP_CONFIG.ports.group, { handler: receiveGroupConnection, limit: 32 }],
  ]);
  const route = routes.get(connection.port);
  if (!route) {
    connection.close(); // No legacy raw or whole-file fallback.
    return;
  }
  const count = inboundConnectionCounts.get(connection.port) || 0;
  if (count >= route.limit) {
    connection.close();
    return;
  }
  inboundConnectionCounts.set(connection.port, count + 1);
  void route.handler(connection).catch((error) => {
    if (connection.port === APP_CONFIG.ports.group) recordGroupError(error);
    else recordError(error);
  }).finally(() => {
    const remaining = (inboundConnectionCounts.get(connection.port) || 1) - 1;
    if (remaining > 0) inboundConnectionCounts.set(connection.port, remaining);
    else inboundConnectionCounts.delete(connection.port);
  });
}

async function receiveGroupConnection(connection) {
  if (!groupFeatureAvailable() || !groupRoom?.active || listenerMode !== "group") {
    connection.close();
    return;
  }
  await groupRoom.handleIncoming(connection);
}

async function receiveControl(connection) {
  try {
    // Parse the bounded TCH1 header before EOF so the optional authenticated
    // native-file signaling stream can remain open across SDP and ICE frames.
    const reader = new ConnectionReader(connection);
    const header = await reader.readExact(8);
    const length = new DataView(header.buffer).getUint32(4);
    if (new TextDecoder().decode(header.subarray(0, 4)) !== "TCH1"
      || length > APP_CONFIG.limits.controlBytes) throw new Error("invalid control header");
    const json = await reader.readExact(length);
    const meta = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json));
    if (meta.type === "NATIVE_FILE_SIGNAL_PIPE") {
      if (!hasSession(meta) || !nativeFileSupported({ mode: "private" })) throw new Error("native signal session rejected");
      const peer = nativeFilePeer({ mode: "private", session: activeSession }, true);
      const mux = attachNativeSignalPipe(peer, connection);
      await mux.ended.promise;
      return;
    }
    const payload = await readAllBounded(connection, 1);
    if (payload.length) throw new Error("control message cannot have a payload");
    if (meta.type === "HELLO") {
      await wakeLocks.acquire("handshake");
      try {
        await receiveHello(meta);
      } finally {
        await wakeLocks.release("handshake");
      }
      return;
    }
    if (meta.type === "HELLO_ACK") {
      await receiveHelloAck(meta);
      return;
    }
    if (meta.type === "HELLO_CONFIRM") {
      receiveHelloConfirm(meta);
      return;
    }
    if (meta.type === "HELLO_CANCEL") {
      receiveHelloCancel(meta);
      return;
    }
    if (meta.type === "HELLO_REJECT") {
      receiveHelloReject(meta);
      return;
    }
    if (!hasSession(meta)) throw new Error("control session rejected");
    if (meta.type === "NATIVE_FILE_SIGNAL") {
      const peer = nativeFilePeers.get(JSON.stringify([activeSession, activePeerAddress]));
      if (!peer) throw new Error("native file signal has no authorized transfer");
      // A control stream acknowledges delivery, not completion of a whole
      // offer/answer exchange. Waiting here would make REQUEST → OFFER →
      // ANSWER recursively wait on the offerer's serialized signal handler.
      void peer.manager.handleSignal(meta.signal).catch((error) => recordError(error));
      return;
    }
    if (meta.type === "SESSION_PING") {
      if (typeof meta.pingId !== "string" || meta.pingId.length !== 32) throw new Error("invalid heartbeat");
      await connection.write(packChatEnvelope(sessionMeta("SESSION_PONG", { pingId: meta.pingId })));
      await connection.closeWrite();
      return;
    }
    if (meta.type === "SESSION_END") {
      endLiveLink(false, t("call_ended"));
      cancelAllTransfers();
      clearPeer();
      addMessage({ type: "system", text: t("system_left") });
    } else {
      noteAuthenticatedPeerTraffic();
      if (meta.type === "RTC_OFFER") await showIncomingCall(meta);
      else if (meta.type === "RTC_ANSWER" && peerConnection && meta.callId === currentCallId) await acceptRTCAnswer(meta);
      else if (meta.type === "RTC_RESTART_OFFER" && peerConnection && meta.callId === currentCallId) await acceptRTCRestartOffer(meta);
      else if (meta.type === "RTC_RESTART_ANSWER" && peerConnection && meta.callId === currentCallId) await acceptRTCRestartAnswer(meta);
      else if (meta.type === "RTC_DECLINE" && meta.callId === currentCallId) endLiveLink(false, t("call_declined"));
      else if (meta.type === "RTC_HANGUP"
        && (meta.callId === currentCallId || meta.callId === pendingCallOffer?.callId)) {
        endLiveLink(false, t("call_ended"));
      }
    }
  } catch (error) {
    recordError(error);
  } finally {
    connection.close();
  }
}

async function receiveHello(meta) {
  const replyTo = meta?.replyTo;
  const nonce = meta?.nonce;
  if (!validAddress(replyTo) || typeof nonce !== "string" || nonce.length !== 32) return;
  if (groupRoom?.active || listenerMode === "group") {
    await sendHandshakeReply(replyTo, {
      type: "HELLO_REJECT",
      v: APP_CONFIG.protocolVersion,
      nonce,
      reason: "GROUP_PROTOCOL_REQUIRED",
    }).catch(recordGroupError);
    return;
  }
  if (meta.v !== APP_CONFIG.protocolVersion) {
    await sendHandshakeReply(replyTo, { type: "HELLO_REJECT", v: APP_CONFIG.protocolVersion, nonce, reason: "PROTOCOL" }).catch(recordError);
    return;
  }
  if (activeSession) {
    if (replyTo === activePeerAddress && nonce === activePeerNonce) {
      await sendHandshakeReply(replyTo, {
        type: "HELLO_ACK",
        v: APP_CONFIG.protocolVersion,
        nonce,
        replyTo: localAddress,
        session: activeSession,
        capabilities: localCapabilities(),
      }).catch(recordError);
    } else {
      await sendHandshakeReply(replyTo, { type: "HELLO_REJECT", v: APP_CONFIG.protocolVersion, nonce, reason: "BUSY" }).catch(recordError);
    }
    return;
  }
  // Do not create two competing sessions when both pages manually initiate a
  // connection at once, or while another inbound ACK is still in flight. A
  // caller can retry after the current attempt settles.
  if (pendingHandshakeNonce || pendingInboundHandshake) {
    await sendHandshakeReply(replyTo, { type: "HELLO_REJECT", v: APP_CONFIG.protocolVersion, nonce, reason: "BUSY" }).catch(recordError);
    return;
  }
  const session = randomID();
  const candidate = {
    replyTo,
    nonce,
    session,
    capabilities: validCapabilities(meta.capabilities),
    timer: null,
  };
  pendingInboundHandshake = candidate;
  candidate.timer = setTimeout(() => clearPendingInboundHandshake(candidate), HANDSHAKE_TIMEOUT_MS);
  try {
    const sent = await sendHandshakeReply(replyTo, {
      type: "HELLO_ACK",
      v: APP_CONFIG.protocolVersion,
      nonce,
      replyTo: localAddress,
      session,
      capabilities: localCapabilities(),
    });
    if (!sent) throw new Error("handshake reply rate limited");
  } finally {
    // The ACK stream only remains pending while the caller sends a separate
    // HELLO_CONFIRM. If the stream closes without that confirmation, release
    // the candidate instead of leaving a ghost session behind.
    if (pendingInboundHandshake === candidate && !activeSession) clearPendingInboundHandshake(candidate);
  }
}

function clearPendingInboundHandshake(candidate = null) {
  if (!pendingInboundHandshake || (candidate && pendingInboundHandshake !== candidate)) return;
  clearTimeout(pendingInboundHandshake.timer);
  pendingInboundHandshake = null;
}

function receiveHelloConfirm(meta) {
  if (meta.v !== APP_CONFIG.protocolVersion
    || !validAddress(meta.replyTo)
    || typeof meta.nonce !== "string"
    || meta.nonce.length !== 32
    || typeof meta.session !== "string"
    || meta.session.length !== 32) return;
  // A repeated confirmation for the already selected peer is harmless and
  // lets the dialler finish if the previous response was interrupted.
  if (activeSession) {
    if (meta.replyTo === activePeerAddress
      && meta.nonce === activePeerNonce
      && meta.session === activeSession) noteAuthenticatedPeerTraffic();
    return;
  }
  const candidate = pendingInboundHandshake;
  if (!candidate
    || meta.replyTo !== candidate.replyTo
    || meta.nonce !== candidate.nonce
    || meta.session !== candidate.session) return;
  clearPendingInboundHandshake(candidate);
  setPeerConnected(candidate.replyTo, candidate.session, candidate.capabilities, candidate.nonce);
  addMessage({ type: "system", text: t("system_joined") });
}

function receiveHelloCancel(meta) {
  if (meta.v !== APP_CONFIG.protocolVersion
    || !validAddress(meta.replyTo)
    || typeof meta.nonce !== "string"
    || meta.nonce.length !== 32
    || typeof meta.session !== "string"
    || meta.session.length !== 32) return;
  const candidate = pendingInboundHandshake;
  if (candidate
    && meta.replyTo === candidate.replyTo
    && meta.nonce === candidate.nonce
    && meta.session === candidate.session) {
    clearPendingInboundHandshake(candidate);
    return;
  }
  if (activeSession
    && meta.replyTo === activePeerAddress
    && meta.nonce === activePeerNonce
    && meta.session === activeSession) {
    clearPeer();
    addMessage({ type: "system", text: t("system_left") });
  }
}

async function receiveHelloAck(meta) {
  if (meta.v !== APP_CONFIG.protocolVersion
    || !handshakeWaiter
    || meta.nonce !== pendingHandshakeNonce
    || meta.nonce !== handshakeWaiter.nonce
    || meta.replyTo !== pendingPeerAddress
    || meta.replyTo !== handshakeWaiter.address
    || typeof meta.session !== "string"
    || meta.session.length !== 32) return;
  const waiter = handshakeWaiter;
  clearTimeout(waiter.timer);
  waiter.confirm = {
    address: meta.replyTo,
    replyTo: localAddress,
    nonce: meta.nonce,
    session: meta.session,
  };
  waiter.timer = setTimeout(() => {
    if (handshakeWaiter === waiter) settleHandshake(new Error("handshake confirmation timed out"));
  }, HANDSHAKE_CONFIRM_TIMEOUT_MS);
  try {
    await sendControlTo(meta.replyTo, {
      type: "HELLO_CONFIRM",
      v: APP_CONFIG.protocolVersion,
      replyTo: localAddress,
      nonce: meta.nonce,
      session: meta.session,
    });
  } catch (error) {
    if (handshakeWaiter === waiter) settleHandshake(error);
    throw error;
  }
  // The user may have stopped the room while the confirmation was in flight.
  if (handshakeWaiter !== waiter
    || waiter.nonce !== pendingHandshakeNonce
    || waiter.address !== pendingPeerAddress
    || activeSession) return;
  setPeerConnected(meta.replyTo, meta.session, meta.capabilities, meta.nonce);
  settleHandshake();
}

function receiveHelloReject(meta) {
  if (!handshakeWaiter || meta.nonce !== pendingHandshakeNonce || meta.nonce !== handshakeWaiter.nonce) return;
  const key = meta.reason === "BUSY"
    ? "status_busy"
    : (meta.reason === "GROUP_PROTOCOL_REQUIRED" ? "group_protocol_required" : "status_protocol");
  const error = new Error(t(key));
  settleHandshake(error);
  setStatus(t(key), "error");
}

// ---- Text and message rendering ----------------------------------------

const renderedMessages = [];
let renderedMessageBytes = 0;
let renderedMessageOrdinal = 0;
const pendingGroupDrafts = new Map();
const privateTextQueues = new Map();
let sendButtonFeedbackTimer = null;

function privateTextQueueFor(session, peerAddress) {
  let queue = privateTextQueues.get(session);
  if (queue && queue.peerAddress !== peerAddress) {
    closePrivateTextQueue(session);
    queue = null;
  }
  if (!queue) {
    queue = {
      session,
      peerAddress,
      tail: Promise.resolve(),
      frames: 0,
      bytes: 0,
      pending: new Set(),
      closed: false,
    };
    privateTextQueues.set(session, queue);
  }
  return queue;
}

function closePrivateTextQueue(session) {
  const queue = privateTextQueues.get(session);
  if (!queue) return;
  queue.closed = true;
  for (const message of queue.pending) updateMessageDelivery(message, "failed");
  if (queue.frames === 0) privateTextQueues.delete(session);
}

function clearSubmittedText() {
  const input = $("send-text");
  input.value = "";
  try {
    input.focus({ preventScroll: true });
  } catch (_) {
    input.focus();
  }
}

function showQueuedSendFeedback() {
  const button = $("send-text-btn");
  button.classList.add("queued");
  button.dataset.feedback = "queued";
  clearTimeout(sendButtonFeedbackTimer);
  sendButtonFeedbackTimer = setTimeout(() => {
    button.classList.remove("queued");
    delete button.dataset.feedback;
  }, 600);
}

function deliveryStatusKey(state, context) {
  if (state === "sending") return "message_pending";
  if (state === "reconnecting") return "message_retrying";
  if (state === "failed") return "message_send_failed";
  if (state === "delivered") return context === "group" ? "group_message_committed" : "message_delivered";
  return "";
}

function isRenderedMessage(message) {
  return Boolean(message && renderedMessages.includes(message) && message.article?.isConnected);
}

function insertRenderedMessage(message) {
  const history = $("history");
  if (message.groupOrdered && !message.localOnly) {
    const localIndex = renderedMessages.findIndex((candidate) => candidate.localOnly);
    if (localIndex >= 0) {
      history.insertBefore(message.article, renderedMessages[localIndex].article);
      renderedMessages.splice(localIndex, 0, message);
      return;
    }
  }
  history.append(message.article);
  renderedMessages.push(message);
}

function moveMessageToCommittedTail(message) {
  const currentIndex = renderedMessages.indexOf(message);
  if (currentIndex < 0) return;
  renderedMessages.splice(currentIndex, 1);
  const localIndex = renderedMessages.findIndex((candidate) => candidate.localOnly);
  if (localIndex >= 0) {
    $("history").insertBefore(message.article, renderedMessages[localIndex].article);
    renderedMessages.splice(localIndex, 0, message);
    return;
  }
  $("history").append(message.article);
  renderedMessages.push(message);
}

function updateMessageDelivery(message, state) {
  if (!isRenderedMessage(message)) return false;
  message.deliveryState = state;
  message.localOnly = message.deliveryContext === "group"
    && (state === "sending" || state === "reconnecting");
  message.article.dataset.deliveryState = state;
  if (state === "sending" || state === "reconnecting") {
    message.article.setAttribute("aria-busy", "true");
  } else {
    message.article.removeAttribute("aria-busy");
  }
  const key = deliveryStatusKey(state, message.deliveryContext);
  if (message.delivery && key) {
    message.delivery.dataset.i18n = key;
    message.delivery.textContent = t(key);
  }
  if (state === "delivered" && message.deliveryContext === "group") {
    message.renderOrdinal = ++renderedMessageOrdinal;
    moveMessageToCommittedTail(message);
  }
  return true;
}

function updatePendingGroupMessages(state) {
  const roomId = groupRoom?.roomId;
  for (const draft of pendingGroupDrafts.values()) {
    if (draft.roomId === roomId) updateMessageDelivery(draft.message, state);
  }
}

function failPendingGroupMessage(clientEventId, reason) {
  const draft = pendingGroupDrafts.get(clientEventId);
  if (!draft || draft.roomId !== groupRoom?.roomId) return;
  pendingGroupDrafts.delete(clientEventId);
  updateMessageDelivery(draft.message, "failed");
  setStatus(format("message_send_failed_status", { message: redact(reason) }), "error");
}

function sendText() {
  const text = $("send-text").value;
  if (!text.trim()) return;
  if (groupRoom?.active) {
    if (!groupRoom.canSend) {
      setStatus(t("group_status_paused"), "error");
      return;
    }
    const payload = encoder.encode(text);
    if (payload.length > APP_CONFIG.limits.textBytes) {
      setStatus(t("message_too_large"), "error");
      return;
    }
    const controller = groupRoom;
    const member = groupMemberById(controller.memberId);
    const roomId = controller.roomId;
    const clientEventId = randomBase64URL(16);
    const message = addMessage({
      type: "text",
      text,
      mine: true,
      senderName: member?.displayName,
      senderCode: member?.code,
      senderRole: member?.role,
      deliveryState: "sending",
      deliveryContext: "group",
      groupOrdered: true,
    });
    pendingGroupDrafts.set(clientEventId, { roomId, text, message });
    clearSubmittedText();
    showQueuedSendFeedback();
    setStatus(t("group_message_sending"), "loading");
    void controller.sendText(text, clientEventId).then((result) => {
      const submitted = pendingGroupDrafts.get(clientEventId);
      if (submitted?.roomId !== roomId) return;
      if (result?.recovering) updateMessageDelivery(submitted.message, "reconnecting");
    }, (error) => {
      const submitted = pendingGroupDrafts.get(clientEventId);
      if (submitted?.roomId !== roomId) return;
      pendingGroupDrafts.delete(clientEventId);
      updateMessageDelivery(submitted.message, "failed");
      setStatus(format("message_send_failed_status", { message: redact(error.message) }), "error");
      recordGroupError(error);
    });
    return;
  }
  if (!activeSession || !activePeerAddress) {
    setStatus(t("need_peer"), "error");
    return;
  }
  const payload = encoder.encode(text);
  if (payload.length > APP_CONFIG.limits.textBytes) {
    setStatus(t("message_too_large"), "error");
    return;
  }
  const session = activeSession;
  const peerAddress = activePeerAddress;
  const queue = privateTextQueueFor(session, peerAddress);
  if (queue.frames + 1 > APP_CONFIG.group.sendQueueMaxFrames
    || queue.bytes + payload.length > APP_CONFIG.group.sendQueueMaxBytes) {
    setStatus(t("message_queue_full"), "error");
    return;
  }
  const messageId = randomID();
  const message = addMessage({
    type: "text",
    text,
    mine: true,
    deliveryState: "sending",
    deliveryContext: "private",
  });
  queue.frames += 1;
  queue.bytes += payload.length;
  queue.pending.add(message);
  clearSubmittedText();
  showQueuedSendFeedback();
  setStatus(t("message_sending"), "loading");
  const send = async () => {
    try {
      if (queue.closed || activeSession !== session || activePeerAddress !== peerAddress) {
        throw new Error("the room changed before this message could be sent");
      }
      setStatus(t("message_sending"), "loading");
      const response = await sendChatEnvelopeTo(
        peerAddress,
        { type: "TEXT", session, messageId },
        payload,
        APP_CONFIG.ports.text,
      );
      const ack = unpackChatEnvelope(response);
      if (ack.payload.length
        || ack.meta.type !== "TEXT_ACK"
        || !sessionMatches(ack.meta, session)
        || ack.meta.messageId !== messageId) throw new Error("text acknowledgement rejected");
      updateMessageDelivery(message, "delivered");
      if (activeSession === session && activePeerAddress === peerAddress) {
        setStatus(t("message_delivered"), "connected");
        noteAuthenticatedPeerTraffic();
      }
    } catch (error) {
      const cancelledWithRoom = queue.closed
        && (activeSession !== session || activePeerAddress !== peerAddress);
      updateMessageDelivery(message, "failed");
      if (activeSession === session && activePeerAddress === peerAddress) {
        setStatus(format("message_send_failed_status", { message: redact(error.message) }), "error");
      }
      if (!cancelledWithRoom) recordError(error);
    } finally {
      queue.pending.delete(message);
      queue.frames = Math.max(0, queue.frames - 1);
      queue.bytes = Math.max(0, queue.bytes - payload.length);
      if (queue.frames === 0 && privateTextQueues.get(session) === queue) privateTextQueues.delete(session);
    }
  };
  const queued = queue.tail.then(send, send);
  queue.tail = queued.catch(() => {});
}

async function receiveText(connection) {
  try {
    const bytes = await readAllBounded(connection, APP_CONFIG.limits.textBytes + APP_CONFIG.limits.controlBytes + 8);
    const { meta, payload } = unpackChatEnvelope(bytes);
    if (meta.type !== "TEXT"
      || !hasSession(meta)
      || typeof meta.messageId !== "string"
      || meta.messageId.length !== 32
      || payload.length > APP_CONFIG.limits.textBytes) throw new Error("text session or size rejected");
    addMessage({ type: "text", text: decoder.decode(payload), mine: false });
    await connection.write(packChatEnvelope(sessionMeta("TEXT_ACK", { messageId: meta.messageId })));
    await connection.closeWrite();
    setStatus(t("message_received"), "connected");
    noteAuthenticatedPeerTraffic();
  } catch (error) {
    recordError(error);
  } finally {
    connection.close();
  }
}

function addMessage(item) {
  $("welcome")?.remove();
  const article = document.createElement("article");
  article.className = `message${item.mine ? " mine" : ""}${item.type === "system" ? " system" : ""}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  let objectURL = "";
  let retainedBytes = 256;
  if (item.type === "text" || item.type === "system") {
    bubble.textContent = item.text;
    retainedBytes += encoder.encode(String(item.text || "")).length;
  } else if (item.type === "voice") {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.playsInline = true;
    audio.preload = "metadata";
    objectURL = URL.createObjectURL(item.blob);
    audio.src = objectURL;
    retainedBytes += item.blob.size;
    bubble.append(audio);
  } else if (item.type === "file") {
    const summary = document.createElement("div");
    summary.className = "file-summary";
    const glyph = document.createElement("span");
    glyph.className = "file-glyph";
    glyph.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = item.name;
    const detail = document.createElement("span");
    detail.textContent = `${humanSize(item.size)} · ${item.status || ""}`;
    copy.append(name, detail);
    summary.append(glyph, copy);
    bubble.append(summary);
  }
  if (item.type === "system") {
    article.append(bubble);
  } else {
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const who = item.senderName
      ? groupMemberIdentity({ displayName: item.senderName, code: item.senderCode, role: item.senderRole })
      : item.mine ? t("you") : t("peer");
    meta.textContent = `${who} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    if (item.mine && item.deliveryState) {
      const delivery = document.createElement("span");
      const key = deliveryStatusKey(item.deliveryState, item.deliveryContext);
      delivery.className = "message-delivery-status";
      delivery.dataset.i18n = key;
      delivery.textContent = t(key);
      meta.append(document.createTextNode(" · "), delivery);
    }
    article.append(meta, bubble);
  }
  const delivery = article.querySelector(".message-delivery-status");
  const message = {
    article,
    bubble,
    delivery,
    deliveryContext: item.deliveryContext || "",
    deliveryState: item.deliveryState || "",
    groupOrdered: Boolean(item.groupOrdered),
    renderOrdinal: ++renderedMessageOrdinal,
    localOnly: Boolean(
      item.deliveryContext === "group"
      && item.mine
      && (item.deliveryState === "sending" || item.deliveryState === "reconnecting"),
    ),
    objectURL,
    retainedBytes,
  };
  if (item.deliveryState) {
    article.dataset.deliveryState = item.deliveryState;
    if (item.deliveryState === "sending" || item.deliveryState === "reconnecting") {
      article.setAttribute("aria-busy", "true");
    }
  }
  insertRenderedMessage(message);
  renderedMessageBytes += retainedBytes;
  while (renderedMessages.length > MESSAGE_HISTORY_MAX_ITEMS
    || renderedMessageBytes > MESSAGE_HISTORY_MAX_BYTES) {
    let oldestIndex = 0;
    for (let index = 1; index < renderedMessages.length; index += 1) {
      if (renderedMessages[index].renderOrdinal < renderedMessages[oldestIndex].renderOrdinal) oldestIndex = index;
    }
    const [expired] = renderedMessages.splice(oldestIndex, 1);
    if (!expired) break;
    renderedMessageBytes -= expired.retainedBytes;
    for (const media of expired.article.querySelectorAll("audio, video")) {
      media.pause();
      media.removeAttribute("src");
      media.load();
    }
    if (expired.objectURL) URL.revokeObjectURL(expired.objectURL);
    expired.article.remove();
  }
  article.scrollIntoView({ block: "end" });
  return message;
}

addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  for (const message of renderedMessages) {
    if (!message.objectURL) continue;
    URL.revokeObjectURL(message.objectURL);
    message.objectURL = "";
  }
});

function clearMessageHistory() {
  for (const message of renderedMessages) {
    for (const media of message.article.querySelectorAll("audio, video")) {
      media.pause();
      media.removeAttribute("src");
      media.load();
    }
    if (message.objectURL) URL.revokeObjectURL(message.objectURL);
    message.article.remove();
  }
  renderedMessages.length = 0;
  renderedMessageBytes = 0;
  renderedMessageOrdinal = 0;
}

// ---- TCF1 streaming file protocol --------------------------------------

function fileWireMeta(context, type, extra = {}) {
  if (context.mode === "group") {
    return {
      type,
      v: APP_CONFIG.protocolVersion,
      mode: "group",
      gv: GROUP_PROTOCOL_VERSION,
      roomId: context.roomId,
      senderId: context.senderId,
      recipientId: context.recipientId,
      transferId: context.transferId,
      ...extra,
    };
  }
  return {
    type,
    v: APP_CONFIG.protocolVersion,
    session: context.session,
    transferId: context.transferId,
    ...extra,
  };
}

function fileWireMatches(meta, context) {
  if (context.mode === "group") {
    return meta?.v === APP_CONFIG.protocolVersion
      && meta.mode === "group"
      && meta.gv === GROUP_PROTOCOL_VERSION
      && meta.roomId === context.roomId
      && meta.senderId === context.senderId
      && meta.recipientId === context.recipientId
      && meta.transferId === context.transferId;
  }
  return sessionMatches(meta, context.session) && meta.transferId === context.transferId;
}

function noteFileTraffic(context) {
  if (context.mode !== "group") noteAuthenticatedPeerTraffic();
}

let activeFileTransfer = null;
let incomingFileTransfer = null;
const outgoingFileQueue = [];
const finishedTransferItems = [];
let processingFileQueue = false;

function peerCanReceiveFiles() {
  return peerCapabilities?.file?.protocol === "TCF1" && peerCapabilities.file.receive === true;
}

function peerMaximumFileBytes() {
  const advertised = Number(peerCapabilities?.file?.maxBytes);
  if (!Number.isSafeInteger(advertised) || advertised < 0) return APP_CONFIG.limits.fileBytes;
  return Math.min(APP_CONFIG.limits.fileBytes, advertised);
}

function renderTransferCount() {
  const count = $("transfer-list").children.length;
  $("queue-count").textContent = String(count);
  $("transfer-tray").classList.toggle("hidden", count === 0);
}

function removeFinishedTransferReference(item) {
  for (let index = finishedTransferItems.length - 1; index >= 0; index -= 1) {
    if (finishedTransferItems[index] === item) finishedTransferItems.splice(index, 1);
  }
}

function markGroupTransferItem(ui, roomId) {
  if (!ui?.item || typeof roomId !== "string" || !roomId) return ui;
  groupTransferRooms.set(ui.item, roomId);
  groupTransferItems.add(ui.item);
  return ui;
}

function discardGroupTransferItem(item) {
  if (!item || stagedTransferItems.has(item)) return false;
  item.dataset.discarded = "true";
  for (const control of item.querySelectorAll("button")) {
    control.onclick = null;
    control.disabled = true;
  }
  removeFinishedTransferReference(item);
  transferItemCleanups.delete(item);
  groupTransferItems.delete(item);
  item.remove();
  return true;
}

function discardGroupTransferItems(roomId = "") {
  for (const item of [...groupTransferItems]) {
    if (roomId && groupTransferRooms.get(item) !== roomId) continue;
    discardGroupTransferItem(item);
  }
  renderTransferCount();
}

function pruneFinishedTransferItems() {
  let removableCount = finishedTransferItems.reduce(
    (count, item) => count + (stagedTransferItems.has(item) ? 0 : 1),
    0,
  );
  while (removableCount > MAX_TRANSFER_HISTORY_ITEMS) {
    const index = finishedTransferItems.findIndex((item) => !stagedTransferItems.has(item));
    if (index < 0) break;
    const [removed] = finishedTransferItems.splice(index, 1);
    const cleanup = transferItemCleanups.get(removed);
    if (cleanup) void cleanup().catch(recordError);
    transferItemCleanups.delete(removed);
    groupTransferItems.delete(removed);
    removed?.remove();
    removableCount -= 1;
    if (!activeSession) setMobileState(restingMobileState());
  }
}

function finishTransferItem(ui) {
  if (!ui?.item || ui.item.dataset.finished === "true") return;
  if (ui.item.dataset.discarded === "true" && !stagedTransferItems.has(ui.item)) {
    groupTransferItems.delete(ui.item);
    return;
  }
  ui.item.dataset.finished = "true";
  for (const control of [ui.cancel, ui.save, ui.reject]) {
    if (!control) continue;
    control.onclick = null;
    control.disabled = true;
  }
  finishedTransferItems.push(ui.item);
  // A verified OPFS file is still user data, not disposable UI history. Keep
  // every staged entry until the user exports or deletes its local copy, and
  // apply the history limit only to entries with no retained file.
  pruneFinishedTransferItems();
  renderTransferCount();
}

function createOutgoingTransferItem(file) {
  const item = document.createElement("li");
  item.className = "transfer-item";
  const copy = document.createElement("div");
  copy.className = "transfer-copy";
  const name = document.createElement("strong");
  name.textContent = sanitizeFileName(file.name);
  const detail = document.createElement("span");
  detail.className = "transfer-detail";
  detail.textContent = format("file_queued", { name: sanitizeFileName(file.name) });
  const progress = document.createElement("progress");
  progress.max = 1;
  progress.value = 0;
  progress.setAttribute("aria-label", t("transfer_progress"));
  progress.dataset.i18nTitle = "transfer_progress";
  copy.append(name, detail, progress);
  const cancel = document.createElement("button");
  cancel.className = "button small danger";
  cancel.type = "button";
  cancel.textContent = t("cancel");
  item.append(copy, cancel);
  $("transfer-list").append(item);
  renderTransferCount();
  return { item, detail, progress, cancel };
}

function createKeyedTransferScheduler(maximum, maximumPending = MAX_PENDING_FILES) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("invalid transfer scheduler limit");
  if (!Number.isSafeInteger(maximumPending) || maximumPending < maximum) {
    throw new Error("invalid transfer scheduler queue limit");
  }
  const lanes = new Map();
  const ready = [];
  let active = 0;
  let pending = 0;

  const pump = () => {
    while (active < maximum && ready.length) {
      const key = ready.shift();
      const lane = lanes.get(key);
      if (!lane || lane.active || !lane.queue.length) continue;
      lane.active = true;
      active += 1;
      void (async () => {
        try {
          while (lane.queue.length) {
            const task = lane.queue.shift();
            try {
              task.resolve(await task.operation());
            } catch (error) {
              task.reject(error);
            } finally {
              lane.pending = Math.max(0, lane.pending - 1);
              pending = Math.max(0, pending - 1);
            }
          }
        } finally {
          lane.active = false;
          active = Math.max(0, active - 1);
          if (lane.queue.length) ready.push(key);
          else if (lanes.get(key) === lane) lanes.delete(key);
          pump();
        }
      })();
    }
  };

  return Object.freeze({
    enqueue(key, scope, operation) {
      if (typeof key !== "string" || !key || typeof scope !== "string" || !scope || typeof operation !== "function") {
        return Promise.reject(new Error("invalid transfer scheduler task"));
      }
      if (pending >= maximumPending) return Promise.reject(new Error("group transfer queue is full"));
      let lane = lanes.get(key);
      if (!lane) {
        lane = { active: false, pending: 0, queue: [], scope };
        lanes.set(key, lane);
        ready.push(key);
      }
      if (lane.scope !== scope || lane.pending >= maximumPending) {
        return Promise.reject(new Error("group recipient transfer queue is full"));
      }
      pending += 1;
      lane.pending += 1;
      const result = new Promise((resolve, reject) => lane.queue.push({ operation, resolve, reject }));
      pump();
      return result;
    },
    cancelScope(scope, reason = "group transfer queue cancelled") {
      const error = new Error(reason);
      for (const [key, lane] of lanes) {
        if (lane.scope !== scope || !lane.queue.length) continue;
        const queued = lane.queue.splice(0);
        lane.pending = Math.max(0, lane.pending - queued.length);
        pending = Math.max(0, pending - queued.length);
        for (const task of queued) task.reject(error);
        if (!lane.active && lanes.get(key) === lane) lanes.delete(key);
      }
      pump();
    },
    snapshot: () => Object.freeze({
      active,
      pending,
      lanes: lanes.size,
      queued: [...lanes.values()].reduce((sum, lane) => sum + lane.queue.length, 0),
    }),
  });
}

const groupRecipientTransferScheduler = createKeyedTransferScheduler(APP_CONFIG.group.maxParallelRecipients);

function scheduleGroupRecipientTransfer(roomId, recipientId, operation) {
  return groupRecipientTransferScheduler.enqueue(`${roomId}:${recipientId}`, roomId, operation);
}

function groupTransferRoomIsCurrent(roomId) {
  return Boolean(roomId && groupRoom?.active && groupRoom.roomId === roomId);
}

function groupInboundTransferIsCurrent(controller, epoch, context, generation) {
  if (!controller
    || groupRoom !== controller
    || controller.lifecycleEpoch !== epoch
    || groupTransferGeneration !== generation
    || !controller.active
    || controller.roomId !== context?.roomId
    || controller.memberId !== context?.recipientId) return false;
  const members = controller.snapshot().members;
  return members.some((member) => member.id === context.senderId && member.status === "online")
    && members.some((member) => member.id === context.recipientId && member.status === "online");
}

function assertGroupTransferMayStart(entry, recipientId) {
  if (entry.cancelled) throw new Error(t("file_cancelled"));
  if (entry.generation !== groupTransferGeneration
    || !groupTransferRoomIsCurrent(entry.roomId)
    || !groupRoom?.canSend) {
    throw new Error(t("group_status_paused"));
  }
  if (entry.invalidRecipients.has(recipientId)) throw new Error(t("group_member_removed"));
  const recipient = groupMemberById(recipientId);
  if (!recipient || recipient.status !== "online") throw new Error(t("group_recipient_unavailable"));
}

function assertGroupTransferControllerCurrent(controller, epoch, entry, recipientId) {
  if (!controller || groupRoom !== controller || controller.lifecycleEpoch !== epoch) {
    throw new Error(t("group_status_closed"));
  }
  assertGroupTransferMayStart(entry, recipientId);
}

function createGroupOutgoingTransferItem(file, recipients) {
  const ui = createOutgoingTransferItem(file);
  const statuses = new Map();
  const list = document.createElement("ol");
  list.className = "group-transfer-recipient-list";
  for (const member of recipients) {
    const fragment = $("group-transfer-status-template").content.cloneNode(true);
    i18n.apply(fragment);
    const item = fragment.querySelector(".group-transfer-recipient");
    fragment.querySelector(".group-transfer-recipient-name").textContent = member.displayName;
    fragment.querySelector(".group-transfer-recipient-code").textContent = `#${member.code}`;
    const output = fragment.querySelector(".group-transfer-recipient-status");
    statuses.set(member.id, { item, output });
    list.append(fragment);
  }
  ui.item.querySelector(".transfer-copy")?.append(list);
  return markGroupTransferItem({ ...ui, statuses }, groupRoom?.roomId);
}

function setGroupTransferRecipientStatus(entry, recipientId, key, state) {
  const status = entry.ui.statuses.get(recipientId);
  if (!status) return;
  status.item.dataset.status = state;
  status.output.dataset.i18n = key;
  status.output.textContent = t(key);
}

function summarizeGroupTransfer(entry, successKey) {
  const states = [...entry.ui.statuses.values()].map(({ item }) => item.dataset.status);
  const complete = states.filter((state) => state === "complete").length;
  const total = states.length;
  if (entry.cancelled) return { complete, total, message: t(successKey === "file_sent" ? "file_cancelled" : "voice_discarded"), ok: false };
  if (total > 0 && complete === total) return { complete, total, message: t(successKey), ok: true };
  if (complete > 0) return { complete, total, message: format("group_transfer_partial", { complete, total }), ok: false };
  return { complete, total, message: t("group_transfer_none_complete"), ok: false };
}

function enqueueGroupFiles(files) {
  if (!groupRoom?.canSend) {
    setStatus(t("group_status_paused"), "error");
    return;
  }
  const recipientIds = selectedGroupRecipientIds();
  if (!recipientIds.length) {
    setStatus(t("group_no_recipients"), "error");
    return;
  }
  const requested = Array.from(files);
  const available = Math.max(0, MAX_PENDING_FILES - groupOutgoingTransfers.size);
  const selected = requested.slice(0, available);
  if (selected.length < requested.length) setStatus(t("file_queue_limit"), "error");
  if (!selected.length) return;
  const validFiles = selected.filter((file) => {
    if (validFileSize(file.size)) return true;
    setStatus(format("file_too_large", { name: sanitizeFileName(file.name) }), "error");
    return false;
  });
  try {
    groupBatchBytes(validFiles, recipientIds.length, APP_CONFIG.group.maxBatchBytes);
  } catch (_) {
    setStatus(t("group_batch_too_large"), "error");
    return;
  }
  const snapshot = groupRoom.snapshot();
  const recipients = snapshot.members.filter((member) => recipientIds.includes(member.id));
  if (recipients.length !== recipientIds.length) {
    setStatus(t("group_no_recipients"), "error");
    return;
  }
  const entries = validFiles.map((file) => {
    const entry = {
      kind: "file",
      file,
      name: sanitizeFileName(file.name),
      transferId: randomID(),
      recipients,
      cancelled: false,
      connections: new Set(),
      invalidRecipients: new Set(),
      generation: groupTransferGeneration,
      roomId: snapshot.roomId,
      completed: 0,
      ui: null,
    };
    entry.ui = createGroupOutgoingTransferItem(file, recipients);
    groupOutgoingTransfers.add(entry);
    entry.ui.cancel.onclick = () => {
      entry.cancelled = true;
      entry.ui.detail.textContent = t("file_cancelled");
      for (const active of entry.connections) {
        active.cancelled = true;
        safeConnectionClose(active.connection);
      }
      entry.ui.cancel.disabled = true;
    };
    return entry;
  });
  if (!entries.length) return;
  void processGroupFileBatch(entries, recipientIds).catch((error) => {
    if (groupTransferRoomIsCurrent(snapshot.roomId)) {
      setStatus(format("file_failed", { message: redact(error.message) }), "error");
    }
    recordGroupError(error);
  });
}

async function processGroupFileBatch(entries, recipientIds) {
  const batchItems = entries.map((entry) => ({ transferId: entry.transferId, size: entry.file.size }));
  // A recipient can accept only one TCF1 stream at a time. Hold one of the
  // two global recipient slots and send that recipient's files serially;
  // different recipients may still progress independently.
  const recipients = entries[0]?.recipients || [];
  const tasks = recipients.map((recipient) => scheduleGroupRecipientTransfer(
    entries[0]?.roomId || "",
    recipient.id,
    async () => {
      for (const entry of entries) {
        try {
          assertGroupTransferMayStart(entry, recipient.id);
          // A ticket is issued only when this recipient reaches a transfer
          // slot and the preceding file for that recipient has completed.
          const response = await groupRoom.requestTransferTickets({
            kind: "file",
            items: batchItems,
            recipientIds,
            targetTransferId: entry.transferId,
            targetRecipientId: recipient.id,
          });
          const grant = response.grants[0];
          if (!grant) throw new Error(response.failures[0]?.reason || "transfer ticket rejected");
          assertGroupTransferMayStart(entry, recipient.id);
          await sendGroupFileTransfer(entry, grant);
          setGroupTransferRecipientStatus(entry, recipient.id, "group_transfer_complete", "complete");
        } catch (error) {
          const rejected = error?.groupTransferStatus === "rejected";
          setGroupTransferRecipientStatus(
            entry,
            recipient.id,
            rejected ? "group_transfer_rejected" : "group_transfer_failed",
            rejected ? "rejected" : "failed",
          );
          if (!entry.cancelled) recordGroupError(error);
        } finally {
          entry.completed += 1;
          entry.ui.progress.value = entry.recipients.length ? entry.completed / entry.recipients.length : 1;
        }
      }
    },
  ));
  await Promise.allSettled(tasks);
  for (const entry of entries) {
    for (const recipient of entry.recipients) {
      const recipientStatus = entry.ui.statuses.get(recipient.id);
      if (recipientStatus?.item.dataset.status) continue;
      setGroupTransferRecipientStatus(entry, recipient.id, "group_transfer_failed", "failed");
      entry.completed += 1;
    }
    const summary = summarizeGroupTransfer(entry, "file_sent");
    entry.ui.progress.value = 1;
    entry.ui.detail.textContent = summary.message;
    entry.ui.cancel.disabled = true;
    finishTransferItem(entry.ui);
    if (!entry.cancelled && summary.complete > 0 && groupTransferRoomIsCurrent(entry.roomId)) addMessage({
      type: "file",
      mine: true,
      name: entry.name,
      size: entry.file.size,
      status: summary.message,
      senderName: groupMemberById(groupRoom.memberId)?.displayName,
      senderCode: groupMemberById(groupRoom.memberId)?.code,
      senderRole: groupMemberById(groupRoom.memberId)?.role,
    });
    entry.file = null;
    groupOutgoingTransfers.delete(entry);
  }
  const states = entries.flatMap((entry) => [...entry.ui.statuses.values()].map(({ item }) => item.dataset.status));
  const completed = states.filter((state) => state === "complete").length;
  const message = completed === states.length && states.length
    ? t("file_sent")
    : (completed ? format("group_transfer_partial", { complete: completed, total: states.length }) : t("group_transfer_none_complete"));
  if (groupTransferRoomIsCurrent(entries[0]?.roomId)) {
    setStatus(message, completed === states.length && states.length ? "connected" : "error");
  }
}

async function sendGroupFileTransfer(entry, grant) {
  const controller = groupRoom;
  const controllerEpoch = controller?.lifecycleEpoch;
  const context = {
    mode: "group",
    roomId: grant.roomId,
    senderId: grant.senderId,
    recipientId: grant.recipientId,
    transferId: grant.transferId,
  };
  let connection = null;
  let active = null;
  let hasher = null;
  let transportEntry = null;
  let sent = 0;
  await wakeLocks.acquire("file-transfer");
  try {
    assertGroupTransferControllerCurrent(controller, controllerEpoch, entry, grant.recipientId);
    if (grant.roomId !== entry.roomId) throw new Error(t("group_status_closed"));
    transportEntry = controller.getTransport(grant.address);
    const transport = await transportEntry;
    try {
      assertGroupTransferControllerCurrent(controller, controllerEpoch, entry, grant.recipientId);
    } catch (error) {
      controller.dropTransport(grant.address, transportEntry);
      throw error;
    }
    try {
      connection = await transport.dial({ port: APP_CONFIG.ports.file });
    } catch (error) {
      controller.dropTransport(grant.address, transportEntry);
      throw error;
    }
    assertGroupTransferControllerCurrent(controller, controllerEpoch, entry, grant.recipientId);
    active = { connection, senderId: grant.senderId, recipientId: grant.recipientId, cancelled: false };
    entry.connections.add(active);
    groupTransferConnections.add(active);
    if (entry.cancelled) throw new Error(t("file_cancelled"));
    const reader = new ConnectionReader(connection, TRANSFER_DECISION_DEADLINE_MS);
    hasher = tailcatNewSHA256();
    const offer = fileWireMeta(context, "OFFER", {
      ticket: grant.ticket,
      nativeFile: nativeFileSupported(context, grant.recipientId)
        ? { v: 1, logicalId: entry.nativeLogicalId ||= randomID() } : undefined,
      name: entry.name,
      size: entry.file.size,
      mime: safeMime(entry.file.type),
      chunkBytes: APP_CONFIG.limits.fileChunkBytes,
    });
    await withConnectionDeadline(connection, (async () => {
      await connection.write(TCF_MAGIC);
      await connection.write(packFileJSON(FILE_FRAME.META, offer));
    })(), STREAM_READ_TIMEOUT_MS, "group file offer write timed out");
    setGroupTransferRecipientStatus(entry, grant.recipientId, "group_transfer_pending", "pending");
    const response = decodeFileJSON(await withConnectionDeadline(
      connection,
      readFileFrame(reader),
      TRANSFER_DECISION_DEADLINE_MS,
      "group file decision timed out",
    ), [FILE_FRAME.META, FILE_FRAME.CANCEL]);
    if (!fileWireMatches(response, context)) throw new Error("group file response rejected");
    if (response.type !== "ACCEPT") {
      const error = new Error(response.reason || t("file_rejected"));
      if (response.type === "REJECT") error.groupTransferStatus = "rejected";
      throw error;
    }
    setGroupTransferRecipientStatus(entry, grant.recipientId, "group_transfer_accepted", "accepted");
    if (offer.nativeFile && response.nativeFile === 1) {
      await sendNativeAcceptedFile(entry, connection, context, response, grant);
      return;
    }
    setGroupTransferRecipientStatus(entry, grant.recipientId, "group_transfer_sending", "transferring");
    const dataDeadlineAt = Date.now() + fileDataDeadlineMs(entry.file.size);
    while (sent < entry.file.size) {
      if (entry.cancelled || active.cancelled) {
        await withConnectionUntil(
          connection,
          connection.write(packFileJSON(FILE_FRAME.CANCEL, fileWireMeta(context, "CANCEL"))),
          dataDeadlineAt,
          "group file cancellation timed out",
        );
        throw new Error(t("file_cancelled"));
      }
      const end = Math.min(sent + APP_CONFIG.limits.fileChunkBytes, entry.file.size);
      const chunk = new Uint8Array(await entry.file.slice(sent, end).arrayBuffer());
      if (chunk.length !== end - sent) throw new Error("file changed while reading");
      await hasher.update(chunk);
      await withConnectionUntil(
        connection,
        connection.write(packFileFrame(FILE_FRAME.DATA, chunk)),
        dataDeadlineAt,
        "group file data deadline exceeded",
      );
      sent = end;
    }
    const digest = await hasher.digestHex();
    await withConnectionUntil(
      connection,
      connection.write(packFileJSON(FILE_FRAME.FINAL, fileWireMeta(context, "FINAL", {
        size: sent,
        sha256: digest,
      }))),
      dataDeadlineAt,
      "group file final deadline exceeded",
    );
    const done = decodeFileJSON(await withConnectionDeadline(
      connection,
      readFileFrame(reader),
      STREAM_READ_TIMEOUT_MS,
      "group file completion timed out",
    ), [FILE_FRAME.FINAL, FILE_FRAME.CANCEL]);
    if (!fileWireMatches(done, context)
      || done.type !== "DONE"
      || done.size !== sent
      || done.sha256 !== digest) throw new Error(done.reason || "receiver verification failed");
  } finally {
    hasher?.close();
    if (active) {
      entry.connections.delete(active);
      groupTransferConnections.delete(active);
    }
    connection?.close();
    await wakeLocks.release("file-transfer");
  }
}

function enqueueFiles(files) {
  if (groupRoom?.active) {
    enqueueGroupFiles(files);
    return;
  }
  if (!activeSession) {
    setStatus(t("need_peer"), "error");
    return;
  }
  const pendingCount = outgoingFileQueue.length + (activeFileTransfer?.direction === "outgoing" ? 1 : 0);
  const available = Math.max(0, MAX_PENDING_FILES - pendingCount);
  const selected = Array.from(files).slice(0, available);
  if (selected.length < files.length) setStatus(t("file_queue_limit"), "error");
  for (const file of selected) {
    const name = sanitizeFileName(file.name);
    if (!validFileSize(file.size)) {
      setStatus(format("file_too_large", { name }), "error");
      continue;
    }
    const peerLimit = peerMaximumFileBytes();
    if (file.size > peerLimit) {
      setStatus(format("file_peer_limit", { name, limit: humanSize(peerLimit) }), "error");
      continue;
    }
    const ui = createOutgoingTransferItem(file);
    const entry = { file, name, ui, cancelled: false, connection: null };
    ui.cancel.onclick = () => {
      entry.cancelled = true;
      ui.detail.textContent = t("file_cancelled");
      if (activeFileTransfer?.entry === entry) {
        // Closing interrupts a sender that is waiting for ACCEPT as well as an
        // active DATA write, so one unresponsive peer cannot stall the queue.
        entry.connection?.close();
      } else {
        const index = outgoingFileQueue.indexOf(entry);
        if (index >= 0) outgoingFileQueue.splice(index, 1);
        ui.cancel.disabled = true;
        entry.file = null;
        finishTransferItem(ui);
      }
    };
    outgoingFileQueue.push(entry);
  }
  processFileQueue();
}

async function processFileQueue() {
  if (processingFileQueue || (incomingFileTransfer && !nativeFilesEnabled())) return;
  processingFileQueue = true;
  try {
    while (outgoingFileQueue.length) {
      if (activeFileTransfer) return;
      const entry = outgoingFileQueue.shift();
      if (entry.cancelled) {
        entry.file = null;
        finishTransferItem(entry.ui);
        continue;
      }
      activeFileTransfer = { direction: "outgoing", entry };
      tcTest.state.file = "sending";
      try {
        await sendFileTransfer(entry);
      } catch (error) {
        entry.ui.detail.textContent = entry.cancelled
          ? t("file_cancelled")
          : format("file_failed", { message: redact(error.message) });
        recordError(error);
      } finally {
        entry.connection?.close();
        entry.connection = null;
        entry.file = null;
        entry.ui.cancel.disabled = true;
        finishTransferItem(entry.ui);
        activeFileTransfer = null;
        tcTest.state.file = "idle";
      }
    }
  } finally {
    processingFileQueue = false;
  }
}

async function sendFileTransfer(entry) {
  if (!activeSession || !activePeerAddress) throw new Error(t("need_peer"));
  if (!peerCanReceiveFiles()) throw new Error(t("unsupported_capability"));
  if (entry.file.size > peerMaximumFileBytes()) {
    throw new Error(format("file_peer_limit", { name: entry.name, limit: humanSize(peerMaximumFileBytes()) }));
  }
  const transferId = randomID();
  const session = activeSession;
  const address = activePeerAddress;
  let connection = null;
  let hasher = null;
  let sent = 0;
  let digest = "";
  tcTest.sendDone = false;
  tcTest.sentBytes = 0;
  tcTest.sentSha256 = null;
  await wakeLocks.acquire("file-transfer");
  try {
    if (nativeFileSupported({ mode: "private" })) {
      const peer = nativeFilePeer({ mode: "private", session }, false);
      const client = await nativeFileControlClient(peer);
      try { await nativeFileSignalPipe(peer); }
      catch (_) { peer.manager.fail(); }
      connection = await client.dial({ port: APP_CONFIG.ports.file });
    } else connection = await tailcatDial({
      addr: address,
      derpMapURL: APP_CONFIG.derpMapURL,
      port: APP_CONFIG.ports.file,
    });
    entry.connection = connection;
    if (entry.cancelled) throw new Error(t("file_cancelled"));
    const reader = new ConnectionReader(connection, TRANSFER_DECISION_DEADLINE_MS);
    hasher = tailcatNewSHA256();
    const offer = {
      type: "OFFER",
      v: APP_CONFIG.protocolVersion,
      session,
      transferId,
      nativeFile: nativeFileSupported({ mode: "private" })
        ? { v: 1, logicalId: entry.nativeLogicalId ||= randomID() } : undefined,
      name: entry.name,
      size: entry.file.size,
      mime: safeMime(entry.file.type),
      chunkBytes: APP_CONFIG.limits.fileChunkBytes,
    };
    await withConnectionDeadline(connection, (async () => {
      await connection.write(TCF_MAGIC);
      await connection.write(packFileJSON(FILE_FRAME.META, offer));
    })(), STREAM_READ_TIMEOUT_MS, "file offer write timed out");
    entry.ui.detail.textContent = t("file_waiting");

    const response = decodeFileJSON(await withConnectionDeadline(
      connection,
      readFileFrame(reader),
      TRANSFER_DECISION_DEADLINE_MS,
      "file decision timed out",
    ), [FILE_FRAME.META, FILE_FRAME.CANCEL]);
    if (response.v !== APP_CONFIG.protocolVersion || response.session !== session || response.transferId !== transferId) {
      throw new Error("file response session rejected");
    }
    if (response.type !== "ACCEPT") {
      if (response.type === "REJECT") {
        if (response.reason === FILE_SINK_REASON.INSUFFICIENT_SPACE
          || response.reason === FILE_SINK_REASON.NO_STORAGE_ESTIMATE) throw new Error(t("file_space_insufficient"));
        if (response.reason === FILE_SINK_REASON.NO_SINK) throw new Error(t("file_receive_unavailable"));
        throw new Error(t("file_rejected"));
      }
      throw new Error(response.reason || t("file_cancelled"));
    }
    noteAuthenticatedPeerTraffic();

    // File bytes are read only after ACCEPT. slice().arrayBuffer() bounds each
    // allocation to 64 KiB; file.arrayBuffer() and whole-file buffering are
    // intentionally never used.
    if (offer.nativeFile && response.nativeFile === 1) {
      await sendNativeAcceptedFile(entry, connection, { mode: "private", session, transferId }, response);
      return;
    }
    while (sent < entry.file.size) {
      if (entry.cancelled) {
        await connection.write(packFileJSON(FILE_FRAME.CANCEL, {
          type: "CANCEL", v: APP_CONFIG.protocolVersion, session, transferId,
        }));
        throw new Error(t("file_cancelled"));
      }
      const end = Math.min(sent + APP_CONFIG.limits.fileChunkBytes, entry.file.size);
      const chunk = new Uint8Array(await entry.file.slice(sent, end).arrayBuffer());
      if (chunk.length !== end - sent) throw new Error("file changed while reading");
      await hasher.update(chunk);
      await connection.write(packFileFrame(FILE_FRAME.DATA, chunk));
      sent = end;
      tcTest.sentBytes = sent;
      entry.ui.progress.value = entry.file.size ? sent / entry.file.size : 1;
      entry.ui.detail.textContent = format("file_sending", {
        name: entry.name,
        sent: humanSize(sent),
        total: humanSize(entry.file.size),
      });
      noteAuthenticatedPeerTraffic();
    }
    if (entry.cancelled) throw new Error(t("file_cancelled"));
    digest = await hasher.digestHex();
    await connection.write(packFileJSON(FILE_FRAME.FINAL, {
      type: "FINAL",
      v: APP_CONFIG.protocolVersion,
      session,
      transferId,
      size: sent,
      sha256: digest,
    }));
    const finalResponse = decodeFileJSON(await withConnectionDeadline(
      connection,
      readFileFrame(reader),
      STREAM_READ_TIMEOUT_MS,
      "file completion timed out",
    ), [FILE_FRAME.FINAL, FILE_FRAME.CANCEL]);
    if (finalResponse.v !== APP_CONFIG.protocolVersion
      || finalResponse.session !== session
      || finalResponse.transferId !== transferId) throw new Error("final file response session rejected");
    if (finalResponse.type !== "DONE" || finalResponse.size !== sent || finalResponse.sha256 !== digest) {
      throw new Error(finalResponse.reason || "receiver verification failed");
    }
    noteAuthenticatedPeerTraffic();
    tcTest.sentSha256 = digest;
    tcTest.sendDone = true;
    entry.ui.progress.value = 1;
    entry.ui.detail.textContent = t("file_sent");
    addMessage({ type: "file", mine: true, name: entry.name, size: entry.file.size, status: t("file_sent") });
    setStatus(t("file_sent"), "connected");
  } finally {
    hasher?.close();
    connection?.close();
    await wakeLocks.release("file-transfer");
  }
}

async function receiveFile(connection) {
  let sink = null;
  let hasher = null;
  let ui = null;
  let accepted = false;
  let completed = false;
  let localArtifactReady = false;
  let terminalWriteStarted = false;
  let offer = null;
  let context = null;
  let groupTicket = null;
  let groupController = null;
  let groupEpoch = 0;
  let groupGeneration = 0;
  let transferState = null;
  const reader = new ConnectionReader(connection, TRANSFER_DECISION_DEADLINE_MS);
  const offerDeadlineAt = Date.now() + STREAM_READ_TIMEOUT_MS;
  await wakeLocks.acquire("file-transfer");
  try {
    const magic = await withConnectionUntil(
      connection,
      reader.readExact(4),
      offerDeadlineAt,
      "file offer preamble timed out",
    );
    if (!equalBytes(magic, TCF_MAGIC)) throw new Error("invalid TCF1 preamble");
    offer = decodeFileJSON(await withConnectionUntil(
      connection,
      readFileFrame(reader),
      offerDeadlineAt,
      "file offer timed out",
    ), [FILE_FRAME.META]);
    const groupOffer = offer.mode === "group";
    if (groupOffer) {
      if (offer.type !== "OFFER"
        || offer.v !== APP_CONFIG.protocolVersion
        || offer.gv !== GROUP_PROTOCOL_VERSION
        || !groupRoom?.active
        || !/^[0-9a-f]{32}$/u.test(offer.transferId)
        || !validFileSize(offer.size)
        || offer.chunkBytes !== APP_CONFIG.limits.fileChunkBytes) throw new Error("group file offer rejected");
      groupController = groupRoom;
      groupEpoch = groupController.lifecycleEpoch;
      groupGeneration = groupTransferGeneration;
      groupTicket = await groupController.consumeTransferTicket(offer, "file", offer.size);
      context = {
        mode: "group",
        roomId: groupTicket.roomId,
        senderId: groupTicket.senderId,
        recipientId: groupTicket.recipientId,
        transferId: groupTicket.transferId,
      };
      if (!groupInboundTransferIsCurrent(groupController, groupEpoch, context, groupGeneration)) {
        throw new Error("group file room changed during ticket validation");
      }
    } else {
      if (offer.type !== "OFFER"
        || offer.v !== APP_CONFIG.protocolVersion
        || !hasSession(offer)
        || typeof offer.transferId !== "string"
        || !/^[0-9a-f]{32}$/u.test(offer.transferId)
        || !validFileSize(offer.size)
        || offer.chunkBytes !== APP_CONFIG.limits.fileChunkBytes) throw new Error("file offer rejected");
      // Capture the authenticated session from the offer. The global session
      // may be cleared while an automatic OPFS sink is being prepared.
      context = { mode: "private", session: offer.session, transferId: offer.transferId };
    }
    offer.name = sanitizeFileName(offer.name);
    offer.mime = safeMime(offer.mime);
    noteFileTraffic(context);

    if (incomingFileTransfer || (activeFileTransfer && !nativeFilesEnabled())) {
      await withConnectionDeadline(
        connection,
        connection.write(packFileJSON(FILE_FRAME.META, fileWireMeta(context, "REJECT", { reason: "BUSY" }))),
        STREAM_READ_TIMEOUT_MS,
        "file busy response timed out",
      );
      return;
    }
    transferState = {
      direction: "incoming",
      connection,
      transferId: offer.transferId,
      cancelled: false,
      sink: null,
      group: context.mode === "group",
      senderId: context.senderId || "",
      recipientId: context.recipientId || "",
      roomId: context.roomId || "",
      generation: groupGeneration,
    };
    incomingFileTransfer = transferState;
    let automaticReceive = false;
    const capacity = await withConnectionDeadline(connection, (async () => {
      await refreshFileSinkSupport();
      if (context.mode === "private" && canAutoReceivePrivateFile(offer.size, context.session)) {
        const automaticCapacity = await getReceiveCapacity(offer.size, {
          kind: FILE_SINK_KIND.OPFS_EXPORT,
          hardMaxBytes: APP_CONFIG.limits.fileBytes,
        });
        automaticReceive = automaticCapacity.ok;
      }
      return getReceiveCapacity(offer.size, {
        kind: fileSinkSupport.preferredKind,
        hardMaxBytes: APP_CONFIG.limits.fileBytes,
      });
    })(), STREAM_READ_TIMEOUT_MS, "file capacity check timed out");
    if (incomingFileTransfer !== transferState
      || transferState.cancelled
      || (context.mode === "private" && activeSession !== context.session)
      || (context.mode === "group"
        && !groupInboundTransferIsCurrent(groupController, groupEpoch, context, groupGeneration))) {
      throw new Error("file offer is no longer current");
    }
    if (automaticReceive && !consumePrivateAutoReceiveBudget(offer.size, context.session)) {
      automaticReceive = false;
    }
    const sinkKind = fileSinkSupport.preferredKind;
    if (!capacity.ok) {
      await withConnectionDeadline(connection, connection.write(packFileJSON(
        FILE_FRAME.META,
        fileWireMeta(context, "REJECT", { reason: capacity.reason || FILE_SINK_REASON.NO_SINK }),
      )), STREAM_READ_TIMEOUT_MS, "file capacity response timed out");
      if (context.mode === "group"
        && (incomingFileTransfer !== transferState
          || transferState.cancelled
          || !groupInboundTransferIsCurrent(groupController, groupEpoch, context, groupGeneration))) {
        return;
      }
      const key = capacity.reason === FILE_SINK_REASON.INSUFFICIENT_SPACE
        || capacity.reason === FILE_SINK_REASON.NO_STORAGE_ESTIMATE
        ? "file_space_insufficient"
        : "file_receive_unavailable";
      setStatus(t(key), "error");
      return;
    }

    tcTest.state.file = "offered";
    const groupSender = context.mode === "group"
      ? groupController.snapshot().members.find((member) => member.id === context.senderId)
      : null;
    ui = createIncomingTransferItem(offer, { sender: groupSender, automaticReceive });
    if (context.mode === "group") markGroupTransferItem(ui, context.roomId);
    const decision = await waitForIncomingFileDecision(
      ui,
      offer,
      connection,
      sinkKind,
      context,
      reader,
      { automaticReceive },
    );
    if (decision.error) throw decision.error;
    if (!decision.accepted) return;
    sink = decision.sink;
    incomingFileTransfer.sink = sink;
    accepted = true;
    hasher = tailcatNewSHA256();
    tcTest.state.file = "receiving";
    tcTest.recvDone = false;
    tcTest.recvBytes = 0;
    tcTest.recvSha256 = null;
    if (incomingFileTransfer !== transferState
      || transferState.cancelled
      || (context.mode === "private" && activeSession !== context.session)
      || (context.mode === "group"
        && !groupInboundTransferIsCurrent(groupController, groupEpoch, context, groupGeneration))) {
      throw new Error("file offer session changed before acceptance");
    }
    ui.save.classList.add("hidden");
    ui.reject.classList.add("hidden");
    ui.cancel.classList.remove("hidden");

    const receiveBody = async (connection, attemptId, native = false) => {
    context.transferId = attemptId;
    const reader = new ConnectionReader(connection);
    hasher?.close();
    hasher = tailcatNewSHA256();
    let received = 0;
    let prefetchedHeader = native ? null : decision.prefetchedHeader;
    // Group transfers have a whole-body deadline so a selected recipient
    // cannot hold a group transfer slot forever. Private TCF1 retains its v1
    // per-read stall semantics and therefore has no aggregate throughput floor.
    reader.timeoutMs = STREAM_READ_TIMEOUT_MS;
    const dataDeadlineAt = context.mode === "group"
      ? Date.now() + fileDataDeadlineMs(offer.size)
      : 0;
    for (;;) {
      const frameOperation = prefetchedHeader
        ? prefetchedHeader.then((header) => readFileFramePayload(reader, header))
        : readFileFrame(reader);
      const frame = context.mode === "group"
        ? await withConnectionUntil(
          connection,
          frameOperation,
          dataDeadlineAt,
          "file data deadline exceeded",
        )
        : await withConnectionDeadline(
          connection,
          frameOperation,
          STREAM_READ_TIMEOUT_MS,
          "file data read timed out",
        );
      prefetchedHeader = null;
      if (frame.kind === FILE_FRAME.CANCEL) {
        const cancel = decodeFileJSON(frame, [FILE_FRAME.CANCEL]);
        if (!fileWireMatches(cancel, context)) throw new Error("cancel session rejected");
        throw new Error(t("file_cancelled"));
      }
      if (frame.kind === FILE_FRAME.DATA) {
        const remaining = offer.size - received;
        const expected = Math.min(APP_CONFIG.limits.fileChunkBytes, remaining);
        if (remaining <= 0 || frame.payload.length !== expected) {
          throw new Error("file chunk length violates TCF1");
        }
        if (incomingFileTransfer?.cancelled) throw new Error(t("file_cancelled"));
        await sink.write(frame.payload);
        await hasher.update(frame.payload);
        connection.acknowledgeRead?.();
        received += frame.payload.length;
        tcTest.recvBytes = received;
        ui.progress.value = offer.size ? received / offer.size : 1;
        ui.detail.textContent = format("file_receiving", {
          name: offer.name,
          received: humanSize(received),
          total: humanSize(offer.size),
        });
        noteFileTraffic(context);
        continue;
      }
      if (frame.kind !== FILE_FRAME.FINAL) throw new Error("unexpected frame during file body");
      const final = decodeFileJSON(frame, [FILE_FRAME.FINAL]);
      if (final.type !== "FINAL"
        || !fileWireMatches(final, context)
        || final.size !== received
        || received !== offer.size
        || !/^[0-9a-f]{64}$/u.test(final.sha256)) throw new Error("invalid final file frame");
      const digest = await hasher.digestHex();
      if (digest !== final.sha256) throw new Error(t("file_hash_failed"));
      noteFileTraffic(context);
      await sink.close();
      let stagedExport = null;
      if (sink.kind === FILE_SINK_KIND.OPFS_EXPORT) stagedExport = await sink.prepareExport();
      localArtifactReady = true;
      if (native) {
        nativeFileReceipts.commit({ room: context.roomId || context.session,
          peer: context.senderId || activePeerAddress,
          logicalTransferId: offer.nativeFile.logicalId, size: received }, digest);
      }
      const doneFrame = packFileJSON(FILE_FRAME.FINAL, fileWireMeta(context, "DONE", {
        size: received,
        sha256: digest,
      }));
      terminalWriteStarted = true;
      let confirmationError = null;
      try {
        await withConnectionDeadline(
          connection,
          connection.write(doneFrame),
          STREAM_READ_TIMEOUT_MS,
          "file completion confirmation timed out",
        );
        completed = true;
      } catch (error) {
        // A transport may report an error after the complete DONE frame was
        // handed to its peer. Preserve the already verified local artifact,
        // but do not claim that the sender received the confirmation.
        confirmationError = error;
        if (context.mode === "group") recordGroupError(error);
        else recordError(error);
      }
      if (completed && !native) {
        // The sender treats the DONE frame itself as terminal and does not wait
        // for EOF, so a half-close failure must never roll back a saved file.
        try {
          await withConnectionDeadline(
            connection,
            connection.closeWrite(),
            STREAM_READ_TIMEOUT_MS,
            "file completion close timed out",
          );
        } catch (error) {
          if (context.mode === "group") recordGroupError(error);
          else recordError(error);
        }
      }
      if (context.mode !== "group") tcTest.recvSha256 = digest;
      tcTest.recvDone = completed;
      ui.progress.value = 1;
      ui.cancel.classList.add("hidden");
      if (stagedExport) {
        configureStagedFileUI(ui, sink, stagedExport, { group: context.mode === "group" });
        const stagedStatus = confirmationError ? t("file_staged_confirmation_unknown") : t("file_staged");
        ui.detail.textContent = stagedStatus;
        ui.localNote.textContent = stagedStatus;
        ui.localNote.classList.remove("hidden");
      } else {
        ui.detail.textContent = confirmationError ? t("file_saved_confirmation_unknown") : t("file_verified");
      }
      const status = confirmationError
        ? t(stagedExport ? "file_staged_confirmation_unknown" : "file_saved_confirmation_unknown")
        : t(stagedExport ? "file_staged" : "file_verified");
      const sender = context.mode === "group" ? groupMemberById(context.senderId) : null;
      const roomStillVisible = context.mode !== "group"
        || (groupRoom?.active && groupRoom.roomId === context.roomId);
      if (roomStillVisible) {
        addMessage({
          type: "file",
          mine: false,
          name: offer.name,
          size: offer.size,
          status,
          senderName: sender?.displayName,
          senderCode: sender?.code,
          senderRole: sender?.role,
        });
        setStatus(status, confirmationError ? "error" : "connected");
      }
      return { state: "committed", size: received, sha256: digest };
    }
    };

    const native = offer.nativeFile?.v === 1 && /^[0-9a-f]{32}$/u.test(offer.nativeFile.logicalId)
      && nativeFileSupported(context, context.senderId);
    let reception = null;
    if (native) {
      const peer = nativeFilePeer(context, true);
      // Prepare the return Tailcat signaling path before ACCEPT starts the
      // sender's 10-second WebRTC clock. ICE itself is never given extra time.
      if (context.mode === "private") {
        try { await nativeFileSignalPipe(peer); }
        catch (_) { peer.manager.fail(); }
      }
      const current = () => peer.authorized() && incomingFileTransfer === transferState && !transferState.cancelled;
      const mux = makeFileCoordination(connection, peer, current, async () => {
        const frame = await readFileFramePayload(reader, await decision.prefetchedHeader);
        if (frame.kind !== FILE_FRAME.META) throw new Error("COORDINATION_FRAME");
        return frame.payload;
      });
      reception = receiveCoordinatedFile({ mux, manager: peer.manager, attemptId: context.transferId,
        authorized: current,
        receiveBody: (stream, attemptId) => receiveBody(stream, attemptId, true),
        queryReceipt: () => nativeFileReceipts.query({ room: context.roomId || context.session,
          peer: context.senderId || activePeerAddress, logicalTransferId: offer.nativeFile.logicalId, size: offer.size }),
        onPath: (path) => nativeFilePath(ui, path),
        reset: async (attemptId, grant) => {
          if (localArtifactReady || !current()) throw new Error("RESTART_REJECTED");
          if (context.mode === "group") {
            if (grant?.transferId !== attemptId || grant.roomId !== context.roomId
              || grant.senderId !== context.senderId || grant.recipientId !== context.recipientId
              || grant.size !== offer.size) throw new Error("RETRY_TICKET_REJECTED");
            await groupController.consumeTransferTicket(grant, "file", offer.size);
          }
          if (!current()) throw new Error("RESTART_REJECTED");
          sink = await resetFileSink(sink, attemptId);
          transferState.sink = sink;
          ui.progress.value = 0;
          tcTest.recvBytes = 0;
        },
      });
      // Observe early setup/cancellation failures while ACCEPT is still writing.
      reception.catch(() => {});
    }
    await withConnectionDeadline(connection, connection.write(packFileJSON(FILE_FRAME.META,
      fileWireMeta(context, "ACCEPT", native ? { nativeFile: 1, forceDerp: forceDerpFiles() } : {}))),
    STREAM_READ_TIMEOUT_MS, "file acceptance write timed out");
    if (reception) { await reception; nativeFilePath(ui, "verified"); }
    else await receiveBody(connection, context.transferId);
  } catch (error) {
    const preserveVerifiedSink = localArtifactReady && terminalWriteStarted;
    if (sink && !completed && !preserveVerifiedSink) {
      try {
        if (sink.state === "closed") await sink.remove();
        else await sink.abort();
      } catch (_) {}
      sink = null;
    }
    if (accepted && offer && context && !terminalWriteStarted) {
      try {
        await withConnectionDeadline(connection, connection.write(packFileJSON(
          FILE_FRAME.CANCEL,
          fileWireMeta(context, "ERROR", { reason: "TRANSFER_ABORTED" }),
        )), STREAM_READ_TIMEOUT_MS, "file cancellation response timed out");
      } catch (_) {}
    }
    if (ui) {
      if (ui.item.classList.contains("native-file-transfer") && !preserveVerifiedSink) nativeFilePath(ui, "failed");
      ui.detail.textContent = error.message === t("file_hash_failed") ? t("file_hash_failed") : format("file_failed", { message: redact(error.message) });
      ui.cancel.classList.add("hidden");
    }
    if (accepted) {
      if (context?.mode === "group" || offer?.mode === "group") recordGroupError(error);
      else recordError(error);
    }
  } finally {
    const preserveVerifiedSink = localArtifactReady && terminalWriteStarted;
    if (!completed && sink && !preserveVerifiedSink) {
      try {
        if (sink.state === "closed") await sink.remove();
        else await sink.abort();
      } catch (_) {}
    }
    hasher?.close();
    connection.close();
    if (incomingFileTransfer?.connection === connection) incomingFileTransfer = null;
    finishTransferItem(ui);
    tcTest.state.file = "idle";
    await wakeLocks.release("file-transfer");
    processFileQueue();
  }
}

function createIncomingTransferItem(offer, { sender = null, automaticReceive = false } = {}) {
  const fragment = $("incoming-file-template").content.cloneNode(true);
  i18n.apply(fragment);
  const item = fragment.querySelector("li");
  const name = fragment.querySelector(".transfer-name");
  const detail = fragment.querySelector(".transfer-detail");
  const progress = fragment.querySelector("progress");
  const save = fragment.querySelector(".save-file");
  const reject = fragment.querySelector(".reject-file");
  const cancel = fragment.querySelector(".cancel-file");
  const openFile = fragment.querySelector(".open-file");
  const exportFile = fragment.querySelector(".export-file");
  const deleteFile = fragment.querySelector(".delete-file");
  const localNote = fragment.querySelector(".transfer-local-note");
  item.dataset.receiveMode = automaticReceive ? "automatic" : "manual";
  name.textContent = sender
    ? format("group_file_offer", { identity: groupMemberIdentity(sender), name: offer.name })
    : `${t("file_offer")}: ${offer.name}`;
  detail.textContent = format(automaticReceive ? "file_offer_detail_auto" : "file_offer_detail", {
    name: offer.name,
    size: humanSize(offer.size),
  });
  save.textContent = fileSinkSupport.preferredKind === FILE_SINK_KIND.OPFS_EXPORT ? t("accept_receive") : t("choose_save");
  reject.textContent = t("reject");
  cancel.textContent = t("cancel");
  openFile.textContent = t("file_open");
  exportFile.textContent = t("file_export");
  deleteFile.textContent = t("file_delete_local");
  $("transfer-list").append(fragment);
  renderTransferCount();
  return {
    item,
    name,
    detail,
    progress,
    save,
    reject,
    cancel,
    open: openFile,
    export: exportFile,
    delete: deleteFile,
    localNote,
  };
}

function waitForIncomingFileDecision(
  ui,
  offer,
  connection,
  sinkKind,
  context,
  reader,
  { automaticReceive = false } = {},
) {
  return new Promise((resolve) => {
    let claimed = false;
    let resolved = false;
    let timeout = null;
    const releaseDecision = () => {
      clearTimeout(timeout);
      if (incomingFileTransfer?.connection === connection) incomingFileTransfer.cancelDecision = null;
    };
    const claim = () => {
      if (claimed) return false;
      claimed = true;
      releaseDecision();
      ui.save.disabled = true;
      ui.reject.disabled = true;
      return true;
    };
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      releaseDecision();
      resolve(value);
    };
    const createSink = (kind) => createFileSink({
      kind,
      transferId: offer.transferId,
      name: offer.name,
      size: offer.size,
      mime: offer.mime,
      hardMaxBytes: APP_CONFIG.limits.fileBytes,
    });
    const rejectOffer = async (reason, label = t("file_rejected")) => {
      if (!claim()) return;
      ui.detail.textContent = label;
      try {
        await withConnectionDeadline(
          connection,
          connection.write(packFileJSON(FILE_FRAME.META, fileWireMeta(context, "REJECT", { reason }))),
          STREAM_READ_TIMEOUT_MS,
          "file rejection write timed out",
        );
      } catch (_) {
        // Closing the stream below is also an unambiguous rejection.
      } finally {
        finish({ accepted: false });
      }
    };
    // Start one read while the consent UI is open. A sender that cancels by
    // closing its stream releases the prompt immediately. If the user accepts
    // first, this same promise becomes the first DATA/CANCEL frame so no bytes
    // are lost to a competing reader.
    const prefetchedHeader = readFileFrameHeader(reader);
    void prefetchedHeader.then(async (header) => {
      if (resolved) return;
      try {
        if (header.kind !== FILE_FRAME.CANCEL || header.length > TRANSFER_CANCEL_MAX_BYTES) {
          throw new Error("file data arrived before acceptance");
        }
        // Claim before reading even the bounded cancellation metadata so a
        // simultaneous save-picker completion cannot accept a cancelled offer.
        if (!claim()) return;
        const frame = await withConnectionDeadline(
          connection,
          readFileFramePayload(reader, header),
          STREAM_READ_TIMEOUT_MS,
          "file cancellation frame timed out",
        );
        const cancel = decodeFileJSON(frame, [FILE_FRAME.CANCEL]);
        if (!fileWireMatches(cancel, context) || cancel.type !== "CANCEL") {
          throw new Error("invalid file cancellation before acceptance");
        }
        ui.detail.textContent = t("file_cancelled");
        finish({ accepted: false });
      } catch (error) {
        claim();
        finish({ accepted: false, error });
      }
    }, (error) => {
      if (resolved) return;
      claim();
      const remoteClosed = /(?:end of stream|closed)/iu.test(String(error?.message || error));
      ui.detail.textContent = remoteClosed ? t("file_cancelled") : format("file_failed", { message: redact(error.message) });
      finish(remoteClosed ? { accepted: false } : { accepted: false, error });
    });
    timeout = setTimeout(() => { void rejectOffer("OFFER_TIMEOUT", t("file_cancelled")); }, FILE_DECISION_TIMEOUT_MS);
    if (incomingFileTransfer?.connection === connection) {
      incomingFileTransfer.cancelDecision = () => rejectOffer("ROOM_CLOSED", t("file_cancelled"));
    }
    ui.save.onclick = async () => {
      if (claimed) return;
      ui.save.disabled = true;
      ui.reject.disabled = true;
      // This call is deliberately inside the click handler so Chrome treats it
      // as a user-initiated save decision.
      try {
        const sink = await createSink(sinkKind);
        if (!claim()) {
          try { await sink.abort(); } catch (_) {}
          return;
        }
        finish({ accepted: true, sink, prefetchedHeader });
      } catch (error) {
        if (!claimed) await rejectOffer("USER_CANCELLED");
      }
    };
    ui.reject.onclick = () => rejectOffer("USER_REJECTED");
    ui.cancel.onclick = () => {
      if (incomingFileTransfer?.connection === connection) {
        incomingFileTransfer.cancelled = true;
        connection.close();
      }
    };
    if (automaticReceive) {
      ui.save.classList.add("hidden");
      ui.reject.classList.add("hidden");
      ui.cancel.classList.remove("hidden");
      ui.detail.textContent = t("file_auto_preparing");
      void createSink(FILE_SINK_KIND.OPFS_EXPORT).then(async (sink) => {
        if (!claim()) {
          try { await sink.abort(); } catch (_) {}
          return;
        }
        finish({ accepted: true, sink, prefetchedHeader, automatic: true });
      }).catch(() => {
        if (claimed || resolved) return;
        ui.item.dataset.receiveMode = "manual-fallback";
        ui.detail.textContent = t("file_auto_fallback");
        ui.save.disabled = false;
        ui.reject.disabled = false;
        ui.save.classList.remove("hidden");
        ui.reject.classList.remove("hidden");
        ui.cancel.classList.add("hidden");
      });
    }
  });
}

function configureStagedFileUI(ui, sink, prepared, { group = false } = {}) {
  const reportError = group ? recordGroupError : recordError;
  let removed = false;
  let removalPromise = null;
  let useDownloadFallback = !prepared.canShare;
  const removeTemporaryFile = async () => {
    if (removed) return true;
    if (removalPromise) return removalPromise;
    removalPromise = (async () => {
      await sink.remove();
      removed = true;
      prepared.dispose();
      ui.open.onclick = null;
      ui.export.onclick = null;
      ui.delete.onclick = null;
      ui.open.classList.add("hidden");
      ui.export.classList.add("hidden");
      ui.delete.classList.add("hidden");
      transferItemCleanups.delete(ui.item);
      stagedTransferItems.delete(ui.item);
      const transferRoomId = groupTransferRooms.get(ui.item);
      if (transferRoomId
        && (!groupRoom?.active || groupRoom.roomId !== transferRoomId)) {
        discardGroupTransferItem(ui.item);
      }
      pruneFinishedTransferItems();
      renderTransferCount();
      if (!activeSession) setMobileState(restingMobileState());
      return true;
    })();
    try {
      return await removalPromise;
    } finally {
      removalPromise = null;
    }
  };
  stagedTransferItems.add(ui.item);
  if (ui.item.dataset.discarded === "true") {
    delete ui.item.dataset.discarded;
    groupTransferItems.add(ui.item);
    $("transfer-list").append(ui.item);
  }
  transferItemCleanups.set(ui.item, removeTemporaryFile);
  ui.open.classList.toggle("hidden", !prepared.canOpen);
  ui.export.classList.remove("hidden");
  ui.delete.classList.remove("hidden");
  ui.open.onclick = () => {
    ui.open.disabled = true;
    try {
      prepared.open();
    } catch (error) {
      setStatus(t("file_open_failed"), "error");
      reportError(error);
    } finally {
      ui.open.disabled = false;
    }
  };
  ui.export.onclick = () => {
    ui.export.disabled = true;
    if (useDownloadFallback) {
      try {
        prepared.download();
        ui.detail.textContent = t("file_download_started");
        ui.localNote.textContent = t("file_delete_after_download");
      } catch (error) {
        setStatus(t("share_failed"), "error");
        reportError(error);
      } finally {
        ui.export.disabled = false;
      }
      return;
    }
    void prepared.share().then(async () => {
      ui.detail.textContent = t("file_exported");
      ui.open.classList.add("hidden");
      ui.export.classList.add("hidden");
      try {
        await removeTemporaryFile();
        ui.localNote.classList.add("hidden");
        ui.delete.classList.add("hidden");
      } catch (error) {
        ui.delete.disabled = false;
        ui.localNote.textContent = t("file_cleanup_failed");
        setStatus(t("file_cleanup_failed"), "error");
        reportError(error);
      }
    }).catch(async (error) => {
      ui.export.disabled = false;
      if (error?.name === "AbortError") {
        try {
          await removeTemporaryFile();
          ui.detail.textContent = t("file_local_deleted");
          ui.localNote.classList.add("hidden");
          ui.open.classList.add("hidden");
          ui.export.classList.add("hidden");
          ui.delete.classList.add("hidden");
        } catch (cleanupError) {
          ui.delete.disabled = false;
          ui.localNote.classList.remove("hidden");
          ui.localNote.textContent = t("file_cleanup_failed");
          setStatus(t("file_cleanup_failed"), "error");
          reportError(cleanupError);
        }
        return;
      }
      useDownloadFallback = true;
      ui.detail.textContent = t("file_share_download_fallback");
      ui.localNote.textContent = t("file_delete_after_download");
      setStatus(t("file_share_download_fallback"), "error");
      reportError(error);
    });
  };
  ui.delete.onclick = () => {
    ui.delete.disabled = true;
    void removeTemporaryFile().then(() => {
      ui.detail.textContent = t("file_local_deleted");
      ui.localNote.classList.add("hidden");
      ui.open.classList.add("hidden");
      ui.export.classList.add("hidden");
      ui.delete.classList.add("hidden");
    }).catch((error) => {
      ui.delete.disabled = false;
      setStatus(t("file_cleanup_failed"), "error");
      reportError(error);
    });
  };
}

function cancelAllTransfers() {
  if (incomingFileTransfer) {
    incomingFileTransfer.cancelled = true;
    incomingFileTransfer.cancelDecision?.();
    incomingFileTransfer.connection.close();
  }
  cancelGroupTransferConnections();
  for (const entry of outgoingFileQueue) {
    entry.cancelled = true;
    entry.ui.detail.textContent = t("file_cancelled");
    entry.ui.cancel.disabled = true;
    entry.file = null;
    finishTransferItem(entry.ui);
  }
  outgoingFileQueue.length = 0;
  if (activeFileTransfer) {
    activeFileTransfer.cancelled = true;
    activeFileTransfer.entry && (activeFileTransfer.entry.cancelled = true);
    activeFileTransfer.cancelDecision?.();
    activeFileTransfer.connection?.close();
    activeFileTransfer.entry?.connection?.close();
  }
}

// ---- Voice notes --------------------------------------------------------

let recorder = null;
let voiceChunks = [];
let voiceBytes = 0;
let voiceStartedAt = 0;
let voiceLimitTimer = null;
let discardVoice = false;
let voiceCancelled = false;
let voicePointerHeld = false;
let voiceGesture = 0;
let activeVoiceStream = null;
let activeGroupVoicePlan = null;
const voiceHoldMode = !support.mobile;

async function startVoiceNote(event) {
  event.preventDefault();
  // Keep one recorder object alive until its onstop callback has completed.
  // MediaRecorder enters "inactive" before that callback is dispatched.
  const groupVoice = groupRoom?.active;
  const groupRoomId = groupVoice ? groupRoom.roomId : "";
  const groupRecipients = groupVoice ? selectedGroupMembers() : [];
  const mimeType = groupVoice
    ? selectedGroupVoiceRecordType(groupRecipients)
    : selectedVoiceRecordType();
  if (recorder || (!activeSession && !groupRoom?.canSend)) return;
  if ((!groupVoice && peerCapabilities?.voice?.enabled !== true)
    || !mimeType) {
    setStatus(t("unsupported_capability"), "error");
    return;
  }
  if (voiceHoldMode && event.pointerId !== undefined) event.currentTarget?.setPointerCapture?.(event.pointerId);
  voicePointerHeld = true;
  const gesture = ++voiceGesture;
  let stream = null;
  await wakeLocks.acquire("voice-note");
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    activeVoiceStream = stream;
    // A permission prompt can outlive the press. If the user released while it
    // was visible, stop the newly granted stream without recording anything.
    if ((voiceHoldMode && !voicePointerHeld) || gesture !== voiceGesture) {
      stream.getTracks().forEach((track) => track.stop());
      if (activeVoiceStream === stream) activeVoiceStream = null;
      await wakeLocks.release("voice-note");
      return;
    }
    if (groupVoice && (!groupRoom?.active || groupRoom.roomId !== groupRoomId)) {
      throw new Error(t("group_status_closed"));
    }
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    activeGroupVoicePlan = groupVoice ? Object.freeze({
      roomId: groupRoomId,
      recipients: Object.freeze(groupRecipients.slice()),
      mimeType,
    }) : null;
    voiceChunks = [];
    voiceBytes = 0;
    discardVoice = false;
    voiceCancelled = false;
    voiceStartedAt = performance.now();
    recorder.ondataavailable = (chunkEvent) => {
      if (!chunkEvent.data.size) return;
      voiceBytes += chunkEvent.data.size;
      if (voiceBytes > APP_CONFIG.limits.voiceBytes) {
        discardVoice = true;
        if (recorder.state === "recording") recorder.stop();
        return;
      }
      voiceChunks.push(chunkEvent.data);
    };
    recorder.onstop = () => {
      void finishVoiceNote(stream).finally(() => wakeLocks.release("voice-note"));
    };
    recorder.start(1000);
    voiceLimitTimer = setTimeout(() => {
      if (recorder?.state === "recording") recorder.stop();
    }, APP_CONFIG.limits.voiceSeconds * 1000 - 250);
    $("ptt-btn").classList.add("recording");
    $("mobile-recording-controls")?.classList.remove("hidden");
    setStatus(t(voiceHoldMode ? "voice_recording" : "voice_tap_stop"), "loading");
    markActivity();
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    if (activeVoiceStream === stream) activeVoiceStream = null;
    recorder = null;
    activeGroupVoicePlan = null;
    voicePointerHeld = false;
    await wakeLocks.release("voice-note");
    setStatus(format("microphone_failed", { message: redact(error.message) }), "error");
    if (groupVoice) recordGroupError(error);
    else recordError(error);
  }
}

function stopVoiceNote(event, force = false) {
  event?.preventDefault();
  if (!voiceHoldMode && !force) return;
  voicePointerHeld = false;
  voiceGesture += 1;
  if (recorder?.state === "recording") recorder.stop();
}

function cancelActiveVoiceRecording() {
  voicePointerHeld = false;
  voiceGesture += 1;
  voiceCancelled = true;
  clearTimeout(voiceLimitTimer);
  activeGroupVoicePlan = null;
  if (recorder?.state === "recording") recorder.stop();
  activeVoiceStream?.getTracks().forEach((track) => track.stop());
  activeVoiceStream = null;
  void wakeLocks.release("voice-note");
}

function cancelVoiceNote(event) {
  event?.preventDefault?.();
  cancelActiveVoiceRecording();
}

async function finishVoiceNote(stream) {
  clearTimeout(voiceLimitTimer);
  stream.getTracks().forEach((track) => track.stop());
  if (activeVoiceStream === stream) activeVoiceStream = null;
  $("ptt-btn").classList.remove("recording");
  $("mobile-recording-controls")?.classList.add("hidden");
  const finishedRecorder = recorder;
  const groupPlan = activeGroupVoicePlan;
  recorder = null;
  activeGroupVoicePlan = null;
  const duration = Math.max(1, Math.min(
    APP_CONFIG.limits.voiceSeconds,
    Math.ceil((performance.now() - voiceStartedAt) / 1000),
  ));
  if (voiceCancelled) {
    voiceChunks = [];
    if (activeSession || groupRoom?.active) {
      setStatus(t("voice_discarded"), activeSession || groupRoom?.canSend ? "connected" : "ready");
    }
    return;
  }
  if (discardVoice || voiceBytes > APP_CONFIG.limits.voiceBytes) {
    voiceChunks = [];
    setStatus(t("voice_limit"), "error");
    return;
  }
  const mime = safeVoiceMime(finishedRecorder?.mimeType);
  if (!mime) {
    voiceChunks = [];
    setStatus(t("unsupported_capability"), "error");
    return;
  }
  const blob = new Blob(voiceChunks, { type: mime });
  voiceChunks = [];
  if (groupPlan) {
    if (!groupRoom?.active || groupRoom.roomId !== groupPlan.roomId) {
      setStatus(t("voice_discarded"), "ready");
      return;
    }
    await sendGroupVoiceNote(blob, duration, groupPlan.recipients);
    return;
  }
  try {
    setStatus(t("voice_sending"), "loading");
    const payload = new Uint8Array(await blob.arrayBuffer());
    if (payload.length > APP_CONFIG.limits.voiceBytes) throw new Error(t("voice_limit"));
    const messageId = randomID();
    const response = await sendChatEnvelopeTo(activePeerAddress, sessionMeta("VOICE", {
      messageId, mime: safeVoiceMime(blob.type), duration,
    }), payload, APP_CONFIG.ports.voice);
    const ack = unpackChatEnvelope(response);
    if (ack.payload.length
      || ack.meta.type !== "VOICE_ACK"
      || !hasSession(ack.meta)
      || ack.meta.messageId !== messageId) throw new Error("voice acknowledgement rejected");
    addMessage({ type: "voice", blob, duration, mine: true });
    setStatus(t("voice_delivered"), "connected");
    noteAuthenticatedPeerTraffic();
  } catch (error) {
    setStatus(format("voice_failed", { message: redact(error.message) }), "error");
    recordError(error);
  }
}

async function sendGroupVoiceNote(blob, duration, recipients) {
  const recipientIds = [...new Set((recipients || []).map((member) => member?.id).filter(Boolean))];
  if (!recipientIds.length) {
    setStatus(t("group_no_recipients"), "error");
    return;
  }
  if (groupOutgoingTransfers.size >= MAX_PENDING_FILES) {
    setStatus(t("file_queue_limit"), "error");
    return;
  }
  const roomId = groupRoom?.roomId || "";
  const transferId = randomID();
  const ui = createGroupOutgoingTransferItem({ name: t("record_voice"), size: blob.size }, recipients);
  const entry = {
    kind: "voice",
    blob,
    transferId,
    recipients,
    ui,
    cancelled: false,
    connections: new Set(),
    invalidRecipients: new Set(),
    generation: groupTransferGeneration,
    roomId,
    completed: 0,
  };
  groupOutgoingTransfers.add(entry);
  ui.cancel.onclick = () => {
    entry.cancelled = true;
    for (const active of entry.connections) {
      active.cancelled = true;
      safeConnectionClose(active.connection);
    }
    ui.cancel.disabled = true;
  };
  try {
    setStatus(t("voice_sending"), "loading");
    const batchItems = [{ transferId, size: blob.size }];
    const tasks = recipients.map((recipient) => scheduleGroupRecipientTransfer(
      entry.roomId,
      recipient.id,
      async () => {
        try {
          assertGroupTransferMayStart(entry, recipient.id);
          const currentRecipient = groupMemberById(recipient.id);
          if (!groupMemberCanReceive(currentRecipient, "voice", blob.size)
            || !groupMemberSupportsVoiceMime(currentRecipient, blob.type)) {
            throw new Error(t("unsupported_capability"));
          }
          const response = await groupRoom.requestTransferTickets({
            kind: "voice",
            items: batchItems,
            recipientIds,
            targetTransferId: transferId,
            targetRecipientId: recipient.id,
          });
          const grant = response.grants[0];
          if (!grant) throw new Error(response.failures[0]?.reason || "transfer ticket rejected");
          assertGroupTransferMayStart(entry, recipient.id);
          await sendGroupVoiceToRecipient(entry, grant, duration);
          setGroupTransferRecipientStatus(entry, recipient.id, "group_transfer_complete", "complete");
        } catch (error) {
          const rejected = error?.groupTransferStatus === "rejected";
          setGroupTransferRecipientStatus(
            entry,
            recipient.id,
            rejected ? "group_transfer_rejected" : "group_transfer_failed",
            rejected ? "rejected" : "failed",
          );
          if (!entry.cancelled) recordGroupError(error);
        } finally {
          entry.completed += 1;
          ui.progress.value = recipients.length ? entry.completed / recipients.length : 1;
        }
      },
    ));
    await Promise.allSettled(tasks);
    for (const recipient of recipients) {
      const recipientStatus = ui.statuses.get(recipient.id);
      if (recipientStatus?.item.dataset.status) continue;
      setGroupTransferRecipientStatus(entry, recipient.id, "group_transfer_failed", "failed");
      entry.completed += 1;
    }
    const summary = summarizeGroupTransfer(entry, "voice_delivered");
    ui.progress.value = 1;
    ui.detail.textContent = summary.message;
    ui.cancel.disabled = true;
    finishTransferItem(ui);
    if (!entry.cancelled && summary.complete > 0 && groupTransferRoomIsCurrent(entry.roomId)) {
      const self = groupMemberById(groupRoom.memberId);
      addMessage({
        type: "voice",
        blob,
        duration,
        mine: true,
        senderName: self?.displayName,
        senderCode: self?.code,
        senderRole: self?.role,
      });
    }
    if (groupTransferRoomIsCurrent(entry.roomId)) {
      setStatus(summary.message, summary.ok ? "connected" : "error");
    }
  } catch (error) {
    for (const member of recipients) setGroupTransferRecipientStatus(entry, member.id, "group_transfer_failed", "failed");
    ui.detail.textContent = format("voice_failed", { message: redact(error.message) });
    ui.cancel.disabled = true;
    finishTransferItem(ui);
    if (groupTransferRoomIsCurrent(entry.roomId)) {
      setStatus(format("voice_failed", { message: redact(error.message) }), "error");
    }
    recordGroupError(error);
  } finally {
    groupOutgoingTransfers.delete(entry);
  }
}

async function sendGroupVoiceToRecipient(entry, grant, duration) {
  const controller = groupRoom;
  const controllerEpoch = controller?.lifecycleEpoch;
  let transportEntry = null;
  let connection = null;
  let active = null;
  const context = {
    roomId: grant.roomId,
    senderId: grant.senderId,
    recipientId: grant.recipientId,
    transferId: grant.transferId,
  };
  try {
    assertGroupTransferControllerCurrent(controller, controllerEpoch, entry, grant.recipientId);
    if (grant.roomId !== entry.roomId) throw new Error(t("group_status_closed"));
    transportEntry = controller.getTransport(grant.address);
    const transport = await transportEntry;
    try {
      assertGroupTransferControllerCurrent(controller, controllerEpoch, entry, grant.recipientId);
    } catch (error) {
      controller.dropTransport(grant.address, transportEntry);
      throw error;
    }
    try {
      connection = await transport.dial({ port: APP_CONFIG.ports.voice });
    } catch (error) {
      controller.dropTransport(grant.address, transportEntry);
      throw error;
    }
    assertGroupTransferControllerCurrent(controller, controllerEpoch, entry, grant.recipientId);
    active = {
      connection,
      senderId: grant.senderId,
      recipientId: grant.recipientId,
      cancelled: false,
    };
    entry.connections.add(active);
    groupTransferConnections.add(active);
    const reader = new ConnectionReader(connection, VOICE_DECISION_DEADLINE_MS);
    const mime = safeVoiceMime(entry.blob.type);
    if (!mime) throw new Error(t("unsupported_capability"));
    const offer = {
      type: "VOICE_OFFER",
      mode: "group",
      gv: GROUP_PROTOCOL_VERSION,
      roomId: grant.roomId,
      senderId: grant.senderId,
      recipientId: grant.recipientId,
      transferId: grant.transferId,
      ticket: grant.ticket,
      size: entry.blob.size,
      mime,
      duration,
    };
    setGroupTransferRecipientStatus(entry, grant.recipientId, "group_transfer_pending", "pending");
    await withConnectionDeadline(
      connection,
      connection.write(packGroupVoiceFrame(offer)),
      STREAM_READ_TIMEOUT_MS,
      "group voice offer write timed out",
    );
    const { meta: response, payload: responsePayload } = await withConnectionDeadline(
      connection,
      readGroupVoiceFrame(reader, 0),
      VOICE_DECISION_DEADLINE_MS,
      "group voice decision timed out",
    );
    if (responsePayload.length || !groupVoiceWireMatches(response, context)) {
      throw new Error("group voice response rejected");
    }
    if (response.type !== "VOICE_ACCEPT") {
      const error = new Error(t("group_transfer_rejected"));
      if (response.type === "VOICE_REJECT") error.groupTransferStatus = "rejected";
      throw error;
    }
    setGroupTransferRecipientStatus(entry, grant.recipientId, "group_transfer_accepted", "accepted");
    assertGroupTransferMayStart(entry, grant.recipientId);
    const payload = new Uint8Array(await entry.blob.arrayBuffer());
    if (payload.length !== entry.blob.size || entry.cancelled || active.cancelled) {
      throw new Error(t("voice_discarded"));
    }
    setGroupTransferRecipientStatus(entry, grant.recipientId, "group_transfer_sending", "transferring");
    await withConnectionDeadline(
      connection,
      writeChunked(connection, packGroupVoiceFrame({
        type: "VOICE_DATA",
        mode: "group",
        gv: GROUP_PROTOCOL_VERSION,
        ...context,
        size: payload.length,
        mime,
        duration,
      }, payload)),
      VOICE_DATA_DEADLINE_MS,
      "group voice data write timed out",
    );
    await withConnectionDeadline(
      connection,
      connection.closeWrite(),
      STREAM_READ_TIMEOUT_MS,
      "group voice close write timed out",
    );
    const { meta: ack, payload: ackPayload } = await withConnectionDeadline(
      connection,
      readGroupVoiceFrame(reader, 0),
      STREAM_READ_TIMEOUT_MS,
      "group voice acknowledgement timed out",
    );
    if (ackPayload.length
      || ack.type !== "VOICE_ACK"
      || !groupVoiceWireMatches(ack, context)) throw new Error("group voice acknowledgement rejected");
  } finally {
    if (active) {
      entry.connections.delete(active);
      groupTransferConnections.delete(active);
    }
    safeConnectionClose(connection);
  }
}

function groupVoiceWireMatches(meta, context) {
  return meta?.v === APP_CONFIG.protocolVersion
    && meta.mode === "group"
    && meta.gv === GROUP_PROTOCOL_VERSION
    && meta.roomId === context.roomId
    && meta.senderId === context.senderId
    && meta.recipientId === context.recipientId
    && meta.transferId === context.transferId;
}

function groupVoiceWireMeta(context, type, extra = {}) {
  return {
    type,
    mode: "group",
    gv: GROUP_PROTOCOL_VERSION,
    roomId: context.roomId,
    senderId: context.senderId,
    recipientId: context.recipientId,
    transferId: context.transferId,
    ...extra,
  };
}

function createIncomingGroupVoiceItem(offer, sender) {
  const fragment = $("incoming-file-template").content.cloneNode(true);
  i18n.apply(fragment);
  const item = fragment.querySelector("li");
  const name = fragment.querySelector(".transfer-name");
  const detail = fragment.querySelector(".transfer-detail");
  const progress = fragment.querySelector("progress");
  const save = fragment.querySelector(".save-file");
  const reject = fragment.querySelector(".reject-file");
  const cancel = fragment.querySelector(".cancel-file");
  const exportFile = fragment.querySelector(".export-file");
  const deleteFile = fragment.querySelector(".delete-file");
  const localNote = fragment.querySelector(".transfer-local-note");
  item.classList.add("incoming-voice-transfer");
  name.textContent = format("group_voice_offer", { identity: groupMemberIdentity(sender) });
  detail.textContent = format("group_voice_offer_detail", {
    duration: Number(offer.duration).toFixed(1),
    size: humanSize(offer.size),
  });
  save.textContent = t("accept");
  reject.textContent = t("reject");
  cancel.classList.add("hidden");
  exportFile.classList.add("hidden");
  deleteFile.classList.add("hidden");
  $("transfer-list").append(fragment);
  renderTransferCount();
  return markGroupTransferItem(
    { item, name, detail, progress, save, reject, cancel, export: exportFile, delete: deleteFile, localNote },
    offer.roomId,
  );
}

function waitForIncomingGroupVoiceDecision(ui, connection, context, active, reader) {
  return new Promise((resolve) => {
    let claimed = false;
    let resolved = false;
    let timeout = null;
    const release = () => {
      clearTimeout(timeout);
      active.cancelDecision = null;
    };
    const claim = () => {
      if (claimed) return false;
      claimed = true;
      ui.save.disabled = true;
      ui.reject.disabled = true;
      ui.save.classList.add("hidden");
      ui.reject.classList.add("hidden");
      return true;
    };
    const finish = (decision) => {
      if (resolved) return;
      resolved = true;
      release();
      resolve(decision);
    };
    const reject = async (reason, label = t("group_transfer_rejected")) => {
      if (!claim()) return;
      ui.detail.textContent = label;
      try {
        await withConnectionDeadline(
          connection,
          connection.write(packGroupVoiceFrame(groupVoiceWireMeta(
            context,
            "VOICE_REJECT",
            { reason },
          ))),
          STREAM_READ_TIMEOUT_MS,
          "group voice rejection write timed out",
        );
      } catch (_) {
        // Closing the stream below is also an unambiguous rejection.
      } finally {
        finish({ accepted: false });
      }
    };
    const prefetchedHead = readGroupVoiceFrameHead(reader, APP_CONFIG.limits.voiceBytes);
    void prefetchedHead.then(({ meta, payloadLength }) => {
      if (resolved) return;
      try {
        if (payloadLength || meta.type !== "VOICE_CANCEL" || !groupVoiceWireMatches(meta, context)) {
          throw new Error("group voice data arrived before acceptance");
        }
        claim();
        ui.detail.textContent = t("voice_discarded");
        finish({ accepted: false });
      } catch (error) {
        claim();
        finish({ accepted: false, error });
      }
    }, (error) => {
      if (resolved) return;
      claim();
      const remoteClosed = /(?:end of stream|closed)/iu.test(String(error?.message || error));
      ui.detail.textContent = remoteClosed ? t("voice_discarded") : format("voice_failed", { message: redact(error.message) });
      finish(remoteClosed ? { accepted: false } : { accepted: false, error });
    });
    timeout = setTimeout(
      () => { void reject("OFFER_TIMEOUT", t("file_cancelled")); },
      FILE_DECISION_TIMEOUT_MS,
    );
    active.cancelDecision = () => { void reject("ROOM_CLOSED", t("file_cancelled")); };
    ui.save.onclick = async () => {
      if (!claim()) return;
      try {
        await withConnectionDeadline(
          connection,
          connection.write(packGroupVoiceFrame(groupVoiceWireMeta(context, "VOICE_ACCEPT"))),
          STREAM_READ_TIMEOUT_MS,
          "group voice acceptance write timed out",
        );
        ui.detail.textContent = t("group_transfer_accepted");
        finish({ accepted: true, prefetchedHead });
      } catch (error) {
        finish({ accepted: false, error });
      }
    };
    ui.reject.onclick = () => { void reject("USER_REJECTED"); };
  });
}

async function receiveGroupVoice(connection, reader, offerDeadlineMs = STREAM_READ_TIMEOUT_MS) {
  let ui = null;
  let active = null;
  let groupController = null;
  let groupEpoch = 0;
  let groupGeneration = 0;
  try {
    const { meta: offer, payload: offerPayload } = await withConnectionDeadline(
      connection,
      readGroupVoiceFrame(reader, 0, { magicRead: true }),
      Math.max(1, offerDeadlineMs),
      "group voice offer timed out",
    );
    const mime = safeVoiceMime(offer.mime);
    if (offerPayload.length
      || offer.type !== "VOICE_OFFER"
      || offer.v !== APP_CONFIG.protocolVersion
      || offer.mode !== "group"
      || offer.gv !== GROUP_PROTOCOL_VERSION
      || !groupRoom?.active
      || !/^[0-9a-f]{32}$/u.test(offer.transferId)
      || !Number.isSafeInteger(offer.size)
      || offer.size < 0
      || offer.size > APP_CONFIG.limits.voiceBytes
      || !mime
      || !Number.isFinite(offer.duration)
      || offer.duration < 0
      || offer.duration > APP_CONFIG.limits.voiceSeconds) throw new Error("group voice offer rejected");
    groupController = groupRoom;
    groupEpoch = groupController.lifecycleEpoch;
    groupGeneration = groupTransferGeneration;
    const ticket = await groupController.consumeTransferTicket(offer, "voice", offer.size);
    const context = {
      roomId: ticket.roomId,
      senderId: ticket.senderId,
      recipientId: ticket.recipientId,
      transferId: ticket.transferId,
    };
    if (!groupVoiceWireMatches(offer, context)) throw new Error("group voice ticket context rejected");
    if (!groupInboundTransferIsCurrent(groupController, groupEpoch, context, groupGeneration)) {
      throw new Error("group voice room changed during ticket validation");
    }
    const localPlayableTypes = playableVoiceTypes().map(safeVoiceMime).filter(Boolean);
    if (!localPlayableTypes.includes(mime)) {
      await withConnectionDeadline(
        connection,
        connection.write(packGroupVoiceFrame(groupVoiceWireMeta(
          context,
          "VOICE_REJECT",
          { reason: "UNSUPPORTED" },
        ))),
        STREAM_READ_TIMEOUT_MS,
        "group voice rejection write timed out",
      );
      return;
    }
    active = {
      connection,
      senderId: ticket.senderId,
      recipientId: ticket.recipientId,
      cancelled: false,
      cancelDecision: null,
      roomId: context.roomId,
      generation: groupGeneration,
    };
    groupTransferConnections.add(active);
    const sender = groupMemberById(ticket.senderId);
    ui = createIncomingGroupVoiceItem(offer, sender);
    reader.timeoutMs = VOICE_DECISION_DEADLINE_MS;
    const decision = await waitForIncomingGroupVoiceDecision(ui, connection, context, active, reader);
    if (decision.error) throw decision.error;
    if (!decision.accepted) return;
    if (active.cancelled) throw new Error(t("voice_discarded"));
    const { meta: data, payload } = await withConnectionDeadline(
      connection,
      decision.prefetchedHead.then((head) => readGroupVoiceFramePayload(reader, head)),
      VOICE_DATA_DEADLINE_MS,
      "group voice payload timed out",
    );
    if (data.type !== "VOICE_DATA"
      || !groupVoiceWireMatches(data, context)
      || data.size !== offer.size
      || data.mime !== mime
      || data.duration !== offer.duration
      || payload.length !== offer.size
      || active.cancelled) throw new Error("group voice payload rejected");
    const currentSender = groupMemberById(context.senderId);
    if (!groupInboundTransferIsCurrent(groupController, groupEpoch, context, groupGeneration)
      || !currentSender
      || active.cancelled) throw new Error("group voice room changed before local commit");
    const blob = new Blob([payload], { type: mime });
    addMessage({
      type: "voice",
      blob,
      duration: offer.duration,
      mine: false,
      senderName: currentSender.displayName,
      senderCode: currentSender.code,
      senderRole: currentSender.role,
    });
    ui.progress.value = 1;
    ui.detail.textContent = t("message_received");
    setStatus(t("message_received"), "connected");
    try {
      await withConnectionDeadline(
        connection,
        connection.write(packGroupVoiceFrame(groupVoiceWireMeta(context, "VOICE_ACK"))),
        STREAM_READ_TIMEOUT_MS,
        "group voice acknowledgement write timed out",
      );
      await withConnectionDeadline(
        connection,
        connection.closeWrite(),
        STREAM_READ_TIMEOUT_MS,
        "group voice close write timed out",
      );
    } catch (error) {
      // The voice bytes are already committed locally. Preserve them just as
      // TCF1 preserves a verified file when its terminal confirmation fails.
      recordGroupError(error);
      if (groupRoom?.active && groupRoom.roomId === context.roomId) {
        ui.detail.textContent = t("voice_received_confirmation_unknown");
        setStatus(t("voice_received_confirmation_unknown"), "error");
      }
    }
  } catch (error) {
    if (ui) {
      ui.save.classList.add("hidden");
      ui.reject.classList.add("hidden");
      ui.detail.textContent = active?.cancelled
        ? t("voice_discarded")
        : format("voice_failed", { message: redact(error.message) });
    }
    throw error;
  } finally {
    if (active) {
      active.cancelDecision = null;
      groupTransferConnections.delete(active);
    }
    finishTransferItem(ui);
  }
}

async function receiveVoice(connection) {
  let groupProtocol = false;
  const startedAt = Date.now();
  try {
    const reader = new ConnectionReader(connection);
    const magic = await withConnectionDeadline(
      connection,
      reader.readExact(4),
      STREAM_READ_TIMEOUT_MS,
      "voice protocol preamble timed out",
    );
    if (equalBytes(magic, TCV_MAGIC)) {
      groupProtocol = true;
      await receiveGroupVoice(
        connection,
        reader,
        STREAM_READ_TIMEOUT_MS - (Date.now() - startedAt),
      );
      return;
    }
    if (!equalBytes(magic, TCH_MAGIC)) throw new Error("invalid voice protocol preamble");
    const { meta, payload } = await readChatEnvelopeStreamBody(
      connection,
      reader,
      APP_CONFIG.limits.voiceBytes,
      APP_CONFIG.limits.voiceSeconds * 1000 + STREAM_READ_TIMEOUT_MS,
    );
    const mime = safeVoiceMime(meta.mime);
    if (meta.type !== "VOICE"
      || meta.mode === "group"
      || !hasSession(meta)
      || typeof meta.messageId !== "string"
      || meta.messageId.length !== 32
      || payload.length > APP_CONFIG.limits.voiceBytes
      || !mime
      || !Number.isFinite(meta.duration)
      || meta.duration < 0
      || meta.duration > APP_CONFIG.limits.voiceSeconds) throw new Error("voice message rejected");
    const blob = new Blob([payload], { type: mime });
    addMessage({
      type: "voice",
      blob,
      duration: meta.duration,
      mine: false,
    });
    const ack = sessionMeta("VOICE_ACK", { messageId: meta.messageId });
    await connection.write(packChatEnvelope(ack));
    await connection.closeWrite();
    setStatus(t("message_received"), "connected");
    noteAuthenticatedPeerTraffic();
  } catch (error) {
    if (groupProtocol) recordGroupError(error);
    else recordError(error);
  } finally {
    connection.close();
  }
}

// ---- WebRTC live media --------------------------------------------------

let peerConnection = null;
let localMediaStream = null;
let pendingCallOffer = null;
let liveMode = "";
let liveGeneration = 0;
let liveActivityTimer = null;
let callSetupTimer = null;
let currentCallId = "";
let rtcDisconnectTimer = null;
let iceRestartAttempted = false;
let cameraFacingMode = "user";
let mediaMuted = false;
let cameraDisabled = false;

function stopMediaStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function beginLiveActivity() {
  clearTimeout(callSetupTimer);
  callSetupTimer = null;
  clearInterval(liveActivityTimer);
  markActivity();
  liveActivityTimer = setInterval(markActivity, 5 * 60 * 1000);
}

function armCallSetupTimeout(generation, callId) {
  clearTimeout(callSetupTimer);
  callSetupTimer = setTimeout(() => {
    if (generation !== liveGeneration || callId !== currentCallId) return;
    setStatus(t("call_timeout"), "error");
    endLiveLink(true, t("call_timeout"));
  }, APP_CONFIG.rtc.callSetupTimeoutMs);
}

function waitForICE(connection) {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (connection.iceGatheringState === "complete") {
        connection.removeEventListener("icegatheringstatechange", done);
        resolve();
      }
    };
    connection.addEventListener("icegatheringstatechange", done);
    setTimeout(() => {
      connection.removeEventListener("icegatheringstatechange", done);
      resolve();
    }, APP_CONFIG.rtc.iceGatheringTimeoutMs);
  });
}

function createPeerConnection(generation) {
  peerConnection?.close();
  const connection = new RTCPeerConnection({ iceServers: APP_CONFIG.rtc.iceServers });
  peerConnection = connection;
  connection.ontrack = (event) => {
    if (connection !== peerConnection || generation !== liveGeneration) return;
    $("remote-media").srcObject = event.streams[0] || new MediaStream([event.track]);
    setMediaStatus(t("call_live"));
  };
  connection.onconnectionstatechange = () => {
    if (connection !== peerConnection || generation !== liveGeneration) return;
    if (connection.connectionState === "connected") {
      clearTimeout(rtcDisconnectTimer);
      rtcDisconnectTimer = null;
      setMediaStatus(t("call_live"));
      beginLiveActivity();
    }
    if (connection.connectionState === "disconnected") {
      setMediaStatus(t("call_reconnecting"));
      clearTimeout(rtcDisconnectTimer);
      rtcDisconnectTimer = setTimeout(() => attemptIceRestart(generation, currentCallId), 8_000);
    }
    if (connection.connectionState === "failed") void attemptIceRestart(generation, currentCallId);
    if (connection.connectionState === "closed") endLiveLink(false, t("call_ended"));
  };
  return connection;
}

async function attemptIceRestart(generation, callId) {
  if (!peerConnection || generation !== liveGeneration || callId !== currentCallId) return;
  if (iceRestartAttempted) {
    endLiveLink(false, t("call_ended"));
    return;
  }
  iceRestartAttempted = true;
  clearTimeout(rtcDisconnectTimer);
  rtcDisconnectTimer = null;
  setMediaStatus(t("call_reconnecting"));
  try {
    peerConnection.restartIce?.();
    await peerConnection.setLocalDescription(await peerConnection.createOffer({ iceRestart: true }));
    if (generation !== liveGeneration) return;
    await waitForICE(peerConnection);
    if (generation !== liveGeneration) return;
    await sendControl("RTC_RESTART_OFFER", {
      callId,
      mode: liveMode,
      description: peerConnection.localDescription.toJSON(),
    });
    rtcDisconnectTimer = setTimeout(() => {
      if (generation === liveGeneration && peerConnection?.connectionState !== "connected") {
        endLiveLink(false, t("call_ended"));
      }
    }, 15_000);
  } catch (error) {
    recordError(error);
    endLiveLink(false, format("call_failed", { message: redact(error.message) }));
  }
}

async function acceptRTCRestartOffer(meta) {
  if (!peerConnection
    || meta.callId !== currentCallId
    || !meta.description?.sdp
    || !["voice", "video", "screen"].includes(meta.mode)) return;
  const generation = liveGeneration;
  clearTimeout(rtcDisconnectTimer);
  rtcDisconnectTimer = null;
  setMediaStatus(t("call_reconnecting"));
  await peerConnection.setRemoteDescription(meta.description);
  await peerConnection.setLocalDescription(await peerConnection.createAnswer());
  if (generation !== liveGeneration) return;
  await waitForICE(peerConnection);
  if (generation !== liveGeneration) return;
  await sendControl("RTC_RESTART_ANSWER", {
    callId: currentCallId,
    mode: liveMode,
    description: peerConnection.localDescription.toJSON(),
  });
}

async function acceptRTCRestartAnswer(meta) {
  if (!peerConnection || meta.callId !== currentCallId || !meta.description?.sdp) return;
  await peerConnection.setRemoteDescription(meta.description);
  setMediaStatus(t("call_reconnecting"));
}

function openMediaDock(mode) {
  void wakeLocks.acquire("live-call");
  $("app").classList.add("media-open");
  setMobileState("call");
  $("media-dock").classList.remove("hidden");
  $("media-title").textContent = mode === "screen" ? t("screen_share") : mode === "video" ? t("video_call") : t("voice_call");
}

async function getOutgoingMedia(mode, generation) {
  if (mode === "screen") {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (generation === liveGeneration) endLiveLink(true, t("call_ended"));
    }, { once: true });
    return stream;
  }
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: mode === "video" ? { facingMode: { ideal: cameraFacingMode } } : false,
  });
}

async function startLiveLink(mode) {
  if (!activeSession) {
    setStatus(t("need_peer"), "error");
    return;
  }
  const allowed = mode === "screen"
    ? (peerCapabilities?.rtc?.screenReceive ?? peerCapabilities?.rtc?.video)
    : peerCapabilities?.rtc?.[mode];
  if (!allowed) {
    setStatus(t("unsupported_capability"), "error");
    return;
  }
  endLiveLink(false);
  const generation = liveGeneration;
  const callId = randomID();
  currentCallId = callId;
  armCallSetupTimeout(generation, callId);
  liveMode = mode;
  iceRestartAttempted = false;
  mediaMuted = false;
  cameraDisabled = false;
  openMediaDock(mode);
  setMediaStatus(t("call_requesting"));
  try {
    const stream = await getOutgoingMedia(mode, generation);
    if (generation !== liveGeneration) {
      stopMediaStream(stream);
      return;
    }
    localMediaStream = stream;
    $("local-media").srcObject = localMediaStream;
    $("local-media").classList.toggle("hidden", !localMediaStream.getVideoTracks().length);
    updateMediaControls();
    const connection = createPeerConnection(generation);
    localMediaStream.getTracks().forEach((track) => connection.addTrack(track, localMediaStream));
    await connection.setLocalDescription(await connection.createOffer());
    if (generation !== liveGeneration) return;
    await waitForICE(connection);
    if (generation !== liveGeneration) return;
    await sendControl("RTC_OFFER", { callId, mode, description: connection.localDescription.toJSON() });
    if (generation !== liveGeneration) return;
    setMediaStatus(t("call_ringing"));
    markActivity();
  } catch (error) {
    if (generation !== liveGeneration) return;
    endLiveLink(false, format("call_failed", { message: redact(error.message) }));
    recordError(error);
  }
}

async function showIncomingCall(meta) {
  if (!["voice", "video", "screen"].includes(meta.mode)
    || !meta.description?.sdp
    || typeof meta.callId !== "string"
    || meta.callId.length !== 32) return;
  if (peerConnection || pendingCallOffer || currentCallId) {
    await sendControl("RTC_DECLINE", { callId: meta.callId, reason: "BUSY" }).catch(recordError);
    return;
  }
  pendingCallOffer = meta;
  $("incoming-call-description").textContent = t(`incoming_${meta.mode}`);
  $("incoming-call-dialog").showModal();
}

async function answerIncomingCall() {
  const offer = pendingCallOffer;
  pendingCallOffer = null;
  $("incoming-call-dialog").close();
  if (!offer) return;
  endLiveLink(false);
  const generation = liveGeneration;
  currentCallId = offer.callId;
  armCallSetupTimeout(generation, currentCallId);
  liveMode = offer.mode;
  openMediaDock(offer.mode);
  setMediaStatus(t("call_requesting"));
  try {
    // Permission is requested only here, directly after the user clicks Accept.
    const stream = offer.mode === "screen"
      ? null
      : await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: offer.mode === "video" ? { facingMode: { ideal: cameraFacingMode } } : false,
      });
    if (generation !== liveGeneration) {
      stopMediaStream(stream);
      return;
    }
    localMediaStream = stream;
    $("local-media").srcObject = localMediaStream;
    $("local-media").classList.toggle("hidden", !localMediaStream?.getVideoTracks().length);
    updateMediaControls();
    const connection = createPeerConnection(generation);
    localMediaStream?.getTracks().forEach((track) => connection.addTrack(track, localMediaStream));
    await connection.setRemoteDescription(offer.description);
    if (generation !== liveGeneration) return;
    await connection.setLocalDescription(await connection.createAnswer());
    if (generation !== liveGeneration) return;
    await waitForICE(connection);
    if (generation !== liveGeneration) return;
    await sendControl("RTC_ANSWER", {
      callId: currentCallId,
      mode: offer.mode,
      description: connection.localDescription.toJSON(),
    });
    if (generation !== liveGeneration) return;
    setMediaStatus(t("call_connecting"));
    markActivity();
  } catch (error) {
    if (generation !== liveGeneration) return;
    await sendControl("RTC_DECLINE", { callId: currentCallId, reason: "MEDIA_FAILED" }).catch(() => {});
    endLiveLink(false, format("call_failed", { message: redact(error.message) }));
    recordError(error);
  }
}

async function declineIncomingCall() {
  const offer = pendingCallOffer;
  if (!offer) return;
  pendingCallOffer = null;
  $("incoming-call-dialog").close();
  await sendControl("RTC_DECLINE", { callId: offer.callId, reason: "USER_DECLINED" }).catch(recordError);
}

async function acceptRTCAnswer(meta) {
  if (!meta.description?.sdp) throw new Error("invalid RTC answer");
  await peerConnection.setRemoteDescription(meta.description);
  setMediaStatus(t("call_connecting"));
}

function updateMediaControls() {
  const mute = $("media-mute");
  const camera = $("media-camera");
  const flip = $("media-switch-camera");
  if (mute) {
    const label = mediaMuted ? t("call_unmute") : t("call_mute");
    mute.title = label;
    mute.setAttribute("aria-label", label);
    mute.setAttribute("aria-pressed", String(mediaMuted));
    mute.disabled = !localMediaStream?.getAudioTracks().length;
  }
  if (camera) {
    const hasCamera = Boolean(localMediaStream?.getVideoTracks().length) && liveMode === "video";
    const label = cameraDisabled ? t("camera_on") : t("camera_off");
    camera.title = label;
    camera.setAttribute("aria-label", label);
    camera.setAttribute("aria-pressed", String(cameraDisabled));
    camera.disabled = !hasCamera;
    camera.classList.toggle("hidden", !hasCamera);
  }
  if (flip) {
    const canFlip = support.mobile && Boolean(localMediaStream?.getVideoTracks().length) && liveMode === "video";
    flip.title = t("switch_camera");
    flip.setAttribute("aria-label", t("switch_camera"));
    flip.disabled = !canFlip;
    flip.classList.toggle("hidden", !canFlip);
  }
}

function toggleMediaMute() {
  mediaMuted = !mediaMuted;
  for (const track of localMediaStream?.getAudioTracks() || []) track.enabled = !mediaMuted;
  updateMediaControls();
}

function toggleMediaCamera() {
  cameraDisabled = !cameraDisabled;
  for (const track of localMediaStream?.getVideoTracks() || []) track.enabled = !cameraDisabled;
  updateMediaControls();
}

async function switchMediaCamera() {
  if (!peerConnection || liveMode !== "video") return;
  const sender = peerConnection.getSenders().find(({ track }) => track?.kind === "video");
  if (!sender) return;
  const nextFacing = cameraFacingMode === "user" ? "environment" : "user";
  let replacementStream = null;
  let installed = false;
  try {
    replacementStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: nextFacing } },
      audio: false,
    });
    const replacement = replacementStream.getVideoTracks()[0];
    if (!replacement) throw new Error("camera track unavailable");
    replacement.enabled = !cameraDisabled;
    const previous = sender.track;
    await sender.replaceTrack(replacement);
    installed = true;
    localMediaStream?.removeTrack?.(previous);
    localMediaStream?.addTrack?.(replacement);
    previous?.stop();
    cameraFacingMode = nextFacing;
    $("local-media").srcObject = localMediaStream;
    updateMediaControls();
  } catch (error) {
    if (!installed) stopMediaStream(replacementStream);
    recordError(error);
    setMediaStatus(format("call_failed", { message: redact(error.message) }));
  }
}

async function endLiveLink(notifyPeer = false, message = "") {
  liveGeneration += 1;
  clearTimeout(callSetupTimer);
  callSetupTimer = null;
  clearTimeout(rtcDisconnectTimer);
  rtcDisconnectTimer = null;
  clearInterval(liveActivityTimer);
  liveActivityTimer = null;
  const endedCallId = currentCallId || pendingCallOffer?.callId || "";
  currentCallId = "";
  iceRestartAttempted = false;
  const hadLink = Boolean(peerConnection || localMediaStream || pendingCallOffer);
  const connection = peerConnection;
  peerConnection = null;
  connection?.close();
  stopMediaStream(localMediaStream);
  localMediaStream = null;
  pendingCallOffer = null;
  if ($("incoming-call-dialog").open) $("incoming-call-dialog").close();
  $("local-media").srcObject = null;
  $("remote-media").srcObject = null;
  $("media-dock").classList.remove("expanded");
  $("media-dock").classList.add("hidden");
  $("app").classList.remove("media-open");
  void wakeLocks.release("live-call");
  setMobileState(activeSession ? "connected" : restingMobileState());
  updateMediaControls();
  setMediaStatus(message || t("call_ended"));
  if (notifyPeer && hadLink && activeSession && endedCallId) {
    await sendControl("RTC_HANGUP", { callId: endedCallId }).catch(() => {});
  }
}

// ---- QR, clipboard, and UI bindings ------------------------------------

function drawInviteQR(value, scope = null) {
  const qr = encodeQR(value, { ecc: "M", border: 4 });
  const canvas = $("qr-canvas");
  const scale = Math.max(2, Math.floor(512 / qr.size));
  canvas.width = qr.size * scale;
  canvas.height = qr.size * scale;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#050a07";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.data[y][x]) context.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  qrScope = scope;
}

function clearInviteQR() {
  const dialog = $("qr-dialog");
  if (dialog.open) dialog.close();
  const canvas = $("qr-canvas");
  canvas.width = 320;
  canvas.height = 320;
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  qrScope = null;
}

function clearGroupInviteQR(roomId = "") {
  if (qrScope?.mode !== "group") return;
  if (roomId && qrScope.roomId !== roomId) return;
  clearInviteQR();
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const field = document.createElement("textarea");
  field.value = value;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("clipboard rejected");
}

async function copyWithFeedback(button, value, labelKey) {
  try {
    await copyText(value);
    button.textContent = t("copied");
  } catch (_) {
    window.prompt(t("copy_fallback"), value);
  }
  setTimeout(() => { button.textContent = t(labelKey); }, 1200);
}

async function shareInvite() {
  if (!localAddress) return;
  const value = inviteURL(localAddress);
  if (typeof navigator.share !== "function") {
    await copyWithFeedback($("share-invite"), value, "native_share");
    return;
  }
  try {
    await navigator.share({ title: "tailcat.app", text: t("invite_ready_body"), url: value });
  } catch (error) {
    if (error?.name === "AbortError") return;
    recordError(error);
    try {
      await copyWithFeedback($("share-invite"), value, "native_share");
    } catch (_) {
      setStatus(t("share_failed"), "error");
    }
  }
}

async function shareGroupInvite() {
  const value = groupInviteURL();
  if (!value) return;
  if (typeof navigator.share !== "function") {
    await copyWithFeedback($("group-share-invite-btn"), value, "native_share");
    return;
  }
  try {
    await navigator.share({ title: "tailcat.app Group Beta", text: t("group_invite_body"), url: value });
  } catch (error) {
    if (error?.name === "AbortError") return;
    await copyWithFeedback($("group-share-invite-btn"), value, "native_share");
  }
}

function updateGroupCreateValidity() {
  let valid = false;
  try {
    normalizeGroupDisplayName($("group-create-nickname").value);
    valid = true;
  } catch (_) {}
  if (support.mobile) valid = valid
    && APP_CONFIG.mobileGroupHostingEnabled
    && $("group-mobile-host-confirm").checked;
  $("group-create-btn").disabled = !valid;
  showGroupDialogError("group-create-status", support.mobile && !APP_CONFIG.mobileGroupHostingEnabled
    ? t("group_mobile_hosting_disabled")
    : "");
}

function updateGroupJoinValidity() {
  let valid = false;
  try {
    normalizeGroupDisplayName($("group-join-nickname").value);
    valid = true;
  } catch (_) {}
  $("group-join-btn").disabled = !valid;
  showGroupDialogError("group-join-status", "");
}

$("group-create-entry-btn")?.addEventListener("click", () => {
  if (!groupFeatureAvailable()) {
    setStatus(t("group_rooms_disabled"), "error");
    return;
  }
  $("group-mobile-host-warning").classList.toggle("hidden", !support.mobile);
  $("group-mobile-host-confirm").checked = false;
  $("group-create-nickname").value = "";
  updateGroupCreateValidity();
  showGroupDialogError("group-create-status", support.mobile && !APP_CONFIG.mobileGroupHostingEnabled
    ? t("group_mobile_hosting_disabled")
    : "");
  $("group-create-dialog").showModal();
  $("group-create-nickname").focus();
});
$("group-create-nickname")?.addEventListener("input", updateGroupCreateValidity);
$("group-mobile-host-confirm")?.addEventListener("change", updateGroupCreateValidity);
$("group-create-cancel-btn")?.addEventListener("click", () => {
  groupCreateOperation += 1;
  $("group-create-dialog").close();
});
$("group-create-btn")?.addEventListener("click", () => void createGroupRoom());
$("group-create-dialog")?.addEventListener("cancel", () => {
  groupCreateOperation += 1;
  showGroupDialogError("group-create-status", "");
});

$("group-join-nickname")?.addEventListener("input", updateGroupJoinValidity);
$("group-join-cancel-btn")?.addEventListener("click", () => {
  groupJoinOperation += 1;
  pendingGroupInvite = null;
  $("group-join-dialog").close();
  setStatus(t("group_request_cancelled"), "ready");
});
$("group-join-btn")?.addEventListener("click", () => void requestGroupJoin());
$("group-join-dialog")?.addEventListener("cancel", () => {
  groupJoinOperation += 1;
  pendingGroupInvite = null;
});
$("group-waiting-cancel-btn")?.addEventListener("click", () => void groupRoom?.cancelJoin());

$("group-copy-invite-btn")?.addEventListener("click", () => (
  copyWithFeedback($("group-copy-invite-btn"), groupInviteURL(), "copy_invite")
));
$("group-share-invite-btn")?.addEventListener("click", () => void shareGroupInvite());
$("group-show-qr-btn")?.addEventListener("click", () => {
  try {
    drawInviteQR(groupInviteURL(), { mode: "group", roomId: groupRoom?.roomId || "" });
    $("qr-dialog").showModal();
  } catch (error) {
    recordGroupError(error);
  }
});
$("group-pause-joins-btn")?.addEventListener("click", () => {
  if (groupRoom?.mode === "owner") groupRoom.setJoinsPaused(!groupRoom.joinsPaused);
});
$("group-rotate-invite-btn")?.addEventListener("click", async () => {
  try {
    await groupRoom?.rotateInvitation();
    clearGroupInviteQR(groupRoom?.roomId || "");
    setStatus(t("group_invite_rotated"), "connected");
  } catch (error) {
    recordGroupError(error);
  }
});
$("group-close-room-btn")?.addEventListener("click", () => void groupRoom?.close("HOST_CLOSED", { notify: true }));
$("group-leave-room-btn")?.addEventListener("click", () => void groupRoom?.leave());
$("group-recipient-all")?.addEventListener("change", (event) => {
  for (const input of document.querySelectorAll("#group-recipient-list .group-recipient-checkbox:not(:disabled)")) {
    input.checked = event.currentTarget.checked;
  }
  updateGroupRecipientSummary();
});

$("persist-key").addEventListener("change", () => {
  $("persist-risk").classList.toggle("hidden", !$("persist-key").checked);
});

$("native-file-note")?.classList.toggle("hidden", !nativeFilesEnabled());
$("force-derp-label")?.classList.toggle("hidden", !nativeFilesEnabled());
if ($("force-derp")) $("force-derp").checked = forceDerpFiles();
$("force-derp")?.addEventListener("change", (event) => {
  try { localStorage.setItem("tailcat.forceDerp", event.target.checked ? "1" : "0"); } catch (_) {}
});
$("forget-key").addEventListener("click", async () => {
  try {
    await dbDelete();
    $("persist-key").checked = false;
    $("persist-risk").classList.add("hidden");
    $("forget-key").classList.add("hidden");
    $("send-progress").textContent = t("persistent_forgotten");
  } catch (error) {
    recordError(error);
    setPersistenceAvailable(false);
  }
});
$("listen-btn").addEventListener("click", () => startRoom());
$("stop-listen-btn").addEventListener("click", () => stopRoom());
$("connect-btn").addEventListener("click", () => connectToPeer($("send-addr").value));
$("send-addr").addEventListener("input", () => { $("connect-btn").disabled = !tcTest.ready; });
$("send-addr").addEventListener("keydown", (event) => {
  if (event.key === "Enter") connectToPeer($("send-addr").value);
});
$("copy-invite").addEventListener("click", () => copyWithFeedback($("copy-invite"), inviteURL(localAddress), "copy_invite"));
$("share-invite")?.addEventListener("click", shareInvite);
$("copy-addr").addEventListener("click", () => copyWithFeedback($("copy-addr"), localAddress, "copy_address"));
$("mobile-menu-btn")?.addEventListener("click", () => setMobileSheet(true));
$("mobile-sheet-close")?.addEventListener("click", () => setMobileSheet(false));
$("mobile-sheet-backdrop")?.addEventListener("click", () => setMobileSheet(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("app").dataset.mobileSheet === "open") setMobileSheet(false);
});
$("show-qr").addEventListener("click", () => {
  try {
    drawInviteQR(inviteURL(localAddress), { mode: "private" });
    $("qr-dialog").showModal();
  } catch (error) {
    recordError(error);
    setStatus(format("generic_error", { message: redact(error.message) }), "error");
  }
});
$("qr-close").addEventListener("click", clearInviteQR);
$("qr-dialog").addEventListener("click", (event) => { if (event.target === $("qr-dialog")) clearInviteQR(); });
$("qr-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  clearInviteQR();
});
$("send-text-btn").addEventListener("click", sendText);
$("send-text").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!event.repeat) sendText();
  }
});
$("attach-btn").addEventListener("click", () => $("send-file").click());
$("send-file").addEventListener("change", () => {
  enqueueFiles($("send-file").files);
  $("send-file").value = "";
});
$("send-btn").addEventListener("click", () => enqueueFiles($("send-file").files));

let dragDepth = 0;
for (const eventName of ["dragenter", "dragover", "dragleave", "drop"]) {
  document.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
}
document.addEventListener("dragenter", () => {
  dragDepth += 1;
  if (activeSession || groupRoom?.canSend) $("drop-zone").classList.remove("hidden");
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $("drop-zone").classList.add("hidden");
});
document.addEventListener("drop", (event) => {
  dragDepth = 0;
  $("drop-zone").classList.add("hidden");
  enqueueFiles(event.dataTransfer.files);
});

if (voiceHoldMode) {
  $("ptt-btn").addEventListener("pointerdown", startVoiceNote);
  window.addEventListener("pointerup", stopVoiceNote);
  window.addEventListener("pointercancel", stopVoiceNote);
} else {
  $("ptt-btn").addEventListener("click", startVoiceNote);
  $("mobile-record-send")?.addEventListener("click", (event) => stopVoiceNote(event, true));
  $("mobile-record-cancel")?.addEventListener("click", cancelVoiceNote);
}
$("voice-call-btn").addEventListener("click", () => startLiveLink("voice"));
$("video-call-btn").addEventListener("click", () => startLiveLink("video"));
$("screen-share-btn").addEventListener("click", () => startLiveLink("screen"));
$("accept-call").addEventListener("click", answerIncomingCall);
$("decline-call").addEventListener("click", declineIncomingCall);
$("incoming-call-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  declineIncomingCall();
});
$("media-hangup").addEventListener("click", () => endLiveLink(true));
$("media-mute")?.addEventListener("click", toggleMediaMute);
$("media-camera")?.addEventListener("click", toggleMediaCamera);
$("media-switch-camera")?.addEventListener("click", switchMediaCamera);
$("media-expand").addEventListener("click", () => {
  const expanded = $("media-dock").classList.toggle("expanded");
  $("media-expand").classList.toggle("is-expanded", expanded);
  $("media-expand").title = expanded ? t("collapse") : t("expand");
  $("media-expand").setAttribute("aria-label", expanded ? t("collapse") : t("expand"));
});

window.addEventListener("beforeunload", () => {
  if (groupRoom?.active) void groupRoom.close(groupRoom.mode === "owner" ? "HOST_CLOSED" : "LEFT", { notify: true });
  listener?.close();
  incomingFileTransfer?.connection?.close();
  activeFileTransfer?.connection?.close();
  activeFileTransfer?.entry?.connection?.close();
  void wakeLocks.cleanup();
  visualViewportSync.cleanup();
});

subscribePageLifecycle({
  hidden: notePageBackgrounded,
  freeze: notePageBackgrounded,
  visible: resumeForegroundSession,
  resume: resumeForegroundSession,
  pagehide: ({ persisted }) => {
    notePageBackgrounded();
    if (!persisted) {
      if (groupRoom?.active) void groupRoom.close(groupRoom.mode === "owner" ? "HOST_CLOSED" : "LEFT", { notify: true });
      listener?.close();
      incomingFileTransfer?.connection?.close();
      activeFileTransfer?.connection?.close();
      activeFileTransfer?.entry?.connection?.close();
    }
  },
  pageshow: resumeForegroundSession,
});

window.addEventListener("hashchange", () => {
  const invite = consumeInviteFragment();
  if (!invite.address && !invite.group) return;
  if (support.ok) {
    if (groupRoom?.active || activeSession || listener) {
      setStatus(t("status_busy"), "error");
    } else if (invite.group) {
      presentGroupInvitation(invite.group);
    } else {
      void connectToPeer(invite.address);
    }
  } else {
    pendingInviteAddress = invite.address;
    pendingGroupInvite = invite.group;
    $("blocked-invite-copy").classList.remove("hidden");
  }
});

// ---- WASM startup and diagnostics --------------------------------------

function countProgress(stream, total) {
  let loaded = 0;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      if (total > 0) {
        const percent = Math.min(100, Math.floor(loaded / total * 100));
        $("load-progress").value = loaded / total;
        setStatus(format("status_loading_percent", { percent }), "loading");
      }
      controller.enqueue(chunk);
    },
  }));
}

async function fetchWasm() {
  const response = await fetch("main.wasm.gz", { cache: "no-cache", credentials: "same-origin" });
  if (!response.ok || !response.body) throw new Error(`main.wasm.gz: HTTP ${response.status}`);
  const total = Number(response.headers.get("Content-Length")) || 0;
  const decompressed = countProgress(response.body, total).pipeThrough(new DecompressionStream("gzip"));
  return new Response(decompressed, { headers: { "Content-Type": "application/wasm" } });
}

async function startWasm() {
  const ready = new Promise((resolve) => { globalThis.onTailcatReady = resolve; });
  const go = new Go();
  const { instance } = await WebAssembly.instantiateStreaming(await fetchWasm(), go.importObject);
  go.run(instance).catch(recordError);
  await ready;
}

async function protocolSelfTest() {
  const session = "0".repeat(32);
  const offer = { type: "OFFER", v: 1, session, transferId: "1".repeat(32), name: "safe.txt", size: 3, chunkBytes: APP_CONFIG.limits.fileChunkBytes };
  const wire = concatBytes(
    TCF_MAGIC,
    packFileJSON(FILE_FRAME.META, offer),
    packFileFrame(FILE_FRAME.DATA, new Uint8Array([97, 98, 99])),
    packFileJSON(FILE_FRAME.FINAL, { type: "FINAL", v: 1, session, transferId: offer.transferId, size: 3, sha256: "x".repeat(64) }),
  );
  const pieces = Array.from(wire, (byte) => new Uint8Array([byte]));
  const mockConnection = { read: async () => pieces.shift() || null };
  const reader = new ConnectionReader(mockConnection);
  const magic = await reader.readExact(4);
  const decodedOffer = decodeFileJSON(await readFileFrame(reader), [FILE_FRAME.META]);
  const data = await readFileFrame(reader);
  const final = decodeFileJSON(await readFileFrame(reader), [FILE_FRAME.FINAL]);
  const hasher = tailcatNewSHA256();
  await hasher.update(data.payload.subarray(0, 1));
  await hasher.update(data.payload.subarray(1));
  const digest = await hasher.digestHex();
  hasher.close();
  const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const groupWrites = [];
  const groupWriter = new GroupFrameWriter({
    write: async (bytes) => groupWrites.push(bytes.slice()),
    closeWrite: async () => {},
    close: () => {},
  });
  const groupTestFrame = { type: "PING", gv: 1, roomId: "A".repeat(22), pingId: "B".repeat(22) };
  await groupWriter.send(groupTestFrame);
  const groupWire = concatBytes(...groupWrites);
  const groupPieces = Array.from(groupWire, (byte) => new Uint8Array([byte]));
  const groupReader = new GroupFrameReader({ read: async () => groupPieces.shift() || null });
  const decodedGroupFrame = await groupReader.read();
  const groupURL = makeGroupInviteURL(invitationOrigin(), {
    address: `tc${"a".repeat(64)}`,
    roomId: "A".repeat(22),
    joinToken: "B".repeat(43),
  });
  const parsedGroup = parseGroupInviteFragment(new URL(groupURL).hash.slice(1), { validAddress });
  let rejectedOversizedBatch = false;
  try {
    groupBatchBytes([{ size: 512 * 1024 * 1024 + 1 }], 2, APP_CONFIG.group.maxBatchBytes);
  } catch (_) {
    rejectedOversizedBatch = true;
  }
  const results = {
    fragment: inviteURL(`tc${"a".repeat(64)}`).includes("#v=1&invite=") && location.hash === "",
    "frame-boundaries": equalBytes(magic, TCF_MAGIC) && data.payload.length === 3 && data.payload[2] === 99 && decodedOffer.name === "safe.txt" && final.size === 3,
    "file-name": sanitizeFileName("../bad\\name\u0000.txt") === "name.txt",
    "file-sizes": validFileSize(APP_CONFIG.limits.fileBytes) && !validFileSize(APP_CONFIG.limits.fileBytes + 1),
    "private-file-auto-boundary": APP_CONFIG.limits.privateFileAutoReceiveBytes === 100 * 1024 * 1024
      && APP_CONFIG.limits.privateFileAutoReceiveBytes < APP_CONFIG.limits.fileBytes
      && APP_CONFIG.limits.privateFileAutoReceiveSessionBytes === 500 * 1024 * 1024
      && APP_CONFIG.limits.privateFileAutoReceiveSessionItems === 20,
    "voice-mime": safeVoiceMime(" AUDIO/WEBM ; CODECS=\"OPUS\" ") === "audio/webm;codecs=opus"
      && safeVoiceMime("audio/mp4;codecs=mp4a.40.2") === "audio/mp4;codecs=mp4a.40.2"
      && safeVoiceMime("audio/webm;codecs=vorbis") === ""
      && safeVoiceMime("audio/mp4;codecs=opus") === ""
      && safeVoiceMime("text/plain") === ""
      && selectMutualVoiceType(
        ["audio/webm;codecs=opus"],
        ["audio/webm;codecs=vorbis", "audio/mp4;codecs=mp4a.40.2"],
      ) === ""
      && selectMutualVoiceType(
        ["audio/mp4;codecs=mp4a.40.2"],
        ["audio/mp4; codecs=\"mp4a.40.2\""],
      ) === "audio/mp4;codecs=mp4a.40.2",
    sha256: digest === expected && data.payload.length === 3,
    "session-lock": sessionMatches({ v: APP_CONFIG.protocolVersion, session }, session)
      && !sessionMatches({ v: APP_CONFIG.protocolVersion, session: "2".repeat(32) }, session),
    "group-frame": decodedGroupFrame.type === groupTestFrame.type
      && decodedGroupFrame.pingId === groupTestFrame.pingId,
    "group-invite": parsedGroup?.roomId === "A".repeat(22)
      && parsedGroup?.joinToken === "B".repeat(43),
    "group-batch": groupBatchBytes([{ size: 512 * 1024 * 1024 }], 2, APP_CONFIG.group.maxBatchBytes)
      === APP_CONFIG.group.maxBatchBytes
      && rejectedOversizedBatch,
  };
  const checks = Object.keys(results);
  const result = {
    ok: Object.values(results).every(Boolean),
    checks,
    sha256: digest,
    countedBytes: data.payload.length,
  };
  if (!result.ok) throw new Error("protocol self-test failed");
  return result;
}

async function groupVoiceDeadlineSelfTest() {
  const wire = packGroupVoiceFrame({ type: "VOICE_OFFER", mode: "group", gv: 1, roomId: "A".repeat(22) });
  const pieces = Array.from(wire, (byte) => new Uint8Array([byte]));
  let closed = false;
  let reads = 0;
  const connection = {
    async read() {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return pieces.shift() || null;
    },
    close() { closed = true; },
  };
  const reader = new ConnectionReader(connection, 1_000);
  let error = "";
  try {
    await withConnectionDeadline(
      connection,
      readGroupVoiceFrame(reader, 0),
      25,
      "group voice absolute deadline reached",
    );
  } catch (caught) {
    error = String(caught?.message || caught);
  }
  return { closed, reads, error };
}

tcTest.runProtocolSelfTests = protocolSelfTest;
tcTest.runProtocolSelfTest = protocolSelfTest;
tcTest.runGroupVoiceDeadlineSelfTest = groupVoiceDeadlineSelfTest;

async function bootstrap() {
  $("app").setAttribute("aria-busy", "true");
  await Promise.all([probePersistence(), refreshFileSinkSupport()]);
  await loadRememberedKey();
  if (!APP_CONFIG.roomsEnabled) {
    pendingInviteAddress = "";
    pendingGroupInvite = null;
    tcTest.ready = false;
    tcTest.state.transport = "maintenance";
    $("app").setAttribute("aria-busy", "false");
    $("load-progress").remove();
    $("listen-btn").disabled = true;
    $("connect-btn").disabled = true;
    setStatus(t("rooms_disabled"), "error");
    return;
  }
  await startWasm();
  tcTest.ready = true;
  tcTest.state.transport = "ready";
  $("app").setAttribute("aria-busy", "false");
  $("load-progress").remove();
  $("listen-btn").disabled = false;
  $("connect-btn").disabled = false;
  renderConnectionState();
  if (groupFeatureAvailable()) renderGroupState(ensureGroupRoom().snapshot());
  else tcTest.group = { enabled: false, mode: "none", members: 0, online: 0, pending: 0, sequence: 0, paused: false };
  await protocolSelfTest();
  if (pendingGroupInvite) {
    const invite = pendingGroupInvite;
    presentGroupInvitation(invite);
  } else if (pendingInviteAddress) {
    const address = pendingInviteAddress;
    pendingInviteAddress = "";
    $("send-addr").value = address;
    await connectToPeer(address);
  } else if (new URLSearchParams(location.search).get("mode") === "listen") {
    await startRoom();
  }
}
