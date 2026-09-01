# tailcat.app

An unofficial, accountless, one-to-one encrypted browser room built from [Tailcatchat](https://github.com/tailscale/tailcatchat) and [Tailcat](https://github.com/tailscale/tailcat).

> **Public beta:** public Tailcat DERP relays are rate-limited, best-effort infrastructure with no uptime SLA or throughput target. Do not use this service as the only copy of important data.

tailcat.app supports temporary text, file, and voice-note transfers while both people are online, plus WebRTC voice/video calls and screen sharing. There is no account, application database, offline file store, cloud chat history, recovery service, content moderation, or malware scanning.

This project is not affiliated with or endorsed by Tailscale Inc. It does not use Tailscale logos. Upstream code, copyright notices, and the BSD-3-Clause license are preserved; see [LICENSE](LICENSE), [UPSTREAM.md](UPSTREAM.md), and the in-app [license page](web/licenses/index.html).

## Product contract

- One active peer per room. The first successful protocol handshake locks the room; later peers are rejected.
- Rooms are ephemeral by default and stop listening when the page closes or after 30 minutes idle.
- A user may explicitly remember an address. Its private key is stored only in this origin's IndexedDB and can be removed with **Forget address** or by clearing site data.
- Invitations use `https://tailcat.app/#v=1&invite=<tc…>`. The application consumes and immediately removes the fragment from the address bar. URL fragments are not sent in ordinary HTTP requests.
- Text, file, voice-note, and call-signaling content travels over Tailcat with WireGuard end-to-end encryption.
- Browser Tailcat traffic currently passes through DERP. A relay cannot read encrypted content but can observe IP addresses, time, relay region, approximate volume, and traffic patterns.
- Live media uses browser WebRTC DTLS-SRTP and `stun:stun.cloudflare.com:3478`, with no TURN fallback. The peer and STUN service may see public IP information, and calls may fail on restrictive networks.
- Files require recipient approval and are not automatically downloaded, opened, previewed, or scanned.
- No third-party scripts, remote fonts, client analytics, or remote error reporting are loaded in the initial beta.

The complete bilingual disclosures are in `web/privacy/`, `web/terms/`, `web/acceptable-use/`, `web/security/`, and `web/licenses/`. Abuse reports go to `abuse@tailcat.app`; never include a private key, full invitation link, or sensitive file in a report.

## Browser support

| Browser | Status | Notes |
| --- | --- | --- |
| Chrome on Windows/macOS | Supported | Full text, file, voice, video, and screen-sharing target |
| Edge on Windows/macOS | Supported | Full desktop target |
| Chrome on Android | Beta | Keep the page in the foreground; screen sharing is hidden where unsupported |
| Firefox, Safari, other browsers | Unsupported | The application shows an incompatibility notice and does not start a room |

Camera, microphone, and display capture require a user action and browser permission. HTTPS is required in production; `localhost` is treated as a secure context for local development.

## Transfer protocol and limits

The application handshake declares protocol version and capabilities. An incompatible peer is rejected instead of falling back to an unsafe whole-file-in-memory transfer.

| Port | Purpose |
| ---: | --- |
| 100 | Room handshake, peer lock, capabilities, and WebRTC signaling |
| 101 | Text messages |
| 102 | `TCF1` streaming file transfer |
| 103 | Voice notes |

`TCF1` sends file metadata, waits for recipient approval and a save destination, transfers 64 KiB chunks, computes incremental SHA-256, verifies both declared size and digest, and then exchanges completion acknowledgement. Reject, cancel, disconnect, write failure, size mismatch, or hash mismatch aborts the transfer and must not show success. Multiple files are queued as separate messages, with one active file transfer at a time.

| Item | Beta limit |
| --- | ---: |
| File | 1 GiB per file |
| Text | 64 KiB UTF-8 |
| Voice note | 2 minutes or 10 MiB, whichever occurs first |
| Peers | 1 active peer per room |
| Idle listener | 30 minutes |

## Build locally

The release toolchain is fixed at Go `1.27.0`. The repository has no Node build step and all browser assets are local.

```sh
go version
PAGES_BUILD=1 ./build.sh dist
python3 -m http.server 8080 --directory dist
```

Open <http://localhost:8080>. The Pages build keeps `main.wasm.gz` and removes the approximately 32 MiB uncompressed `main.wasm`. The browser fetches and decompresses the gzip file itself; the server must serve it as `application/gzip` **without** `Content-Encoding: gzip`.

Before publishing, verify:

```sh
test -f dist/main.wasm.gz
test ! -f dist/main.wasm
test "$(wc -c < dist/main.wasm.gz)" -lt 26214400
```

Use a local static server instead of opening `index.html` as a `file:` URL. Some network and media features still require the public DERP/STUN services during local testing.

## Automated tests

The deterministic suite runs the production framing and UI across two real
browser pages while replacing only the Tailcat network stream. It covers the
three-step handshake, peer locking, text/voice acknowledgements, remembered
keys, streaming boundaries through 100 MiB, queue order, rejection,
cancellation, peer close, hash and disk failures, protocol mismatch, relay
unavailability, idle shutdown, security headers, real 404s, and unsupported
browser states.

```sh
npm ci
npm run test:e2e
```

CI installs and runs both the stable Chrome and Microsoft Edge channels. A
separate opt-in smoke test uses the real Tailcat WASM bridge and public Tokyo
DERP relay; it is intentionally excluded from deterministic CI because the
public relay has no SLA:

```sh
LIVE_DERP=1 npm run test:e2e -- --project=chrome --grep "live Tokyo DERP"
```

## Cloudflare Pages deployment

Connect the public GitHub repository `chaiyalin/tailcat.app` to a Pages project with these exact build settings:

| Setting | Value |
| --- | --- |
| Project name | `tailcat-app` |
| Production branch | `main` |
| Framework preset | None |
| Build system | Version 3 |
| Build command | `PAGES_BUILD=1 ./build.sh dist` |
| Build output directory | `dist` |
| Environment variables | `GO_VERSION=1.27.0`, `SKIP_DEPENDENCY_INSTALL=1` |

The build output must contain `_headers`, `404.html`, `robots.txt`, the legal pages, and only the compressed WASM. `web/_headers` applies:

- a strict same-origin CSP that permits the local JavaScript/WASM runtime, `https://tailcat.dev`, Tailcat DERP WebSockets at `wss://*.ipn.dev`, and local `blob:` media;
- camera, microphone, and display-capture permissions only for this origin;
- frame, object, and form blocking plus `no-referrer`, `nosniff`, HSTS, and public-beta `noindex`;
- revalidation caching for HTML, JavaScript, CSS, configuration, and unversioned assets; and
- `application/gzip`, `no-transform`, and no `Content-Encoding` for `main.wasm.gz`.

### Domain and operations checklist

1. Protect preview deployments with Cloudflare Access and complete two-browser acceptance testing on a preview URL.
2. Add `tailcat.app` from **Pages → Custom domains** so Pages creates the DNS record and certificate. Do not pre-create a root CNAME.
3. Create a Cloudflare Redirect Rule for `www.tailcat.app` to `https://tailcat.app` with path and query preserved.
4. Redirect the production `tailcat-app.pages.dev` hostname to the canonical domain while keeping branch preview hostnames protected by Access.
5. Keep Cloudflare Web Analytics and any browser-injected analytics disabled for the initial beta.
6. Enable Cloudflare Email Routing for `abuse@tailcat.app`, forward it to the verified operator mailbox, and test receipt in both directions.
7. Confirm HTTPS is active, the `www` redirect preserves paths, missing paths return the real `404.html` with status 404, `/main.wasm` returns 404, `/main.wasm.gz` is below 25 MiB and has no `Content-Encoding`, and `https://tailcat.dev/derpmap.json` returns JSON without CSP/CORS errors.

Cloudflare Pages handles ordinary request and security metadata at the edge. The application does not log private keys, invitation fragments, or full URLs. See the bilingual [Privacy Notice](web/privacy/index.html) for the complete data-flow description.

## Release gates

Automated and real-device tests must cover handshake and second-peer rejection; ephemeral and persistent addresses; text and voice notes; 0 B, 1 B, 64 KiB, 64 KiB + 1 B, 100 MiB, and 1 GiB files where specified; consent rejection; cancel; peer close; DERP outage; idle timeout; digest mismatch; disk-write failure; and protocol mismatch.

Desktop Chrome and Edge should each complete a 1 GiB transfer on Windows and macOS. Android Chrome should complete at least 100 MiB plus voice-note and video tests. Firefox and Safari must show the unsupported-browser state. Regional checks should cover public DERP behavior on China Mobile, China Unicom, and China Telecom without assuming any relay has an SLA.

Release sequence: Access-protected preview → `pages.dev` smoke test → custom domain → limited public beta → one-week observation → tag `app-v0.1.0-beta.1`. Use Cloudflare Pages deployment rollback or the static room-disable configuration if production must be stopped.

## Upstream and dependency policy

Production pins `github.com/tailscale/tailcat` to release `v0.4.0`; it never tracks `main` automatically. Tailcat makes no API, CLI, or wire-format stability promise, so every upgrade happens on a dedicated branch and must pass old/new-page interoperability and persistent-key migration tests. See [UPSTREAM.md](UPSTREAM.md) for the update procedure.

## License

BSD 3-Clause License. Copyright (c) 2026, Tailchat contributors. All rights reserved. See [LICENSE](LICENSE) for the controlling text and `web/licenses/` for attribution. Tailcat source files carry `Copyright (c) Tailscale Inc & contributors` and `SPDX-License-Identifier: BSD-3-Clause`.
