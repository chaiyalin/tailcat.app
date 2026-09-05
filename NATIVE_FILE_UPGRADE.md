# Native file transfer upgrade — implementation record

Target: `0.4.0-beta.1`. Branch: `feature/native-webrtc-files`.

## Status — 2026-09-05

**Incomplete; transport primitives only. Not a release candidate.** The new
modules are not imported by `app.js`, not advertised in room capabilities, and
not deployed. The application version remains `0.3.0-beta.1`. Production and
the existing Magicsock experiment have not been changed.

## Verified production baseline

- Pages project: `tailcat-app`.
- Production deployment: `6c2748cd-9377-4f10-8644-d54f8909dc16`.
- Recorded source: `9df79d476d22cdab53cf92a996becf412ff47545`.
- Production branch field: `main`; actual source is the existing
  `feature/group-rooms-v2` commit above.
- Remote `main`, checked with `git ls-remote`, remains
  `4f3d9b70e8e777bf596b4ccfaa7a4aab0e8ad17e`.
- Production flags: group rooms on, mobile group hosting off, preview invites off.
- Dependencies remain Tailcat v0.4.0 and the existing Tailscale
  `72780705eda8` pseudo-version. No draft WebRTC fork or Magicsock changes.

The following production resources matched the local baseline bytes:

| Resource | SHA-256 |
| --- | --- |
| app.js | aca6e21f2a4686b1bec18e47166bcd7105f4f84013f42cca0c9cf089ba5db0e2 |
| config.js | d256687f086443870b58529ab1c8b383c9eabd92be64c69a1f4fd54dd1ac124d |
| group-room.js | 9635de59933f4859e3ec85b53d1e1c7de4242a28bba0347878b64d9d3a2ff713 |
| file-sinks.js | 3044fa42e8a6b80467627befec972096937af1091f1e26364c54865e4971ade7 |
| main.wasm.gz | 6adc4216a578bc3a7f8aca32f5cdfec3cb6a1b94fe854569ed8ce721882a82f8 |
| runtime-config.js | 99e04a8df0eff2230c7fff9a206f479f2bb4a4f7bf4115785cde59e292a6a1da |

`index.html` differs only in observed Cloudflare Email Address Obfuscation:
the `mailto:` abuse link is rewritten and `email-decode.min.js` is injected.
This must be addressed in the no-injected-scripts release check. Do not copy
the transformed HTML into source control. The baseline branch was preserved;
this branch was created from the verified production source commit.

## Implemented primitives

- `web/native-file-stream.js`: reliable/ordered DataChannel byte stream; 16 KiB
  messages including a versioned six-byte header; negotiated SCTP ceiling;
  512/128 KiB send watermarks; 1 MiB receiver credit; credit returned in batches
  only after explicit `acknowledgeRead()`; serial reader/writer; FIN/FIN_ACK;
  30-second stalled wait; cancel/error/close wakeup; bounded numeric diagnostics.
- `web/file-transport-manager.js`: lazy per-room/per-peer PC; fixed Cloudflare
  STUN; deterministic offerer; room/peer/generation-bound signaling; bounded
  ICE/signaling queues; explicitly authorized incoming attempts; PC reuse;
  10-second whole-setup deadline; 60-second cooldown; 30-second idle cleanup;
  close/revocation handling. No media permissions, TURN or endpoint overrides.
- `web/file-transfer-state.js`: memory-only, peer-bound, expiring completion
  receipts and a single-retry orchestrator. A missing receipt is never restart
  permission. Restart requires the receiver to confirm old-writer cleanup.
  A cached completion must match the sender's digest. Unknown outcomes remain
  unconfirmed. Disk/hash/quota/refusal/cancellation/auth errors are not retried.
- Unit tests, real browser transport fixture, CI branch trigger and unit command.

The orchestration hooks are a contract, **not an implementation of storage reset,
Tailcat authentication, group tickets or wire-level result queries**.

## Verification performed

- `npm run test:unit`: 29/29 passed.
- `PAGES_BUILD=1 ./build.sh dist`: passed; `go mod verify`: passed.
- Real DataChannel fixture on desktop Chrome: passed, including 100 MiB,
  alternating direction, connection reuse, byte-pattern integrity, buffer bounds.
- Same fixture with Android touch/UA emulation: passed. This is not Android hardware.
- Same fixture on WebKit/iOS emulation: **intermittent**. Two runs failed
  `DIRECT_TIMEOUT` with no signaling errors and receiver ICE still `checking`
  at 10 seconds; a subsequent rerun and three consecutive repeats passed all
  sizes, including 100 MiB. Cause
  not yet established. Do not call this a Safari compatibility pass or relax
  the deadline. Failure diagnostics contain candidate-type counts, not addresses.
- Edge fixture: could not start because Microsoft Edge is not installed on this Mac.
- Compressed WASM from the working-tree build: 7,697,413 bytes; raw WASM omitted.
- Existing Chrome `headers`, `file-sinks`, `transport`, `group-ticket-security`:
  29/29 passed. This is a selected regression subset, not the complete matrix.

Reproduce:

```sh
npm run test:unit
PAGES_BUILD=1 ./build.sh dist
npx playwright test tests/e2e/native-file-stream.spec.js --project=chrome --project=android-chrome --project=ios-safari
npx playwright test tests/e2e/headers.spec.js tests/e2e/file-sinks.spec.js tests/e2e/transport.spec.js tests/e2e/group-ticket-security.spec.js --project=chrome
```

## Required implementation before any preview release

1. Archive the existing production source in a separate baseline PR; reconcile
   GitHub main and Pages deployment settings without publishing new behavior.
2. Diagnose WebKit ICE failure with candidate-type counts only (no candidate
   addresses). Validate behavior in separate pages and real Safari. Missing
   direct connectivity must still result in a tested, functional DERP path.
3. Integrate the manager with private control port 100 and authorized pairwise
   group coordination. Bind identity to actual authenticated room state, retain
   capability fields in member filters, require owner support, and revoke all
   callbacks/attempts on leave. Never treat `isAuthorized` test fixtures as auth.
4. Extract shared TCF1 file execution and implement logical/attempt IDs across
   private/group tasks. Connect user consent, sender limits, fresh group tickets,
   serial OPFS/picker reset and hashing to the retry orchestrator. Return stream
   credit only after sink write + hash. Add wire-level result query and restart
   confirmation, 15-second recovery deadline, and nonduplicating auto-receive budget.
5. Add per-recipient bilingual state UI, forceDerp selection-only option,
   disabled-by-default static `nativeFileTransfer.enabled`, DTLS/IP disclosures,
   version/source-SHA metadata, build manifests, and 14-day CI evidence artifacts.
6. Run complete deterministic room/file/OPFS/media regressions, new/old protocol
   interoperability, corruption/cancel/disk failures, lost DONE/query/control,
   simultaneous sends, group membership races and late-generation writes.

## Release gates still outstanding

No isolated Pages preview has been created, no PR merged, no production feature
enabled, and no release tag created. Publish only to a separate public/noindex
native-file preview project after integration gates; do not add Access.

The full user-approved Windows/macOS/Android/iOS hardware matrix, carrier/NAT/
UDP/STUN-blocking runs, 1 GiB stress, interruption/retry, DERP-byte attribution,
memory bounds, 50-cycle cleanup and seven-day/50-session observation are all
outstanding. Local transport tests do not substitute for them.

After all gates: reconcile main, deploy the feature disabled, smoke-test DERP,
enable private + group together as `0.4.0-beta.1`, then observe before tagging.
Rollback remains a static flag redeploy followed by Pages deployment rollback;
already-open pages retain their loaded configuration.
