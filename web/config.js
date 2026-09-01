// Production configuration is deliberately static. In particular, the DERP
// map cannot be overridden from the URL: an invite must never be able to send
// a visitor to an untrusted relay map.

export const APP_CONFIG = Object.freeze({
  version: "0.1.0-beta.1",
  protocolVersion: 1,
  // Emergency beta kill switch. Set false and redeploy this static file to
  // leave the explanatory site online while preventing new rooms.
  roomsEnabled: true,
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
