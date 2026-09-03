# tailcat.app

An unofficial, accountless encrypted browser room built from [Tailcatchat](https://github.com/tailscale/tailcatchat) and [Tailcat](https://github.com/tailscale/tailcat). It keeps the existing one-to-one room and adds an opt-in **Group Beta** for temporary rooms of up to 10 people.

> **Public beta:** public Tailcat DERP relays are rate-limited, best-effort infrastructure with no uptime SLA or throughput target. Do not use this service as the only copy of important data.

> **Release target `0.3.0-beta.1`:** Group Beta is implemented behind the independent `groupRoomsEnabled` and `mobileGroupHostingEnabled` static release switches. Both remain off in production until their 3/6/10-person, public-DERP, and real-device gates pass. Disabling either group switch does not affect private one-to-one rooms.

tailcat.app supports temporary text, file, and voice-note transfers while participants are online. Private rooms also support WebRTC voice/video calls and screen sharing; Group Beta does not. There is no account, application database, server-side file store, offline delivery, cloud chat history, recovery service, content moderation, or malware scanning. iOS Safari may use this origin's private browser storage to stage an approved incoming file until the user exports or deletes it.

This project is not affiliated with or endorsed by Tailscale Inc. It does not use Tailscale logos. Upstream code, copyright notices, and the BSD-3-Clause license are preserved; see [LICENSE](LICENSE), [UPSTREAM.md](UPSTREAM.md), and the in-app [license page](web/licenses/index.html).

## Product contract

- Private rooms retain one active peer. Their first successful protocol handshake locks the room; later peers are rejected.
- Group Beta rooms allow up to 10 people including the host. The host approves each 60-second join request after the applicant supplies a 1–24-character nickname; nicknames are unverified, can be duplicated, and are always shown with a random member code.
- Group text and membership events are ordered and relayed by the trusted host. The host can see group text, nicknames/member codes, membership relationships, file sizes, and selected recipients. Each Tailcat network link is encrypted, but Group Beta is not host-blind group end-to-end encryption. Files and voice notes travel directly from the sender to selected recipients; unless selected as a recipient, the host does not receive their file names, audio, or content.
- Rooms are ephemeral by default. A Group Beta host must remain online: closing or refreshing the host page ends the room for everyone, with no host transfer. New members receive no earlier messages. An existing member can recover limited in-memory events during a 120-second reconnect window, but there is no cloud history or offline delivery.
- A user may explicitly remember an address. Its private key is stored only in this origin's IndexedDB and can be removed with **Forget address** or by clearing site data.
- Production private invitations use `https://tailcat.app/#v=1&invite=<tc…>`. Production group invitations use `https://tailcat.app/#v=1&mode=group&gv=1&invite=<tc…>&room=<128-bit-id>&join=<256-bit-token>`. Protected preview builds keep invitations on their own HTTPS origin so testers are not redirected to production. The application consumes and immediately removes either fragment from the address bar. URL fragments are not sent in ordinary HTTP requests. Rotating a group join token invalidates old invitations without disconnecting current members.
- In a private room, text, files, voice notes, and call signaling travel over the direct two-party Tailcat relationship with WireGuard encryption. In Group Beta, every sender–host or sender–recipient Tailcat link is encrypted under the trust model above.
- Browser Tailcat traffic currently passes through DERP. A relay cannot read encrypted content but can observe IP addresses, time, relay region, approximate volume, and traffic patterns.
- Live media uses browser WebRTC DTLS-SRTP and `stun:stun.cloudflare.com:3478`, with no TURN fallback. The peer and STUN service may see public IP information, and calls may fail on restrictive networks.
- Files require each recipient's approval and are not automatically opened, previewed, or scanned. Group voice notes also require each selected recipient to accept before their audio bytes are sent. Android Chrome writes to a user-selected destination; iOS Safari verifies an approved file in origin-private temporary storage before a second user action exports it. In a group, one recipient's rejection or failure does not stop other recipients.
- Mobile rooms and transfers are foreground-only beta features. A mobile Group Beta host must explicitly acknowledge this risk and keep the screen awake with the page in the foreground. Backgrounding pauses joining and sends; returning within 120 seconds may recover the room, otherwise it ends for everyone. File transfers are not resumable.
- No third-party scripts, remote fonts, client analytics, or remote error reporting are loaded in the initial beta.

The complete bilingual disclosures are in `web/privacy/`, `web/terms/`, `web/acceptable-use/`, `web/security/`, and `web/licenses/`. Abuse reports go to `abuse@tailcat.app`; never include a private key, full invitation link, or sensitive file in a report.

## Browser support

| Browser | Status | Notes |
| --- | --- | --- |
| Chrome on Windows/macOS | Supported | Full text, file, voice, video, and screen-sharing target |
| Edge on Windows/macOS | Supported | Full desktop target |
| Chrome 132+ on Android | Beta | Keep the page in the foreground; direct incoming-file saving; outgoing screen sharing is hidden |
| Safari 17+ on iOS/iPadOS | Beta | Keep the page in the foreground; approved incoming files use OPFS staging and user-initiated export |
| iOS Chrome, Android Edge, Samsung Internet | Not a release target | Capability detection may offer a limited mode, but this beta makes no compatibility commitment |
| Firefox, desktop Safari, and other browsers | Not a release target | Core-capable builds may enter an explicitly limited mode; this beta makes no compatibility commitment |

Camera, microphone, and display capture require a user action and browser permission. HTTPS is required in production; `localhost` is treated as a secure context for local development.

Mobile layouts use staged views for room creation, invitation, chat, and calls. A mobile Group Beta host requests a screen wake lock for the room's lifetime; private rooms request one during active handshakes, transfers, recordings, or calls. A wake lock reduces accidental sleep but cannot make background operation reliable.

## Transfer protocol and limits

The application handshake declares protocol version and capabilities. File capabilities include the receiver's current `maxBytes` and optional `sink` (`picker` or `opfs-export`); senders enforce the advertised limit. An incompatible peer is rejected instead of falling back to an unsafe whole-file-in-memory transfer, and older version-1 peers may ignore the added optional fields.

| Port | Purpose |
| ---: | --- |
| 100 | Room handshake, peer lock, capabilities, and WebRTC signaling |
| 101 | Text messages |
| 102 | `TCF1` streaming file transfer |
| 103 | Private `TCH1` voice notes and Group Beta `TCV1` voice offers/data |
| 104 | `TCG1` persistent Group Beta control and text stream |

`TCF1` sends file metadata, waits for recipient approval and a safe sink, transfers 64 KiB chunks, computes incremental SHA-256, verifies both declared size and digest, and then exchanges completion acknowledgement. Reject, cancel, disconnect, write failure, size mismatch, or hash mismatch aborts the affected transfer and must not show success. Private-room files remain sequential.

Group files and voice notes use host-coordinated, single-use transfer tickets bound to the room, sender, recipient, transfer ID, type, and size. A ticket is issued only when its target leaves the queue, the host first arms the intended recipient, and the recipient must ask the online host to consume it before accepting any payload. It must be used once and within 120 seconds; removal, pause, room closure, binding mismatch, or replay invalidates it. `TCV1` separates a group voice offer, the recipient's accept/reject decision, the audio body, and the completion acknowledgement, so a declined recipient receives no audio bytes. At most two recipient transfers run in parallel and the rest queue. A file batch must satisfy `sum(file size × selected recipients) <= 1 GiB`.

`TCG1` starts with the four-byte `TCG1` magic and then uses 32-bit-length-prefixed JSON frames. The host binds identity to the approved control stream, ignores client-claimed sender identity, assigns a monotonically increasing sequence, deduplicates the latest 256 client event IDs per member, and broadcasts committed events. Each member has an independent bounded send queue; a slow member is disconnected without blocking the room. Reconnect replay is limited to the newest 100 events or 8 MiB held in the host's memory.

For OPFS receive, the app uses a random transfer identifier rather than the offered file name as its internal path. Before accepting bytes it requires estimated free space of at least the file size plus the larger of 64 MiB or 10%. A verified temporary file remains local to this browser origin only until the user exports or deletes it; startup cleanup removes abandoned transfer entries. If OPFS or a trustworthy storage estimate is unavailable, that browsing mode can still send files but cannot receive them.

| Item | Beta limit |
| --- | ---: |
| File | 1 GiB per file |
| Text | 64 KiB UTF-8 |
| Voice note | 2 minutes or 10 MiB, whichever occurs first |
| Private room | 1 active peer |
| Group Beta | 10 people including the host |
| Group file batch | 1 GiB after multiplying each file by selected recipients |
| Group recipient transfers | 2 active at once; remaining recipients queue |
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

The deterministic suite runs the production framing and UI across real browser
pages while replacing only the Tailcat network stream. Existing private-room
coverage remains intact. Group coverage includes 10 successful members and an
11th `FULL` response; concurrent approval, rejection, expiry, invitation
rotation, removal, host shutdown, 1,000 interleaved messages, reconnect replay
and gaps, slow-member isolation, per-recipient file outcomes, one-time ticket
replay rejection, per-recipient voice accept/reject outcomes, and the exact
aggregate batch boundary.

```sh
npm ci
npm run test:e2e
```

CI installs stable Chrome, Microsoft Edge, and WebKit; it runs the desktop suite
plus Android-touch Chrome and iOS-Safari mobile projects. Playwright's macOS
WebKit build does not currently expose a usable OPFS directory in this runner,
so it validates the Safari shell and capability behavior while the async OPFS
and worker protocols run in deterministic module tests. A real iPhone/iPad
Safari receive/export/cleanup run remains a mandatory release gate and is never
inferred from a skipped emulation test. A separate opt-in smoke test uses the
real Tailcat WASM bridge and public Tokyo
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

Production must leave `TAILCAT_GROUP_ROOMS_ENABLED`, `TAILCAT_MOBILE_GROUP_HOSTING_ENABLED`, and `TAILCAT_PREVIEW_INVITES` unset (or set to `0`). For an Access-protected branch preview, set `TAILCAT_GROUP_ROOMS_ENABLED=1` and `TAILCAT_PREVIEW_INVITES=1`; enable `TAILCAT_MOBILE_GROUP_HOSTING_ENABLED=1` only while running the mobile-host gate. `build.sh` accepts only `0` or `1`, rejects mobile hosting without group rooms, and generates the public `runtime-config.js` artifact. No secret belongs in these variables or that file.

A local preview-equivalent artifact can be built with:

```bash
PAGES_BUILD=1 TAILCAT_GROUP_ROOMS_ENABLED=1 TAILCAT_PREVIEW_INVITES=1 ./build.sh dist
```

The build output must contain `_headers`, `404.html`, `robots.txt`, the legal pages, and only the compressed WASM. `web/_headers` applies:

- a strict same-origin CSP that permits the local JavaScript/WASM runtime, `https://tailcat.dev`, Tailcat DERP HTTPS probes and WebSockets at `https://*.ipn.dev` / `wss://*.ipn.dev`, and local `blob:` media;
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

Automated and real-device tests must preserve the private-room gates for handshake and second-peer rejection; ephemeral and persistent addresses; text and voice notes; 0 B, 1 B, 64 KiB, 64 KiB + 1 B, 100 MiB, and 1 GiB files where specified; consent rejection; cancel; peer close; DERP outage; idle timeout; digest mismatch; disk-write failure; and protocol mismatch.

Desktop Chrome and Edge should each complete a 1 GiB transfer on Windows and macOS. Android Chrome 132 and the current Android Chrome must complete at least 100 MiB plus voice-note and video tests. iOS Safari 17/18 and the current Safari must verify, export, and clean up at least a 100 MiB incoming file. Android-to-iPhone tests cover both file directions, text, voice notes, video, mobile receipt of desktop screen sharing, save cancellation, lock/background behavior, network switching, and STUN failure. Firefox and non-target mobile browsers must show the correct incompatible or limited state. Regional checks should cover public DERP behavior on China Mobile, China Unicom, and China Telecom without assuming any relay has an SLA.

Group Beta adds an Access-protected preview gate at 3, 6, and then 10 people. The 10-browser gate runs for 60 minutes over real public DERP, sends a 1 MiB file to nine recipients and a 100 MiB file to two recipients with verification, exercises network switching and reconnect, and checks that connection/stream/heap resources are reclaimed across 20 cycles. Android Chrome and iOS Safari must each host nine participants in the foreground for 30 minutes and pass wake-lock failure, background pause, 120-second recovery, and timeout shutdown checks.

Release sequence: Access-protected preview from `feature/group-rooms-v2` → 3/6/10-person gates → public-DERP and real-device gates → merge to `main` with production group switches still off → limited enablement → tag `app-v0.3.0-beta.1`. Any failed group gate leaves `groupRoomsEnabled` off; a failed mobile-host gate leaves `mobileGroupHostingEnabled` off. Cloudflare Pages rollback or either static switch can disable Group Beta without affecting private rooms.

Group diagnostics contain no invitation, token, Tailcat address, nickname, message, file name, content, or IP address. If operational diagnostics are enabled, they are limited to an anonymous run identifier, member count, latency, error category, byte count, and resource counts.

## Upstream and dependency policy

Production pins `github.com/tailscale/tailcat` to release `v0.4.0`; it never tracks `main` automatically. Tailcat makes no API, CLI, or wire-format stability promise, so every upgrade happens on a dedicated branch and must pass old/new-page interoperability and persistent-key migration tests. See [UPSTREAM.md](UPSTREAM.md) for the update procedure.

## License

BSD 3-Clause License. Copyright (c) 2026, Tailchat contributors. All rights reserved. See [LICENSE](LICENSE) for the controlling text and `web/licenses/` for attribution. Tailcat source files carry `Copyright (c) Tailscale Inc & contributors` and `SPDX-License-Identifier: BSD-3-Clause`.
