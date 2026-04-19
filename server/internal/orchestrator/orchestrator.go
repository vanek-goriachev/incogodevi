package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/api"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/graph"
	"github.com/vanek-goriachev/incogodevi/server/internal/parser"
)

// PartialGraphChunkSize is the number of nodes (and edges) bundled into a
// single partial_graph SSE event. It is chosen to keep frame sizes well below
// the 64 KB SSE soft-limit recommended by browser implementations while
// minimising the number of round-trips for medium projects (~5 KB per node).
const PartialGraphChunkSize = 100

// PartialGraphMinInterval throttles consecutive partial_graph emissions so
// the SSE buffer cannot be flooded on very small projects (T13 spec).
const PartialGraphMinInterval = 100 * time.Millisecond

// Options bundles the dependencies an Orchestrator needs at construction.
//
// Every field is required except Logger (defaults to slog.Default()). Mocking
// individual services is achieved by supplying alternative implementations of
// the deps.go interfaces — production code passes the concrete *parser.Parser,
// *graph.Builder, *entry.Resolver and *reach.Analyzer directly.
type Options struct {
	Cache    CacheWriter
	Parser   ParserService
	Builder  BuilderService
	Resolver EntryResolverService
	Reach    ReachService
	Logger   *slog.Logger

	// Now overrides time.Now in tests; production passes nil.
	Now func() time.Time

	// PartialChunkSize, when positive, overrides PartialGraphChunkSize. Used
	// by integration tests to assert chunked emissions on small fixtures.
	PartialChunkSize int

	// PartialMinInterval, when positive, overrides PartialGraphMinInterval.
	PartialMinInterval time.Duration
}

// Orchestrator runs the analysis pipeline (parser → graph → entry → reach →
// exporter) under per-project single-flight, streaming progress through an
// api.SSEStreamer.
//
// Instances are safe for concurrent use across distinct project IDs; the
// inflight sync.Map maintains one mutex per project so two POST /analyze
// calls for different projects do not contend.
type Orchestrator struct {
	cache    CacheWriter
	parser   ParserService
	builder  BuilderService
	resolver EntryResolverService
	reach    ReachService
	logger   *slog.Logger
	now      func() time.Time
	chunk    int
	minTick  time.Duration

	inflight sync.Map // map[domain.ProjectID]*sync.Mutex
}

// New constructs an Orchestrator. It panics if any required dependency is
// missing because callers cannot reasonably continue with a half-initialised
// pipeline (the same convention used by the other backend packages).
func New(opts Options) *Orchestrator {
	if opts.Cache == nil {
		panic("orchestrator: Options.Cache is required")
	}
	if opts.Parser == nil {
		panic("orchestrator: Options.Parser is required")
	}
	if opts.Builder == nil {
		panic("orchestrator: Options.Builder is required")
	}
	if opts.Resolver == nil {
		panic("orchestrator: Options.Resolver is required")
	}
	if opts.Reach == nil {
		panic("orchestrator: Options.Reach is required")
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	chunk := opts.PartialChunkSize
	if chunk <= 0 {
		chunk = PartialGraphChunkSize
	}
	tick := opts.PartialMinInterval
	if tick <= 0 {
		tick = PartialGraphMinInterval
	}
	return &Orchestrator{
		cache:    opts.Cache,
		parser:   opts.Parser,
		builder:  opts.Builder,
		resolver: opts.Resolver,
		reach:    opts.Reach,
		logger:   logger,
		now:      now,
		chunk:    chunk,
		minTick:  tick,
	}
}

// Run executes one analysis pipeline for project id and streams events to
// stream. It enforces single-flight per project_id (ADR-10), recovers from
// panics and translates context cancellation into a graceful exit.
//
// On success the final SSE event is `done` with phase=done; on a recoverable
// failure (parser/graph/reach error) the final event is `done` with
// phase=failed and a populated error envelope. ErrAnalysisInProgress is the
// only error returned to the caller — every other failure is reported through
// the SSE stream.
func (o *Orchestrator) Run(
	ctx context.Context,
	id domain.ProjectID,
	spec domain.EntryPointSpec,
	filters domain.Filters,
	stream *api.SSEStreamer,
) error {
	if stream == nil {
		return errors.New("orchestrator: nil SSEStreamer")
	}
	release, ok := o.Reserve(id)
	if !ok {
		return ErrAnalysisInProgress
	}
	defer release()
	return o.runReserved(ctx, id, spec, filters, stream)
}

// RunReserved runs the pipeline assuming the caller has already obtained the
// per-project single-flight reservation through Reserve. It is intended for
// the HTTP handler (T15), which needs to surface ErrAnalysisInProgress as a
// JSON 409 *before* the SSE response headers are flushed and therefore can
// no longer rely on Run to acquire the lock itself.
//
// Calling RunReserved without a prior Reserve breaks the single-flight
// invariant; Reserve panics make this contract obvious in tests.
func (o *Orchestrator) RunReserved(
	ctx context.Context,
	id domain.ProjectID,
	spec domain.EntryPointSpec,
	filters domain.Filters,
	stream *api.SSEStreamer,
) error {
	if stream == nil {
		return errors.New("orchestrator: nil SSEStreamer")
	}
	return o.runReserved(ctx, id, spec, filters, stream)
}

// Reserve attempts to acquire the per-project single-flight slot. The
// returned release function must be called exactly once and is safe to call
// from a deferred statement; subsequent calls are no-ops. When ok is false
// another goroutine already holds the slot and the caller must surface
// ErrAnalysisInProgress / a 409 to its consumer.
func (o *Orchestrator) Reserve(id domain.ProjectID) (release func(), ok bool) {
	mu, fresh := o.acquire(id)
	if !fresh {
		return func() {}, false
	}
	var once sync.Once
	return func() { once.Do(mu.Unlock) }, true
}

// PreflightValidate runs the cheap, side-effect-free checks the HTTP layer
// can resolve before opening the SSE response: spec.Mode shape and the
// structural form of every manual / interface_impl FQN. Semantic resolution
// (does the symbol exist? does the package compile?) is deferred to the
// main pipeline so the response can carry it through SSE done:failed.
//
// The returned error is either nil or an *entry.InvalidEntryPointError so
// the HTTP layer can render the canonical 400 envelope unchanged.
func (o *Orchestrator) PreflightValidate(spec domain.EntryPointSpec, _ domain.Filters) error {
	return validateEntryPointShape(spec)
}

// runReserved is the panic-safe pipeline runner shared by Run and
// RunReserved. The caller owns the per-project single-flight slot.
func (o *Orchestrator) runReserved(
	ctx context.Context,
	id domain.ProjectID,
	spec domain.EntryPointSpec,
	filters domain.Filters,
	stream *api.SSEStreamer,
) error {

	logger := o.logger.With(slog.String("project_id", string(id)))
	start := o.now()

	// Recover from any panic in the pipeline so the client always sees a
	// terminal `done` event. The outer error variable is set so test code
	// inspecting the return value can still detect the failure.
	var runErr error
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				stack := debug.Stack()
				logger.Error("orchestrator panic",
					slog.Any("recover", rec),
					slog.String("stack", string(stack)),
				)
				runErr = fmt.Errorf("orchestrator: panic: %v", rec)
				emitFailed(stream, logger, "internal", fmt.Sprintf("%v", rec), start)
			}
		}()
		runErr = o.runPipeline(ctx, id, spec, filters, stream, logger, start)
	}()

	return runErr
}

// runPipeline contains the actual phase sequence. It is split out so the
// surrounding panic recoverer in Run stays concise.
func (o *Orchestrator) runPipeline(
	ctx context.Context,
	id domain.ProjectID,
	spec domain.EntryPointSpec,
	_ domain.Filters,
	stream *api.SSEStreamer,
	logger *slog.Logger,
	start time.Time,
) error {
	// 1. loading — currently a logical phase boundary; sources are already
	// on disk by the time the orchestrator runs.
	if err := emit(stream, domain.EventPhase, phasePayload{
		Phase:   domain.PhaseLoading,
		Message: "preparing sources",
	}); err != nil {
		return err
	}

	// 2. parsing — drain progress in a goroutine so we can forward each tick
	// as a `phase` event without buffering the whole channel up front.
	if err := emit(stream, domain.EventPhase, phasePayload{Phase: domain.PhaseParsing}); err != nil {
		return err
	}
	loadResult, err := o.runParse(ctx, id, stream)
	if err != nil {
		emitFailed(stream, logger, "parse_failed", err.Error(), start)
		return err
	}
	for _, w := range loadResult.Warnings {
		if err := emit(stream, domain.EventWarning, w); err != nil {
			return err
		}
	}
	if loadResult.TypesUnavailable {
		// Cache hit only carries reduced packages — the orchestrator needs
		// live types to run the graph builder. Surface a warning so the
		// caller can decide whether to invalidate the cache.
		w := domain.Warning{
			Code:    "types_unavailable",
			Message: "parser returned cached snapshot without live types; falling back to graph build with reduced data only",
		}
		if err := emit(stream, domain.EventWarning, w); err != nil {
			return err
		}
	}

	// 3. building_graph — emit `phase` then collect partial_graph chunks once
	// the builder finishes. The builder itself does not yield intermediate
	// nodes, so we slice the final result and pace the emissions with the
	// configured throttle to satisfy the SSE buffering note in T13.
	if err := emit(stream, domain.EventPhase, phasePayload{
		Phase:    domain.PhaseBuildingGraph,
		Progress: 0.3,
	}); err != nil {
		return err
	}
	g, err := o.runBuild(ctx, loadResult, stream, logger)
	if err != nil {
		emitFailed(stream, logger, "graph_failed", err.Error(), start)
		return err
	}

	// 4. partial_graph — chunked emissions of the freshly built graph so the
	// frontend can populate Cytoscape incrementally (NFR-02).
	if err := o.streamPartialGraph(stream, g); err != nil {
		return err
	}

	// 5. reachability — entry resolution + BFS marking + dead-code report.
	if err := emit(stream, domain.EventPhase, phasePayload{
		Phase:    domain.PhaseReachability,
		Progress: 0.85,
	}); err != nil {
		return err
	}
	entries, entryWarnings, err := o.resolver.Resolve(spec, loadResult.LivePackages, g)
	if err != nil {
		emitFailed(stream, logger, "entry_failed", err.Error(), start)
		return err
	}
	for _, w := range entryWarnings {
		if err := emit(stream, domain.EventWarning, w); err != nil {
			return err
		}
	}
	if err := o.reach.Mark(g, entries); err != nil {
		emitFailed(stream, logger, "reach_failed", err.Error(), start)
		return err
	}
	markEntries(g, entries)
	deadCode := o.reach.DeadCode(g)
	deadCode.ProjectID = id
	deadCode.GeneratedAt = o.now().UTC()

	// 6. exporting — persist artefacts to disk so subsequent GETs can serve
	// them and the frontend can fall back when partial_graph events are
	// missed (api-contract.md §3 fallback note).
	if err := emit(stream, domain.EventPhase, phasePayload{
		Phase:    domain.PhaseExporting,
		Progress: 0.95,
	}); err != nil {
		return err
	}
	g.Warnings = mergeWarnings(g.Warnings, loadResult.Warnings, entryWarnings)
	if err := o.cache.WriteGraph(id, g); err != nil {
		emitFailed(stream, logger, "export_failed", err.Error(), start)
		return err
	}
	if err := o.cache.WriteDeadCode(id, deadCode); err != nil {
		emitFailed(stream, logger, "export_failed", err.Error(), start)
		return err
	}

	// 7. done — terminal event with summary stats.
	elapsed := o.now().Sub(start)
	done := donePayload{
		Phase:         domain.PhaseDone,
		NodeCount:     len(g.Nodes),
		EdgeCount:     len(g.Edges),
		WarningsCount: len(g.Warnings),
		ElapsedMS:     int(elapsed / time.Millisecond),
		GraphURL:      fmt.Sprintf("/api/projects/%s/graph", id),
	}
	if err := emit(stream, domain.EventDone, done); err != nil {
		return err
	}
	logger.Info("analysis done",
		slog.Int("nodes", done.NodeCount),
		slog.Int("edges", done.EdgeCount),
		slog.Int("warnings", done.WarningsCount),
		slog.Int("elapsed_ms", done.ElapsedMS),
	)
	return nil
}

// runParse invokes the parser and forwards each progress tick as a `phase`
// event. The progress channel is closed by the parser; the forwarder
// goroutine exits cleanly when the channel drains.
func (o *Orchestrator) runParse(
	ctx context.Context,
	id domain.ProjectID,
	stream *api.SSEStreamer,
) (loadResult *parser.LoadResult, err error) {
	progress := make(chan float64, 64)
	progressDone := make(chan struct{})
	go func() {
		defer close(progressDone)
		var last float64
		for v := range progress {
			// Only emit when the value advances enough to matter; the
			// parser otherwise pings on every package which would balloon
			// the SSE stream for large dependency trees.
			if v < last+0.05 && v < 1.0 {
				continue
			}
			last = v
			_ = emit(stream, domain.EventPhase, phasePayload{
				Phase:    domain.PhaseParsing,
				Progress: v,
			})
		}
	}()

	res, parseErr := o.parser.Load(ctx, id, progress)
	<-progressDone
	if parseErr != nil {
		return nil, parseErr
	}
	return res, nil
}

// runBuild invokes the graph builder. Progress events from the builder are
// translated into `phase` updates carrying the building_graph kind.
func (o *Orchestrator) runBuild(
	ctx context.Context,
	loadResult *parser.LoadResult,
	stream *api.SSEStreamer,
	logger *slog.Logger,
) (*domain.Graph, error) {
	progress := make(chan float64, 64)
	progressDone := make(chan struct{})
	go func() {
		defer close(progressDone)
		for v := range progress {
			_ = emit(stream, domain.EventPhase, phasePayload{
				Phase:    domain.PhaseBuildingGraph,
				Progress: 0.3 + 0.5*v, // map [0,1] into the 0.30-0.80 band
			})
		}
	}()
	g, err := o.builder.Build(ctx, graph.BuildInput{
		Packages: loadResult.LivePackages,
		Reduced:  loadResult.Packages,
	}, progress)
	<-progressDone
	if err != nil {
		return nil, err
	}
	logger.Debug("graph built",
		slog.Int("nodes", len(g.Nodes)),
		slog.Int("edges", len(g.Edges)),
	)
	return g, nil
}

// streamPartialGraph slices the freshly built graph into PartialChunkSize
// chunks and emits them with a minimum spacing of PartialMinInterval so the
// SSE buffer cannot drown on very small projects.
func (o *Orchestrator) streamPartialGraph(stream *api.SSEStreamer, g *domain.Graph) error {
	if g == nil || len(g.Nodes) == 0 {
		// Always emit at least one (possibly empty) partial_graph so clients
		// can rely on its presence to switch UI state.
		return emit(stream, domain.EventPartialGraph, partialPayload{Nodes: []domain.Node{}, Edges: []domain.Edge{}})
	}
	last := time.Time{}
	chunk := o.chunk
	if chunk <= 0 {
		chunk = PartialGraphChunkSize
	}
	for offset := 0; offset < len(g.Nodes); offset += chunk {
		end := offset + chunk
		if end > len(g.Nodes) {
			end = len(g.Nodes)
		}
		nodes := g.Nodes[offset:end]
		edges := edgesForNodes(g.Edges, nodes)

		now := o.now()
		if !last.IsZero() {
			gap := now.Sub(last)
			if gap < o.minTick {
				time.Sleep(o.minTick - gap)
				now = o.now()
			}
		}
		if err := emit(stream, domain.EventPartialGraph, partialPayload{Nodes: nodes, Edges: edges}); err != nil {
			return err
		}
		last = now
	}
	return nil
}

// acquire returns the project's mutex. The boolean is true when the caller
// successfully claimed the mutex (single-flight winner) and false when an
// analysis is already in progress.
func (o *Orchestrator) acquire(id domain.ProjectID) (*sync.Mutex, bool) {
	v, _ := o.inflight.LoadOrStore(id, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	return mu, mu.TryLock()
}

// emit is a thin wrapper that swallows nil-stream calls (impossible in
// production but convenient for the panic recovery codepath which may run
// with a half-initialised local state).
func emit(stream *api.SSEStreamer, kind string, payload any) error {
	if stream == nil {
		return nil
	}
	return stream.Emit(kind, payload)
}

// emitFailed sends a terminal `done` event with phase=failed and an embedded
// error envelope. Failures here are logged but not surfaced to the caller —
// the original error is what gets returned by Run.
func emitFailed(stream *api.SSEStreamer, logger *slog.Logger, code, message string, start time.Time) {
	if stream == nil {
		return
	}
	payload := donePayload{
		Phase:     domain.PhaseFailed,
		ElapsedMS: int(time.Since(start) / time.Millisecond),
		Error: &errorEnvelope{
			Code:    code,
			Message: message,
		},
	}
	if err := stream.Emit(domain.EventDone, payload); err != nil {
		logger.Warn("emit failed-done", slog.String("error", err.Error()))
	}
}

// markEntries flips IsEntry on every node whose ID appears in entries. The
// graph slice is mutated by index; ranging by value would copy the struct.
func markEntries(g *domain.Graph, entries []string) {
	if g == nil || len(entries) == 0 {
		return
	}
	idx := make(map[string]struct{}, len(entries))
	for _, id := range entries {
		idx[id] = struct{}{}
	}
	for i := range g.Nodes {
		if _, ok := idx[g.Nodes[i].ID]; ok {
			g.Nodes[i].IsEntry = true
		}
	}
}

// edgesForNodes returns every edge whose both endpoints lie in the supplied
// node window. The cost is O(|edges| · |nodes|) which is acceptable for the
// chunk sizes the orchestrator uses (default 100); the alternative — a global
// pre-computed adjacency map — would slow down the first emission, which is
// the one NFR-02 cares about most.
func edgesForNodes(edges []domain.Edge, nodes []domain.Node) []domain.Edge {
	if len(nodes) == 0 || len(edges) == 0 {
		return nil
	}
	idx := make(map[string]struct{}, len(nodes))
	for i := range nodes {
		idx[nodes[i].ID] = struct{}{}
	}
	out := make([]domain.Edge, 0, len(nodes))
	for _, e := range edges {
		if _, srcOK := idx[e.Source]; !srcOK {
			continue
		}
		if _, tgtOK := idx[e.Target]; !tgtOK {
			continue
		}
		out = append(out, e)
	}
	return out
}

// mergeWarnings concatenates several warning slices while dropping exact
// duplicates so the final graph carries a clean diagnostic list.
func mergeWarnings(initial []domain.Warning, extras ...[]domain.Warning) []domain.Warning {
	seen := make(map[domain.Warning]struct{}, len(initial))
	out := make([]domain.Warning, 0, len(initial))
	for _, w := range initial {
		if _, dup := seen[w]; dup {
			continue
		}
		seen[w] = struct{}{}
		out = append(out, w)
	}
	for _, batch := range extras {
		for _, w := range batch {
			if _, dup := seen[w]; dup {
				continue
			}
			seen[w] = struct{}{}
			out = append(out, w)
		}
	}
	return out
}

// phasePayload is the JSON payload for `phase` events.
type phasePayload struct {
	Phase    domain.AnalysisPhase `json:"phase"`
	Message  string               `json:"message,omitempty"`
	Progress float64              `json:"progress,omitempty"`
}

// partialPayload is the JSON payload for `partial_graph` events.
type partialPayload struct {
	Nodes []domain.Node `json:"nodes"`
	Edges []domain.Edge `json:"edges"`
}

// donePayload is the terminal `done` event payload.
type donePayload struct {
	Phase         domain.AnalysisPhase `json:"phase"`
	NodeCount     int                  `json:"node_count,omitempty"`
	EdgeCount     int                  `json:"edge_count,omitempty"`
	WarningsCount int                  `json:"warnings_count,omitempty"`
	ElapsedMS     int                  `json:"elapsed_ms"`
	GraphURL      string               `json:"graph_url,omitempty"`
	Error         *errorEnvelope       `json:"error,omitempty"`
}

// errorEnvelope mirrors api-contract.md §0 inside a `done` event.
type errorEnvelope struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
