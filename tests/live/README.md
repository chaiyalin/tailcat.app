# Real production compatibility acceptance

`production-interop.mjs` is an opt-in acceptance script for an HTTPS candidate
using Tailcat v0.7.0 and the current `https://tailcat.app/` production page using
Tailcat v0.4.0. It uses installed Chrome and actual Tokyo DERP connections; it
does not start the local Playwright server or replace the Tailcat bridge.

Run from the repository after installing the pinned npm dependencies:

```sh
LIVE_PRODUCTION_INTEROP=1 TAILCAT_CANDIDATE_URL=https://YOUR-CANDIDATE.pages.dev/ node tests/live/production-interop.mjs
```

The default checks are private candidate host, private production host, group
candidate host and group production host. Each room sends text and a 32 KiB
synthetic file in both directions. Group checks include real host admission,
recipient selection and the existing ticket protocol. An unavailable group
entry is a failed gate rather than a silently skipped group result. Use
`LIVE_INTEROP_GROUP=0` only for a deliberately private-only run; the final report
then states that group checks were not run. `TAILCAT_INTEROP_BYTES=1048576` raises
each file to 1 MiB; larger values are rejected. Optional
`TAILCAT_BROWSER_CHANNEL=msedge` selects an installed Edge channel.

The save picker is hidden before startup so both pages use their **real OPFS**
backend. There is no storage fixture. Files are verified against an independently
calculated SHA-256 by reading the completed OPFS artifact, then deleted through
the product UI. Private sender/receiver completion hashes and group per-recipient
completion receipts are checked. Each case uses a disposable browser context.
Two different origins prevent the application's same-origin OPFS ownership lock
from making the receiver unavailable.

The local `tailcat.forceDerp` test option is set before startup. Zero constructed
PeerConnections and observed official `*.ipn.dev` WebSocket frame counters are
required, keeping this gate focused on stable dependency interoperability.
Those counters are encrypted transport totals, not a precise per-file bandwidth
attribution measurement. This script does not evaluate native WebRTC success.

If a build manifest exposes dependency metadata, the candidate must report
`v0.7.0` and production `v0.4.0`. Missing metadata is explicitly reported as
`provenanceVerified: false`; a transport pass alone does not prove which
dependency was deployed. Pair the report with the release build manifest and
source SHA checks.

No invitation, key, SDP, ICE candidate, browser console, trace, screenshot or
video is retained. Debug environment flags are disabled before Playwright is
loaded. Failures print only a fixed stage label and a failing case, avoiding
Playwright error call logs that might expose filled invitation values. Successful
JSON output contains only fixed case names, counts, byte totals and public build
metadata. A failed case exits with code 1 after the remaining cases run.

This is small-file release smoke coverage. It does not replace real Android/iOS,
cross-network interruption, 100 MiB/1 GiB, memory-pressure or endurance gates.
