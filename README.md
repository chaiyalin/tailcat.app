# Tailchat

A small, no-build encrypted browser chat built on [Tailcat](https://github.com/tailscale/tailcat).

Tailchat supports:

- encrypted text messages;
- push-to-talk voice notes;
- file picker and drag-and-drop file transfer;
- static deployment on GitHub Pages.

The interface is plain HTML, CSS, and JavaScript. A small Go WebAssembly bridge imports Tailcat as a Go module dependency and exposes its encrypted transport to the page.

## How it works

One person starts a room and privately shares the generated `tc…` address. The other person pastes that address and presses **Set**. Each chat item is transferred over its own end-to-end encrypted Tailcat stream:

- port 101: text
- port 102: files
- port 103: voice notes

Port 1 remains compatible with raw Tailcat text and file transfers. Browser traffic currently uses DERP relays because browsers cannot use Tailcat's direct UDP path without WebRTC support.

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

Tailcat uses WireGuard encryption for transport. The `tc…` room address contains connection metadata and should be exchanged through a trusted channel. This is an experimental chat application; it does not provide identity verification, message history, delivery queues, or multi-party rooms.
