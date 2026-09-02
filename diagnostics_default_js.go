// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

//go:build js && wasm && !tailcat_webrtc_experiment

package main

func newSessionDiagnostics() sessionDiagnostics { return nil }
