// Production configuration is deliberately static. In particular, the DERP
// map cannot be overridden from the URL: an invite must never be able to send
// a visitor to an untrusted relay map.

const VERSION_BASE = "0.2.0-beta.1+webrtc-lab";
const BUILD_SHORT_SHA = String(globalThis.__TAILCAT_BUILD_SHA__ || "")
  .trim()
  .match(/^[0-9a-f]{7,40}$/iu)?.[0]
  ?.slice(0, 12)
  ?.toLowerCase() || "";
const WEBRTC_LAB_BUILD_ENABLED = globalThis.__TAILCAT_WEBRTC_LAB__ === true;

export const APP_CONFIG = Object.freeze({
  version: BUILD_SHORT_SHA ? `${VERSION_BASE}.${BUILD_SHORT_SHA}` : VERSION_BASE,
  protocolVersion: 1,
  // Emergency beta kill switch. Set false and redeploy this static file to
  // leave the explanatory site online while preventing new rooms.
  roomsEnabled: true,
  mobile: Object.freeze({
    androidEnabled: true,
    iosEnabled: true,
  }),
  derpMapURL: "https://tailcat.dev/derpmap.json",
  idleTimeoutMs: 30 * 60 * 1000,
  ports: Object.freeze({ control: 100, text: 101, file: 102, voice: 103 }),
  limits: Object.freeze({
    textBytes: 64 * 1024,
    fileBytes: 1024 * 1024 * 1024,
    voiceBytes: 10 * 1024 * 1024,
    voiceSeconds: 120,
    fileChunkBytes: 64 * 1024,
    controlBytes: 64 * 1024,
    fileNameChars: 180,
  }),
  rtc: Object.freeze({
    iceServers: Object.freeze([{ urls: "stun:stun.cloudflare.com:3478" }]),
    iceGatheringTimeoutMs: 8000,
    callSetupTimeoutMs: 60 * 1000,
  }),
  experimental: Object.freeze({
    magicsockWebRTC: Object.freeze({
      // Emergency data-path kill switch. Disabling this keeps the established
      // Tailcat-over-DERP transport and suppresses the experimental capability.
      enabled: WEBRTC_LAB_BUILD_ENABLED,
      pathStatusVersion: 1,
      statusTimeoutMs: 5_000,
      probeDelaysMs: Object.freeze([0, 2_000, 5_000, 10_000, 20_000]),
      steadyProbeIntervalMs: 30_000,
    }),
  }),
  regions: Object.freeze([
    Object.freeze({ code: "auto", id: -1, labelKey: "region_auto" }),
    Object.freeze({ code: "nyc", id: 301, labelKey: "region_nyc" }),
    Object.freeze({ code: "sfo", id: 302, labelKey: "region_sfo" }),
    Object.freeze({ code: "fra", id: 303, labelKey: "region_fra" }),
    Object.freeze({ code: "tok", id: 304, labelKey: "region_tok" }),
  ]),
});

export function defaultRegionCode() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    return zone.startsWith("Asia/") ? "tok" : "auto";
  } catch (_) {
    return "auto";
  }
}

export function regionByCode(code) {
  return APP_CONFIG.regions.find((region) => region.code === code)
    || APP_CONFIG.regions[0];
}
