package api

import (
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// MaxUploadBytes is the byte limit applied to POST /api/projects per
// docs/requirements.md NFR-04 / NFR-14 (50 MiB).
const MaxUploadBytes int64 = 50 * 1024 * 1024

// Config bundles the dependencies a Server needs to run.
type Config struct {
	// Cache owns the per-project sources and disk-cached artifacts. Required.
	Cache cache.Manager

	// StaticFS is the root of the embedded SPA bundle. Required.
	StaticFS fs.FS

	// Logger is used by the middleware chain and route handlers. Nil falls
	// back to slog.Default().
	Logger *slog.Logger

	// Version is reported by /api/healthz. Empty falls back to "dev".
	Version string

	// StartedAt is reported by /api/healthz as uptime_sec. Zero falls back
	// to time.Now() at NewServer.
	StartedAt time.Time

	// ActiveProjects, when non-nil, is read by /api/healthz to populate the
	// active_projects field. When nil the value reported is the size of the
	// cache.Manager's project list — a sufficient approximation for T12.
	ActiveProjects *atomic.Int64

	// TrustedOrigins is an optional allow-list of cross-origin Origin
	// headers. Same-origin requests are always allowed; everything else
	// must appear here verbatim or it is rejected with 403.
	TrustedOrigins []string
}

// Server is the HTTP entry point of the backend. It owns the configured mux
// (for direct mounting in tests) and the wrapped handler returned by
// Handler().
type Server struct {
	cache          cache.Manager
	logger         *slog.Logger
	version        string
	startedAt      time.Time
	activeProjects *atomic.Int64
	mux            *http.ServeMux
	handler        http.Handler
}

// NewServer constructs a Server, registers all routes and wraps the mux with
// the standard middleware chain (AccessLog → RequestID → Recover → CORS →
// mux). The returned value is ready to be assigned to http.Server.Handler.
func NewServer(cfg Config) (*Server, error) {
	if cfg.Cache == nil {
		return nil, errors.New("api: NewServer requires a non-nil cache.Manager")
	}
	if cfg.StaticFS == nil {
		return nil, errors.New("api: NewServer requires a non-nil StaticFS")
	}

	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	version := cfg.Version
	if version == "" {
		version = "dev"
	}
	startedAt := cfg.StartedAt
	if startedAt.IsZero() {
		startedAt = time.Now()
	}

	srv := &Server{
		cache:          cfg.Cache,
		logger:         logger,
		version:        version,
		startedAt:      startedAt,
		activeProjects: cfg.ActiveProjects,
		mux:            http.NewServeMux(),
	}

	srv.registerRoutes(cfg.StaticFS)

	// Order matters: RequestID populates ctx before AccessLog records the
	// id; Recover sits inside AccessLog so the panic envelope is logged
	// with the same status; CORS rejects cross-origin requests before any
	// downstream work, including before they show up in the access log
	// payload as 403s.
	srv.handler = chain(
		srv.mux,
		RequestID(),
		AccessLog(logger),
		Recover(logger),
		CORS(cfg.TrustedOrigins...),
	)
	return srv, nil
}

// Handler returns the fully wrapped HTTP handler ready for http.Server.
func (s *Server) Handler() http.Handler { return s.handler }

// Mux exposes the underlying ServeMux for tests that want to install
// additional routes (e.g. a panic-injection endpoint).
func (s *Server) Mux() *http.ServeMux { return s.mux }

// registerRoutes wires up every endpoint defined in docs/api-contract.md.
// Real handlers for upload/analyze/graph/dead-code are placeholders here and
// filled in by tasks T13–T16.
func (s *Server) registerRoutes(staticFS fs.FS) {
	s.mux.HandleFunc("GET /api/healthz", s.handleHealthz)

	s.mux.HandleFunc("GET /api/projects", s.handleListProjects)
	s.mux.Handle("POST /api/projects", MaxBytes(MaxUploadBytes,
		http.HandlerFunc(s.handleCreateProjectPlaceholder)))

	s.mux.HandleFunc("DELETE /api/projects/{id}", s.handleDeleteProject)

	s.mux.HandleFunc("POST /api/projects/{id}/analyze", s.handleAnalyzePlaceholder)
	s.mux.HandleFunc("GET /api/projects/{id}/graph", s.handleGraphPlaceholder)
	s.mux.HandleFunc("GET /api/projects/{id}/dead-code", s.handleDeadCodePlaceholder)

	// Static SPA. Anything unmatched by /api/* falls through to the file
	// server, which 404s gracefully when an asset is missing — important
	// while server/internal/web/dist still contains only the placeholder.
	s.mux.Handle("GET /", http.FileServerFS(staticFS))
}

// handleHealthz mirrors docs/api-contract.md §7.
func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	body := healthResponse{
		Status:         "ok",
		Version:        s.version,
		UptimeSec:      int64(time.Since(s.startedAt).Seconds()),
		ActiveProjects: s.countActiveProjects(),
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) countActiveProjects() int64 {
	if s.activeProjects != nil {
		return s.activeProjects.Load()
	}
	return int64(len(s.cache.ListProjects()))
}

// healthResponse is the JSON payload returned by /api/healthz.
type healthResponse struct {
	Status         string `json:"status"`
	Version        string `json:"version"`
	UptimeSec      int64  `json:"uptime_sec"`
	ActiveProjects int64  `json:"active_projects"`
}

// handleListProjects implements docs/api-contract.md §6.
func (s *Server) handleListProjects(w http.ResponseWriter, _ *http.Request) {
	projects := s.cache.ListProjects()
	out := projectsListResponse{
		Projects: make([]projectListEntry, 0, len(projects)),
		Count:    len(projects),
	}
	var total int64
	for _, p := range projects {
		out.Projects = append(out.Projects, projectListEntry{
			ProjectID:    p.ID,
			Name:         p.Name,
			UploadedAt:   p.UploadedAt,
			LastAccessAt: p.LastAccessAt,
			SizeBytes:    p.SizeBytes,
		})
		total += p.SizeBytes
	}
	out.CacheBytesTotal = total
	writeJSON(w, http.StatusOK, out)
}

// projectsListResponse mirrors the shape documented in api-contract.md §6.
// The Status field shown in the contract is filled in by T13 once the
// orchestrator publishes per-project status; for T12 we omit it to keep the
// surface honest about what is actually known.
type projectsListResponse struct {
	Projects        []projectListEntry `json:"projects"`
	Count           int                `json:"count"`
	CacheBytesTotal int64              `json:"cache_bytes_total"`
}

type projectListEntry struct {
	ProjectID    domain.ProjectID `json:"project_id"`
	Name         string           `json:"name"`
	UploadedAt   time.Time        `json:"uploaded_at"`
	LastAccessAt time.Time        `json:"last_access_at"`
	SizeBytes    int64            `json:"size_bytes"`
}

// handleDeleteProject implements docs/api-contract.md §5. The cache manager
// is idempotent (DeleteProject of an unknown id returns nil) but the API
// contract requires 404 for a project that does not exist, so we probe with
// GetProject first.
func (s *Server) handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("id")
	id, err := asProjectIDOr404(rawID)
	if err != nil {
		writeAPIError(w, r, err)
		return
	}
	if _, err := s.cache.GetProject(id); err != nil {
		if isProjectNotFound(err) {
			writeAPIError(w, r, errProjectNotFound(rawID))
			return
		}
		writeAPIError(w, r, err)
		return
	}
	if err := s.cache.DeleteProject(id); err != nil {
		s.logger.Error("delete project",
			slog.String("project_id", string(id)),
			slog.String("error", err.Error()),
		)
		writeAPIError(w, r, errInternal())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleCreateProjectPlaceholder is the 501 stub replaced in T14. We still
// drain a bit of the body to make sure the MaxBytesReader limit is exercised
// for AC verification ("POST with 60 MiB → 413").
func (s *Server) handleCreateProjectPlaceholder(w http.ResponseWriter, r *http.Request) {
	if r.Body != nil {
		buf := make([]byte, 4096)
		for {
			_, err := r.Body.Read(buf)
			if err == nil {
				continue
			}
			if IsMaxBytesError(err) {
				writeAPIError(w, r, errArchiveTooLarge(MaxBytesLimit(err)))
				return
			}
			break
		}
	}
	writeAPIError(w, r, errNotImplemented("POST /api/projects", "T14"))
}

// handleAnalyzePlaceholder is the 501 stub replaced in T15.
func (s *Server) handleAnalyzePlaceholder(w http.ResponseWriter, r *http.Request) {
	if _, err := asProjectIDOr404(r.PathValue("id")); err != nil {
		writeAPIError(w, r, err)
		return
	}
	writeAPIError(w, r, errNotImplemented("POST /api/projects/{id}/analyze", "T15"))
}

// handleGraphPlaceholder is the 501 stub replaced in T16.
func (s *Server) handleGraphPlaceholder(w http.ResponseWriter, r *http.Request) {
	if _, err := asProjectIDOr404(r.PathValue("id")); err != nil {
		writeAPIError(w, r, err)
		return
	}
	writeAPIError(w, r, errNotImplemented("GET /api/projects/{id}/graph", "T16"))
}

// handleDeadCodePlaceholder is the 501 stub replaced in T16.
func (s *Server) handleDeadCodePlaceholder(w http.ResponseWriter, r *http.Request) {
	if _, err := asProjectIDOr404(r.PathValue("id")); err != nil {
		writeAPIError(w, r, err)
		return
	}
	writeAPIError(w, r, errNotImplemented("GET /api/projects/{id}/dead-code", "T16"))
}
