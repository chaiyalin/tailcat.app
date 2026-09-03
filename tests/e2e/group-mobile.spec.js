import { expect, test } from "@playwright/test";
import { openMockPage } from "./mock-tailcat.js";

test.beforeEach(async ({ context }) => {
  await context.route("https://127.0.0.1:4173/**", async (route) => {
    const response = await context.request.fetch(route.request().url().replace(/^https:/u, "http:"));
    await route.fulfill({ response });
  });
});

async function createMobileHost(context, namespace) {
  const host = await openMockPage(context, namespace, {
    group: true,
    mobileGroupHosting: true,
    url: "https://127.0.0.1:4173/",
  });
  await host.locator("#group-create-entry-btn").click();
  await expect(host.locator("#group-mobile-host-warning")).toBeVisible();
  await host.locator("#group-create-nickname").fill("Mobile Host");
  await expect(host.locator("#group-create-btn")).toBeDisabled();
  await host.locator("#group-mobile-host-confirm").check();
  await host.locator("#group-create-btn").click();
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.mode)).toBe("owner");
  // WebKit marks the first page hidden when the participant page opens in the
  // same emulated browser context. Real participants use separate devices, so
  // keep the host foregrounded until each test deliberately changes it.
  await host.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });
  return { host, invitation: await host.locator("#group-invite-link").textContent() };
}

async function joinMember(context, namespace, host, invitation) {
  const member = await openMockPage(context, namespace, {
    group: true,
    mobileGroupHosting: true,
    url: `https://127.0.0.1:4173/${new URL(invitation).hash}`,
  });
  await member.locator("#group-join-nickname").fill("Mobile Member");
  await member.locator("#group-join-btn").click();
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.pending)).toBe(1);
  await host.locator("#mobile-menu-btn").click();
  await host.locator(".group-pending-item .group-approve-join").click();
  await expect.poll(() => member.evaluate(() => globalThis.tcTest.group.mode)).toBe("member");
  return member;
}

async function setVisibility(page, state) {
  await page.evaluate((nextState) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: nextState });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

async function installFailFirstWakeLock(context) {
  await context.addInitScript(() => {
    class TestWakeLockSentinel extends EventTarget {
      released = false;

      async release() {
        if (this.released) return;
        this.released = true;
        this.dispatchEvent(new Event("release"));
      }
    }

    globalThis.__testWakeLockRequests = 0;
    globalThis.__testWakeLockSentinels = [];
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        async request(type) {
          if (type !== "screen") throw new Error("unexpected wake lock type");
          globalThis.__testWakeLockRequests += 1;
          if (globalThis.__testWakeLockRequests === 1) {
            throw new Error("simulated wake lock denial");
          }
          const sentinel = new TestWakeLockSentinel();
          globalThis.__testWakeLockSentinels.push(sentinel);
          return sentinel;
        },
      },
    });
  });
}

test("mobile hosting requires confirmation, pauses in background, and resumes inside 120 seconds", async ({ context }) => {
  const namespace = `group-mobile-resume-${Date.now()}`;
  const { host, invitation } = await createMobileHost(context, namespace);
  const member = await joinMember(context, namespace, host, invitation);

  await setVisibility(host, "hidden");
  await expect.poll(() => member.evaluate(() => globalThis.tcTest.group.paused)).toBe(true);
  await expect(member.locator("#send-text-btn")).toBeDisabled();
  await setVisibility(host, "visible");
  await expect.poll(() => member.evaluate(() => globalThis.tcTest.group.paused)).toBe(false);
  await expect(member.locator("#send-text-btn")).toBeEnabled();
});

test("mobile host returning after the recovery window closes the room", async ({ context }) => {
  const namespace = `group-mobile-timeout-${Date.now()}`;
  const { host, invitation } = await createMobileHost(context, namespace);
  const member = await joinMember(context, namespace, host, invitation);
  await setVisibility(host, "hidden");
  await host.evaluate(() => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 120_001;
  });
  await setVisibility(host, "visible");
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
  await expect.poll(() => member.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
  await expect(member.locator("#status")).toContainText(/host|房主/u);
});

test("a mobile group that finishes creating in the background starts paused", async ({ context }) => {
  const namespace = `group-mobile-create-background-${Date.now()}`;
  const host = await openMockPage(context, namespace, {
    group: true,
    mobileGroupHosting: true,
    url: "https://127.0.0.1:4173/",
  });
  await host.evaluate(() => {
    const originalListen = globalThis.tailcatListen;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.__releaseDelayedGroupListen = release;
    globalThis.tailcatListen = async (options) => {
      await gate;
      return originalListen(options);
    };
  });
  await host.locator("#group-create-entry-btn").click();
  await host.locator("#group-create-nickname").fill("Background Host");
  await host.locator("#group-mobile-host-confirm").check();
  await host.locator("#group-create-btn").click();
  await setVisibility(host, "hidden");
  await host.evaluate(() => globalThis.__releaseDelayedGroupListen());

  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.mode)).toBe("owner");
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.paused)).toBe(true);
  await setVisibility(host, "visible");
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.paused)).toBe(false);
});

test("mobile host reports wake lock failure and remains safely operable", async ({ context }) => {
  const pageErrors = [];
  context.on("page", (page) => page.on("pageerror", (error) => pageErrors.push(error.message)));
  await installFailFirstWakeLock(context);

  const namespace = `group-mobile-wake-lock-${Date.now()}`;
  const { host } = await createMobileHost(context, namespace);

  await expect(host.locator("#group-wake-lock-alert")).toBeVisible();
  await expect(host.locator("#group-wake-lock-alert")).toContainText(/screen could not be kept awake|无法保持屏幕唤醒/u);
  await expect(host.locator("#status")).toContainText(/screen could not be kept awake|无法保持屏幕唤醒/u);
  await expect.poll(() => host.evaluate(() => globalThis.__testWakeLockRequests)).toBe(1);

  // A visible-page lifecycle signal retries the still-required group-host lock.
  await setVisibility(host, "visible");
  await expect.poll(() => host.evaluate(() => globalThis.__testWakeLockRequests)).toBe(2);
  await expect.poll(() => host.evaluate(() => globalThis.__testWakeLockSentinels[0]?.released)).toBe(false);
  // A successful retry does not erase the safety warning for this room.
  await expect(host.locator("#group-wake-lock-alert")).toBeVisible();

  // Browsers may release a sentinel at any time. While the page remains
  // visible and the group-host reason remains active, it must reacquire
  // without waiting for another lifecycle event.
  await host.evaluate(async () => {
    await globalThis.__testWakeLockSentinels[0].release();
  });
  await expect.poll(() => host.evaluate(() => globalThis.__testWakeLockRequests)).toBe(3);
  await expect.poll(() => host.evaluate(() => globalThis.__testWakeLockSentinels[1]?.released)).toBe(false);

  await host.locator("#mobile-menu-btn").click();
  await expect(host.locator("#group-close-room-btn")).toBeEnabled();
  await host.locator("#group-close-room-btn").click();
  await expect.poll(() => host.evaluate(() => globalThis.tcTest.group.mode)).toBe("none");
  await expect.poll(() => host.evaluate(() => globalThis.__testWakeLockSentinels[1]?.released)).toBe(true);
  expect(pageErrors).toEqual([]);
});
