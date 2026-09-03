import { APP_CONFIG, defaultRegionCode, regionByCode } from "./config.js";
import {
  FILE_SINK_KIND,
  FILE_SINK_REASON,
  createFileSink,
  getReceiveCapacity,
  initializeFileSinks,
  probeFileSinkSupport,
} from "./file-sinks.js";
import { createI18n } from "./i18n.js";
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
const HANDSHAKE_CANCEL_TIMEOUT_MS = 5_000;
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
const MAGICKSOCK_WEBRTC = APP_CONFIG.experimental.magicsockWebRTC;
const TRANSPORT_PATHS = Object.freeze(["unknown", "derp", "webrtc"]);
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
  // Laboratory links must stay on the dedicated experiment deployment. A
  // canonical production link could join a build running a different
  // experimental wire implementation.
  const origin = MAGICKSOCK_WEBRTC.enabled ? location.origin : CANONICAL_ORIGIN;
  const url = new URL("/", origin);
  url.hash = new URLSearchParams({ v: String(APP_CONFIG.protocolVersion), invite: address }).toString();
  return url.toString();
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
  version: APP_CONFIG.version,
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
    localPath: "unknown",
    peerPath: "unknown",
    bilateralPath: "unknown",
    localPathRevision: 0,
    peerPathRevision: 0,
    persistentTransport: false,
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

let persistenceAvailable = typeof globalThis.indexedDB !== "undefined";
let fileSinkSupport = Object.freeze({
  preferredKind: null,
  maxBytes: 0,
  picker: Object.freeze({ supported: false, maxBytes: 0 }),
  opfs: Object.freeze({ supported: false, receivable: false, maxBytes: 0, reason: FILE_SINK_REASON.NO_SINK }),
});
let pageWasBackgrounded = false;
let resumeCheckInFlight = null;
const transferItemCleanups = new WeakMap();
const stagedTransferItems = new Set();
const wakeLocks = createScreenWakeLockManager({ onError: recordError });
const visualViewportSync = syncVisualViewportCSSVariables();

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

function validFileSize(size) {
  return Number.isSafeInteger(size) && size >= 0 && size <= APP_CONFIG.limits.fileBytes;
}

function setStatus(message, state = "loading") {
  $("status").textContent = message;
  $("status-dot").className = `status-dot ${state}`;
}

function setMobileSheet(open) {
  const hasRoomControls = Boolean(activeSession || stagedTransferItems.size);
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

function renderExperimentDisclosure() {
  const enabled = MAGICKSOCK_WEBRTC.enabled;
  $("experiment-pill").classList.toggle("hidden", !enabled);
  $("experiment-banner").classList.toggle("hidden", !enabled);
  $("experiment-version").textContent = enabled ? APP_CONFIG.version : "";
  $("encryption-note").textContent = t(enabled ? "encryption_note_experiment" : "encryption_note");
}

function applyLanguage(language) {
  i18n.setLanguage(language);
  $("language-select").value = i18n.language;
  $("blocked-language-select").value = i18n.language;
  rebuildRegions();
  renderConnectionState();
  renderTransportPaths();
  renderRuntimeCapabilityNote();
  renderExperimentDisclosure();
  if (support.mobile) {
    $("ptt-btn").title = t("voice_tap_start");
    $("ptt-btn").setAttribute("aria-label", t("voice_tap_start"));
  }
  updateMediaControls();
}

i18n.apply();
renderExperimentDisclosure();
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
  $("blocked-invite-copy").classList.toggle("hidden", !pendingInviteAddress);
  $("copy-blocked-invite").addEventListener("click", () => {
    if (pendingInviteAddress) {
      void copyWithFeedback($("copy-blocked-invite"), inviteURL(pendingInviteAddress), "copy_preserved_invite");
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

let outboundPeerTransport = null;

function persistentTransportEnabled() {
  return MAGICKSOCK_WEBRTC.enabled && typeof globalThis.tailcatConnect === "function";
}

function persistentTransportAddress() {
  return activePeerAddress || pendingPeerAddress || pendingInboundHandshake?.replyTo || "";
}

function closeOutboundPeerTransport(address = "") {
  const slot = outboundPeerTransport;
  if (!slot || (address && slot.address !== address)) return;
  outboundPeerTransport = null;
  slot.closed = true;
  slot.controller.abort();
  try {
    slot.client?.close();
  } catch (error) {
    recordError(error);
  }
  if (!slot.client) {
    void slot.promise?.then((client) => {
      try {
        client.close();
      } catch (error) {
        recordError(error);
      }
    }, () => {});
  }
  tcTest.state.persistentTransport = false;
}

async function getOutboundPeerTransport(address) {
  if (!persistentTransportEnabled()) return null;
  const normalized = String(address || "");
  if (!normalized || normalized !== persistentTransportAddress()) return null;
  if (outboundPeerTransport?.address === normalized && !outboundPeerTransport.closed) {
    return outboundPeerTransport.promise;
  }
  closeOutboundPeerTransport();
  const slot = {
    address: normalized,
    client: null,
    closed: false,
    controller: new AbortController(),
    promise: null,
  };
  outboundPeerTransport = slot;
  slot.promise = Promise.resolve(globalThis.tailcatConnect({
    addr: normalized,
    derpMapURL: APP_CONFIG.derpMapURL,
    signal: slot.controller.signal,
  })).then((client) => {
    if (!client || typeof client.dial !== "function" || typeof client.status !== "function" || typeof client.close !== "function") {
      throw new Error("tailcatConnect returned an invalid client");
    }
    if (slot.closed || outboundPeerTransport !== slot) {
      client.close();
      throw new Error("peer transport was closed while connecting");
    }
    slot.client = client;
    tcTest.state.persistentTransport = true;
    return client;
  }).catch((error) => {
    if (outboundPeerTransport === slot) outboundPeerTransport = null;
    tcTest.state.persistentTransport = false;
    throw error;
  });
  return slot.promise;
}

async function dialPeerStream(address, port) {
  const persistent = await getOutboundPeerTransport(address);
  if (persistent) return persistent.dial({ port });
  return globalThis.tailcatDial({
    addr: address,
    derpMapURL: APP_CONFIG.derpMapURL,
    port,
  });
}

async function sendChatEnvelopeTo(address, meta, payload, port, responseTimeoutMs = STREAM_READ_TIMEOUT_MS) {
  const connection = await dialPeerStream(address, port);
  try {
    await writeChunked(connection, packChatEnvelope(meta, payload));
    await connection.closeWrite();
    return await readAllBounded(connection, 1024, responseTimeoutMs);
  } finally {
    connection.close();
  }
}

async function sendLegacyChatEnvelopeTo(address, meta, payload, port, responseTimeoutMs) {
  // Handshake cancellation must not depend on the persistent Client it is
  // cancelling. A separate one-shot dial lets room teardown abort that Client
  // immediately without racing the best-effort HELLO_CANCEL notification.
  const connection = await globalThis.tailcatDial({
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
let pathProbeTimer = null;
let pathProbeGeneration = 0;
let pathProbeStartedAt = 0;
let localTransportPath = "unknown";
let peerTransportPath = "unknown";
let localPathRevision = 0;
let peerPathRevision = 0;
let lastAnnouncedTransportPath = "";

function supportsAuthenticatedPathStatus(capabilities = peerCapabilities) {
  return persistentTransportEnabled()
    && capabilities?.transport?.magicsockWebRTC === true
    && capabilities.transport.pathStatus === MAGICKSOCK_WEBRTC.pathStatusVersion;
}

function normalizeTransportPath(value) {
  const path = String(value || "unknown");
  return TRANSPORT_PATHS.includes(path) ? path : "unknown";
}

function transportPathLabel(path) {
  const keys = {
    unknown: "path_unknown",
    derp: "path_derp",
    webrtc: "path_webrtc",
    unsupported: "path_unsupported",
  };
  return t(keys[path] || keys.unknown);
}

function renderTransportPaths() {
  const connected = Boolean(activeSession && activePeerAddress);
  $("transport-paths").classList.toggle("hidden", !connected);
  const peerSupportsStatus = connected && supportsAuthenticatedPathStatus();
  const visiblePeerPath = peerSupportsStatus ? peerTransportPath : "unsupported";
  const localLabel = $("local-path-label");
  const peerLabel = $("peer-path-label");
  localLabel.dataset.path = localTransportPath;
  peerLabel.dataset.path = visiblePeerPath;
  localLabel.textContent = transportPathLabel(localTransportPath);
  peerLabel.textContent = transportPathLabel(visiblePeerPath);

  let bilateral = "unknown";
  let note = "";
  if (connected && !peerSupportsStatus) {
    bilateral = "legacy";
    note = t("path_peer_legacy");
  } else if (localTransportPath === "webrtc" && peerTransportPath === "webrtc") {
    bilateral = "webrtc";
    note = t("path_bilateral_direct");
  } else if (localTransportPath === "derp" && peerTransportPath === "derp") {
    bilateral = "derp";
  } else if (connected && (localTransportPath !== "unknown" || peerTransportPath !== "unknown")) {
    bilateral = "mixed";
    note = t("path_mixed");
  }
  const noteElement = $("transport-path-note");
  noteElement.textContent = note;
  noteElement.classList.toggle("hidden", !note);
  tcTest.state.localPath = localTransportPath;
  tcTest.state.peerPath = visiblePeerPath;
  tcTest.state.bilateralPath = bilateral;
  tcTest.state.localPathRevision = localPathRevision;
  tcTest.state.peerPathRevision = peerPathRevision;
}

function stopTransportPathProbes({ reset = true } = {}) {
  clearTimeout(pathProbeTimer);
  pathProbeTimer = null;
  pathProbeGeneration += 1;
  pathProbeStartedAt = 0;
  if (reset) {
    localTransportPath = "unknown";
    peerTransportPath = "unknown";
    localPathRevision = 0;
    peerPathRevision = 0;
    lastAnnouncedTransportPath = "";
  }
  renderTransportPaths();
}

async function announceTransportPath(generation, session, address) {
  if (!supportsAuthenticatedPathStatus()
    || generation !== pathProbeGeneration
    || session !== activeSession
    || address !== activePeerAddress) return;
  if (lastAnnouncedTransportPath === localTransportPath) return;
  localPathRevision += 1;
  renderTransportPaths();
  await sendControl("PATH_STATUS", {
    revision: localPathRevision,
    path: localTransportPath,
  });
  if (generation === pathProbeGeneration && session === activeSession && address === activePeerAddress) {
    lastAnnouncedTransportPath = localTransportPath;
  }
}

function scheduleTransportPathProbe(generation, index) {
  if (generation !== pathProbeGeneration || !activeSession || !activePeerAddress) return;
  const delays = MAGICKSOCK_WEBRTC.probeDelaysMs;
  const delay = index < delays.length
    ? Math.max(0, delays[index] - (Date.now() - pathProbeStartedAt))
    : MAGICKSOCK_WEBRTC.steadyProbeIntervalMs;
  pathProbeTimer = setTimeout(async () => {
    if (generation !== pathProbeGeneration || !activeSession || !activePeerAddress) return;
    const session = activeSession;
    const address = activePeerAddress;
    try {
      try {
        const client = await getOutboundPeerTransport(address);
        if (!client) {
          localTransportPath = "derp";
        } else {
          const status = await client.status({ timeoutMs: MAGICKSOCK_WEBRTC.statusTimeoutMs });
          localTransportPath = normalizeTransportPath(status?.path);
        }
      } catch (_) {
        localTransportPath = "unknown";
      }
      if (generation === pathProbeGeneration && session === activeSession && address === activePeerAddress) {
        renderTransportPaths();
        await announceTransportPath(generation, session, address).catch(() => {});
      }
    } finally {
      if (generation === pathProbeGeneration && session === activeSession && address === activePeerAddress) {
        scheduleTransportPathProbe(generation, index + 1);
      }
    }
  }, delay);
}

function startTransportPathProbes({ reset = true, forceAnnounce = false } = {}) {
  stopTransportPathProbes({ reset });
  if (!activeSession || !activePeerAddress) return;
  if (!persistentTransportEnabled()) {
    // The v0.4 browser bridge has no raw UDP path. Its legacy dial API is a
    // known DERP path, while an older peer cannot authenticate a path report.
    localTransportPath = "derp";
    renderTransportPaths();
    return;
  }
  if (forceAnnounce) lastAnnouncedTransportPath = "";
  const generation = pathProbeGeneration;
  pathProbeStartedAt = Date.now();
  renderTransportPaths();
  scheduleTransportPathProbe(generation, 0);
}

function receiveTransportPathStatus(meta) {
  if (!supportsAuthenticatedPathStatus()
    || !Number.isSafeInteger(meta.revision)
    || meta.revision <= peerPathRevision
    || meta.revision < 1) return;
  const path = normalizeTransportPath(meta.path);
  if (path === "unknown" && meta.path !== "unknown") return;
  peerPathRevision = meta.revision;
  peerTransportPath = path;
  renderTransportPaths();
}

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
  const capabilities = {
    text: { maxBytes: APP_CONFIG.limits.textBytes },
    file: {
      protocol: "TCF1",
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
  if (persistentTransportEnabled()) {
    capabilities.transport = {
      magicsockWebRTC: true,
      pathStatus: MAGICKSOCK_WEBRTC.pathStatusVersion,
    };
  }
  return capabilities;
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
        // Keep revisions monotonic for the lifetime of this authenticated
        // session. A foreground check restarts polling, not the protocol.
        startTransportPathProbes({ reset: false, forceAnnounce: true });
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
  if (support.mobile && (activeSession || activeFileTransfer || recorder || peerConnection || handshakeWaiter)) {
    $("background-risk").classList.remove("hidden");
  }
}

function resumeForegroundSession() {
  if (!pageWasBackgrounded) return;
  pageWasBackgrounded = false;
  void wakeLocks.request();
  if (activeSession) void verifySessionAfterResume();
  else $("background-risk").classList.add("hidden");
}

function clearPeer() {
  cancelActiveVoiceRecording();
  stopPeerHeartbeat();
  lastAuthenticatedPeerTrafficAt = 0;
  const previousAddress = activePeerAddress || pendingPeerAddress || pendingInboundHandshake?.replyTo || "";
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
  stopTransportPathProbes();
  closeOutboundPeerTransport(previousAddress);
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
  if (listener) return listener;
  if (listenerStarting) return listenerStarting;
  stoppedForIdle = false;
  $("listen-btn").disabled = true;
  $("region-select").disabled = true;
  $("persist-key").disabled = true;
  setStatus(t("status_starting"), "loading");
  setMobileState("connecting");
  tcTest.state.room = "starting";
  listenerStarting = (async () => {
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
      localAddress = created.addr;
      tcTest.listenAddr = created.addr;
      tcTest.state.room = "open";
      $("listen-addr").textContent = created.addr;
      $("listen-info").classList.remove("hidden");
      $("listen-btn").classList.add("hidden");
      $("stop-listen-btn").classList.remove("hidden");
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
    const notify = sendControl("SESSION_END", { reason: idle ? "IDLE" : "CLOSED" }).catch(() => {});
    // A persistent Client is closed with the room. Give the already-open path
    // one bounded opportunity to deliver SESSION_END before tearing it down.
    await Promise.race([
      notify,
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
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
  $("persist-key").disabled = !persistenceAvailable;
  clearPeer();
  setMobileState(restingMobileState());
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
  startTransportPathProbes();
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
  void sendLegacyChatEnvelopeTo(confirm.address, {
    type: "HELLO_CANCEL",
    v: APP_CONFIG.protocolVersion,
    replyTo: confirm.replyTo,
    nonce: confirm.nonce,
    session: confirm.session,
  }, new Uint8Array(), APP_CONFIG.ports.control, HANDSHAKE_CANCEL_TIMEOUT_MS).catch(() => {});
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
    closeOutboundPeerTransport(normalized);
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
    if (meta.type === "PATH_STATUS") {
      receiveTransportPathStatus(meta);
      noteAuthenticatedPeerTraffic();
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

function clearPendingInboundHandshake(candidate = null, { preserveTransport = false } = {}) {
  if (!pendingInboundHandshake || (candidate && pendingInboundHandshake !== candidate)) return;
  const address = pendingInboundHandshake.replyTo;
  clearTimeout(pendingInboundHandshake.timer);
  pendingInboundHandshake = null;
  if (!preserveTransport && !activeSession && !pendingPeerAddress) {
    closeOutboundPeerTransport(address);
  }
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
  clearPendingInboundHandshake(candidate, { preserveTransport: true });
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

addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  for (const message of renderedMessages) {
    if (!message.objectURL) continue;
    URL.revokeObjectURL(message.objectURL);
    message.objectURL = "";
  }
});

// ---- TCF1 streaming file protocol --------------------------------------

let activeFileTransfer = null;
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
    removed?.remove();
    removableCount -= 1;
    if (!activeSession) setMobileState(restingMobileState());
  }
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
    connection = await dialPeerStream(address, APP_CONFIG.ports.file);
    entry.connection = connection;
    if (entry.cancelled) throw new Error(t("file_cancelled"));
    const reader = new ConnectionReader(connection, FILE_DECISION_TIMEOUT_MS + 10_000);
    hasher = tailcatNewSHA256();
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
  const reader = new ConnectionReader(connection);
  await wakeLocks.acquire("file-transfer");
  try {
    const magic = await reader.readExact(4);
    if (!equalBytes(magic, TCF_MAGIC)) throw new Error("invalid TCF1 preamble");
    offer = decodeFileJSON(await readFileFrame(reader), [FILE_FRAME.META]);
    if (offer.type !== "OFFER"
      || offer.v !== APP_CONFIG.protocolVersion
      || !hasSession(offer)
      || typeof offer.transferId !== "string"
      || !/^[0-9a-f]{32}$/u.test(offer.transferId)
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
    activeFileTransfer = { direction: "incoming", connection, transferId: offer.transferId, cancelled: false, sink: null };
    await refreshFileSinkSupport();
    const sinkKind = fileSinkSupport.preferredKind;
    const capacity = await getReceiveCapacity(offer.size, {
      kind: sinkKind,
      hardMaxBytes: APP_CONFIG.limits.fileBytes,
    });
    if (!capacity.ok) {
      await connection.write(packFileJSON(FILE_FRAME.META, {
        type: "REJECT", v: APP_CONFIG.protocolVersion, session: activeSession,
        transferId: offer.transferId, reason: capacity.reason || FILE_SINK_REASON.NO_SINK,
      }));
      const key = capacity.reason === FILE_SINK_REASON.INSUFFICIENT_SPACE
        || capacity.reason === FILE_SINK_REASON.NO_STORAGE_ESTIMATE
        ? "file_space_insufficient"
        : "file_receive_unavailable";
      setStatus(t(key), "error");
      return;
    }

    tcTest.state.file = "offered";
    ui = createIncomingTransferItem(offer);
    const decision = await waitForIncomingFileDecision(ui, offer, connection, sinkKind);
    if (!decision.accepted) return;
    sink = decision.sink;
    activeFileTransfer.sink = sink;
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
        await sink.write(frame.payload);
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
      await sink.close();
      let stagedExport = null;
      if (sink.kind === FILE_SINK_KIND.OPFS_EXPORT) stagedExport = await sink.prepareExport();
      localArtifactReady = true;
      const doneFrame = packFileJSON(FILE_FRAME.FINAL, {
        type: "DONE", v: APP_CONFIG.protocolVersion, session: activeSession,
        transferId: offer.transferId, size: received, sha256: digest,
      });
      terminalWriteStarted = true;
      let confirmationError = null;
      try {
        await connection.write(doneFrame);
        completed = true;
      } catch (error) {
        // A transport may report an error after the complete DONE frame was
        // handed to its peer. Preserve the already verified local artifact,
        // but do not claim that the sender received the confirmation.
        confirmationError = error;
        recordError(error);
      }
      if (completed) {
        // The sender treats the DONE frame itself as terminal and does not wait
        // for EOF, so a half-close failure must never roll back a saved file.
        try {
          await connection.closeWrite();
        } catch (error) {
          recordError(error);
        }
      }
      tcTest.recvSha256 = digest;
      tcTest.recvDone = completed;
      ui.progress.value = 1;
      ui.cancel.classList.add("hidden");
      if (stagedExport) {
        configureStagedFileUI(ui, sink, stagedExport);
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
      addMessage({ type: "file", mine: false, name: offer.name, size: offer.size, status });
      setStatus(status, confirmationError ? "error" : "connected");
      break;
    }
  } catch (error) {
    const preserveVerifiedSink = localArtifactReady && terminalWriteStarted;
    if (sink && !completed && !preserveVerifiedSink) {
      try {
        if (sink.state === "closed") await sink.remove();
        else await sink.abort();
      } catch (_) {}
      sink = null;
    }
    if (accepted && offer && activeSession && !terminalWriteStarted) {
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
    const preserveVerifiedSink = localArtifactReady && terminalWriteStarted;
    if (!completed && sink && !preserveVerifiedSink) {
      try {
        if (sink.state === "closed") await sink.remove();
        else await sink.abort();
      } catch (_) {}
    }
    hasher?.close();
    connection.close();
    if (activeFileTransfer?.connection === connection) activeFileTransfer = null;
    finishTransferItem(ui);
    tcTest.state.file = "idle";
    await wakeLocks.release("file-transfer");
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
  const exportFile = fragment.querySelector(".export-file");
  const deleteFile = fragment.querySelector(".delete-file");
  const localNote = fragment.querySelector(".transfer-local-note");
  name.textContent = `${t("file_offer")}: ${offer.name}`;
  detail.textContent = format("file_offer_detail", { name: offer.name, size: humanSize(offer.size) });
  save.textContent = fileSinkSupport.preferredKind === FILE_SINK_KIND.OPFS_EXPORT ? t("accept_receive") : t("choose_save");
  reject.textContent = t("reject");
  cancel.textContent = t("cancel");
  exportFile.textContent = t("file_export");
  deleteFile.textContent = t("file_delete_local");
  $("transfer-list").append(fragment);
  renderTransferCount();
  return { item, name, detail, progress, save, reject, cancel, export: exportFile, delete: deleteFile, localNote };
}

function waitForIncomingFileDecision(ui, offer, connection, sinkKind) {
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
        const sink = await createFileSink({
          kind: sinkKind,
          transferId: offer.transferId,
          name: offer.name,
          size: offer.size,
          mime: offer.mime,
          hardMaxBytes: APP_CONFIG.limits.fileBytes,
        });
        if (!claim()) {
          try { await sink.abort(); } catch (_) {}
          return;
        }
        finish({ accepted: true, sink });
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

function configureStagedFileUI(ui, sink, prepared) {
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
      ui.export.onclick = null;
      ui.delete.onclick = null;
      transferItemCleanups.delete(ui.item);
      stagedTransferItems.delete(ui.item);
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
  transferItemCleanups.set(ui.item, removeTemporaryFile);
  ui.export.classList.remove("hidden");
  ui.delete.classList.remove("hidden");
  ui.export.onclick = () => {
    ui.export.disabled = true;
    if (useDownloadFallback) {
      try {
        prepared.download();
        ui.detail.textContent = t("file_download_started");
        ui.localNote.textContent = t("file_delete_after_download");
      } catch (error) {
        setStatus(t("share_failed"), "error");
        recordError(error);
      } finally {
        ui.export.disabled = false;
      }
      return;
    }
    void prepared.share().then(async () => {
      ui.detail.textContent = t("file_exported");
      ui.export.classList.add("hidden");
      try {
        await removeTemporaryFile();
        ui.localNote.classList.add("hidden");
        ui.delete.classList.add("hidden");
      } catch (error) {
        ui.delete.disabled = false;
        ui.localNote.textContent = t("file_cleanup_failed");
        setStatus(t("file_cleanup_failed"), "error");
        recordError(error);
      }
    }).catch(async (error) => {
      ui.export.disabled = false;
      if (error?.name === "AbortError") {
        try {
          await removeTemporaryFile();
          ui.detail.textContent = t("file_local_deleted");
          ui.localNote.classList.add("hidden");
          ui.export.classList.add("hidden");
          ui.delete.classList.add("hidden");
        } catch (cleanupError) {
          ui.delete.disabled = false;
          ui.localNote.classList.remove("hidden");
          ui.localNote.textContent = t("file_cleanup_failed");
          setStatus(t("file_cleanup_failed"), "error");
          recordError(cleanupError);
        }
        return;
      }
      useDownloadFallback = true;
      ui.detail.textContent = t("file_share_download_fallback");
      ui.localNote.textContent = t("file_delete_after_download");
      setStatus(t("file_share_download_fallback"), "error");
      recordError(error);
    });
  };
  ui.delete.onclick = () => {
    ui.delete.disabled = true;
    void removeTemporaryFile().then(() => {
      ui.detail.textContent = t("file_local_deleted");
      ui.localNote.classList.add("hidden");
      ui.export.classList.add("hidden");
      ui.delete.classList.add("hidden");
    }).catch((error) => {
      ui.delete.disabled = false;
      setStatus(t("file_cleanup_failed"), "error");
      recordError(error);
    });
  };
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
let activeVoiceStream = null;
const voiceHoldMode = !support.mobile;

async function startVoiceNote(event) {
  event.preventDefault();
  // Keep one recorder object alive until its onstop callback has completed.
  // MediaRecorder enters "inactive" before that callback is dispatched.
  if (recorder || !activeSession) return;
  if (peerCapabilities?.voice?.enabled !== true) {
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
    const mimeType = selectedVoiceRecordType();
    if (!mimeType) throw new Error(t("unsupported_capability"));
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
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
    $("ptt-btn").textContent = "■";
    $("mobile-recording-controls")?.classList.remove("hidden");
    setStatus(t(voiceHoldMode ? "voice_recording" : "voice_tap_stop"), "loading");
    markActivity();
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    if (activeVoiceStream === stream) activeVoiceStream = null;
    recorder = null;
    voicePointerHeld = false;
    await wakeLocks.release("voice-note");
    setStatus(format("microphone_failed", { message: redact(error.message) }), "error");
    recordError(error);
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
  $("ptt-btn").textContent = "●";
  $("mobile-recording-controls")?.classList.add("hidden");
  const finishedRecorder = recorder;
  recorder = null;
  const duration = Math.max(1, Math.min(
    APP_CONFIG.limits.voiceSeconds,
    Math.ceil((performance.now() - voiceStartedAt) / 1000),
  ));
  if (voiceCancelled) {
    voiceChunks = [];
    setStatus(t("voice_discarded"), activeSession ? "connected" : "ready");
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
    const mime = safeVoiceMime(meta.mime);
    if (meta.type !== "VOICE"
      || !hasSession(meta)
      || typeof meta.messageId !== "string"
      || meta.messageId.length !== 32
      || payload.length > APP_CONFIG.limits.voiceBytes
      || !mime
      || !Number.isFinite(meta.duration)
      || meta.duration < 0
      || meta.duration > APP_CONFIG.limits.voiceSeconds) throw new Error("voice message rejected");
    const blob = new Blob([payload], { type: mime });
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
  $("media-expand").textContent = expanded ? "▣" : "□";
  $("media-expand").title = expanded ? t("collapse") : t("expand");
});

window.addEventListener("beforeunload", () => {
  stopTransportPathProbes();
  closeOutboundPeerTransport();
  listener?.close();
  activeFileTransfer?.connection?.close();
  activeFileTransfer?.entry?.connection?.close();
  void wakeLocks.cleanup();
  visualViewportSync.cleanup();
});

subscribePageLifecycle({
  hidden: () => {
    notePageBackgrounded();
    stopTransportPathProbes({ reset: false });
  },
  freeze: () => {
    notePageBackgrounded();
    stopTransportPathProbes({ reset: false });
  },
  visible: resumeForegroundSession,
  resume: resumeForegroundSession,
  pagehide: ({ persisted }) => {
    notePageBackgrounded();
    if (!persisted) {
      stopTransportPathProbes();
      closeOutboundPeerTransport();
      listener?.close();
      activeFileTransfer?.connection?.close();
      activeFileTransfer?.entry?.connection?.close();
    } else {
      stopTransportPathProbes({ reset: false });
    }
  },
  pageshow: resumeForegroundSession,
});

window.addEventListener("hashchange", () => {
  const address = consumeInviteFragment();
  if (!address) return;
  if (support.ok) {
    void connectToPeer(address);
  } else {
    pendingInviteAddress = address;
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

async function configureDataTransport() {
  const enabled = MAGICKSOCK_WEBRTC.enabled;
  const configure = globalThis.tailcatConfigureTransport;
  if (typeof configure !== "function") {
    if (enabled) throw new Error("this WASM build does not expose WebRTC transport configuration");
    tcTest.runtime.magicsockWebRTC = false;
    return;
  }
  const stunURLs = APP_CONFIG.rtc.iceServers.flatMap(({ urls }) => (
    Array.isArray(urls) ? urls : [urls]
  )).filter((url) => typeof url === "string" && url.startsWith("stun:"));
  if (enabled && stunURLs.length === 0) throw new Error("WebRTC data transport requires an explicit STUN URL");
  const applied = await configure({
    webRTC: {
      enabled,
      stunURLs,
    },
  });
  if (enabled && (applied?.webRTC?.compiled !== true || applied.webRTC.enabled !== true)) {
    throw new Error("the WASM build did not enable the requested WebRTC transport");
  }
  if (enabled && typeof globalThis.AbortController !== "function") {
    throw new Error("this browser cannot cancel persistent Tailcat clients");
  }
  if (enabled && typeof globalThis.tailcatConnect !== "function") {
    throw new Error("this WASM build does not expose persistent Tailcat clients");
  }
  tcTest.runtime.magicsockWebRTC = enabled;
  tcTest.runtime.transportConfiguration = {
    compiled: applied?.webRTC?.compiled === true,
    enabled: applied?.webRTC?.enabled === true,
    stunURLs: Array.isArray(applied?.webRTC?.stunURLs) ? [...applied.webRTC.stunURLs] : [],
  };
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
  await Promise.all([probePersistence(), refreshFileSinkSupport()]);
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
  await configureDataTransport();
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
