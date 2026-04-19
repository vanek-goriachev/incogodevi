package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/loader"
)

// archiveFormField is the name of the multipart field that carries the ZIP
// payload. Mirrors docs/api-contract.md §1.
const archiveFormField = "archive"

// nameFormField is the optional human-readable project name. Empty values
// fall back to the module path parsed by the loader.
const nameFormField = "name"

// multipartMemoryBudget is the upper bound of in-memory bytes
// http.Request.ParseMultipartForm is allowed to keep. Anything beyond is
// spooled to a temp file by the standard library; the loader's own LimitReader
// then enforces NFR-14 against the spool.
const multipartMemoryBudget int64 = 32 << 20

// handleCreateProject is the production handler for POST /api/projects. It
// delegates archive validation to loader.Loader and renders ProjectMeta as the
// JSON envelope documented in api-contract.md §1.
//
// The MaxBytes middleware wrapping this route caps r.Body at MaxUploadBytes
// before a single byte is read. Consequently any ParseMultipartForm or
// FormFile call may return a *http.MaxBytesError, which we translate into the
// canonical 413 envelope.
func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	if s.loader == nil {
		// Should never happen in production — NewServer wires the loader.
		// Surface as 500 with a stable code for the operator.
		s.logger.Error("loader missing on POST /api/projects",
			slog.String("request_id", RequestIDFromContext(r.Context())),
		)
		writeAPIError(w, r, errInternal())
		return
	}

	if err := r.ParseMultipartForm(multipartMemoryBudget); err != nil {
		writeAPIError(w, r, translateUploadError(err))
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	file, header, err := r.FormFile(archiveFormField)
	if err != nil {
		if errors.Is(err, http.ErrMissingFile) {
			writeAPIError(w, r, errInvalidZip("missing archive field"))
			return
		}
		writeAPIError(w, r, translateUploadError(err))
		return
	}
	defer func() { _ = file.Close() }()

	if header == nil || header.Size <= 0 {
		writeAPIError(w, r, errInvalidZip("archive is empty"))
		return
	}

	displayName := strings.TrimSpace(r.FormValue(nameFormField))

	meta, err := s.loader.Load(r.Context(), file, header.Size, displayName)
	if err != nil {
		writeAPIError(w, r, translateLoaderError(err, s.logger, RequestIDFromContext(r.Context())))
		return
	}

	// PII hygiene: log size, not the original filename.
	s.logger.Info("project_uploaded",
		slog.String("project_id", string(meta.ID)),
		slog.Int64("size_bytes", meta.SizeBytes),
		slog.Int("file_count", meta.FileCount),
		slog.String("request_id", RequestIDFromContext(r.Context())),
	)

	writeJSON(w, http.StatusCreated, projectMetaResponse{
		ProjectID:  meta.ID,
		Name:       meta.Name,
		UploadedAt: meta.UploadedAt,
		SizeBytes:  meta.SizeBytes,
		FileCount:  meta.FileCount,
		ExpiresAt:  meta.ExpiresAt,
	})
}

// projectMetaResponse mirrors docs/api-contract.md §1 response. We deliberately
// expose only fields documented for clients — internal bookkeeping such as
// LastAccessAt or SchemaVersion stays inside cache.ProjectMeta.
type projectMetaResponse struct {
	ProjectID  domain.ProjectID `json:"project_id"`
	Name       string           `json:"name"`
	UploadedAt time.Time        `json:"uploaded_at"`
	SizeBytes  int64            `json:"size_bytes"`
	FileCount  int              `json:"file_count"`
	ExpiresAt  time.Time        `json:"expires_at"`
}

// translateUploadError converts the various non-domain errors raised by the
// stdlib multipart machinery into the contract's stable envelopes.
//
// The MaxBytesReader-driven 413 takes priority because it pre-empts every
// other failure mode (we cannot trust a partially read multipart body).
func translateUploadError(err error) *domain.APIError {
	if err == nil {
		return nil
	}
	if IsMaxBytesError(err) {
		return errArchiveTooLarge(MaxBytesLimit(err))
	}
	return errInvalidZip("invalid multipart payload")
}

// translateLoaderError maps loader sentinels onto the documented codes.
// Unknown errors collapse to invalid_zip + a structured log entry so we never
// leak implementation details to the client (api-contract.md §0).
func translateLoaderError(err error, logger *slog.Logger, requestID string) *domain.APIError {
	switch {
	case errors.Is(err, domain.ErrArchiveTooLarge):
		return errArchiveTooLarge(loader.DefaultMaxArchiveBytes)
	case errors.Is(err, domain.ErrZipSlip):
		return errZipSlipDetected()
	case errors.Is(err, domain.ErrGoModMissing):
		return errGoModMissing()
	case errors.Is(err, domain.ErrFileCountExceeded):
		return errFileCountExceeded(loader.DefaultMaxFiles)
	case errors.Is(err, domain.ErrUnpackedSizeExceeded):
		return errUnpackedSizeExceeded(loader.DefaultMaxUnpackedBytes)
	}
	if IsMaxBytesError(err) {
		return errArchiveTooLarge(MaxBytesLimit(err))
	}
	logger.Warn("loader rejected upload",
		slog.String("error", err.Error()),
		slog.String("request_id", requestID),
	)
	return errInvalidZip("archive could not be processed")
}

// loaderFromCache builds the default Loader used by NewServer when no custom
// instance was supplied via Config. Keeps the wiring isolated for tests that
// want to install a fake loader through Server.SetLoader.
func loaderFromCache(mgr cache.Manager, logger *slog.Logger) *loader.Loader {
	return loader.New(mgr, loader.Config{}, logger)
}
