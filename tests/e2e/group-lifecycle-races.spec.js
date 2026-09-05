import { expect, test } from "@playwright/test";
import { installMockVoiceMedia, openMockPage } from "./mock-tailcat.js";

async function createGroupHost(context, namespace, name = "Host") {
  const page = await openMockPage(context, namespace, { group: true });
  await createGroupOnPage(page, name);
  return {
    page,
    invitation: await page.locator("#group-invite-link").textContent(),
  };
}

async function createGroupOnPage(page, name) {
  await page.locator("#group-create-entry-btn").click();
  await page.locator("#group-create-nickname").fill(name);
  await page.locator("#group-create-btn").click();
  await expect.poll(() => page.evaluate(() => globalThis.tcTest.group.mode)).toBe("owner");
}

async function requestJoin(page, invitation, name) {
  await page.evaluate((value) => { location.hash = new URL(value).hash; }, invitation);
  await expect(page.locator("#group-join-dialog")).toBeVisible();
  await page.locator("#group-join-nickname").fill(name);
  await page.locator("#group-join-btn").click();
  await expect.poll(() => page.evaluate(() => globalThis.tcTest.group.mode)).toBe("pending");
}

async function approve(host, name) {
  const request = host.locator(".group-pending-item", { hasText: name });
  await expect(request).toBeVisible();
  await request.locator(".group-approve-join").click();
}

async function joinGroup(context, namespace, host, invitation, name) {
  const page = await openMockPage(context, namespace, { group: true });
  await requestJoin(page, invitation, name);
  await approve(host, name);
  await expect.poll(() => page.evaluate(() => globalThis.tcTest.group.mode)).toBe("member");
  return page;
}

async function selectRecipient(sender, name) {
  await sender.locator("#group-recipient-list .group-recipient-option", { hasText: name })
    .locator("input").check();
}

async function leaveGroup(page) {
  await page.locator("#group-leave-room-btn").click();
  await expect.poll(() => page.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
}

test("an old file task paused on wake lock cannot connect through a replacement room", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-file-wake-epoch-${Date.now()}`;
  try {
    const { page: host, invitation } = await createGroupHost(context, namespace, "Old Host");
    const sender = await joinGroup(context, namespace, host, invitation, "Sender");
    const receiver = await joinGroup(context, namespace, host, invitation, "Old Receiver");
    const oldReceiverAddress = await receiver.evaluate(() => globalThis.__mockTailcat.snapshot().listenerAddress);

    await sender.evaluate(() => {
      const originalConnect = globalThis.tailcatConnect;
      let releaseWake;
      const wakeGate = new Promise((resolve) => { releaseWake = resolve; });
      class TestWakeLockSentinel extends EventTarget {
        released = false;

        async release() {
          if (this.released) return;
          this.released = true;
          this.dispatchEvent(new Event("release"));
        }
      }
      const state = {
        wakeRequests: 0,
        wakeReleased: false,
        connectAddresses: [],
        dials: [],
        releaseWake() {
          if (state.wakeReleased) return;
          state.wakeReleased = true;
          releaseWake(new TestWakeLockSentinel());
        },
      };
      Object.defineProperty(navigator, "wakeLock", {
        configurable: true,
        value: {
          request(type) {
            if (type !== "screen") throw new Error("unexpected wake lock type");
            state.wakeRequests += 1;
            return wakeGate;
          },
        },
      });
      globalThis.tailcatConnect = async (options) => {
        state.connectAddresses.push(options.addr);
        const client = await originalConnect(options);
        return {
          async dial(dialOptions = {}) {
            state.dials.push({ address: options.addr, port: Number(dialOptions.port) });
            return client.dial(dialOptions);
          },
          close() {
            client.close();
          },
        };
      };
      globalThis.__fileWakeEpochRace = state;
    });
    await selectRecipient(sender, "Old Receiver");
    await sender.locator("#send-file").setInputFiles({
      name: "old-room-wake.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("this task must remain owned by the old room"),
    });
    await expect.poll(() => sender.evaluate(() => globalThis.__fileWakeEpochRace.wakeRequests)).toBe(1);
    expect(await sender.evaluate(() => globalThis.__fileWakeEpochRace.connectAddresses)).toEqual([]);

    await leaveGroup(sender);
    await createGroupOnPage(sender, "Replacement Host");
    const replacementInvitation = await sender.locator("#group-invite-link").textContent();
    await sender.evaluate(() => globalThis.__fileWakeEpochRace.releaseWake());

    // Both callers shared the same pending wake-lock request. The old file
    // continuation was registered first, so creation reaching its finally
    // block proves the stale task has resumed before these negative checks.
    await expect(sender.locator("#group-create-btn")).toBeEnabled();
    const audit = await sender.evaluate(() => ({
      connectAddresses: [...globalThis.__fileWakeEpochRace.connectAddresses],
      dials: [...globalThis.__fileWakeEpochRace.dials],
    }));
    expect(audit.connectAddresses).not.toContain(oldReceiverAddress);
    expect(audit.dials).not.toContainEqual({ address: oldReceiverAddress, port: 102 });
    await expect.poll(() => sender.evaluate(() => globalThis.tcTest.group.mode)).toBe("owner");
    await expect(sender.locator("#group-invite-link")).toHaveText(replacementInvitation);
    await expect(sender.locator("#status")).toContainText(/group room active/iu);
  } finally {
    await context.close();
  }
});

test("a group voice transport resolving in a later epoch is closed without dialing", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-voice-transport-epoch-${Date.now()}`;
  try {
    const { page: host, invitation } = await createGroupHost(context, namespace, "Old Host");
    const sender = await joinGroup(context, namespace, host, invitation, "Sender");
    const receiver = await joinGroup(context, namespace, host, invitation, "Old Receiver");
    const oldReceiverAddress = await receiver.evaluate(() => globalThis.__mockTailcat.snapshot().listenerAddress);
    await installMockVoiceMedia(sender);

    await sender.evaluate((targetAddress) => {
      const originalConnect = globalThis.tailcatConnect;
      let releaseTransport;
      const transportGate = new Promise((resolve) => { releaseTransport = resolve; });
      const state = {
        targetAddress,
        armed: true,
        connects: 0,
        aborts: 0,
        dials: 0,
        closes: 0,
        released: false,
        release() {
          if (state.released) return;
          state.released = true;
          let closed = false;
          releaseTransport({
            async dial() {
              state.dials += 1;
              throw new Error("a stale voice transport attempted to dial");
            },
            close() {
              if (closed) return;
              closed = true;
              state.closes += 1;
            },
          });
        },
      };
      globalThis.tailcatConnect = (options) => {
        if (!state.armed || options.addr !== targetAddress) return originalConnect(options);
        state.armed = false;
        state.connects += 1;
        options.signal?.addEventListener("abort", () => { state.aborts += 1; }, { once: true });
        return transportGate;
      };
      globalThis.__voiceTransportEpochRace = state;
    }, oldReceiverAddress);
    await selectRecipient(sender, "Old Receiver");
    await sender.locator("#ptt-btn").dispatchEvent("pointerdown", { pointerId: 1 });
    await expect(sender.locator("#ptt-btn")).toHaveClass(/recording/u);
    await sender.locator("body").dispatchEvent("pointerup", { pointerId: 1 });
    await expect.poll(() => sender.evaluate(() => globalThis.__voiceTransportEpochRace.connects)).toBe(1);

    await leaveGroup(sender);
    await expect.poll(() => sender.evaluate(() => globalThis.__voiceTransportEpochRace.aborts)).toBe(1);
    await createGroupOnPage(sender, "Replacement Host");
    const replacementInvitation = await sender.locator("#group-invite-link").textContent();
    await sender.evaluate(() => globalThis.__voiceTransportEpochRace.release());

    // closeTransports registered its close callback after the send coroutine
    // had already awaited this promise, so observing close also proves the
    // stale send continuation ran and declined to dial.
    await expect.poll(() => sender.evaluate(() => globalThis.__voiceTransportEpochRace.closes)).toBe(1);
    expect(await sender.evaluate(() => globalThis.__voiceTransportEpochRace.dials)).toBe(0);
    expect(await sender.evaluate(() => globalThis.__mockTailcat.snapshot().records.some(
      ({ port, direction }) => port === 103 && direction === "outbound",
    ))).toBe(false);
    await expect.poll(() => sender.evaluate(() => globalThis.tcTest.group.mode)).toBe("owner");
    await expect(sender.locator("#group-invite-link")).toHaveText(replacementInvitation);
    await expect(sender.locator("#status")).toContainText(/group room active/iu);
  } finally {
    await context.close();
  }
});

test("a late capacity REJECT completion cannot overwrite a replacement room status", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-file-reject-epoch-${Date.now()}`;
  try {
    // Open first so this page owns the origin-private file sink. The low-space
    // estimate is installed only after joining, so its advertised capability
    // still allows the sender to obtain a transfer ticket.
    const receiver = await openMockPage(context, namespace, { group: true });
    await receiver.evaluate(() => {
      const originalListen = globalThis.tailcatListen;
      let releaseWrite;
      const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
      const decoder = new TextDecoder();
      const state = {
        started: 0,
        finished: 0,
        reason: "",
        released: false,
        release() {
          if (state.released) return;
          state.released = true;
          releaseWrite();
        },
      };
      globalThis.tailcatListen = (options = {}) => originalListen({
        ...options,
        onConnection(connection) {
          if (Number(connection.port) !== 102) {
            return options.onConnection(connection);
          }
          const originalWrite = connection.write.bind(connection);
          const wrapped = Object.create(connection);
          wrapped.write = async (input) => {
            const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
            let meta = null;
            if (bytes.length >= 5 && bytes[0] === 1) {
              const jsonLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
              if (jsonLength <= bytes.length - 5) {
                try {
                  meta = JSON.parse(decoder.decode(bytes.subarray(5, 5 + jsonLength)));
                } catch (_) {}
              }
            }
            const result = await originalWrite(bytes);
            if (meta?.type === "REJECT" && meta.reason === "INSUFFICIENT_SPACE") {
              state.started += 1;
              state.reason = meta.reason;
              await writeGate;
              state.finished += 1;
            }
            return result;
          };
          return options.onConnection(wrapped);
        },
      });
      globalThis.__capacityRejectEpochRace = state;
    });

    const { page: sender, invitation } = await createGroupHost(context, namespace, "Old Host");
    await requestJoin(receiver, invitation, "Receiver");
    await approve(sender, "Receiver");
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.group.mode)).toBe("member");
    await receiver.evaluate(() => {
      const headroom = 64 * 1024 * 1024;
      Object.defineProperty(globalThis, "showSaveFilePicker", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(navigator.storage, "estimate", {
        configurable: true,
        value: async () => ({ quota: headroom + 1024, usage: 0 }),
      });
    });
    await selectRecipient(sender, "Receiver");

    await sender.locator("#send-file").setInputFiles({
      name: "late-capacity-reject.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(2048, 0x5a),
    });
    await expect.poll(() => receiver.evaluate(() => globalThis.__capacityRejectEpochRace.started)).toBe(1);
    expect(await receiver.evaluate(() => globalThis.__capacityRejectEpochRace.reason)).toBe("INSUFFICIENT_SPACE");

    await leaveGroup(receiver);
    await createGroupOnPage(receiver, "Replacement Host");
    const replacementInvitation = await receiver.locator("#group-invite-link").textContent();
    await receiver.evaluate(() => globalThis.__capacityRejectEpochRace.release());
    await expect.poll(() => receiver.evaluate(() => globalThis.__capacityRejectEpochRace.finished)).toBe(1);

    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.group.mode)).toBe("owner");
    await expect(receiver.locator("#group-invite-link")).toHaveText(replacementInvitation);
    await expect(receiver.locator("#status")).toContainText(/group room active/iu);
    await expect(receiver.locator("#status")).not.toContainText(/not enough browser storage|unable to receive/iu);
  } finally {
    await context.close();
  }
});
