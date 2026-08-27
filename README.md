# Tailcatchat

A small, no-build encrypted browser chat built on [Tailcat](https://github.com/tailscale/tailcat).

Tailcatchat supports:

- encrypted text messages;
- push-to-talk voice notes using the microphone button or a 100 ms Enter hold in an empty composer, with automatic playback on receipt;
- file picker and drag-and-drop transfer, with inline image previews and downloads;
- realtime WebRTC voice/video meetings and screen sharing, pinned beside chat with fullscreen expansion;
- static deployment on GitHub Pages.

The interface is plain HTML, CSS, and JavaScript. A small Go WebAssembly bridge imports Tailcat as a Go module dependency and exposes its encrypted transport to the page.

## How it works

One person starts a room and shares the generated invite link through a trusted channel. The link stores the `tc…` address in its URL fragment—for example, `https://example.github.io/tailcatchat/#invite=tc…`—so the address is not sent to the static web server. Opening the link automatically starts a local listener, configures the host as the peer, and sends the new listener address back over an encrypted Tailcat control stream. This makes the chat bidirectional without exposing either address to the static web server. Addresses can also be pasted manually and activated with **Set**.

Each chat item is transferred over its own end-to-end encrypted Tailcat stream:

- port 100: peer handshake
- port 101: text
- port 102: files
- port 103: voice notes

Port 1 remains compatible with raw Tailcat text and file transfers. Browser Tailcat traffic currently uses DERP relays because browsers cannot use Tailcat's direct UDP path without WebRTC support.

Live voice, video, and screen media use encrypted WebRTC DTLS-SRTP connections, with call setup exchanged through Tailcat's encrypted control stream. A public STUN server assists direct path discovery. There is currently no TURN fallback, so live media may fail between restrictive networks even while relayed Tailcat chat continues to work.

## Build locally

Go 1.26.5 or newer is required by the pinned Tailcat dependency.

```sh
./build.sh
python3 -m http.server 8080 -d dist
```

Open <http://localhost:8080>. Microphone access works on localhost and HTTPS origins.

## GitHub Pages

1. Push this repository to GitHub with `main` as the default branch.
2. In **Settings → Pages**, select **GitHub Actions** as the source.
3. Push to `main`, or run the `deploy-pages` workflow manually.

The workflow builds the WebAssembly app and publishes a static Pages artifact. No application server is required.

## Dependency

`go.mod` pins Tailcat to a specific upstream commit for reproducible builds. Update it with:

```sh
go get github.com/tailscale/tailcat@main
go mod tidy
```

## Security notes

Tailcat uses WireGuard encryption for message content. DERP relays can observe that peers communicated, when they communicated, and approximate traffic volume, but cannot read the content. The `tc…` room address contains connection metadata and should be exchanged through a trusted channel. Invite fragments are not sent to the HTTP server, but remain visible to browser history, local browser extensions, screenshots, and anyone who receives the link. Rooms are ephemeral by default, although users can opt to keep an address on one device. This is an experimental chat application; it does not provide identity verification, message history, delivery queues, or multi-party rooms.
