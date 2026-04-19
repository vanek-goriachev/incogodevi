package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// jsonContentType is the canonical Content-Type emitted by every JSON response
// (docs/api-contract.md §0).
const jsonContentType = "application/json; charset=utf-8"

// errorEnvelope wraps an APIError so the wire format matches the
// `{ "error": {...} }` shape required by the contract.
type errorEnvelope struct {
	Error *domain.APIError `json:"error"`
}

// writeJSON serialises v as JSON with the canonical Content-Type and status
// code. Encoding failures cannot be reported to the client at this point — the
// header has already been flushed — so they are merely logged.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", jsonContentType)
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		slog.Default().Error("encode response body", slog.String("error", err.Error()))
	}
}

// writeAPIError walks err looking for a *domain.APIError. If one is present,
// it is rendered as `{error:{...}}` with the carried HTTP status. Otherwise a
// generic 500 envelope is returned and the original error is logged so the
// client never receives implementation details.
func writeAPIError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		return
	}
	apiErr, ok := asAPIError(err)
	if !ok {
		slog.Default().Error("unwrapped error reached HTTP boundary",
			slog.String("error", err.Error()),
			slog.String("request_id", RequestIDFromContext(r.Context())),
		)
		apiErr = errInternal()
	}
	status := apiErr.HTTPStatus
	if status == 0 {
		status = http.StatusInternalServerError
	}
	writeJSON(w, status, errorEnvelope{Error: apiErr})
}

// asProjectIDOr404 parses raw into a domain.ProjectID. Any failure — empty
// string, wrong length, non-base64 alphabet — is collapsed to a 404
// project_not_found so callers cannot probe the cache surface for valid ids.
func asProjectIDOr404(raw string) (domain.ProjectID, error) {
	var id domain.ProjectID
	if err := id.UnmarshalText([]byte(raw)); err != nil {
		return "", errProjectNotFound(raw)
	}
	return id, nil
}

// isProjectNotFound reports whether err carries the cache-level
// ErrProjectNotFound sentinel.
func isProjectNotFound(err error) bool {
	return errors.Is(err, domain.ErrProjectNotFound)
}
