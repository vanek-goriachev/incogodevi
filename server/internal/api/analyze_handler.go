package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// MaxAnalyzeBodyBytes caps the JSON config body sent to /analyze (T15 spec).
// 1 MiB is far above the largest plausible payload (manual entry points list)
// and well below anything that would put memory pressure on the server.
const MaxAnalyzeBodyBytes int64 = 1 << 20

// Analyzer is the seam over orchestrator.Orchestrator used by the HTTP layer.
//
// The interface deliberately keeps the SSE streamer concrete (*SSEStreamer is
// owned by api/sse.go, which the orchestrator already imports) so the
// orchestrator package does not need a parallel abstraction. The handler uses
// Reserve + RunReserved to translate single-flight rejection into a 409 JSON
// envelope before any SSE headers leak to the wire.
type Analyzer interface {
	Reserve(id domain.ProjectID) (release func(), ok bool)
	PreflightValidate(spec domain.EntryPointSpec, filters domain.Filters) error
	RunReserved(
		ctx context.Context,
		id domain.ProjectID,
		spec domain.EntryPointSpec,
		filters domain.Filters,
		stream *SSEStreamer,
	) error
}

// analyzeRequest mirrors the JSON body documented in api-contract.md §2.
// Both fields are pointers so the handler can distinguish "field omitted" from
// "field present with zero value" and apply the documented defaults only when
// the caller did not supply anything.
type analyzeRequest struct {
	EntryPoints *domain.EntryPointSpec `json:"entry_points,omitempty"`
	Filters     *domain.Filters        `json:"filters,omitempty"`
}

// handleAnalyze implements POST /api/projects/{id}/analyze. The flow is:
//
//  1. Validate {id} (404 if malformed or unknown).
//  2. Decode + validate the JSON config (400 invalid_filters / invalid_body).
//  3. Preflight EntryPointSpec for structural errors (400 invalid_entry_point).
//  4. Reserve the per-project single-flight slot (409 if held).
//  5. Open the SSE streamer and call orchestrator.RunReserved.
//
// Steps 1-4 always respond as JSON. Only after step 4 succeeds do we flush
// SSE response headers; from that point on every failure surfaces as an SSE
// done:failed event because the client already received 200 OK.
func (s *Server) handleAnalyze(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("id")
	id, err := asProjectIDOr404(rawID)
	if err != nil {
		writeAPIError(w, r, err)
		return
	}
	if s.analyzer == nil {
		s.logger.Error("analyzer missing on POST /api/projects/{id}/analyze",
			slog.String("request_id", RequestIDFromContext(r.Context())))
		writeAPIError(w, r, errInternal())
		return
	}
	if _, err := s.cache.GetProject(id); err != nil {
		if isProjectNotFound(err) {
			writeAPIError(w, r, errProjectNotFound(rawID))
			return
		}
		s.logger.Error("analyze: cache lookup failed",
			slog.String("project_id", string(id)),
			slog.String("error", err.Error()))
		writeAPIError(w, r, errInternal())
		return
	}

	spec, filters, err := decodeAnalyzeBody(r)
	if err != nil {
		writeAPIError(w, r, err)
		return
	}

	if err := validateFilters(filters); err != nil {
		writeAPIError(w, r, err)
		return
	}
	if err := s.analyzer.PreflightValidate(spec, filters); err != nil {
		writeAPIError(w, r, err)
		return
	}

	release, ok := s.analyzer.Reserve(id)
	if !ok {
		writeAPIError(w, r, errAnalysisInProgress(string(id)))
		return
	}
	defer release()

	stream, err := NewSSEStreamer(w)
	if err != nil {
		// We already hold the reservation; release it before returning so the
		// next caller is not blocked behind a streamer construction failure.
		s.logger.Error("analyze: SSE streamer init failed",
			slog.String("project_id", string(id)),
			slog.String("error", err.Error()))
		writeAPIError(w, r, errInternal())
		return
	}

	if runErr := s.analyzer.RunReserved(r.Context(), id, spec, filters, stream); runErr != nil {
		// The orchestrator surfaces every recoverable failure through SSE
		// done:failed and only returns the original error for logging. We log
		// at info because parser/graph errors on user-supplied code are
		// expected, not server faults.
		s.logger.Info("analyze: pipeline returned error",
			slog.String("project_id", string(id)),
			slog.String("error", runErr.Error()))
	}
	_ = stream.Close()
}

// decodeAnalyzeBody parses the JSON body into the documented EntryPointSpec /
// Filters pair, applying defaults for any field the caller omitted. An empty
// body is treated as "use defaults" per api-contract.md §2.
func decodeAnalyzeBody(r *http.Request) (domain.EntryPointSpec, domain.Filters, error) {
	spec := domain.DefaultEntryPointSpec()
	filters := domain.DefaultFilters()

	body := http.MaxBytesReader(nil, r.Body, MaxAnalyzeBodyBytes)
	defer func() { _ = body.Close() }()

	dec := json.NewDecoder(body)
	dec.DisallowUnknownFields()
	var req analyzeRequest
	if err := dec.Decode(&req); err != nil {
		if errors.Is(err, io.EOF) {
			// Empty body — defaults already loaded above.
			return spec, filters, nil
		}
		if IsMaxBytesError(err) {
			return spec, filters, errAnalyzeBodyTooLarge(MaxBytesLimit(err))
		}
		return spec, filters, errInvalidBody("malformed JSON: " + err.Error())
	}
	// Reject extra payload after the first JSON value so the protocol stays
	// strict and operators do not silently lose configuration to typos.
	if dec.More() {
		return spec, filters, errInvalidBody("unexpected trailing JSON")
	}

	if req.EntryPoints != nil {
		spec = mergeEntryPointSpec(spec, *req.EntryPoints)
	}
	if req.Filters != nil {
		filters = mergeFilters(filters, *req.Filters)
	}
	return spec, filters, nil
}

// mergeEntryPointSpec overlays caller-supplied fields onto the defaults so an
// omitted "manual" or "interface_impl" array does not nil out the slice the
// orchestrator expects.
func mergeEntryPointSpec(defaults, override domain.EntryPointSpec) domain.EntryPointSpec {
	out := defaults
	if override.Mode != "" {
		out.Mode = override.Mode
	}
	if override.AutoKinds != nil {
		out.AutoKinds = override.AutoKinds
	}
	if override.Manual != nil {
		out.Manual = override.Manual
	}
	if override.InterfaceImpl != nil {
		out.InterfaceImpl = override.InterfaceImpl
	}
	return out
}

// mergeFilters overlays caller-supplied fields onto the documented defaults.
// Boolean toggles always win because the JSON encoding cannot distinguish
// "field omitted" from "field set to false"; that is consistent with how the
// rest of the API handles boolean filters.
func mergeFilters(defaults, override domain.Filters) domain.Filters {
	out := defaults
	if override.IncludeKinds != nil {
		out.IncludeKinds = override.IncludeKinds
	}
	if override.ExcludePaths != nil {
		out.ExcludePaths = override.ExcludePaths
	}
	out.StdlibExclude = override.StdlibExclude
	out.TestExclude = override.TestExclude
	return out
}

// validateFilters rejects any IncludeKinds value that is not one of the eight
// recognised NodeKinds (api-contract.md §2). Empty IncludeKinds means "all";
// it is allowed.
func validateFilters(filters domain.Filters) error {
	var bad []string
	for _, k := range filters.IncludeKinds {
		if !k.IsValid() {
			bad = append(bad, string(k))
		}
	}
	if len(bad) > 0 {
		return errInvalidFilters(bad)
	}
	return nil
}
