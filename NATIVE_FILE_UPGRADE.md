# Native file transfer — implementation and release evidence

Candidate: `0.4.0-beta.1`, branch `feature/native-webrtc-files`.
Updated: 2026-09-05. **Integrated candidate; production acceptance remains open.**

## Production baseline

Production remains `0.3.0-beta.1`, source
`9df79d476d22cdab53cf92a996becf412ff47545`, Pages deployment
`6c2748cd-9377-4f10-8644-d54f8909dc16` in `tailcat-app`.
The source is separately archived in [draft PR #2](https://github.com/chaiyalin/tailcat.app/pull/2).
Remote main was `4f3d9b70e8e777bf596b4ccfaa7a4aab0e8ad17e`.
Do not merge the baseline without reconciling deployment flags: production has
group rooms enabled, mobile group hosting disabled and preview invites disabled.
Default source builds disable all opt-in switches.

Baseline production SHA-256 matches:

| Asset | SHA-256 |
| --- | --- |
| app.js | aca6e21f2a4686b1bec18e47166bcd7105f4f84013f42cca0c9cf089ba5db0e2 |
| config.js | d256687f086443870b58529ab1c8b383c9eabd92be64c69a1f4fd54dd1ac124d |
| group-room.js | 9635de59933f4859e3ec85b53d1e1c7de4242a28bba0347878b64d9d3a2ff713 |
| file-sinks.js | 3044fa42e8a6b80467627befec972096937af1091f1e26364c54865e4971ade7 |
| main.wasm.gz | 6adc4216a578bc3a7f8aca32f5cdfec3cb6a1b94fe854569ed8ce721882a82f8 |

Production HTML has an observed Cloudflare email-obfuscation script injection;
do not copy that transformation to source. The no-injected-script production
gate is open. No production or Magicsock deployment is changed here.

## Integrated implementation

- Optional file transport negotiation, fixed-schema group capability filtering
  and owner-capability gate. Old peers retain the original TCF1 flow.
- Private SDP/ICE signaling uses authenticated control port 100. Group members
  obtain existing owner grants, then exchange signaling directly on the
  authorized sender/receiver Tailcat file coordination stream. The owner does
  not forward pairwise SDP or file bodies.
- Per-room/per-peer FileTransportManager: deterministic offerer, authenticated
  pair and generation binding, lazy PC creation/reuse, one incoming transfer,
  two outgoing recipient lanes, 10-second setup, 60-second failure cooldown,
  30-second idle cleanup, Cloudflare STUN only, independent from media calls.
- Reliable ordered byte adapter: 16 KiB messages including outer headers
  (subject to SCTP limit), 512/128 KiB send watermarks, 1 MiB receiver credit
  and 256 KiB replenishment. Credit returns after disk write and hash.
- TCF1 acceptance remains on Tailcat. Both paths retain 64 KiB file chunks,
  incremental WASM SHA-256 and size/digest/DONE verification.
- FileCoordination multiplexes SELECT/QUERY/RESET/SIGNAL/FINISHED and bounded
  relay bytes after negotiated ACCEPT. Logical IDs remain stable; attempts
  change. Direct failure queries the result before at most one DERP restart.
  A committed receipt must match the sender's independently computed digest.
  Missing/unknown results never authorize another save.
- Completion receipts are session-memory only, bound to peer/room/logical ID/
  size/hash, limited to 256 with 30-minute TTL, cleared on room end.
- Group restart obtains and consumes a fresh ticket bound to the new attempt,
  room, sender, recipient and size. Consumed tickets cannot be reused.
- Writer settlement precedes reset. Picker resets truncate and seek the same
  uncommitted transaction. OPFS removes the old partial file and allocates a
  fresh random local name. Verified files remain intact. Retry never re-enters
  consent and therefore never double-charges automatic receive budgets.
- Separate incoming/outgoing private lanes allow simultaneous bidirectional
  files. Cancellation, room exit and revocation close streams/coordinators.
- Bilingual per-file/per-recipient path, restart, verification, failure and
  unconfirmed-result UI; per-recipient progress; mobile drawer relay-only toggle.
  Local `tailcat.forceDerp=1` changes selection, never endpoint addresses.
- Static native switch defaults off. DTLS/WireGuard/IP disclosures; no added
  remote scripts, analytics, backend, TURN or camera/microphone permissions.
- Build emits source SHA and `build-manifest.json`: Go/dependency versions,
  dirty-state indicator, asset sizes and SHA-256. CI retains evidence 14 days.
  Pages artifacts contain only compressed WASM, never the raw binary.

## Local verification

- Unit suite: **31 passed**.
- Full Chrome + Android touch emulation + WebKit mobile suite: **170 passed,
  4 conditional skips, zero failures**. Skips are the opt-in live test and
  three Safari-specific cases excluded on Android.
- New integration: 0 B, 1 B, 16 KiB, 64 KiB, 64 KiB+1 and 100 MiB, actual native
  PCs with mocked Tailcat, SHA-256, reuse, legacy negotiation, force-DERP,
  OPFS reset, picker reset without a second prompt, lost DONE, disk failure,
  private duplex, fresh group tickets and member-to-two-recipient transfer.
- The 100 MiB case observes less than 2 MiB of mocked Tailcat writes. This is
  path evidence, **not a real DERP traffic measurement**.
- Android emulation uses actual Chromium OPFS. WebKit's ephemeral macOS
  runner rejects native getDirectory() with UnknownError before transfer.
  Its integration uses an explicitly marked storage fixture with actual
  DataChannels, **not proof of Safari filesystem or iPhone compatibility**.
  Existing async/worker filesystem protocol tests remain in the suite.
- Earlier standalone WebKit ICE intermittently timed out at 10 seconds;
  the latest complete run passed. Hardware/network reliability is still open.
- Edge is absent from this Mac. CI targets Edge; configuration alone is not a pass.
- `go mod verify`: all modules verified. Tailcat v0.4.0 and existing Tailscale
  `72780705eda8` dependency unchanged. No draft fork or Magicsock integration.

## Known limits and production blockers

1. Loss of the coordination stream fails safely as an unconfirmed result.
   This candidate does not reopen that stream inside the same logical task.
   The 15-second QUERY deadline bounds a still-live stream. Do not claim
   automatic recovery from simultaneous control/data loss.
2. A picker reset requiring renewed authorization fails explicitly. An in-task
   click-to-reauthorize continuation is not implemented; no picker is opened
   automatically and no false success is displayed.
3. Real Windows/macOS Edge, Android 132/current, Safari 17/18/26 hardware matrix,
   both directions, iOS OPFS worker/export/cleanup and lifecycle/network-switch
   checks remain unverified.
4. Required 1 GiB stress, hardware memory attribution, NAT/carrier/UDP/STUN
   blocking, 20 interruption trials, 19/20 direct success, true DERP traffic
   attribution and 50-cycle endurance remain open.
5. Production/new-page interoperability, main/deployment reconciliation and
   production no-script-injection checks must pass before enabling production.
6. Seven days and at least 50 real sessions have not been observed. No release
   tag until that observation and every other gate pass.

## Reproduce and isolated preview

```sh
npm ci
npm run test:unit
PAGES_BUILD=1 ./build.sh dist
npx playwright test --project=chrome --project=android-chrome --project=ios-safari
bash tests/e2e/release-contract.sh
LIVE_DERP=1 LIVE_NATIVE=1 npx playwright test tests/e2e/live-derp.spec.js --project=chrome

# Separate public native preview only, never tailcat-app:
PAGES_BUILD=1 TAILCAT_GROUP_ROOMS_ENABLED=1 TAILCAT_PREVIEW_INVITES=1 TAILCAT_NATIVE_FILES_ENABLED=1 ./build.sh dist
```

Preview is public/noindex, no Access, no custom domain. Production stays gated.
After acceptance: merge archived baseline and reviewed native PR; deploy native
off first; smoke-test DERP; enable native; observe; then tag.

Rollback by rebuilding native off and redeploying the same project, preserving
the environment's other switches. Already-open pages retain loaded config.
Production and the Magicsock preview are not part of native-preview rollback.
