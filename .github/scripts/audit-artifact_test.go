// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

package main

import "testing"

func TestAuditRejectsTransportAndPrivateKeyMaterial(t *testing.T) {
	tests := []struct {
		name string
		data string
		want string
	}{
		{"Google STUN", `stun:stun.l.google.com:19302`, "Google STUN"},
		{"TURN", `ice=turn:relay.example:3478`, "TURN URL"},
		{"TURNS", `ice=turns:relay.example:5349`, "TURN URL"},
		{"private key", `"Private":"privkey:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"`, "private key"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			findings := audit([]byte(test.data))
			if len(findings) != 1 || findings[0] != test.want {
				t.Fatalf("audit finding = %v, want [%s]", findings, test.want)
			}
		})
	}
}

func TestAuditRejectsValidTailcatInvitationButNotIdentifiers(t *testing.T) {
	// This is the public, non-secret example address in Tailcat v0.4.0's
	// README. Prefix and suffix text model linker string concatenation.
	const publicExample = "tcomFwWCCcjS5nKNqAod034nWoJZW0LZqDhhC8U_dKdnDRYQ8uNGFpGQEu"
	if findings := audit([]byte("prefix" + publicExample + "suffix")); len(findings) != 1 || findings[0] != "Tailcat invitation" {
		t.Fatalf("valid invitation finding = %v", findings)
	}
	for _, safe := range []string{
		"return: value",
		"tcacheStateneighstatsqDiscOwnerNICIDtupleStackprotodemuxflags",
		"TCPPortsInterceptedFromNetmapAndPrefsLocked-range1",
		"stun:stun.cloudflare.com:3478",
	} {
		if findings := audit([]byte(safe)); len(findings) != 0 {
			t.Fatalf("safe input %q finding = %v", safe, findings)
		}
	}
}
