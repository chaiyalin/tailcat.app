# Third-party notices

This file records the open-source components used by the browser build of
tailcat.app. It is informational and does not replace the license terms that
apply to each component.

The inventory was generated on 2026-09-01 from the pinned module graph with
Go 1.27.0:

```sh
GOOS=js GOARCH=wasm go list -deps \
  -f '{{if and .Module (ne .Module.Path "tailcatchat")}}{{.Module.Path}} {{.Module.Version}}{{end}}' . \
  | sort -u
```

Only modules containing packages in that `js/wasm` dependency graph are
listed. Versions that appear in `go.mod` but contribute no package to this
target are intentionally omitted. The Go runtime and standard library, which
are linked into the WebAssembly binary, and the vendored browser QR library
are listed separately.

## Upstream application and transport

### Tailcatchat / tailcat.app

tailcat.app is derived from
[`tailscale/tailcatchat`](https://github.com/tailscale/tailcatchat). The
repository-root [`LICENSE`](LICENSE) applies to the derived application and
contains this notice:

> Copyright (c) 2026, Tailchat contributors
>
> All rights reserved.

### Tailcat v0.4.0

Source: [`github.com/tailscale/tailcat` at `v0.4.0`](https://github.com/tailscale/tailcat/blob/v0.4.0/LICENSE)

License: BSD 3-Clause

Exact license-file SHA-256: `a7ca6186a7963a0a60740f6047760eecd7a0234e8c38bd7e1e0bbcb324bda45b`

The complete notice required for binary redistribution is reproduced here:

```text
BSD 3-Clause License

Copyright (c) 2020 Tailscale Inc & contributors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

The use of Tailcat code does not imply that Tailscale Inc. is affiliated with,
supports, certifies, or endorses tailcat.app.

## Go modules in the `js/wasm` build

Each entry below names the exact selected version, its license family, the
notice found in its root license or authors file (where present), and an
immutable upstream copy of the complete license. The SHA-256 values were
calculated from the corresponding `LICENSE` file in the Go module cache.
None of the Apache-2.0 modules listed below shipped a root `NOTICE` file in the
selected module version.

### BSD-family modules

| Module and version | Preserved attribution | Complete license | SHA-256 |
|---|---|---|---|
| `filippo.io/edwards25519 v1.2.0` | Copyright (c) 2009 The Go Authors. All rights reserved. | [LICENSE](https://github.com/FiloSottile/edwards25519/blob/v1.2.0/LICENSE) | `2d36597f7117c38b006835ae7f537487207d8ec407aa9d9980794b2030cbc067` |
| `github.com/creachadair/msync v0.8.1` | Copyright (C) 2022, Michael J. Fromberger; All Rights Reserved. | [LICENSE](https://github.com/creachadair/msync/blob/v0.8.1/LICENSE) | `1d45f7789b678c742a045d7a6923c2762f667dc2523b9b4c01fe240d24c83083` |
| `github.com/go-json-experiment/json v0.0.0-20260623181947-01eb4420fa68` | Copyright (c) 2020 The Go Authors. All rights reserved. | [LICENSE](https://github.com/go-json-experiment/json/blob/01eb4420fa68/LICENSE) | `14a34c4db2d21bf9cf80d028b802cd22fed9bf597a6c2db7ce30ee6ffd04967a` |
| `github.com/hdevalence/ed25519consensus v0.2.0` | Copyright (c) 2009 The Go Authors. All rights reserved; Copyright (c) 2020 Henry de Valence. All rights reserved. | [LICENSE](https://github.com/hdevalence/ed25519consensus/blob/v0.2.0/LICENSE) | `789be8b214a1871d8d1a5ab157f8f4ad74cd889087762bd5cced07ed589b6bc7` |
| `github.com/klauspost/compress v1.19.1` | Copyright (c) 2012 The Go Authors. All rights reserved; Copyright (c) 2019 Klaus Post. All rights reserved. | [LICENSE](https://github.com/klauspost/compress/blob/v1.19.1/LICENSE) | `0d9e582ee4bff57bf1189c9e514e6da7ce277f9cd3bc2d488b22fbb39a6d87cf` |
| `github.com/tailscale/hujson v0.0.0-20260302212456-ecc657c15afd` | Copyright (c) 2019 Tailscale Inc. All rights reserved. | [LICENSE](https://github.com/tailscale/hujson/blob/ecc657c15afd/LICENSE) | `a125b6c2721809b6c2a8761771932611833008ed8697d752b3e35d36e4bbd83e` |
| `github.com/tailscale/peercred v0.0.0-20250107143737-35a0c7bd7edc` | Copyright (c) 2021, Tailscale Inc. All rights reserved; AUTHORS: Tailscale Inc. | [LICENSE](https://github.com/tailscale/peercred/blob/35a0c7bd7edc/LICENSE) | `8e0db394107481655ef6a46baace86aaead5fc9b4c5ce83b9fa16037e891d03c` |
| `github.com/tailscale/tailcat v0.4.0` | Copyright (c) 2020 Tailscale Inc & contributors. | [LICENSE](https://github.com/tailscale/tailcat/blob/v0.4.0/LICENSE) | `a7ca6186a7963a0a60740f6047760eecd7a0234e8c38bd7e1e0bbcb324bda45b` |
| `github.com/tailscale/web-client-prebuilt v0.0.0-20250124233751-d4cd19a26976` | Copyright (c) 2020 Tailscale Inc & AUTHORS. | [LICENSE](https://github.com/tailscale/web-client-prebuilt/blob/d4cd19a26976/LICENSE) | `d1ee1c7947d4b2c1963ea214d5324f1d4c89f2f1d0f0224889b4dfb868dad725` |
| `go4.org/netipx v0.0.0-20260823151212-3075585bcbeb` | Copyright (c) 2020 The Inet.af AUTHORS. All rights reserved. AUTHORS includes Alex Willmer, Matt Layher, Tailscale Inc., and Tobias Klauser. | [LICENSE](https://github.com/go4org/netipx/blob/3075585bcbeb/LICENSE) | `1bfc4f32f4ec8ca8fce54bd2d97784f003786753a69a78ca74ffae1574037fb9` |
| `golang.org/x/crypto v0.55.0` | Copyright 2009 The Go Authors. | [LICENSE](https://github.com/golang/crypto/blob/v0.55.0/LICENSE) | `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad` |
| `golang.org/x/exp v0.0.0-20260410095643-746e56fc9e2f` | Copyright 2009 The Go Authors. | [LICENSE](https://github.com/golang/exp/blob/746e56fc9e2f/LICENSE) | `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad` |
| `golang.org/x/net v0.58.0` | Copyright 2009 The Go Authors. | [LICENSE](https://github.com/golang/net/blob/v0.58.0/LICENSE) | `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad` |
| `golang.org/x/sync v0.22.0` | Copyright 2009 The Go Authors. | [LICENSE](https://github.com/golang/sync/blob/v0.22.0/LICENSE) | `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad` |
| `golang.org/x/sys v0.47.0` | Copyright 2009 The Go Authors. | [LICENSE](https://github.com/golang/sys/blob/v0.47.0/LICENSE) | `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad` |
| `golang.org/x/term v0.45.0` | Copyright 2009 The Go Authors. | [LICENSE](https://github.com/golang/term/blob/v0.45.0/LICENSE) | `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad` |
| `golang.org/x/text v0.41.0` | Copyright 2009 The Go Authors. | [LICENSE](https://github.com/golang/text/blob/v0.41.0/LICENSE) | `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad` |
| `golang.org/x/time v0.15.0` | Copyright 2009 The Go Authors. | [LICENSE](https://github.com/golang/time/blob/v0.15.0/LICENSE) | `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad` |
| `tailscale.com v1.103.0-pre.0.20260830144538-72780705eda8` | Copyright (c) 2020 Tailscale Inc & contributors. | [LICENSE](https://github.com/tailscale/tailscale/blob/72780705eda8/LICENSE) | `6c10979d9859262305f3a9971502aca4a20d9531f71ad2fc5cf66c258d21fd1e` |

The `golang.org/x/*` modules also carry the Go project's
[`PATENTS`](https://github.com/golang/go/blob/go1.27.0/PATENTS) additional IP
rights grant. The selected `tailscale.com` module carries Tailscale's
[`PATENTS`](https://github.com/tailscale/tailscale/blob/72780705eda8/PATENTS)
additional IP rights grant.

### MIT-family modules

| Module and version | Preserved attribution | Complete license | SHA-256 |
|---|---|---|---|
| `github.com/fxamacker/cbor/v2 v2.9.0` | Copyright (c) 2019-present Faye Amacker | [LICENSE](https://github.com/fxamacker/cbor/blob/v2.9.0/LICENSE) | `78cad457d5ea7318230f3d969d4cdf29cef45524a1fc8ca3a97646da1ad7a841` |
| `github.com/gaissmai/bart v0.26.1` | Copyright (c) 2024 Karl Gaissmaier | [LICENSE](https://github.com/gaissmai/bart/blob/v0.26.1/LICENSE) | `12d27746d111da33969df0ecaa9b799e22c42db7d0b6a5164f383ec934233a41` |
| `github.com/tailscale/wireguard-go v0.0.0-20260821191448-23d18d66172c` | Imported source headers state Copyright (C) 2017-2023 WireGuard LLC. All Rights Reserved. | [LICENSE](https://github.com/tailscale/wireguard-go/blob/23d18d66172c/LICENSE) | `91276db973f25602d1aa43491f59cbc84cb88e6f151e1d0cc82a755563ce0195` |
| `github.com/x448/float16 v0.8.4` | Copyright (c) 2019 Montgomery Edwards⁴⁴⁸ and Faye Amacker | [LICENSE](https://github.com/x448/float16/blob/v0.8.4/LICENSE) | `a555f1194fdac34da70fb416968f7e2217b02352c26c1eac2fa45fcb4290ae8d` |

### ISC module

| Module and version | Preserved attribution | Complete license | SHA-256 |
|---|---|---|---|
| `github.com/coder/websocket v1.8.14` | Copyright (c) 2025 Coder | [LICENSE.txt](https://github.com/coder/websocket/blob/v1.8.14/LICENSE.txt) | `cc0975a5f6305145bdd7b41ce9479632fdac3870e6ac4281f28017f18c767c4e` |

### Apache License 2.0 modules

The selected versions below contain the complete Apache License 2.0 text in
their root `LICENSE` file and no root `NOTICE` file.

| Module and version | Complete license | SHA-256 |
|---|---|---|
| `github.com/akutz/memconn v0.1.0` | [LICENSE](https://github.com/akutz/memconn/blob/v0.1.0/LICENSE) | `db1ed8cccea0d0fb5d92b7c59d9aa78a5bbcd047972519c6a21a4416937f2ebf` |
| `github.com/golang/groupcache v0.0.0-20241129210726-2c02b8208cf8` | [LICENSE](https://github.com/golang/groupcache/blob/2c02b8208cf8/LICENSE) | `73ba74dfaa520b49a401b5d21459a8523a146f3b7518a833eea5efa85130bf68` |
| `github.com/google/btree v1.1.3` | [LICENSE](https://github.com/google/btree/blob/v1.1.3/LICENSE) | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| `github.com/pires/go-proxyproto v0.8.1` | [LICENSE](https://github.com/pires/go-proxyproto/blob/v0.8.1/LICENSE) | `666f1951be1d543e744818d232bb311a4a310fd1d344288642c796fca39af3c7` |
| `go4.org/mem v0.0.0-20240501181205-ae6ca9944745` | [LICENSE](https://github.com/go4org/mem/blob/ae6ca9944745/LICENSE) | `c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08` |
| `gvisor.dev/gvisor v0.0.0-20260224225140-573d5e7127a8` | AUTHORS identifies Google LLC. [LICENSE](https://github.com/google/gvisor/blob/573d5e7127a8/LICENSE) | `0fbab5c58efbdf6d31e8085214f2dd821659c03d73cff3ed2b08e98826ea1cd9` |

## Package-level notices within `github.com/klauspost/compress v1.19.1`

Two imported subpackages carry additional license files. These notices are in
addition to the module-root BSD license above.

### `internal/snapref`

Source: [`internal/snapref/LICENSE`](https://github.com/klauspost/compress/blob/v1.19.1/internal/snapref/LICENSE)

License: BSD 3-Clause

Notice: Copyright (c) 2011 The Snappy-Go Authors. All rights reserved.

SHA-256: `f69f157b0be75da373605dbc8bbf142e8924ee82d8f44f11bcaf351335bf98cf`

### `zstd/internal/xxhash`

Source: [`zstd/internal/xxhash/LICENSE.txt`](https://github.com/klauspost/compress/blob/v1.19.1/zstd/internal/xxhash/LICENSE.txt)

License: MIT

Notice: Copyright (c) 2016 Caleb Spare

SHA-256: `f566a9f97bacdaf00d9f21dd991e81dc11201c4e016c86b470799429a1c9a79c`

Several imported Zstandard source files also state that they are based on work
by Yann Collet released under a BSD license; those file-header attributions are
preserved in the source module.

## Go 1.27.0 runtime and standard library

The Go runtime and standard library are linked into `main.wasm`.

Source: [`golang/go` at `go1.27.0`](https://github.com/golang/go/blob/go1.27.0/LICENSE)

License: BSD 3-Clause

Notice: Copyright 2009 The Go Authors.

License SHA-256: `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad`

Patent grant: [`PATENTS`](https://github.com/golang/go/blob/go1.27.0/PATENTS), SHA-256 `96f408bfae65bf137fc2525d3ecb030271c50c1e90799f87abf8846d8dd505cc`

## Vendored browser library

### Iconoir v7.12.1

The interface uses a locally vendored subset of the
[`Iconoir`](https://github.com/iconoir-icons/iconoir/tree/v7.12.1) SVG icon library.

License: MIT

Vendored notice: [`web/vendor/iconoir/LICENSE.txt`](web/vendor/iconoir/LICENSE.txt)

Notice: Copyright (c) 2021 Luca Burgio

### uqr v0.1.3

Invitation QR codes use the locally vendored
[`uqr`](https://github.com/unjs/uqr/tree/v0.1.3) browser library.

License: MIT

Vendored notice: [`web/vendor/uqr.LICENSE.txt`](web/vendor/uqr.LICENSE.txt)

Notice: Copyright (c) Project Nayuki; Copyright (c) 2023 Anthony Fu
<https://github.com/antfu>

The vendored JavaScript header also states: Copyright (c) Sébastien Chopin,
Pooya Parsa, Anthony Fu and contributors.

License SHA-256: `b39d50e24727f341a0ebdb2ab040c57efaf4076a8ad5b1d0c8c45beb975b4571`

## Common license texts

The exact per-component license files are linked above. Common license texts
are reproduced below or bundled with the web distribution for offline
inspection.

### MIT License

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC License (`github.com/coder/websocket`)

```text
Copyright (c) 2025 Coder

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### Apache License 2.0

The complete unmodified Apache License 2.0 text distributed by every module in
the Apache table above is bundled at
[`web/licenses/APACHE-2.0.txt`](web/licenses/APACHE-2.0.txt), and is also
available from each immutable module license link in that table.

## Audit notes

- Every external module returned by the command at the start of this file is
  represented exactly once in the inventory (Tailcat is intentionally also
  highlighted in the upstream section).
- No additional root `NOTICE` file existed in any selected module version.
- Package-level license files were checked for imported package directories;
  the two applicable `github.com/klauspost/compress` notices are recorded.
- The inventory must be regenerated whenever `go.mod`, `go.sum`, the Go
  toolchain version, build tags, or the WebAssembly entry point changes.
