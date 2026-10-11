# Upstream maintenance

tailcat.app is a public fork of [tailscale/tailcatchat](https://github.com/tailscale/tailcatchat) with a deliberately pinned [tailscale/tailcat](https://github.com/tailscale/tailcat) dependency. Production does not follow either repository's `main` branch automatically.

## Remotes

The intended remotes are:

```sh
git remote add origin git@github.com:chaiyalin/tailcat.app.git
git remote add upstream https://github.com/tailscale/tailcatchat.git
git remote -v
```

If a remote already exists, update its URL instead of adding a duplicate. Fetching is read-only:

```sh
git fetch --tags origin
git fetch --tags upstream
```

Never force-push `main` to synchronize upstream. Review and integrate upstream changes on a dedicated branch.

## Pinned production baseline

- Tailcatchat upstream: `c170a675bf3ecc7b8d7d852219c65c0bdbe3aaf0`; unchanged as of 2026-10-11.
- Application baseline: the deployed `0.3.0-beta.1` source `9df79d476d22cdab53cf92a996becf412ff47545`.
- Tailcat Go module: release `v0.7.0`, tag commit `15ab9e68bfc6534a61797d7af28cedd42b54a3a5`.
- Tailscale dependency: `v1.103.0-pre.0.20260916030321-a2263542f260`, as selected by the Tailcat release.
- Go toolchain: `1.27.1`.
- Maintenance candidate: `0.3.1-beta.1`; final tag remains gated by real-device and observation evidence.

`go.mod` and `go.sum` are the source of truth for the resolved dependency graph. Do not replace the Tailcat release with `@main`, a floating branch, or an unreviewed pseudo-version.

## Updating Tailcatchat upstream

1. Resolve the actual deployed source and an up-to-date `main`; preserve any already deployed source not yet archived in main. Create an isolated branch named for the reviewed upstream version/date.
2. Fetch `upstream` and inspect its commits and diff from the recorded fork baseline.
3. Cherry-pick or merge only after reviewing changes to browser permissions, invite handling, Tailcat addresses, WebRTC signaling, storage, build artifacts, licenses, and deployment workflow.
4. Preserve the repository-root BSD 3-Clause license and this upstream copyright notice:

   ```text
   Copyright (c) 2026, Tailchat contributors
   All rights reserved.
   ```

5. Reapply or consciously revise tailcat.app product constraints: one active peer in private rooms; an independently gated 10-person temporary Group Beta; immediate fragment removal; private-only explicit address persistence; recipient consent; streaming `TCF1`, `TCV1`, and framed `TCG1`; bounded queues and size limits; local-only QR generation; bilingual disclosures; and Cloudflare security headers.
6. Run the full automated, two-browser, real-device, CSP, and Cloudflare preview checks before merging.

## Updating Tailcat

Tailcat explicitly makes no API, CLI, or wire-format stability promise. Upgrade only to a named release on a dedicated branch, for example:

```sh
git switch -c deps/tailcat-vNEXT
go get github.com/tailscale/tailcat@vNEXT
go mod tidy
go mod verify
```

Replace `vNEXT` with an actual published version; never run the example literally and never use `@main` for production. Review the release notes and dependency diff, then verify:

- the WASM bridge still exposes compatible `tailcatListen`, `tailcatDial`, stable-lifecycle `tailcatConnect`, listener region, and incremental SHA-256 behavior;
- an old production page and the candidate page reject incompatible handshakes safely instead of falling back to whole-file buffering;
- invite and `tc…` parsing remain compatible or fail closed;
- ephemeral and remembered address behavior is correct;
- private text, `TCF1` files, voice notes, and WebRTC signaling pass in both directions, while Group Beta `TCG1`/`TCV1` interoperability and direct selected-recipient transfers pass independently;
- the compressed WASM remains below Cloudflare Pages' 25 MiB per-file limit; and
- the candidate works through every configured public DERP region without assuming uptime or throughput.

If a new wire format cannot read remembered addresses, publish a clear migration notice and require the user to reset the saved address. Never silently reinterpret or upload a stored private key.

## Third-party notices

Every release must audit the actual Go dependency graph and distributed browser assets. Preserve all required notices rather than assuming the primary BSD-3-Clause license covers every transitive module.

The local QR generator is currently `uqr v0.1.3`, vendored as `web/vendor/uqr.js` under the MIT License with `web/vendor/uqr.LICENSE.txt`. Any QR-library update must record its exact version or commit, source URL, license identifier, copyright notices, integrity review, and required license text in `web/licenses/index.html`.

## Release evidence

Keep the reviewed upstream commit, Tailcat version, Go version, dependency verification result, compressed WASM size, browser matrix results, protocol interoperability result, and public isolated preview URL with the release notes. Preview is operator-authorized without Access and retains noindex. Create `app-v0.3.1-beta.1` only after the outstanding real-device and observation gates pass; deterministic CI alone is not sufficient.

## 2026-10-11 synchronization

[Tailcat v0.7.0](https://github.com/tailscale/tailcat/releases/tag/v0.7.0)
contains 52 commits since v0.4.0, including meow/Ping retry, TCP teardown,
WireGuard buffering and gVisor congestion/recovery improvements. These are
upstream implementation changes, not measured browser speed claims.
Tailcatchat has no new commits to integrate. The existing `tsdial` close fix
from `72780705eda8` remains present in the selected Tailscale dependency.

v0.6 introduced default WireGuard preshared keys. This maintenance release
explicitly retains the existing address format: newly generated listener keys
have a zero PSK, and the server uses `DisablePresharedKey: true`. Existing
v0.4 private-key JSON is restored without changing node identity or address.
Previously stored nonzero-PSK keys are rejected explicitly. This preserves
the prior WireGuard security model and old/new-page interoperability; the
new PSK feature needs its own migration release before it can be enabled.

The deprecated `ConnBlob` API is replaced with `Addr`/`ParseAddr`. Application
protocols TCH1/TCF1/TCG1/TCV1, consent, streaming hashes, local storage and room
limits remain unchanged. Production group hosting stays desktop-only. The
unfinished native-file preview and the separate game/rooms worktrees are not
included in this maintenance production rollout.

[Tailscale PR #21030](https://github.com/tailscale/tailscale/pull/21030)
remains Draft and unmerged, with head `35a6fabf9d004f288406ebba28e446cdbfc96d4b`.
It is not imported. Tailcat main commits after v0.7.0 and unrelated Tailscale
release upgrades are also excluded from the fixed release dependency graph.

The previous native-preview CI failure was a wall-clock watchdog running
while WASM initialization blocked the browser event loop. Its controller
test now waits for readiness and advances a controlled clock, while keeping
the 25 ms business timeout and resource-cleanup assertions.

Builds publish `build-manifest.json` with exact dependency versions, source
SHA, dirty status and per-asset SHA-256. Only clean committed builds may be
deployed. Runtime configuration carries the same source SHA.

All private-key JSON parsing paths return a fixed error rather than an
upstream error that could echo malformed key material. Listener, persistent
Client and one-shot dial tests verify rejection before any network request.

The production Pages build environment explicitly records Go `1.27.1`,
`TAILCAT_GROUP_ROOMS_ENABLED=1`, `TAILCAT_MOBILE_GROUP_HOSTING_ENABLED=0` and
`TAILCAT_PREVIEW_INVITES=0`, matching the deployed feature selection. This
sync branch is excluded from the production project's automatic branch
previews; its separate public project is `tailcat-app-upstream-sync`.

All static responses retain revalidation and add `Cache-Control: no-transform`.
This prevents Cloudflare's default email-obfuscation HTML/script injection
without changing zone-wide settings or other sites. The deployed HTML must
match the build manifest and contain no injected decode/analytics script.

Real-network acceptance also exposed a pre-existing startup/close deadlock:
network shutdown inside a `syscall/js.FuncOf` callback could wait for WebSocket
events while blocking their JavaScript event loop. Listener, session and stream
wrappers now synchronously invalidate state and release callbacks, then perform
physical shutdown on Go goroutines. One-shot cleanup retains stream-before-client
ordering; stopped listeners reject late handlers. Blocking-close unit fixtures
require real JavaScript timers to make progress, and the live lifecycle gate
checks immediate close, legacy identity restoration and WebSocket reclamation.
