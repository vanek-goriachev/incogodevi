package api

import (
	"errors"
	"net/http"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// Stable error codes used across the HTTP boundary. Mirrors
// docs/api-contract.md.
const (
	codeProjectNotFound      = "project_not_found"
	codeNotImplemented       = "not_implemented"
	codeInternal             = "internal"
	codeArchiveTooLarge      = "archive_too_large"
	codeForbiddenOrigin      = "forbidden_origin"
	codeMethodNotAllowed     = "method_not_allowed"
	codeAnalysisInProgress   = "analysis_in_progress"
	codeInvalidZip           = "invalid_zip"
	codeZipSlipDetected      = "zip_slip_detected"
	codeGoModMissing         = "go_mod_missing"
	codeFileCountExceeded    = "file_count_exceeded"
	codeUnpackedSizeExceeded = "unpacked_size_exceeded"
	codeInvalidFilters       = "invalid_filters"
	codeInvalidBody          = "invalid_body"
	codeBodyTooLarge         = "body_too_large"
)

// errProjectNotFound builds the canonical APIError for an unknown / expired
// project id. Details intentionally omit reasons (invalid format vs. missing)
// so callers cannot probe the cache surface.
func errProjectNotFound(id string) *domain.APIError {
	return &domain.APIError{
		Code:       codeProjectNotFound,
		Message:    "project not found or expired",
		Details:    map[string]any{"project_id": id},
		HTTPStatus: http.StatusNotFound,
	}
}

// errNotImplemented is returned by handlers whose real implementation lives
// in a later task. The message names the task so reviewers and operators can
// trace placeholders quickly.
func errNotImplemented(handlerName, ownerTask string) *domain.APIError {
	return &domain.APIError{
		Code:       codeNotImplemented,
		Message:    handlerName + " not implemented yet",
		Details:    map[string]any{"owner_task": ownerTask},
		HTTPStatus: http.StatusNotImplemented,
	}
}

// errInternal is the catch-all error used by the panic recoverer. The message
// is intentionally generic — diagnostic detail goes to slog, not to clients.
func errInternal() *domain.APIError {
	return &domain.APIError{
		Code:       codeInternal,
		Message:    "internal error",
		HTTPStatus: http.StatusInternalServerError,
	}
}

// errArchiveTooLarge is reported when the request body exceeds the per-route
// MaxBytesReader limit (NFR-04 / NFR-14).
func errArchiveTooLarge(limitBytes int64) *domain.APIError {
	return &domain.APIError{
		Code:       codeArchiveTooLarge,
		Message:    "request body exceeds the configured limit",
		Details:    map[string]any{"limit_bytes": limitBytes},
		HTTPStatus: http.StatusRequestEntityTooLarge,
	}
}

// errForbiddenOrigin is the response for cross-origin requests. The local-use
// CORS policy only accepts requests from the server's own origin.
func errForbiddenOrigin(origin string) *domain.APIError {
	return &domain.APIError{
		Code:       codeForbiddenOrigin,
		Message:    "cross-origin request is not allowed",
		Details:    map[string]any{"origin": origin},
		HTTPStatus: http.StatusForbidden,
	}
}

// errMethodNotAllowed is emitted by the explicit 405 fallback used on routes
// that share a path across multiple methods.
func errMethodNotAllowed(method string) *domain.APIError {
	return &domain.APIError{
		Code:       codeMethodNotAllowed,
		Message:    "method not allowed",
		Details:    map[string]any{"method": method},
		HTTPStatus: http.StatusMethodNotAllowed,
	}
}

// errInvalidZip covers every "the body is not a usable archive" condition that
// the upload handler can hit: missing form field, broken multipart, broken
// zip header, missing Content-Length, etc. The message accepts a free-form
// reason so log scanners can distinguish them while clients still see a single
// stable code.
func errInvalidZip(reason string) *domain.APIError {
	return &domain.APIError{
		Code:       codeInvalidZip,
		Message:    reason,
		HTTPStatus: http.StatusBadRequest,
	}
}

// errZipSlipDetected reports a path-traversal entry in the uploaded archive.
// The offending entry name is intentionally NOT echoed to avoid acting as a
// reflected XSS vector when the response is displayed in a browser.
func errZipSlipDetected() *domain.APIError {
	return &domain.APIError{
		Code:       codeZipSlipDetected,
		Message:    "archive contains path-traversal entries",
		HTTPStatus: http.StatusBadRequest,
	}
}

// errGoModMissing matches FR-01 acceptance: "valid Go module not found".
func errGoModMissing() *domain.APIError {
	return &domain.APIError{
		Code:       codeGoModMissing,
		Message:    "valid Go module not found",
		HTTPStatus: http.StatusBadRequest,
	}
}

// errFileCountExceeded surfaces the loader-level file budget overrun
// (NFR-04 / NFR-14) as the documented 422 envelope.
func errFileCountExceeded(limit int) *domain.APIError {
	return &domain.APIError{
		Code:       codeFileCountExceeded,
		Message:    "archive exceeds the file-count limit",
		Details:    map[string]any{"limit": limit},
		HTTPStatus: http.StatusUnprocessableEntity,
	}
}

// errUnpackedSizeExceeded surfaces the cumulative-size guard.
func errUnpackedSizeExceeded(limitBytes int64) *domain.APIError {
	return &domain.APIError{
		Code:       codeUnpackedSizeExceeded,
		Message:    "archive exceeds the unpacked-size limit",
		Details:    map[string]any{"limit_bytes": limitBytes},
		HTTPStatus: http.StatusUnprocessableEntity,
	}
}

// errAnalysisInProgress mirrors api-contract.md §2's 409 envelope. The handler
// uses it when single-flight rejects a second concurrent /analyze call.
func errAnalysisInProgress(projectID string) *domain.APIError {
	return &domain.APIError{
		Code:       codeAnalysisInProgress,
		Message:    "an analysis is already running for this project",
		Details:    map[string]any{"project_id": projectID},
		HTTPStatus: http.StatusConflict,
	}
}

// errInvalidFilters reports an unknown NodeKind in the include_kinds slice.
// The bad values are echoed in details so the caller can fix their request.
func errInvalidFilters(badKinds []string) *domain.APIError {
	return &domain.APIError{
		Code:       codeInvalidFilters,
		Message:    "include_kinds contains values that are not recognised NodeKinds",
		Details:    map[string]any{"invalid_kinds": badKinds},
		HTTPStatus: http.StatusBadRequest,
	}
}

// errInvalidBody covers JSON decoding failures on /analyze: malformed JSON,
// unknown fields, trailing garbage. We surface a free-form reason so log
// scanners can distinguish them while clients still see a stable code.
func errInvalidBody(reason string) *domain.APIError {
	return &domain.APIError{
		Code:       codeInvalidBody,
		Message:    reason,
		HTTPStatus: http.StatusBadRequest,
	}
}

// errAnalyzeBodyTooLarge mirrors errArchiveTooLarge but uses a dedicated code
// so /analyze and /api/projects can share the same MaxBytes plumbing without
// confusing operators about which limit was tripped.
func errAnalyzeBodyTooLarge(limitBytes int64) *domain.APIError {
	return &domain.APIError{
		Code:       codeBodyTooLarge,
		Message:    "request body exceeds the per-route limit",
		Details:    map[string]any{"limit_bytes": limitBytes},
		HTTPStatus: http.StatusRequestEntityTooLarge,
	}
}

// asAPIError unwraps err to a *domain.APIError if possible. The boolean is
// false when err carries no APIError on its chain.
func asAPIError(err error) (*domain.APIError, bool) {
	var apiErr *domain.APIError
	if errors.As(err, &apiErr) && apiErr != nil {
		return apiErr, true
	}
	return nil, false
}
