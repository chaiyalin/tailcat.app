// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"syscall/js"
	"testing"
	"time"

	"github.com/tailscale/tailcat"
)

func TestSessionStreamLimitIncludesPendingDials(t *testing.T) {
	client := &fakeSessionClient{}
	session := &jsSession{
		client:      client,
		connections: make(map[*sessionStream]struct{}),
	}

	for i := 0; i < maxSessionStreams; i++ {
		if _, _, err := session.reserveDial(); err != nil {
			t.Fatalf("reserveDial %d: %v", i, err)
		}
	}
	if _, _, err := session.reserveDial(); err == nil || !strings.Contains(err.Error(), "24") {
		t.Fatalf("25th reserveDial error = %v, want stream-limit error", err)
	}

	for i := 0; i < maxSessionStreams; i++ {
		session.finishFailedDial()
	}
	if _, _, err := session.reserveDial(); err != nil {
		t.Fatalf("reserveDial after releasing reservations: %v", err)
	}
	session.finishFailedDial()
}

func TestJSSessionDialAndClose(t *testing.T) {
	client := &fakeSessionClient{}
	session := newJSSession(client)

	conn, err := awaitPromise(session.Get("dial").Invoke(dialOptions(104)))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if got := conn.Get("port").Int(); got != 104 {
		t.Fatalf("connection port = %d, want 104", got)
	}

	session.Get("close").Invoke()
	session.Get("close").Invoke()
	// The stream's retained, idempotent close shim remains harmless after the
	// session has already closed its underlying connection.
	conn.Get("close").Invoke()
	if _, err := awaitPromise(session.Get("dial").Invoke(dialOptions(104))); err == nil {
		t.Fatal("dial after close succeeded")
	}

	client.mu.Lock()
	defer client.mu.Unlock()
	if client.closeCalls != 1 {
		t.Fatalf("client Close calls = %d, want 1", client.closeCalls)
	}
	if len(client.dialedPorts) != 1 || client.dialedPorts[0] != 104 {
		t.Fatalf("dialed ports = %v, want [104]", client.dialedPorts)
	}
	if len(client.connections) != 1 || !client.connections[0].isClosed() {
		t.Fatalf("active connection was not closed with the session")
	}
}

func TestClosingStreamRestoresSessionCapacity(t *testing.T) {
	client := &fakeSessionClient{}
	session := newJSSession(client)
	connections := make([]js.Value, 0, maxSessionStreams)
	for i := 0; i < maxSessionStreams; i++ {
		conn, err := awaitPromise(session.Get("dial").Invoke(dialOptions(104)))
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		connections = append(connections, conn)
	}
	if _, err := awaitPromise(session.Get("dial").Invoke(dialOptions(104))); err == nil {
		t.Fatal("25th active stream succeeded")
	}
	connections[0].Get("close").Invoke()
	if _, err := awaitPromise(session.Get("dial").Invoke(dialOptions(104))); err != nil {
		t.Fatalf("dial after closing one stream: %v", err)
	}
	session.Get("close").Invoke()
}

func TestSessionCloseUnblocksPendingDial(t *testing.T) {
	client := newBlockingSessionClient()
	session := newJSSession(client)
	pending := session.Get("dial").Invoke(dialOptions(102))

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

func TestSessionCloseWinsSuccessfulDialRace(t *testing.T) {
	client := newRacingSessionClient()
	session := newJSSession(client)
	pending := session.Get("dial").Invoke(dialOptions(103))

	select {
	case <-client.started:
	case <-time.After(2 * time.Second):
		t.Fatal("dial did not start")
	}
	session.Get("close").Invoke()
	close(client.proceed)
	if _, err := awaitPromise(pending); err == nil || !strings.Contains(err.Error(), "closed while dialing") {
		t.Fatalf("racing dial error = %v, want closed-while-dialing rejection", err)
	}
	if !client.conn.isClosed() {
		t.Fatal("connection returned after session close was not closed")
	}
}

func TestFailedDialReleasesReservation(t *testing.T) {
	client := &fakeSessionClient{dialFailures: 1}
	session := newJSSession(client)
	if _, err := awaitPromise(session.Get("dial").Invoke(dialOptions(104))); err == nil {
		t.Fatal("configured failed dial succeeded")
	}
	for i := 0; i < maxSessionStreams; i++ {
		if _, err := awaitPromise(session.Get("dial").Invoke(dialOptions(104))); err != nil {
			t.Fatalf("dial %d after failed dial: %v", i, err)
		}
	}
	if _, err := awaitPromise(session.Get("dial").Invoke(dialOptions(104))); err == nil {
		t.Fatal("25th active stream succeeded after prior failed dial")
	}
	session.Get("close").Invoke()
}

func TestAbortSignalCancelsPendingInitialization(t *testing.T) {
	controller := js.Global().Get("AbortController").New()
	ctx, cleanup, err := contextWithAbortSignal(context.Background(), controller.Get("signal"))
	if err != nil {
		t.Fatalf("contextWithAbortSignal: %v", err)
	}
	defer cleanup()

	client := newBlockingInitializationClient()
	done := make(chan error, 1)
	go func() {
		done <- initializeSessionClient(ctx, client)
	}()
	select {
	case <-client.started:
	case <-time.After(2 * time.Second):
		t.Fatal("client initialization did not start")
	}

	controller.Call("abort")
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("initialization error = %v, want context canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("abort did not cancel client initialization")
	}
	if got := client.closeCalls.Load(); got != 1 {
		t.Fatalf("client Close calls = %d, want 1", got)
	}
}

func TestAbortSignalRegistrationAndCleanup(t *testing.T) {
	signal := js.Global().Get("Object").New()
	signal.Set("aborted", false)
	var listener js.Value
	var removeCalls int
	add := js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) == 2 && args[0].String() == "abort" {
			listener = args[1]
		}
		return nil
	})
	remove := js.FuncOf(func(this js.Value, args []js.Value) any {
		removeCalls++
		return nil
	})
	defer add.Release()
	defer remove.Release()
	signal.Set("addEventListener", add)
	signal.Set("removeEventListener", remove)

	ctx, cleanup, err := contextWithAbortSignal(context.Background(), signal)
	if err != nil {
		t.Fatalf("contextWithAbortSignal: %v", err)
	}
	if listener.Type() != js.TypeFunction {
		t.Fatal("abort listener was not registered")
	}
	listener.Invoke()
	if !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatalf("abort context error = %v, want context canceled", ctx.Err())
	}
	cleanup()
	cleanup()
	if removeCalls != 1 {
		t.Fatalf("removeEventListener calls = %d, want 1", removeCalls)
	}
}

func TestAbortSignalValidationAndAlreadyAborted(t *testing.T) {
	if err := validateAbortSignal(js.Global().Get("Object").New()); err == nil {
		t.Fatal("plain object accepted as AbortSignal")
	}
	controller := js.Global().Get("AbortController").New()
	controller.Call("abort")
	ctx, cleanup, err := contextWithAbortSignal(context.Background(), controller.Get("signal"))
	if err != nil {
		t.Fatalf("contextWithAbortSignal: %v", err)
	}
	defer cleanup()
	if !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatalf("already-aborted context error = %v, want context canceled", ctx.Err())
	}
}

func TestAbortSignalListenerFailureIsReturned(t *testing.T) {
	signal := js.Global().Get("Object").New()
	signal.Set("aborted", false)
	signal.Set("addEventListener", js.Global().Get("Function").New("throw new Error('listener failed')"))
	signal.Set("removeEventListener", js.Global().Get("Function").New(""))
	if _, _, err := contextWithAbortSignal(context.Background(), signal); err == nil || !strings.Contains(err.Error(), "addEventListener") {
		t.Fatalf("listener registration error = %v", err)
	}
}

func TestInitializeSessionClientSuccessDoesNotClose(t *testing.T) {
	client := &successfulInitializationClient{}
	if err := initializeSessionClient(context.Background(), client); err != nil {
		t.Fatalf("initializeSessionClient: %v", err)
	}
	if got := client.closeCalls.Load(); got != 0 {
		t.Fatalf("client Close calls = %d, want 0", got)
	}
}

func TestInitializeSessionClientStopsRetryingAtDeadline(t *testing.T) {
	client := &failingInitializationClient{}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := initializeSessionClient(ctx, client); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("initializeSessionClient error = %v, want deadline exceeded", err)
	}
	if got := client.pingCalls.Load(); got == 0 {
		t.Fatal("client Ping was not called")
	}
	if got := client.closeCalls.Load(); got != 1 {
		t.Fatalf("client Close calls = %d, want 1", got)
	}
}

func TestSessionArgumentValidation(t *testing.T) {
	for _, value := range []any{0, -1, 65536, 1.5, "104", js.Global().Get("NaN"), js.Global().Get("Infinity")} {
		opts := js.Global().Get("Object").New()
		opts.Set("port", value)
		if _, err := requiredSessionPort([]js.Value{opts}); err == nil {
			t.Errorf("port %v accepted", value)
		}
	}
	valid := js.Global().Get("Object").New()
	valid.Set("port", 65535)
	if got, err := requiredSessionPort([]js.Value{valid}); err != nil || got != 65535 {
		t.Fatalf("port 65535 = %d, %v; want 65535, nil", got, err)
	}
	if _, err := requiredSessionPort(nil); err == nil {
		t.Fatal("missing dial options accepted")
	}
}

func TestParseClientOptions(t *testing.T) {
	empty := js.Global().Get("Object").New()
	if _, err := parseClientOptions(empty); err == nil || !strings.Contains(err.Error(), "addr") {
		t.Fatalf("empty options error = %v, want missing addr", err)
	}

	valid := js.Global().Get("Object").New()
	valid.Set("addr", "tc-test")
	valid.Set("derpMapURL", "https://example.invalid/derpmap")
	parsed, err := parseClientOptions(valid)
	if err != nil {
		t.Fatalf("parseClientOptions: %v", err)
	}
	if parsed.addr != "tc-test" || parsed.derpMapURL != "https://example.invalid/derpmap" {
		t.Fatalf("parsed options = %+v", parsed)
	}

	valid.Set("signal", js.Global().Get("Object").New())
	if _, err := parseClientOptions(valid); err == nil || !strings.Contains(err.Error(), "AbortSignal") {
		t.Fatalf("invalid signal error = %v", err)
	}
}

func TestTailcatConnectRejectsInvalidArgumentsBeforeNetworkUse(t *testing.T) {
	promise := tailcatConnect(js.Undefined(), nil).(js.Value)
	if _, err := awaitPromise(promise); err == nil || !strings.Contains(err.Error(), "options object") {
		t.Fatalf("missing options error = %v", err)
	}

	opts := js.Global().Get("Object").New()
	opts.Set("addr", "not-a-tailcat-address")
	promise = tailcatConnect(js.Undefined(), []js.Value{opts}).(js.Value)
	if _, err := awaitPromise(promise); err == nil || !strings.Contains(err.Error(), "parsing addr") {
		t.Fatalf("invalid address error = %v", err)
	}

	privateKey := tailcat.NewPrivateKey()
	opts.Set("addr", string(privateKey.Public.ConnBlob()))
	opts.Set("privateKey", "not-json")
	promise = tailcatConnect(js.Undefined(), []js.Value{opts}).(js.Value)
	if _, err := awaitPromise(promise); err == nil || !strings.Contains(err.Error(), "privateKey") {
		t.Fatalf("invalid private key error = %v", err)
	}
}

func TestAppTCPPortRangeIncludesGroupProtocol(t *testing.T) {
	for port := uint16(100); port <= 104; port++ {
		if !isAppTCPPort(port) {
			t.Errorf("port %d is not served", port)
		}
	}
	for _, port := range []uint16{0, 99, 105, 65535} {
		if isAppTCPPort(port) {
			t.Errorf("port %d is unexpectedly served", port)
		}
	}
}

func dialOptions(port int) js.Value {
	opts := js.Global().Get("Object").New()
	opts.Set("port", port)
	return opts
}

type fakeSessionClient struct {
	mu           sync.Mutex
	dialedPorts  []uint16
	connections  []*trackedConn
	dialFailures int
	closeCalls   int
	closed       bool
}

func (c *fakeSessionClient) DialTCPPort(ctx context.Context, port uint16) (net.Conn, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, net.ErrClosed
	}
	if c.dialFailures > 0 {
		c.dialFailures--
		return nil, errors.New("temporary failure")
	}
	conn := new(trackedConn)
	c.dialedPorts = append(c.dialedPorts, port)
	c.connections = append(c.connections, conn)
	return conn, nil
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

func (c *blockingSessionClient) Close() error {
	c.mu.Lock()
	c.closeCalls++
	c.mu.Unlock()
	c.closeOnce.Do(func() { close(c.closed) })
	return nil
}

var _ sessionClient = (*blockingSessionClient)(nil)

type racingSessionClient struct {
	started    chan struct{}
	proceed    chan struct{}
	startOnce  sync.Once
	closeCalls atomic.Int32
	conn       *trackedConn
}

func newRacingSessionClient() *racingSessionClient {
	return &racingSessionClient{
		started: make(chan struct{}),
		proceed: make(chan struct{}),
		conn:    new(trackedConn),
	}
}

func (c *racingSessionClient) DialTCPPort(ctx context.Context, port uint16) (net.Conn, error) {
	c.startOnce.Do(func() { close(c.started) })
	// Deliberately return a connection even if close canceled ctx. This forces
	// the session's post-dial closed check to win the race and clean it up.
	<-c.proceed
	return c.conn, nil
}

func (c *racingSessionClient) Close() error {
	c.closeCalls.Add(1)
	return nil
}

var _ sessionClient = (*racingSessionClient)(nil)

type blockingInitializationClient struct {
	started    chan struct{}
	startOnce  sync.Once
	closeCalls atomic.Int32
}

func newBlockingInitializationClient() *blockingInitializationClient {
	return &blockingInitializationClient{started: make(chan struct{})}
}

func (c *blockingInitializationClient) Ping(ctx context.Context) (tailcat.PingResult, error) {
	c.startOnce.Do(func() { close(c.started) })
	<-ctx.Done()
	return tailcat.PingResult{}, ctx.Err()
}

func (*blockingInitializationClient) DialTCPPort(context.Context, uint16) (net.Conn, error) {
	return nil, errors.New("not implemented")
}

func (c *blockingInitializationClient) Close() error {
	c.closeCalls.Add(1)
	return nil
}

var _ initializingSessionClient = (*blockingInitializationClient)(nil)

type successfulInitializationClient struct {
	closeCalls atomic.Int32
}

func (*successfulInitializationClient) Ping(context.Context) (tailcat.PingResult, error) {
	return tailcat.PingResult{}, nil
}

func (*successfulInitializationClient) DialTCPPort(context.Context, uint16) (net.Conn, error) {
	return nil, errors.New("not implemented")
}

func (c *successfulInitializationClient) Close() error {
	c.closeCalls.Add(1)
	return nil
}

var _ initializingSessionClient = (*successfulInitializationClient)(nil)

type failingInitializationClient struct {
	pingCalls  atomic.Int32
	closeCalls atomic.Int32
}

func (c *failingInitializationClient) Ping(context.Context) (tailcat.PingResult, error) {
	c.pingCalls.Add(1)
	return tailcat.PingResult{}, errors.New("relay is not ready")
}

func (*failingInitializationClient) DialTCPPort(context.Context, uint16) (net.Conn, error) {
	return nil, errors.New("not implemented")
}

func (c *failingInitializationClient) Close() error {
	c.closeCalls.Add(1)
	return nil
}

var _ initializingSessionClient = (*failingInitializationClient)(nil)

type trackedConn struct {
	mu          sync.Mutex
	written     []byte
	closed      bool
	writeClosed bool
}

func (*trackedConn) Read([]byte) (int, error) { return 0, errors.New("no data") }

func (c *trackedConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return 0, net.ErrClosed
	}
	c.written = append(c.written, p...)
	return len(p), nil
}

func (c *trackedConn) CloseWrite() error {
	c.mu.Lock()
	c.writeClosed = true
	c.mu.Unlock()
	return nil
}

func (c *trackedConn) Close() error {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	return nil
}

func (c *trackedConn) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (*trackedConn) LocalAddr() net.Addr              { return testAddr("local") }
func (*trackedConn) RemoteAddr() net.Addr             { return testAddr("remote") }
func (*trackedConn) SetDeadline(time.Time) error      { return nil }
func (*trackedConn) SetReadDeadline(time.Time) error  { return nil }
func (*trackedConn) SetWriteDeadline(time.Time) error { return nil }
