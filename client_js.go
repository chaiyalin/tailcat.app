// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"sync"
	"syscall/js"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

const (
	maxSessionStreams  = 24
	sessionTimeout     = 60 * time.Second
	pingAttemptTimeout = 5 * time.Second
	pingRetryDelay     = 100 * time.Millisecond
)

// sessionClient is the part of tailcat.Client needed after the initial DERP
// handshake. Keeping this boundary small makes lifecycle behavior testable
// without contacting a relay.
type sessionClient interface {
	DialTCPPort(context.Context, uint16) (net.Conn, error)
	Close() error
}

type initializingSessionClient interface {
	sessionClient
	Ping(context.Context) (tailcat.PingResult, error)
}

type clientOptions struct {
	addr        string
	derpMapURL  string
	keyJSON     string
	abortSignal js.Value
}

func parseClientOptions(opts js.Value) (clientOptions, error) {
	o := clientOptions{
		addr:        optString(opts, "addr"),
		derpMapURL:  optString(opts, "derpMapURL"),
		keyJSON:     optString(opts, "privateKey"),
		abortSignal: opts.Get("signal"),
	}
	if o.addr == "" {
		return clientOptions{}, errors.New("addr is required")
	}
	if err := validateAbortSignal(o.abortSignal); err != nil {
		return clientOptions{}, err
	}
	return o, nil
}

func (o clientOptions) newClient() (*tailcat.Client, error) {
	server := tailcat.ConnBlob(o.addr)
	if _, err := tailcat.ParseConnBlob(server); err != nil {
		return nil, fmt.Errorf("parsing addr: %w", err)
	}
	priv := key.NewNode()
	if o.keyJSON != "" {
		var pk tailcat.PrivateKey
		if err := json.Unmarshal([]byte(o.keyJSON), &pk); err != nil {
			return nil, fmt.Errorf("parsing privateKey: %w", err)
		}
		priv = pk.Private
	}
	return &tailcat.Client{
		Server:     server,
		Key:        priv,
		Logf:       logger.Discard,
		DERPMapURL: o.derpMapURL,
	}, nil
}

// tailcatConnect creates one persistent Tailcat client whose streams share a
// single DERP connection and node identity:
//
//	const client = await tailcatConnect({ addr, derpMapURL, privateKey, signal })
//	const conn = await client.dial({ port: 104 })
//	client.close()
//
// signal, when provided, cancels initialization. The listener is removed as
// soon as initialization settles; closing an established client is explicit.
// At most maxSessionStreams streams may be active or dialing at once.
func tailcatConnect(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("tailcatConnect requires an options object"))
	}
	opts, err := parseClientOptions(args[0])
	if err != nil {
		return rejectedPromise(err)
	}
	ctx, releaseAbort, err := contextWithAbortSignal(context.Background(), opts.abortSignal)
	if err != nil {
		return rejectedPromise(err)
	}
	return makePromise(func() (any, error) {
		defer releaseAbort()

		client, err := opts.newClient()
		if err != nil {
			return nil, err
		}
		initCtx, cancel := context.WithTimeout(ctx, sessionTimeout)
		defer cancel()
		if err := initializeSessionClient(initCtx, client); err != nil {
			return nil, err
		}
		return newJSSession(client), nil
	})
}

// validateAbortSignal uses a structural check so AbortSignals from another
// same-origin JavaScript realm are accepted too.
func validateAbortSignal(signal js.Value) error {
	if signal.Type() == js.TypeUndefined || signal.Type() == js.TypeNull {
		return nil
	}
	if signal.Type() != js.TypeObject ||
		signal.Get("aborted").Type() != js.TypeBoolean ||
		signal.Get("addEventListener").Type() != js.TypeFunction ||
		signal.Get("removeEventListener").Type() != js.TypeFunction {
		return errors.New("signal must be an AbortSignal")
	}
	return nil
}

// contextWithAbortSignal connects a JavaScript AbortSignal to a Go context.
// cleanup removes and releases the Go callback and is safe to call repeatedly.
func contextWithAbortSignal(parent context.Context, signal js.Value) (ctx context.Context, cleanup func(), err error) {
	ctx, cancel := context.WithCancel(parent)
	if signal.Type() == js.TypeUndefined || signal.Type() == js.TypeNull {
		return ctx, cancel, nil
	}
	if err := validateAbortSignal(signal); err != nil {
		cancel()
		return nil, nil, err
	}
	if signal.Get("aborted").Bool() {
		cancel()
		return ctx, cancel, nil
	}

	abort := js.FuncOf(func(this js.Value, args []js.Value) any {
		cancel()
		return nil
	})
	if err := callAbortSignalMethod(signal, "addEventListener", "abort", abort); err != nil {
		abort.Release()
		cancel()
		return nil, nil, err
	}
	var once sync.Once
	cleanup = func() {
		once.Do(func() {
			_ = callAbortSignalMethod(signal, "removeEventListener", "abort", abort)
			abort.Release()
			cancel()
		})
	}
	// Close the check/register race. A standards-compliant AbortSignal will
	// dispatch the event, while the second read also covers lightweight mocks.
	if signal.Get("aborted").Bool() {
		cancel()
	}
	return ctx, cleanup, nil
}

func callAbortSignalMethod(signal js.Value, method string, args ...any) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("signal.%s failed: %v", method, recovered)
		}
	}()
	signal.Call(method, args...)
	return nil
}

func initializeSessionClient(ctx context.Context, client initializingSessionClient) (err error) {
	defer func() {
		if err != nil {
			_ = client.Close()
		}
	}()
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("initializing Tailcat client: %w", err)
	}
	if err := pingSessionUntil(ctx, client); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("initializing Tailcat client: %w", err)
	}
	return nil
}

// pingSessionUntil repeats the DERP meow handshake while the relay connection
// is coming up. Individual attempts are bounded so an abort is observed
// promptly even if one attempt stalls.
func pingSessionUntil(ctx context.Context, client interface {
	Ping(context.Context) (tailcat.PingResult, error)
}) error {
	for {
		pingCtx, cancel := context.WithTimeout(ctx, pingAttemptTimeout)
		_, err := client.Ping(pingCtx)
		cancel()
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return fmt.Errorf("ping: %w", ctx.Err())
		}
		select {
		case <-time.After(pingRetryDelay):
		case <-ctx.Done():
			return fmt.Errorf("ping: %w", ctx.Err())
		}
	}
}

type sessionStream struct {
	close func()
}

type jsSession struct {
	mu          sync.Mutex
	client      sessionClient
	dialContext context.Context
	cancelDials context.CancelFunc
	closed      bool
	pending     int
	connections map[*sessionStream]struct{}
}

func newJSSession(client sessionClient) js.Value {
	dialContext, cancelDials := context.WithCancel(context.Background())
	session := &jsSession{
		client:      client,
		dialContext: dialContext,
		cancelDials: cancelDials,
		connections: make(map[*sessionStream]struct{}),
	}
	object := js.Global().Get("Object").New()
	promise := js.Global().Get("Promise")
	closedDial := promise.Get("reject").Call(
		"bind",
		promise,
		js.Global().Get("Error").New("Tailcat client is closed"),
	)
	closedClose := js.Global().Get("Boolean")

	var (
		dialFunc  js.Func
		closeFunc js.Func
		release   sync.Once
	)
	dialFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		port, err := requiredSessionPort(args)
		if err != nil {
			return rejectedPromise(err)
		}
		client, dialContext, err := session.reserveDial()
		if err != nil {
			return rejectedPromise(err)
		}
		return makePromise(func() (any, error) {
			dialCtx, cancel := context.WithTimeout(dialContext, sessionTimeout)
			defer cancel()
			conn, err := client.DialTCPPort(dialCtx, port)
			if err != nil {
				if conn != nil {
					_ = conn.Close()
				}
				session.finishFailedDial()
				return nil, fmt.Errorf("DialTCPPort: %w", err)
			}
			if conn == nil {
				session.finishFailedDial()
				return nil, errors.New("DialTCPPort returned no connection")
			}

			stream := new(sessionStream)
			connection := makeJSConn(conn, port, func() {
				session.releaseConnection(stream)
			})
			stream.close = func() {
				connection.Get("close").Invoke()
			}
			if err := session.finishSuccessfulDial(stream); err != nil {
				stream.close()
				return nil, err
			}
			return connection, nil
		})
	})
	closeFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		session.close()
		release.Do(func() {
			// Never leave a released Go callback reachable from JavaScript.
			// Native replacements preserve deterministic post-close behavior.
			object.Set("dial", closedDial)
			object.Set("close", closedClose)
			dialFunc.Release()
			closeFunc.Release()
			dialFunc = js.Func{}
			closeFunc = js.Func{}
		})
		return nil
	})

	object.Set("dial", dialFunc)
	object.Set("close", closeFunc)
	return object
}

func (s *jsSession) reserveDial() (sessionClient, context.Context, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.client == nil {
		return nil, nil, errors.New("Tailcat client is closed")
	}
	if s.pending+len(s.connections) >= maxSessionStreams {
		return nil, nil, fmt.Errorf("at most %d Tailcat streams may be active or dialing", maxSessionStreams)
	}
	s.pending++
	dialContext := s.dialContext
	if dialContext == nil {
		dialContext = context.Background()
	}
	return s.client, dialContext, nil
}

func (s *jsSession) finishFailedDial() {
	s.mu.Lock()
	if s.pending > 0 {
		s.pending--
	}
	s.mu.Unlock()
}

func (s *jsSession) finishSuccessfulDial(stream *sessionStream) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending > 0 {
		s.pending--
	}
	if s.closed || s.client == nil {
		return errors.New("Tailcat client was closed while dialing")
	}
	s.connections[stream] = struct{}{}
	return nil
}

func (s *jsSession) releaseConnection(stream *sessionStream) {
	s.mu.Lock()
	delete(s.connections, stream)
	s.mu.Unlock()
}

func (s *jsSession) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	client := s.client
	s.client = nil
	cancelDials := s.cancelDials
	s.cancelDials = nil
	s.dialContext = nil
	connections := s.connections
	s.connections = nil
	s.mu.Unlock()

	if cancelDials != nil {
		cancelDials()
	}
	// Closing through each JavaScript wrapper also releases its read/write
	// callbacks; closing only the raw net.Conn would retain them indefinitely.
	for stream := range connections {
		stream.close()
	}
	if client != nil {
		_ = client.Close()
	}
}

func requiredSessionPort(args []js.Value) (uint16, error) {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return 0, errors.New("dial requires an options object")
	}
	p := args[0].Get("port")
	if p.Type() != js.TypeNumber {
		return 0, errors.New("port must be an integer from 1 through 65535")
	}
	n := p.Float()
	if math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n < 1 || n > math.MaxUint16 {
		return 0, errors.New("port must be an integer from 1 through 65535")
	}
	return uint16(n), nil
}
