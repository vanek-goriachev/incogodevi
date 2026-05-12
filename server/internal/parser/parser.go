package parser

import (
	"context"
	"encoding/gob"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"time"

	"golang.org/x/tools/go/packages"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// loadMode is the union of packages.Need* flags requested by FR-04 and
// ADR-02. Pulling it out of the function body makes it trivial to assert in
// tests that the parser asks for the full type-aware view.
const loadMode = packages.NeedName |
	packages.NeedFiles |
	packages.NeedCompiledGoFiles |
	packages.NeedImports |
	packages.NeedDeps |
	packages.NeedTypes |
	packages.NeedTypesInfo |
	packages.NeedSyntax |
	packages.NeedModule

// Parser orchestrates a single project's parse step. Instances are safe for
// concurrent use across distinct project IDs; the cache.Manager handles
// per-project synchronisation (ADR-10).
type Parser struct {
	cache  cache.Manager
	logger *slog.Logger
	loader packagesLoader
}

// packagesLoader is the seam used by tests to inject a fake packages.Load.
// The production implementation calls packages.Load verbatim.
type packagesLoader func(cfg *packages.Config, patterns ...string) ([]*packages.Package, error)

// New constructs a Parser bound to the given cache.Manager. Logger may be
// nil; callers that omit it get slog.Default().
func New(manager cache.Manager, logger *slog.Logger) *Parser {
	if manager == nil {
		panic("parser: cache manager must not be nil")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Parser{
		cache:  manager,
		logger: logger,
		loader: packages.Load,
	}
}

// Load returns the typed snapshot of project id. The progress channel, when
// non-nil, receives monotonically non-decreasing values in [0.0, 1.0] and is
// closed when the call returns. A cache hit emits a single value of 1.0.
//
// On cache miss the call invokes packages.Load, walks the resulting packages,
// writes parsed.gob and returns both the reduced and live views. On cache hit
// only the reduced view is returned and TypesUnavailable is set so callers
// know they need a fresh load before touching go/types.
func (p *Parser) Load(ctx context.Context, id domain.ProjectID, progress chan<- float64) (*LoadResult, error) {
	return p.load(ctx, id, progress, false)
}

// LoadLive is like Load but never serves from the parsed.gob cache. Callers
// that need live *types.Package data (entry resolution, reachability) must use
// this variant, because cache hits intentionally drop the type information.
//
// Bypassing the cache makes second analyses pay the full packages.Load cost
// but is the only way to honour a manual EntryPointSpec on a project whose
// parser snapshot has already been persisted; the previous behaviour returned
// a cached snapshot with no types and the entry resolver then rejected every
// manual FQN as unresolvable (see docs/tech-debt.md).
func (p *Parser) LoadLive(ctx context.Context, id domain.ProjectID, progress chan<- float64) (*LoadResult, error) {
	return p.load(ctx, id, progress, true)
}

func (p *Parser) load(ctx context.Context, id domain.ProjectID, progress chan<- float64, bypassCache bool) (*LoadResult, error) {
	if progress != nil {
		defer close(progress)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	start := time.Now()

	if !bypassCache {
		if cached, ok := p.tryCache(id); ok {
			emit(progress, 1.0)
			cached.ElapsedMS = elapsedMS(start)
			return cached, nil
		}
	}

	sourcesDir := p.cache.SourcesDir(id)
	if sourcesDir == "" {
		return nil, fmt.Errorf("parser: empty sources dir for project %q", id)
	}
	if _, err := os.Stat(sourcesDir); err != nil {
		return nil, fmt.Errorf("parser: stat sources %q: %w", sourcesDir, err)
	}

	cfg := &packages.Config{
		Mode:    loadMode,
		Dir:     sourcesDir,
		Context: ctx,
		Env:     buildEnv(sourcesDir),
		Logf:    nil,
		Tests:   false,
	}

	pkgs, err := p.loader(cfg, "./...")
	if err != nil {
		return nil, fmt.Errorf("parser: packages.Load: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	result, err := p.processPackages(ctx, pkgs, progress)
	if err != nil {
		return nil, err
	}
	result.ElapsedMS = elapsedMS(start)

	if err := p.writeCache(id, result.Packages); err != nil {
		// Cache failure is non-fatal: surface a warning so the analysis is
		// still usable but the next run will pay the parse cost again.
		p.logger.Warn("parser: write cache failed",
			slog.String("project_id", string(id)),
			slog.String("error", err.Error()))
		result.Warnings = append(result.Warnings, domain.Warning{
			Code:    "cache_write_failed",
			Message: err.Error(),
		})
	}
	return result, nil
}

// processPackages walks pkgs in deterministic order, emits progress events
// and returns the aggregated LoadResult. Errors attached to a package are
// converted to non-fatal warnings (NFR-08).
func (p *Parser) processPackages(ctx context.Context, pkgs []*packages.Package, progress chan<- float64) (*LoadResult, error) {
	visited := collectAll(pkgs)
	sort.Slice(visited, func(i, j int) bool {
		return visited[i].PkgPath < visited[j].PkgPath
	})

	result := &LoadResult{}
	emit(progress, 0.0)

	if len(visited) == 0 {
		emit(progress, 1.0)
		return result, nil
	}

	for i, pkg := range visited {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		for _, perr := range pkg.Errors {
			result.Warnings = append(result.Warnings, domain.Warning{
				Code:    "import_error",
				Message: perr.Msg,
				Package: pkg.PkgPath,
				File:    perr.Pos,
			})
		}
		reduced := reduce(pkg)
		result.Packages = append(result.Packages, reduced)
		result.LivePackages = append(result.LivePackages, fromPackages(pkg))

		emit(progress, float64(i+1)/float64(len(visited)))
	}
	return result, nil
}

// collectAll gathers the transitive closure of pkgs into a flat slice while
// de-duplicating by PkgPath. We rely on packages.Visit so that all dependency
// errors surface as warnings, matching ADR-02.
func collectAll(roots []*packages.Package) []*packages.Package {
	seen := make(map[string]*packages.Package)
	packages.Visit(roots, nil, func(pkg *packages.Package) {
		if pkg == nil || pkg.PkgPath == "" {
			return
		}
		if _, ok := seen[pkg.PkgPath]; ok {
			return
		}
		seen[pkg.PkgPath] = pkg
	})
	out := make([]*packages.Package, 0, len(seen))
	for _, p := range seen {
		out = append(out, p)
	}
	return out
}

// tryCache attempts to return a LoadResult straight from disk. A cache miss
// (file absent, schema mismatch, decode error) returns ok=false without
// surfacing an error.
func (p *Parser) tryCache(id domain.ProjectID) (*LoadResult, bool) {
	rc, err := p.cache.ReadParsedBlob(id)
	if err != nil {
		if !errors.Is(err, cache.ErrStaleCache) {
			p.logger.Debug("parser: parsed blob unreadable",
				slog.String("project_id", string(id)),
				slog.String("error", err.Error()))
		}
		return nil, false
	}
	defer func() { _ = rc.Close() }()

	var env blobEnvelope
	if err := gob.NewDecoder(rc).Decode(&env); err != nil {
		p.logger.Warn("parser: decode parsed blob",
			slog.String("project_id", string(id)),
			slog.String("error", err.Error()))
		return nil, false
	}
	if env.SchemaVersion != blobSchemaVersion {
		p.logger.Info("parser: parsed blob schema mismatch",
			slog.String("project_id", string(id)),
			slog.Int("file_version", env.SchemaVersion),
			slog.Int("current_version", blobSchemaVersion))
		return nil, false
	}

	pkgs := make([]*ReducedPackage, len(env.Packages))
	for i := range env.Packages {
		pkg := env.Packages[i]
		pkgs[i] = &pkg
	}
	return &LoadResult{
		Packages:         pkgs,
		TypesUnavailable: true,
		FromCache:        true,
	}, true
}

// writeCache serialises pkgs into parsed.gob. The caller decides whether a
// failure here is fatal; Load treats it as a warning.
func (p *Parser) writeCache(id domain.ProjectID, pkgs []*ReducedPackage) error {
	wc, err := p.cache.WriteParsedBlob(id)
	if err != nil {
		return fmt.Errorf("open writer: %w", err)
	}
	envelope := blobEnvelope{
		SchemaVersion: blobSchemaVersion,
		Packages:      derefAll(pkgs),
	}
	if err := gob.NewEncoder(wc).Encode(envelope); err != nil {
		// Try to abort the partial write so the next read sees a stale
		// (missing) cache rather than a half-written blob. The cache layer
		// exposes this through the *atomicWriteCloser type.
		if aborter, ok := wc.(interface{ Abort() }); ok {
			aborter.Abort()
		} else {
			_ = wc.Close()
		}
		return fmt.Errorf("encode: %w", err)
	}
	if err := wc.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	return nil
}

// buildEnv prepares the environment for packages.Load. We isolate GOPATH
// inside the project's parent directory so the host GOPATH is never written
// to, and force -mod=mod so missing-vendor errors surface as warnings instead
// of refusing to load (ADR-02).
func buildEnv(sourcesDir string) []string {
	env := append([]string(nil), os.Environ()...)
	env = append(env, "GOFLAGS=-mod=mod")
	env = append(env, "GOPATH="+filepath.Join(filepath.Dir(sourcesDir), "gopath"))
	return env
}

// derefAll converts []*ReducedPackage to []ReducedPackage for gob encoding.
// gob can encode pointers but the value form keeps the on-disk layout
// straightforward and removes any "is the pointer nil" branches in readers.
func derefAll(in []*ReducedPackage) []ReducedPackage {
	out := make([]ReducedPackage, 0, len(in))
	for _, p := range in {
		if p == nil {
			continue
		}
		out = append(out, *p)
	}
	return out
}

// emit sends v on progress. The channel is treated as buffered by the caller
// (T13/T15 size it generously); we nevertheless prefer a blocking send so the
// monotonic contract documented on Load is preserved. Receivers must drain
// promptly to avoid stalling the parse phase.
func emit(progress chan<- float64, v float64) {
	if progress == nil {
		return
	}
	progress <- v
}

// elapsedMS returns the milliseconds elapsed since start, clamped to non-
// negative integers.
func elapsedMS(start time.Time) int {
	d := time.Since(start)
	if d < 0 {
		return 0
	}
	return int(d / time.Millisecond)
}
