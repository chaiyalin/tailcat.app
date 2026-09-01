import { expect, test } from "@playwright/test";

test.describe("mobile runtime lifecycle primitives", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "chrome", "Runtime primitives run once in desktop Chrome.");
  });

  test("holds wake locks only while active work remains and reacquires after foregrounding", async ({ page }) => {
    await page.goto("/404.html");

    const result = await page.evaluate(async () => {
      const { createScreenWakeLockManager } = await import("/mobile-runtime.js");
      class FakeDocument extends EventTarget {
        visibilityState = "visible";
      }
      class FakeSentinel extends EventTarget {
        released = false;

        async release() {
          if (this.released) return;
          this.released = true;
          this.dispatchEvent(new Event("release"));
        }
      }

      const documentRef = new FakeDocument();
      const sentinels = [];
      const manager = createScreenWakeLockManager({
        documentRef,
        navigatorRef: {
          wakeLock: {
            async request(type) {
              if (type !== "screen") throw new Error("unexpected lock type");
              const sentinel = new FakeSentinel();
              sentinels.push(sentinel);
              return sentinel;
            },
          },
        },
      });

      await manager.acquire("file-transfer");
      await manager.acquire("file-transfer");
      await manager.acquire("voice-note");
      const afterAcquire = {
        active: manager.active,
        count: manager.referenceCount,
        reasons: manager.activeReasons,
        requests: sentinels.length,
      };

      documentRef.visibilityState = "hidden";
      documentRef.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve));
      const whileHidden = {
        active: manager.active,
        count: manager.referenceCount,
        released: sentinels[0].released,
      };

      documentRef.visibilityState = "visible";
      documentRef.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve));
      const afterResume = {
        active: manager.active,
        count: manager.referenceCount,
        requests: sentinels.length,
      };

      await manager.release("file-transfer");
      await manager.release("file-transfer");
      const afterPartialRelease = {
        active: manager.active,
        count: manager.referenceCount,
        reasons: manager.activeReasons,
      };
      await manager.release("voice-note");
      const afterFinalRelease = {
        active: manager.active,
        count: manager.referenceCount,
        released: sentinels.at(-1).released,
      };
      await manager.cleanup();

      return { afterAcquire, whileHidden, afterResume, afterPartialRelease, afterFinalRelease };
    });

    expect(result).toEqual({
      afterAcquire: {
        active: true,
        count: 3,
        reasons: ["file-transfer", "voice-note"],
        requests: 1,
      },
      whileHidden: { active: false, count: 3, released: true },
      afterResume: { active: true, count: 3, requests: 2 },
      afterPartialRelease: { active: true, count: 1, reasons: ["voice-note"] },
      afterFinalRelease: { active: false, count: 0, released: true },
    });
  });

  test("normalizes visibility, freeze/resume, and BFCache lifecycle events", async ({ page }) => {
    await page.goto("/404.html");

    const result = await page.evaluate(async () => {
      const { subscribePageLifecycle } = await import("/mobile-runtime.js");
      class FakeDocument extends EventTarget {
        visibilityState = "visible";
      }
      const documentRef = new FakeDocument();
      const windowRef = new EventTarget();
      const received = [];
      const unsubscribe = subscribePageLifecycle({
        any(snapshot) {
          received.push({
            type: snapshot.type,
            visibilityState: snapshot.visibilityState,
            persisted: snapshot.persisted,
          });
        },
      }, { documentRef, windowRef });

      documentRef.visibilityState = "hidden";
      documentRef.dispatchEvent(new Event("visibilitychange"));
      documentRef.dispatchEvent(new Event("freeze"));
      documentRef.visibilityState = "visible";
      documentRef.dispatchEvent(new Event("resume"));
      documentRef.dispatchEvent(new Event("visibilitychange"));
      for (const [type, persisted] of [["pagehide", true], ["pageshow", true]]) {
        const event = new Event(type);
        Object.defineProperty(event, "persisted", { value: persisted });
        windowRef.dispatchEvent(event);
      }

      unsubscribe();
      documentRef.dispatchEvent(new Event("freeze"));
      return received;
    });

    expect(result).toEqual([
      { type: "hidden", visibilityState: "hidden", persisted: undefined },
      { type: "freeze", visibilityState: "hidden", persisted: undefined },
      { type: "resume", visibilityState: "visible", persisted: undefined },
      { type: "visible", visibilityState: "visible", persisted: undefined },
      { type: "pagehide", visibilityState: "visible", persisted: true },
      { type: "pageshow", visibilityState: "visible", persisted: true },
    ]);
  });
});
