package api

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/exporter"
)

// Recognised values for ?format= on /api/projects/{id}/dead-code.
const (
	deadCodeFormatJSON = "json"
	deadCodeFormatTXT  = "txt"

	contentTypeTXT = "text/plain; charset=utf-8"
)

// handleDeadCode implements GET /api/projects/{id}/dead-code (api-contract.md §4).
//
// Format selection precedence:
//  1. ?format= query parameter (json | txt) — explicit always wins.
//  2. Accept header — text/plain → txt, anything else → json.
//  3. Default → json.
//
// download=1 sets the canonical attachment filename derived from the project's
// display name in cache.ProjectMeta. The response body content matches the
// stable formats produced by the exporter package so that the same artefact
// can be served as a download or pasted into the UI without divergence.
func (s *Server) handleDeadCode(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("id")
	id, err := asProjectIDOr404(rawID)
	if err != nil {
		writeAPIError(w, r, err)
		return
	}
	project, err := s.cache.GetProject(id)
	if err != nil {
		if isProjectNotFound(err) {
			writeAPIError(w, r, errProjectNotFound(rawID))
			return
		}
		s.logger.Error("dead-code: cache lookup failed",
			slog.String("project_id", string(id)),
			slog.String("error", err.Error()))
		writeAPIError(w, r, errInternal())
		return
	}

	format, err := resolveDeadCodeFormat(r)
	if err != nil {
		writeAPIError(w, r, err)
		return
	}

	report, err := s.cache.ReadDeadCode(id)
	if err != nil {
		writeAPIError(w, r, translateDeadCodeReadError(err, string(id)))
		return
	}

	download := r.URL.Query().Get("download") == "1"

	switch format {
	case deadCodeFormatTXT:
		body := exporter.RenderTXT(report)
		w.Header().Set("Content-Type", contentTypeTXT)
		if download {
			w.Header().Set("Content-Disposition", attachmentHeader(project.Meta.Name, "txt"))
		}
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write(body); err != nil {
			s.logger.Warn("dead-code txt write failed",
				slog.String("project_id", string(id)),
				slog.String("error", err.Error()))
		}
	case deadCodeFormatJSON:
		body, err := exporter.RenderJSON(report)
		if err != nil {
			s.logger.Error("dead-code json render failed",
				slog.String("project_id", string(id)),
				slog.String("error", err.Error()))
			writeAPIError(w, r, errInternal())
			return
		}
		w.Header().Set("Content-Type", jsonContentType)
		if download {
			w.Header().Set("Content-Disposition", attachmentHeader(project.Meta.Name, "json"))
		}
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write(body); err != nil {
			s.logger.Warn("dead-code json write failed",
				slog.String("project_id", string(id)),
				slog.String("error", err.Error()))
		}
	}
}

// resolveDeadCodeFormat returns the requested output format and validates it
// against the documented set. An explicit ?format= overrides the Accept header;
// missing/empty defaults to JSON per api-contract.md §4.
func resolveDeadCodeFormat(r *http.Request) (string, error) {
	if v := r.URL.Query().Get("format"); v != "" {
		switch v {
		case deadCodeFormatJSON, deadCodeFormatTXT:
			return v, nil
		default:
			return "", errInvalidFormat(v)
		}
	}
	accept := r.Header.Get("Accept")
	if accept != "" && acceptPrefersText(accept) {
		return deadCodeFormatTXT, nil
	}
	return deadCodeFormatJSON, nil
}

// acceptPrefersText reports whether the Accept header asks for text/plain
// without simultaneously accepting application/json. The check is intentionally
// strict — generic "*/*" or any application/json offer keeps the JSON default.
func acceptPrefersText(accept string) bool {
	lower := strings.ToLower(accept)
	if !strings.Contains(lower, "text/plain") {
		return false
	}
	if strings.Contains(lower, "application/json") {
		return false
	}
	return true
}

// attachmentHeader builds the Content-Disposition header used when ?download=1.
// The filename follows the contract template "<project>-dead-code.<ext>" and
// is sanitised so the response stays portable across operating systems.
func attachmentHeader(projectName, ext string) string {
	base := sanitizeFilename(projectName)
	if base == "" {
		base = "project"
	}
	return fmt.Sprintf(`attachment; filename="%s-dead-code.%s"`, base, ext)
}

// sanitizeFilename keeps ASCII letters, digits, dots, hyphens and underscores;
// every other byte is replaced with "_". This avoids quoting headaches and
// keeps the filename safe for Windows/macOS/Linux file systems alike.
func sanitizeFilename(name string) string {
	var b strings.Builder
	b.Grow(len(name))
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-' || r == '_' || r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	return strings.Trim(b.String(), "._-")
}

// translateDeadCodeReadError is the dead-code twin of translateGraphReadError.
// Missing artefact → 404 no_graph_yet, corrupt artefact → 503 stale_cache.
func translateDeadCodeReadError(err error, projectID string) error {
	switch {
	case errors.Is(err, domain.ErrProjectNotFound):
		return errProjectNotFound(projectID)
	case errors.Is(err, domain.ErrNoGraphYet):
		return errNoGraphYet(projectID)
	case errors.Is(err, cache.ErrStaleCache), errors.Is(err, cache.ErrSchemaMismatch):
		return errStaleCache(projectID)
	}
	return err
}
