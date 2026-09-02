// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

//go:build js && wasm && tailcat_webrtc_experiment

package main

import webrtcfeature "tailscale.com/feature/webrtc"

const webRTCTransportCompiled = true

func applyWebRTCTransportConfig(config webRTCTransportConfig) error {
	return webrtcfeature.Configure(webrtcfeature.Config{
		Enabled:  config.enabled,
		STUNURLs: append([]string(nil), config.stunURLs...),
	})
}
