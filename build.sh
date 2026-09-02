#!/usr/bin/env bash
set -euo pipefail

out="${1:-dist}"
if [[ "$out" != "dist" ]]; then
  echo "refusing output outside the dedicated dist directory: $out" >&2
  exit 2
fi

webrtc_lab=false
case "${TAILCAT_WEBRTC_EXPERIMENT:-}" in
  ""|0)
    ;;
  1)
    webrtc_lab=true
    ;;
  *)
    echo "TAILCAT_WEBRTC_EXPERIMENT must be exactly 0, 1, or unset" >&2
    exit 2
    ;;
esac

# The dedicated switch above is the only supported way to select build tags.
# This prevents an inherited GOFLAGS value from silently turning an ordinary
# Pages build into the laboratory transport build (or adding unrelated tags).
effective_goflags="$(go env GOFLAGS)"
if [[ "$effective_goflags" == *-tags* ]]; then
  echo "refusing build tags from GOFLAGS; use TAILCAT_WEBRTC_EXPERIMENT=1" >&2
  exit 2
fi

required_go_version="go1.27.0"
actual_go_version="$(go env GOVERSION)"
if [[ "$actual_go_version" != "$required_go_version" ]]; then
  echo "Go $required_go_version is required; found $actual_go_version" >&2
  exit 1
fi

rm -rf -- "$out"
mkdir -p "$out"

# Copy the complete static tree, including nested assets and dotfiles.
cp -R web/. "$out/"
cp LICENSE THIRD_PARTY_NOTICES.md "$out/"

build_sha="${CF_PAGES_COMMIT_SHA:-}"
if [[ ! "$build_sha" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  build_sha="$(git rev-parse --verify HEAD)"
fi
if [[ ! "$build_sha" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  echo "unable to determine a valid build commit SHA" >&2
  exit 1
fi
build_sha="$(printf '%s' "$build_sha" | tr '[:upper:]' '[:lower:]')"
printf '%s\n' \
  '(function () {' \
  '  "use strict";' \
  '  Object.defineProperties(globalThis, {' \
  "    __TAILCAT_BUILD_SHA__: { value: \"$build_sha\", writable: false, configurable: false }," \
  "    __TAILCAT_WEBRTC_LAB__: { value: $webrtc_lab, writable: false, configurable: false }" \
  '  });' \
  '}());' > "$out/build-info.js"

# build-info.js is generated rather than tracked and must execute before the
# app module imports config.js. Modify only the disposable distribution copy.
if [[ "$(grep -c '<script src="wasm_exec.js"></script>' "$out/index.html")" != "1" ]]; then
  echo "could not locate the unique wasm_exec.js script in dist/index.html" >&2
  exit 1
fi
sed '/<script src="wasm_exec.js"><\/script>/i\
  <script src="build-info.js"></script>
' "$out/index.html" > "$out/index.html.with-build-info"
mv "$out/index.html.with-build-info" "$out/index.html"

if [[ "$webrtc_lab" == "true" ]]; then
  GOOS=js GOARCH=wasm go build -tags=tailcat_webrtc_experiment -trimpath -ldflags="-s -w" -o "$out/main.wasm" .
else
  GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$out/main.wasm" .
fi
gzip -9 -n -c "$out/main.wasm" > "$out/main.wasm.gz"

# wasm_exec.js must come from the exact Go toolchain that compiled main.wasm.
wasm_exec="$(go env GOROOT)/lib/wasm/wasm_exec.js"
if [[ ! -f "$wasm_exec" ]]; then
  echo "wasm_exec.js not found in the active Go toolchain: $wasm_exec" >&2
  exit 1
fi
cp "$wasm_exec" "$out/wasm_exec.js"
touch "$out/.nojekyll"

# Cloudflare Pages rejects files larger than 25 MiB. app.js fetches the gzip
# file directly and decompresses it in the browser, so production artifacts do
# not include the larger raw binary.
if [[ "${PAGES_BUILD:-}" == "1" ]]; then
  rm -- "$out/main.wasm"
fi

echo "tailcat.app distribution written to $out/"
