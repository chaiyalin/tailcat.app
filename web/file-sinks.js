// Streaming file destinations used by the TCF1 receiver. This module never
// buffers a complete transfer: each write is limited to one protocol chunk.

export const FILE_SINK_KIND = Object.freeze({
  PICKER: "picker",
  OPFS_EXPORT: "opfs-export",
});

export const FILE_SINK_REASON = Object.freeze({
  NO_SINK: "NO_SINK",
  NO_STORAGE_ESTIMATE: "NO_STORAGE_ESTIMATE",
  INSUFFICIENT_SPACE: "INSUFFICIENT_SPACE",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  USER_CANCELLED: "USER_CANCELLED",
  INVALID_TRANSFER_ID: "INVALID_TRANSFER_ID",
  INVALID_CHUNK: "INVALID_CHUNK",
  SIZE_MISMATCH: "SIZE_MISMATCH",
  NOT_READY: "NOT_READY",
  REMOVE_UNSUPPORTED: "REMOVE_UNSUPPORTED",
  WORKER_FAILED: "WORKER_FAILED",
  STORAGE_FAILED: "STORAGE_FAILED",
});

export const FILE_SINK_CHUNK_BYTES = 64 * 1024;
export const FILE_SINK_MIN_HEADROOM_BYTES = 64 * 1024 * 1024;
export const FILE_SINK_DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

const OPFS_DIRECTORY = "tailcat-transfers";
const TRANSFER_ID_PATTERN = /^[0-9a-f]{32}$/u;
const DEFAULT_WORKER_URL = new URL("./opfs-worker.js", import.meta.url);
const WORKER_REQUEST_TIMEOUT_MS = 60_000;
const OPFS_OWNER_LOCK = "tailcat-app-opfs-owner";
const reservedStorageIds = new Set();
const SAFE_INLINE_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "video/mp4",
  "video/ogg",
  "video/quicktime",
  "video/webm",
]);

let initializationPromise = null;
let initializedState = null;
let workerClient = null;
let releaseOwnership = null;
let ownershipRequest = null;

export class FileSinkError extends Error {
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options);
    this.name = "FileSinkError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fileSinkError(error, fallbackCode = FILE_SINK_REASON.STORAGE_FAILED) {
  if (error instanceof FileSinkError) return error;
  const cancelled = error?.name === "AbortError";
  return new FileSinkError(
    cancelled ? FILE_SINK_REASON.USER_CANCELLED : fallbackCode,
    cancelled ? "The file operation was cancelled." : String(error?.message || error || "File storage failed."),
    undefined,
    error ? { cause: error } : undefined,
  );
}

function validByteCount(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function validateTransferId(transferId) {
  if (!TRANSFER_ID_PATTERN.test(String(transferId || ""))) {
    throw new FileSinkError(FILE_SINK_REASON.INVALID_TRANSFER_ID, "Invalid file transfer identifier.");
  }
  return transferId;
}

function safeName(input) {
  const leaf = String(input || "file").split(/[\\/]/u).pop() || "file";
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+$/u, "");
  return Array.from(cleaned || "file").slice(0, 180).join("");
}

function safeMime(input) {
  const value = String(input || "").toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value)
    ? value
    : "application/octet-stream";
}

function asChunk(value) {
  let bytes;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new FileSinkError(FILE_SINK_REASON.INVALID_CHUNK, "A file chunk must be binary data.");
  }
  if (bytes.byteLength > FILE_SINK_CHUNK_BYTES) {
    throw new FileSinkError(
      FILE_SINK_REASON.INVALID_CHUNK,
      `A file chunk cannot exceed ${FILE_SINK_CHUNK_BYTES} bytes.`,
    );
  }
  return bytes;
}

function storageAPIAvailable() {
  return Boolean(globalThis.navigator?.storage?.getDirectory);
}

function pickerAvailable() {
  return typeof globalThis.showSaveFilePicker === "function";
}

async function claimOPFSOwnership() {
  if (releaseOwnership) return true;
  if (ownershipRequest) return ownershipRequest;
  if (typeof navigator.locks?.request !== "function") return false;
  ownershipRequest = new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    void navigator.locks.request(OPFS_OWNER_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) {
        settle(false);
        return;
      }
      let release;
      const held = new Promise((done) => { release = done; });
      releaseOwnership = release;
      settle(true);
      await held;
      releaseOwnership = null;
    }).catch(() => settle(false));
  });
  return ownershipRequest;
}

async function opfsDirectory() {
  if (!storageAPIAvailable()) {
    throw new FileSinkError(FILE_SINK_REASON.NO_SINK, "Origin-private file storage is unavailable.");
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIRECTORY, { create: true });
}

async function removeEntryIfPresent(directory, name) {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (error?.name !== "NotFoundError") throw error;
  }
}

async function cleanupDirectory(directory) {
  for await (const [name] of directory.entries()) {
    await directory.removeEntry(name, { recursive: true });
  }
}

function randomTransferId() {
  const value = new Uint8Array(16);
  crypto.getRandomValues(value);
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function allocateOPFSStorageId(directory) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const storageId = randomTransferId();
    if (reservedStorageIds.has(storageId)) continue;
    try {
      await directory.getFileHandle(storageId);
    } catch (error) {
      if (error?.name !== "NotFoundError") throw error;
      reservedStorageIds.add(storageId);
      return storageId;
    }
  }
  throw new FileSinkError(FILE_SINK_REASON.STORAGE_FAILED, "A unique temporary file identifier could not be allocated.");
}

class OPFSWorkerClient {
  constructor(url) {
    this.sequence = 0;
    this.pending = new Map();
    this.failed = null;
    this.worker = new Worker(url, { name: "tailcat-opfs" });
    this.worker.addEventListener("message", (event) => this.onMessage(event));
    this.worker.addEventListener("error", (event) => {
      this.fail(new FileSinkError(
        FILE_SINK_REASON.WORKER_FAILED,
        event.message || "The file storage worker stopped unexpectedly.",
      ));
    });
    this.worker.addEventListener("messageerror", () => {
      this.fail(new FileSinkError(FILE_SINK_REASON.WORKER_FAILED, "The file storage worker returned invalid data."));
    });
  }

  onMessage(event) {
    const message = event.data;
    if (!message || typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.ok === true) {
      pending.resolve(message.result);
      return;
    }
    const remote = message.error || {};
    const error = new FileSinkError(
      typeof remote.code === "string" ? remote.code : FILE_SINK_REASON.WORKER_FAILED,
      String(remote.message || "The file storage worker failed."),
    );
    error.name = String(remote.name || "FileSinkError");
    pending.reject(error);
  }

  fail(error) {
    if (this.failed) return;
    this.failed = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.worker.terminate();
  }

  request(type, payload = {}, transfer = []) {
    if (this.failed) return Promise.reject(this.failed);
    const id = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new FileSinkError(FILE_SINK_REASON.WORKER_FAILED, `File storage worker timed out during ${type}.`));
      }, WORKER_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.worker.postMessage({ id, type, ...payload }, transfer);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(fileSinkError(error, FILE_SINK_REASON.WORKER_FAILED));
      }
    });
  }
}

function getWorkerClient(url = DEFAULT_WORKER_URL) {
  if (!workerClient) workerClient = new OPFSWorkerClient(url);
  return workerClient;
}

/**
 * Initializes the receiving backends and removes temporary files left by an
 * interrupted prior page. Call once during application startup, before rooms
 * are enabled.
 */
export async function initializeFileSinks({ workerURL = DEFAULT_WORKER_URL, allowOPFS = true } = {}) {
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    const state = {
      picker: pickerAvailable(),
      opfs: false,
      opfsMode: null,
      opfsError: null,
      opfsOwned: false,
    };
    if (!allowOPFS || !storageAPIAvailable()) {
      initializedState = Object.freeze(state);
      return initializedState;
    }
    try {
      state.opfsOwned = await claimOPFSOwnership();
      if (!state.opfsOwned) {
        state.opfsError = "Origin-private file receiving is already active in another tab or cannot be locked safely.";
        initializedState = Object.freeze(state);
        return initializedState;
      }
      const directory = await opfsDirectory();
      await cleanupDirectory(directory);

      // Inspect a real OPFS file handle instead of parsing a Safari version.
      // The probe file also obeys the rule that every internal name is a
      // cryptographically random transfer ID.
      const probeId = randomTransferId();
      const probeHandle = await directory.getFileHandle(probeId, { create: true });
      const asynchronousWritable = typeof probeHandle.createWritable === "function";
      await removeEntryIfPresent(directory, probeId);

      if (asynchronousWritable) {
        state.opfs = true;
        state.opfsMode = "async";
      } else if (typeof globalThis.Worker === "function") {
        const client = getWorkerClient(workerURL);
        await client.request("CLEANUP");
        state.opfs = true;
        state.opfsMode = "worker";
      }
    } catch (error) {
      state.opfsError = fileSinkError(error).message;
      if (state.opfsOwned && !state.opfs) {
        releaseOwnership?.();
        state.opfsOwned = false;
      }
    }
    initializedState = Object.freeze(state);
    return initializedState;
  })();
  return initializationPromise;
}

/** Removes all unexported OPFS files. Do not call while a transfer is active. */
export async function cleanupTemporaryFiles() {
  const state = await initializeFileSinks();
  if (!state.opfs) return false;
  try {
    if (state.opfsMode === "worker") {
      await getWorkerClient().request("CLEANUP");
    } else {
      await cleanupDirectory(await opfsDirectory());
    }
    return true;
  } catch (error) {
    throw fileSinkError(error);
  }
}

function storageHeadroom(size) {
  return Math.max(FILE_SINK_MIN_HEADROOM_BYTES, Math.ceil(size * 0.1));
}

function maxSizeForAvailableSpace(availableBytes, hardMaxBytes) {
  if (availableBytes < FILE_SINK_MIN_HEADROOM_BYTES) return 0;
  const fixedReserveLimit = Math.max(0, Math.floor(availableBytes - FILE_SINK_MIN_HEADROOM_BYTES));
  const proportionalReserveLimit = Math.max(0, Math.floor(availableBytes / 1.1));
  // Below 640 MiB the fixed reserve dominates; above it the 10% reserve does.
  const threshold = FILE_SINK_MIN_HEADROOM_BYTES * 10;
  const storageLimit = fixedReserveLimit <= threshold
    ? fixedReserveLimit
    : proportionalReserveLimit;
  return Math.min(hardMaxBytes, storageLimit);
}

async function storageEstimate() {
  if (typeof navigator.storage?.estimate !== "function") return null;
  try {
    const estimate = await navigator.storage.estimate();
    if (!Number.isFinite(estimate?.quota) || !Number.isFinite(estimate?.usage)) return null;
    return {
      quotaBytes: Math.max(0, Math.floor(estimate.quota)),
      usageBytes: Math.max(0, Math.floor(estimate.usage)),
      availableBytes: Math.max(0, Math.floor(estimate.quota - estimate.usage)),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Returns the maximum currently receivable size and the preferred sink. OPFS
 * is advertised only when the browser can report enough free origin storage.
 */
export async function probeFileSinkSupport({ hardMaxBytes = FILE_SINK_DEFAULT_MAX_BYTES } = {}) {
  if (!validByteCount(hardMaxBytes)) {
    throw new TypeError("hardMaxBytes must be a non-negative safe integer.");
  }
  const state = await initializeFileSinks();
  const pickerSupported = pickerAvailable();
  const estimate = state.opfs ? await storageEstimate() : null;
  const opfsMaxBytes = estimate ? maxSizeForAvailableSpace(estimate.availableBytes, hardMaxBytes) : 0;
  const opfsReceivable = state.opfs
    && Boolean(estimate)
    && estimate.availableBytes >= FILE_SINK_MIN_HEADROOM_BYTES;
  const preferredKind = pickerSupported
    ? FILE_SINK_KIND.PICKER
    : (opfsReceivable ? FILE_SINK_KIND.OPFS_EXPORT : null);
  return Object.freeze({
    picker: Object.freeze({ supported: pickerSupported, maxBytes: pickerSupported ? hardMaxBytes : 0 }),
    opfs: Object.freeze({
      supported: state.opfs,
      receivable: opfsReceivable,
      mode: state.opfsMode,
      maxBytes: opfsMaxBytes,
      estimate,
      reason: !state.opfs
        ? FILE_SINK_REASON.NO_SINK
        : (!estimate ? FILE_SINK_REASON.NO_STORAGE_ESTIMATE : (opfsReceivable ? null : FILE_SINK_REASON.INSUFFICIENT_SPACE)),
    }),
    preferredKind,
    maxBytes: preferredKind === FILE_SINK_KIND.PICKER ? hardMaxBytes : opfsMaxBytes,
  });
}

/** Checks the exact size + headroom rule immediately before accepting. */
export async function getReceiveCapacity(size, {
  kind,
  hardMaxBytes = FILE_SINK_DEFAULT_MAX_BYTES,
} = {}) {
  if (!validByteCount(size) || !validByteCount(hardMaxBytes)) {
    throw new TypeError("size and hardMaxBytes must be non-negative safe integers.");
  }
  if (size > hardMaxBytes) {
    return Object.freeze({
      ok: false,
      reason: FILE_SINK_REASON.FILE_TOO_LARGE,
      kind: kind || null,
      size,
      maxBytes: hardMaxBytes,
      requiredBytes: size,
      availableBytes: null,
    });
  }
  const support = await probeFileSinkSupport({ hardMaxBytes });
  const selectedKind = kind || support.preferredKind;
  if (selectedKind === FILE_SINK_KIND.PICKER) {
    return Object.freeze({
      ok: support.picker.supported,
      reason: support.picker.supported ? null : FILE_SINK_REASON.NO_SINK,
      kind: selectedKind,
      size,
      maxBytes: support.picker.maxBytes,
      requiredBytes: size,
      availableBytes: null,
    });
  }
  if (selectedKind !== FILE_SINK_KIND.OPFS_EXPORT || !support.opfs.supported) {
    return Object.freeze({
      ok: false,
      reason: FILE_SINK_REASON.NO_SINK,
      kind: selectedKind || null,
      size,
      maxBytes: 0,
      requiredBytes: size + storageHeadroom(size),
      availableBytes: support.opfs.estimate?.availableBytes ?? null,
    });
  }
  if (!support.opfs.estimate) {
    return Object.freeze({
      ok: false,
      reason: FILE_SINK_REASON.NO_STORAGE_ESTIMATE,
      kind: selectedKind,
      size,
      maxBytes: 0,
      requiredBytes: size + storageHeadroom(size),
      availableBytes: null,
    });
  }
  const requiredBytes = size + storageHeadroom(size);
  const availableBytes = support.opfs.estimate.availableBytes;
  return Object.freeze({
    ok: availableBytes >= requiredBytes,
    reason: availableBytes >= requiredBytes ? null : FILE_SINK_REASON.INSUFFICIENT_SPACE,
    kind: selectedKind,
    size,
    maxBytes: support.opfs.maxBytes,
    requiredBytes,
    availableBytes,
  });
}

class BaseFileSink {
  constructor({ kind, transferId, name, size, mime }) {
    this.kind = kind;
    this.transferId = validateTransferId(transferId);
    this.name = safeName(name);
    this.size = size;
    this.mime = safeMime(mime);
    this.bytesWritten = 0;
    this.state = "open";
    this.tail = Promise.resolve();
  }

  enqueue(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }

  assertOpen() {
    if (this.state !== "open") {
      throw new FileSinkError(FILE_SINK_REASON.NOT_READY, `The file sink is ${this.state}.`);
    }
  }

  async fail(error) {
    try {
      await this.abortRaw();
    } catch (_) {
      // Preserve the original write/close error. A later startup cleanup makes
      // another best-effort pass over any OPFS entry that could not be removed.
    }
    this.state = "aborted";
    throw fileSinkError(error);
  }

  write(value) {
    return this.enqueue(async () => {
      this.assertOpen();
      try {
        const bytes = asChunk(value);
        if (this.bytesWritten + bytes.byteLength > this.size) {
          throw new FileSinkError(FILE_SINK_REASON.SIZE_MISMATCH, "File data exceeds the declared size.");
        }
        await this.writeRaw(bytes);
        this.bytesWritten += bytes.byteLength;
        return this.bytesWritten;
      } catch (error) {
        return this.fail(error);
      }
    });
  }

  close() {
    return this.enqueue(async () => {
      this.assertOpen();
      try {
        if (this.bytesWritten !== this.size) {
          throw new FileSinkError(
            FILE_SINK_REASON.SIZE_MISMATCH,
            `Expected ${this.size} bytes but received ${this.bytesWritten}.`,
          );
        }
        await this.closeRaw();
        this.state = "closed";
      } catch (error) {
        return this.fail(error);
      }
    });
  }

  abort() {
    return this.enqueue(async () => {
      if (this.state === "removed" || this.state === "aborted") return;
      try {
        await this.abortRaw();
      } finally {
        this.state = "aborted";
      }
    });
  }

  remove() {
    return this.enqueue(async () => {
      if (this.state === "removed") return true;
      if (this.state === "open") await this.abortRaw();
      const removed = await this.removeRaw();
      this.state = "removed";
      return removed;
    });
  }

  getFile() {
    return this.enqueue(async () => {
      if (this.state !== "closed") {
        throw new FileSinkError(FILE_SINK_REASON.NOT_READY, "The file must be closed before it can be exported.");
      }
      const stored = await this.getFileRaw();
      // A File made from an OPFS File is a metadata wrapper over the existing
      // blob; it does not concatenate the transferred bytes in JavaScript.
      return new File([stored], this.name, {
        type: this.mime,
        lastModified: Date.now(),
      });
    });
  }

  async prepareExport() {
    let file = await this.getFile();
    let objectURL = null;
    let canShare = false;
    if (typeof navigator.share === "function") {
      try {
        canShare = typeof navigator.canShare !== "function" || navigator.canShare({ files: [file] });
      } catch (_) {
        canShare = false;
      }
    }
    const ensureObjectURL = () => {
      if (!file) throw new FileSinkError(FILE_SINK_REASON.NOT_READY, "The staged file was released.");
      if (!globalThis.document || typeof URL.createObjectURL !== "function") {
        throw new FileSinkError(FILE_SINK_REASON.NO_SINK, "Browser file opening is unavailable.");
      }
      if (!objectURL) objectURL = URL.createObjectURL(file);
      return objectURL;
    };
    return {
      get file() { return file; },
      name: this.name,
      canShare,
      canOpen: SAFE_INLINE_MIME_TYPES.has(this.mime),
      open: () => {
        const anchor = document.createElement("a");
        anchor.href = ensureObjectURL();
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      },
      share: () => {
        if (!file) return Promise.reject(new FileSinkError(FILE_SINK_REASON.NOT_READY, "The staged file was released."));
        if (typeof navigator.share !== "function") {
          return Promise.reject(new FileSinkError(FILE_SINK_REASON.NO_SINK, "System file sharing is unavailable."));
        }
        // No await occurs before navigator.share, preserving the click's
        // transient user activation.
        return navigator.share({ files: [file], title: this.name });
      },
      download: () => {
        const anchor = document.createElement("a");
        anchor.href = ensureObjectURL();
        anchor.download = this.name;
        anchor.rel = "noopener";
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      },
      dispose: () => {
        if (objectURL) URL.revokeObjectURL(objectURL);
        objectURL = null;
        file = null;
      },
    };
  }
}

// Only an uncommitted, joined attempt may be reset. OPFS gets a fresh random
// local path; picker keeps its original transaction and user-selected handle.
export async function resetFileSink(sink, transferId) {
  await sink.tail;
  sink.assertOpen();
  if (sink.kind === FILE_SINK_KIND.PICKER) {
    return sink.enqueue(async () => {
      sink.assertOpen();
      try {
        await sink.writable.truncate(0);
        await sink.writable.seek(0);
        sink.bytesWritten = 0;
        return sink;
      } catch (error) { return sink.fail(error); }
    });
  }
  const options = { kind: sink.kind, transferId, name: sink.name, size: sink.size, mime: sink.mime };
  await sink.abort();
  return createFileSink(options);
}

class PickerFileSink extends BaseFileSink {
  constructor(options, handle, writable) {
    super({ ...options, kind: FILE_SINK_KIND.PICKER });
    this.handle = handle;
    this.writable = writable;
  }

  async writeRaw(bytes) {
    await this.writable.write(bytes);
  }

  async closeRaw() {
    await this.writable.close();
    this.writable = null;
  }

  async abortRaw() {
    if (!this.writable) return;
    try {
      await this.writable.abort();
    } finally {
      this.writable = null;
    }
  }

  async removeRaw() {
    if (typeof this.handle.remove !== "function") {
      throw new FileSinkError(FILE_SINK_REASON.REMOVE_UNSUPPORTED, "This browser cannot remove a saved file.");
    }
    await this.handle.remove();
    return true;
  }

  getFileRaw() {
    return this.handle.getFile();
  }
}

class AsyncOPFSFileSink extends BaseFileSink {
  constructor(options, directory, handle, writable) {
    super({ ...options, kind: FILE_SINK_KIND.OPFS_EXPORT });
    this.directory = directory;
    this.handle = handle;
    this.writable = writable;
  }

  async writeRaw(bytes) {
    await this.writable.write(bytes);
  }

  async closeRaw() {
    await this.writable.close();
    this.writable = null;
  }

  async abortRaw() {
    let abortError = null;
    if (this.writable) {
      try {
        await this.writable.abort();
      } catch (error) {
        abortError = error;
      } finally {
        this.writable = null;
      }
    }
    try {
      await removeEntryIfPresent(this.directory, this.transferId);
      reservedStorageIds.delete(this.transferId);
    } catch (removeError) {
      throw abortError || removeError;
    }
    if (abortError) throw abortError;
  }

  async removeRaw() {
    await removeEntryIfPresent(this.directory, this.transferId);
    reservedStorageIds.delete(this.transferId);
    return true;
  }

  getFileRaw() {
    return this.handle.getFile();
  }
}

class WorkerOPFSFileSink extends BaseFileSink {
  constructor(options, client, handle) {
    super({ ...options, kind: FILE_SINK_KIND.OPFS_EXPORT });
    this.client = client;
    this.handle = handle;
  }

  async writeRaw(bytes) {
    // Transfer a dedicated 64 KiB-or-smaller copy. The TCF1 frame remains
    // usable by the incremental hasher after this buffer is detached.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    await this.client.request(
      "WRITE",
      { transferId: this.transferId, chunk: copy.buffer },
      [copy.buffer],
    );
  }

  closeRaw() {
    return this.client.request("CLOSE", { transferId: this.transferId });
  }

  async abortRaw() {
    await this.client.request("ABORT", { transferId: this.transferId });
    reservedStorageIds.delete(this.transferId);
  }

  async removeRaw() {
    await this.client.request("DELETE", { transferId: this.transferId });
    reservedStorageIds.delete(this.transferId);
    return true;
  }

  getFileRaw() {
    return this.handle.getFile();
  }
}

/**
 * Opens a streaming sink. For picker sinks this function must be called
 * directly from the user's click handler; showSaveFilePicker is invoked before
 * the first await so transient user activation is retained.
 */
export async function createFileSink({
  kind,
  transferId,
  name,
  size,
  mime = "application/octet-stream",
  hardMaxBytes = FILE_SINK_DEFAULT_MAX_BYTES,
  workerURL = DEFAULT_WORKER_URL,
} = {}) {
  const protocolTransferId = validateTransferId(transferId);
  if (!validByteCount(size, hardMaxBytes)) {
    throw new FileSinkError(FILE_SINK_REASON.FILE_TOO_LARGE, "The file exceeds the receiving limit.");
  }
  let options = { transferId: protocolTransferId, name: safeName(name), size, mime: safeMime(mime) };

  if (kind === FILE_SINK_KIND.PICKER) {
    if (!pickerAvailable()) {
      throw new FileSinkError(FILE_SINK_REASON.NO_SINK, "Direct file saving is unavailable.");
    }
    try {
      // Keep this as the first asynchronous browser operation in this branch.
      const handle = await globalThis.showSaveFilePicker({ suggestedName: options.name });
      const writable = await handle.createWritable({ keepExistingData: false });
      return new PickerFileSink(options, handle, writable);
    } catch (error) {
      throw fileSinkError(error);
    }
  }

  if (kind !== FILE_SINK_KIND.OPFS_EXPORT) {
    throw new FileSinkError(FILE_SINK_REASON.NO_SINK, "No file destination was selected.");
  }
  const state = await initializeFileSinks({ workerURL });
  const capacity = await getReceiveCapacity(size, { kind, hardMaxBytes });
  if (!capacity.ok) {
    throw new FileSinkError(capacity.reason, "There is not enough verified local storage for this file.", capacity);
  }

  let storageId = "";
  try {
    const directory = await opfsDirectory();
    // The protocol transfer ID is controlled by the remote peer and must never
    // become an OPFS path. Allocate a fresh local-only ID so a repeated offer
    // cannot overwrite or later delete a previously verified staged file.
    storageId = await allocateOPFSStorageId(directory);
    options = { ...options, transferId: storageId };
    if (state.opfsMode === "async") {
      const handle = await directory.getFileHandle(storageId, { create: true });
      const writable = await handle.createWritable({ keepExistingData: false });
      return new AsyncOPFSFileSink(options, directory, handle, writable);
    }
    if (state.opfsMode === "worker") {
      const client = getWorkerClient(workerURL);
      await client.request("INIT", { transferId: storageId });
      // INIT owns file creation because a sync access handle is exclusive. Get
      // the export handle only after the worker has created the final entry.
      const handle = await directory.getFileHandle(storageId);
      return new WorkerOPFSFileSink(options, client, handle);
    }
    throw new FileSinkError(FILE_SINK_REASON.NO_SINK, "Origin-private file storage is unavailable.");
  } catch (error) {
    if (storageId) {
      try {
        const directory = await opfsDirectory();
        await removeEntryIfPresent(directory, storageId);
        reservedStorageIds.delete(storageId);
      } catch (_) {}
    }
    throw fileSinkError(error);
  }
}
