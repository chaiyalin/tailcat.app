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

# Cloudflare's immutable build context is an additional project-isolation
# boundary. A production-project preview of this branch must fail closed, and
# a lab build must identify both the dedicated branch and Pages project. Local
# and GitHub CI builds do not set CF_PAGES and are intentionally unaffected.
if [[ "${CF_PAGES:-}" == "1" ]]; then
  pages_branch="${CF_PAGES_BRANCH:-}"
  pages_url="${CF_PAGES_URL%/}"
  case "$pages_url" in
    https://tailcat-app.pages.dev|https://*.tailcat-app.pages.dev)
      if [[ -e WEBRTC_FORK.lock ]] ||
        grep -Eq 'github\.com/chaiyalin/tailscale|tailcat_webrtc_experiment' go.mod ./*.go ||
        grep -Fq '+webrtc-lab' web/config.js; then
        echo "refusing WebRTC laboratory sources in the production Pages project" >&2
        exit 2
      fi
      ;;
  esac
  if [[ "$pages_branch" == "feature/webrtc-magicsock-experiment" && "$webrtc_lab" != "true" ]]; then
    echo "refusing a DERP-only Pages build of the WebRTC experiment branch" >&2
    exit 2
  fi
  if [[ "$webrtc_lab" == "true" ]]; then
    if [[ "$pages_branch" != "feature/webrtc-magicsock-experiment" ]]; then
      echo "the WebRTC laboratory Pages build requires its dedicated branch" >&2
      exit 2
    fi
    case "$pages_url" in
      https://tailcat-app-webrtc.pages.dev|https://*.tailcat-app-webrtc.pages.dev)
        ;;
      *)
        echo "the WebRTC laboratory build is restricted to tailcat-app-webrtc Pages" >&2
        exit 2
        ;;
    esac
  fi
fi

# The dedicated switch above is the only supported way to influence the Go
# build. Refuse every inherited GOFLAGS value so neither build tags nor module,
# linker, or compiler flags can silently change the reviewed Pages artifact.
effective_goflags="$(go env GOFLAGS)"
if [[ -n "$effective_goflags" ]]; then
  echo "refusing externally configured GOFLAGS; use TAILCAT_WEBRTC_EXPERIMENT=1 for the laboratory build" >&2
  exit 2
fi

required_go_version="go1.27.0"
actual_go_version="$(go env GOVERSION)"
if [[ "$actual_go_version" != "$required_go_version" ]]; then
  echo "Go $required_go_version is required; found $actual_go_version" >&2
  exit 1
fi

build_sha="$(git rev-parse --verify HEAD)"
if [[ ! "$build_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "unable to determine the exact application commit" >&2
  exit 1
fi
if [[ -n "${CF_PAGES_COMMIT_SHA:-}" ]]; then
  pages_sha="$(printf '%s' "$CF_PAGES_COMMIT_SHA" | tr '[:upper:]' '[:lower:]')"
  if [[ ! "$pages_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "CF_PAGES_COMMIT_SHA must be a complete 40-character commit SHA" >&2
    exit 2
  fi
  if [[ "$pages_sha" != "$build_sha" ]]; then
    echo "CF_PAGES_COMMIT_SHA does not match the checked-out commit" >&2
    exit 2
  fi
fi

# Pages publishes only this reviewed, explicit static-file set. Refuse links,
# missing entries, and newly added web files until they are intentionally
# reviewed and added here.
web_files=(
  web/404.html
  web/_headers
  web/acceptable-use/index.html
  web/app.css
  web/app.js
  web/config.js
  web/file-sinks.js
  web/i18n.js
  web/index.html
  web/legal.css
  web/licenses/APACHE-2.0.txt
  web/licenses/index.html
  web/mobile-runtime.js
  web/opfs-worker.js
  web/privacy/index.html
  web/robots.txt
  web/security/index.html
  web/terms/index.html
  web/vendor/favicon.svg
  web/vendor/uqr.LICENSE.txt
  web/vendor/uqr.js
)

if [[ -n "$(find web -type l -print -quit)" ]]; then
  echo "refusing symbolic links in the Pages static tree" >&2
  exit 2
fi
if ! diff -u \
  <(printf '%s\n' "${web_files[@]}" | LC_ALL=C sort) \
  <(find web -type f -print | LC_ALL=C sort); then
  echo "the Pages static-file allowlist does not match web/" >&2
  exit 2
fi

rm -rf -- "$out"
mkdir -p "$out"
for source in "${web_files[@]}"; do
  target="$out/${source#web/}"
  mkdir -p "$(dirname "$target")"
  cp -- "$source" "$target"
done
cp -- LICENSE THIRD_PARTY_NOTICES.md "$out/"
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
  GOWORK=off GOOS=js GOARCH=wasm go build -mod=readonly -tags=tailcat_webrtc_experiment -trimpath -ldflags="-s -w" -o "$out/main.wasm" .
else
  GOWORK=off GOOS=js GOARCH=wasm go build -mod=readonly -trimpath -ldflags="-s -w" -o "$out/main.wasm" .
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
