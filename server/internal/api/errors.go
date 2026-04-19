package api

import (
	"errors"
	"net/http"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// Stable error codes used across the HTTP boundary. Mirrors
// docs/api-contract.md.
const (
	codeProjectNotFound    = "project_not_found"
	codeNotImplemented     = "not_implemented"
	codeInternal           = "internal"
	codeArchiveTooLarge    = "archive_too_large"
	codeForbiddenOrigin    = "forbidden_origin"
	codeMethodNotAllowed   = "method_not_allowed"
	codeAnalysisInProgress = "analysis_in_progress"
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

// asAPIError unwraps err to a *domain.APIError if possible. The boolean is
// false when err carries no APIError on its chain.
func asAPIError(err error) (*domain.APIError, bool) {
	var apiErr *domain.APIError
	if errors.As(err, &apiErr) && apiErr != nil {
		return apiErr, true
	}
	return nil, false
}
