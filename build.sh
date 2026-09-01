#!/usr/bin/env bash
set -euo pipefail

out="${1:-dist}"
if [[ "$out" != "dist" ]]; then
  echo "refusing output outside the dedicated dist directory: $out" >&2
  exit 2
fi

rm -rf -- "$out"
mkdir -p "$out"

# Copy the complete static tree, including nested assets and dotfiles.
cp -R web/. "$out/"
cp LICENSE THIRD_PARTY_NOTICES.md "$out/"

GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$out/main.wasm" .
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
