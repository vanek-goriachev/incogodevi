package orchestrator

import (
	"errors"
	"net/http"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// inProgressError is the concrete value returned by Run when single-flight
// rejects a second /analyze call. It satisfies both the *domain.APIError
// chain (so the HTTP layer can render the canonical envelope) and unwraps
// to domain.ErrAnalysisInProgress for errors.Is matching.
type inProgressError struct {
	*domain.APIError
}

// Unwrap returns domain.ErrAnalysisInProgress so callers can write
// errors.Is(err, domain.ErrAnalysisInProgress) without poking at the API
// envelope.
func (e *inProgressError) Unwrap() error { return domain.ErrAnalysisInProgress }

// ErrAnalysisInProgress is the singleton single-flight sentinel returned by
// Run. The HTTP layer (T15) maps it to a 409 + "analysis_in_progress"
// envelope by inspecting the embedded *domain.APIError.
var ErrAnalysisInProgress error = &inProgressError{
	APIError: &domain.APIError{
		Code:       "analysis_in_progress",
		Message:    "an analysis is already running for this project",
		HTTPStatus: http.StatusConflict,
	},
}

// IsAnalysisInProgress reports whether err is (or wraps) ErrAnalysisInProgress.
func IsAnalysisInProgress(err error) bool {
	return errors.Is(err, domain.ErrAnalysisInProgress) || errors.Is(err, ErrAnalysisInProgress)
}
