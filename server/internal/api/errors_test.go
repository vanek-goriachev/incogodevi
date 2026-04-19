package api

import (
	"errors"
	"net/http"
	"testing"
)

func TestErrorBuilders(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name       string
		err        error
		wantCode   string
		wantStatus int
	}{
		{"project_not_found", errProjectNotFound("xyz"), codeProjectNotFound, http.StatusNotFound},
		{"not_implemented", errNotImplemented("h", "T99"), codeNotImplemented, http.StatusNotImplemented},
		{"internal", errInternal(), codeInternal, http.StatusInternalServerError},
		{"archive_too_large", errArchiveTooLarge(123), codeArchiveTooLarge, http.StatusRequestEntityTooLarge},
		{"forbidden_origin", errForbiddenOrigin("https://x"), codeForbiddenOrigin, http.StatusForbidden},
		{"method_not_allowed", errMethodNotAllowed("PATCH"), codeMethodNotAllowed, http.StatusMethodNotAllowed},
		{"no_graph_yet", errNoGraphYet("xyz"), codeNoGraphYet, http.StatusNotFound},
		{"stale_cache", errStaleCache("xyz"), codeStaleCache, http.StatusServiceUnavailable},
		{"invalid_scope", errInvalidScope("foo", []string{"a", "b"}), codeInvalidScope, http.StatusBadRequest},
		{"invalid_format", errInvalidFormat("xml"), codeInvalidFormat, http.StatusBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			apiErr, ok := asAPIError(c.err)
			if !ok {
				t.Fatalf("expected APIError, got %T", c.err)
			}
			if apiErr.Code != c.wantCode {
				t.Errorf("code: got %q, want %q", apiErr.Code, c.wantCode)
			}
			if apiErr.HTTPStatus != c.wantStatus {
				t.Errorf("status: got %d, want %d", apiErr.HTTPStatus, c.wantStatus)
			}
			if apiErr.Message == "" {
				t.Errorf("message must not be empty")
			}
		})
	}
}

func TestAsAPIError_NilCases(t *testing.T) {
	t.Parallel()

	if _, ok := asAPIError(nil); ok {
		t.Errorf("nil should not match")
	}
	if _, ok := asAPIError(errors.New("plain")); ok {
		t.Errorf("plain error should not match")
	}
}
