// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

//go:build js && wasm && tailcat_webrtc_experiment

package main

import (
	"sync"
	"syscall/js"
	"time"

	webrtcfeature "tailscale.com/feature/webrtc"
)

const (
	maxDiagnosticPathEntries = 64
	maxSafeJSInteger         = uint64(1<<53 - 1)
)

type diagnosticPathEntry struct {
	revision    uint64
	monotonicMs int64
	path        string
}

type webRTCSessionDiagnostics struct {
	mu       sync.Mutex
	started  time.Time
	revision uint64
	closed   bool
	timeline []diagnosticPathEntry
}

func newSessionDiagnostics() sessionDiagnostics {
	// The WebRTC package owns process-wide, identity-free counters. tailcat.app
	// intentionally permits one room per page, so rebasing here scopes them to
	// the persistent client returned for that room.
	webrtcfeature.ResetDiagnostics()
	return &webRTCSessionDiagnostics{started: time.Now()}
}

func (d *webRTCSessionDiagnostics) recordPath(path string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return
	}
	path = sanitizedDiagnosticPath(path)
	if n := len(d.timeline); n > 0 && d.timeline[n-1].path == path {
		return
	}
	d.revision++
	elapsed := time.Since(d.started).Milliseconds()
	if elapsed < 0 {
		elapsed = 0
	}
	if n := len(d.timeline); n > 0 && elapsed < d.timeline[n-1].monotonicMs {
		elapsed = d.timeline[n-1].monotonicMs
	}
	entry := diagnosticPathEntry{revision: d.revision, monotonicMs: elapsed, path: path}
	if len(d.timeline) == maxDiagnosticPathEntries {
		copy(d.timeline, d.timeline[1:])
		d.timeline[len(d.timeline)-1] = entry
		return
	}
	d.timeline = append(d.timeline, entry)
}

func (d *webRTCSessionDiagnostics) snapshot() js.Value {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return frozenDiagnosticSnapshot(webrtcfeature.DiagnosticSnapshot{}, nil)
	}
	snapshot := webrtcfeature.SnapshotDiagnostics()
	timeline := append([]diagnosticPathEntry(nil), d.timeline...)
	return frozenDiagnosticSnapshot(snapshot, timeline)
}

func (d *webRTCSessionDiagnostics) close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return
	}
	d.closed = true
	d.started = time.Time{}
	d.revision = 0
	d.timeline = nil
	// Rebase again after the Tailcat client has closed so a later room cannot
	// inherit this room's byte counters or high-water mark.
	webrtcfeature.ResetDiagnostics()
}

func sanitizedDiagnosticPath(path string) string {
	switch path {
	case "webrtc", "derp", "unknown":
		return path
	default:
		return "unknown"
	}
}

func frozenDiagnosticSnapshot(snapshot webrtcfeature.DiagnosticSnapshot, timeline []diagnosticPathEntry) js.Value {
	objectClass := js.Global().Get("Object")
	entries := js.Global().Get("Array").New(len(timeline))
	for i, item := range timeline {
		entry := objectClass.New()
		entry.Set("revision", safeDiagnosticNumber(item.revision))
		entry.Set("monotonicMs", float64(max(item.monotonicMs, 0)))
		entry.Set("path", sanitizedDiagnosticPath(item.path))
		entries.SetIndex(i, objectClass.Call("freeze", entry))
	}
	objectClass.Call("freeze", entries)

	result := objectClass.New()
	result.Set("webRTCTxBytes", safeDiagnosticNumber(snapshot.WebRTCTxBytes))
	result.Set("webRTCRxBytes", safeDiagnosticNumber(snapshot.WebRTCRxBytes))
	result.Set("dataChannelBufferedBytes", safeDiagnosticNumber(snapshot.DataChannelBufferedBytes))
	result.Set("dataChannelPeakBufferedBytes", safeDiagnosticNumber(snapshot.DataChannelPeakBufferedBytes))
	result.Set("pathTimeline", entries)
	return objectClass.Call("freeze", result)
}

func safeDiagnosticNumber(value uint64) float64 {
	if value > maxSafeJSInteger {
		value = maxSafeJSInteger
	}
	return float64(value)
}
