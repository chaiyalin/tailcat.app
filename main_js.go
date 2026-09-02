// Copyright (c) Tailscale Inc & contributors
// SPDX-License-Identifier: BSD-3-Clause

// The tailcat web app is the WebAssembly (js/wasm) build of tailcat
// for browsers. It exposes tailcatListen, tailcatDial, tailcatConnect,
// tailcatConfigureTransport, and tailcatNewSHA256 as global JavaScript
// functions that app.js uses
// to implement streaming file sharing. The browser reaches DERP relays over WebSockets,
// which tailscale.com's derphttp package does automatically under
// GOOS=js.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"sync"
	"syscall/js"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
	"tailscale.com/wgengine/filter"
)

func main() {
	js.Global().Set("tailcatListen", js.FuncOf(tailcatListen))
	js.Global().Set("tailcatDial", js.FuncOf(tailcatDial))
	js.Global().Set("tailcatConnect", js.FuncOf(tailcatConnect))
	js.Global().Set("tailcatConfigureTransport", js.FuncOf(tailcatConfigureTransport))
	js.Global().Set("tailcatNewSHA256", js.FuncOf(tailcatNewSHA256))
	if f := js.Global().Get("onTailcatReady"); f.Type() == js.TypeFunction {
		f.Invoke()
	}
	select {}
}

// tailcatListen starts a tailcat server in the browser.
//
// It takes one options object argument:
//
//	{
//	  derpMapURL: string,      // absolute URL of the JSON DERP map (required)
//	  privateKey: string,      // optional tailcat.PrivateKey JSON; ephemeral if empty
//	  regionID: number,        // optional; -1 selects automatically, positive IDs pin a region
//	  verbose: bool,           // optional; log to the console
//	  onConnection: (conn) => {}, // called with a conn object per incoming connection
//	}
//
// It returns a Promise that resolves to:
//
//	{
//	  addr: string,           // the "tc..." address to share
//	  privateKeyJSON: string, // the key (with its DERP region pinned), for persistence
//	  regionID: number,       // the selected DERP region
//	  regionName: string,
//	  regionCode: string,
//	  close: () => {},
//	}
func tailcatListen(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("tailcatListen requires an options object"))
	}
	opts := args[0]
	onConnection := opts.Get("onConnection")
	derpMapURL := optString(opts, "derpMapURL")
	keyJSON := optString(opts, "privateKey")
	logf := optLogf(opts)
	requestedRegionID, hasRequestedRegion, regionErr := optRegionID(opts)
	return makePromise(func() (any, error) {
		if onConnection.Type() != js.TypeFunction {
			return nil, errors.New("onConnection function is required")
		}
		if derpMapURL == "" {
			return nil, errors.New("derpMapURL is required")
		}
		if regionErr != nil {
			return nil, regionErr
		}
		pk := &tailcat.PrivateKey{}
		if keyJSON != "" {
			if err := json.Unmarshal([]byte(keyJSON), pk); err != nil {
				return nil, fmt.Errorf("parsing privateKey: %w", err)
			}
		} else {
			pk = tailcat.NewPrivateKey()
			pk.Public.RegionID = -1 // auto-select
		}
		markTransportStarted()
		if hasRequestedRegion {
			// An explicit selection overrides the region stored with a
			// remembered key while retaining the node identity.
			pk.Public.Region = nil
			pk.Public.RegionID = requestedRegionID
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ci := pk.Public
		if err := ci.Expand(ctx, tailcat.ExpandForServer, tailcat.DERPMapURL(derpMapURL)); err != nil {
			return nil, fmt.Errorf("Expand: %w", err)
		}
		if len(ci.Region) == 0 || ci.Region[0] == nil {
			return nil, errors.New("DERP map did not resolve a usable region")
		}
		reg := ci.Region[0]
		// Pin the resolved region so the returned address and any
		// persisted key keep using the same relay across page loads.
		pk.Public.Region = nil
		pk.Public.RegionID = reg.RegionID
		blob := pk.Public.ConnBlob()
		keyOut, err := json.Marshal(pk)
		if err != nil {
			return nil, err
		}

		srv := &tailcat.Server{
			Key:            pk.Private,
			Logf:           logf,
			Region:         reg,
			ServedTCPPorts: []filter.PortRange{{First: 100, Last: 103}},
		}
		srv.OnTCP = func(port uint16) (handler func(net.Conn)) {
			if port < 100 || port > 103 {
				return nil
			}
			return func(c net.Conn) {
				onConnection.Invoke(makeJSConn(c, port, nil))
			}
		}
		if err := srv.Start(); err != nil {
			srv.Close()
			return nil, fmt.Errorf("Server.Start: %w", err)
		}
		// Keep close idempotent for the JavaScript API, but drop the heavy
		// server reference after the first call. The small close callback can
		// safely remain callable without retaining the netstack and OnTCP
		// callback for every stopped/reopened room.
		var (
			closeOnce sync.Once
			serverMu  sync.Mutex
			server    = srv
		)
		return map[string]any{
			"addr":           string(blob),
			"privateKeyJSON": string(keyOut),
			"regionID":       int(reg.RegionID),
			"regionName":     reg.RegionName,
			"regionCode":     reg.RegionCode,
			"close": js.FuncOf(func(this js.Value, args []js.Value) any {
				closeOnce.Do(func() {
					serverMu.Lock()
					current := server
					server = nil
					serverMu.Unlock()
					if current != nil {
						_ = current.Close()
					}
				})
				return nil
			}),
		}, nil
	})
}

// tailcatNewSHA256 returns an incremental SHA-256 object for hashing streamed
// file chunks without first collecting the complete file in browser memory.
//
//	{
//	  update: (Uint8Array) => Promise<void>,
//	  digestHex: () => Promise<string>, // lowercase; idempotent
//	  close: () => {},
//	}
//
// The first digestHex call finalizes the hash. Subsequent digestHex calls
// return the same value, while update calls reject. close invalidates the
// object and releases the hash state.
func tailcatNewSHA256(this js.Value, args []js.Value) any {
	if len(args) != 0 {
		return js.Null()
	}

	var (
		mu        sync.Mutex
		h         = sha256.New()
		finalized bool
		closed    bool
		digest    string
	)

	var update, digestHex js.Func
	update = js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) != 1 || !args[0].InstanceOf(js.Global().Get("Uint8Array")) {
			return rejectedPromise(errors.New("update requires a Uint8Array"))
		}
		chunk := make([]byte, args[0].Get("byteLength").Int())
		if copied := js.CopyBytesToGo(chunk, args[0]); copied != len(chunk) {
			return rejectedPromise(errors.New("failed to copy the complete Uint8Array"))
		}

		mu.Lock()
		defer mu.Unlock()
		switch {
		case closed:
			return rejectedPromise(errors.New("SHA-256 object is closed"))
		case finalized:
			return rejectedPromise(errors.New("SHA-256 digest has already been finalized"))
		}
		_, _ = h.Write(chunk) // hash.Hash.Write never returns an error.
		return resolvedPromise(js.Undefined())
	})

	digestHex = js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) != 0 {
			return rejectedPromise(errors.New("digestHex takes no arguments"))
		}
		mu.Lock()
		defer mu.Unlock()
		if closed {
			return rejectedPromise(errors.New("SHA-256 object is closed"))
		}
		if !finalized {
			digest = hex.EncodeToString(h.Sum(nil))
			finalized = true
			h = nil
		}
		return resolvedPromise(digest)
	})

	var releaseOnce sync.Once
	closeHash := js.FuncOf(func(this js.Value, args []js.Value) any {
		mu.Lock()
		closed = true
		h = nil
		digest = ""
		mu.Unlock()
		// The application never hashes after close. Release the hot-path
		// callbacks so each completed file does not leave two registered Go
		// functions behind. Keep only this tiny close callback for idempotence.
		releaseOnce.Do(func() {
			update.Release()
			digestHex.Release()
			update = js.Func{}
			digestHex = js.Func{}
		})
		return nil
	})

	return map[string]any{
		"update":    update,
		"digestHex": digestHex,
		"close":     closeHash,
	}
}

// tailcatDial connects to a tailcat server and dials one TCP stream
// over the tunnel.
//
// It takes one options object argument:
//
//	{
//	  addr: string,       // the server's "tc..." address (required)
//	  derpMapURL: string, // optional absolute URL of the JSON DERP map
//	  privateKey: string, // optional tailcat.PrivateKey JSON; ephemeral if empty
//	  port: number,       // optional TCP port; defaults to 1 like the CLI
//	  verbose: bool,
//	}
//
// It returns a Promise that resolves to a conn object (see makeJSConn).
func tailcatDial(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("tailcatDial requires an options object"))
	}
	opts := args[0]
	addr := optString(opts, "addr")
	derpMapURL := optString(opts, "derpMapURL")
	keyJSON := optString(opts, "privateKey")
	logf := optLogf(opts)
	port := uint16(1)
	if p := opts.Get("port"); p.Type() == js.TypeNumber {
		port = uint16(p.Int())
	}
	return makePromise(func() (any, error) {
		if addr == "" {
			return nil, errors.New("addr is required")
		}
		priv := key.NewNode()
		if keyJSON != "" {
			var pk tailcat.PrivateKey
			if err := json.Unmarshal([]byte(keyJSON), &pk); err != nil {
				return nil, fmt.Errorf("parsing privateKey: %w", err)
			}
			priv = pk.Private
		}
		cl := &tailcat.Client{
			Server:     tailcat.ConnBlob(addr),
			Key:        priv,
			Logf:       logf,
			DERPMapURL: derpMapURL,
		}
		markTransportStarted()
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if err := pingUntil(ctx, cl); err != nil {
			cl.Close()
			return nil, err
		}
		c, err := cl.DialTCPPort(ctx, port)
		if err != nil {
			cl.Close()
			return nil, fmt.Errorf("DialTCPPort: %w", err)
		}
		return makeJSConn(c, port, func() { cl.Close() }), nil
	})
}

// pingUntil retries the meow/meowed handshake until it succeeds or
// ctx expires. The first pings can be lost while either side's DERP
// connection is still coming up.
func pingUntil(ctx context.Context, cl *tailcat.Client) error {
	for {
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, err := cl.Ping(pctx)
		cancel()
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return fmt.Errorf("ping: %w", err)
		}
	}
}

// makeJSConn wraps a tunneled TCP connection as a JavaScript object:
//
//	{
//	  port: number,
//	  read: () => Promise<Uint8Array|null>, // null on EOF; no concurrent calls
//	  write: (Uint8Array) => Promise,
//	  closeWrite: () => Promise, // half-close, netcat style
//	  close: () => {},
//	}
//
// read is pull-based: the browser only reads from netstack when the
// page asks for more, so a fast sender stalls on TCP backpressure
// rather than filling browser memory.
func makeJSConn(c net.Conn, port uint16, onClose func()) js.Value {
	buf := make([]byte, 64<<10)
	var (
		closeOnce   sync.Once
		releaseOnce sync.Once
		connMu      sync.Mutex
		readMu      sync.Mutex
		writeMu     sync.Mutex
		conn        = c
		cleanup     = onClose
		readFunc    js.Func
		writeFunc   js.Func
		closeWFunc  js.Func
	)
	currentConn := func() (net.Conn, error) {
		connMu.Lock()
		defer connMu.Unlock()
		if conn == nil {
			return nil, net.ErrClosed
		}
		return conn, nil
	}
	closeConn := func() {
		closeOnce.Do(func() {
			connMu.Lock()
			current := conn
			conn = nil
			after := cleanup
			cleanup = nil
			connMu.Unlock()
			if current != nil {
				_ = current.Close()
			}
			if after != nil {
				after()
			}
			// read/write/closeWrite are invalid after close and can release
			// their syscall/js registrations. The close callback remains so
			// repeated close calls stay harmless, but it no longer retains the
			// connection or Tailcat client through conn/cleanup.
			releaseOnce.Do(func() {
				readFunc.Release()
				writeFunc.Release()
				closeWFunc.Release()
				readFunc = js.Func{}
				writeFunc = js.Func{}
				closeWFunc = js.Func{}
			})
		})
	}
	readFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		return makePromise(func() (any, error) {
			readMu.Lock()
			defer readMu.Unlock()
			current, err := currentConn()
			if err != nil {
				return nil, err
			}
			n, err := current.Read(buf)
			if n > 0 {
				u8 := js.Global().Get("Uint8Array").New(n)
				if copied := js.CopyBytesToJS(u8, buf[:n]); copied != n {
					return nil, errors.New("failed to copy the complete read buffer")
				}
				return u8, nil
			}
			if err == nil || errors.Is(err, io.EOF) {
				return js.Null(), nil
			}
			return nil, err
		})
	})
	writeFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) != 1 || !args[0].InstanceOf(js.Global().Get("Uint8Array")) {
			return rejectedPromise(errors.New("write requires a Uint8Array"))
		}
		b := make([]byte, args[0].Get("byteLength").Int())
		if copied := js.CopyBytesToGo(b, args[0]); copied != len(b) {
			return rejectedPromise(errors.New("failed to copy the complete Uint8Array"))
		}
		return makePromise(func() (any, error) {
			writeMu.Lock()
			defer writeMu.Unlock()
			current, err := currentConn()
			if err != nil {
				return nil, err
			}
			for written := 0; written < len(b); {
				n, err := current.Write(b[written:])
				written += n
				if err != nil {
					return nil, err
				}
				if n == 0 {
					return nil, io.ErrNoProgress
				}
			}
			return js.Undefined(), nil
		})
	})
	closeWFunc = js.FuncOf(func(this js.Value, args []js.Value) any {
		return makePromise(func() (any, error) {
			writeMu.Lock()
			defer writeMu.Unlock()
			current, err := currentConn()
			if err != nil {
				return nil, err
			}
			cw, ok := current.(interface{ CloseWrite() error })
			if !ok {
				return nil, errors.New("connection does not support half-close")
			}
			if err := cw.CloseWrite(); err != nil {
				return nil, err
			}
			return js.Undefined(), nil
		})
	})
	closeFunc := js.FuncOf(func(this js.Value, args []js.Value) any {
		closeConn()
		return nil
	})
	return js.ValueOf(map[string]any{
		"port":       int(port),
		"read":       readFunc,
		"write":      writeFunc,
		"closeWrite": closeWFunc,
		"close":      closeFunc,
	})
}

func optString(v js.Value, name string) string {
	if p := v.Get(name); p.Type() == js.TypeString {
		return p.String()
	}
	return ""
}

func optRegionID(v js.Value) (tailcfg.DERPRegionID, bool, error) {
	p := v.Get("regionID")
	if p.Type() == js.TypeUndefined || p.Type() == js.TypeNull {
		return 0, false, nil
	}
	if p.Type() != js.TypeNumber {
		return 0, false, errors.New("regionID must be a number")
	}
	n := p.Float()
	if math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n < -1 || n > 1<<31-1 || n == 0 {
		return 0, false, errors.New("regionID must be -1 (auto) or a positive integer")
	}
	return tailcfg.DERPRegionID(int64(n)), true, nil
}

func optLogf(v js.Value) logger.Logf {
	if v.Get("verbose").Truthy() {
		return log.Printf
	}
	return logger.Discard
}

// makePromise runs f on a new goroutine and returns a JavaScript
// Promise of its result, rejected with a JavaScript Error if f
// returns an error.
func makePromise(f func() (any, error)) js.Value {
	handler := js.FuncOf(func(this js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			if res, err := f(); err == nil {
				resolve.Invoke(res)
			} else {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
			}
		}()
		return nil
	})
	// The Promise constructor invokes its executor synchronously. Once New
	// returns, the executor itself is no longer reachable from JavaScript; the
	// goroutine above owns f until it resolves or rejects. Releasing here is
	// essential for streaming callers, which may create tens of thousands of
	// promises for one large file.
	promise := js.Global().Get("Promise").New(handler)
	handler.Release()
	return promise
}

func rejectedPromise(err error) js.Value {
	return js.Global().Get("Promise").Call("reject", js.Global().Get("Error").New(err.Error()))
}

func resolvedPromise(v any) js.Value {
	return js.Global().Get("Promise").Call("resolve", v)
}
