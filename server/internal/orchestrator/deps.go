package orchestrator

import (
	"context"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/graph"
	"github.com/vanek-goriachev/incogodevi/server/internal/parser"
)

// ParserService is the seam over parser.Parser used by the orchestrator. The
// concrete parser exposed by the parser package satisfies this interface
// directly; tests inject fakes that exercise edge cases (panic, partial
// warnings, slow loads) without spinning up packages.Load.
type ParserService interface {
	Load(ctx context.Context, id domain.ProjectID, progress chan<- float64) (*parser.LoadResult, error)
	// LoadLive bypasses the parsed.gob cache so the returned snapshot carries
	// live *types.Package data. The orchestrator needs this for every analyze
	// run because entry resolution and reachability both require go/types.
	LoadLive(ctx context.Context, id domain.ProjectID, progress chan<- float64) (*parser.LoadResult, error)
}

// BuilderService is the seam over graph.Builder. Tests can inject fakes that
// emit a synthetic graph quickly so the orchestrator-level behaviour
// (single-flight, panic recovery, SSE ordering) is exercised in isolation
// from the heavier T08 codepaths.
type BuilderService interface {
	Build(ctx context.Context, in graph.BuildInput, progress chan<- float64) (*domain.Graph, error)
}

// EntryResolverService is the seam over entry.Resolver.
type EntryResolverService interface {
	Resolve(spec domain.EntryPointSpec, pkgs []parser.LivePackage, g *domain.Graph) ([]string, []domain.Warning, error)
}

// ReachService is the seam over reach.Analyzer.
type ReachService interface {
	Mark(g *domain.Graph, entryIDs []string) error
	DeadCode(g *domain.Graph) *domain.DeadCodeReport
}

// CacheWriter narrows cache.Manager to the two artefact-write methods the
// orchestrator needs. The full cache.Manager satisfies this interface.
type CacheWriter interface {
	WriteGraph(id domain.ProjectID, g *domain.Graph) error
	WriteDeadCode(id domain.ProjectID, r *domain.DeadCodeReport) error
}
