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

- Tailcatchat fork baseline: the audited commit recorded by Git history when this fork was created.
- Tailcat Go module: release `v0.4.0` exactly.
- Go toolchain: `1.27.0`.
- First public beta tag: `app-v0.1.0-beta.1` after the observation period and release gates pass.

`go.mod` and `go.sum` are the source of truth for the resolved dependency graph. Do not replace the Tailcat release with `@main`, a floating branch, or an unreviewed pseudo-version.

## Updating Tailcatchat upstream

1. Start from an up-to-date local `main` and create a branch named for the reviewed upstream commit, for example `upstream/tailcatchat-YYYYMMDD`.
2. Fetch `upstream` and inspect its commits and diff from the recorded fork baseline.
3. Cherry-pick or merge only after reviewing changes to browser permissions, invite handling, Tailcat addresses, WebRTC signaling, storage, build artifacts, licenses, and deployment workflow.
4. Preserve the repository-root BSD 3-Clause license and this upstream copyright notice:

   ```text
   Copyright (c) 2026, Tailchat contributors
   All rights reserved.
   ```

5. Reapply or consciously revise tailcat.app product constraints: one peer, fragment removal, 30-minute idle shutdown, explicit persistence, receiver consent, streaming `TCF1`, size limits, local-only QR generation, bilingual disclosures, and Cloudflare security headers.
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

- the WASM bridge still exposes compatible `tailcatListen`, `tailcatDial`, listener region, and incremental SHA-256 behavior;
- an old production page and the candidate page reject incompatible handshakes safely instead of falling back to whole-file buffering;
- invite and `tc…` parsing remain compatible or fail closed;
- ephemeral and remembered address behavior is correct;
- text, `TCF1` files, voice notes, and WebRTC signaling pass in both directions;
- the compressed WASM remains below Cloudflare Pages' 25 MiB per-file limit; and
- the candidate works through every configured public DERP region without assuming uptime or throughput.

If a new wire format cannot read remembered addresses, publish a clear migration notice and require the user to reset the saved address. Never silently reinterpret or upload a stored private key.

## Third-party notices

Every release must audit the actual Go dependency graph and distributed browser assets. Preserve all required notices rather than assuming the primary BSD-3-Clause license covers every transitive module.

The local QR generator is currently `uqr v0.1.3`, vendored as `web/vendor/uqr.js` under the MIT License with `web/vendor/uqr.LICENSE.txt`. Any QR-library update must record its exact version or commit, source URL, license identifier, copyright notices, integrity review, and required license text in `web/licenses/index.html`.

## Release evidence

Keep the reviewed upstream commit, Tailcat version, Go version, dependency verification result, compressed WASM size, browser matrix results, protocol interoperability result, and Cloudflare preview URL with the release notes. Create `app-v0.1.0-beta.1` only after the deployment and observation gates in `README.md` are complete.
