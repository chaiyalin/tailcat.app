// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"slices"
	"strings"
	"syscall/js"
	"testing"
	"time"
)

func TestReleaseVersionSourcesAgree(t *testing.T) {
	const expected = "0.4.0-beta.1"
	type manifest struct {
		Version  string              `json:"version"`
		Packages map[string]manifest `json:"packages"`
	}

	read := func(name string) []byte {
		t.Helper()
		contents, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		return contents
	}
	decode := func(name string) manifest {
		t.Helper()
		var value manifest
		if err := json.Unmarshal(read(name), &value); err != nil {
			t.Fatalf("decode %s: %v", name, err)
		}
		return value
	}

	packageJSON := decode("package.json")
	packageLock := decode("package-lock.json")
	versions := map[string]string{
		"package.json":              packageJSON.Version,
		"package-lock.json":         packageLock.Version,
		"package-lock root package": packageLock.Packages[""].Version,
	}
	for source, version := range versions {
		if version != expected {
			t.Errorf("%s version = %q; want %q", source, version, expected)
		}
	}
	config := string(read("web/config.js"))
	if !strings.Contains(config, `version: "`+expected+`"`) {
		t.Errorf("web/config.js does not expose %q", expected)
	}
	readme := string(read("README.md"))
	if !strings.Contains(readme, "Release target `"+expected+"`") {
		t.Errorf("README.md does not declare release target %q", expected)
	}
	if !strings.Contains(readme, "tag `app-v"+expected+"`") {
		t.Errorf("README.md does not declare tag app-v%s", expected)
	}
}

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

func TestSHA256CloseUsesNativeShimsAcrossCycles(t *testing.T) {
	const cycles = 64
	chunk := js.Global().Get("Uint8Array").New(3)
	if copied := js.CopyBytesToJS(chunk, []byte("abc")); copied != 3 {
		t.Fatalf("CopyBytesToJS copied %d bytes, want 3", copied)
	}

	for cycle := 0; cycle < cycles; cycle++ {
		h := js.ValueOf(tailcatNewSHA256(js.Undefined(), nil))
		if _, err := awaitPromise(h.Get("update").Invoke(chunk)); err != nil {
			t.Fatalf("cycle %d update: %v", cycle, err)
		}
		h.Get("close").Invoke()

		if !h.Get("close").Equal(js.Global().Get("Boolean")) {
			t.Fatalf("cycle %d close did not become the native idempotent shim", cycle)
		}
		if got := h.Get("close").Invoke(); got.Type() != js.TypeBoolean || got.Bool() {
			t.Fatalf("cycle %d second close = %v; want false from Boolean()", cycle, got)
		}
		for _, method := range []string{"update", "digestHex"} {
			var promise js.Value
			if method == "update" {
				promise = h.Get(method).Invoke(chunk)
			} else {
				promise = h.Get(method).Invoke()
			}
			if _, err := awaitPromise(promise); err == nil || !strings.Contains(err.Error(), "closed") {
				t.Fatalf("cycle %d %s after close error = %v; want closed rejection", cycle, method, err)
			}
		}
	}
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

func TestJSConnReadHonorsOptionalMaximum(t *testing.T) {
	c := &limitedReadConn{data: []byte("abcdefgh")}
	wrapped := makeJSConn(c, 104, nil)
	read := func(args ...any) (js.Value, error) {
		t.Helper()
		return awaitPromise(wrapped.Get("read").Invoke(args...))
	}
	bytesFromJS := func(value js.Value) string {
		t.Helper()
		if !value.InstanceOf(js.Global().Get("Uint8Array")) {
			t.Fatalf("read value type = %v; want Uint8Array", value.Type())
		}
		got := make([]byte, value.Get("byteLength").Int())
		if copied := js.CopyBytesToGo(got, value); copied != len(got) {
			t.Fatalf("CopyBytesToGo copied %d bytes, want %d", copied, len(got))
		}
		return string(got)
	}

	first, err := read(3)
	if err != nil {
		t.Fatalf("read(3): %v", err)
	}
	if got := bytesFromJS(first); got != "abc" {
		t.Fatalf("read(3) = %q, want %q", got, "abc")
	}
	second, err := read()
	if err != nil {
		t.Fatalf("read(): %v", err)
	}
	if got := bytesFromJS(second); got != "defgh" {
		t.Fatalf("read() = %q, want %q", got, "defgh")
	}
	eof, err := read(js.Undefined())
	if err != nil {
		t.Fatalf("read(undefined): %v", err)
	}
	if eof.Type() != js.TypeNull {
		t.Fatalf("read at EOF = %v, want null", eof)
	}
	if got, want := c.readBufferSizes, []int{3, 64 << 10, 64 << 10}; !slices.Equal(got, want) {
		t.Fatalf("read buffer sizes = %v, want %v", got, want)
	}

	for _, bad := range []any{0, -1, 1.5, (64 << 10) + 1, "3", js.Null()} {
		if _, err := read(bad); err == nil || !strings.Contains(err.Error(), "read maximum") {
			t.Errorf("read(%v) error = %v; want maximum validation rejection", bad, err)
		}
	}
	if _, err := read(1, 2); err == nil || !strings.Contains(err.Error(), "at most one") {
		t.Errorf("read(1, 2) error = %v; want arity rejection", err)
	}
	wrapped.Get("close").Invoke()
}

func TestJSConnCloseUsesNativeShimsAcrossCycles(t *testing.T) {
	const cycles = 64
	payload := js.Global().Get("Uint8Array").New(1)
	if copied := js.CopyBytesToJS(payload, []byte{0x5a}); copied != 1 {
		t.Fatalf("CopyBytesToJS copied %d bytes, want 1", copied)
	}

	for cycle := 0; cycle < cycles; cycle++ {
		connection := &shortWriteConn{}
		closedCallbacks := 0
		wrapped := makeJSConn(connection, 104, func() { closedCallbacks++ })
		wrapped.Get("close").Invoke()

		if !connection.closed || closedCallbacks != 1 {
			t.Fatalf("cycle %d closed = %v, callbacks = %d; want true, 1", cycle, connection.closed, closedCallbacks)
		}
		if !wrapped.Get("close").Equal(js.Global().Get("Boolean")) {
			t.Fatalf("cycle %d close did not become the native idempotent shim", cycle)
		}
		if got := wrapped.Get("close").Invoke(); got.Type() != js.TypeBoolean || got.Bool() {
			t.Fatalf("cycle %d second close = %v; want false from Boolean()", cycle, got)
		}

		operations := []struct {
			name    string
			promise js.Value
		}{
			{name: "read", promise: wrapped.Get("read").Invoke()},
			{name: "write", promise: wrapped.Get("write").Invoke(payload)},
			{name: "closeWrite", promise: wrapped.Get("closeWrite").Invoke()},
		}
		for _, operation := range operations {
			if _, err := awaitPromise(operation.promise); err == nil || !strings.Contains(err.Error(), "closed") {
				t.Fatalf("cycle %d %s after close error = %v; want closed rejection", cycle, operation.name, err)
			}
		}
	}
}

type shortWriteConn struct {
	written     []byte
	closed      bool
	writeClosed bool
}

type limitedReadConn struct {
	shortWriteConn
	data            []byte
	readBufferSizes []int
}

func (c *limitedReadConn) Read(p []byte) (int, error) {
	c.readBufferSizes = append(c.readBufferSizes, len(p))
	if len(c.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p, c.data)
	c.data = c.data[n:]
	return n, nil
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
