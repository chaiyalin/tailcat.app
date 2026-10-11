import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { openMockPage } from "./mock-tailcat.js";

async function createGroupHost(context, namespace) {
  const host = await openMockPage(context, namespace, { group: true });
  await host.locator("#group-create-entry-btn").click();
  await host.locator("#group-create-nickname").fill("Compatibility Host");
  await host.locator("#group-create-btn").click();
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.mode)).toBe("owner");

  const invitation = await host.locator("#group-invite-link").textContent();
  const hostAddress = new URLSearchParams(new URL(invitation).hash.slice(1)).get("invite");
  expect(hostAddress).toMatch(/^tc\S{32,}$/u);
  return { host, hostAddress };
}

test("a Group host explicitly rejects the legacy private-room handshake without changing rooms", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const namespace = `group-compat-${randomUUID()}`;

  try {
    const { host, hostAddress } = await createGroupHost(context, namespace);
    const legacyClient = await openMockPage(context, namespace);

    await legacyClient.locator("#send-addr").fill(hostAddress);
    await legacyClient.locator("#connect-btn").click();

    await expect(legacyClient.locator("#status")).toContainText(
      "This invitation requires a Group Beta-capable page",
    );
    await expect.poll(async () => {
      const snapshot = await host.evaluate(() => globalThis.__mockTailcat.snapshot());
      return snapshot.records.some(({ direction, port, envelope }) => (
        direction === "outbound"
        && port === 100
        && envelope?.type === "HELLO_REJECT"
        && envelope.reason === "GROUP_PROTOCOL_REQUIRED"
      ));
    }).toBe(true);

    const legacySnapshot = await legacyClient.evaluate(() => globalThis.__mockTailcat.snapshot());
    expect(legacySnapshot.records.some(({ direction, port, envelope }) => (
      direction === "outbound" && port === 100 && envelope?.type === "HELLO"
    ))).toBe(true);
    expect(await legacyClient.evaluate(() => globalThis.tcTest.state.peer)).toBe("none");

    expect(await host.evaluate(() => ({
      mode: globalThis.tcTest.group.mode,
      members: globalThis.tcTest.group.members,
      peer: globalThis.tcTest.state.peer,
      room: globalThis.tcTest.state.room,
    }))).toEqual({ mode: "owner", members: 1, peer: "none", room: "open" });
    await expect(host.locator("#group-members-list .group-member-item")).toHaveCount(1);
    await expect(host.locator("#group-pending-list .group-pending-item")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
