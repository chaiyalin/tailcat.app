// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

//go:build js && wasm && !tailcat_webrtc_experiment

package main

import (
	"syscall/js"
	"testing"
)

func TestDefaultSessionDoesNotExposeDiagnostics(t *testing.T) {
	session := newJSSession(&fakeSessionClient{})
	defer session.Get("close").Invoke()
	if got := session.Get("diagnostics"); got.Type() != js.TypeUndefined {
		t.Fatalf("default client diagnostics type = %v, want undefined", got.Type())
	}
	if js.Global().Get("Reflect").Call("has", session, "diagnostics").Bool() {
		t.Fatal("default client exposes a diagnostics property")
	}
}
