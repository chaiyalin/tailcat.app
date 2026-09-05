import { expect, test } from "@playwright/test";
import { installMockSavePicker, installMockVoiceMedia, openMockPage } from "./mock-tailcat.js";

async function createGroupHost(context, namespace, name = "Host") {
  const page = await openMockPage(context, namespace, { group: true });
  await page.locator("#group-create-entry-btn").click();
  await page.locator("#group-create-nickname").fill(name);
  await page.locator("#group-create-btn").click();
  await expect.poll(() => page.evaluate(() => globalThis.tcTest.group.mode)).toBe("owner");
  return {
    page,
    invitation: await page.locator("#group-invite-link").textContent(),
  };
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

function activeIncomingFiles(page) {
  return page.locator('.incoming-transfer:not([data-finished="true"])');
}

function activeIncomingVoices(page) {
  return page.locator('.incoming-voice-transfer:not([data-finished="true"])');
}

async function selectRecipient(sender, name) {
  await sender.locator("#group-recipient-list .group-recipient-option", { hasText: name })
    .locator("input").check();
}

async function outboundFileConnections(page) {
  return page.evaluate(() => globalThis.__mockTailcat.snapshot().records.filter(
    ({ port, direction, closed }) => port === 102 && direction === "outbound" && !closed,
  ).length);
}

async function installPrematureGroupDataInjector(page, kind) {
  await page.evaluate((attackKind) => {
    const originalConnect = globalThis.tailcatConnect;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const state = {
      kind: attackKind,
      offerSeen: false,
      injected: false,
      declaredBodyBytes: 0,
      injectedHeadBytes: 0,
      injectedBodyBytes: 0,
      applicationBytesAfterInjection: 0,
      applicationCloseWriteAfterInjection: false,
      peerClosed: false,
      localClosed: false,
    };
    globalThis.__prematureGroupData = state;

    const isVoiceFrame = (bytes) => bytes.length >= 12
      && bytes[0] === 0x54
      && bytes[1] === 0x43
      && bytes[2] === 0x56
      && bytes[3] === 0x31;

    globalThis.tailcatConnect = async (options) => {
      const client = await originalConnect(options);
      return {
        async dial(dialOptions = {}) {
          const connection = await client.dial(dialOptions);
          const port = Number(dialOptions.port);
          if ((attackKind === "file" && port !== 102)
            || (attackKind === "voice" && port !== 103)) return connection;

          return {
            port: connection.port,
            async read(maximumBytes) {
              const chunk = maximumBytes === undefined
                ? await connection.read()
                : await connection.read(maximumBytes);
              if (chunk === null) state.peerClosed = true;
              return chunk;
            },
            async write(input) {
              const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
              if (state.injected) state.applicationBytesAfterInjection += bytes.length;
              await connection.write(bytes);
              if (state.injected) return;

              if (attackKind === "file" && bytes.length >= 5 && bytes[0] === 1) {
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                const jsonLength = view.getUint32(1, false);
                if (jsonLength > bytes.length - 5) return;
                const offer = JSON.parse(decoder.decode(bytes.subarray(5, 5 + jsonLength)));
                if (offer.type !== "OFFER" || offer.mode !== "group") return;
                const declaredBodyBytes = 64 * 1024;
                const head = new Uint8Array(5);
                head[0] = 2;
                new DataView(head.buffer).setUint32(1, declaredBodyBytes, false);
                const body = new Uint8Array(2048).fill(0x5a);
                const attack = new Uint8Array(head.length + body.length);
                attack.set(head);
                attack.set(body, head.length);
                Object.assign(state, {
                  offerSeen: true,
                  injected: true,
                  declaredBodyBytes,
                  injectedHeadBytes: head.length,
                  injectedBodyBytes: body.length,
                });
                // Coalesce the DATA header and body bytes in one application
                // write. The receiver may inspect only the five-byte header
                // before consent, even if the bridge receives more at once.
                await connection.write(attack);
                return;
              }

              if (attackKind === "voice" && isVoiceFrame(bytes)) {
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                const jsonLength = view.getUint32(4, false);
                const payloadLength = view.getUint32(8, false);
                if (payloadLength !== 0 || jsonLength > bytes.length - 12) return;
                const offer = JSON.parse(decoder.decode(bytes.subarray(12, 12 + jsonLength)));
                if (offer.type !== "VOICE_OFFER" || offer.mode !== "group") return;
                const declaredBodyBytes = 10 * 1024 * 1024;
                const meta = encoder.encode(JSON.stringify({
                  type: "VOICE_DATA",
                  v: offer.v,
                  mode: offer.mode,
                  gv: offer.gv,
                  roomId: offer.roomId,
                  senderId: offer.senderId,
                  recipientId: offer.recipientId,
                  transferId: offer.transferId,
                  size: declaredBodyBytes,
                  mime: offer.mime,
                  duration: offer.duration,
                }));
                const head = new Uint8Array(12 + meta.length);
                head.set([0x54, 0x43, 0x56, 0x31]);
                const headView = new DataView(head.buffer);
                headView.setUint32(4, meta.length, false);
                headView.setUint32(8, declaredBodyBytes, false);
                head.set(meta, 12);
                const body = new Uint8Array(2048).fill(0x5a);
                const attack = new Uint8Array(head.length + body.length);
                attack.set(head);
                attack.set(body, head.length);
                Object.assign(state, {
                  offerSeen: true,
                  injected: true,
                  declaredBodyBytes,
                  injectedHeadBytes: head.length,
                  injectedBodyBytes: body.length,
                });
                // The frame head and body share one write; a pre-consent read
                // must stop exactly after the authenticated metadata.
                await connection.write(attack);
              }
            },
            async closeWrite() {
              if (state.injected) state.applicationCloseWriteAfterInjection = true;
              return connection.closeWrite();
            },
            close() {
              state.localClosed = true;
              connection.close();
            },
          };
        },
        close() {
          client.close();
        },
      };
    };
  }, kind);
}

test("a multi-file batch is serialized within one recipient lane", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-file-serial-${Date.now()}`;
  try {
    const { page: sender, invitation } = await createGroupHost(context, namespace);
    const receiver = await joinGroup(context, namespace, sender, invitation, "Only Receiver");
    await installMockSavePicker(receiver);
    await selectRecipient(sender, "Only Receiver");

    await sender.locator("#send-file").setInputFiles([
      {
        name: "batch-first.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("first payload"),
      },
      {
        name: "batch-second.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("second payload"),
      },
    ]);

    const first = receiver.locator(".incoming-transfer", { hasText: "batch-first.bin" });
    await expect(first).toBeVisible();
    await expect(first.locator(".transfer-name")).toHaveText(
      /^File from Host · #[A-Z0-9_-]{6} · Host: batch-first\.bin$/u,
    );
    await expect(activeIncomingFiles(receiver)).toHaveCount(1);
    await expect.poll(() => outboundFileConnections(sender)).toBe(1);
    await expect(receiver.locator(".incoming-transfer", { hasText: "batch-second.bin" })).toHaveCount(0);

    await first.locator(".save-file").click();
    await expect(first).toHaveAttribute("data-finished", "true");

    const second = receiver.locator(".incoming-transfer", { hasText: "batch-second.bin" });
    await expect(second).toBeVisible();
    await expect(activeIncomingFiles(receiver)).toHaveCount(1);
    await second.locator(".save-file").click();
    await expect(second).toHaveAttribute("data-finished", "true");

    for (const name of ["batch-first.bin", "batch-second.bin"]) {
      const outgoing = sender.locator(".transfer-item", { hasText: name });
      await expect(outgoing.locator('[data-status="complete"]')).toHaveCount(1);
      await expect(outgoing).toHaveAttribute("data-finished", "true");
    }
    expect(await receiver.evaluate(() => globalThis.__mockSave.pickerCalls)).toBe(2);
  } finally {
    await context.close();
  }
});

test("separate file batches share the same recipient lane", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-file-cross-batch-${Date.now()}`;
  try {
    const { page: sender, invitation } = await createGroupHost(context, namespace);
    const receiver = await joinGroup(context, namespace, sender, invitation, "Only Receiver");
    await installMockSavePicker(receiver);
    await selectRecipient(sender, "Only Receiver");

    await sender.locator("#send-file").setInputFiles({
      name: "first-batch.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("first independent batch"),
    });
    const first = receiver.locator(".incoming-transfer", { hasText: "first-batch.bin" });
    await expect(first).toBeVisible();

    await sender.locator("#send-file").setInputFiles({
      name: "second-batch.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("second independent batch"),
    });
    // Let a wrongly independent scheduler issue its second ticket and dial.
    await receiver.waitForTimeout(300);
    expect(await sender.evaluate(() => globalThis.__mockTailcat.snapshot().records.filter(
      ({ port, direction }) => port === 102 && direction === "outbound",
    ).length)).toBe(1);
    await expect(receiver.locator(".incoming-transfer", { hasText: "second-batch.bin" })).toHaveCount(0);

    await first.locator(".save-file").click();
    await expect(first).toHaveAttribute("data-finished", "true");
    const second = receiver.locator(".incoming-transfer", { hasText: "second-batch.bin" });
    await expect(second).toBeVisible();
    await second.locator(".save-file").click();
    await expect(second).toHaveAttribute("data-finished", "true");

    for (const name of ["first-batch.bin", "second-batch.bin"]) {
      await expect(sender.locator(".transfer-item", { hasText: name }).locator('[data-status="complete"]')).toHaveCount(1);
    }
  } finally {
    await context.close();
  }
});

test("a multi-file batch opens at most two recipient lanes globally", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-file-parallel-${Date.now()}`;
  try {
    const { page: sender, invitation } = await createGroupHost(context, namespace);
    const receivers = [];
    for (const name of ["Receiver A", "Receiver B", "Receiver C"]) {
      const page = await joinGroup(context, namespace, sender, invitation, name);
      await installMockSavePicker(page);
      receivers.push(page);
    }
    await sender.locator("#group-recipient-all").check();
    await sender.locator("#send-file").setInputFiles([
      {
        name: "parallel-first.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("first parallel payload"),
      },
      {
        name: "parallel-second.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("second parallel payload"),
      },
    ]);

    await expect.poll(async () => {
      const counts = await Promise.all(receivers.map((page) => activeIncomingFiles(page).count()));
      return counts.reduce((total, count) => total + count, 0);
    }).toBe(2);
    await expect.poll(() => outboundFileConnections(sender)).toBe(2);
    for (const receiver of receivers) expect(await activeIncomingFiles(receiver).count()).toBeLessThanOrEqual(1);

    let accepted = 0;
    while (accepted < 6) {
      let acceptedOne = false;
      for (const receiver of receivers) {
        const active = activeIncomingFiles(receiver);
        if (await active.count()) {
          const name = await active.first().locator(".transfer-name").textContent();
          const item = receiver.locator(".incoming-transfer", { hasText: name || "" });
          await item.locator(".save-file").click();
          accepted += 1;
          acceptedOne = true;
          await expect(item).toHaveAttribute("data-finished", "true");
          break;
        }
      }
      if (!acceptedOne) {
        await expect.poll(async () => {
          const counts = await Promise.all(receivers.map((page) => activeIncomingFiles(page).count()));
          return counts.reduce((total, count) => total + count, 0);
        }).toBeGreaterThan(0);
      }
      expect(await outboundFileConnections(sender)).toBeLessThanOrEqual(2);
    }

    await expect.poll(async () => {
      const calls = await Promise.all(receivers.map((page) => page.evaluate(() => globalThis.__mockSave.pickerCalls)));
      return calls.reduce((total, count) => total + count, 0);
    }).toBe(6);
    for (const name of ["parallel-first.bin", "parallel-second.bin"]) {
      await expect(sender.locator(".transfer-item", { hasText: name }).locator('[data-status="complete"]')).toHaveCount(3);
    }
  } finally {
    await context.close();
  }
});

test("sender cancellation immediately dismisses a pending group file decision", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-file-cancel-${Date.now()}`;
  try {
    const { page: sender, invitation } = await createGroupHost(context, namespace);
    const receiver = await joinGroup(context, namespace, sender, invitation, "Receiver");
    await installMockSavePicker(receiver);
    await selectRecipient(sender, "Receiver");

    await sender.locator("#send-file").setInputFiles({
      name: "cancel-before-decision.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("cancel before consent"),
    });
    const incoming = receiver.locator(".incoming-transfer", { hasText: "cancel-before-decision.bin" });
    await expect(incoming).toBeVisible();
    const outgoing = sender.locator(".transfer-item", { hasText: "cancel-before-decision.bin" });
    await outgoing.locator("button.danger").click();

    await expect(incoming).toHaveAttribute("data-finished", "true", { timeout: 3_000 });
    await expect(incoming.locator(".save-file")).toBeDisabled();
    await expect(incoming.locator(".reject-file")).toBeDisabled();

    await sender.locator("#send-file").setInputFiles({
      name: "after-cancel.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("the receive lane was released"),
    });
    const next = receiver.locator(".incoming-transfer", { hasText: "after-cancel.bin" });
    await expect(next).toBeVisible();
    await next.locator(".reject-file").click();
  } finally {
    await context.close();
  }
});

test("sender cancellation immediately dismisses a pending group voice decision", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-voice-cancel-${Date.now()}`;
  try {
    const { page: sender, invitation } = await createGroupHost(context, namespace);
    const receiver = await joinGroup(context, namespace, sender, invitation, "Receiver");
    await installMockVoiceMedia(sender);
    await selectRecipient(sender, "Receiver");

    await sender.locator("#ptt-btn").dispatchEvent("pointerdown", { pointerId: 1 });
    await expect(sender.locator("#ptt-btn")).toHaveClass(/recording/u);
    await sender.locator("body").dispatchEvent("pointerup", { pointerId: 1 });

    const incoming = activeIncomingVoices(receiver);
    await expect(incoming).toHaveCount(1);
    const outgoing = sender.locator('.transfer-item:not([data-finished="true"])');
    await expect(outgoing).toHaveCount(1);
    await outgoing.locator("button.danger").click();

    await expect(incoming).toHaveCount(0, { timeout: 3_000 });
    const finished = receiver.locator('.incoming-voice-transfer[data-finished="true"]');
    await expect(finished).toHaveCount(1);
    await expect(finished.locator(".save-file")).toBeHidden();
    await expect(finished.locator(".reject-file")).toBeHidden();
  } finally {
    await context.close();
  }
});

test("a premature group file DATA header is rejected without reading its declared 64 KiB body", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-file-preconsent-data-${Date.now()}`;
  try {
    const { page: sender, invitation } = await createGroupHost(context, namespace);
    await installPrematureGroupDataInjector(sender, "file");
    const receiver = await joinGroup(context, namespace, sender, invitation, "Receiver");
    await installMockSavePicker(receiver);
    await selectRecipient(sender, "Receiver");

    await sender.locator("#send-file").setInputFiles({
      name: "premature-data.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(64 * 1024, 0x5a),
    });

    const incoming = receiver.locator(".incoming-transfer", { hasText: "premature-data.bin" });
    await expect(incoming).toBeVisible();
    await expect(incoming).toHaveAttribute("data-finished", "true", { timeout: 3_000 });
    await expect(incoming.locator(".save-file")).toBeDisabled();
    await expect(incoming.locator(".reject-file")).toBeDisabled();
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.state.file)).toBe("idle");

    const outgoing = sender.locator(".transfer-item", { hasText: "premature-data.bin" });
    await expect(outgoing).toHaveAttribute("data-finished", "true", { timeout: 3_000 });
    await expect(outgoing.locator('[data-status="failed"]')).toHaveCount(1);
    await expect.poll(() => sender.evaluate(() => globalThis.__prematureGroupData.peerClosed)).toBe(true);

    expect(await sender.evaluate(() => globalThis.__prematureGroupData)).toMatchObject({
      offerSeen: true,
      injected: true,
      declaredBodyBytes: 64 * 1024,
      injectedHeadBytes: 5,
      injectedBodyBytes: 2048,
      applicationBytesAfterInjection: 0,
      applicationCloseWriteAfterInjection: false,
      peerClosed: true,
      localClosed: true,
    });
    expect(await receiver.evaluate(() => globalThis.__mockSave.pickerCalls)).toBe(0);
    expect(await receiver.evaluate(() => globalThis.__mockSave.totalBytes)).toBe(0);
    await expect(receiver.locator("#history .message:not(.system)")).toHaveCount(0);
    await expect(sender.locator("#history .message:not(.system)")).toHaveCount(0);
    await expect.poll(() => receiver.evaluate(() => globalThis.__mockTailcat.snapshot().records.some(
      ({ port, direction, closed }) => port === 102 && direction === "inbound" && closed,
    ))).toBe(true);
  } finally {
    await context.close();
  }
});

test("a premature group voice DATA head is rejected without reading its declared 10 MiB body", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-voice-preconsent-data-${Date.now()}`;
  try {
    const { page: sender, invitation } = await createGroupHost(context, namespace);
    await installPrematureGroupDataInjector(sender, "voice");
    const receiver = await joinGroup(context, namespace, sender, invitation, "Receiver");
    await installMockVoiceMedia(sender);
    await sender.evaluate((voiceBytes) => {
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
      class LargeVoiceMediaRecorder {
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
            this.ondataavailable?.({
              data: new Blob([new Uint8Array(voiceBytes)], { type: this.mimeType }),
            });
            this.onstop?.();
          });
        }
      }
      Object.defineProperty(globalThis, "MediaRecorder", {
        configurable: true,
        value: LargeVoiceMediaRecorder,
      });
    }, 10 * 1024 * 1024);
    await selectRecipient(sender, "Receiver");

    await sender.locator("#ptt-btn").dispatchEvent("pointerdown", { pointerId: 1 });
    await expect(sender.locator("#ptt-btn")).toHaveClass(/recording/u);
    await sender.locator("body").dispatchEvent("pointerup", { pointerId: 1 });

    const incoming = receiver.locator(".incoming-voice-transfer");
    await expect(incoming).toHaveCount(1);
    await expect(incoming).toHaveAttribute("data-finished", "true", { timeout: 3_000 });
    await expect(incoming.locator(".save-file")).toBeHidden();
    await expect(incoming.locator(".reject-file")).toBeHidden();

    const outgoing = sender.locator(".transfer-item", { hasText: "Hold to record voice note" });
    await expect(outgoing).toHaveAttribute("data-finished", "true", { timeout: 3_000 });
    await expect(outgoing.locator('[data-status="failed"]')).toHaveCount(1);
    await expect.poll(() => sender.evaluate(() => globalThis.__prematureGroupData.peerClosed)).toBe(true);

    const attack = await sender.evaluate(() => globalThis.__prematureGroupData);
    expect(attack).toMatchObject({
      offerSeen: true,
      injected: true,
      declaredBodyBytes: 10 * 1024 * 1024,
      injectedBodyBytes: 2048,
      applicationBytesAfterInjection: 0,
      applicationCloseWriteAfterInjection: false,
      peerClosed: true,
      localClosed: true,
    });
    expect(attack.injectedHeadBytes).toBeGreaterThan(12);
    expect(attack.injectedHeadBytes).toBeLessThan(1024);
    await expect(receiver.locator("#history audio")).toHaveCount(0);
    await expect(sender.locator("#history audio")).toHaveCount(0);
    await expect(receiver.locator("#history .message:not(.system)")).toHaveCount(0);
    await expect(sender.locator("#history .message:not(.system)")).toHaveCount(0);
    await expect.poll(() => receiver.evaluate(() => globalThis.__mockTailcat.snapshot().records.some(
      ({ port, direction, closed }) => port === 103 && direction === "inbound" && closed,
    ))).toBe(true);
  } finally {
    await context.close();
  }
});

test("a stale capacity probe cannot recreate file consent after its group room closes", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-file-stale-capacity-${Date.now()}`;
  try {
    // Open the receiver first so it owns OPFS and every support refresh must
    // await navigator.storage.estimate; a second tab may skip that probe.
    const receiver = await openMockPage(context, namespace, { group: true });
    const { page: sender, invitation } = await createGroupHost(context, namespace);
    await requestJoin(receiver, invitation, "Receiver");
    await approve(sender, "Receiver");
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.group.mode)).toBe("member");
    await installMockSavePicker(receiver);
    await receiver.evaluate(() => {
      let release;
      const probe = {
        calls: 0,
        resolvedCalls: 0,
        released: false,
        release() {
          if (probe.released) return;
          probe.released = true;
          release({ quota: 4 * 1024 ** 3, usage: 0 });
        },
      };
      const gate = new Promise((resolve) => { release = resolve; });
      Object.defineProperty(navigator.storage, "estimate", {
        configurable: true,
        value: () => {
          probe.calls += 1;
          return gate.then((estimate) => {
            probe.resolvedCalls += 1;
            return estimate;
          });
        },
      });
      globalThis.__capacityProbe = probe;
    });
    await selectRecipient(sender, "Receiver");

    await sender.locator("#send-file").setInputFiles({
      name: "stale-capacity.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("capacity probe must not outlive its room"),
    });
    await expect.poll(() => receiver.evaluate(() => globalThis.__capacityProbe.calls)).toBeGreaterThan(0);
    await expect(receiver.locator(".incoming-transfer", { hasText: "stale-capacity.bin" })).toHaveCount(0);

    await receiver.locator("#group-leave-room-btn").click();
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
    await receiver.evaluate(() => globalThis.__capacityProbe.release());
    await expect.poll(() => receiver.evaluate(() => (
      globalThis.__capacityProbe.resolvedCalls === globalThis.__capacityProbe.calls
    ))).toBe(true);
    await receiver.waitForTimeout(100);

    await expect(receiver.locator(".incoming-transfer", { hasText: "stale-capacity.bin" })).toHaveCount(0);
    await expect(receiver.locator("#transfer-list .transfer-item")).toHaveCount(0);
    await expect(receiver.locator("#history .message:not(.system)")).toHaveCount(0);
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.state.file)).toBe("idle");
  } finally {
    await context.close();
  }
});

test("closing an old room clears transfer and invitation UI without contaminating a new room", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-room-transfer-cleanup-${Date.now()}`;
  try {
    const { page: host, invitation: oldInvitation } = await createGroupHost(context, namespace, "Old Host");
    const receiver = await joinGroup(context, namespace, host, oldInvitation, "Receiver");
    await installMockSavePicker(receiver);
    await selectRecipient(host, "Receiver");

    await host.locator("#send-file").setInputFiles({
      name: "old-complete.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("completed in the old room"),
    });
    const completedIncoming = receiver.locator(".incoming-transfer", { hasText: "old-complete.bin" });
    await expect(completedIncoming).toBeVisible();
    await completedIncoming.locator(".save-file").click();
    await expect(host.locator(".transfer-item", { hasText: "old-complete.bin" })).toHaveAttribute("data-finished", "true");

    await host.clock.install();
    const finalWritesBefore = await host.evaluate(() => globalThis.__mockTailcat.snapshot().fileFinalWritesStarted);
    await host.evaluate(() => globalThis.__mockTailcat.failNextFileFinal("late old-room final", 40_000));
    await host.locator("#send-file").setInputFiles({
      name: "old-active.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("still active while the old room closes"),
    });
    const activeIncoming = receiver.locator(".incoming-transfer", { hasText: "old-active.bin" });
    await expect(activeIncoming).toBeVisible();
    await activeIncoming.locator(".save-file").click();
    await expect.poll(() => host.evaluate(() => globalThis.__mockTailcat.snapshot().fileFinalWritesStarted)).toBeGreaterThan(finalWritesBefore);

    await host.locator("#group-show-qr-btn").click();
    await expect(host.locator("#qr-dialog")).toBeVisible();
    expect(await host.locator("#qr-canvas").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let nonBlack = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] || pixels[index + 1] || pixels[index + 2]) nonBlack += 1;
      }
      return nonBlack;
    })).toBeGreaterThan(0);

    // A real lifecycle/host-close can happen while the modal is open. Invoke
    // the existing close control's handler without dismissing the QR first.
    await host.locator("#group-close-room-btn").evaluate((button) => button.click());
    await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
    await expect(host.locator("#transfer-list > li")).toHaveCount(0);
    await expect(host.locator("#transfer-tray")).toHaveClass(/hidden/u);
    await expect(host.locator("#group-invite-link")).toHaveText("");
    await expect(host.locator("#qr-dialog")).not.toBeVisible();
    const clearedQR = await host.locator("#qr-canvas").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let nonBlack = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] || pixels[index + 1] || pixels[index + 2]) nonBlack += 1;
      }
      return { width: canvas.width, height: canvas.height, nonBlack };
    });
    expect(clearedQR).toEqual({ width: 320, height: 320, nonBlack: 0 });

    await host.locator("#group-create-entry-btn").click();
    await host.locator("#group-create-nickname").fill("New Host");
    await host.locator("#group-create-btn").click();
    await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.mode)).toBe("owner");
    const newInvitation = await host.locator("#group-invite-link").textContent();
    expect(newInvitation).toMatch(/^https:\/\/tailcat\.app\/#v=1&mode=group&/u);
    expect(newInvitation).not.toBe(oldInvitation);

    // Complete the old room's delayed task only after the replacement room is
    // active. Its catch/finally path must remain scoped to the old room.
    await host.clock.fastForward(31_000);
    await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.mode)).toBe("owner");
    await expect(host.locator("#group-invite-link")).toHaveText(newInvitation);
    await expect(host.locator("#transfer-list > li")).toHaveCount(0);
    await expect(host.locator("#status")).toContainText(/group room active/iu);
    await expect(host.locator("body")).not.toContainText(/old-complete\.bin|old-active\.bin/u);
  } finally {
    await context.close();
  }
});

test("a stalled receiver DONE write times out and releases its file lane", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-file-done-deadline-${Date.now()}`;
  try {
    const { page: sender, invitation } = await createGroupHost(context, namespace);
    const receiver = await joinGroup(context, namespace, sender, invitation, "Receiver");
    await installMockSavePicker(receiver);
    await selectRecipient(sender, "Receiver");
    await receiver.clock.install();
    await receiver.evaluate(() => globalThis.__mockTailcat.failNextFileFinal("stalled DONE", 40_000));

    await sender.locator("#send-file").setInputFiles({
      name: "stalled-done.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("locally verified before DONE stalls"),
    });
    const incoming = receiver.locator(".incoming-transfer", { hasText: "stalled-done.bin" });
    await expect(incoming).toBeVisible();
    await incoming.locator(".save-file").click();
    await expect.poll(() => receiver.evaluate(() => globalThis.__mockTailcat.snapshot().fileFinalWritesStarted)).toBeGreaterThan(0);

    await receiver.clock.fastForward(31_000);
    await expect(incoming).toHaveAttribute("data-finished", "true", { timeout: 3_000 });
    await expect(incoming.locator(".transfer-detail")).toContainText(/confirmation.*unknown/u);
    expect(await receiver.evaluate(() => ({
      closed: globalThis.__mockSave.closed,
      aborted: globalThis.__mockSave.aborted,
      fileState: globalThis.tcTest.state.file,
    }))).toEqual({ closed: true, aborted: false, fileState: "idle" });

    await sender.locator("#send-file").setInputFiles({
      name: "after-done-timeout.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("lane is available again"),
    });
    const next = receiver.locator(".incoming-transfer", { hasText: "after-done-timeout.bin" });
    await expect(next).toBeVisible();
    await next.locator(".reject-file").click();
  } finally {
    await context.close();
  }
});

test("a stalled receiver closeWrite times out and releases its file lane", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-file-close-write-deadline-${Date.now()}`;
  try {
    const { page: sender, invitation } = await createGroupHost(context, namespace);
    const receiver = await openMockPage(context, namespace, { group: true });
    await receiver.evaluate(() => {
      const originalListen = globalThis.tailcatListen;
      globalThis.tailcatListen = async (options) => originalListen({
        ...options,
        onConnection(connection) {
          if (connection.port === 102) {
            const originalCloseWrite = connection.closeWrite.bind(connection);
            connection.closeWrite = async () => {
              globalThis.__stalledFileCloseWrite = (globalThis.__stalledFileCloseWrite || 0) + 1;
              await new Promise((resolve) => setTimeout(resolve, 40_000));
              return originalCloseWrite();
            };
          }
          options.onConnection(connection);
        },
      });
    });
    await requestJoin(receiver, invitation, "Receiver");
    await approve(sender, "Receiver");
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.group.mode)).toBe("member");
    await installMockSavePicker(receiver);
    await selectRecipient(sender, "Receiver");
    await receiver.clock.install();

    await sender.locator("#send-file").setInputFiles({
      name: "stalled-close-write.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("DONE succeeds before closeWrite stalls"),
    });
    const incoming = receiver.locator(".incoming-transfer", { hasText: "stalled-close-write.bin" });
    await expect(incoming).toBeVisible();
    await incoming.locator(".save-file").click();
    await expect.poll(() => receiver.evaluate(() => globalThis.__stalledFileCloseWrite || 0)).toBe(1);

    await receiver.clock.fastForward(31_000);
    await expect(incoming).toHaveAttribute("data-finished", "true", { timeout: 3_000 });
    expect(await receiver.evaluate(() => globalThis.tcTest.state.file)).toBe("idle");

    await sender.locator("#send-file").setInputFiles({
      name: "after-close-write-timeout.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("lane is available again"),
    });
    const next = receiver.locator(".incoming-transfer", { hasText: "after-close-write-timeout.bin" });
    await expect(next).toBeVisible();
    await next.locator(".reject-file").click();
  } finally {
    await context.close();
  }
});

test("TCF1 offer parsing has one absolute deadline across slow-drip chunks", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-file-offer-deadline-${Date.now()}`;
  try {
    const { page: receiver } = await createGroupHost(context, namespace);
    const attacker = await openMockPage(context, namespace, { group: true });
    await receiver.clock.install();
    const address = await receiver.evaluate(() => globalThis.__mockTailcat.snapshot().listenerAddress);

    await attacker.evaluate(async (target) => {
      const connection = await globalThis.tailcatDial({ addr: target, port: 102 });
      globalThis.__slowTCF = { connection, ended: false };
      void connection.read().then(
        (value) => { globalThis.__slowTCF.ended = value === null; },
        () => { globalThis.__slowTCF.ended = true; },
      );
      await connection.write(new Uint8Array([0x54]));
    }, address);
    await expect.poll(() => receiver.evaluate(() => globalThis.__mockTailcat.snapshot().records.filter(
      ({ port, direction }) => port === 102 && direction === "inbound",
    ).length)).toBe(1);

    await receiver.clock.fastForward(20_000);
    await attacker.evaluate(() => globalThis.__slowTCF.connection.write(new Uint8Array([0x43])));
    await receiver.waitForTimeout(100);
    await receiver.clock.fastForward(15_000);

    await expect.poll(() => attacker.evaluate(() => globalThis.__slowTCF.ended), { timeout: 3_000 }).toBe(true);
    await expect.poll(() => receiver.evaluate(() => globalThis.__mockTailcat.snapshot().records.some(
      ({ port, direction, closed }) => port === 102 && direction === "inbound" && closed,
    ))).toBe(true);
  } finally {
    await context.close();
  }
});

test("TCF1 recipient decision parsing cannot extend its deadline by dripping bytes", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-file-decision-deadline-${Date.now()}`;
  try {
    const { page: sender, invitation } = await createGroupHost(context, namespace);
    const receiver = await openMockPage(context, namespace, { group: true });
    await receiver.evaluate(() => {
      const originalListen = globalThis.tailcatListen;
      globalThis.tailcatListen = async (options) => originalListen({
        ...options,
        onConnection(connection) {
          if (connection.port !== 102) {
            options.onConnection(connection);
            return;
          }
          void (async () => {
            let buffered = new Uint8Array();
            const readExact = async (length) => {
              while (buffered.length < length) {
                const chunk = await connection.read();
                if (chunk === null) throw new Error("unexpected file offer EOF");
                const merged = new Uint8Array(buffered.length + chunk.length);
                merged.set(buffered);
                merged.set(chunk, buffered.length);
                buffered = merged;
              }
              const result = buffered.slice(0, length);
              buffered = buffered.slice(length);
              return result;
            };
            const magic = await readExact(4);
            if (String.fromCharCode(...magic) !== "TCF1") throw new Error("bad test offer");
            const header = await readExact(5);
            const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(1, false);
            const offer = JSON.parse(new TextDecoder().decode(await readExact(length)));
            const response = new TextEncoder().encode(JSON.stringify({
              type: "ACCEPT",
              v: offer.v,
              mode: offer.mode,
              gv: offer.gv,
              roomId: offer.roomId,
              senderId: offer.senderId,
              recipientId: offer.recipientId,
              transferId: offer.transferId,
            }));
            const wire = new Uint8Array(5 + response.length);
            wire[0] = 1;
            new DataView(wire.buffer).setUint32(1, response.length, false);
            wire.set(response, 5);
            globalThis.__slowDecision = { connection, wire, index: 0 };
          })();
        },
      });
    });
    await requestJoin(receiver, invitation, "Slow Receiver");
    await approve(sender, "Slow Receiver");
    await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.group.mode)).toBe("member");
    await selectRecipient(sender, "Slow Receiver");
    await sender.clock.install();

    await sender.locator("#send-file").setInputFiles({
      name: "slow-decision.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("decision deadline"),
    });
    await expect.poll(() => receiver.evaluate(() => Boolean(globalThis.__slowDecision))).toBe(true);

    // The production decision budget is 245 seconds: ticket control, bounded
    // capacity/framing work, the complete 120-second consent window, and grace.
    // Keep every individual read under 30 seconds while exceeding that total.
    for (let index = 0; index < 10; index += 1) {
      await receiver.evaluate(async () => {
        const state = globalThis.__slowDecision;
        await state.connection.write(state.wire.slice(state.index, state.index + 1));
        state.index += 1;
      });
      if (index < 9) {
        await sender.waitForTimeout(50);
        await sender.clock.fastForward(25_000);
      }
    }
    await sender.waitForTimeout(50);
    await sender.clock.fastForward(25_000);

    const outgoing = sender.locator(".transfer-item", { hasText: "slow-decision.bin" });
    await expect(outgoing).toHaveAttribute("data-finished", "true", { timeout: 3_000 });
    await expect(outgoing.locator('[data-status="failed"]')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("TCF1 data writes are bounded by an absolute chunk deadline", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-file-data-deadline-${Date.now()}`;
  try {
    const { page: sender, invitation } = await createGroupHost(context, namespace);
    const receiver = await joinGroup(context, namespace, sender, invitation, "Receiver");
    await installMockSavePicker(receiver);
    await selectRecipient(sender, "Receiver");
    await sender.clock.install();
    await sender.evaluate(() => globalThis.__mockTailcat.setFileWriteDelay(40_000));

    await sender.locator("#send-file").setInputFiles({
      name: "slow-data.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(1024, 0x5a),
    });
    const incoming = receiver.locator(".incoming-transfer", { hasText: "slow-data.bin" });
    await expect(incoming).toBeVisible();
    await incoming.locator(".save-file").click();
    const outgoing = sender.locator(".transfer-item", { hasText: "slow-data.bin" });
    await expect(outgoing.locator('[data-status="transferring"]')).toHaveCount(1);

    await sender.clock.fastForward(31_000);
    await expect(outgoing).toHaveAttribute("data-finished", "true", { timeout: 3_000 });
    await expect(outgoing.locator('[data-status="failed"]')).toHaveCount(1);
    await expect(incoming).toHaveAttribute("data-finished", "true", { timeout: 3_000 });
  } finally {
    await context.close();
  }
});
