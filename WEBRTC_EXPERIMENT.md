# WebRTC magicsock experiment

This branch is a laboratory build for testing Tailscale's draft WebRTC
magicsock path in browsers. It is not a production release and must not be
deployed to `tailcat.app` while the upstream work remains a draft.

## Fixed inputs

- Application baseline: `main@d6baa08a8c5afb8bc1e8c097d86446a9143d57c6`
- Tailcat: `github.com/tailscale/tailcat v0.4.0`
- Tailscale baseline: `72780705eda81790e839a0793a90bdea4164d3ca`
- Upstream experiment: `tailscale/tailscale#21030` at
  `230e095afe936162992e12224c6486d26368fc60`
- Fixed fork commit: `chaiyalin/tailscale@7d20ed5680aa16a75d5ecd095bf69f7b1c86e5a7`
- Go replacement: `github.com/chaiyalin/tailscale`
  `v0.0.0-20260902082517-7d20ed5680aa`
- STUN: `stun:stun.cloudflare.com:3478`
- TURN service and URLs: disabled (Pion's TURN library remains a transitive
  WebRTC dependency but is never configured)
- Data-channel flow control: 512 KiB low watermark, 1 MiB high watermark,
  10 second wait limit

The complete provenance chain, fork commit, Go pseudo-version, and module
checksums are recorded in `WEBRTC_FORK.lock`, `go.mod`, `go.sum`, and the CI
build metadata. Dependencies must never follow a movable branch or tag.

## Build modes

The default build remains DERP-only:

```sh
PAGES_BUILD=1 ./build.sh dist
```

The experiment is opt-in at compile time and again at runtime:

```sh
PAGES_BUILD=1 TAILCAT_WEBRTC_EXPERIMENT=1 ./build.sh dist
```

Only the second build may import `tailscale.com/feature/webrtc`. Both builds
must keep the application protocol at version 1 and preserve TCF1 streaming.

## Evidence rules

Each real-network run records the application and dependency commit, browser,
OS/device, network class, anonymous run ID, path transition timings,
DERP/WebRTC byte counters, maximum buffered amount, file size, digest, elapsed
time, and error class. Never record a Tailcat address,
invite URL, private key, peer IP/port, message text, file name, or file content.

A run counts as WebRTC only when the bridge reports the magicsock WebRTC path.
Chromium runs additionally compare DERP WebSocket bytes; speed alone is not
evidence of a direct path.

## Gates

1. **Reproducible build:** both build modes, module verification, all existing
   tests, compressed WASM below 25 MiB, no raw WASM, Google STUN URL, TURN
   URL, invitation, or key material in the Pages artifact.
2. **Deterministic behavior:** persistent client reuse, path revisions,
   backpressure, close/error wake-up, fallback, legacy bridge behavior, and all
   desktop/mobile regressions pass.
3. **Desktop direct path:** Windows Chrome/Edge and macOS Chrome complete 40/40
   LAN sessions; at least 38 upgrade within 20 seconds. A verified 100 MiB
   transfer adds less than 2 MiB and less than 2% of payload on DERP after
   upgrade. A desktop 1 GiB stress run adds less than 5 MiB on DERP.
4. **NAT and fallback:** different residential networks, China Mobile/Unicom/
   Telecom, cellular, symmetric NAT, UDP blocking, and STUN blocking are
   exercised. Business traffic must complete over either WebRTC or DERP;
   mid-stream failure must resume safely or fail explicitly without a false
   success or partial-file residue.
5. **Compatibility and mobile:** experiment-to-production web sessions safely
   use DERP. Android Chrome 132/current and iOS Safari 17/18/current complete
   both roles and at least 100 MiB in each direction with picker/OPFS cleanup.
6. **Memory and endurance:** buffered amount never exceeds the high watermark
   plus one send batch; paused-receiver memory remains bounded; 50 room cycles
   and a four-hour soak have no corruption, false success, crash, or residue.

## Preview and rollback

Deploy only to the separate `tailcat-app-webrtc` Pages project. Its branch and
root `pages.dev` hosts must be protected by Cloudflare Access, it has no custom
domain, and automatic production deployment is disabled. The experiment UI
must always show its laboratory status and the current build commit.

In a real Cloudflare Pages build, `build.sh` also requires the exact experiment
branch and a `tailcat-app-webrtc.pages.dev` deployment URL. This makes an
accidental build in the production `tailcat-app` project fail closed.

To stop testing, disable new rooms and redeploy, disable the project's preview
branch, or revert this branch. Do not change or roll back the production
`tailcat-app` project as part of this experiment.

Production evaluation requires an upstream non-draft, fixed release or commit,
a fresh security review, a dependency rebase, and a complete rerun of every
gate.
