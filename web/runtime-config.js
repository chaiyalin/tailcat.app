// Build-time release switches. Production builds leave all beta switches off.
// A protected preview can opt in without changing the checked-in source.
globalThis.__TAILCAT_GROUP_BETA__ ??= false;
globalThis.__TAILCAT_MOBILE_GROUP_HOSTING__ ??= false;
globalThis.__TAILCAT_PREVIEW_INVITES__ ??= false;
globalThis.__TAILCAT_NATIVE_FILES__ ??= false;
