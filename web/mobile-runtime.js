/**
 * Browser-runtime helpers shared by the mobile and desktop application paths.
 *
 * Platform detection in this module is descriptive only. A recognized user
 * agent never overrides a missing core browser capability, and an unfamiliar
 * user agent is not rejected when the required APIs are available.
 *
 * This module deliberately does not require IndexedDB. Address persistence is
 * an optional application feature, not a prerequisite for encrypted rooms.
 */

export const REQUIRED_CORE_CAPABILITIES = Object.freeze([
  "webAssembly",
  "webSocket",
  "fetchStreams",
  "transformStream",
  "decompressionStream",
  "crypto",
]);

/** @typedef {"official" | "unofficial" | "unsupported" | "unknown"} SupportTier */

/**
 * Test whether an object exposes a callable property without invoking it.
 *
 * @param {unknown} value
 * @param {string} property
 * @returns {boolean}
 */
function hasFunction(value, property) {
  return Boolean(value && typeof value[property] === "function");
}

/**
 * Detect the APIs required by the Tailcat browser runtime.
 *
 * The returned `ready` value is the core admission decision. Platform or user
 * agent classification is intentionally not part of this decision.
 *
 * @param {object} [scope=globalThis] Browser-like global object. Supplying a
 * mock scope makes the function safe to use in deterministic tests.
 * @returns {Readonly<{
 *   webAssembly: boolean,
 *   webSocket: boolean,
 *   fetchStreams: boolean,
 *   transformStream: boolean,
 *   decompressionStream: boolean,
 *   crypto: boolean,
 *   ready: boolean,
 *   missing: readonly string[],
 * }>} A frozen capability snapshot.
 */
export function detectCoreCapabilities(scope = globalThis) {
  const responsePrototype = scope.Response?.prototype;
  const capabilities = {
    webAssembly: Boolean(
      scope.WebAssembly
      && hasFunction(scope.WebAssembly, "instantiate")
      && hasFunction(scope.WebAssembly, "compile"),
    ),
    webSocket: typeof scope.WebSocket === "function",
    fetchStreams: Boolean(
      typeof scope.fetch === "function"
      && typeof scope.ReadableStream === "function"
      && responsePrototype
      && "body" in responsePrototype,
    ),
    transformStream: typeof scope.TransformStream === "function",
    decompressionStream: typeof scope.DecompressionStream === "function",
    crypto: Boolean(
      scope.crypto
      && hasFunction(scope.crypto, "getRandomValues")
      && hasFunction(scope.crypto.subtle, "digest"),
    ),
  };
  const missing = REQUIRED_CORE_CAPABILITIES.filter((name) => !capabilities[name]);
  return Object.freeze({
    ...capabilities,
    ready: missing.length === 0,
    missing: Object.freeze(missing),
  });
}

/**
 * Classify a browser for product messaging and support labels.
 *
 * User-agent strings are mutable and incomplete, so this result must not be
 * used as the core browser-admission check. Use `detectCoreCapabilities()` for
 * that decision.
 *
 * Official labels:
 * - Android Chrome
 * - iOS/iPadOS Safari
 * - desktop Chrome and Edge
 *
 * Explicitly unofficial labels:
 * - iOS/iPadOS Chrome
 * - Android Edge
 * - Samsung Internet
 *
 * @param {object} [input]
 * @param {string} [input.userAgent]
 * @param {string} [input.platform]
 * @param {number} [input.maxTouchPoints]
 * @returns {Readonly<{
 *   os: string,
 *   browser: string,
 *   formFactor: "mobile" | "desktop" | "unknown",
 *   channel: string,
 *   support: SupportTier,
 *   officiallySupported: boolean,
 *   isMobile: boolean,
 * }>} A frozen, descriptive platform classification.
 */
export function classifyPlatform(input = {}) {
  const navigatorRef = typeof navigator === "object" ? navigator : undefined;
  const userAgent = String(input.userAgent ?? navigatorRef?.userAgent ?? "");
  const platform = String(input.platform ?? navigatorRef?.platform ?? "");
  const maxTouchPoints = Number(input.maxTouchPoints ?? navigatorRef?.maxTouchPoints ?? 0);

  const ipadDesktopUA = /Macintosh/u.test(userAgent) && maxTouchPoints > 1;
  const ios = /iPad|iPhone|iPod/u.test(userAgent) || ipadDesktopUA;
  const android = /Android/u.test(userAgent);

  let os = "unknown";
  if (ios) os = "ios";
  else if (android) os = "android";
  else if (/CrOS/u.test(userAgent)) os = "chromeos";
  else if (/Windows NT/u.test(userAgent)) os = "windows";
  else if (/Macintosh|Mac OS X/u.test(userAgent) || /Mac/u.test(platform)) os = "macos";
  else if (/Linux/u.test(userAgent) || /Linux/u.test(platform)) os = "linux";

  let browser = "unknown";
  if (android && (/; wv\)/u.test(userAgent) || /Version\/4\.0[^\n]*Chrome\//u.test(userAgent))) {
    browser = "webview";
  } else if (/SamsungBrowser\//u.test(userAgent)) browser = "samsung";
  else if (/EdgiOS\/|EdgA\/|Edg\//u.test(userAgent)) browser = "edge";
  else if (/OPiOS\/|OPR\//u.test(userAgent)) browser = "opera";
  else if (/CriOS\/|Chrome\//u.test(userAgent)) browser = "chrome";
  else if (/Chromium\//u.test(userAgent)) browser = "chromium";
  else if (/FxiOS\/|Firefox\//u.test(userAgent)) browser = "firefox";
  else if (/Safari\//u.test(userAgent) && /Version\//u.test(userAgent)) browser = "safari";

  const isMobile = ios || android || /\bMobile\b/u.test(userAgent);
  const formFactor = userAgent
    ? (isMobile ? "mobile" : "desktop")
    : "unknown";

  let channel = `${os}-${browser}`;
  /** @type {SupportTier} */
  let support = browser === "unknown" || os === "unknown" ? "unknown" : "unsupported";

  if (android && browser === "chrome") {
    channel = "android-chrome";
    support = "official";
  } else if (ios && browser === "safari") {
    channel = "ios-safari";
    support = "official";
  } else if (!isMobile && browser === "chrome") {
    channel = "desktop-chrome";
    support = "official";
  } else if (!isMobile && browser === "edge") {
    channel = "desktop-edge";
    support = "official";
  } else if (ios && browser === "chrome") {
    channel = "ios-chrome";
    support = "unofficial";
  } else if (android && browser === "edge") {
    channel = "android-edge";
    support = "unofficial";
  } else if (browser === "samsung") {
    channel = "android-samsung";
    support = "unofficial";
  }

  return Object.freeze({
    os,
    browser,
    formFactor,
    channel,
    support,
    officiallySupported: support === "official",
    isMobile,
  });
}

/**
 * Produce a single immutable snapshot suitable for application startup.
 * `coreReady` depends only on feature detection, never on the UA label.
 *
 * @param {object} [options]
 * @param {object} [options.scope]
 * @param {Parameters<typeof classifyPlatform>[0]} [options.platform]
 * @returns {Readonly<{
 *   capabilities: ReturnType<typeof detectCoreCapabilities>,
 *   platform: ReturnType<typeof classifyPlatform>,
 *   coreReady: boolean,
 * }>} Runtime snapshot.
 */
export function inspectMobileRuntime(options = {}) {
  const capabilities = detectCoreCapabilities(options.scope ?? globalThis);
  const platform = classifyPlatform(options.platform);
  return Object.freeze({ capabilities, platform, coreReady: capabilities.ready });
}

/**
 * A reference-counted Screen Wake Lock manager.
 *
 * Each caller acquires a named reason and releases the same reason when its
 * work completes. The physical screen lock exists while at least one reason
 * remains. Locks are released when the document becomes hidden and requested
 * again after it becomes visible.
 */
export class ScreenWakeLockManager {
  /**
   * @param {object} [options]
   * @param {Document} [options.documentRef]
   * @param {Navigator} [options.navigatorRef]
   * @param {(error: unknown) => void} [options.onError]
   */
  constructor(options = {}) {
    this.documentRef = options.documentRef
      ?? (typeof document === "object" ? document : undefined);
    this.navigatorRef = options.navigatorRef
      ?? (typeof navigator === "object" ? navigator : undefined);
    this.onError = typeof options.onError === "function" ? options.onError : () => {};
    /** @type {Map<string, number>} */
    this.reasons = new Map();
    /** @type {WakeLockSentinel | null} */
    this.sentinel = null;
    /** @type {Promise<boolean> | null} */
    this.pendingRequest = null;
    this.retryTimer = null;
    this.disposed = false;

    this.handleVisibilityChange = () => {
      if (this.documentRef?.visibilityState === "hidden") {
        this.releasePhysicalLock();
      } else if (this.documentRef?.visibilityState === "visible") {
        this.request();
      }
    };
    this.documentRef?.addEventListener?.("visibilitychange", this.handleVisibilityChange);
  }

  /** @returns {boolean} Whether Screen Wake Lock is exposed by the browser. */
  get supported() {
    return hasFunction(this.navigatorRef?.wakeLock, "request");
  }

  /** @returns {boolean} Whether a screen lock is currently held. */
  get active() {
    return Boolean(this.sentinel && !this.sentinel.released);
  }

  /** @returns {number} Total number of outstanding acquire calls. */
  get referenceCount() {
    let count = 0;
    for (const value of this.reasons.values()) count += value;
    return count;
  }

  /** @returns {readonly string[]} Current reason names. */
  get activeReasons() {
    return Object.freeze([...this.reasons.keys()]);
  }

  /**
   * Add a reference and request the physical lock when possible.
   *
   * @param {string} reason Stable caller-owned reason, such as `file-transfer`.
   * @returns {Promise<boolean>} Whether the physical lock is held.
   */
  async acquire(reason) {
    const key = this.validateReason(reason);
    if (this.disposed) return false;
    this.reasons.set(key, (this.reasons.get(key) ?? 0) + 1);
    return this.request();
  }

  /**
   * Request the physical lock for the current outstanding reasons.
   * Calling this method does not add a reference.
   *
   * @returns {Promise<boolean>} Whether the physical lock is held.
   */
  async request() {
    if (this.disposed || this.referenceCount === 0 || !this.supported) return false;
    if (this.documentRef?.visibilityState === "hidden") return false;
    if (this.active) return true;
    if (this.pendingRequest) return this.pendingRequest;

    this.pendingRequest = (async () => {
      try {
        const sentinel = await this.navigatorRef.wakeLock.request("screen");
        const shouldKeep = !this.disposed
          && this.referenceCount > 0
          && this.documentRef?.visibilityState !== "hidden";
        if (!shouldKeep) {
          await sentinel.release();
          return false;
        }

        this.sentinel = sentinel;
        sentinel.addEventListener?.("release", () => {
          if (this.sentinel !== sentinel) return;
          this.sentinel = null;
          if (this.disposed
            || this.referenceCount === 0
            || this.documentRef?.visibilityState !== "visible") return;
          clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.request();
          }, 250);
        }, { once: true });
        return !sentinel.released;
      } catch (error) {
        this.onError(error);
        return false;
      } finally {
        this.pendingRequest = null;
      }
    })();
    return this.pendingRequest;
  }

  /**
   * Remove one reference for a reason.
   *
   * @param {string} reason Reason previously passed to `acquire()`.
   * @returns {Promise<boolean>} Whether a matching reference existed.
   */
  async release(reason) {
    const key = this.validateReason(reason);
    const count = this.reasons.get(key) ?? 0;
    if (count === 0) return false;
    if (count === 1) this.reasons.delete(key);
    else this.reasons.set(key, count - 1);
    if (this.referenceCount === 0) await this.releasePhysicalLock();
    return true;
  }

  /**
   * Clear every reason and release the physical lock.
   * The manager remains reusable after this call.
   *
   * @returns {Promise<void>}
   */
  async releaseAll() {
    this.reasons.clear();
    await this.releasePhysicalLock();
  }

  /**
   * Release the current sentinel without changing logical reason references.
   *
   * @returns {Promise<void>}
   */
  async releasePhysicalLock() {
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (!sentinel || sentinel.released) return;
    try {
      await sentinel.release();
    } catch (error) {
      this.onError(error);
    }
  }

  /**
   * Remove listeners, clear references, and release the physical lock.
   * This operation is idempotent; a disposed manager cannot be reused.
   *
   * @returns {Promise<void>}
   */
  async cleanup() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.documentRef?.removeEventListener?.("visibilitychange", this.handleVisibilityChange);
    const pendingRequest = this.pendingRequest;
    await this.releaseAll();
    await pendingRequest;
    await this.releasePhysicalLock();
  }

  /** @private */
  validateReason(reason) {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new TypeError("wake lock reason must be a non-empty string");
    }
    return reason;
  }
}

/**
 * Create a reference-counted Screen Wake Lock manager.
 *
 * @param {ConstructorParameters<typeof ScreenWakeLockManager>[0]} [options]
 * @returns {ScreenWakeLockManager}
 */
export function createScreenWakeLockManager(options) {
  return new ScreenWakeLockManager(options);
}

/**
 * Keep visual viewport measurements in CSS custom properties.
 *
 * Variables created for the default prefix:
 * - `--tc-visual-viewport-width`
 * - `--tc-visual-viewport-height`
 * - `--tc-visual-viewport-offset-top`
 * - `--tc-visual-viewport-offset-left`
 * - `--tc-visual-viewport-scale`
 * - `--tc-visual-viewport-bottom-inset`
 *
 * Existing inline values are restored by `cleanup()`.
 *
 * @param {object} [options]
 * @param {Window} [options.windowRef]
 * @param {Document} [options.documentRef]
 * @param {string} [options.prefix="--tc-visual-viewport"]
 * @returns {Readonly<{
 *   supported: boolean,
 *   update: () => void,
 *   cleanup: () => void,
 * }>} Viewport synchronizer.
 */
export function syncVisualViewportCSSVariables(options = {}) {
  const windowRef = options.windowRef ?? (typeof window === "object" ? window : undefined);
  const documentRef = options.documentRef
    ?? windowRef?.document
    ?? (typeof document === "object" ? document : undefined);
  const prefix = options.prefix ?? "--tc-visual-viewport";
  if (!/^--[a-zA-Z0-9_-]+$/u.test(prefix)) {
    throw new TypeError("visual viewport CSS variable prefix must start with --");
  }

  const root = documentRef?.documentElement;
  const viewport = windowRef?.visualViewport;
  const names = Object.freeze({
    width: `${prefix}-width`,
    height: `${prefix}-height`,
    offsetTop: `${prefix}-offset-top`,
    offsetLeft: `${prefix}-offset-left`,
    scale: `${prefix}-scale`,
    bottomInset: `${prefix}-bottom-inset`,
  });
  const previous = new Map();
  let animationFrame = 0;
  let cleaned = false;

  if (root?.style) {
    for (const name of Object.values(names)) {
      previous.set(name, {
        value: root.style.getPropertyValue(name),
        priority: root.style.getPropertyPriority(name),
      });
    }
  }

  const cssNumber = (value) => {
    const finite = Number.isFinite(value) ? value : 0;
    return Math.round(finite * 1000) / 1000;
  };

  const positiveMeasurement = (value, fallback) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
  };

  const boundedOffset = (value, layoutSize, viewportSize) => {
    const numeric = Number(value);
    const nonNegative = Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
    // Safari can briefly report stale or overscrolled offsets while its bars
    // and software keyboard animate. Do not let those transient values move
    // the application outside the layout viewport.
    return Math.min(nonNegative, Math.max(0, layoutSize - viewportSize));
  };

  /** Update CSS variables immediately. */
  const update = () => {
    if (cleaned || !root?.style || !windowRef) return;
    const layoutWidth = positiveMeasurement(windowRef.innerWidth, 1);
    const layoutHeight = positiveMeasurement(windowRef.innerHeight, 1);
    const widthValue = Math.min(positiveMeasurement(viewport?.width, layoutWidth), layoutWidth);
    const heightValue = Math.min(positiveMeasurement(viewport?.height, layoutHeight), layoutHeight);
    const offsetTopValue = boundedOffset(viewport?.offsetTop, layoutHeight, heightValue);
    const offsetLeftValue = boundedOffset(viewport?.offsetLeft, layoutWidth, widthValue);
    const width = cssNumber(widthValue);
    const height = cssNumber(heightValue);
    const offsetTop = cssNumber(offsetTopValue);
    const offsetLeft = cssNumber(offsetLeftValue);
    const scale = cssNumber(positiveMeasurement(viewport?.scale, 1));
    const bottomInset = cssNumber(Math.max(
      0,
      layoutHeight - (offsetTopValue + heightValue),
    ));

    root.style.setProperty(names.width, `${width}px`);
    root.style.setProperty(names.height, `${height}px`);
    root.style.setProperty(names.offsetTop, `${offsetTop}px`);
    root.style.setProperty(names.offsetLeft, `${offsetLeft}px`);
    root.style.setProperty(names.scale, String(scale));
    root.style.setProperty(names.bottomInset, `${bottomInset}px`);
  };

  const scheduleUpdate = () => {
    if (cleaned || animationFrame) return;
    if (typeof windowRef?.requestAnimationFrame !== "function") {
      update();
      return;
    }
    animationFrame = windowRef.requestAnimationFrame(() => {
      animationFrame = 0;
      update();
    });
  };

  viewport?.addEventListener?.("resize", scheduleUpdate);
  viewport?.addEventListener?.("scroll", scheduleUpdate);
  windowRef?.addEventListener?.("resize", scheduleUpdate);
  windowRef?.addEventListener?.("orientationchange", scheduleUpdate);
  update();

  /** Remove event listeners and restore prior inline custom properties. */
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    viewport?.removeEventListener?.("resize", scheduleUpdate);
    viewport?.removeEventListener?.("scroll", scheduleUpdate);
    windowRef?.removeEventListener?.("resize", scheduleUpdate);
    windowRef?.removeEventListener?.("orientationchange", scheduleUpdate);
    if (animationFrame && typeof windowRef?.cancelAnimationFrame === "function") {
      windowRef.cancelAnimationFrame(animationFrame);
    }
    animationFrame = 0;
    if (!root?.style) return;
    for (const [name, original] of previous) {
      if (original.value) root.style.setProperty(name, original.value, original.priority);
      else root.style.removeProperty(name);
    }
  };

  return Object.freeze({ supported: Boolean(viewport), update, cleanup });
}

/**
 * @typedef {object} PageLifecycleSnapshot
 * @property {"hidden" | "visible" | "freeze" | "resume" | "pagehide" | "pageshow"} type
 * @property {Event} event
 * @property {DocumentVisibilityState | "unknown"} visibilityState
 * @property {boolean | undefined} persisted
 * @property {number} timestamp
 */

/**
 * Subscribe to visibility and Page Lifecycle events with one callback shape.
 *
 * `hidden` and `visible` are derived from `visibilitychange`; `freeze` and
 * `resume` are Page Lifecycle events where implemented; `pagehide` and
 * `pageshow` include their back-forward-cache `persisted` value.
 *
 * @param {Partial<Record<PageLifecycleSnapshot["type"],
 *   (snapshot: PageLifecycleSnapshot) => void>> & {
 *   any?: (snapshot: PageLifecycleSnapshot) => void,
 * }} callbacks
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @param {Window} [options.windowRef]
 * @returns {() => void} Idempotent unsubscribe function.
 */
export function subscribePageLifecycle(callbacks = {}, options = {}) {
  const documentRef = options.documentRef
    ?? (typeof document === "object" ? document : undefined);
  const windowRef = options.windowRef
    ?? documentRef?.defaultView
    ?? (typeof window === "object" ? window : undefined);
  let subscribed = true;

  const emit = (type, event) => {
    if (!subscribed) return;
    const snapshot = Object.freeze({
      type,
      event,
      visibilityState: documentRef?.visibilityState ?? "unknown",
      persisted: "persisted" in event ? Boolean(event.persisted) : undefined,
      timestamp: Date.now(),
    });
    callbacks[type]?.(snapshot);
    callbacks.any?.(snapshot);
  };

  const onVisibilityChange = (event) => {
    emit(documentRef?.visibilityState === "hidden" ? "hidden" : "visible", event);
  };
  const onFreeze = (event) => emit("freeze", event);
  const onResume = (event) => emit("resume", event);
  const onPageHide = (event) => emit("pagehide", event);
  const onPageShow = (event) => emit("pageshow", event);

  documentRef?.addEventListener?.("visibilitychange", onVisibilityChange);
  documentRef?.addEventListener?.("freeze", onFreeze);
  documentRef?.addEventListener?.("resume", onResume);
  windowRef?.addEventListener?.("pagehide", onPageHide);
  windowRef?.addEventListener?.("pageshow", onPageShow);

  return () => {
    if (!subscribed) return;
    subscribed = false;
    documentRef?.removeEventListener?.("visibilitychange", onVisibilityChange);
    documentRef?.removeEventListener?.("freeze", onFreeze);
    documentRef?.removeEventListener?.("resume", onResume);
    windowRef?.removeEventListener?.("pagehide", onPageHide);
    windowRef?.removeEventListener?.("pageshow", onPageShow);
  };
}
