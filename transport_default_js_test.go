// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

//go:build js && wasm && !tailcat_webrtc_experiment

package main

import (
	"syscall/js"
	"testing"
)

func TestDefaultBuildTransportConfiguration(t *testing.T) {
	resetTransportState(t)
	disabled := transportOptions(false, "stun:stun.cloudflare.com:3478")
	result, err := awaitPromise(js.ValueOf(tailcatConfigureTransport(js.Undefined(), []js.Value{disabled})))
	if err != nil {
		t.Fatalf("disabled configuration: %v", err)
	}
	webRTC := result.Get("webRTC")
	if webRTC.Get("compiled").Bool() || webRTC.Get("enabled").Bool() {
		t.Fatal("default build reported WebRTC compiled or enabled")
	}
	if _, err := awaitPromise(js.ValueOf(tailcatConfigureTransport(js.Undefined(), []js.Value{disabled}))); err != nil {
		t.Fatalf("identical transport configuration was not idempotent: %v", err)
	}
	markTransportStarted()
	if _, err := awaitPromise(js.ValueOf(tailcatConfigureTransport(js.Undefined(), []js.Value{disabled}))); err != nil {
		t.Fatalf("identical configuration after start was not idempotent: %v", err)
	}
	different := transportOptions(false)
	if _, err := awaitPromise(js.ValueOf(tailcatConfigureTransport(js.Undefined(), []js.Value{different}))); err == nil {
		t.Fatal("different second transport configuration succeeded")
	}

	resetTransportState(t)
	enabled := transportOptions(true, "stun:stun.cloudflare.com:3478")
	if _, err := awaitPromise(js.ValueOf(tailcatConfigureTransport(js.Undefined(), []js.Value{enabled}))); err == nil {
		t.Fatal("default build accepted enabled WebRTC")
	}
}

func TestTransportConfigurationFreezesOnStart(t *testing.T) {
	resetTransportState(t)
	markTransportStarted()
	opts := transportOptions(false)
	if _, err := awaitPromise(js.ValueOf(tailcatConfigureTransport(js.Undefined(), []js.Value{opts}))); err == nil {
		t.Fatal("transport configuration after start succeeded")
	}
}

func TestTransportRejectsInvalidSTUNURL(t *testing.T) {
	for _, urls := range [][]string{
		{"https://example.invalid/stun"},
		{"stuns:stun.cloudflare.com:3478"},
		{"stun:stun.example.invalid:3478"},
		{cloudflareSTUNURL, cloudflareSTUNURL},
	} {
		opts := transportOptions(false, urls...)
		if _, err := parseWebRTCTransportConfig([]js.Value{opts}); err == nil {
			t.Errorf("transport accepted STUN URLs %q", urls)
		}
	}
	if _, err := parseWebRTCTransportConfig([]js.Value{transportOptions(true)}); err == nil {
		t.Fatal("enabled transport accepted no STUN URL")
	}
}

func transportOptions(enabled bool, stunURLs ...string) js.Value {
	root := js.Global().Get("Object").New()
	webRTC := js.Global().Get("Object").New()
	webRTC.Set("enabled", enabled)
	urls := js.Global().Get("Array").New(len(stunURLs))
	for i, u := range stunURLs {
		urls.SetIndex(i, u)
	}
	webRTC.Set("stunURLs", urls)
	root.Set("webRTC", webRTC)
	return root
}

func resetTransportState(t *testing.T) {
	t.Helper()
	transportState.Lock()
	transportState.configured = false
	transportState.started = false
	transportState.webRTC = webRTCTransportConfig{}
	transportState.Unlock()
	t.Cleanup(func() {
		transportState.Lock()
		transportState.configured = false
		transportState.started = false
		transportState.webRTC = webRTCTransportConfig{}
		transportState.Unlock()
	})
}
