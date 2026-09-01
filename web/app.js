import { APP_CONFIG, defaultRegionCode, regionByCode } from "./config.js";
import { createI18n } from "./i18n.js";
import { encode as encodeQR } from "./vendor/uqr.js";

const $ = (id) => document.getElementById(id);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const i18n = createI18n();
const { t } = i18n;
const TCH_MAGIC = new Uint8Array([0x54, 0x43, 0x48, 0x31]); // TCH1
const TCF_MAGIC = new Uint8Array([0x54, 0x43, 0x46, 0x31]); // TCF1
const FILE_FRAME = Object.freeze({ META: 1, DATA: 2, FINAL: 3, CANCEL: 4 });
const DB_NAME = "tailcat-app";
const DB_STORE = "private-settings";
const DB_KEY = "remembered-listener";
const CANONICAL_ORIGIN = "https://tailcat.app/";
const STREAM_READ_TIMEOUT_MS = 30_000;
const FILE_DECISION_TIMEOUT_MS = 2 * 60 * 1000;
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

// Read the invite before any transport starts, then immediately remove it from
// the visible URL. Fragments never travel in HTTP requests, Referer headers, or
// Cloudflare logs; removing it also avoids leaking it in screenshots/history.
function consumeInviteFragment() {
  const raw = location.hash.slice(1);
  if (!raw) return "";
  let address = "";
  try {
    const fragment = new URLSearchParams(raw);
    if (!fragment.has("invite") && !fragment.has("v")) return "";
    if (fragment.get("v") === String(APP_CONFIG.protocolVersion)) {
      address = fragment.get("invite") || "";
    }
  } catch (_) {
    return "";
  }
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return validAddress(address) ? address : "";
}

const hadInviteFragment = Boolean(location.hash);
let pendingInviteAddress = consumeInviteFragment();

function validAddress(value) {
  return typeof value === "string"
    && value.length >= 32
    && value.length <= 8192
    && value.startsWith("tc")
    && !/[\s\u0000-\u001f\u007f#]/u.test(value);
}

function inviteURL(address) {
  const url = new URL(CANONICAL_ORIGIN);
  url.hash = new URLSearchParams({ v: String(APP_CONFIG.protocolVersion), invite: address }).toString();
  return url.toString();
}

function browserSupport() {
  const ua = navigator.userAgent;
  const brands = navigator.userAgentData?.brands?.map(({ brand }) => brand.toLowerCase()) || [];
  const android = /Android/i.test(ua) || navigator.userAgentData?.platform === "Android";
  const safari = /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|Edg|OPR)\//.test(ua);
  const firefox = /(Firefox|FxiOS)\//.test(ua);
  const edge = brands.some((brand) => brand.includes("microsoft edge")) || /Edg\//.test(ua);
  const chrome = brands.some((brand) => brand.includes("google chrome"))
    || (/Chrome\//.test(ua) && !/(OPR|SamsungBrowser|EdgA|EdgiOS)\//.test(ua));
  const ios = /(iPhone|iPad|iPod)/i.test(ua);
  return {
    android,
    edge,
    chrome,
    ok: !ios && !safari && !firefox && ((android && chrome && !edge) || (!android && (chrome || edge))),
  };
}

const support = browserSupport();

const tcTest = {
  ready: false,
  inviteConsumed: hadInviteFragment && location.hash === "",
  unsupported: !support.ok,
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
    ports: APP_CONFIG.ports,
  }),
};
Object.defineProperty(window, "tcTest", { value: tcTest, enumerable: false, configurable: false });

function redact(value) {
  return String(value || "")
    .replace(/tc[^\s"']{8,}/g, "[tailcat-address]")
    .replace(/#(?:[^\s"']+)/g, "#[invite-removed]");
}

function recordError(error) {
  const message = redact(error?.message || error);
  tcTest.errors.push(message.slice(0, 500));
  if (tcTest.errors.length > 30) tcTest.errors.shift();
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

function validFileSize(size) {
  return Number.isSafeInteger(size) && size >= 0 && size <= APP_CONFIG.limits.fileBytes;
}

function setStatus(message, state = "loading") {
  $("status").textContent = message;
  $("status-dot").className = `status-dot ${state}`;
}

function setMediaStatus(message) {
  $("media-status").textContent = message;
}

function setComposerEnabled(enabled) {
  for (const id of ["send-text", "send-text-btn", "voice-call-btn", "video-call-btn"]) {
    $(id).disabled = !enabled;
  }
  $("attach-btn").disabled = !enabled || !peerCanReceiveFiles();
  $("ptt-btn").disabled = !enabled || peerCapabilities?.voice?.enabled !== true;
  const screenEnabled = enabled && !support.android && Boolean(navigator.mediaDevices?.getDisplayMedia);
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
}

i18n.apply();
$("language-select").value = i18n.language;
$("blocked-language-select").value = i18n.language;
$("language-select").addEventListener("change", (event) => applyLanguage(event.target.value));
$("blocked-language-select").addEventListener("change", (event) => applyLanguage(event.target.value));
rebuildRegions();
$("region-select").value = defaultRegionCode();
$("android-note").classList.toggle("hidden", !support.android);
$("screen-share-btn").classList.toggle("hidden", support.android || !navigator.mediaDevices?.getDisplayMedia);

if (!support.ok) {
  $("app").classList.add("hidden");
  $("browser-blocker").classList.remove("hidden");
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
      const chunk = await readConnectionChunk(this.connection, this.timeoutMs);
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

async function readConnectionChunk(connection, timeoutMs = STREAM_READ_TIMEOUT_MS) {
  let timer = null;
  try {
    return await Promise.race([
      connection.read(),
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

async function readFileFrame(reader) {
  const header = await reader.readExact(5);
  const kind = header[0];
  const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(1, false);
  const maximum = kind === FILE_FRAME.DATA ? APP_CONFIG.limits.fileChunkBytes : APP_CONFIG.limits.controlBytes;
  if (![FILE_FRAME.META, FILE_FRAME.DATA, FILE_FRAME.FINAL, FILE_FRAME.CANCEL].includes(kind) || length > maximum) {
    throw new Error("invalid TCF1 frame");
  }
  return { kind, payload: await reader.readExact(length) };
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
let localAddress = "";
let activePeerAddress = "";
let activePeerNonce = "";
let activeSession = "";
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
  return {
    text: { maxBytes: APP_CONFIG.limits.textBytes },
    file: {
      protocol: "TCF1",
      maxBytes: APP_CONFIG.limits.fileBytes,
      chunkBytes: APP_CONFIG.limits.fileChunkBytes,
      receive: typeof window.showSaveFilePicker === "function",
    },
    voice: {
      maxBytes: APP_CONFIG.limits.voiceBytes,
      maxSeconds: APP_CONFIG.limits.voiceSeconds,
      enabled: Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia),
    },
    rtc: {
      voice: Boolean(window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia),
      video: Boolean(window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia),
      screen: !support.android && Boolean(window.RTCPeerConnection && navigator.mediaDevices?.getDisplayMedia),
      screenShare: !support.android && Boolean(window.RTCPeerConnection && navigator.mediaDevices?.getDisplayMedia),
      screenReceive: Boolean(window.RTCPeerConnection),
      turn: false,
    },
  };
}

function validCapabilities(value) {
  return value && typeof value === "object" ? value : {};
}

function markActivity() {
  if (!listener) return;
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
  if (activeSession && activePeerAddress) {
    $("peer-label").textContent = t("connected_peer");
    setStatus(t("status_connected"), "connected");
    setComposerEnabled(true);
    tcTest.state.peer = "connected";
    return;
  }
  $("peer-label").textContent = t("waiting_peer");
  setComposerEnabled(false);
  tcTest.state.peer = "none";
  if (listener) setStatus(format("status_listening", { region: listener.regionName || listener.regionCode || t("region_auto") }), "ready");
  else if (tcTest.ready) setStatus(stoppedForIdle ? t("status_idle_closed") : t("status_ready"), "ready");
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
      const activeFileRecentlyMoved = Boolean(activeFileTransfer)
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

function clearPeer() {
  stopPeerHeartbeat();
  lastAuthenticatedPeerTrafficAt = 0;
  activePeerAddress = "";
  activePeerNonce = "";
  activeSession = "";
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
    return null;
  }
}

async function startRoom() {
  if (!support.ok) throw new Error("unsupported browser");
  if (!APP_CONFIG.roomsEnabled) throw new Error(t("rooms_disabled"));
  if (listener) return listener;
  if (listenerStarting) return listenerStarting;
  stoppedForIdle = false;
  $("listen-btn").disabled = true;
  $("region-select").disabled = true;
  $("persist-key").disabled = true;
  setStatus(t("status_starting"), "loading");
  tcTest.state.room = "starting";
  listenerStarting = (async () => {
    let created = null;
    try {
      const remember = $("persist-key").checked;
      const saved = remember ? await dbRead().catch(() => null) : null;
      const requestedRegion = regionByCode($("region-select").value);
      created = await tailcatListen({
        derpMapURL: APP_CONFIG.derpMapURL,
        privateKey: saved?.privateKeyJSON || "",
        regionID: requestedRegion.id,
        onConnection: routeIncomingConnection,
      });
      listener = created;
      localAddress = created.addr;
      tcTest.listenAddr = created.addr;
      tcTest.state.room = "open";
      $("listen-addr").textContent = created.addr;
      $("listen-info").classList.remove("hidden");
      $("listen-btn").classList.add("hidden");
      $("stop-listen-btn").classList.remove("hidden");
      $("region-select").value = regionByCode(created.regionCode || requestedRegion.code).code;
      if (remember) {
        await dbWrite({
          privateKeyJSON: created.privateKeyJSON,
          regionID: created.regionID,
          regionCode: created.regionCode || requestedRegion.code,
          savedAt: new Date().toISOString(),
        });
        $("forget-key").classList.remove("hidden");
        $("send-progress").textContent = t("persistent_saved");
      }
      markActivity();
      renderConnectionState();
      return created;
    } catch (error) {
      created?.close();
      listener = null;
      localAddress = "";
      tcTest.listenAddr = null;
      tcTest.state.room = "closed";
      $("listen-info").classList.add("hidden");
      $("listen-addr").textContent = "";
      $("listen-btn").classList.remove("hidden");
      $("stop-listen-btn").classList.add("hidden");
      $("listen-btn").disabled = false;
      $("region-select").disabled = false;
      $("persist-key").disabled = false;
      setStatus(format("status_failed", { message: redact(error.message) }), "error");
      recordError(error);
      throw error;
    } finally {
      listenerStarting = null;
    }
  })();
  return listenerStarting;
}

async function stopRoom({ idle = false } = {}) {
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
  localAddress = "";
  tcTest.listenAddr = null;
  tcTest.state.room = "closed";
  $("listen-info").classList.add("hidden");
  $("listen-addr").textContent = "";
  $("listen-btn").classList.remove("hidden");
  $("listen-btn").disabled = !tcTest.ready;
  $("stop-listen-btn").classList.add("hidden");
  $("region-select").disabled = false;
  $("persist-key").disabled = false;
  clearPeer();
  setStatus(idle ? t("status_idle_closed") : t("status_stopped"), idle ? "error" : "ready");
}

function setPeerConnected(address, session, capabilities, nonce = "") {
  activePeerAddress = address;
  activeSession = session;
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
  if (handshakeWaiter) {
    setStatus(t("status_connecting"), "loading");
    return false;
  }
  await startRoom();
  pendingPeerAddress = normalized;
  pendingHandshakeNonce = randomID();
  $("send-addr").value = normalized;
  $("connect-btn").disabled = true;
  setStatus(t("status_connecting"), "loading");
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
    $("connect-btn").disabled = !tcTest.ready;
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
  void route.handler(connection).catch(recordError).finally(() => {
    const remaining = (inboundConnectionCounts.get(connection.port) || 1) - 1;
    if (remaining > 0) inboundConnectionCounts.set(connection.port, remaining);
    else inboundConnectionCounts.delete(connection.port);
  });
}

async function receiveControl(connection) {
  try {
    const bytes = await readAllBounded(connection, APP_CONFIG.limits.controlBytes + 8);
    const { meta, payload } = unpackChatEnvelope(bytes);
    if (payload.length) throw new Error("control message cannot have a payload");
    if (meta.type === "HELLO") {
      await receiveHello(meta);
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
  const key = meta.reason === "BUSY" ? "status_busy" : "status_protocol";
  const error = new Error(t(key));
  settleHandshake(error);
  setStatus(t(key), "error");
}

// ---- Text and message rendering ----------------------------------------

const renderedMessages = [];
let renderedMessageBytes = 0;

async function sendText() {
  const text = $("send-text").value;
  if (!text.trim()) return;
  if (!activeSession || !activePeerAddress) {
    setStatus(t("need_peer"), "error");
    return;
  }
  const payload = encoder.encode(text);
  if (payload.length > APP_CONFIG.limits.textBytes) {
    setStatus(t("message_too_large"), "error");
    return;
  }
  $("send-text-btn").disabled = true;
  setStatus(t("message_sending"), "loading");
  try {
    const messageId = randomID();
    const response = await sendChatEnvelopeTo(
      activePeerAddress,
      sessionMeta("TEXT", { messageId }),
      payload,
      APP_CONFIG.ports.text,
    );
    const ack = unpackChatEnvelope(response);
    if (ack.payload.length
      || ack.meta.type !== "TEXT_ACK"
      || !hasSession(ack.meta)
      || ack.meta.messageId !== messageId) throw new Error("text acknowledgement rejected");
    addMessage({ type: "text", text, mine: true });
    $("send-text").value = "";
    setStatus(t("message_delivered"), "connected");
    noteAuthenticatedPeerTraffic();
  } catch (error) {
    setStatus(format("status_failed", { message: redact(error.message) }), "error");
    recordError(error);
  } finally {
    $("send-text-btn").disabled = !activeSession;
  }
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
    glyph.textContent = "FILE";
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
    const who = item.mine ? t("you") : t("peer");
    meta.textContent = `${who} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    article.append(meta, bubble);
  }
  $("history").append(article);
  renderedMessages.push({ article, objectURL, retainedBytes });
  renderedMessageBytes += retainedBytes;
  while (renderedMessages.length > MESSAGE_HISTORY_MAX_ITEMS
    || renderedMessageBytes > MESSAGE_HISTORY_MAX_BYTES) {
    const expired = renderedMessages.shift();
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
}

addEventListener("pagehide", () => {
  for (const message of renderedMessages) {
    if (message.objectURL) URL.revokeObjectURL(message.objectURL);
  }
}, { once: true });

// ---- TCF1 streaming file protocol --------------------------------------

let activeFileTransfer = null;
const outgoingFileQueue = [];
const finishedTransferItems = [];
let processingFileQueue = false;

function peerCanReceiveFiles() {
  return peerCapabilities?.file?.protocol === "TCF1" && peerCapabilities.file.receive === true;
}

function renderTransferCount() {
  const count = $("transfer-list").children.length;
  $("queue-count").textContent = String(count);
  $("transfer-tray").classList.toggle("hidden", count === 0);
}

function finishTransferItem(ui) {
  if (!ui?.item || ui.item.dataset.finished === "true") return;
  ui.item.dataset.finished = "true";
  for (const control of [ui.cancel, ui.save, ui.reject]) {
    if (!control) continue;
    control.onclick = null;
    control.disabled = true;
  }
  finishedTransferItems.push(ui.item);
  while (finishedTransferItems.length > MAX_TRANSFER_HISTORY_ITEMS) {
    finishedTransferItems.shift()?.remove();
  }
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
  detail.textContent = format("file_queued", { name: sanitizeFileName(file.name) });
  const progress = document.createElement("progress");
  progress.max = 1;
  progress.value = 0;
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

function enqueueFiles(files) {
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
  if (processingFileQueue || activeFileTransfer?.direction === "incoming") return;
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
  const transferId = randomID();
  const session = activeSession;
  const address = activePeerAddress;
  const connection = await tailcatDial({
    addr: address,
    derpMapURL: APP_CONFIG.derpMapURL,
    port: APP_CONFIG.ports.file,
  });
  entry.connection = connection;
  if (entry.cancelled) {
    connection.close();
    throw new Error(t("file_cancelled"));
  }
  const reader = new ConnectionReader(connection, FILE_DECISION_TIMEOUT_MS + 10_000);
  const hasher = tailcatNewSHA256();
  let sent = 0;
  let digest = "";
  tcTest.sendDone = false;
  tcTest.sentBytes = 0;
  tcTest.sentSha256 = null;
  try {
    const offer = {
      type: "OFFER",
      v: APP_CONFIG.protocolVersion,
      session,
      transferId,
      name: entry.name,
      size: entry.file.size,
      mime: safeMime(entry.file.type),
      chunkBytes: APP_CONFIG.limits.fileChunkBytes,
    };
    await connection.write(TCF_MAGIC);
    await connection.write(packFileJSON(FILE_FRAME.META, offer));
    entry.ui.detail.textContent = t("file_waiting");

    const response = decodeFileJSON(await readFileFrame(reader), [FILE_FRAME.META, FILE_FRAME.CANCEL]);
    if (response.v !== APP_CONFIG.protocolVersion || response.session !== session || response.transferId !== transferId) {
      throw new Error("file response session rejected");
    }
    if (response.type !== "ACCEPT") {
      if (response.type === "REJECT") throw new Error(t("file_rejected"));
      throw new Error(response.reason || t("file_cancelled"));
    }
    noteAuthenticatedPeerTraffic();

    // File bytes are read only after ACCEPT. slice().arrayBuffer() bounds each
    // allocation to 64 KiB; file.arrayBuffer() and whole-file buffering are
    // intentionally never used.
    while (sent < entry.file.size) {
      if (entry.cancelled) {
        await connection.write(packFileJSON(FILE_FRAME.CANCEL, { type: "CANCEL", v: APP_CONFIG.protocolVersion, session, transferId }));
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
    const finalResponse = decodeFileJSON(await readFileFrame(reader), [FILE_FRAME.FINAL, FILE_FRAME.CANCEL]);
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
    hasher.close();
    connection.close();
  }
}

async function receiveFile(connection) {
  let writable = null;
  let hasher = null;
  let ui = null;
  let accepted = false;
  let verified = false;
  let offer = null;
  const reader = new ConnectionReader(connection);
  try {
    const magic = await reader.readExact(4);
    if (!equalBytes(magic, TCF_MAGIC)) throw new Error("invalid TCF1 preamble");
    offer = decodeFileJSON(await readFileFrame(reader), [FILE_FRAME.META]);
    if (offer.type !== "OFFER"
      || offer.v !== APP_CONFIG.protocolVersion
      || !hasSession(offer)
      || typeof offer.transferId !== "string"
      || offer.transferId.length !== 32
      || !validFileSize(offer.size)
      || offer.chunkBytes !== APP_CONFIG.limits.fileChunkBytes) throw new Error("file offer rejected");
    offer.name = sanitizeFileName(offer.name);
    offer.mime = safeMime(offer.mime);
    noteAuthenticatedPeerTraffic();

    if (activeFileTransfer) {
      await connection.write(packFileJSON(FILE_FRAME.META, {
        type: "REJECT", v: APP_CONFIG.protocolVersion, session: activeSession,
        transferId: offer.transferId, reason: "BUSY",
      }));
      return;
    }
    if (typeof window.showSaveFilePicker !== "function") {
      await connection.write(packFileJSON(FILE_FRAME.META, {
        type: "REJECT", v: APP_CONFIG.protocolVersion, session: activeSession,
        transferId: offer.transferId, reason: "NO_SAFE_FILE_PICKER",
      }));
      setStatus(t("file_no_picker"), "error");
      return;
    }

    activeFileTransfer = { direction: "incoming", connection, transferId: offer.transferId, cancelled: false };
    tcTest.state.file = "offered";
    ui = createIncomingTransferItem(offer);
    const decision = await waitForIncomingFileDecision(ui, offer, connection);
    if (!decision.accepted) return;
    writable = decision.writable;
    accepted = true;
    hasher = tailcatNewSHA256();
    tcTest.state.file = "receiving";
    tcTest.recvDone = false;
    tcTest.recvBytes = 0;
    tcTest.recvSha256 = null;
    await connection.write(packFileJSON(FILE_FRAME.META, {
      type: "ACCEPT", v: APP_CONFIG.protocolVersion, session: activeSession, transferId: offer.transferId,
    }));
    ui.save.classList.add("hidden");
    ui.reject.classList.add("hidden");
    ui.cancel.classList.remove("hidden");

    let received = 0;
    for (;;) {
      const frame = await readFileFrame(reader);
      if (frame.kind === FILE_FRAME.CANCEL) {
        const cancel = decodeFileJSON(frame, [FILE_FRAME.CANCEL]);
        if (!hasSession(cancel) || cancel.transferId !== offer.transferId) throw new Error("cancel session rejected");
        throw new Error(t("file_cancelled"));
      }
      if (frame.kind === FILE_FRAME.DATA) {
        const remaining = offer.size - received;
        const expected = Math.min(APP_CONFIG.limits.fileChunkBytes, remaining);
        if (remaining <= 0 || frame.payload.length !== expected) {
          throw new Error("file chunk length violates TCF1");
        }
        if (activeFileTransfer?.cancelled) throw new Error(t("file_cancelled"));
        await writable.write(frame.payload);
        await hasher.update(frame.payload);
        received += frame.payload.length;
        tcTest.recvBytes = received;
        ui.progress.value = offer.size ? received / offer.size : 1;
        ui.detail.textContent = format("file_receiving", {
          name: offer.name,
          received: humanSize(received),
          total: humanSize(offer.size),
        });
        noteAuthenticatedPeerTraffic();
        continue;
      }
      if (frame.kind !== FILE_FRAME.FINAL) throw new Error("unexpected frame during file body");
      const final = decodeFileJSON(frame, [FILE_FRAME.FINAL]);
      if (final.type !== "FINAL"
        || !hasSession(final)
        || final.transferId !== offer.transferId
        || final.size !== received
        || received !== offer.size
        || !/^[0-9a-f]{64}$/u.test(final.sha256)) throw new Error("invalid final file frame");
      const digest = await hasher.digestHex();
      if (digest !== final.sha256) throw new Error(t("file_hash_failed"));
      noteAuthenticatedPeerTraffic();
      await writable.close();
      writable = null;
      verified = true;
      tcTest.recvSha256 = digest;
      tcTest.recvDone = true;
      ui.progress.value = 1;
      ui.detail.textContent = t("file_verified");
      ui.cancel.classList.add("hidden");
      await connection.write(packFileJSON(FILE_FRAME.FINAL, {
        type: "DONE", v: APP_CONFIG.protocolVersion, session: activeSession,
        transferId: offer.transferId, size: received, sha256: digest,
      }));
      await connection.closeWrite();
      addMessage({ type: "file", mine: false, name: offer.name, size: offer.size, status: t("file_verified") });
      setStatus(t("file_verified"), "connected");
      break;
    }
  } catch (error) {
    if (writable) {
      try { await writable.abort(); } catch (_) {}
      writable = null;
    }
    if (accepted && offer && activeSession) {
      try {
        await connection.write(packFileJSON(FILE_FRAME.CANCEL, {
          type: "ERROR", v: APP_CONFIG.protocolVersion, session: activeSession,
          transferId: offer.transferId, reason: "TRANSFER_ABORTED",
        }));
      } catch (_) {}
    }
    if (ui) {
      ui.detail.textContent = error.message === t("file_hash_failed") ? t("file_hash_failed") : format("file_failed", { message: redact(error.message) });
      ui.cancel.classList.add("hidden");
    }
    if (accepted) recordError(error);
  } finally {
    if (!verified && writable) {
      try { await writable.abort(); } catch (_) {}
    }
    hasher?.close();
    connection.close();
    if (activeFileTransfer?.connection === connection) activeFileTransfer = null;
    finishTransferItem(ui);
    tcTest.state.file = "idle";
    processFileQueue();
  }
}

function createIncomingTransferItem(offer) {
  const fragment = $("incoming-file-template").content.cloneNode(true);
  const item = fragment.querySelector("li");
  const name = fragment.querySelector(".transfer-name");
  const detail = fragment.querySelector(".transfer-detail");
  const progress = fragment.querySelector("progress");
  const save = fragment.querySelector(".save-file");
  const reject = fragment.querySelector(".reject-file");
  const cancel = fragment.querySelector(".cancel-file");
  name.textContent = `${t("file_offer")}: ${offer.name}`;
  detail.textContent = format("file_offer_detail", { name: offer.name, size: humanSize(offer.size) });
  save.textContent = t("choose_save");
  reject.textContent = t("reject");
  cancel.textContent = t("cancel");
  $("transfer-list").append(fragment);
  renderTransferCount();
  return { item, name, detail, progress, save, reject, cancel };
}

function waitForIncomingFileDecision(ui, offer, connection) {
  return new Promise((resolve) => {
    let claimed = false;
    let resolved = false;
    const releaseDecision = () => {
      clearTimeout(timeout);
      if (activeFileTransfer?.connection === connection) activeFileTransfer.cancelDecision = null;
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
    const rejectOffer = async (reason, label = t("file_rejected")) => {
      if (!claim()) return;
      ui.detail.textContent = label;
      try {
        await connection.write(packFileJSON(FILE_FRAME.META, {
          type: "REJECT", v: APP_CONFIG.protocolVersion, session: activeSession,
          transferId: offer.transferId, reason,
        }));
      } catch (_) {
        // Closing the stream below is also an unambiguous rejection.
      } finally {
        finish({ accepted: false });
      }
    };
    const timeout = setTimeout(() => rejectOffer("OFFER_TIMEOUT", t("file_cancelled")), FILE_DECISION_TIMEOUT_MS);
    if (activeFileTransfer?.connection === connection) {
      activeFileTransfer.cancelDecision = () => rejectOffer("ROOM_CLOSED", t("file_cancelled"));
    }
    ui.save.onclick = async () => {
      if (claimed) return;
      ui.save.disabled = true;
      ui.reject.disabled = true;
      // This call is deliberately inside the click handler so Chrome treats it
      // as a user-initiated save decision.
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: offer.name });
        const writable = await handle.createWritable({ keepExistingData: false });
        if (!claim()) {
          try { await writable.abort(); } catch (_) {}
          return;
        }
        finish({ accepted: true, writable });
      } catch (error) {
        if (!claimed) await rejectOffer("USER_CANCELLED");
      }
    };
    ui.reject.onclick = () => rejectOffer("USER_REJECTED");
    ui.cancel.onclick = () => {
      if (activeFileTransfer?.connection === connection) {
        activeFileTransfer.cancelled = true;
        connection.close();
      }
    };
  });
}

function cancelAllTransfers() {
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

async function startVoiceNote(event) {
  event.preventDefault();
  // Keep one recorder object alive until its onstop callback has completed.
  // MediaRecorder enters "inactive" before that callback is dispatched.
  if (recorder || !activeSession) return;
  if (peerCapabilities?.voice?.enabled !== true) {
    setStatus(t("unsupported_capability"), "error");
    return;
  }
  if (event.pointerId !== undefined) event.currentTarget?.setPointerCapture?.(event.pointerId);
  voicePointerHeld = true;
  const gesture = ++voiceGesture;
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // A permission prompt can outlive the press. If the user released while it
    // was visible, stop the newly granted stream without recording anything.
    if (!voicePointerHeld || gesture !== voiceGesture) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    recorder = new MediaRecorder(stream);
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
    recorder.onstop = () => finishVoiceNote(stream);
    recorder.start(1000);
    voiceLimitTimer = setTimeout(() => {
      if (recorder?.state === "recording") recorder.stop();
    }, APP_CONFIG.limits.voiceSeconds * 1000 - 250);
    $("ptt-btn").classList.add("recording");
    $("ptt-btn").textContent = "■";
    setStatus(t("voice_recording"), "loading");
    markActivity();
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    recorder = null;
    voicePointerHeld = false;
    setStatus(format("microphone_failed", { message: redact(error.message) }), "error");
    recordError(error);
  }
}

function stopVoiceNote(event) {
  event?.preventDefault();
  voicePointerHeld = false;
  voiceGesture += 1;
  if (recorder?.state === "recording") recorder.stop();
}

function cancelVoiceNote() {
  voicePointerHeld = false;
  voiceGesture += 1;
  voiceCancelled = true;
  clearTimeout(voiceLimitTimer);
  if (recorder?.state === "recording") recorder.stop();
}

async function finishVoiceNote(stream) {
  clearTimeout(voiceLimitTimer);
  stream.getTracks().forEach((track) => track.stop());
  $("ptt-btn").classList.remove("recording");
  $("ptt-btn").textContent = "●";
  const finishedRecorder = recorder;
  recorder = null;
  const duration = Math.max(1, Math.min(
    APP_CONFIG.limits.voiceSeconds,
    Math.ceil((performance.now() - voiceStartedAt) / 1000),
  ));
  if (voiceCancelled) {
    voiceChunks = [];
    return;
  }
  if (discardVoice || voiceBytes > APP_CONFIG.limits.voiceBytes) {
    voiceChunks = [];
    setStatus(t("voice_limit"), "error");
    return;
  }
  const blob = new Blob(voiceChunks, { type: safeMime(finishedRecorder.mimeType, "audio/") });
  voiceChunks = [];
  try {
    setStatus(t("voice_sending"), "loading");
    const payload = new Uint8Array(await blob.arrayBuffer());
    if (payload.length > APP_CONFIG.limits.voiceBytes) throw new Error(t("voice_limit"));
    const messageId = randomID();
    const response = await sendChatEnvelopeTo(activePeerAddress, sessionMeta("VOICE", {
      messageId, mime: safeMime(blob.type, "audio/"), duration,
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

async function receiveVoice(connection) {
  try {
    const maximum = APP_CONFIG.limits.voiceBytes + APP_CONFIG.limits.controlBytes + 8;
    const bytes = await readAllBounded(
      connection,
      maximum,
      STREAM_READ_TIMEOUT_MS,
      APP_CONFIG.limits.voiceSeconds * 1000 + STREAM_READ_TIMEOUT_MS,
    );
    const { meta, payload } = unpackChatEnvelope(bytes);
    if (meta.type !== "VOICE"
      || !hasSession(meta)
      || typeof meta.messageId !== "string"
      || meta.messageId.length !== 32
      || payload.length > APP_CONFIG.limits.voiceBytes
      || !Number.isFinite(meta.duration)
      || meta.duration < 0
      || meta.duration > APP_CONFIG.limits.voiceSeconds) throw new Error("voice message rejected");
    const blob = new Blob([payload], { type: safeMime(meta.mime, "audio/") });
    addMessage({ type: "voice", blob, duration: meta.duration, mine: false });
    await connection.write(packChatEnvelope(sessionMeta("VOICE_ACK", { messageId: meta.messageId })));
    await connection.closeWrite();
    setStatus(t("message_received"), "connected");
    noteAuthenticatedPeerTraffic();
  } catch (error) {
    recordError(error);
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
      setMediaStatus(t("call_live"));
      beginLiveActivity();
    }
    if (["failed", "closed"].includes(connection.connectionState)) endLiveLink(false, t("call_ended"));
  };
  return connection;
}

function openMediaDock(mode) {
  $("app").classList.add("media-open");
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
  return navigator.mediaDevices.getUserMedia({ audio: true, video: mode === "video" });
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
      : await navigator.mediaDevices.getUserMedia({ audio: true, video: offer.mode === "video" });
    if (generation !== liveGeneration) {
      stopMediaStream(stream);
      return;
    }
    localMediaStream = stream;
    $("local-media").srcObject = localMediaStream;
    $("local-media").classList.toggle("hidden", !localMediaStream?.getVideoTracks().length);
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

async function endLiveLink(notifyPeer = false, message = "") {
  liveGeneration += 1;
  clearTimeout(callSetupTimer);
  callSetupTimer = null;
  clearInterval(liveActivityTimer);
  liveActivityTimer = null;
  const endedCallId = currentCallId || pendingCallOffer?.callId || "";
  currentCallId = "";
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
  setMediaStatus(message || t("call_ended"));
  if (notifyPeer && hadLink && activeSession && endedCallId) {
    await sendControl("RTC_HANGUP", { callId: endedCallId }).catch(() => {});
  }
}

// ---- QR, clipboard, and UI bindings ------------------------------------

function drawInviteQR(value) {
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

$("persist-key").addEventListener("change", () => {
  $("persist-risk").classList.toggle("hidden", !$("persist-key").checked);
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
$("copy-addr").addEventListener("click", () => copyWithFeedback($("copy-addr"), localAddress, "copy_address"));
$("show-qr").addEventListener("click", () => {
  try {
    drawInviteQR(inviteURL(localAddress));
    $("qr-dialog").showModal();
  } catch (error) {
    recordError(error);
    setStatus(format("generic_error", { message: redact(error.message) }), "error");
  }
});
$("qr-close").addEventListener("click", () => $("qr-dialog").close());
$("qr-dialog").addEventListener("click", (event) => { if (event.target === $("qr-dialog")) $("qr-dialog").close(); });
$("send-text-btn").addEventListener("click", sendText);
$("send-text").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
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
  if (activeSession) $("drop-zone").classList.remove("hidden");
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

$("ptt-btn").addEventListener("pointerdown", startVoiceNote);
window.addEventListener("pointerup", stopVoiceNote);
window.addEventListener("pointercancel", stopVoiceNote);
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
$("media-expand").addEventListener("click", () => {
  const expanded = $("media-dock").classList.toggle("expanded");
  $("media-expand").textContent = expanded ? "▣" : "□";
  $("media-expand").title = expanded ? t("collapse") : t("expand");
});

window.addEventListener("beforeunload", () => {
  listener?.close();
  activeFileTransfer?.connection?.close();
  activeFileTransfer?.entry?.connection?.close();
});

window.addEventListener("hashchange", () => {
  const address = consumeInviteFragment();
  if (support.ok && address) connectToPeer(address);
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
  const results = {
    fragment: inviteURL(`tc${"a".repeat(64)}`).includes("#v=1&invite=") && location.hash === "",
    "frame-boundaries": equalBytes(magic, TCF_MAGIC) && data.payload.length === 3 && data.payload[2] === 99 && decodedOffer.name === "safe.txt" && final.size === 3,
    "file-name": sanitizeFileName("../bad\\name\u0000.txt") === "name.txt",
    "file-sizes": validFileSize(APP_CONFIG.limits.fileBytes) && !validFileSize(APP_CONFIG.limits.fileBytes + 1),
    sha256: digest === expected && data.payload.length === 3,
    "session-lock": sessionMatches({ v: APP_CONFIG.protocolVersion, session }, session)
      && !sessionMatches({ v: APP_CONFIG.protocolVersion, session: "2".repeat(32) }, session),
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

tcTest.runProtocolSelfTests = protocolSelfTest;
tcTest.runProtocolSelfTest = protocolSelfTest;

async function bootstrap() {
  $("app").setAttribute("aria-busy", "true");
  await loadRememberedKey();
  if (!APP_CONFIG.roomsEnabled) {
    pendingInviteAddress = "";
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
  await protocolSelfTest();
  if (pendingInviteAddress) {
    const address = pendingInviteAddress;
    pendingInviteAddress = "";
    $("send-addr").value = address;
    await connectToPeer(address);
  } else if (new URLSearchParams(location.search).get("mode") === "listen") {
    await startRoom();
  }
}
