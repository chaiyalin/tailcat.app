#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_root"

release_flags=(
  TAILCAT_GROUP_ROOMS_ENABLED
  TAILCAT_MOBILE_GROUP_HOSTING_ENABLED
  TAILCAT_PREVIEW_INVITES
  TAILCAT_NATIVE_FILES_ENABLED
)

build_with_clean_flags() {
  env \
    -u TAILCAT_GROUP_ROOMS_ENABLED \
    -u TAILCAT_MOBILE_GROUP_HOSTING_ENABLED \
    -u TAILCAT_PREVIEW_INVITES \
    -u TAILCAT_NATIVE_FILES_ENABLED \
    "$@" \
    PAGES_BUILD=1 \
    ./build.sh dist >/dev/null
}

assert_runtime_flags() {
  local group_value="$1"
  local mobile_value="$2"
  local preview_value="$3"
  local native_value="${4:-false}"
  grep -Fqx "globalThis.__TAILCAT_GROUP_BETA__ ??= $group_value;" dist/runtime-config.js
  grep -Fqx "globalThis.__TAILCAT_MOBILE_GROUP_HOSTING__ ??= $mobile_value;" dist/runtime-config.js
  grep -Fqx "globalThis.__TAILCAT_PREVIEW_INVITES__ ??= $preview_value;" dist/runtime-config.js
  grep -Fqx "globalThis.__TAILCAT_NATIVE_FILES__ ??= $native_value;" dist/runtime-config.js
}

restore_default_artifact() {
  build_with_clean_flags
}
trap restore_default_artifact EXIT

# Production/default artifact: every beta release switch is off.
build_with_clean_flags
assert_runtime_flags false false false
build_with_clean_flags \
  TAILCAT_GROUP_ROOMS_ENABLED=0 \
  TAILCAT_MOBILE_GROUP_HOSTING_ENABLED=0 \
  TAILCAT_PREVIEW_INVITES=0
assert_runtime_flags false false false

# Protected desktop preview and mobile-host gate artifacts.
build_with_clean_flags TAILCAT_GROUP_ROOMS_ENABLED=1 TAILCAT_PREVIEW_INVITES=1
assert_runtime_flags true false true
build_with_clean_flags TAILCAT_GROUP_ROOMS_ENABLED=1 TAILCAT_MOBILE_GROUP_HOSTING_ENABLED=1
assert_runtime_flags true true false
build_with_clean_flags TAILCAT_GROUP_ROOMS_ENABLED=1 TAILCAT_PREVIEW_INVITES=1 TAILCAT_NATIVE_FILES_ENABLED=1
assert_runtime_flags true false true true

# Every public switch is strict: values other than 0 or 1 fail the build.
for release_flag in "${release_flags[@]}"; do
  if build_with_clean_flags "$release_flag=invalid" 2>/dev/null; then
    echo "$release_flag accepted an invalid release-switch value" >&2
    exit 1
  fi
done

# Mobile hosting can never be published without Group Beta itself.
if build_with_clean_flags TAILCAT_MOBILE_GROUP_HOSTING_ENABLED=1 2>/dev/null; then
  echo "mobile group hosting built without group rooms" >&2
  exit 1
fi

# Leave the shared artifact in its production-default state for later checks.
restore_default_artifact
trap - EXIT
