package domain

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"regexp"
)

// ProjectID is a URL-safe identifier assigned to every uploaded project.
//
// Format: 22 characters from the URL-safe base64 alphabet (A-Z, a-z, 0-9, '-',
// '_'), generated from 16 random bytes without padding. See
// docs/api-contract.md §0.
type ProjectID string

// projectIDPattern matches a syntactically valid ProjectID.
var projectIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

// NewProjectID returns a fresh, cryptographically random ProjectID.
//
// It draws 16 bytes from crypto/rand and encodes them with the URL-safe
// base64 alphabet without padding, yielding exactly 22 characters.
func NewProjectID() ProjectID {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand on supported platforms only fails when the OS entropy
		// source is fundamentally broken; treat that as fatal.
		panic(fmt.Errorf("domain: read random bytes for ProjectID: %w", err))
	}
	return ProjectID(base64.RawURLEncoding.EncodeToString(buf[:]))
}

// IsValid reports whether p has the expected 22-character URL-safe shape.
func (p ProjectID) IsValid() bool {
	return projectIDPattern.MatchString(string(p))
}

// String implements fmt.Stringer.
func (p ProjectID) String() string { return string(p) }

// MarshalText implements encoding.TextMarshaler so ProjectID round-trips
// cleanly through JSON, gob and other encoders that prefer textual forms.
func (p ProjectID) MarshalText() ([]byte, error) {
	if !p.IsValid() {
		return nil, fmt.Errorf("domain: invalid ProjectID %q", string(p))
	}
	return []byte(p), nil
}

// UnmarshalText implements encoding.TextUnmarshaler. It rejects any input that
// does not match the canonical 22-character URL-safe base64 shape.
func (p *ProjectID) UnmarshalText(data []byte) error {
	candidate := string(data)
	if !projectIDPattern.MatchString(candidate) {
		return fmt.Errorf("domain: invalid ProjectID %q", candidate)
	}
	*p = ProjectID(candidate)
	return nil
}
