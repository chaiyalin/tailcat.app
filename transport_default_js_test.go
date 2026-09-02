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
	if _, err := awaitPromise(js.ValueOf(tailcatConfigureTransport(js.Undefined(), []js.Value{disabled}))); err == nil {
		t.Fatal("identical second transport configuration succeeded")
	}
	if err := markTransportStarted(); err != nil {
		t.Fatalf("start after successful configuration: %v", err)
	}
	if _, err := awaitPromise(js.ValueOf(tailcatConfigureTransport(js.Undefined(), []js.Value{disabled}))); err == nil {
		t.Fatal("identical transport configuration after start succeeded")
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
	if err := markTransportStarted(); err == nil {
		t.Fatal("transport started without configuration")
	}
	opts := transportOptions(false)
	if _, err := awaitPromise(js.ValueOf(tailcatConfigureTransport(js.Undefined(), []js.Value{opts}))); err == nil {
		t.Fatal("transport configuration after start succeeded")
	}
}

func TestInvalidConfigurationCannotPermitLateStart(t *testing.T) {
	resetTransportState(t)
	invalid := transportOptions(false, "stun:stun.example.invalid:3478")
	if _, err := awaitPromise(js.ValueOf(tailcatConfigureTransport(js.Undefined(), []js.Value{invalid}))); err == nil {
		t.Fatal("invalid transport configuration succeeded")
	}
	clientOptions := js.Global().Get("Object").New()
	clientOptions.Set("addr", "tc-invalid-for-config-test")
	if _, err := awaitPromise(js.ValueOf(tailcatConnect(js.Undefined(), []js.Value{clientOptions}))); err == nil {
		t.Fatal("Tailcat client started after invalid configuration")
	}
	valid := transportOptions(false)
	if _, err := awaitPromise(js.ValueOf(tailcatConfigureTransport(js.Undefined(), []js.Value{valid}))); err == nil {
		t.Fatal("late valid transport configuration succeeded")
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
