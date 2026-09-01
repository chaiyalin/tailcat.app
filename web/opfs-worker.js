// Safari 17-25 exposes OPFS synchronous access handles only in a dedicated
// worker. Every request and response carries an id so failures cannot be
// attributed to the wrong transfer.

const OPFS_DIRECTORY = "tailcat-transfers";
const TRANSFER_ID_PATTERN = /^[0-9a-f]{32}$/u;
const CHUNK_BYTES = 64 * 1024;
const active = new Map();
let directoryPromise = null;

function serializeError(error) {
  return {
    name: String(error?.name || "Error"),
    message: String(error?.message || error || "File storage worker failed."),
    code: typeof error?.code === "string" ? error.code : "WORKER_FAILED",
  };
}

function validateTransferId(transferId) {
  if (!TRANSFER_ID_PATTERN.test(String(transferId || ""))) {
    const error = new Error("Invalid file transfer identifier.");
    error.code = "INVALID_TRANSFER_ID";
    throw error;
  }
  return transferId;
}

async function directory() {
  if (!directoryPromise) {
    directoryPromise = navigator.storage.getDirectory()
      .then((root) => root.getDirectoryHandle(OPFS_DIRECTORY, { create: true }));
  }
  return directoryPromise;
}

async function removeEntryIfPresent(name) {
  try {
    await (await directory()).removeEntry(name);
  } catch (error) {
    if (error?.name !== "NotFoundError") throw error;
  }
}

async function closeActive(transferId, remove) {
  const entry = active.get(transferId);
  let closeError = null;
  if (entry) {
    active.delete(transferId);
    try {
      entry.access.flush();
    } catch (error) {
      closeError = error;
    } finally {
      try {
        entry.access.close();
      } catch (error) {
        closeError ||= error;
      }
    }
  }
  if (remove) {
    try {
      await removeEntryIfPresent(transferId);
    } catch (error) {
      closeError ||= error;
    }
  }
  if (closeError) throw closeError;
}

async function init(transferId) {
  validateTransferId(transferId);
  if (active.has(transferId)) {
    const error = new Error("The temporary file identifier is already active.");
    error.code = "STORAGE_FAILED";
    throw error;
  }
  const opfs = await directory();
  try {
    await opfs.getFileHandle(transferId);
    const error = new Error("The temporary file identifier already exists.");
    error.code = "STORAGE_FAILED";
    throw error;
  } catch (error) {
    if (error?.name !== "NotFoundError") throw error;
  }
  const file = await opfs.getFileHandle(transferId, { create: true });
  let access;
  try {
    access = await file.createSyncAccessHandle();
    access.truncate(0);
    access.flush();
    active.set(transferId, { access, offset: 0 });
  } catch (error) {
    try { access?.close(); } catch (_) {}
    await removeEntryIfPresent(transferId);
    throw error;
  }
  return { offset: 0 };
}

function write(transferId, chunk) {
  validateTransferId(transferId);
  const entry = active.get(transferId);
  if (!entry) {
    const error = new Error("File transfer is not initialized.");
    error.code = "NOT_READY";
    throw error;
  }
  if (!(chunk instanceof ArrayBuffer) || chunk.byteLength > CHUNK_BYTES) {
    const error = new Error("Invalid file chunk.");
    error.code = "INVALID_CHUNK";
    throw error;
  }
  let bytes = new Uint8Array(chunk);
  while (bytes.byteLength) {
    const written = entry.access.write(bytes, { at: entry.offset });
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.byteLength) {
      throw new Error("OPFS returned an invalid write length.");
    }
    entry.offset += written;
    bytes = bytes.subarray(written);
  }
  return { offset: entry.offset };
}

async function close(transferId) {
  validateTransferId(transferId);
  const entry = active.get(transferId);
  if (!entry) {
    const error = new Error("File transfer is not initialized.");
    error.code = "NOT_READY";
    throw error;
  }
  active.delete(transferId);
  try {
    entry.access.flush();
  } finally {
    entry.access.close();
  }
  return { size: entry.offset };
}

async function cleanup() {
  for (const transferId of Array.from(active.keys())) {
    try {
      await closeActive(transferId, true);
    } catch (_) {
      // Continue so one broken handle does not retain every other temp file.
    }
  }
  const opfs = await directory();
  for await (const [name] of opfs.entries()) {
    await opfs.removeEntry(name, { recursive: true });
  }
  return { removed: true };
}

async function dispatch(message) {
  switch (message.type) {
    case "INIT":
      return init(message.transferId);
    case "WRITE":
      return write(message.transferId, message.chunk);
    case "CLOSE":
      return close(message.transferId);
    case "ABORT":
      validateTransferId(message.transferId);
      await closeActive(message.transferId, true);
      return { removed: true };
    case "DELETE":
      validateTransferId(message.transferId);
      await closeActive(message.transferId, true);
      return { removed: true };
    case "CLEANUP":
      return cleanup();
    default: {
      const error = new Error("Unknown file storage worker request.");
      error.code = "WORKER_FAILED";
      throw error;
    }
  }
}

self.addEventListener("message", async (event) => {
  const message = event.data;
  if (!message || typeof message.id !== "string" || typeof message.type !== "string") return;
  try {
    const result = await dispatch(message);
    self.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    self.postMessage({ id: message.id, ok: false, error: serializeError(error) });
  }
});
