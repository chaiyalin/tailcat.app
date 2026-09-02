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
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

const (
	maxSessionStreams   = 24
	defaultStatusWait   = 5 * time.Second
	maximumStatusWait   = 30 * time.Second
	webRTCMagicEndpoint = "127.3.3.41"
)

// sessionClient is the subset of tailcat.Client used by a persistent browser
// session. Keeping the boundary small also lets the stream and status behavior
// be tested without reaching a DERP relay.
type sessionClient interface {
	DialTCPPort(context.Context, uint16) (net.Conn, error)
	DiscoPing(context.Context) (*ipnstate.PingResult, error)
	Close() error
}

type initializingSessionClient interface {
	sessionClient
	Ping(context.Context) (tailcat.PingResult, error)
}

type sessionDiagnostics interface {
	recordPath(string)
	snapshot() js.Value
	close()
}

type clientOptions struct {
	addr        string
	derpMapURL  string
	keyJSON     string
	logf        logger.Logf
	abortSignal js.Value
}

func parseClientOptions(opts js.Value) (clientOptions, error) {
	o := clientOptions{
		addr:        optString(opts, "addr"),
		derpMapURL:  optString(opts, "derpMapURL"),
		keyJSON:     optString(opts, "privateKey"),
		logf:        optLogf(opts),
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
	priv := key.NewNode()
	if o.keyJSON != "" {
		var pk tailcat.PrivateKey
		if err := json.Unmarshal([]byte(o.keyJSON), &pk); err != nil {
			return nil, fmt.Errorf("parsing privateKey: %w", err)
		}
		priv = pk.Private
	}
	return &tailcat.Client{
		Server:     tailcat.ConnBlob(o.addr),
		Key:        priv,
		Logf:       o.logf,
		DERPMapURL: o.derpMapURL,
	}, nil
}

// tailcatConnect creates one persistent Tailcat client. Multiple application
// protocol streams can then share its magicsock path discovery state:
//
//	const client = await tailcatConnect(options)
//	const conn = await client.dial({port: 101})
//	const status = await client.status({timeoutMs: 5000})
//	client.close()
//
// options.signal may be an AbortSignal. Aborting it rejects initialization and
// closes the partially started Tailcat client before this Promise resolves.
//
// At most maxSessionStreams streams may be active or dialing at once.
func tailcatConnect(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("tailcatConnect requires an options object"))
	}
	opts, err := parseClientOptions(args[0])
	if err != nil {
		return rejectedPromise(err)
	}
	parent, releaseAbort, err := contextWithAbortSignal(context.Background(), opts.abortSignal)
	if err != nil {
		return rejectedPromise(err)
	}
	return makePromise(func() (any, error) {
		defer releaseAbort()
		cl, err := opts.newClient()
		if err != nil {
			return nil, err
		}
		if err := markTransportStarted(); err != nil {
			_ = cl.Close()
			return nil, err
		}
		ctx, cancel := context.WithTimeout(parent, 60*time.Second)
		defer cancel()
		if err := initializeSessionClient(ctx, cl); err != nil {
			return nil, err
		}
		return newJSSession(cl), nil
	})
}

// validateAbortSignal accepts a standard AbortSignal or no signal. It uses a
// structural check so signals created in another same-origin realm still work.
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
// cleanup removes and releases the Go callback and must always be called.
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
	// Close the check/register race: an abort between the first aborted read and
	// addEventListener is observed here even if the browser did not queue it.
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

func initializeSessionClient(ctx context.Context, cl initializingSessionClient) error {
	if err := ctx.Err(); err != nil {
		_ = cl.Close()
		return fmt.Errorf("initializing Tailcat client: %w", err)
	}
	if err := pingUntil(ctx, cl); err != nil {
		_ = cl.Close()
		return err
	}
	if err := ctx.Err(); err != nil {
		_ = cl.Close()
		return fmt.Errorf("initializing Tailcat client: %w", err)
	}
	return nil
}

type jsSession struct {
	mu          sync.Mutex
	client      sessionClient
	closed      bool
	pending     int
	nextID      uint64
	connections map[uint64]func()
}

func newJSSession(client sessionClient) js.Value {
	s := &jsSession{
		client:      client,
		connections: make(map[uint64]func()),
	}
	diagnostics := newSessionDiagnostics()
	object := js.Global().Get("Object").New()
	promise := js.Global().Get("Promise")
	closedDial := promise.Get("reject").Call(
		"bind",
		promise,
		js.Global().Get("Error").New("Tailcat client is closed"),
	)
	closedStatus := promise.Get("resolve").Call(
		"bind",
		promise,
		js.ValueOf(closedSessionStatus()),
	)
	closedClose := js.Global().Get("Boolean")

	var (
		dialFunc        js.Func
		statusFunc      js.Func
		closeFunc       js.Func
		diagnosticsFunc js.Func
		release         sync.Once
	)
	dialFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		port, err := requiredSessionPort(args)
		if err != nil {
			return rejectedPromise(err)
		}
		client, err := s.reserveDial()
		if err != nil {
			return rejectedPromise(err)
		}
		return makePromise(func() (any, error) {
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			conn, err := client.DialTCPPort(ctx, port)
			if err != nil {
				if conn != nil {
					_ = conn.Close()
				}
				s.finishFailedDial()
				return nil, fmt.Errorf("DialTCPPort: %w", err)
			}
			if conn == nil {
				s.finishFailedDial()
				return nil, errors.New("DialTCPPort returned no connection")
			}
			var id uint64
			connection, closeConnection := makeJSConnWithClose(conn, port, func() {
				if id != 0 {
					s.releaseConnection(id)
				}
			})
			id, err = s.finishSuccessfulDial(closeConnection)
			if err != nil {
				closeConnection()
				return nil, err
			}
			return connection, nil
		})
	})
	statusFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		timeout, err := requiredStatusTimeout(args)
		if err != nil {
			return rejectedPromise(err)
		}
		client, closed := s.statusClient()
		if closed {
			return resolvedPromise(closedSessionStatus())
		}
		return makePromise(func() (any, error) {
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			result, err := client.DiscoPing(ctx)
			if err != nil {
				if diagnostics != nil {
					diagnostics.recordPath("unknown")
				}
				return nil, fmt.Errorf("DiscoPing: %w", err)
			}
			if result == nil {
				if diagnostics != nil {
					diagnostics.recordPath("unknown")
				}
				return nil, errors.New("DiscoPing returned no result")
			}
			status := sessionStatus(result)
			if diagnostics != nil {
				diagnostics.recordPath(status["path"].(string))
			}
			return status, nil
		})
	})
	if diagnostics != nil {
		diagnosticsFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
			return diagnostics.snapshot()
		})
	}
	closeFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		s.close()
		release.Do(func() {
			// Replace all Go callbacks before releasing them. The replacement
			// functions are native JavaScript values, retain no Go state, and
			// preserve predictable post-close behavior.
			object.Set("dial", closedDial)
			object.Set("status", closedStatus)
			object.Set("close", closedClose)
			if diagnostics != nil {
				diagnostics.close()
				js.Global().Get("Reflect").Call("deleteProperty", object, "diagnostics")
				diagnosticsFunc.Release()
				diagnosticsFunc = js.Func{}
			}
			dialFunc.Release()
			statusFunc.Release()
			closeFunc.Release()
			dialFunc = js.Func{}
			statusFunc = js.Func{}
			closeFunc = js.Func{}
		})
		return nil
	})

	object.Set("dial", dialFunc)
	object.Set("status", statusFunc)
	object.Set("close", closeFunc)
	if diagnostics != nil {
		object.Set("diagnostics", diagnosticsFunc)
	}
	return object
}

func (s *jsSession) reserveDial() (sessionClient, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.client == nil {
		return nil, errors.New("Tailcat client is closed")
	}
	if s.pending+len(s.connections) >= maxSessionStreams {
		return nil, fmt.Errorf("at most %d Tailcat streams may be active", maxSessionStreams)
	}
	s.pending++
	return s.client, nil
}

func (s *jsSession) finishFailedDial() {
	s.mu.Lock()
	if s.pending > 0 {
		s.pending--
	}
	s.mu.Unlock()
}

func (s *jsSession) finishSuccessfulDial(closeConnection func()) (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending > 0 {
		s.pending--
	}
	if s.closed || s.client == nil {
		return 0, errors.New("Tailcat client was closed while dialing")
	}
	s.nextID++
	id := s.nextID
	s.connections[id] = closeConnection
	return id, nil
}

func (s *jsSession) releaseConnection(id uint64) {
	s.mu.Lock()
	delete(s.connections, id)
	s.mu.Unlock()
}

func (s *jsSession) statusClient() (sessionClient, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.client, s.closed || s.client == nil
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
	connections := s.connections
	s.connections = nil
	s.mu.Unlock()

	for _, closeConnection := range connections {
		closeConnection()
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

func requiredStatusTimeout(args []js.Value) (time.Duration, error) {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return 0, errors.New("status requires an options object")
	}
	p := args[0].Get("timeoutMs")
	if p.Type() == js.TypeUndefined || p.Type() == js.TypeNull {
		return defaultStatusWait, nil
	}
	if p.Type() != js.TypeNumber {
		return 0, errors.New("timeoutMs must be an integer from 1 through 30000")
	}
	n := p.Float()
	if math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n < 1 || n > float64(maximumStatusWait/time.Millisecond) {
		return 0, errors.New("timeoutMs must be an integer from 1 through 30000")
	}
	return time.Duration(n) * time.Millisecond, nil
}

func sessionStatus(result *ipnstate.PingResult) map[string]any {
	path := "unknown"
	if endpointHost(result.Endpoint) == webRTCMagicEndpoint {
		path = "webrtc"
	} else if result.DERPRegionID != 0 {
		path = "derp"
	}
	return map[string]any{
		"state":          "connected",
		"path":           path,
		"latencyMs":      result.LatencySeconds * 1000,
		"derpRegionID":   int(result.DERPRegionID),
		"derpRegionCode": result.DERPRegionCode,
	}
}

func closedSessionStatus() map[string]any {
	return map[string]any{
		"state":          "closed",
		"path":           "unknown",
		"latencyMs":      float64(0),
		"derpRegionID":   0,
		"derpRegionCode": "",
	}
}

func endpointHost(endpoint string) string {
	if endpoint == "" {
		return ""
	}
	host, _, err := net.SplitHostPort(endpoint)
	if err == nil {
		return strings.Trim(host, "[]")
	}
	return ""
}
