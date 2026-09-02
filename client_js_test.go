// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"syscall/js"
	"testing"
	"time"

	"tailscale.com/ipn/ipnstate"
)

func TestSessionStreamLimitIncludesPendingDials(t *testing.T) {
	client := &fakeSessionClient{}
	s := &jsSession{client: client, connections: make(map[uint64]net.Conn)}

	for i := 0; i < maxSessionStreams; i++ {
		if _, err := s.reserveDial(); err != nil {
			t.Fatalf("reserveDial %d: %v", i, err)
		}
	}
	if _, err := s.reserveDial(); err == nil || !strings.Contains(err.Error(), "24") {
		t.Fatalf("25th reserveDial error = %v, want stream-limit error", err)
	}

	for i := 0; i < maxSessionStreams; i++ {
		s.finishFailedDial()
	}
	if _, err := s.reserveDial(); err != nil {
		t.Fatalf("reserveDial after releasing reservations: %v", err)
	}
	s.finishFailedDial()
}

func TestJSSessionDialStatusAndClose(t *testing.T) {
	client := &fakeSessionClient{
		pingResult: &ipnstate.PingResult{
			Endpoint:       "127.3.3.41:9",
			LatencySeconds: 0.0125,
		},
	}
	session := newJSSession(client)

	dialOptions := js.Global().Get("Object").New()
	dialOptions.Set("port", 101)
	conn, err := awaitPromise(session.Get("dial").Invoke(dialOptions))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if got := conn.Get("port").Int(); got != 101 {
		t.Fatalf("connection port = %d, want 101", got)
	}

	statusOptions := js.Global().Get("Object").New()
	statusOptions.Set("timeoutMs", 2500)
	status, err := awaitPromise(session.Get("status").Invoke(statusOptions))
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if got := status.Get("state").String(); got != "connected" {
		t.Fatalf("state = %q, want connected", got)
	}
	if got := status.Get("path").String(); got != "webrtc" {
		t.Fatalf("path = %q, want webrtc", got)
	}
	if got := status.Get("latencyMs").Float(); got != 12.5 {
		t.Fatalf("latencyMs = %v, want 12.5", got)
	}

	conn.Get("close").Invoke()
	session.Get("close").Invoke()
	session.Get("close").Invoke()
	closedStatus, err := awaitPromise(session.Get("status").Invoke(statusOptions))
	if err != nil || closedStatus.Get("state").String() != "closed" || closedStatus.Get("path").String() != "unknown" {
		t.Fatalf("status after close = %v, %v; want closed/unknown", closedStatus, err)
	}
	if _, err := awaitPromise(session.Get("dial").Invoke(dialOptions)); err == nil {
		t.Fatal("dial after close succeeded")
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.closeCalls != 1 {
		t.Fatalf("client Close calls = %d, want 1", client.closeCalls)
	}
	if len(client.dialedPorts) != 1 || client.dialedPorts[0] != 101 {
		t.Fatalf("dialed ports = %v, want [101]", client.dialedPorts)
	}
}

func TestSessionCloseUnblocksPendingDial(t *testing.T) {
	client := newBlockingSessionClient()
	session := newJSSession(client)
	dialOptions := js.Global().Get("Object").New()
	dialOptions.Set("port", 102)
	pending := session.Get("dial").Invoke(dialOptions)

	select {
	case <-client.started:
	case <-time.After(2 * time.Second):
		t.Fatal("dial did not start")
	}
	session.Get("close").Invoke()
	if _, err := awaitPromise(pending); err == nil {
		t.Fatal("pending dial resolved after close; want rejection")
	}

	client.mu.Lock()
	defer client.mu.Unlock()
	if client.closeCalls != 1 {
		t.Fatalf("client Close calls = %d, want 1", client.closeCalls)
	}
}

func TestSessionStatusPathClassification(t *testing.T) {
	tests := []struct {
		name   string
		result *ipnstate.PingResult
		want   string
	}{
		{
			name: "WebRTC magic endpoint wins over relay metadata",
			result: &ipnstate.PingResult{
				Endpoint:     "127.3.3.41:1234",
				DERPRegionID: 304,
			},
			want: "webrtc",
		},
		{
			name: "DERP",
			result: &ipnstate.PingResult{
				DERPRegionID:   303,
				DERPRegionCode: "fra",
			},
			want: "derp",
		},
		{
			name:   "Other direct endpoint is not exposed",
			result: &ipnstate.PingResult{Endpoint: "192.0.2.1:5678"},
			want:   "unknown",
		},
		{name: "No path metadata", result: &ipnstate.PingResult{}, want: "unknown"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sessionStatus(tt.result)
			if got["path"] != tt.want {
				t.Fatalf("path = %q, want %q", got["path"], tt.want)
			}
			if _, ok := got["endpoint"]; ok {
				t.Fatal("status exposes endpoint")
			}
		})
	}
}

func TestSessionArgumentValidation(t *testing.T) {
	for _, value := range []any{0, -1, 65536, 1.5, "101"} {
		opts := js.Global().Get("Object").New()
		opts.Set("port", value)
		if _, err := requiredSessionPort([]js.Value{opts}); err == nil {
			t.Errorf("port %v accepted", value)
		}
	}
	valid := js.Global().Get("Object").New()
	valid.Set("port", 65535)
	if got, err := requiredSessionPort([]js.Value{valid}); err != nil || got != 65535 {
		t.Fatalf("port 65535 = %d, %v", got, err)
	}

	empty := js.Global().Get("Object").New()
	if got, err := requiredStatusTimeout([]js.Value{empty}); err != nil || got != defaultStatusWait {
		t.Fatalf("default status timeout = %v, %v", got, err)
	}
	for _, value := range []any{0, -1, 30001, 1.5, "5000"} {
		opts := js.Global().Get("Object").New()
		opts.Set("timeoutMs", value)
		if _, err := requiredStatusTimeout([]js.Value{opts}); err == nil {
			t.Errorf("timeoutMs %v accepted", value)
		}
	}
}

type fakeSessionClient struct {
	mu          sync.Mutex
	dialedPorts []uint16
	pingResult  *ipnstate.PingResult
	pingErr     error
	closeCalls  int
	closed      bool
}

func (c *fakeSessionClient) DialTCPPort(ctx context.Context, port uint16) (net.Conn, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, net.ErrClosed
	}
	c.dialedPorts = append(c.dialedPorts, port)
	return &shortWriteConn{}, nil
}

func (c *fakeSessionClient) DiscoPing(ctx context.Context) (*ipnstate.PingResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, net.ErrClosed
	}
	if c.pingErr != nil {
		return nil, c.pingErr
	}
	if c.pingResult == nil {
		return nil, errors.New("no ping result")
	}
	result := *c.pingResult
	return &result, nil
}

func (c *fakeSessionClient) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		c.closeCalls++
	}
	return nil
}

var _ sessionClient = (*fakeSessionClient)(nil)

type blockingSessionClient struct {
	mu         sync.Mutex
	started    chan struct{}
	closed     chan struct{}
	startOnce  sync.Once
	closeOnce  sync.Once
	closeCalls int
}

func newBlockingSessionClient() *blockingSessionClient {
	return &blockingSessionClient{
		started: make(chan struct{}),
		closed:  make(chan struct{}),
	}
}

func (c *blockingSessionClient) DialTCPPort(ctx context.Context, port uint16) (net.Conn, error) {
	c.startOnce.Do(func() { close(c.started) })
	select {
	case <-c.closed:
		return nil, net.ErrClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *blockingSessionClient) DiscoPing(ctx context.Context) (*ipnstate.PingResult, error) {
	return nil, errors.New("not implemented")
}

func (c *blockingSessionClient) Close() error {
	c.mu.Lock()
	c.closeCalls++
	c.mu.Unlock()
	c.closeOnce.Do(func() { close(c.closed) })
	return nil
}

var _ sessionClient = (*blockingSessionClient)(nil)
