import { expect, test } from "@playwright/test";
import { installMockSavePicker, installMockVoiceMedia, openMockPage } from "./mock-tailcat.js";

async function createGroupHost(context, namespace, name = "Host") {
  const page = await openMockPage(context, namespace, { group: true });
  await expect(page.locator("#group-create-entry")).not.toHaveClass(/hidden/u);
  await page.locator("#group-create-entry-btn").click();
  await page.locator("#group-create-nickname").fill(name);
  await page.locator("#group-create-btn").click();
  await expect.poll(() => page.evaluate(() => globalThis.tcTest.group.mode)).toBe("owner");
  const invitation = await page.locator("#group-invite-link").textContent();
  expect(invitation).toMatch(/^https:\/\/tailcat\.app\/#v=1&mode=group&gv=1&invite=tc/u);
  return { page, invitation };
}

async function requestJoin(page, invitation, name, { expectPending = true } = {}) {
  await page.evaluate((value) => { location.hash = new URL(value).hash; }, invitation);
  await expect(page.locator("#group-join-dialog")).toBeVisible();
  await page.locator("#group-join-nickname").fill(name);
  await page.locator("#group-join-btn").click();
  if (expectPending) await expect.poll(() => page.evaluate(() => globalThis.tcTest.group.mode)).toBe("pending");
}

async function approve(page, name) {
  const request = page.locator(".group-pending-item", { hasText: name });
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

async function sendText(page, text) {
  await page.locator("#send-text").fill(text);
  await page.locator("#send-text-btn").click();
  await expect(page.locator("#send-text")).toHaveValue("");
}

test("Group Beta stays hidden behind its independent production switch", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => globalThis.tcTest?.ready === true);
  await expect(page.locator("#group-create-entry")).toHaveClass(/hidden/u);
  expect(await page.evaluate(() => globalThis.tcTest.group.enabled)).toBe(false);
});

test("a malformed group invitation fails closed instead of dialing the private protocol", async ({ browser }) => {
  const context = await browser.newContext();
  const address = `tc${"a".repeat(64)}`;
  const fragment = `#v=1&mode=group&gv=2&invite=${address}&room=${"A".repeat(22)}&join=${"B".repeat(43)}`;
  const page = await openMockPage(context, `group-invalid-${Date.now()}`, { group: true, url: `/${fragment}` });
  await expect(page.locator("#group-join-dialog")).not.toBeVisible();
  await expect(page.locator("#send-addr")).toHaveValue("");
  expect(await page.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
  expect(await page.evaluate(() => globalThis.__mockTailcat.snapshot().records)).toEqual([]);
  await context.close();
});

test("a protected preview keeps generated invitations on its own HTTPS origin", async ({ browser }) => {
  const context = await browser.newContext();
  await context.route("https://127.0.0.1:4173/**", async (route) => {
    const response = await context.request.fetch(route.request().url().replace(/^https:/u, "http:"));
    await route.fulfill({ response });
  });
  const page = await openMockPage(context, `group-preview-${Date.now()}`, {
    group: true,
    previewInvites: true,
    url: "https://127.0.0.1:4173/",
  });
  await page.locator("#group-create-entry-btn").click();
  await page.locator("#group-create-nickname").fill("Preview Host");
  await page.locator("#group-create-btn").click();
  await expect.poll(() => page.evaluate(() => globalThis.tcTest.group.mode)).toBe("owner");
  await expect(page.locator("#group-invite-link")).toHaveText(/^https:\/\/127\.0\.0\.1:4173\/#v=1&mode=group&/u);
  await context.close();
});

test("cancelling group creation while the listener starts cannot create a late room", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await openMockPage(context, `group-create-cancel-${Date.now()}`, { group: true });
  await page.evaluate(() => {
    const originalListen = globalThis.tailcatListen;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.__releaseDelayedGroupListen = release;
    globalThis.tailcatListen = async (options) => {
      await gate;
      return originalListen(options);
    };
  });

  await page.locator("#group-create-entry-btn").click();
  await page.locator("#group-create-nickname").fill("Cancelled Host");
  await page.locator("#group-create-btn").click();
  await page.locator("#group-create-cancel-btn").click();
  await page.evaluate(() => globalThis.__releaseDelayedGroupListen());

  await expect.poll(() => page.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
  await expect.poll(() => page.evaluate(() => globalThis.__mockTailcat.snapshot().listenerAddress)).toBeNull();
  await page.locator("#listen-btn").click();
  await expect.poll(() => page.evaluate(() => globalThis.tcTest.state.room)).toBe("open");
  await context.close();
});

test("owner approval performs callback verification and commits ordered text", async ({ browser }) => {
  const context = await browser.newContext();
  const namespace = `group-basic-${Date.now()}`;
  const { page: host, invitation } = await createGroupHost(context, namespace, "Owner Cat");
  const alice = await joinGroup(context, namespace, host, invitation, "Alice");
  const bob = await joinGroup(context, namespace, host, invitation, "Alice");

  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.members)).toBe(3);
  await expect(host.locator("#group-members-list .group-member-item")).toHaveCount(3);
  await expect(alice.locator("#group-members-list")).toContainText("Owner Cat");
  await expect(alice.locator("#group-members-list code")).toHaveCount(3);

  await sendText(alice, "first from Alice");
  await sendText(host, "second from host");
  await sendText(bob, "third from duplicate nickname");

  for (const page of [host, alice, bob]) {
    const messages = page.locator("#history .message:not(.system) .bubble");
    await expect(messages).toHaveCount(3);
    await expect(messages.nth(0)).toHaveText("first from Alice");
    await expect(messages.nth(1)).toHaveText("second from host");
    await expect(messages.nth(2)).toHaveText("third from duplicate nickname");
  }

  await context.close();
});

test("rejection, invitation rotation, removal, and host close are isolated", async ({ browser }) => {
  const context = await browser.newContext();
  const namespace = `group-controls-${Date.now()}`;
  const { page: host, invitation: oldInvitation } = await createGroupHost(context, namespace);

  const rejected = await openMockPage(context, namespace, { group: true });
  await requestJoin(rejected, oldInvitation, "Rejected");
  const rejectedRequest = host.locator(".group-pending-item", { hasText: "Rejected" });
  await rejectedRequest.locator(".group-reject-join").click();
  await expect.poll(() => rejected.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
  await expect(rejected.locator("#status")).toContainText(/declined|拒绝/u);

  await host.locator("#group-rotate-invite-btn").click();
  const newInvitation = await host.locator("#group-invite-link").textContent();
  expect(newInvitation).not.toBe(oldInvitation);
  const stale = await openMockPage(context, namespace, { group: true });
  await requestJoin(stale, oldInvitation, "Stale", { expectPending: false });
  await expect.poll(() => stale.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
  await expect(stale.locator("#status")).toContainText(/invalid|失效|无效/u);

  await host.locator("#group-pause-joins-btn").click();
  await expect(host.locator("#group-pause-joins-btn")).toContainText("Resume joining");
  const paused = await openMockPage(context, namespace, { group: true });
  await requestJoin(paused, newInvitation, "Paused", { expectPending: false });
  await expect.poll(() => paused.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
  await expect(paused.locator("#status")).toContainText(/paused|暂停/u);
  await host.locator("#group-pause-joins-btn").click();

  const member = await joinGroup(context, namespace, host, newInvitation, "Member");
  const memberRow = host.locator(".group-member-item", { hasText: "Member" });
  await memberRow.locator(".group-remove-member").click();
  await expect.poll(() => member.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
  await expect(member.locator("#status")).toContainText(/removed|移出/u);

  const survivor = await joinGroup(context, namespace, host, newInvitation, "Survivor");
  await host.locator("#group-close-room-btn").click();
  await expect.poll(() => survivor.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
  await expect(survivor.locator("#status")).toContainText(/host left|房主/u);
  await context.close();
});

test("a host closing while approval is pending releases the applicant listener", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-pending-close-${Date.now()}`;
  const { page: host, invitation } = await createGroupHost(context, namespace);
  const applicant = await openMockPage(context, namespace, { group: true });
  await requestJoin(applicant, invitation, "Waiting Applicant");
  await expect(host.locator(".group-pending-item", { hasText: "Waiting Applicant" })).toBeVisible();

  await host.locator("#group-close-room-btn").click();
  await expect.poll(() => applicant.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
  await expect.poll(() => applicant.evaluate(() => globalThis.__mockTailcat.snapshot().listenerAddress)).toBeNull();

  await applicant.locator("#listen-btn").click();
  await expect.poll(() => applicant.evaluate(() => globalThis.tcTest.state.room)).toBe("open");
  await context.close();
});

test("pending countdown updates preserve approval focus and translated template controls", async ({ browser }) => {
  const context = await browser.newContext({ locale: "zh-CN" });
  const namespace = `group-pending-focus-${Date.now()}`;
  const { page: host, invitation } = await createGroupHost(context, namespace, "房主");
  const applicant = await openMockPage(context, namespace, { group: true });
  await requestJoin(applicant, invitation, "申请者");
  const request = host.locator(".group-pending-item", { hasText: "申请者" });
  const approveButton = request.locator(".group-approve-join");
  await expect(approveButton).toHaveText("批准");
  await expect(request.locator(".group-reject-join")).toHaveText("拒绝");
  await approveButton.focus();
  const requestId = await request.getAttribute("data-request-id");
  await host.waitForTimeout(1_150);
  expect(await host.evaluate((expected) => (
    document.activeElement?.classList.contains("group-approve-join")
      && document.activeElement.closest(".group-pending-item")?.dataset.requestId === expected
  ), requestId)).toBe(true);
  await approveButton.press("Enter");
  await expect.poll(() => applicant.evaluate(() => globalThis.tcTest.group.mode)).toBe("member");
  await expect(host.locator(".group-member-item", { hasText: "申请者" }).locator(".group-remove-member")).toHaveText("移除");
  await context.close();
});

test("one group file goes directly to selected recipients with independent outcomes", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-file-${Date.now()}`;
  const { page: host, invitation } = await createGroupHost(context, namespace);
  const alice = await joinGroup(context, namespace, host, invitation, "Alice");
  const bob = await joinGroup(context, namespace, host, invitation, "Bob");
  await installMockSavePicker(alice);
  await installMockSavePicker(bob);

  await host.locator("#group-recipient-all").check();
  await expect(host.locator("#group-recipient-summary")).toContainText("2 recipients");
  await host.locator("#send-file").setInputFiles({
    name: "group-direct.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("direct to two recipients"),
  });

  const aliceOffer = alice.locator(".incoming-transfer", { hasText: "group-direct.bin" });
  const bobOffer = bob.locator(".incoming-transfer", { hasText: "group-direct.bin" });
  await expect(aliceOffer).toBeVisible();
  await expect(bobOffer).toBeVisible();
  await aliceOffer.locator(".save-file").click();
  await bobOffer.locator(".reject-file").click();

  const outgoing = host.locator(".transfer-item", { hasText: "group-direct.bin" });
  await expect(outgoing.locator('[data-status="complete"]')).toHaveCount(1);
  await expect(outgoing.locator('[data-status="rejected"]')).toHaveCount(1);
  await host.locator("#language-select").selectOption("zh");
  await expect(outgoing.locator('[data-status="complete"] .group-transfer-recipient-status')).toHaveText("已完成");
  await expect(outgoing.locator('[data-status="rejected"] .group-transfer-recipient-status')).toHaveText("已拒绝");
  expect(await alice.evaluate(() => globalThis.__mockSave.totalBytes)).toBe(24);
  expect(await bob.evaluate(() => globalThis.__mockSave.pickerCalls)).toBe(0);

  const hostTransport = await host.evaluate(() => globalThis.__mockTailcat.snapshot());
  expect(hostTransport.records.filter(({ port, direction }) => port === 102 && direction === "outbound")).toHaveLength(2);
  await context.close();
});

test("member-to-member files and voice bypass a non-recipient host", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-member-direct-${Date.now()}`;
  const { page: host, invitation } = await createGroupHost(context, namespace);
  const alice = await joinGroup(context, namespace, host, invitation, "Alice Sender");
  const bob = await joinGroup(context, namespace, host, invitation, "Bob Receiver");
  await installMockSavePicker(bob);
  await installMockVoiceMedia(alice);

  await alice.locator("#group-recipient-list .group-recipient-option", { hasText: "Bob Receiver" })
    .locator("input").check();
  await alice.locator("#send-file").setInputFiles({
    name: "member-only-secret.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("member direct payload"),
  });
  const fileOffer = bob.locator(".incoming-transfer", { hasText: "member-only-secret.bin" });
  await expect(fileOffer).toBeVisible();
  await fileOffer.locator(".save-file").click();
  await expect(alice.locator('.transfer-item[data-finished="true"]', { hasText: "member-only-secret.bin" })).toBeVisible();

  await alice.locator("#ptt-btn").dispatchEvent("pointerdown", { pointerId: 1 });
  await expect(alice.locator("#ptt-btn")).toHaveClass(/recording/u);
  await alice.locator("body").dispatchEvent("pointerup", { pointerId: 1 });
  const voiceOffer = bob.locator(".incoming-voice-transfer");
  await expect(voiceOffer).toBeVisible();
  await voiceOffer.locator(".save-file").click();
  await expect(bob.locator("#history audio")).toHaveCount(1);

  const hostTransport = await host.evaluate(() => globalThis.__mockTailcat.snapshot());
  expect(hostTransport.records.filter(({ port }) => port === 102 || port === 103)).toEqual([]);
  await expect(host.locator("#history")).not.toContainText("member-only-secret.bin");
  await expect(host.locator("#history audio")).toHaveCount(0);
  await context.close();
});

test("late group transfer diagnostics remain category-only after the receiver leaves", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-diagnostic-redaction-${Date.now()}`;
  const { page: host, invitation } = await createGroupHost(context, namespace);
  const sender = await joinGroup(context, namespace, host, invitation, "Sensitive Nickname");
  const receiver = await joinGroup(context, namespace, host, invitation, "Receiver");
  await installMockSavePicker(receiver);
  await sender.locator("#group-recipient-list .group-recipient-option", { hasText: "Receiver" })
    .locator("input").check();
  const sensitive = `tc${"z".repeat(64)} 203.0.113.9 https://tailcat.dev/derpmap.json Sensitive Nickname secret-file.bin secret-message`;
  await receiver.evaluate((message) => {
    globalThis.__mockTailcat.failNextFileFinal(message, 500);
  }, sensitive);
  await sender.locator("#send-file").setInputFiles({
    name: "secret-file.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("secret-message"),
  });
  const offer = receiver.locator(".incoming-transfer", { hasText: "secret-file.bin" });
  await expect(offer).toBeVisible();
  await offer.locator(".save-file").click();
  await expect.poll(() => receiver.evaluate(() => globalThis.__mockTailcat.snapshot().fileFinalWritesStarted)).toBeGreaterThan(0);
  await receiver.locator("#group-leave-room-btn").click();
  await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
  await expect.poll(() => receiver.evaluate(() => globalThis.tcTest.errors.length)).toBeGreaterThan(0);
  const diagnostics = await receiver.evaluate(() => [...globalThis.tcTest.errors]);
  expect(diagnostics.every((value) => /^GROUP_[A-Z_]+$/u.test(value))).toBe(true);
  expect(JSON.stringify(diagnostics)).not.toMatch(/203\.0\.113\.9|tailcat\.dev|Sensitive Nickname|secret-file|secret-message|tcz{20}/u);
  await context.close();
});

test("a voice note uses tickets and only reaches selected group members", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-voice-${Date.now()}`;
  const { page: host, invitation } = await createGroupHost(context, namespace);
  const alice = await joinGroup(context, namespace, host, invitation, "Alice");
  const bob = await joinGroup(context, namespace, host, invitation, "Bob");
  await installMockVoiceMedia(host);

  await host.locator("#group-recipient-list .group-recipient-option", { hasText: "Alice" })
    .locator("input").check();
  await expect(host.locator("#ptt-btn")).toBeEnabled();
  await host.locator("#ptt-btn").dispatchEvent("pointerdown", { pointerId: 1 });
  await expect(host.locator("#ptt-btn")).toHaveClass(/recording/u);
  // The privacy boundary is the selection at recording start. Later checkbox
  // changes apply only to the next voice note.
  await host.locator("#group-recipient-list .group-recipient-option", { hasText: "Alice" })
    .locator("input").uncheck();
  await host.locator("#group-recipient-list .group-recipient-option", { hasText: "Bob" })
    .locator("input").check();
  await host.locator("body").dispatchEvent("pointerup", { pointerId: 1 });

  const offer = alice.locator(".incoming-voice-transfer");
  await expect(offer).toBeVisible();
  await expect(bob.locator(".incoming-voice-transfer")).toHaveCount(0);
  await expect(alice.locator("#history audio")).toHaveCount(0);
  await offer.locator(".save-file").click();
  await expect(alice.locator("#history audio")).toHaveCount(1);
  await expect(bob.locator("#history audio")).toHaveCount(0);
  await expect(host.locator("#history audio")).toHaveCount(1);
  const transport = await host.evaluate(() => globalThis.__mockTailcat.snapshot());
  expect(transport.records.filter(({ port, direction }) => port === 103 && direction === "outbound")).toHaveLength(1);
  await context.close();
});

test("group voice recipients independently accept or decline before payload delivery", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-voice-decisions-${Date.now()}`;
  const { page: host, invitation } = await createGroupHost(context, namespace);
  const alice = await joinGroup(context, namespace, host, invitation, "Alice");
  const bob = await joinGroup(context, namespace, host, invitation, "Bob");
  await installMockVoiceMedia(host);

  await host.locator("#group-recipient-all").check();
  await host.locator("#ptt-btn").dispatchEvent("pointerdown", { pointerId: 1 });
  await expect(host.locator("#ptt-btn")).toHaveClass(/recording/u);
  await host.locator("body").dispatchEvent("pointerup", { pointerId: 1 });

  const aliceOffer = alice.locator(".incoming-voice-transfer");
  const bobOffer = bob.locator(".incoming-voice-transfer");
  await expect(aliceOffer).toBeVisible();
  await expect(bobOffer).toBeVisible();
  await aliceOffer.locator(".save-file").click();
  await bobOffer.locator(".reject-file").click();

  const outgoing = host.locator(".transfer-item", { hasText: "Hold to record voice note" });
  await expect(outgoing.locator('[data-status="complete"]')).toHaveCount(1);
  await expect(outgoing.locator('[data-status="rejected"]')).toHaveCount(1);
  await expect(alice.locator("#history audio")).toHaveCount(1);
  await expect(bob.locator("#history audio")).toHaveCount(0);
  await expect(host.locator("#history audio")).toHaveCount(1);
  await context.close();
});

test("one disconnected member resumes in memory and receives ordered buffered events", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-resume-${Date.now()}`;
  const { page: host, invitation } = await createGroupHost(context, namespace);
  const member = await joinGroup(context, namespace, host, invitation, "Resumer");

  await member.evaluate(() => {
    globalThis.__mockTailcat.setFailGroupDials(true);
    globalThis.__mockTailcat.closeConnections({ port: 104, direction: "outbound" });
  });
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.online)).toBe(1);
  await sendText(host, "buffered while disconnected 1");
  await sendText(host, "buffered while disconnected 2");
  await member.evaluate(() => globalThis.__mockTailcat.setFailGroupDials(false));
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.online)).toBe(2);

  const received = member.locator("#history .message:not(.system) .bubble");
  await expect(received).toHaveCount(2);
  await expect(received.nth(0)).toHaveText("buffered while disconnected 1");
  await expect(received.nth(1)).toHaveText("buffered while disconnected 2");
  await context.close();
});

test("recovery reports a message gap when more than 100 room events were evicted", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-gap-${Date.now()}`;
  const { page: host, invitation } = await createGroupHost(context, namespace);
  const member = await joinGroup(context, namespace, host, invitation, "Gap Member");
  await member.evaluate(() => {
    globalThis.__mockTailcat.setFailGroupDials(true);
    globalThis.__mockTailcat.closeConnections({ port: 104, direction: "outbound" });
  });
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.online)).toBe(1);
  await host.evaluate(async () => {
    const input = document.getElementById("send-text");
    const button = document.getElementById("send-text-btn");
    for (let index = 0; index < 105; index += 1) {
      input.value = `evicted event ${index}`;
      button.click();
      while (input.value) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  await member.evaluate(() => globalThis.__mockTailcat.setFailGroupDials(false));
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.online)).toBe(2);
  await expect(member.locator("#history .message.system", { hasText: /no longer available|不在恢复缓冲区/u })).toBeVisible();
  await sendText(host, "live after gap");
  await expect(member.locator("#history .message:not(.system) .bubble", { hasText: "live after gap" })).toBeVisible();
  await context.close();
});

test("twenty join and leave cycles release each member stream", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chrome", "The 20-cycle resource gate runs once on Chrome.");
  test.setTimeout(180_000);
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-cycles-${Date.now()}`;
  const { page: host, invitation } = await createGroupHost(context, namespace);
  const guest = await openMockPage(context, namespace, { group: true });
  for (let cycle = 1; cycle <= 20; cycle += 1) {
    const name = `Cycle ${cycle}`;
    await requestJoin(guest, invitation, name);
    await approve(host, name);
    await expect.poll(() => guest.evaluate(() => globalThis.tcTest.group.mode)).toBe("member");
    await guest.locator("#group-leave-room-btn").click();
    await expect.poll(() => guest.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
    await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.members)).toBe(1);
  }
  expect(await host.evaluate(() => globalThis.tcTest.group.sequence)).toBe(40);
  const activeGroupStreams = await host.evaluate(() => globalThis.__mockTailcat.snapshot().records
    .filter((record) => record.port === 104 && !record.closed).length);
  expect(activeGroupStreams).toBe(0);
  await context.close();
});

test("concurrent approvals reserve the final seat atomically", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chrome", "The multi-page admission race gate runs once on Chrome.");
  test.setTimeout(180_000);
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-approval-race-${Date.now()}`;
  const { page: host, invitation } = await createGroupHost(context, namespace);
  for (let index = 1; index <= 8; index += 1) {
    await joinGroup(context, namespace, host, invitation, `Existing ${index}`);
  }
  const left = await openMockPage(context, namespace, { group: true });
  const right = await openMockPage(context, namespace, { group: true });
  await requestJoin(left, invitation, "Final Left");
  await requestJoin(right, invitation, "Final Right");
  await expect(host.locator(".group-pending-item")).toHaveCount(2);
  await host.evaluate(() => {
    for (const button of document.querySelectorAll(".group-pending-item .group-approve-join")) button.click();
  });
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.members)).toBe(10);
  await expect.poll(async () => {
    const modes = await Promise.all([
      left.evaluate(() => globalThis.tcTest.group.mode),
      right.evaluate(() => globalThis.tcTest.group.mode),
    ]);
    return modes.sort().join(",");
  }).toBe("member,none");
  await context.close();
});

test("ten seats join and the eleventh applicant receives FULL", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chrome", "The 10-page deterministic gate runs once on Chrome.");
  test.setTimeout(300_000);
  const context = await browser.newContext();
  const namespace = `group-ten-${Date.now()}`;
  const { page: host, invitation } = await createGroupHost(context, namespace);
  const members = [];
  for (let index = 1; index <= 9; index += 1) {
    members.push(await joinGroup(context, namespace, host, invitation, `Member ${index}`));
  }
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.members)).toBe(10);
  await expect(host.locator("#group-room-count")).toHaveText("10 / 10");

  const eleventh = await openMockPage(context, namespace, { group: true });
  await requestJoin(eleventh, invitation, "Member 10", { expectPending: false });
  await expect.poll(() => eleventh.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
  await expect(eleventh.locator("#status")).toContainText(/10 people|10 人/u);
  await eleventh.close();

  const allPages = [host, ...members];
  await Promise.all(allPages.map((page, senderIndex) => page.evaluate(async ({ sender }) => {
    const input = document.getElementById("send-text");
    const button = document.getElementById("send-text-btn");
    for (let index = 0; index < 100; index += 1) {
      while (button.disabled) await new Promise((resolve) => setTimeout(resolve, 0));
      input.value = `${sender}:${index}`;
      button.click();
      while (input.value || button.disabled) await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }, { sender: senderIndex })));
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.textEvents)).toBe(1000);
  const expectedSequence = await host.evaluate(() => globalThis.tcTest.group.sequence);
  const sequences = await Promise.all(allPages.map((page) => page.evaluate(() => globalThis.tcTest.group.sequence)));
  expect(sequences).toEqual(Array(10).fill(expectedSequence));
  const textCounts = await Promise.all(allPages.map((page) => page.evaluate(() => globalThis.tcTest.group.textEvents)));
  expect(textCounts).toEqual(Array(10).fill(1000));
  const onlineCounts = await Promise.all(allPages.map((page) => page.evaluate(() => globalThis.tcTest.group.online)));
  expect(onlineCounts).toEqual(Array(10).fill(10));
  const orderedTails = await Promise.all(allPages.map((page) => page.locator("#history .message:not(.system) .bubble").allTextContents()));
  expect(orderedTails[0]).toHaveLength(100);
  expect(new Set(orderedTails[0]).size).toBe(100);
  for (const tail of orderedTails.slice(1)) expect(tail).toEqual(orderedTails[0]);

  for (const member of members) {
    expect(await member.evaluate(() => globalThis.tcTest.group.members)).toBe(10);
  }
  await context.close();
});
