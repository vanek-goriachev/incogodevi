package orchestrator

import (
	"net/http"
	"strings"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// validateEntryPointShape checks the parts of EntryPointSpec that do not
// require a parsed project: spec.Mode is one of the recognised values and
// every manual / interface_impl FQN parses cleanly. Semantic resolution is
// deferred to entry.Resolver inside the live pipeline so that errors there
// surface as SSE done:failed instead of a 4xx without a stream.
func validateEntryPointShape(spec domain.EntryPointSpec) error {
	if spec.Mode != "" && !spec.Mode.IsValid() {
		return invalidEntryPointAPI("unknown entry-point mode", map[string]any{
			"mode": string(spec.Mode),
		})
	}
	var malformed []string
	for _, raw := range spec.Manual {
		if !isWellFormedFQN(raw, false) {
			malformed = append(malformed, raw)
		}
	}
	for _, raw := range spec.InterfaceImpl {
		// interface_impl entries must reference a type, never a member.
		if !isWellFormedFQN(raw, true) {
			malformed = append(malformed, raw)
		}
	}
	if len(malformed) > 0 {
		return invalidEntryPointAPI("one or more entry points are malformed", map[string]any{
			"fqns": malformed,
		})
	}
	return nil
}

// isWellFormedFQN mirrors entry.parseManualFQN at the structural level. When
// rejectMember is true the FQN must point at a type, i.e. "<pkg>#<Type>"
// without the trailing ".<Member>" — interface_impl uses this form.
func isWellFormedFQN(raw string, rejectMember bool) bool {
	fqn := strings.TrimSpace(raw)
	if fqn == "" {
		return false
	}
	hash := strings.Index(fqn, "#")
	if hash <= 0 || hash == len(fqn)-1 {
		return false
	}
	right := fqn[hash+1:]
	dot := strings.Index(right, ".")
	if dot < 0 {
		return true
	}
	if rejectMember {
		return false
	}
	if dot == 0 || dot == len(right)-1 {
		return false
	}
	return true
}

// invalidEntryPointAPI returns the canonical 400 envelope for malformed
// preflight input. The HTTP layer (T15) reads it as *domain.APIError and
// responds with the documented invalid_entry_point code.
func invalidEntryPointAPI(message string, details map[string]any) error {
	return &invalidEntryPointError{
		APIError: &domain.APIError{
			Code:       "invalid_entry_point",
			Message:    message,
			Details:    details,
			HTTPStatus: http.StatusBadRequest,
		},
	}
}

// invalidEntryPointError mirrors entry.InvalidEntryPointError so the
// HTTP layer can use a single errors.Is(domain.ErrInvalidEntryPoint) check
// regardless of which package produced the failure.
type invalidEntryPointError struct {
	*domain.APIError
}

// Unwrap exposes both the embedded *APIError (so errors.As can lift it for
// the JSON envelope) and the domain.ErrInvalidEntryPoint sentinel (so
// errors.Is matches). The two-element slice form is the Go 1.20+ idiom for
// errors that aggregate multiple chains.
func (e *invalidEntryPointError) Unwrap() []error {
	return []error{e.APIError, domain.ErrInvalidEntryPoint}
}
