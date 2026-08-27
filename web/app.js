// Tailcatchat: a no-build, plain JavaScript UI over Tailcat's WebAssembly API.
// Each chat item gets its own encrypted Tailcat TCP stream. Port 1 remains the
// netcat-compatible stream used by the original demo; ports 101-103 carry the
// tiny Tailcatchat envelope used for text, files, and voice notes.

const CHUNK = 64 * 1024;
const KEY_STORAGE = "tailcat-web-key";
const CONTROL_PORT = 100;
const CHAT_PORT = 101;
const FILE_PORT = 102;
const VOICE_PORT = 103;
const MAGIC = new Uint8Array([0x54, 0x43, 0x48, 0x31]); // TCH1
const params = new URLSearchParams(location.search);
const verbose = params.has("verbose");
const canonicalDERPMapURL = "https://tailcat.dev/derpmap.json";

// Room addresses live in the URL fragment so browsers never include them in
// HTTP requests, access logs, or Referer headers. The canonical invite format
// is #invite=<url-encoded tc address>; a bare #tc… fragment is also accepted.
function inviteAddressFromHash() {
  const raw = location.hash.slice(1);
  if (!raw) return "";
  try {
    const fragment = new URLSearchParams(raw);
    const address = fragment.get("invite") || (raw.startsWith("tc") ? decodeURIComponent(raw) : "");
    return address?.startsWith("tc") ? address : "";
  } catch (_) {
    return "";
  }
}

function inviteURL(address) {
  const url = new URL(location.href);
  url.hash = new URLSearchParams({ invite: address }).toString();
  return url.toString();
}

async function pickDERPMapURL() {
  if (params.get("derpmap")) return new URL(params.get("derpmap"), location.href).toString();
  if (location.hostname.endsWith(".github.io")) return canonicalDERPMapURL;
  const sameOrigin = new URL("derpmap.json", location.href).toString();
  try {
    const resp = await fetch(sameOrigin, { method: "HEAD" });
    if (resp.ok) return sameOrigin;
  } catch (_) {}
  return canonicalDERPMapURL;
}
const derpMapURL = await pickDERPMapURL();

window.tcTest = {
  ready: false, listenAddr: null, recvBytes: 0, recvSha256: null,
  recvDone: false, sentBytes: 0, sentSha256: null, sendDone: false, errors: [],
};
window.addEventListener("error", (e) => window.tcTest.errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.tcTest.errors.push(String(e.reason)));

const $ = (id) => document.getElementById(id);
function setStatus(message, ready = false) {
  $("status").textContent = message;
  $("status-dot").classList.toggle("ready", ready);
}
function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
async function hex(digest) {
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(bytes) { return hex(await crypto.subtle.digest("SHA-256", bytes)); }

function countProgress(stream, total, wireBytes) {
  const ofMB = wireBytes > 0 ? ` of ${(wireBytes / (1 << 20)).toFixed(1)} MB` : "";
  const bar = $("load-progress");
  let loaded = 0;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      if (total > 0) {
        bar.value = loaded / total;
        setStatus(`Loading WebAssembly… ${Math.min(100, Math.floor(100 * loaded / total))}%${ofMB}`);
      }
      controller.enqueue(chunk);
    },
  }));
}

async function fetchWasm() {
  const gz = await fetch("main.wasm.gz");
  if (gz.ok) {
    const size = Number(gz.headers.get("Content-Length")) || 0;
    const wasm = countProgress(gz.body, size, size).pipeThrough(new DecompressionStream("gzip"));
    return new Response(wasm, { headers: { "Content-Type": "application/wasm" } });
  }
  const resp = await fetch("main.wasm");
  if (!resp.ok) throw new Error(`fetching main.wasm: ${resp.status}`);
  const total = Number(resp.headers.get("X-Uncompressed-Size")) || Number(resp.headers.get("Content-Length")) || 0;
  const wireBytes = Number(resp.headers.get("X-Compressed-Size")) || Number(resp.headers.get("Content-Length")) || 0;
  return new Response(countProgress(resp.body, total, wireBytes), { headers: { "Content-Type": "application/wasm" } });
}

const ready = new Promise((resolve) => { globalThis.onTailcatReady = resolve; });
const go = new Go();
WebAssembly.instantiateStreaming(fetchWasm(), go.importObject).then(({ instance }) => go.run(instance));
await ready;
window.tcTest.ready = true;
$("load-progress").remove();
setStatus("Ready", true);
$("listen-btn").disabled = false;
$("send-btn").disabled = false;
$("send-text-btn").disabled = false;

// ---- Room listener -------------------------------------------------------
let listenerPromise = null;
let localAddress = "";
async function startListener() {
  if (listenerPromise) return listenerPromise;
  $("listen-btn").disabled = true;
  setStatus("Starting encrypted room…");
  listenerPromise = (async () => {
    const persist = $("persist-key").checked;
    const privateKey = persist ? (localStorage.getItem(KEY_STORAGE) || "") : "";
    try {
      const listener = await tailcatListen({ derpMapURL, privateKey, verbose, onConnection });
      if (persist) localStorage.setItem(KEY_STORAGE, listener.privateKeyJSON);
      localAddress = listener.addr;
      $("listen-addr").textContent = listener.addr;
      $("listen-info").classList.remove("hidden");
      $("copy-invite").dataset.invite = inviteURL(listener.addr);
      $("listen-btn").textContent = "Room is open";
      setStatus("Listening securely", true);
      window.tcTest.listenAddr = listener.addr;
      $("send-text").focus();
      return listener;
    } catch (err) {
      listenerPromise = null;
      setStatus("Listen failed: " + err.message);
      window.tcTest.errors.push(String(err));
      $("listen-btn").disabled = false;
      throw err;
    }
  })();
  return listenerPromise;
}

function onConnection(conn) {
  if (params.get("sink") === "hash") return hashSink(conn);
  if (conn.port === CONTROL_PORT) {
    receiveControl(conn);
    return;
  }
  if (conn.port === CHAT_PORT || conn.port === FILE_PORT || conn.port === VOICE_PORT) {
    receiveChatItem(conn);
    return;
  }
  // Preserve port 1 as the original tailcat browser/CLI interop surface.
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.className = "btn small";
  btn.textContent = "Save incoming file…";
  const textBtn = document.createElement("button");
  textBtn.className = "btn small";
  textBtn.textContent = "Show as text";
  const progress = document.createElement("span");
  li.append(btn, " ", textBtn, " ", progress);
  $("incoming").append(li);
  const chose = () => { btn.disabled = true; textBtn.disabled = true; };
  textBtn.onclick = () => { chose(); receiveLegacyText(conn, li, progress); };
  btn.onclick = async () => {
    chose();
    try {
      const handle = await showSaveFilePicker({ suggestedName: "tailcat-download" });
      const writable = await handle.createWritable();
      let n = 0;
      for (let chunk; (chunk = await conn.read()) !== null;) {
        await writable.write(chunk); n += chunk.length; progress.textContent = humanSize(n);
      }
      await writable.close(); conn.close(); progress.textContent = `done, ${humanSize(n)}`;
    } catch (err) { conn.close(); progress.textContent = "failed: " + err.message; }
  };
}

async function readAll(conn, progress) {
  const chunks = [];
  let n = 0;
  for (let chunk; (chunk = await conn.read()) !== null;) {
    chunks.push(chunk); n += chunk.length;
    if (progress) progress.textContent = `${humanSize(n)} received`;
  }
  conn.close();
  const all = new Uint8Array(n);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return all;
}

async function receiveLegacyText(conn, li, progress) {
  try {
    const all = await readAll(conn, progress);
    const text = new TextDecoder().decode(all);
    const box = document.createElement("code");
    box.className = "recv-text"; box.textContent = text;
    const copy = document.createElement("button");
    copy.textContent = "Copy";
    copy.onclick = () => copyWithFeedback(copy, text, "Copy");
    li.append(box, copy); progress.textContent = `done, ${all.length} bytes`;
  } catch (err) { conn.close(); progress.textContent = "failed: " + err.message; }
}

async function receiveControl(conn) {
  try {
    const bytes = await readAll(conn);
    const { meta } = unpackEnvelope(bytes);
    if (meta.type === "hello" && connectToAddress(meta.replyTo)) {
      addMessage({ type: "system", text: "they're hear meow" });
      setStatus("Peer connected", true);
    } else if (meta.type === "rtc-offer") {
      await answerLiveLink(meta);
    } else if (meta.type === "rtc-answer" && peerConnection) {
      await peerConnection.setRemoteDescription(meta.description);
      setMediaStatus("live link connected");
    } else if (meta.type === "rtc-hangup") {
      endLiveLink(false);
      addMessage({ type: "system", text: "live link ended" });
    }
  } catch (err) {
    conn.close();
    setMediaStatus("live link error: " + err.message);
    window.tcTest.errors.push(String(err));
  }
}

async function receiveChatItem(conn) {
  try {
    const bytes = await readAll(conn);
    const { meta, payload } = unpackEnvelope(bytes);
    if (meta.type === "text") {
      addMessage({ type: "text", text: new TextDecoder().decode(payload), mine: false });
    } else if (meta.type === "voice") {
      addMessage({ type: "voice", blob: new Blob([payload], { type: meta.mime }), mine: false, duration: meta.duration });
    } else if (meta.type === "file") {
      addMessage({ type: "file", blob: new Blob([payload], { type: meta.mime }), name: meta.name, mine: false });
    }
    setStatus("Message received", true);
  } catch (err) {
    conn.close();
    setStatus("Could not read message: " + err.message);
    window.tcTest.errors.push(String(err));
  }
}

async function hashSink(conn) {
  const all = await readAll(conn);
  window.tcTest.recvBytes = all.length;
  window.tcTest.recvSha256 = await sha256Hex(all);
  window.tcTest.recvDone = true;
}

$("listen-btn").onclick = startListener;
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // Clipboard API is unavailable on some non-HTTPS origins and older
  // browsers. execCommand still works when called from this click gesture.
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  input.setSelectionRange(0, input.value.length);
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("copy command was rejected");
}

async function copyWithFeedback(button, text, idleLabel) {
  try {
    await copyText(text);
    button.textContent = "Copied";
  } catch (err) {
    // Keep the value accessible even when browser policy blocks both copy
    // mechanisms, instead of leaving an unhandled promise rejection.
    window.prompt("Copy this value:", text);
    button.textContent = "Select & copy";
  }
  setTimeout(() => { button.textContent = idleLabel; }, 1200);
}
$("copy-invite").onclick = () => copyWithFeedback(
  $("copy-invite"),
  $("copy-invite").dataset.invite,
  "Copy link",
);
$("copy-addr").onclick = () => copyWithFeedback(
  $("copy-addr"),
  $("listen-addr").textContent,
  "Copy",
);

// ---- Sending -------------------------------------------------------------
async function sendStream(addr, size, readChunk, progressEl, port = 1) {
  const conn = await tailcatDial({ addr, derpMapURL, verbose, port });
  let offset = 0;
  while (offset < size) {
    const chunk = await readChunk(offset, Math.min(CHUNK, size - offset));
    await conn.write(chunk); offset += chunk.length;
    progressEl.textContent = `${humanSize(offset)} / ${humanSize(size)}`;
  }
  await conn.closeWrite();
  while ((await conn.read()) !== null) {}
  conn.close();
  window.tcTest.sentBytes = offset;
  window.tcTest.sendDone = true;
  progressEl.textContent = `Sent ${humanSize(offset)}`;
}

function currentAddress() {
  const addr = $("send-addr").value.trim();
  if (!addr) { setStatus("Paste a peer address first"); $("send-addr").focus(); return null; }
  return addr;
}
function packEnvelope(meta, payload) {
  const json = new TextEncoder().encode(JSON.stringify({ ...meta, v: 1 }));
  const result = new Uint8Array(8 + json.length + payload.length);
  result.set(MAGIC, 0);
  new DataView(result.buffer).setUint32(4, json.length);
  result.set(json, 8); result.set(payload, 8 + json.length);
  return result;
}
function unpackEnvelope(bytes) {
  if (bytes.length < 8 || !MAGIC.every((b, i) => bytes[i] === b)) throw new Error("not a Tailcatchat message");
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
  if (length > bytes.length - 8) throw new Error("invalid message header");
  return { meta: JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))), payload: bytes.subarray(8 + length) };
}
async function sendEnvelope(addr, meta, payload, port) {
  const wire = packEnvelope(meta, payload);
  await sendStream(addr, wire.length, async (off, n) => wire.subarray(off, off + n), $("send-progress"), port);
}

let chatMode = false;

function connectToAddress(address, { invited = false } = {}) {
  if (!address?.startsWith("tc")) return false;
  $("send-addr").value = address;
  chatMode = true;
  $("peer-label").textContent = invited
    ? "Joined from invite · ready to send"
    : "Tailcatchat peer set · ready to send";
  setStatus(invited ? "Invite loaded" : "Peer set", true);
  $("send-text").focus();
  return true;
}

async function sendText() {
  const addr = currentAddress();
  const text = $("send-text").value;
  if (!addr || !text.trim()) return;
  $("send-text-btn").disabled = true;
  setStatus("Sending…");
  try {
    const payload = new TextEncoder().encode(text);
    // Setting a peer with the UI opts into Tailcatchat's typed chat stream.
    // Merely pasting an address preserves the original raw port-1 behavior,
    // so this page remains compatible with the tailcat CLI and older clients.
    if (chatMode) await sendEnvelope(addr, { type: "text" }, payload, CHAT_PORT);
    else await sendStream(addr, payload.length, async (off, n) => payload.subarray(off, off + n), $("send-progress"));
    addMessage({ type: "text", text, mine: true });
    $("send-text").value = "";
    setStatus("Delivered", true);
  } catch (err) {
    setStatus("Send failed: " + err.message);
    window.tcTest.errors.push(String(err));
  } finally { $("send-text-btn").disabled = false; }
}

$("send-text-btn").onclick = sendText;
$("connect-btn").onclick = () => {
  if (connectToAddress(currentAddress())) $("send-text").focus();
};
$("send-addr").addEventListener("input", () => {
  chatMode = false;
  $("peer-label").textContent = $("send-addr").value.trim() ? "Press Set to start chatting" : "Waiting for a peer address";
});

async function sendFile(file) {
  const addr = currentAddress();
  if (!addr || !file) return;
  setStatus(`Sending ${file.name}…`);
  try {
    const payload = new Uint8Array(await file.arrayBuffer());
    await sendEnvelope(addr, { type: "file", name: file.name, mime: file.type || "application/octet-stream" }, payload, FILE_PORT);
    addMessage({ type: "file", blob: file, name: file.name, mine: true });
    setStatus("File delivered", true);
  } catch (err) { setStatus("File send failed: " + err.message); window.tcTest.errors.push(String(err)); }
}
$("attach-btn").onclick = () => $("send-file").click();
$("send-file").onchange = () => sendFile($("send-file").files[0]);
// Kept for the original integration surface.
$("send-btn").onclick = () => sendFile($("send-file").files[0]);

const composer = $("composer");
let dragDepth = 0;
for (const name of ["dragenter", "dragover", "dragleave", "drop"]) {
  document.addEventListener(name, (event) => { event.preventDefault(); event.stopPropagation(); });
}
document.addEventListener("dragenter", () => { dragDepth++; $("drop-zone").classList.remove("hidden"); });
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop-zone").classList.add("hidden"); } });
document.addEventListener("drop", (event) => {
  dragDepth = 0; $("drop-zone").classList.add("hidden");
  for (const file of event.dataTransfer.files) sendFile(file);
});

// ---- Live voice, video, and screen sharing -------------------------------
// Signalling crosses the encrypted Tailcat control stream. Once negotiated,
// media flows over WebRTC's encrypted DTLS-SRTP transport. The public STUN
// server only assists path discovery; no TURN relay is configured yet.
const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
let peerConnection = null;
let localMediaStream = null;
let liveMode = "";
let makingOffer = false;

function setMediaStatus(message) { $("media-status").textContent = message; }
function openMediaDock(title) {
  document.querySelector(".app").classList.add("media-open");
  $("media-title").textContent = title;
}
function waitForICE(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const changed = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", changed);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", changed);
    setTimeout(resolve, 5000);
  });
}
async function sendControl(meta) {
  const addr = currentAddress();
  if (!addr) throw new Error("peer address required");
  await sendEnvelope(addr, meta, new Uint8Array(), CONTROL_PORT);
}
function createPeerConnection() {
  if (peerConnection) peerConnection.close();
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnection = pc;
  pc.ontrack = (event) => {
    $("remote-media").srcObject = event.streams[0] || new MediaStream([event.track]);
    setMediaStatus("live · encrypted WebRTC media");
  };
  pc.onconnectionstatechange = () => {
    setMediaStatus(`rtc: ${pc.connectionState}`);
    if (["failed", "closed"].includes(pc.connectionState)) endLiveLink(false);
  };
  return pc;
}
async function getLiveStream(mode) {
  if (mode === "screen") {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    display.getVideoTracks()[0].addEventListener("ended", () => endLiveLink(true), { once: true });
    return display;
  }
  return navigator.mediaDevices.getUserMedia({ audio: true, video: mode === "video" });
}
async function startLiveLink(mode) {
  if (!currentAddress()) return;
  if (!window.RTCPeerConnection) { setStatus("WebRTC is unavailable in this browser"); return; }
  endLiveLink(false);
  liveMode = mode;
  openMediaDock(mode === "screen" ? "Screen share" : mode === "video" ? "Video meet" : "Voice meet");
  setMediaStatus("requesting media…");
  try {
    localMediaStream = await getLiveStream(mode);
    $("local-media").srcObject = localMediaStream;
    $("local-media").classList.toggle("hidden", !localMediaStream.getVideoTracks().length);
    const pc = createPeerConnection();
    localMediaStream.getTracks().forEach((track) => pc.addTrack(track, localMediaStream));
    makingOffer = true;
    await pc.setLocalDescription(await pc.createOffer());
    await waitForICE(pc);
    await sendControl({ type: "rtc-offer", mode, description: pc.localDescription });
    makingOffer = false;
    setMediaStatus("calling peer…");
    addMessage({ type: "system", text: `${mode === "screen" ? "screen share" : mode + " meet"} started` });
  } catch (err) {
    makingOffer = false;
    setMediaStatus("could not start: " + err.message);
    endLiveLink(false, true);
  }
}
async function answerLiveLink(meta) {
  if (makingOffer) return; // Simple single-peer glare policy: current caller wins.
  endLiveLink(false);
  liveMode = meta.mode;
  openMediaDock(meta.mode === "screen" ? "Incoming screen" : `Incoming ${meta.mode} meet`);
  setMediaStatus("joining live link…");
  try {
    localMediaStream = meta.mode === "screen"
      ? null
      : await navigator.mediaDevices.getUserMedia({ audio: true, video: meta.mode === "video" });
    $("local-media").srcObject = localMediaStream;
    $("local-media").classList.toggle("hidden", !localMediaStream?.getVideoTracks().length);
    const pc = createPeerConnection();
    localMediaStream?.getTracks().forEach((track) => pc.addTrack(track, localMediaStream));
    await pc.setRemoteDescription(meta.description);
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForICE(pc);
    await sendControl({ type: "rtc-answer", description: pc.localDescription });
    addMessage({ type: "system", text: `${meta.mode === "screen" ? "screen share" : meta.mode + " meet"} connected` });
  } catch (err) {
    setMediaStatus("could not join: " + err.message);
    endLiveLink(false, true);
  }
}
async function endLiveLink(notifyPeer = true, keepDock = false) {
  const hadLink = Boolean(peerConnection || localMediaStream);
  const pc = peerConnection;
  peerConnection = null;
  if (pc) pc.close();
  localMediaStream?.getTracks().forEach((track) => track.stop());
  localMediaStream = null;
  $("local-media").srcObject = null;
  $("remote-media").srcObject = null;
  if (!keepDock) {
    $("media-dock").classList.remove("expanded");
    document.querySelector(".app").classList.remove("media-open");
  }
  setMediaStatus("link ended");
  if (notifyPeer && hadLink && currentAddress()) {
    try { await sendControl({ type: "rtc-hangup" }); } catch (_) {}
  }
}

$("voice-call-btn").onclick = () => startLiveLink("voice");
$("video-call-btn").onclick = () => startLiveLink("video");
$("screen-share-btn").onclick = () => startLiveLink("screen");
$("media-hangup").onclick = () => endLiveLink(true);
$("media-expand").onclick = () => {
  const expanded = $("media-dock").classList.toggle("expanded");
  $("media-expand").textContent = expanded ? "[_]" : "[ ]";
  $("media-expand").title = expanded ? "Collapse" : "Expand";
};

// ---- Push to talk --------------------------------------------------------
let recorder = null;
let voiceChunks = [];
let voiceStarted = 0;
let enterTimer = null;
let enterHeld = false;
let enterPTT = false;
async function startPTT(event) {
  event.preventDefault();
  if (recorder?.state === "recording") return;
  if (!currentAddress()) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    voiceChunks = []; voiceStarted = performance.now();
    recorder.ondataavailable = (e) => { if (e.data.size) voiceChunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(voiceChunks, { type: recorder.mimeType || "audio/webm" });
      const duration = Math.max(1, Math.round((performance.now() - voiceStarted) / 1000));
      $("ptt-btn").classList.remove("recording"); $("ptt-btn").textContent = "🎙";
      try {
        const addr = currentAddress();
        const payload = new Uint8Array(await blob.arrayBuffer());
        await sendEnvelope(addr, { type: "voice", mime: blob.type, duration }, payload, VOICE_PORT);
        addMessage({ type: "voice", blob, duration, mine: true });
        setStatus("Voice message delivered", true);
      } catch (err) { setStatus("Voice send failed: " + err.message); }
    };
    recorder.start();
    $("ptt-btn").classList.add("recording"); $("ptt-btn").textContent = "■";
    setStatus("Recording — release to send");
  } catch (err) { setStatus("Microphone unavailable: " + err.message); }
}
function stopPTT(event) {
  event.preventDefault();
  if (recorder?.state === "recording") recorder.stop();
}
$("ptt-btn").addEventListener("pointerdown", startPTT);
for (const name of ["pointerup", "pointercancel", "pointerleave"]) $("ptt-btn").addEventListener(name, stopPTT);

// Enter keeps its familiar chat behavior when text is present. In an empty
// composer, holding it for 100 ms starts PTT and releasing it sends the voice
// message. A quick empty Enter tap does nothing. Shift+Enter always inserts a
// newline.
$("send-text").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  if ($("send-text").value.trim()) {
    if (!event.repeat) sendText();
    return;
  }
  if (event.repeat || enterTimer || enterPTT) return;
  enterHeld = true;
  enterTimer = setTimeout(async () => {
    enterTimer = null;
    enterPTT = true;
    await startPTT({ preventDefault() {} });
    // A microphone permission prompt can outlive the key hold.
    if (!enterHeld && recorder?.state === "recording") stopPTT({ preventDefault() {} });
    if (recorder?.state !== "recording") enterPTT = false;
  }, 100);
});

$("send-text").addEventListener("keyup", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  enterHeld = false;
  if (enterTimer) {
    clearTimeout(enterTimer);
    enterTimer = null;
    return;
  }
  if (enterPTT) {
    enterPTT = false;
    stopPTT({ preventDefault() {} });
  }
});

window.addEventListener("blur", () => {
  if (enterTimer) clearTimeout(enterTimer);
  enterTimer = null;
  enterHeld = false;
  if (enterPTT) stopPTT({ preventDefault() {} });
  enterPTT = false;
});

// ---- Message rendering ---------------------------------------------------
function addMessage(item) {
  $("welcome")?.remove();
  const article = document.createElement("article");
  article.className = `message${item.mine ? " mine" : ""}${item.type === "system" ? " system" : ""}`;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${item.mine ? "You" : "Peer"} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (item.type === "system") {
    bubble.textContent = item.text;
  } else if (item.type === "text") {
    bubble.textContent = item.text;
  } else if (item.type === "voice") {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.playsInline = true;
    audio.src = URL.createObjectURL(item.blob);
    if (!item.mine) audio.autoplay = true;
    bubble.append(audio);
  } else if (item.type === "file") {
    const objectURL = URL.createObjectURL(item.blob);
    const info = document.createElement("span"); info.className = "file-info";
    const name = document.createElement("div"); name.className = "file-name"; name.textContent = item.name;
    const size = document.createElement("div"); size.className = "file-size"; size.textContent = humanSize(item.blob.size);
    const download = document.createElement("a"); download.className = "download"; download.textContent = "Download";
    download.href = objectURL; download.download = item.name;
    info.append(name, size);

    if (item.blob.type.startsWith("image/")) {
      bubble.classList.add("image");
      const preview = document.createElement("img");
      preview.className = "image-preview";
      preview.src = objectURL;
      preview.alt = item.name;
      preview.loading = "eager";
      const details = document.createElement("div"); details.className = "image-details";
      details.append(info, download);
      bubble.append(preview, details);
    } else {
      bubble.classList.add("file");
      const icon = document.createElement("span"); icon.className = "file-icon"; icon.textContent = "📄";
      bubble.append(icon, info, download);
    }
  }
  if (item.type === "system") article.append(bubble);
  else article.append(meta, bubble);
  $("history").append(article);
  article.scrollIntoView({ block: "end" });

  if (item.type === "voice" && !item.mine) {
    const audio = bubble.querySelector("audio");
    // Explicitly call play as well as setting autoplay. Browsers may still
    // require prior interaction with the page; controls remain available when
    // their autoplay policy rejects the request.
    audio.play().catch(() => setStatus("Voice received — tap play", true));
  }
}

// Load fragment invites only after the WASM transport is ready. Changing the
// fragment while the app is open joins the new room without a page reload.
async function connectFromInvite() {
  const address = inviteAddressFromHash();
  if (!address || !connectToAddress(address, { invited: true })) return;
  try {
    // The invite identifies the host. Starting our own listener and sending its
    // address back makes the relationship bidirectional without exposing
    // either address to the web server.
    await startListener();
    const payload = new Uint8Array();
    await sendEnvelope(address, { type: "hello", replyTo: localAddress }, payload, CONTROL_PORT);
    addMessage({ type: "system", text: "they're hear meow" });
    setStatus("Connected from invite", true);
    $("send-progress").textContent = "";
  } catch (err) {
    setStatus("Invite connection failed: " + err.message);
  }
}
connectFromInvite();
window.addEventListener("hashchange", connectFromInvite);

// ---- Test automation -----------------------------------------------------
if (params.get("mode") === "listen") {
  startListener();
} else if (params.get("mode") === "send") {
  const addr = params.get("addr");
  const size = parseInt(params.get("bytes"), 10);
  const data = new Uint8Array(size);
  for (let off = 0; off < size; off += CHUNK) crypto.getRandomValues(data.subarray(off, Math.min(off + CHUNK, size)));
  window.tcTest.sentSha256 = await sha256Hex(data);
  try { await sendStream(addr, size, async (off, n) => data.subarray(off, off + n), $("send-progress")); }
  catch (err) { window.tcTest.errors.push(String(err)); }
}
