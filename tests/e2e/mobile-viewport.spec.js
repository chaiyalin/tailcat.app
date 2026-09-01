import { expect, test } from "@playwright/test";

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
  userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36",
});

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "chrome", "The deterministic VisualViewport fixture runs once in touch-emulated Chrome.");
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      width: innerWidth,
      height: innerHeight,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
    };
    class MockVisualViewport extends EventTarget {
      get width() { return state.width; }
      get height() { return state.height; }
      get offsetTop() { return state.offsetTop; }
      get offsetLeft() { return state.offsetLeft; }
      get pageTop() { return state.offsetTop; }
      get pageLeft() { return state.offsetLeft; }
      get scale() { return state.scale; }
    }
    const viewport = new MockVisualViewport();
    Object.defineProperty(globalThis, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    Object.defineProperty(globalThis, "__setMockVisualViewport", {
      configurable: true,
      value(next, eventType = "resize") {
        Object.assign(state, next);
        viewport.dispatchEvent(new Event(eventType));
      },
    });
  });

  await page.goto("/");
  await page.waitForFunction(() => globalThis.tcTest?.ready === true);
  await page.evaluate(() => {
    const app = document.getElementById("app");
    app.dataset.mobileState = "connected";
    app.setAttribute("aria-busy", "false");
  });
  await expect(page.locator("#send-text")).toBeVisible();
});

test("applies the documented Android Chrome and iOS Safari version boundaries", async ({ browser }) => {
  const cases = [
    {
      channel: "android-chrome",
      officiallySupported: false,
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    },
    {
      channel: "android-chrome",
      officiallySupported: true,
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36",
    },
    {
      channel: "ios-safari",
      officiallySupported: false,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.7 Mobile/15E148 Safari/604.1",
    },
    {
      channel: "ios-safari",
      officiallySupported: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    },
  ];

  for (const expected of cases) {
    const context = await browser.newContext({
      baseURL: "http://127.0.0.1:4173",
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      userAgent: expected.userAgent,
    });
    try {
      const candidate = await context.newPage();
      await candidate.goto("/");
      await candidate.waitForFunction(() => globalThis.tcTest?.ready === true);
      expect(await candidate.evaluate(() => globalThis.tcTest.runtime)).toEqual(expect.objectContaining({
        channel: expected.channel,
        coreReady: true,
        officiallySupported: expected.officiallySupported,
      }));
      // Version labels only select official vs limited support. Admission is
      // still driven independently by the required runtime capabilities.
      await expect(candidate.locator("#browser-blocker")).toHaveClass(/hidden/u);
      await expect(candidate.locator("#app")).not.toHaveClass(/hidden/u);
    } finally {
      await context.close();
    }
  }
});

async function viewportMetrics(page) {
  return page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const app = document.getElementById("app").getBoundingClientRect();
    const composer = document.getElementById("composer").getBoundingClientRect();
    const input = document.getElementById("send-text").getBoundingClientRect();
    return {
      layout: { width: innerWidth, height: innerHeight },
      visual: {
        width: visualViewport.width,
        height: visualViewport.height,
        top: visualViewport.offsetTop,
        left: visualViewport.offsetLeft,
      },
      css: {
        width: rootStyle.getPropertyValue("--tc-visual-viewport-width").trim(),
        height: rootStyle.getPropertyValue("--tc-visual-viewport-height").trim(),
        top: rootStyle.getPropertyValue("--tc-visual-viewport-offset-top").trim(),
        left: rootStyle.getPropertyValue("--tc-visual-viewport-offset-left").trim(),
        bottom: rootStyle.getPropertyValue("--tc-visual-viewport-bottom-inset").trim(),
      },
      app: { top: app.top, left: app.left, right: app.right, bottom: app.bottom, width: app.width, height: app.height },
      composer: { top: composer.top, left: composer.left, right: composer.right, bottom: composer.bottom },
      input: { top: input.top, left: input.left, right: input.right, bottom: input.bottom },
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    };
  });
}

async function setMockViewport(page, values, eventType) {
  await page.evaluate(({ values: next, eventType: type }) => {
    globalThis.__setMockVisualViewport(next, type);
  }, { values, eventType });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function expectShellInsideVisualViewport(metrics, expected) {
  const visualRight = expected.left + expected.width;
  const visualBottom = expected.top + expected.height;
  expect(metrics.app.left).toBeCloseTo(expected.left, 1);
  expect(metrics.app.top).toBeCloseTo(expected.top, 1);
  expect(metrics.app.right).toBeCloseTo(visualRight, 1);
  expect(metrics.app.bottom).toBeCloseTo(visualBottom, 1);
  expect(metrics.app.width).toBeCloseTo(expected.width, 1);
  expect(metrics.app.height).toBeCloseTo(expected.height, 1);
  expect(metrics.composer.left).toBeGreaterThanOrEqual(expected.left - 1);
  expect(metrics.composer.right).toBeLessThanOrEqual(visualRight + 1);
  expect(metrics.composer.bottom).toBeLessThanOrEqual(visualBottom + 1);
  expect(metrics.input.top).toBeGreaterThanOrEqual(expected.top - 1);
  expect(metrics.input.left).toBeGreaterThanOrEqual(expected.left - 1);
  expect(metrics.input.right).toBeLessThanOrEqual(visualRight + 1);
  expect(metrics.input.bottom).toBeLessThanOrEqual(visualBottom + 1);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.layout.width + 1);
}

test("tracks visual viewport resize and scroll while keeping the composer above the keyboard", async ({ page }) => {
  const initial = await viewportMetrics(page);
  expectShellInsideVisualViewport(initial, {
    left: 0,
    top: 0,
    width: initial.layout.width,
    height: initial.layout.height,
  });

  const keyboardViewport = {
    width: initial.layout.width,
    height: 420,
    offsetTop: 168,
    offsetLeft: 0,
    scale: 1,
  };
  await setMockViewport(page, keyboardViewport, "resize");
  const resized = await viewportMetrics(page);
  expect(resized.css).toEqual({
    width: `${keyboardViewport.width}px`,
    height: `${keyboardViewport.height}px`,
    top: `${keyboardViewport.offsetTop}px`,
    left: "0px",
    bottom: `${initial.layout.height - keyboardViewport.offsetTop - keyboardViewport.height}px`,
  });
  expectShellInsideVisualViewport(resized, {
    left: keyboardViewport.offsetLeft,
    top: keyboardViewport.offsetTop,
    width: keyboardViewport.width,
    height: keyboardViewport.height,
  });

  const pannedViewport = {
    width: 330,
    height: 380,
    offsetTop: 200,
    offsetLeft: 36,
    scale: 1.18,
  };
  await setMockViewport(page, pannedViewport, "scroll");
  const panned = await viewportMetrics(page);
  expect(panned.css).toEqual({
    width: `${pannedViewport.width}px`,
    height: `${pannedViewport.height}px`,
    top: `${pannedViewport.offsetTop}px`,
    left: `${pannedViewport.offsetLeft}px`,
    bottom: `${initial.layout.height - pannedViewport.offsetTop - pannedViewport.height}px`,
  });
  expectShellInsideVisualViewport(panned, {
    left: pannedViewport.offsetLeft,
    top: pannedViewport.offsetTop,
    width: pannedViewport.width,
    height: pannedViewport.height,
  });
});

test("bounds transient visual viewport measurements without creating horizontal overflow", async ({ page }) => {
  const initial = await viewportMetrics(page);
  await setMockViewport(page, {
    width: 320,
    height: 400,
    offsetTop: 10_000,
    offsetLeft: 10_000,
    scale: 1,
  }, "scroll");

  const bounded = await viewportMetrics(page);
  const expected = {
    left: initial.layout.width - 320,
    top: initial.layout.height - 400,
    width: 320,
    height: 400,
  };
  expect(bounded.css.left).toBe(`${expected.left}px`);
  expect(bounded.css.top).toBe(`${expected.top}px`);
  expect(bounded.css.bottom).toBe("0px");
  expectShellInsideVisualViewport(bounded, expected);

  await setMockViewport(page, {
    width: 0,
    height: Number.NaN,
    offsetTop: -50,
    offsetLeft: -20,
    scale: 0,
  }, "resize");
  const recovered = await viewportMetrics(page);
  expect(recovered.css).toEqual({
    width: `${initial.layout.width}px`,
    height: `${initial.layout.height}px`,
    top: "0px",
    left: "0px",
    bottom: "0px",
  });
  expectShellInsideVisualViewport(recovered, {
    left: 0,
    top: 0,
    width: initial.layout.width,
    height: initial.layout.height,
  });
});
