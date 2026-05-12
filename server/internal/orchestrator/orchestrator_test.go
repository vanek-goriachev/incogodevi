package orchestrator_test

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/api"
	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/entry"
	"github.com/vanek-goriachev/incogodevi/server/internal/graph"
	"github.com/vanek-goriachev/incogodevi/server/internal/orchestrator"
	"github.com/vanek-goriachev/incogodevi/server/internal/parser"
	"github.com/vanek-goriachev/incogodevi/server/internal/reach"
)

// frame is one decoded SSE frame: an event name and the JSON-decoded data
// payload (including the seq field).
type frame struct {
	Event string
	Data  map[string]any
}

// parseFrames splits the recorded SSE body into a slice of decoded frames so
// individual tests can assert on event order, payload shape and seq monotony.
func parseFrames(t *testing.T, body string) []frame {
	t.Helper()
	body = strings.TrimRight(body, "\n")
	if body == "" {
		return nil
	}
	chunks := strings.Split(body, "\n\n")
	out := make([]frame, 0, len(chunks))
	for _, chunk := range chunks {
		chunk = strings.TrimSpace(chunk)
		if chunk == "" || strings.HasPrefix(chunk, ":") {
			continue
		}
		lines := strings.Split(chunk, "\n")
		f := frame{}
		for _, ln := range lines {
			switch {
			case strings.HasPrefix(ln, "event: "):
				f.Event = strings.TrimPrefix(ln, "event: ")
			case strings.HasPrefix(ln, "data: "):
				raw := strings.TrimPrefix(ln, "data: ")
				if err := json.Unmarshal([]byte(raw), &f.Data); err != nil {
					t.Fatalf("decode data %q: %v", raw, err)
				}
			}
		}
		if f.Event == "" {
			continue
		}
		out = append(out, f)
	}
	return out
}

// realPipeline assembles the production parser/builder/entry/reach stack
// against a freshly extracted testdata project. The returned closure runs
// Run(ctx, ...) so individual tests can override only what they care about.
func realPipeline(t *testing.T, fixture string) (*orchestrator.Orchestrator, domain.ProjectID, cache.Manager) {
	t.Helper()

	mgr, err := cache.New(cache.Options{
		RootTmp:       filepath.Join(t.TempDir(), "sources"),
		RootCache:     filepath.Join(t.TempDir(), "cache"),
		IdleTTL:       time.Hour,
		SweepInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	src := filepath.Join("testdata", fixture)
	stat, err := os.Stat(src)
	if err != nil || !stat.IsDir() {
		t.Fatalf("missing fixture %q: %v", fixture, err)
	}
	project, err := mgr.NewProject(fixture, 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	if err := copyTree(src, project.SourcesDir); err != nil {
		t.Fatalf("copy fixture: %v", err)
	}

	o := orchestrator.New(orchestrator.Options{
		Cache:              mgr,
		Parser:             parser.New(mgr, nil),
		Builder:            graph.New(nil),
		Resolver:           entry.New(nil),
		Reach:              reach.New(nil),
		PartialChunkSize:   3,
		PartialMinInterval: 1 * time.Millisecond,
	})
	return o, project.Meta.ID, mgr
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o600)
	})
}

func TestPipelineHappy(t *testing.T) {
	o, id, mgr := realPipeline(t, "simple")
	rec := httptest.NewRecorder()
	stream, err := api.NewSSEStreamer(rec)
	if err != nil {
		t.Fatalf("NewSSEStreamer: %v", err)
	}
	if err := o.Run(context.Background(), id, domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream); err != nil {
		t.Fatalf("Run: %v", err)
	}

	frames := parseFrames(t, rec.Body.String())
	if len(frames) == 0 {
		t.Fatal("no SSE frames recorded")
	}

	// Required event types and their relative ordering.
	wantOrder := []string{
		"phase:loading",
		"phase:parsing",
		"phase:building_graph",
		"partial_graph",
		"phase:reachability",
		"phase:exporting",
		"done",
	}
	have := make([]string, 0, len(frames))
	for _, f := range frames {
		switch f.Event {
		case "phase":
			have = append(have, "phase:"+f.Data["phase"].(string))
		default:
			have = append(have, f.Event)
		}
	}
	cursor := 0
	for _, want := range wantOrder {
		found := false
		for ; cursor < len(have); cursor++ {
			if have[cursor] == want {
				found = true
				cursor++
				break
			}
		}
		if !found {
			t.Fatalf("missing event %q in observed sequence: %v", want, have)
		}
	}

	// seq is monotonic across the stream.
	prev := 0
	for i, f := range frames {
		seq := int(f.Data["seq"].(float64))
		if seq <= prev {
			t.Fatalf("frame %d seq %d not greater than %d", i, seq, prev)
		}
		prev = seq
	}

	last := frames[len(frames)-1]
	if last.Event != "done" {
		t.Fatalf("last event = %q, want done", last.Event)
	}
	if last.Data["phase"] != "done" {
		t.Fatalf("done.phase = %v, want done", last.Data["phase"])
	}
	if last.Data["elapsed_ms"].(float64) <= 0 {
		t.Fatalf("done.elapsed_ms = %v, want > 0", last.Data["elapsed_ms"])
	}
	nodeCount := int(last.Data["node_count"].(float64))
	edgeCount := int(last.Data["edge_count"].(float64))
	if nodeCount == 0 {
		t.Fatal("node_count must be positive on the simple fixture")
	}
	if edgeCount == 0 {
		t.Fatal("edge_count must be positive on the simple fixture")
	}

	// Graph artefact persisted to cache and matches the done summary.
	g, err := mgr.ReadGraph(id)
	if err != nil {
		t.Fatalf("ReadGraph: %v", err)
	}
	if len(g.Nodes) != nodeCount {
		t.Fatalf("graph.json node count %d != done.node_count %d", len(g.Nodes), nodeCount)
	}
	if len(g.Edges) != edgeCount {
		t.Fatalf("graph.json edge count %d != done.edge_count %d", len(g.Edges), edgeCount)
	}
	if got := last.Data["graph_url"]; got != "/api/projects/"+string(id)+"/graph" {
		t.Fatalf("graph_url = %v", got)
	}

	// Dead-code report persisted as well.
	dc, err := mgr.ReadDeadCode(id)
	if err != nil {
		t.Fatalf("ReadDeadCode: %v", err)
	}
	if dc.EntriesCount == 0 {
		t.Fatal("expected at least one dead-code entry on the simple fixture (NeverCalled)")
	}
	// Dead-code report must exclude stdlib / third-party noise. The simple
	// fixture's only internal-module dead symbol is internal/dead.NeverCalled,
	// so every reported entry must live under example.com/simple.
	for _, ent := range dc.Entries {
		if !strings.HasPrefix(ent.Package, "example.com/simple") {
			t.Fatalf("dead-code entry leaked external package: %+v", ent)
		}
	}

	// At least one node in the graph must be marked as entry (func main).
	entries := 0
	for _, n := range g.Nodes {
		if n.IsEntry {
			entries++
		}
	}
	if entries == 0 {
		t.Fatal("expected at least one IsEntry=true node after orchestrator run")
	}
}

func TestSingleFlightRejectsConcurrentRun(t *testing.T) {
	id := domain.NewProjectID()
	gate := make(chan struct{})
	release := make(chan struct{})

	parserStub := &fakeParser{
		loadFn: func(ctx context.Context, _ domain.ProjectID, progress chan<- float64) (*parser.LoadResult, error) {
			defer close(progress)
			close(gate)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			return &parser.LoadResult{}, nil
		},
	}
	o := orchestrator.New(orchestrator.Options{
		Cache:    &noopCache{},
		Parser:   parserStub,
		Builder:  &fakeBuilder{},
		Resolver: &fakeResolver{},
		Reach:    &fakeReach{},
	})

	rec1 := httptest.NewRecorder()
	stream1, _ := api.NewSSEStreamer(rec1)
	rec2 := httptest.NewRecorder()
	stream2, _ := api.NewSSEStreamer(rec2)

	var wg sync.WaitGroup
	wg.Add(1)
	var firstErr error
	go func() {
		defer wg.Done()
		firstErr = o.Run(context.Background(), id, domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream1)
	}()

	<-gate
	secondErr := o.Run(context.Background(), id, domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream2)
	close(release)
	wg.Wait()

	if firstErr != nil {
		t.Fatalf("first run returned %v", firstErr)
	}
	if !orchestrator.IsAnalysisInProgress(secondErr) {
		t.Fatalf("second run err = %v, want IsAnalysisInProgress", secondErr)
	}
	if !errors.Is(secondErr, domain.ErrAnalysisInProgress) {
		t.Fatalf("second run err must unwrap to domain.ErrAnalysisInProgress, got %v", secondErr)
	}
}

func TestSingleFlightReleasesAfterRun(t *testing.T) {
	id := domain.NewProjectID()
	o := orchestrator.New(orchestrator.Options{
		Cache:    &noopCache{},
		Parser:   &fakeParser{},
		Builder:  &fakeBuilder{},
		Resolver: &fakeResolver{},
		Reach:    &fakeReach{},
	})
	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		stream, _ := api.NewSSEStreamer(rec)
		if err := o.Run(context.Background(), id, domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream); err != nil {
			t.Fatalf("Run %d: %v", i, err)
		}
	}
}

func TestPanicRecoveryEmitsFailedDone(t *testing.T) {
	o := orchestrator.New(orchestrator.Options{
		Cache:  &noopCache{},
		Parser: &fakeParser{},
		Builder: &fakeBuilder{buildFn: func(_ context.Context, _ graph.BuildInput, progress chan<- float64) (*domain.Graph, error) {
			close(progress)
			panic("boom")
		}},
		Resolver: &fakeResolver{},
		Reach:    &fakeReach{},
	})
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	err := o.Run(context.Background(), domain.NewProjectID(), domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream)
	if err == nil {
		t.Fatal("Run should propagate the panic as an error")
	}
	frames := parseFrames(t, rec.Body.String())
	last := frames[len(frames)-1]
	if last.Event != "done" || last.Data["phase"] != "failed" {
		t.Fatalf("last frame = %+v, want done/failed", last)
	}
	envelope, ok := last.Data["error"].(map[string]any)
	if !ok {
		t.Fatalf("done.error missing or wrong type: %v", last.Data["error"])
	}
	if envelope["code"] != "internal" {
		t.Fatalf("error.code = %v", envelope["code"])
	}
}

func TestParserErrorEmitsFailedDone(t *testing.T) {
	parserErr := errors.New("parse exploded")
	o := orchestrator.New(orchestrator.Options{
		Cache: &noopCache{},
		Parser: &fakeParser{loadFn: func(_ context.Context, _ domain.ProjectID, progress chan<- float64) (*parser.LoadResult, error) {
			close(progress)
			return nil, parserErr
		}},
		Builder:  &fakeBuilder{},
		Resolver: &fakeResolver{},
		Reach:    &fakeReach{},
	})
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	if err := o.Run(context.Background(), domain.NewProjectID(), domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream); !errors.Is(err, parserErr) {
		t.Fatalf("Run err = %v, want %v", err, parserErr)
	}
	frames := parseFrames(t, rec.Body.String())
	last := frames[len(frames)-1]
	if last.Event != "done" || last.Data["phase"] != "failed" {
		t.Fatalf("last frame = %+v", last)
	}
	envelope := last.Data["error"].(map[string]any)
	if envelope["code"] != "parse_failed" {
		t.Fatalf("error.code = %v", envelope["code"])
	}
}

func TestContextCancelExitsCleanly(t *testing.T) {
	id := domain.NewProjectID()
	cancelled := make(chan struct{})
	parserStub := &fakeParser{loadFn: func(ctx context.Context, _ domain.ProjectID, progress chan<- float64) (*parser.LoadResult, error) {
		defer close(progress)
		select {
		case <-cancelled:
		case <-ctx.Done():
		}
		return nil, ctx.Err()
	}}
	o := orchestrator.New(orchestrator.Options{
		Cache:    &noopCache{},
		Parser:   parserStub,
		Builder:  &fakeBuilder{},
		Resolver: &fakeResolver{},
		Reach:    &fakeReach{},
	})

	ctx, cancel := context.WithCancel(context.Background())
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	done := make(chan error, 1)
	go func() {
		done <- o.Run(ctx, id, domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream)
	}()

	cancel()
	close(cancelled)

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run err = %v, want context.Canceled", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("orchestrator did not exit within 500ms after context cancel")
	}

	// A subsequent run on the same id must succeed — the per-id mutex must
	// have been released by the deferred Unlock.
	rec2 := httptest.NewRecorder()
	stream2, _ := api.NewSSEStreamer(rec2)
	o2 := orchestrator.New(orchestrator.Options{
		Cache:    &noopCache{},
		Parser:   &fakeParser{},
		Builder:  &fakeBuilder{},
		Resolver: &fakeResolver{},
		Reach:    &fakeReach{},
	})
	if err := o2.Run(context.Background(), id, domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream2); err != nil {
		t.Fatalf("second Run: %v", err)
	}
}

func TestWarningPassthrough(t *testing.T) {
	parserStub := &fakeParser{loadFn: func(_ context.Context, _ domain.ProjectID, progress chan<- float64) (*parser.LoadResult, error) {
		close(progress)
		return &parser.LoadResult{
			Warnings: []domain.Warning{{Code: "import_error", Message: "missing pkg foo", Package: "example.com/foo"}},
		}, nil
	}}
	o := orchestrator.New(orchestrator.Options{
		Cache:    &noopCache{},
		Parser:   parserStub,
		Builder:  &fakeBuilder{},
		Resolver: &fakeResolver{},
		Reach:    &fakeReach{},
	})
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	if err := o.Run(context.Background(), domain.NewProjectID(), domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream); err != nil {
		t.Fatalf("Run: %v", err)
	}
	frames := parseFrames(t, rec.Body.String())
	hasWarning := false
	for _, f := range frames {
		if f.Event == "warning" && f.Data["code"] == "import_error" {
			hasWarning = true
			break
		}
	}
	if !hasWarning {
		t.Fatalf("no import_error warning event in stream: %+v", frames)
	}
}

func TestPartialGraphChunking(t *testing.T) {
	g := &domain.Graph{}
	for i := 0; i < 7; i++ {
		g.Nodes = append(g.Nodes, domain.Node{ID: itoa(i), Name: itoa(i), Kind: domain.NodeKindFunc})
	}
	o := orchestrator.New(orchestrator.Options{
		Cache:              &noopCache{},
		Parser:             &fakeParser{},
		Builder:            &fakeBuilder{result: g},
		Resolver:           &fakeResolver{},
		Reach:              &fakeReach{},
		PartialChunkSize:   3,
		PartialMinInterval: 1 * time.Millisecond,
	})
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	if err := o.Run(context.Background(), domain.NewProjectID(), domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream); err != nil {
		t.Fatalf("Run: %v", err)
	}
	frames := parseFrames(t, rec.Body.String())
	partials := 0
	for _, f := range frames {
		if f.Event == "partial_graph" {
			partials++
			nodes := f.Data["nodes"].([]any)
			if len(nodes) > 3 {
				t.Fatalf("chunk size %d > 3", len(nodes))
			}
		}
	}
	if partials != 3 {
		t.Fatalf("partial_graph count = %d, want 3 chunks", partials)
	}
}

// TestPartialGraphChunkCap exercises the watchdog that prevents
// streamPartialGraph from emitting an unbounded number of throttled
// frames on huge graphs. With chunk size 10, a 1000-node graph would
// otherwise emit 100 frames spaced by PartialMinInterval, dominating
// the perceived analyze duration. The cap (PartialMaxChunks) inflates
// the chunk size so the total number of partial frames stays at most
// PartialMaxChunks.
func TestPartialGraphChunkCap(t *testing.T) {
	const total = 1000
	const chunkCap = 5
	g := &domain.Graph{}
	for i := 0; i < total; i++ {
		g.Nodes = append(g.Nodes, domain.Node{ID: itoa(i), Name: itoa(i), Kind: domain.NodeKindFunc})
	}
	o := orchestrator.New(orchestrator.Options{
		Cache:              &noopCache{},
		Parser:             &fakeParser{},
		Builder:            &fakeBuilder{result: g},
		Resolver:           &fakeResolver{},
		Reach:              &fakeReach{},
		PartialChunkSize:   10,
		PartialMaxChunks:   chunkCap,
		PartialMinInterval: 1 * time.Millisecond,
	})
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	if err := o.Run(context.Background(), domain.NewProjectID(), domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream); err != nil {
		t.Fatalf("Run: %v", err)
	}
	frames := parseFrames(t, rec.Body.String())
	partials := 0
	totalNodes := 0
	for _, f := range frames {
		if f.Event != "partial_graph" {
			continue
		}
		partials++
		nodes := f.Data["nodes"].([]any)
		totalNodes += len(nodes)
	}
	if partials > chunkCap {
		t.Fatalf("partial_graph count = %d, want <= %d", partials, chunkCap)
	}
	if partials == 0 {
		t.Fatalf("expected at least one partial_graph frame")
	}
	if totalNodes != total {
		t.Fatalf("aggregate nodes across partials = %d, want %d", totalNodes, total)
	}
}

// TestParsePhaseDeadlineExceeded asserts the parse watchdog cancels a
// stuck parser stage and surfaces a structured done:failed event whose
// error message points the user at the likely cause (deps download).
// Without the watchdog, a first-time upload of an unvendored project
// would block indefinitely while go list / go mod download streams
// archives for every transitive dep, with the FE showing only a
// "parsing" badge.
func TestParsePhaseDeadlineExceeded(t *testing.T) {
	o := orchestrator.New(orchestrator.Options{
		Cache: &noopCache{},
		Parser: &fakeParser{loadFn: func(ctx context.Context, _ domain.ProjectID, progress chan<- float64) (*parser.LoadResult, error) {
			defer close(progress)
			<-ctx.Done()
			return nil, ctx.Err()
		}},
		Builder:       &fakeBuilder{},
		Resolver:      &fakeResolver{},
		Reach:         &fakeReach{},
		ParseDeadline: 50 * time.Millisecond,
	})
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	err := o.Run(context.Background(), domain.NewProjectID(), domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream)
	if err == nil {
		t.Fatal("expected parse deadline error, got nil")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want wrapping context.DeadlineExceeded", err)
	}
	frames := parseFrames(t, rec.Body.String())
	last := frames[len(frames)-1]
	if last.Event != "done" || last.Data["phase"] != "failed" {
		t.Fatalf("last frame = %+v", last)
	}
	envelope := last.Data["error"].(map[string]any)
	if envelope["code"] != "parse_failed" {
		t.Fatalf("error.code = %v", envelope["code"])
	}
	msg, _ := envelope["message"].(string)
	if msg == "" || !strings.Contains(msg, "budget") {
		t.Fatalf("error.message = %q, want guidance about budget", msg)
	}
}

func TestNewPanicsOnMissingDependencies(t *testing.T) {
	cases := []struct {
		name string
		opts orchestrator.Options
	}{
		{"missing cache", orchestrator.Options{Parser: &fakeParser{}, Builder: &fakeBuilder{}, Resolver: &fakeResolver{}, Reach: &fakeReach{}}},
		{"missing parser", orchestrator.Options{Cache: &noopCache{}, Builder: &fakeBuilder{}, Resolver: &fakeResolver{}, Reach: &fakeReach{}}},
		{"missing builder", orchestrator.Options{Cache: &noopCache{}, Parser: &fakeParser{}, Resolver: &fakeResolver{}, Reach: &fakeReach{}}},
		{"missing resolver", orchestrator.Options{Cache: &noopCache{}, Parser: &fakeParser{}, Builder: &fakeBuilder{}, Reach: &fakeReach{}}},
		{"missing reach", orchestrator.Options{Cache: &noopCache{}, Parser: &fakeParser{}, Builder: &fakeBuilder{}, Resolver: &fakeResolver{}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Fatalf("expected panic for %s", tc.name)
				}
			}()
			orchestrator.New(tc.opts)
		})
	}
}

func TestRunRejectsNilStream(t *testing.T) {
	o := orchestrator.New(orchestrator.Options{
		Cache: &noopCache{}, Parser: &fakeParser{}, Builder: &fakeBuilder{},
		Resolver: &fakeResolver{}, Reach: &fakeReach{},
	})
	if err := o.Run(context.Background(), domain.NewProjectID(), domain.DefaultEntryPointSpec(), domain.DefaultFilters(), nil); err == nil {
		t.Fatal("expected error for nil stream")
	}
}

func TestResolverErrorEmitsFailedDone(t *testing.T) {
	resolverErr := errors.New("entry boom")
	o := orchestrator.New(orchestrator.Options{
		Cache:   &noopCache{},
		Parser:  &fakeParser{},
		Builder: &fakeBuilder{},
		Resolver: &fakeResolver{resolveFn: func(_ domain.EntryPointSpec, _ []parser.LivePackage, _ *domain.Graph) ([]string, []domain.Warning, error) {
			return nil, nil, resolverErr
		}},
		Reach: &fakeReach{},
	})
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	if err := o.Run(context.Background(), domain.NewProjectID(), domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream); !errors.Is(err, resolverErr) {
		t.Fatalf("Run err = %v, want %v", err, resolverErr)
	}
	frames := parseFrames(t, rec.Body.String())
	last := frames[len(frames)-1]
	if last.Event != "done" || last.Data["phase"] != "failed" {
		t.Fatalf("last frame = %+v", last)
	}
	envelope := last.Data["error"].(map[string]any)
	if envelope["code"] != "entry_failed" {
		t.Fatalf("error.code = %v", envelope["code"])
	}
}

func TestReachMarkErrorEmitsFailedDone(t *testing.T) {
	reachErr := errors.New("reach boom")
	o := orchestrator.New(orchestrator.Options{
		Cache:    &noopCache{},
		Parser:   &fakeParser{},
		Builder:  &fakeBuilder{},
		Resolver: &fakeResolver{},
		Reach:    &fakeReach{markFn: func(_ *domain.Graph, _ []string) error { return reachErr }},
	})
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	if err := o.Run(context.Background(), domain.NewProjectID(), domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream); !errors.Is(err, reachErr) {
		t.Fatalf("Run err = %v", err)
	}
	frames := parseFrames(t, rec.Body.String())
	last := frames[len(frames)-1]
	envelope := last.Data["error"].(map[string]any)
	if envelope["code"] != "reach_failed" {
		t.Fatalf("error.code = %v", envelope["code"])
	}
}

func TestExportFailureWriteGraphEmitsFailedDone(t *testing.T) {
	exportErr := errors.New("disk full")
	o := orchestrator.New(orchestrator.Options{
		Cache:    &failingCache{writeGraphErr: exportErr},
		Parser:   &fakeParser{},
		Builder:  &fakeBuilder{},
		Resolver: &fakeResolver{},
		Reach:    &fakeReach{},
	})
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	if err := o.Run(context.Background(), domain.NewProjectID(), domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream); !errors.Is(err, exportErr) {
		t.Fatalf("Run err = %v", err)
	}
	frames := parseFrames(t, rec.Body.String())
	last := frames[len(frames)-1]
	envelope := last.Data["error"].(map[string]any)
	if envelope["code"] != "export_failed" {
		t.Fatalf("error.code = %v", envelope["code"])
	}
}

func TestExportFailureWriteDeadCodeEmitsFailedDone(t *testing.T) {
	exportErr := errors.New("disk full dead")
	o := orchestrator.New(orchestrator.Options{
		Cache:    &failingCache{writeDeadCodeErr: exportErr},
		Parser:   &fakeParser{},
		Builder:  &fakeBuilder{},
		Resolver: &fakeResolver{},
		Reach:    &fakeReach{},
	})
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	if err := o.Run(context.Background(), domain.NewProjectID(), domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream); !errors.Is(err, exportErr) {
		t.Fatalf("Run err = %v", err)
	}
}

func TestTypesUnavailableSurfacesWarning(t *testing.T) {
	o := orchestrator.New(orchestrator.Options{
		Cache: &noopCache{},
		Parser: &fakeParser{loadFn: func(_ context.Context, _ domain.ProjectID, progress chan<- float64) (*parser.LoadResult, error) {
			close(progress)
			return &parser.LoadResult{TypesUnavailable: true, FromCache: true}, nil
		}},
		Builder:  &fakeBuilder{},
		Resolver: &fakeResolver{},
		Reach:    &fakeReach{},
	})
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	if err := o.Run(context.Background(), domain.NewProjectID(), domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream); err != nil {
		t.Fatalf("Run: %v", err)
	}
	frames := parseFrames(t, rec.Body.String())
	hasWarning := false
	for _, f := range frames {
		if f.Event == "warning" && f.Data["code"] == "types_unavailable" {
			hasWarning = true
		}
	}
	if !hasWarning {
		t.Fatal("expected types_unavailable warning when parser cache returns reduced view")
	}
}

func TestEntryResolverWarningPassthrough(t *testing.T) {
	o := orchestrator.New(orchestrator.Options{
		Cache:   &noopCache{},
		Parser:  &fakeParser{},
		Builder: &fakeBuilder{},
		Resolver: &fakeResolver{resolveFn: func(_ domain.EntryPointSpec, _ []parser.LivePackage, _ *domain.Graph) ([]string, []domain.Warning, error) {
			return nil, []domain.Warning{{Code: "no_auto_entry_points", Message: "no main"}}, nil
		}},
		Reach: &fakeReach{},
	})
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	if err := o.Run(context.Background(), domain.NewProjectID(), domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream); err != nil {
		t.Fatalf("Run: %v", err)
	}
	frames := parseFrames(t, rec.Body.String())
	for _, f := range frames {
		if f.Event == "warning" && f.Data["code"] == "no_auto_entry_points" {
			return
		}
	}
	t.Fatalf("expected no_auto_entry_points warning, frames=%v", frames)
}

// --- fakes ----------------------------------------------------------------

type fakeParser struct {
	loadFn func(ctx context.Context, id domain.ProjectID, progress chan<- float64) (*parser.LoadResult, error)
	// loadCalls / loadLiveCalls let assertions count which entry point the
	// orchestrator used. Bumped from Load and LoadLive respectively.
	loadCalls     int
	loadLiveCalls int
}

func (f *fakeParser) Load(ctx context.Context, id domain.ProjectID, progress chan<- float64) (*parser.LoadResult, error) {
	f.loadCalls++
	if f.loadFn != nil {
		return f.loadFn(ctx, id, progress)
	}
	if progress != nil {
		close(progress)
	}
	return &parser.LoadResult{}, nil
}

// LoadLive routes to the same fake hook as Load so existing tests stay green
// after the orchestrator switched to LoadLive for live-types analysis. The
// loadLiveCalls counter lets dedicated tests assert the orchestrator never
// falls back to the cache-friendly Load path.
func (f *fakeParser) LoadLive(ctx context.Context, id domain.ProjectID, progress chan<- float64) (*parser.LoadResult, error) {
	f.loadLiveCalls++
	if f.loadFn != nil {
		return f.loadFn(ctx, id, progress)
	}
	if progress != nil {
		close(progress)
	}
	return &parser.LoadResult{}, nil
}

type fakeBuilder struct {
	buildFn func(ctx context.Context, in graph.BuildInput, progress chan<- float64) (*domain.Graph, error)
	result  *domain.Graph
}

func (f *fakeBuilder) Build(ctx context.Context, in graph.BuildInput, progress chan<- float64) (*domain.Graph, error) {
	if f.buildFn != nil {
		return f.buildFn(ctx, in, progress)
	}
	if progress != nil {
		close(progress)
	}
	if f.result != nil {
		return f.result, nil
	}
	return &domain.Graph{}, nil
}

type fakeResolver struct {
	resolveFn func(spec domain.EntryPointSpec, pkgs []parser.LivePackage, g *domain.Graph) ([]string, []domain.Warning, error)
}

func (f *fakeResolver) Resolve(spec domain.EntryPointSpec, pkgs []parser.LivePackage, g *domain.Graph) ([]string, []domain.Warning, error) {
	if f.resolveFn != nil {
		return f.resolveFn(spec, pkgs, g)
	}
	return nil, nil, nil
}

type fakeReach struct {
	markFn     func(g *domain.Graph, entryIDs []string) error
	deadCodeFn func(g *domain.Graph) *domain.DeadCodeReport
}

func (f *fakeReach) Mark(g *domain.Graph, entryIDs []string) error {
	if f.markFn != nil {
		return f.markFn(g, entryIDs)
	}
	return nil
}

func (f *fakeReach) DeadCode(g *domain.Graph) *domain.DeadCodeReport {
	if f.deadCodeFn != nil {
		return f.deadCodeFn(g)
	}
	return &domain.DeadCodeReport{Entries: []domain.DeadCodeEntry{}}
}

type noopCache struct{}

func (noopCache) WriteGraph(_ domain.ProjectID, _ *domain.Graph) error             { return nil }
func (noopCache) WriteDeadCode(_ domain.ProjectID, _ *domain.DeadCodeReport) error { return nil }

type failingCache struct {
	writeGraphErr    error
	writeDeadCodeErr error
}

func (f *failingCache) WriteGraph(_ domain.ProjectID, _ *domain.Graph) error {
	return f.writeGraphErr
}
func (f *failingCache) WriteDeadCode(_ domain.ProjectID, _ *domain.DeadCodeReport) error {
	return f.writeDeadCodeErr
}

// TestRunUsesLoadLiveBypassingCache guards the fix for the cached-re-analyze
// regression: the orchestrator must never serve the cache-friendly Load path,
// because cache hits drop *types.Package data and the entry resolver then
// rejects every manual FQN as unresolvable. Asserting that LoadLive (and only
// LoadLive) was invoked keeps this contract enforceable in tests.
func TestRunUsesLoadLiveBypassingCache(t *testing.T) {
	id := domain.NewProjectID()
	parserStub := &fakeParser{}
	o := orchestrator.New(orchestrator.Options{
		Cache:    &noopCache{},
		Parser:   parserStub,
		Builder:  &fakeBuilder{},
		Resolver: &fakeResolver{},
		Reach:    &fakeReach{},
	})
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	if err := o.Run(context.Background(), id, domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if parserStub.loadLiveCalls != 1 {
		t.Fatalf("LoadLive calls = %d, want 1", parserStub.loadLiveCalls)
	}
	if parserStub.loadCalls != 0 {
		t.Fatalf("Load (cache-friendly) calls = %d, want 0 — orchestrator must bypass the parser cache", parserStub.loadCalls)
	}
}

// itoa is a dependency-free integer formatter mirrored from sse_test.go so the
// fake graph nodes carry stable string IDs.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
