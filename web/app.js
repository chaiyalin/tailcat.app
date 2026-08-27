// Tailchat: a no-build, plain JavaScript UI over Tailcat's WebAssembly API.
// Each chat item gets its own encrypted Tailcat TCP stream. Port 1 remains the
// netcat-compatible stream used by the original demo; ports 101-103 carry the
// tiny Tailchat envelope used for text, files, and voice notes.

const CHUNK = 64 * 1024;
const KEY_STORAGE = "tailcat-web-key";
const CHAT_PORT = 101;
const FILE_PORT = 102;
const VOICE_PORT = 103;
const MAGIC = new Uint8Array([0x54, 0x43, 0x48, 0x31]); // TCH1
const params = new URLSearchParams(location.search);
const verbose = params.has("verbose");
const canonicalDERPMapURL = "https://tailcat.dev/derpmap.json";

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
async function startListener() {
  $("listen-btn").disabled = true;
  setStatus("Starting encrypted room…");
  const persist = $("persist-key").checked;
  const privateKey = persist ? (localStorage.getItem(KEY_STORAGE) || "") : "";
  try {
    const listener = await tailcatListen({ derpMapURL, privateKey, verbose, onConnection });
    if (persist) localStorage.setItem(KEY_STORAGE, listener.privateKeyJSON);
    $("listen-addr").textContent = listener.addr;
    $("listen-info").classList.remove("hidden");
    $("listen-btn").textContent = "Room is open";
    setStatus("Listening securely", true);
    window.tcTest.listenAddr = listener.addr;
  } catch (err) {
    setStatus("Listen failed: " + err.message);
    window.tcTest.errors.push(String(err));
    $("listen-btn").disabled = false;
  }
}

function onConnection(conn) {
  if (params.get("sink") === "hash") return hashSink(conn);
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
    copy.textContent = "Copy"; copy.onclick = () => navigator.clipboard.writeText(text);
    li.append(box, copy); progress.textContent = `done, ${all.length} bytes`;
  } catch (err) { conn.close(); progress.textContent = "failed: " + err.message; }
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
$("copy-addr").onclick = async () => {
  await navigator.clipboard.writeText($("listen-addr").textContent);
  $("copy-addr").textContent = "Copied";
  setTimeout(() => { $("copy-addr").textContent = "Copy address"; }, 1200);
};

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
  if (bytes.length < 8 || !MAGIC.every((b, i) => bytes[i] === b)) throw new Error("not a Tailchat message");
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
  if (length > bytes.length - 8) throw new Error("invalid message header");
  return { meta: JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))), payload: bytes.subarray(8 + length) };
}
async function sendEnvelope(addr, meta, payload, port) {
  const wire = packEnvelope(meta, payload);
  await sendStream(addr, wire.length, async (off, n) => wire.subarray(off, off + n), $("send-progress"), port);
}

let chatMode = false;

async function sendText() {
  const addr = currentAddress();
  const text = $("send-text").value;
  if (!addr || !text.trim()) return;
  $("send-text-btn").disabled = true;
  setStatus("Sending…");
  try {
    const payload = new TextEncoder().encode(text);
    // Setting a peer with the UI opts into Tailchat's typed chat stream.
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
$("send-text").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendText(); }
});
$("connect-btn").onclick = () => {
  if (currentAddress()) {
    chatMode = true;
    $("peer-label").textContent = "Tailchat peer set · ready to send";
    setStatus("Peer set", true);
    $("send-text").focus();
  }
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

// ---- Push to talk --------------------------------------------------------
let recorder = null;
let voiceChunks = [];
let voiceStarted = 0;
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

// ---- Message rendering ---------------------------------------------------
function addMessage(item) {
  $("welcome")?.remove();
  const article = document.createElement("article");
  article.className = `message${item.mine ? " mine" : ""}`;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${item.mine ? "You" : "Peer"} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (item.type === "text") {
    bubble.textContent = item.text;
  } else if (item.type === "voice") {
    const audio = document.createElement("audio");
    audio.controls = true; audio.src = URL.createObjectURL(item.blob);
    bubble.append(audio);
  } else if (item.type === "file") {
    bubble.classList.add("file");
    const icon = document.createElement("span"); icon.className = "file-icon"; icon.textContent = "📄";
    const info = document.createElement("span"); info.className = "file-info";
    const name = document.createElement("div"); name.className = "file-name"; name.textContent = item.name;
    const size = document.createElement("div"); size.className = "file-size"; size.textContent = humanSize(item.blob.size);
    const download = document.createElement("a"); download.className = "download"; download.textContent = "Download";
    download.href = URL.createObjectURL(item.blob); download.download = item.name;
    info.append(name, size); bubble.append(icon, info, download);
  }
  article.append(meta, bubble); $("history").append(article); article.scrollIntoView({ block: "end" });
}

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
