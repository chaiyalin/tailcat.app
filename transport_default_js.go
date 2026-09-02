// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

//go:build js && wasm && !tailcat_webrtc_experiment

package main

import "errors"

const webRTCTransportCompiled = false

func applyWebRTCTransportConfig(config webRTCTransportConfig) error {
	if config.enabled {
		return errors.New("WebRTC transport is not included in this build")
	}
	return nil
}
