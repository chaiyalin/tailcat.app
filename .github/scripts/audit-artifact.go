// Copyright (c) tailcat.app contributors
// SPDX-License-Identifier: BSD-3-Clause

// audit-artifact rejects transport defaults and credential material that must
// never be embedded in a published Pages artifact. It deliberately reports
// only the category and file, never the matching bytes.
package main

import (
	"bytes"
	"fmt"
	"os"
	"regexp"

	"github.com/tailscale/tailcat"
)

var (
	googleSTUNPattern = regexp.MustCompile(`(?i)stun:[^\s"']*google\.`)
	turnURLPattern    = regexp.MustCompile(`(?i)(^|[^a-z])turns?:[^\s"']+`)
	privateKeyPattern = regexp.MustCompile(`(?i)privkey:[0-9a-f]{64}`)
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: audit-artifact FILE...")
		os.Exit(2)
	}
	failed := false
	for _, name := range os.Args[1:] {
		data, err := os.ReadFile(name)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: unable to read artifact\n", name)
			failed = true
			continue
		}
		for _, finding := range audit(data) {
			fmt.Fprintf(os.Stderr, "%s: forbidden %s material\n", name, finding)
			failed = true
		}
	}
	if failed {
		os.Exit(1)
	}
}

func audit(data []byte) []string {
	var findings []string
	if googleSTUNPattern.Match(data) {
		findings = append(findings, "Google STUN")
	}
	if turnURLPattern.Match(data) {
		findings = append(findings, "TURN URL")
	}
	if privateKeyPattern.Match(data) {
		findings = append(findings, "private key")
	}
	if containsConnBlob(data) {
		findings = append(findings, "Tailcat invitation")
	}
	return findings
}

func containsConnBlob(data []byte) bool {
	for offset := 0; offset+2 < len(data); {
		relative := bytes.Index(data[offset:], []byte("tc"))
		if relative < 0 {
			return false
		}
		start := offset + relative
		end := start + 2
		for end < len(data) && isBase64URL(data[end]) && end-start <= 4096 {
			end++
		}
		// Real compact addresses are longer than 32 bytes, but checking every
		// possible prefix also detects one concatenated with adjacent linker
		// string data without mistaking long identifiers beginning with "tc".
		for candidateEnd := start + 34; candidateEnd <= end; candidateEnd++ {
			candidate := tailcat.ConnBlob(string(data[start:candidateEnd]))
			if _, err := tailcat.ParseConnBlob(candidate); err == nil {
				return true
			}
		}
		offset = start + 2
	}
	return false
}

func isBase64URL(value byte) bool {
	return value >= 'a' && value <= 'z' ||
		value >= 'A' && value <= 'Z' ||
		value >= '0' && value <= '9' ||
		value == '-' || value == '_'
}
