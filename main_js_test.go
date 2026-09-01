// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"errors"
	"io"
	"net"
	"syscall/js"
	"testing"
	"time"
)

func TestIncrementalSHA256(t *testing.T) {
	h := js.ValueOf(tailcatNewSHA256(js.Undefined(), nil))
	chunk := js.Global().Get("Uint8Array").New(3)
	if copied := js.CopyBytesToJS(chunk, []byte("abc")); copied != 3 {
		t.Fatalf("CopyBytesToJS copied %d bytes, want 3", copied)
	}
	if _, err := awaitPromise(h.Get("update").Invoke(chunk)); err != nil {
		t.Fatalf("update: %v", err)
	}

	const want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	got, err := awaitPromise(h.Get("digestHex").Invoke())
	if err != nil {
		t.Fatalf("digestHex: %v", err)
	}
	if got.String() != want {
		t.Fatalf("digestHex = %q, want %q", got.String(), want)
	}
	got, err = awaitPromise(h.Get("digestHex").Invoke())
	if err != nil || got.String() != want {
		t.Fatalf("second digestHex = %q, %v; want %q, nil", got.String(), err, want)
	}
	if _, err := awaitPromise(h.Get("update").Invoke(chunk)); err == nil {
		t.Fatal("update after digestHex succeeded, want rejection")
	}

	h.Get("close").Invoke()
}

func TestOptRegionID(t *testing.T) {
	obj := js.Global().Get("Object").New()
	if _, ok, err := optRegionID(obj); err != nil || ok {
		t.Fatalf("absent regionID = ok %v, err %v; want false, nil", ok, err)
	}
	obj.Set("regionID", -1)
	if id, ok, err := optRegionID(obj); err != nil || !ok || id != -1 {
		t.Fatalf("auto regionID = %v, %v, %v; want -1, true, nil", id, ok, err)
	}
	obj.Set("regionID", 303)
	if id, ok, err := optRegionID(obj); err != nil || !ok || id != 303 {
		t.Fatalf("fixed regionID = %v, %v, %v; want 303, true, nil", id, ok, err)
	}
	for _, bad := range []any{0, -2, 1.5, "tok"} {
		obj.Set("regionID", bad)
		if _, _, err := optRegionID(obj); err == nil {
			t.Errorf("regionID %v accepted, want error", bad)
		}
	}
}

func TestJSConnWritesAllAndClosesIdempotently(t *testing.T) {
	c := &shortWriteConn{}
	closedCallbacks := 0
	wrapped := makeJSConn(c, 102, func() { closedCallbacks++ })
	payload := js.Global().Get("Uint8Array").New(7)
	if copied := js.CopyBytesToJS(payload, []byte("stream!")); copied != 7 {
		t.Fatalf("CopyBytesToJS copied %d bytes, want 7", copied)
	}
	if _, err := awaitPromise(wrapped.Get("write").Invoke(payload)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := string(c.written); got != "stream!" {
		t.Fatalf("written bytes = %q, want %q", got, "stream!")
	}
	if _, err := awaitPromise(wrapped.Get("closeWrite").Invoke()); err != nil {
		t.Fatalf("closeWrite: %v", err)
	}
	if !c.writeClosed {
		t.Fatal("CloseWrite was not called")
	}
	wrapped.Get("close").Invoke()
	wrapped.Get("close").Invoke()
	if !c.closed || closedCallbacks != 1 {
		t.Fatalf("closed = %v, callbacks = %d; want true, 1", c.closed, closedCallbacks)
	}
}

type shortWriteConn struct {
	written     []byte
	closed      bool
	writeClosed bool
}

func (c *shortWriteConn) Read([]byte) (int, error) { return 0, io.EOF }
func (c *shortWriteConn) Write(p []byte) (int, error) {
	if c.closed {
		return 0, net.ErrClosed
	}
	n := min(2, len(p))
	c.written = append(c.written, p[:n]...)
	return n, nil
}
func (c *shortWriteConn) CloseWrite() error                { c.writeClosed = true; return nil }
func (c *shortWriteConn) Close() error                     { c.closed = true; return nil }
func (c *shortWriteConn) LocalAddr() net.Addr              { return testAddr("local") }
func (c *shortWriteConn) RemoteAddr() net.Addr             { return testAddr("remote") }
func (c *shortWriteConn) SetDeadline(time.Time) error      { return nil }
func (c *shortWriteConn) SetReadDeadline(time.Time) error  { return nil }
func (c *shortWriteConn) SetWriteDeadline(time.Time) error { return nil }

type testAddr string

func (a testAddr) Network() string { return "test" }
func (a testAddr) String() string  { return string(a) }

func awaitPromise(p js.Value) (js.Value, error) {
	type result struct {
		value js.Value
		err   error
	}
	done := make(chan result, 1)
	onResolve := js.FuncOf(func(this js.Value, args []js.Value) any {
		var value js.Value
		if len(args) > 0 {
			value = args[0]
		}
		done <- result{value: value}
		return nil
	})
	onReject := js.FuncOf(func(this js.Value, args []js.Value) any {
		message := "promise rejected"
		if len(args) > 0 {
			if m := args[0].Get("message"); m.Type() == js.TypeString {
				message = m.String()
			}
		}
		done <- result{err: errors.New(message)}
		return nil
	})
	defer onResolve.Release()
	defer onReject.Release()
	p.Call("then", onResolve, onReject)
	r := <-done
	return r.value, r.err
}
