#!/usr/bin/env bash
set -euo pipefail

out="${1:-dist}"
rm -rf "$out"
mkdir -p "$out"

GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$out/main.wasm" .
gzip -9 -c "$out/main.wasm" > "$out/main.wasm.gz"
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$out/wasm_exec.js"
cp web/index.html web/app.js "$out/"
touch "$out/.nojekyll"

# GitHub Pages cannot negotiate precompressed content. app.js fetches this
# gzip file directly and decompresses it in the browser, so the raw binary is
# unnecessary in the deployment artifact.
if [[ "${PAGES_BUILD:-}" == "1" ]]; then
  rm "$out/main.wasm"
fi

echo "Tailchat distribution written to $out/"
