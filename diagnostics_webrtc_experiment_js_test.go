// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

//go:build js && wasm && tailcat_webrtc_experiment

package main

import (
	"errors"
	"strings"
	"syscall/js"
	"testing"

	"tailscale.com/ipn/ipnstate"
)

func TestExperimentalDiagnosticSnapshotSchemaRingAndRedaction(t *testing.T) {
	diagnostics := newSessionDiagnostics().(*webRTCSessionDiagnostics)
	defer diagnostics.close()
	paths := []string{"webrtc", "derp", "direct-udp"}
	for i := 0; i < 70; i++ {
		diagnostics.recordPath(paths[i%len(paths)])
	}
	snapshot := diagnostics.snapshot()
	assertFrozenDiagnosticSchema(t, snapshot)
	timeline := snapshot.Get("pathTimeline")
	if timeline.Length() != maxDiagnosticPathEntries {
		t.Fatalf("timeline length = %d, want %d", timeline.Length(), maxDiagnosticPathEntries)
	}
	if got := timeline.Index(0).Get("revision").Int(); got != 7 {
		t.Fatalf("oldest retained revision = %d, want 7", got)
	}
	lastTime := -1
	for i := 0; i < timeline.Length(); i++ {
		entry := timeline.Index(i)
		if !js.Global().Get("Object").Call("isFrozen", entry).Bool() {
			t.Fatalf("timeline entry %d is mutable", i)
		}
		path := entry.Get("path").String()
		if path != "webrtc" && path != "derp" && path != "unknown" {
			t.Fatalf("timeline path %q is not sanitized", path)
		}
		if elapsed := entry.Get("monotonicMs").Int(); elapsed < lastTime {
			t.Fatalf("timeline time regressed from %d to %d", lastTime, elapsed)
		} else {
			lastTime = elapsed
		}
	}
	encoded := js.Global().Get("JSON").Call("stringify", snapshot).String()
	for _, forbidden := range []string{"endpoint", "address", "candidate", "privateKey", "nodeKey", "tailcatAddress", "tc-invalid"} {
		if strings.Contains(encoded, forbidden) {
			t.Fatalf("diagnostic snapshot contains forbidden field/value %q: %s", forbidden, encoded)
		}
	}
	if got := safeDiagnosticNumber(maxSafeJSInteger + 1); got != float64(maxSafeJSInteger) {
		t.Fatalf("unsafe large diagnostic number = %v", got)
	}
	diagnostics.close()
	closedSnapshot := diagnostics.snapshot()
	assertFrozenDiagnosticSchema(t, closedSnapshot)
	if closedSnapshot.Get("pathTimeline").Length() != 0 ||
		closedSnapshot.Get("webRTCTxBytes").Int() != 0 ||
		closedSnapshot.Get("webRTCRxBytes").Int() != 0 ||
		closedSnapshot.Get("dataChannelBufferedBytes").Int() != 0 ||
		closedSnapshot.Get("dataChannelPeakBufferedBytes").Int() != 0 {
		t.Fatalf("closed diagnostic snapshot was not cleared: %s", js.Global().Get("JSON").Call("stringify", closedSnapshot).String())
	}
}

func TestExperimentalClientDiagnosticsTracksStatusAndReleasesOnClose(t *testing.T) {
	client := &fakeSessionClient{pingResult: &ipnstate.PingResult{Endpoint: "127.3.3.41:9"}}
	session := newJSSession(client)
	diagnostics := session.Get("diagnostics")
	if diagnostics.Type() != js.TypeFunction {
		t.Fatalf("experimental diagnostics type = %v, want function", diagnostics.Type())
	}
	statusOptions := js.Global().Get("Object").New()
	statusOptions.Set("timeoutMs", 100)
	if _, err := awaitPromise(session.Get("status").Invoke(statusOptions)); err != nil {
		t.Fatalf("successful status: %v", err)
	}
	if _, err := awaitPromise(session.Get("status").Invoke(statusOptions)); err != nil {
		t.Fatalf("repeated successful status: %v", err)
	}
	unchanged := diagnostics.Invoke().Get("pathTimeline")
	if unchanged.Length() != 1 || unchanged.Index(0).Get("revision").Int() != 1 || unchanged.Index(0).Get("path").String() != "webrtc" {
		t.Fatalf("repeated status timeline = %s, want one webrtc revision", js.Global().Get("JSON").Call("stringify", unchanged).String())
	}

	client.mu.Lock()
	client.pingErr = errors.New("diagnostic timeout")
	client.mu.Unlock()
	if _, err := awaitPromise(session.Get("status").Invoke(statusOptions)); err == nil {
		t.Fatal("failed status unexpectedly succeeded")
	}
	if _, err := awaitPromise(session.Get("status").Invoke(statusOptions)); err == nil {
		t.Fatal("repeated failed status unexpectedly succeeded")
	}
	snapshot := diagnostics.Invoke()
	assertFrozenDiagnosticSchema(t, snapshot)
	timeline := snapshot.Get("pathTimeline")
	if timeline.Length() != 2 ||
		timeline.Index(0).Get("revision").Int() != 1 || timeline.Index(0).Get("path").String() != "webrtc" ||
		timeline.Index(1).Get("revision").Int() != 2 || timeline.Index(1).Get("path").String() != "unknown" {
		t.Fatalf("status timeline = %s, want [webrtc, unknown]", js.Global().Get("JSON").Call("stringify", timeline).String())
	}

	session.Get("close").Invoke()
	if js.Global().Get("Reflect").Call("has", session, "diagnostics").Bool() {
		t.Fatal("closed experimental client retained diagnostics callback")
	}
}

func assertFrozenDiagnosticSchema(t *testing.T, snapshot js.Value) {
	t.Helper()
	objectClass := js.Global().Get("Object")
	if !objectClass.Call("isFrozen", snapshot).Bool() {
		t.Fatal("diagnostic snapshot is mutable")
	}
	want := []string{"webRTCTxBytes", "webRTCRxBytes", "dataChannelBufferedBytes", "dataChannelPeakBufferedBytes", "pathTimeline"}
	keys := objectClass.Call("keys", snapshot)
	if keys.Length() != len(want) {
		t.Fatalf("diagnostic keys = %s", js.Global().Get("JSON").Call("stringify", keys).String())
	}
	for i, key := range want {
		if got := keys.Index(i).String(); got != key {
			t.Fatalf("diagnostic key %d = %q, want %q", i, got, key)
		}
	}
	for _, key := range want[:4] {
		if snapshot.Get(key).Type() != js.TypeNumber {
			t.Fatalf("diagnostic %s is not numeric", key)
		}
	}
	timeline := snapshot.Get("pathTimeline")
	if !js.Global().Get("Array").Call("isArray", timeline).Bool() || !objectClass.Call("isFrozen", timeline).Bool() {
		t.Fatal("diagnostic pathTimeline is not a frozen array")
	}
}
