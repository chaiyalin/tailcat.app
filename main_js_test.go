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

	"github.com/tailscale/tailcat"
)

// These disposable fixture keys and address were generated and serialized with
// github.com/tailscale/tailcat v0.4.0. Keeping the literal old bytes means this
// test catches a wire-format change rather than comparing v0.7 with itself.
const v04ListenerKeyJSON = `{"Private":"privkey:088e75f612f5ce459a0a7af66830eedae601a59951ba5af0376d4367079b817e","Public":{"ServerPublic":"nodekey:d4432ec8ba9baa857e26790c68ad5da9b7b195b3bf6e34352d91d64e14915f79","ServerDiscoPublic":"discokey:93a09eea6a18b02094c7e0ba9ea3b648f35738bf4e3f24d10a7443a914635175","RegionID":304}}`
const v04ListenerAddr = "tco2FwWCDUQy7IupuqhX4meQxorV2pt7GVs79uNDUtkdZOFJFfeWFrWCCToJ7qahiwIJTH4Lqeo7ZI81c4v04_JNEKdEOpFGNRdWFpGQEw"

func TestBrowserListenerNewKeyRetainsNoPSKFormat(t *testing.T) {
	pk, err := browserListenerKey("")
	if err != nil {
		t.Fatalf("new listener key: %v", err)
	}
	if !pk.Public.PresharedKey.IsZero() {
		t.Fatal("new compatible browser listener includes a PSK")
	}
	if pk.Private.IsZero() || pk.Public.ServerPublic.NodePublic != pk.Private.Public() || pk.Public.ServerDiscoPublic.IsZero() {
		t.Fatal("new listener lost its node or independent discovery identity")
	}
	if pk.Public.RegionID != -1 || len(pk.Public.Region) != 0 {
		t.Fatal("new listener did not retain automatic region selection")
	}
	pk.Public.RegionID = 304
	ci, err := tailcat.ParseAddr(pk.Public.Addr())
	if err != nil || !ci.PresharedKey.IsZero() {
		t.Fatalf("new address does not round-trip without a PSK: %v", err)
	}
	if !ci.ServerPublic.Equal(pk.Public.ServerPublic) || !ci.ServerDiscoPublic.Equal(pk.Public.ServerDiscoPublic) {
		t.Fatal("new listener address changed node or discovery identity")
	}
}

func TestBrowserListenerRestoresV04IdentityAndAddressBytes(t *testing.T) {
	pk, err := browserListenerKey(v04ListenerKeyJSON)
	if err != nil {
		t.Fatalf("restore v0.4 key: %v", err)
	}
	if !pk.Public.PresharedKey.IsZero() {
		t.Fatal("restoring a v0.4 key introduced a PSK")
	}
	if got := string(pk.Public.Addr()); got != v04ListenerAddr {
		t.Fatal("restoring a v0.4 key changed the existing address bytes")
	}
	private, err := pk.Private.MarshalText()
	if err != nil || string(private) != "privkey:088e75f612f5ce459a0a7af66830eedae601a59951ba5af0376d4367079b817e" {
		t.Fatal("restoring a v0.4 key changed the private node identity")
	}
	if pk.Public.ServerPublic.NodePublic != pk.Private.Public() {
		t.Fatal("restored node identity does not match its address")
	}
	if !pk.Public.ServerDiscoPublic.Equal(tailcat.DiscoPublicForNode(pk.Private)) {
		t.Fatal("restored discovery identity does not match the server's derived key")
	}
	encoded, err := json.Marshal(pk)
	if err != nil {
		t.Fatalf("serialize restored key: %v", err)
	}
	back, err := browserListenerKey(string(encoded))
	if err != nil || !back.Private.Equal(pk.Private) || string(back.Public.Addr()) != v04ListenerAddr {
		t.Fatalf("persisting and reopening changed the v0.4 identity or address: %v", err)
	}
}

func TestBrowserListenerRejectsExistingPSKWithoutDowngrade(t *testing.T) {
	pk := tailcat.NewPrivateKey()
	if pk.Public.PresharedKey.IsZero() {
		t.Fatal("v0.7 fixture did not generate the expected PSK")
	}
	encoded, err := json.Marshal(pk)
	if err != nil {
		t.Fatalf("serialize PSK fixture: %v", err)
	}
	restored, err := browserListenerKey(string(encoded))
	if restored != nil || err == nil || !strings.Contains(err.Error(), "PSK listener keys are not supported") {
		t.Fatal("PSK key was not explicitly rejected before listener construction")
	}
	secret, _ := pk.Public.PresharedKey.MarshalText()
	if strings.Contains(err.Error(), string(secret)) {
		t.Fatal("PSK rejection exposed the secret")
	}
	if pk.Public.PresharedKey.IsZero() {
		t.Fatal("PSK rejection modified the supplied fixture")
	}
	if restored, err := browserListenerKey("not-json"); restored != nil || err == nil || !strings.Contains(err.Error(), "parsing privateKey") {
		t.Fatal("invalid persisted key was not rejected before listener construction")
	}
}

func TestPrivateKeyDecodeDoesNotExposeMalformedPSK(t *testing.T) {
	const secret = "psk:malformed-secret-fixture-only"
	encoded := strings.Replace(v04ListenerKeyJSON, `"RegionID":304`, `"PresharedKey":"`+secret+`","RegionID":304`, 1)
	const want = "parsing privateKey: invalid JSON or key encoding"
	for _, parse := range []struct {
		name string
		call func(string) (*tailcat.PrivateKey, error)
	}{{"decoder", decodeBrowserPrivateKey}, {"listener key", browserListenerKey}} {
		t.Run(parse.name, func(t *testing.T) {
			pk, err := parse.call(encoded)
			if pk != nil || err == nil || err.Error() != want || strings.Contains(err.Error(), secret) {
				t.Fatal("malformed private key did not produce a fixed, secret-free error")
			}
		})
	}
	onConnection := js.FuncOf(func(js.Value, []js.Value) any { return nil })
	defer onConnection.Release()
	for _, connect := range []struct {
		name string
		call func(js.Value, []js.Value) any
	}{{"listener", tailcatListen}, {"persistent client", tailcatConnect}, {"single dial", tailcatDial}} {
		t.Run(connect.name, func(t *testing.T) {
			opts := js.Global().Get("Object").New()
			opts.Set("addr", v04ListenerAddr)
			opts.Set("derpMapURL", "https://example.invalid/derpmap.json")
			opts.Set("privateKey", encoded)
			opts.Set("onConnection", onConnection)
			promise := connect.call(js.Undefined(), []js.Value{opts}).(js.Value)
			if _, err := awaitPromise(promise); err == nil || !strings.Contains(err.Error(), want) || strings.Contains(err.Error(), secret) {
				t.Fatal("bridge exposed malformed private-key input or did not reject before networking")
			}
		})
	}
}

func TestReleaseVersionSourcesAgree(t *testing.T) {
	const expected = "0.3.1-beta.1"
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
