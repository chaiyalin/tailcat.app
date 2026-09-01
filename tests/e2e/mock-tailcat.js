import { expect } from "@playwright/test";

/**
 * Replace the WASM transport only after the real bridge reports ready. The
 * application still runs its production framing, handshake, hashing, and UI;
 * only Tailcat's network byte stream is looped between pages in this browser
 * context through a BroadcastChannel.
 */
export async function installMockTailcat(page, namespace) {
  await page.waitForFunction(() => globalThis.tcTest?.ready === true);
  const initialErrors = await page.evaluate(() => globalThis.tcTest.errors);
  expect(initialErrors).toEqual([]);

  await page.evaluate(({ namespace: channelNamespace }) => {
    const endpoint = crypto.randomUUID();
    const channel = new BroadcastChannel(`tailcat-e2e-${channelNamespace}`);
    const connections = new Map();
    const pendingDials = new Map();
    const records = [];
    let listener = null;
    let listenerSequence = 0;
    let corruptNextFileData = false;
    let fileWriteDelayMs = 0;
    let failControlDials = false;

    function stableHex(value) {
      // This is only an address identity function for the transport fixture,
      // not a cryptographic primitive.
      let left = 0x811c9dc5;
      let right = 0x9e3779b9;
      for (const character of String(value)) {
        const code = character.codePointAt(0);
        left = Math.imul(left ^ code, 0x01000193) >>> 0;
        right = Math.imul(right ^ (code + left), 0x85ebca6b) >>> 0;
      }
      const block = `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
      return block.repeat(4);
    }

    function regionFor(id) {
      const regions = {
        301: ["nyc", "New York"],
        302: ["sfo", "San Francisco"],
        303: ["fra", "Frankfurt"],
        304: ["tok", "Tokyo"],
      };
      const [code, name] = regions[id] || ["tok", "Tokyo"];
      return { id: id > 0 ? id : 304, code, name };
    }

    function parseEnvelope(record) {
      if (![100, 101, 103].includes(record.port) || record.capturedBytes > 70 * 1024) return;
      const length = record.capture.reduce((sum, part) => sum + part.length, 0);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const part of record.capture) {
        bytes.set(part, offset);
        offset += part.length;
      }
      if (bytes.length < 8 || bytes[0] !== 0x54 || bytes[1] !== 0x43 || bytes[2] !== 0x48 || bytes[3] !== 0x31) return;
      const jsonLength = new DataView(bytes.buffer).getUint32(4, false);
      if (jsonLength > bytes.length - 8) return;
      try {
        record.envelope = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLength)));
      } catch (_) {
        // Production code is responsible for rejecting malformed envelopes.
      }
    }

    function endReads(state) {
      state.remoteEnded = true;
      while (state.waiters.length) state.waiters.shift()(null);
    }

    function deliver(state, bytes) {
      if (state.remoteEnded || state.closed) return;
      if (state.waiters.length) state.waiters.shift()(bytes);
      else state.queue.push(bytes);
    }

    function makeConnection({ id, peer, port, direction }) {
      const record = {
        id,
        peer,
        port,
        direction,
        writeSizes: [],
        capturedBytes: 0,
        capture: [],
        envelope: null,
        localWriteClosed: false,
        closed: false,
      };
      records.push(record);
      const state = {
        id,
        peer,
        port,
        record,
        queue: [],
        waiters: [],
        localWriteClosed: false,
        remoteEnded: false,
        closed: false,
      };

      const connection = {
        port,
        async read() {
          if (state.queue.length) return state.queue.shift();
          if (state.remoteEnded || state.closed) return null;
          return new Promise((resolve) => state.waiters.push(resolve));
        },
        async write(input) {
          // A remote half-close ends reads only; TCP remains writable until
          // this side also calls closeWrite/close.
          if (state.closed || state.localWriteClosed) throw new Error("mock connection is closed");
          let bytes = input instanceof Uint8Array ? input.slice() : new Uint8Array(input).slice();
          record.writeSizes.push(bytes.length);
          if ([100, 101, 103].includes(port) && record.capturedBytes + bytes.length <= 70 * 1024) {
            record.capture.push(bytes.slice());
            record.capturedBytes += bytes.length;
          }
          if (corruptNextFileData && port === 102 && bytes.length > 5 && bytes[0] === 2) {
            bytes[bytes.length - 1] ^= 0x01;
            corruptNextFileData = false;
            record.corrupted = true;
          }
          if (fileWriteDelayMs > 0 && port === 102 && bytes[0] === 2) {
            await new Promise((resolve) => setTimeout(resolve, fileWriteDelayMs));
          }
          // Fragment each application write at awkward boundaries so framing
          // is exercised independently of the transport's packet boundaries.
          const cuts = bytes.length > 9 ? [1, 3, 9, bytes.length] : [1, bytes.length];
          let start = 0;
          for (const end of cuts) {
            if (end <= start) continue;
            channel.postMessage({
              type: "DATA",
              from: endpoint,
              to: state.peer,
              id,
              bytes: bytes.slice(start, end),
            });
            start = end;
          }
        },
        async closeWrite() {
          if (state.closed || state.localWriteClosed) return;
          state.localWriteClosed = true;
          record.localWriteClosed = true;
          parseEnvelope(record);
          channel.postMessage({ type: "EOF", from: endpoint, to: state.peer, id });
        },
        close() {
          if (state.closed) return;
          state.closed = true;
          record.closed = true;
          endReads(state);
          channel.postMessage({ type: "CLOSE", from: endpoint, to: state.peer, id });
        },
      };
      state.connection = connection;
      connections.set(id, state);
      return connection;
    }

    channel.onmessage = ({ data: message }) => {
      if (!message || message.from === endpoint || (message.to && message.to !== endpoint)) return;
      if (message.type === "OPEN") {
        if (!listener || listener.closed || message.addr !== listener.addr) return;
        const connection = makeConnection({
          id: message.id,
          peer: message.from,
          port: message.port,
          direction: "inbound",
        });
        channel.postMessage({ type: "OPEN_ACK", from: endpoint, to: message.from, id: message.id });
        queueMicrotask(() => listener?.onConnection(connection));
        return;
      }
      if (message.type === "OPEN_ACK") {
        const pending = pendingDials.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingDials.delete(message.id);
        pending.resolve(pending.connection);
        return;
      }
      const state = connections.get(message.id);
      if (!state || message.from !== state.peer) return;
      if (message.type === "DATA") deliver(state, new Uint8Array(message.bytes));
      else if (message.type === "EOF" || message.type === "CLOSE") endReads(state);
    };

    const listen = async (options = {}) => {
      if (listener && !listener.closed) return listener.public;
      const privateKeyJSON = options.privateKey || JSON.stringify({
        fixture: channelNamespace,
        endpoint,
        sequence: ++listenerSequence,
        random: crypto.randomUUID(),
      });
      const address = `tc${stableHex(privateKeyJSON)}`;
      const region = regionFor(Number(options.regionID));
      const internal = {
        addr: address,
        closed: false,
        onConnection: options.onConnection,
      };
      internal.public = {
        addr: address,
        privateKeyJSON,
        regionID: region.id,
        regionCode: region.code,
        regionName: region.name,
        close() {
          internal.closed = true;
          if (listener === internal) listener = null;
        },
      };
      listener = internal;
      return internal.public;
    };

    const dial = async (options = {}) => {
      if (failControlDials && Number(options.port) === 100) {
        throw new Error("mock control path unavailable");
      }
      const id = crypto.randomUUID();
      const connection = makeConnection({
        id,
        peer: "pending",
        port: Number(options.port),
        direction: "outbound",
      });
      const state = connections.get(id);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingDials.delete(id);
          connections.delete(id);
          reject(new Error("mock peer unavailable"));
        }, 3_000);
        pendingDials.set(id, {
          connection,
          resolve: (opened) => {
            state.peer = state.record.peer = state.openedPeer;
            resolve(opened);
          },
          reject,
          timer,
        });
        channel.postMessage({
          type: "OPEN",
          from: endpoint,
          addr: options.addr,
          port: Number(options.port),
          id,
        });
      });
    };

    // OPEN_ACK tells us which endpoint owns the address. Capture it before
    // resolving the dial so subsequent DATA messages are addressed correctly.
    const originalOnMessage = channel.onmessage;
    channel.onmessage = (event) => {
      const message = event.data;
      if (message?.type === "OPEN_ACK" && message.to === endpoint) {
        const state = connections.get(message.id);
        if (state) state.openedPeer = message.from;
      }
      originalOnMessage(event);
    };

    globalThis.tailcatListen = listen;
    globalThis.tailcatDial = dial;
    globalThis.__mockTailcat = {
      endpoint,
      setCorruptNextFileData(value = true) {
        corruptNextFileData = Boolean(value);
      },
      setFileWriteDelay(milliseconds = 0) {
        fileWriteDelayMs = Math.max(0, Number(milliseconds) || 0);
      },
      setFailControlDials(value = true) {
        failControlDials = Boolean(value);
      },
      async sendEnvelope(addr, envelope, port = 100) {
        const connection = await dial({ addr, port });
        try {
          const json = new TextEncoder().encode(JSON.stringify(envelope));
          const header = new Uint8Array(8);
          header.set([0x54, 0x43, 0x48, 0x31]);
          new DataView(header.buffer).setUint32(4, json.length, false);
          const bytes = new Uint8Array(header.length + json.length);
          bytes.set(header);
          bytes.set(json, header.length);
          await connection.write(bytes);
          await connection.closeWrite();
          while (await connection.read() !== null) {}
        } finally {
          connection.close();
        }
      },
      snapshot() {
        return {
          endpoint,
          listenerAddress: listener?.addr || null,
          records: records.map((record) => ({
            id: record.id,
            port: record.port,
            direction: record.direction,
            writeSizes: [...record.writeSizes],
            envelope: record.envelope ? { ...record.envelope } : null,
            corrupted: Boolean(record.corrupted),
            localWriteClosed: record.localWriteClosed,
            closed: record.closed,
          })),
        };
      },
    };
    globalThis.tcTest.mockTransport = true;
    addEventListener("pagehide", () => {
      for (const state of connections.values()) state.connection.close();
      channel.close();
    }, { once: true });
  }, { namespace });

  await page.waitForFunction(() => globalThis.tcTest?.mockTransport === true);
}

export async function installMockSavePicker(page) {
  await page.evaluate(() => {
    const state = {
      pickerCalls: 0,
      writes: [],
      totalBytes: 0,
      closed: false,
      aborted: false,
      cancelNextPicker: false,
      failNextWrite: false,
    };
    Object.defineProperty(globalThis, "showSaveFilePicker", {
      configurable: true,
      value: async () => {
        state.pickerCalls += 1;
        if (state.cancelNextPicker) {
          state.cancelNextPicker = false;
          throw new DOMException("Picker cancelled", "AbortError");
        }
        return {
          async createWritable() {
            return {
              async write(value) {
                if (state.failNextWrite) {
                  state.failNextWrite = false;
                  throw new Error("mock disk write failed");
                }
                const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
                state.writes.push(bytes.length);
                state.totalBytes += bytes.length;
              },
              async close() {
                state.closed = true;
              },
              async abort() {
                state.aborted = true;
              },
            };
          },
        };
      },
    });
    globalThis.__mockSave = state;
  });
}

export async function installMockVoiceMedia(page) {
  await page.evaluate(() => {
    const track = { stop() {} };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
      getVideoTracks: () => [],
    };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => stream,
    });
    class MockMediaRecorder {
      constructor() {
        this.mimeType = "audio/webm";
        this.state = "inactive";
        this.ondataavailable = null;
        this.onstop = null;
      }

      start() {
        this.state = "recording";
      }

      stop() {
        if (this.state !== "recording") return;
        this.state = "inactive";
        queueMicrotask(() => {
          this.ondataavailable?.({ data: new Blob(["mock voice note"], { type: this.mimeType }) });
          this.onstop?.();
        });
      }
    }
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: MockMediaRecorder,
    });
  });
}

export async function openMockPage(context, namespace) {
  const page = await context.newPage();
  await page.goto("/");
  await installMockTailcat(page, namespace);
  return page;
}

export async function startMockRoom(page) {
  await page.locator("#listen-btn").click();
  await expect.poll(() => page.evaluate(() => globalThis.tcTest.state.room)).toBe("open");
  const address = await page.locator("#listen-addr").textContent();
  expect(address).toMatch(/^tc\S{32,}$/u);
  return address;
}

export async function connectMockPeer(page, address) {
  await page.locator("#send-addr").fill(address);
  await page.locator("#connect-btn").click();
  await expect.poll(() => page.evaluate(() => globalThis.tcTest.state.peer)).toBe("connected");
}
