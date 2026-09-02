// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"errors"
	"fmt"
	"sync"
	"syscall/js"
)

const cloudflareSTUNURL = "stun:stun.cloudflare.com:3478"

type webRTCTransportConfig struct {
	enabled  bool
	stunURLs []string
}

var transportState struct {
	sync.Mutex
	configured bool
	started    bool
	webRTC     webRTCTransportConfig
}

// tailcatConfigureTransport must be called before the first listener or
// client is started. Build-specific adapters either apply the experimental
// WebRTC manager configuration or reject enabling an unavailable transport.
func tailcatConfigureTransport(this js.Value, args []js.Value) any {
	config, err := parseWebRTCTransportConfig(args)
	if err != nil {
		return rejectedPromise(err)
	}

	transportState.Lock()
	defer transportState.Unlock()
	if transportState.configured {
		return rejectedPromise(errors.New("transport is already configured"))
	}
	if transportState.started {
		return rejectedPromise(errors.New("transport configuration is frozen after Tailcat starts"))
	}
	if err := applyWebRTCTransportConfig(config); err != nil {
		return rejectedPromise(err)
	}
	transportState.configured = true
	transportState.webRTC = webRTCTransportConfig{
		enabled:  config.enabled,
		stunURLs: append([]string(nil), config.stunURLs...),
	}
	return resolvedPromise(transportConfigSnapshot(config))
}

// markTransportStarted freezes transport configuration before any Tailcat
// listener or client can begin network activity. Starting without a successful
// configuration is a terminal error for this WASM instance: a later call may
// not silently change transport policy underneath the attempted room.
func markTransportStarted() error {
	transportState.Lock()
	defer transportState.Unlock()
	transportState.started = true
	if !transportState.configured {
		return errors.New("transport must be configured before Tailcat starts")
	}
	return nil
}

func parseWebRTCTransportConfig(args []js.Value) (webRTCTransportConfig, error) {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return webRTCTransportConfig{}, errors.New("tailcatConfigureTransport requires an options object")
	}
	webRTC := args[0].Get("webRTC")
	if webRTC.Type() != js.TypeObject {
		return webRTCTransportConfig{}, errors.New("webRTC configuration object is required")
	}
	enabled := webRTC.Get("enabled")
	if enabled.Type() != js.TypeBoolean {
		return webRTCTransportConfig{}, errors.New("webRTC.enabled must be a boolean")
	}

	config := webRTCTransportConfig{enabled: enabled.Bool()}
	urls := webRTC.Get("stunURLs")
	if urls.Type() == js.TypeUndefined || urls.Type() == js.TypeNull {
		return config, nil
	}
	if !js.Global().Get("Array").Call("isArray", urls).Bool() {
		return webRTCTransportConfig{}, errors.New("webRTC.stunURLs must be an array")
	}
	if urls.Length() > 1 {
		return webRTCTransportConfig{}, errors.New("webRTC.stunURLs supports exactly one configured STUN server")
	}
	for i := 0; i < urls.Length(); i++ {
		item := urls.Index(i)
		if item.Type() != js.TypeString {
			return webRTCTransportConfig{}, errors.New("every webRTC.stunURLs entry must be a string")
		}
		u := item.String()
		if u != cloudflareSTUNURL {
			return webRTCTransportConfig{}, fmt.Errorf("webRTC.stunURLs may only contain %q", cloudflareSTUNURL)
		}
		config.stunURLs = append(config.stunURLs, u)
	}
	if config.enabled && len(config.stunURLs) != 1 {
		return webRTCTransportConfig{}, fmt.Errorf("enabled WebRTC requires exactly %q", cloudflareSTUNURL)
	}
	return config, nil
}

func transportConfigSnapshot(config webRTCTransportConfig) map[string]any {
	urls := make([]any, len(config.stunURLs))
	for i, u := range config.stunURLs {
		urls[i] = u
	}
	return map[string]any{
		"webRTC": map[string]any{
			"compiled": webRTCTransportCompiled,
			"enabled":  config.enabled,
			"stunURLs": urls,
		},
	}
}
