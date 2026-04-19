package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// Default tuning knobs. Production values live in architecture.md §3.4 and
// docs/api-contract.md §0 (TTL idle = 30 min, sweep every 60 s).
const (
	DefaultIdleTTL       = 30 * time.Minute
	DefaultSweepInterval = 60 * time.Second
)

// Artifact file names inside a project's CacheDir.
const (
	metaFileName     = "meta.json"
	graphFileName    = "graph.json"
	deadCodeFileName = "dead-code.json"
	parsedBlobName   = "parsed.gob"
)

// Default sub-directory names appended to os.TempDir() when callers do not
// override RootTmp / RootCache.
const (
	defaultSourcesSubdir = "go-viz/sources"
	defaultCacheSubdir   = "go-viz-cache"
)

// Clock abstracts time.Now so the sweeper can be exercised deterministically
// in tests.
type Clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now().UTC() }

// Options configures a Manager. Zero values fall back to sensible defaults.
type Options struct {
	// RootTmp is the parent directory for extracted project sources. Each
	// project gets its own RootTmp/<id>/ subtree.
	RootTmp string

	// RootCache is the parent directory for analysis artifacts. Each
	// project gets its own RootCache/<id>/ subtree.
	RootCache string

	// IdleTTL is the maximum time a project may stay idle (no GetProject
	// call) before the sweeper removes it. Zero → DefaultIdleTTL.
	IdleTTL time.Duration

	// SweepInterval controls how often the background goroutine looks for
	// idle projects. Zero → DefaultSweepInterval.
	SweepInterval time.Duration

	// Logger receives structured events (eviction, schema mismatch, …).
	// Nil → slog.Default().
	Logger *slog.Logger

	// Clock is used by the sweeper to compare LastAccessAt against "now".
	// Nil → realClock (UTC time.Now).
	Clock Clock
}

// Manager is the public surface of the disk cache. Production code obtains an
// instance via New and must call Close before exit so the sweeper goroutine
// terminates cleanly.
type Manager interface {
	NewProject(name string, sizeBytes int64, fileCount int) (*Project, error)
	GetProject(id domain.ProjectID) (*Project, error)
	ListProjects() []ProjectMeta
	DeleteProject(id domain.ProjectID) error
	SourcesDir(id domain.ProjectID) string
	ReadMeta(id domain.ProjectID) (*ProjectMeta, error)
	WriteMeta(id domain.ProjectID, meta *ProjectMeta) error
	ReadGraph(id domain.ProjectID) (*domain.Graph, error)
	WriteGraph(id domain.ProjectID, g *domain.Graph) error
	ReadDeadCode(id domain.ProjectID) (*domain.DeadCodeReport, error)
	WriteDeadCode(id domain.ProjectID, r *domain.DeadCodeReport) error
	ReadParsedBlob(id domain.ProjectID) (io.ReadCloser, error)
	WriteParsedBlob(id domain.ProjectID) (io.WriteCloser, error)
	Close() error
}

// ProjectMeta is the persisted descriptor of a project. It is written to
// meta.json under the project's CacheDir on every NewProject and on every
// metadata update (e.g. a refreshed LastAccessAt after a successful
// GetProject).
type ProjectMeta struct {
	ID            domain.ProjectID `json:"id"`
	Name          string           `json:"name"`
	UploadedAt    time.Time        `json:"uploaded_at"`
	LastAccessAt  time.Time        `json:"last_access_at"`
	ExpiresAt     time.Time        `json:"expires_at"`
	SizeBytes     int64            `json:"size_bytes"`
	FileCount     int              `json:"file_count"`
	SchemaVersion int              `json:"schema_version"`
}

// Project is the in-memory handle returned by NewProject and GetProject. It
// is the single owner of the per-project synchronisation primitives used by
// downstream tasks:
//
//   - parseOnce gates the one-shot parsing performed in T07.
//   - analyzeMu serialises Orchestrator phases for the same project (ADR-10).
//
// The Meta field is a snapshot at the time of the call; LastAccessAt /
// ExpiresAt may already be stale once the caller inspects it.
type Project struct {
	Meta       ProjectMeta
	SourcesDir string
	CacheDir   string

	// ParseOnce ensures parsing happens at most once per Project lifetime
	// (T07 wires this up). Exported so the orchestrator can call Do.
	ParseOnce sync.Once

	// AnalyzeMu serialises the parse → graph → reachability pipeline for
	// this project, allowing parallel analyses for distinct projects
	// (ADR-10).
	AnalyzeMu sync.Mutex
}

// graphEnvelope is the JSON wrapper for graph.json. SchemaVersion lives at
// the top level both inside the embedded Graph and on the envelope so older
// readers can detect mismatches without decoding the body.
type graphEnvelope struct {
	SchemaVersion int           `json:"schema_version"`
	Graph         *domain.Graph `json:"graph"`
}

// deadCodeEnvelope is the JSON wrapper for dead-code.json.
type deadCodeEnvelope struct {
	SchemaVersion int                    `json:"schema_version"`
	Report        *domain.DeadCodeReport `json:"report"`
}

// manager is the production implementation of Manager.
type manager struct {
	rootTmp       string
	rootCache     string
	idleTTL       time.Duration
	sweepInterval time.Duration
	logger        *slog.Logger
	clock         Clock

	mu       sync.RWMutex
	projects map[domain.ProjectID]*Project
	closed   bool

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// New constructs a Manager and starts its background sweeper goroutine.
// Callers must invoke Close before exit so the goroutine terminates cleanly.
func New(opts Options) (Manager, error) {
	if opts.RootTmp == "" {
		opts.RootTmp = filepath.Join(os.TempDir(), defaultSourcesSubdir)
	}
	if opts.RootCache == "" {
		opts.RootCache = filepath.Join(os.TempDir(), defaultCacheSubdir)
	}
	if opts.IdleTTL <= 0 {
		opts.IdleTTL = DefaultIdleTTL
	}
	if opts.SweepInterval <= 0 {
		opts.SweepInterval = DefaultSweepInterval
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Clock == nil {
		opts.Clock = realClock{}
	}

	if err := os.MkdirAll(opts.RootTmp, dirPerm); err != nil {
		return nil, fmt.Errorf("cache: ensure root tmp %q: %w", opts.RootTmp, err)
	}
	if err := os.MkdirAll(opts.RootCache, dirPerm); err != nil {
		return nil, fmt.Errorf("cache: ensure root cache %q: %w", opts.RootCache, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	m := &manager{
		rootTmp:       opts.RootTmp,
		rootCache:     opts.RootCache,
		idleTTL:       opts.IdleTTL,
		sweepInterval: opts.SweepInterval,
		logger:        opts.Logger,
		clock:         opts.Clock,
		projects:      make(map[domain.ProjectID]*Project),
		cancel:        cancel,
	}
	m.wg.Add(1)
	go m.runSweeper(ctx)
	return m, nil
}

// NewProject allocates a fresh ProjectID, creates the per-project sources and
// cache directories with 0o700 permissions and persists the initial meta.json.
func (m *manager) NewProject(name string, sizeBytes int64, fileCount int) (*Project, error) {
	if err := m.guardOpen(); err != nil {
		return nil, err
	}
	id := domain.NewProjectID()
	now := m.clock.Now()
	meta := ProjectMeta{
		ID:            id,
		Name:          name,
		UploadedAt:    now,
		LastAccessAt:  now,
		ExpiresAt:     now.Add(m.idleTTL),
		SizeBytes:     sizeBytes,
		FileCount:     fileCount,
		SchemaVersion: domain.CurrentSchemaVersion,
	}

	sourcesDir := filepath.Join(m.rootTmp, string(id))
	cacheDir := filepath.Join(m.rootCache, string(id))
	if err := os.MkdirAll(sourcesDir, dirPerm); err != nil {
		return nil, fmt.Errorf("cache: create sources dir %q: %w", sourcesDir, err)
	}
	if err := os.MkdirAll(cacheDir, dirPerm); err != nil {
		// best-effort cleanup; do not mask the original error
		_ = os.RemoveAll(sourcesDir)
		return nil, fmt.Errorf("cache: create cache dir %q: %w", cacheDir, err)
	}

	project := &Project{
		Meta:       meta,
		SourcesDir: sourcesDir,
		CacheDir:   cacheDir,
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		_ = os.RemoveAll(sourcesDir)
		_ = os.RemoveAll(cacheDir)
		return nil, ErrManagerClosed
	}
	m.projects[id] = project
	m.mu.Unlock()

	if err := m.writeMetaToDisk(cacheDir, &meta); err != nil {
		// roll back so callers do not see a half-initialised project.
		m.mu.Lock()
		delete(m.projects, id)
		m.mu.Unlock()
		_ = os.RemoveAll(sourcesDir)
		_ = os.RemoveAll(cacheDir)
		return nil, err
	}
	return project, nil
}

// GetProject returns the live Project handle for id, refreshing LastAccessAt
// and ExpiresAt under both the in-memory record and meta.json on disk.
func (m *manager) GetProject(id domain.ProjectID) (*Project, error) {
	if err := m.guardOpen(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	project, ok := m.projects[id]
	if !ok {
		m.mu.Unlock()
		return nil, domain.ErrProjectNotFound
	}
	now := m.clock.Now()
	project.Meta.LastAccessAt = now
	project.Meta.ExpiresAt = now.Add(m.idleTTL)
	metaCopy := project.Meta
	cacheDir := project.CacheDir
	m.mu.Unlock()

	if err := m.writeMetaToDisk(cacheDir, &metaCopy); err != nil {
		return nil, err
	}
	return project, nil
}

// ListProjects returns a copy of the current ProjectMeta records, ordered by
// UploadedAt descending so callers (e.g. GET /api/projects in T12) get the
// freshest project first without further sorting.
func (m *manager) ListProjects() []ProjectMeta {
	m.mu.RLock()
	out := make([]ProjectMeta, 0, len(m.projects))
	for _, p := range m.projects {
		out = append(out, p.Meta)
	}
	m.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].UploadedAt.Equal(out[j].UploadedAt) {
			return out[i].ID < out[j].ID
		}
		return out[i].UploadedAt.After(out[j].UploadedAt)
	})
	return out
}

// DeleteProject is idempotent: removing a project that has already been
// reaped or never existed returns nil. Both directories are removed
// best-effort; failure to remove the on-disk artefacts is reported as an
// error but the in-memory entry is dropped regardless.
func (m *manager) DeleteProject(id domain.ProjectID) error {
	m.mu.Lock()
	project, ok := m.projects[id]
	if !ok {
		m.mu.Unlock()
		return nil
	}
	delete(m.projects, id)
	sourcesDir := project.SourcesDir
	cacheDir := project.CacheDir
	m.mu.Unlock()

	var firstErr error
	if err := os.RemoveAll(sourcesDir); err != nil {
		firstErr = fmt.Errorf("cache: remove sources %q: %w", sourcesDir, err)
	}
	if err := os.RemoveAll(cacheDir); err != nil && firstErr == nil {
		firstErr = fmt.Errorf("cache: remove cache %q: %w", cacheDir, err)
	}
	return firstErr
}

// SourcesDir returns the absolute sources path for id even if the project is
// no longer registered. Returning a path for unknown ids keeps callers (T06,
// T07) from having to special-case lookups while preserving the single owner
// of the directory layout.
func (m *manager) SourcesDir(id domain.ProjectID) string {
	m.mu.RLock()
	if p, ok := m.projects[id]; ok {
		dir := p.SourcesDir
		m.mu.RUnlock()
		return dir
	}
	m.mu.RUnlock()
	return filepath.Join(m.rootTmp, string(id))
}

// cacheDir resolves the per-project cache directory or returns
// ErrProjectNotFound. It does not refresh LastAccessAt — internal callers
// already hold one of the locks and must not recurse into GetProject.
func (m *manager) cacheDir(id domain.ProjectID) (string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.projects[id]
	if !ok {
		return "", domain.ErrProjectNotFound
	}
	return p.CacheDir, nil
}

// ReadMeta returns the meta record persisted on disk. Callers usually consult
// the in-memory copy via GetProject / Project.Meta; ReadMeta is provided for
// integration tests and tooling that bypass the registry.
func (m *manager) ReadMeta(id domain.ProjectID) (*ProjectMeta, error) {
	dir, err := m.cacheDir(id)
	if err != nil {
		return nil, err
	}
	return m.readMetaFromDisk(dir)
}

// WriteMeta overwrites meta.json atomically and updates the in-memory copy.
// SchemaVersion is forced to domain.CurrentSchemaVersion regardless of the
// caller-supplied value so writers cannot accidentally persist stale numbers.
func (m *manager) WriteMeta(id domain.ProjectID, meta *ProjectMeta) error {
	if meta == nil {
		return errors.New("cache: WriteMeta with nil meta")
	}
	m.mu.Lock()
	project, ok := m.projects[id]
	if !ok {
		m.mu.Unlock()
		return domain.ErrProjectNotFound
	}
	updated := *meta
	updated.ID = id
	updated.SchemaVersion = domain.CurrentSchemaVersion
	project.Meta = updated
	cacheDir := project.CacheDir
	m.mu.Unlock()
	return m.writeMetaToDisk(cacheDir, &updated)
}

// ReadGraph deserialises graph.json. It returns:
//   - ErrProjectNotFound if id is not registered;
//   - ErrStaleCache if the file is missing or corrupt;
//   - ErrSchemaMismatch if the persisted SchemaVersion does not match
//     domain.CurrentSchemaVersion.
func (m *manager) ReadGraph(id domain.ProjectID) (*domain.Graph, error) {
	dir, err := m.cacheDir(id)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, graphFileName)
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("cache: graph %q: %w", path, ErrStaleCache)
		}
		return nil, fmt.Errorf("cache: read graph %q: %w", path, err)
	}
	var env graphEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		m.logger.Warn("graph cache unreadable", slog.String("path", path), slog.String("error", err.Error()))
		return nil, fmt.Errorf("cache: decode graph %q: %w", path, ErrStaleCache)
	}
	if env.Graph == nil {
		return nil, fmt.Errorf("cache: empty graph in %q: %w", path, ErrStaleCache)
	}
	if env.SchemaVersion != domain.CurrentSchemaVersion {
		m.logger.Warn("graph schema mismatch",
			slog.String("path", path),
			slog.Int("file_version", env.SchemaVersion),
			slog.Int("current_version", domain.CurrentSchemaVersion))
		return nil, fmt.Errorf("cache: graph %q: %w", path, ErrSchemaMismatch)
	}
	return env.Graph, nil
}

// WriteGraph encodes g as JSON and atomically replaces graph.json.
func (m *manager) WriteGraph(id domain.ProjectID, g *domain.Graph) error {
	if g == nil {
		return errors.New("cache: WriteGraph with nil graph")
	}
	dir, err := m.cacheDir(id)
	if err != nil {
		return err
	}
	env := graphEnvelope{SchemaVersion: domain.CurrentSchemaVersion, Graph: g}
	return writeAtomic(filepath.Join(dir, graphFileName), func(w io.Writer) error {
		enc := json.NewEncoder(w)
		enc.SetEscapeHTML(false)
		return enc.Encode(env)
	})
}

// ReadDeadCode mirrors ReadGraph for dead-code.json.
func (m *manager) ReadDeadCode(id domain.ProjectID) (*domain.DeadCodeReport, error) {
	dir, err := m.cacheDir(id)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, deadCodeFileName)
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("cache: dead-code %q: %w", path, ErrStaleCache)
		}
		return nil, fmt.Errorf("cache: read dead-code %q: %w", path, err)
	}
	var env deadCodeEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		m.logger.Warn("dead-code cache unreadable", slog.String("path", path), slog.String("error", err.Error()))
		return nil, fmt.Errorf("cache: decode dead-code %q: %w", path, ErrStaleCache)
	}
	if env.Report == nil {
		return nil, fmt.Errorf("cache: empty dead-code in %q: %w", path, ErrStaleCache)
	}
	if env.SchemaVersion != domain.CurrentSchemaVersion {
		m.logger.Warn("dead-code schema mismatch",
			slog.String("path", path),
			slog.Int("file_version", env.SchemaVersion),
			slog.Int("current_version", domain.CurrentSchemaVersion))
		return nil, fmt.Errorf("cache: dead-code %q: %w", path, ErrSchemaMismatch)
	}
	return env.Report, nil
}

// WriteDeadCode mirrors WriteGraph for dead-code.json.
func (m *manager) WriteDeadCode(id domain.ProjectID, r *domain.DeadCodeReport) error {
	if r == nil {
		return errors.New("cache: WriteDeadCode with nil report")
	}
	dir, err := m.cacheDir(id)
	if err != nil {
		return err
	}
	env := deadCodeEnvelope{SchemaVersion: domain.CurrentSchemaVersion, Report: r}
	return writeAtomic(filepath.Join(dir, deadCodeFileName), func(w io.Writer) error {
		enc := json.NewEncoder(w)
		enc.SetEscapeHTML(false)
		return enc.Encode(env)
	})
}

// ReadParsedBlob opens parsed.gob for streaming reads. Callers must Close the
// returned ReadCloser. ErrStaleCache is returned when the file is missing.
func (m *manager) ReadParsedBlob(id domain.ProjectID) (io.ReadCloser, error) {
	dir, err := m.cacheDir(id)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, parsedBlobName)
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("cache: parsed blob %q: %w", path, ErrStaleCache)
		}
		return nil, fmt.Errorf("cache: open parsed blob %q: %w", path, err)
	}
	return f, nil
}

// WriteParsedBlob returns an io.WriteCloser that atomically replaces
// parsed.gob on Close. The returned writer also exposes Abort (via the
// concrete *atomicWriteCloser type) so callers may discard a partial write.
func (m *manager) WriteParsedBlob(id domain.ProjectID) (io.WriteCloser, error) {
	dir, err := m.cacheDir(id)
	if err != nil {
		return nil, err
	}
	return newAtomicWriteCloser(filepath.Join(dir, parsedBlobName))
}

// Close stops the sweeper goroutine. The on-disk caches are preserved so a
// subsequent process restart can rediscover them (NFR-10).
func (m *manager) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	m.mu.Unlock()

	m.cancel()
	m.wg.Wait()
	return nil
}

// guardOpen rejects calls made after Close.
func (m *manager) guardOpen() error {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.closed {
		return ErrManagerClosed
	}
	return nil
}

// writeMetaToDisk persists meta.json atomically. SchemaVersion is forced to
// the current domain version so a stale record can never round-trip.
func (m *manager) writeMetaToDisk(cacheDir string, meta *ProjectMeta) error {
	out := *meta
	out.SchemaVersion = domain.CurrentSchemaVersion
	return writeAtomic(filepath.Join(cacheDir, metaFileName), func(w io.Writer) error {
		enc := json.NewEncoder(w)
		enc.SetEscapeHTML(false)
		return enc.Encode(&out)
	})
}

// readMetaFromDisk decodes meta.json with the same schema-version semantics
// as ReadGraph / ReadDeadCode.
func (m *manager) readMetaFromDisk(cacheDir string) (*ProjectMeta, error) {
	path := filepath.Join(cacheDir, metaFileName)
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("cache: meta %q: %w", path, ErrStaleCache)
		}
		return nil, fmt.Errorf("cache: read meta %q: %w", path, err)
	}
	var meta ProjectMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		m.logger.Warn("meta cache unreadable", slog.String("path", path), slog.String("error", err.Error()))
		return nil, fmt.Errorf("cache: decode meta %q: %w", path, ErrStaleCache)
	}
	if meta.SchemaVersion != domain.CurrentSchemaVersion {
		m.logger.Warn("meta schema mismatch",
			slog.String("path", path),
			slog.Int("file_version", meta.SchemaVersion),
			slog.Int("current_version", domain.CurrentSchemaVersion))
		return nil, fmt.Errorf("cache: meta %q: %w", path, ErrSchemaMismatch)
	}
	return &meta, nil
}
