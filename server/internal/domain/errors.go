package domain

import (
	"errors"
	"fmt"
)

// Sentinel errors raised by the analysis pipeline. They are mapped to API
// envelopes by the HTTP layer (T12); business code may also wrap them with
// fmt.Errorf("...: %w", err) and check via errors.Is.
var (
	// ErrProjectNotFound — no Project with this ID is currently held in memory
	// or on disk (TTL may have expired).
	ErrProjectNotFound = errors.New("project not found")

	// ErrNoGraphYet — the project exists but /analyze has never produced a
	// graph for it.
	ErrNoGraphYet = errors.New("no graph yet")

	// ErrInvalidEntryPoint — a manually supplied entry-point FQN cannot be
	// resolved against the parsed packages.
	ErrInvalidEntryPoint = errors.New("invalid entry point")

	// ErrZipSlip — an archive entry tried to escape the destination directory
	// via "../" or an absolute path (ADR-08).
	ErrZipSlip = errors.New("zip slip detected")

	// ErrGoModMissing — neither the archive root nor the first sub-folder
	// contains a go.mod file.
	ErrGoModMissing = errors.New("go.mod missing")

	// ErrArchiveTooLarge — the uploaded archive exceeds the 50 MiB pre-unpack
	// limit (NFR-04).
	ErrArchiveTooLarge = errors.New("archive too large")

	// ErrFileCountExceeded — the archive contains more than 10 000 entries.
	ErrFileCountExceeded = errors.New("file count exceeded")

	// ErrUnpackedSizeExceeded — cumulative unpacked size crossed the 500 MiB
	// zip-bomb guard.
	ErrUnpackedSizeExceeded = errors.New("unpacked size exceeded")

	// ErrAnalysisInProgress — single-flight per project_id rejected a second
	// concurrent /analyze call (ADR-10).
	ErrAnalysisInProgress = errors.New("analysis in progress")
)

// APIError is the canonical structured error used across the HTTP boundary.
//
// Code is the stable machine-readable identifier (snake_case) listed in
// api-contract.md. Details may carry per-error context (package name,
// project_id, …). HTTPStatus is the response code; it is intentionally NOT
// serialised so that clients see only {code, message, details}.
type APIError struct {
	Code       string         `json:"code"`
	Message    string         `json:"message"`
	Details    map[string]any `json:"details,omitempty"`
	HTTPStatus int            `json:"-"`
}

// Error implements the error interface.
func (e *APIError) Error() string {
	if e == nil {
		return "<nil APIError>"
	}
	if e.Code == "" {
		return e.Message
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}
