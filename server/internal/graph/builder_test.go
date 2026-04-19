package graph_test

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/graph"
	"github.com/vanek-goriachev/incogodevi/server/internal/parser"
)

// loadFixture copies testdata/<name> into a fresh project, runs the parser
// and returns the resulting LoadResult ready to be fed to Builder.Build.
func loadFixture(t *testing.T, name string) *parser.LoadResult {
	t.Helper()

	src := filepath.Join("testdata", name)
	stat, err := os.Stat(src)
	if err != nil || !stat.IsDir() {
		t.Fatalf("missing fixture %q: %v", name, err)
	}

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

	project, err := mgr.NewProject(name, 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	if err := copyTree(src, project.SourcesDir); err != nil {
		t.Fatalf("copy fixture: %v", err)
	}

	p := parser.New(mgr, nil)
	res, err := p.Load(context.Background(), project.Meta.ID, nil)
	if err != nil {
		t.Fatalf("parser.Load: %v", err)
	}
	if res.TypesUnavailable {
		t.Fatalf("expected live types from a fresh load")
	}
	return res
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

func buildGraph(t *testing.T, res *parser.LoadResult) *domain.Graph {
	t.Helper()
	b := graph.New(nil)
	g, err := b.Build(context.Background(), graph.BuildInput{
		Packages: res.LivePackages,
		Reduced:  res.Packages,
	}, nil)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return g
}

func TestBuildSimpleChain(t *testing.T) {
	g := buildGraph(t, loadFixture(t, "simple"))

	if g.SchemaVersion != domain.CurrentSchemaVersion {
		t.Fatalf("schema version = %d, want %d", g.SchemaVersion, domain.CurrentSchemaVersion)
	}
	pkg := nodeByName(g, "simple", domain.NodeKindPackage)
	if pkg == nil {
		t.Fatal("expected package node 'simple'")
	}
	for _, name := range []string{"A", "B", "C"} {
		if nodeByName(g, name, domain.NodeKindFunc) == nil {
			t.Fatalf("expected func node %q", name)
		}
	}
	// Three contains-edges (package -> A,B,C) plus two calls (A->B, B->C).
	contains := countEdges(g, domain.EdgeKindContains)
	calls := countEdges(g, domain.EdgeKindCalls)
	if contains < 3 {
		t.Fatalf("contains edges = %d, want >= 3", contains)
	}
	if calls < 2 {
		t.Fatalf("calls edges = %d, want >= 2", calls)
	}
}

func TestBuildEdges(t *testing.T) {
	g := buildGraph(t, loadFixture(t, "simple"))
	a := nodeByName(g, "A", domain.NodeKindFunc)
	b := nodeByName(g, "B", domain.NodeKindFunc)
	c := nodeByName(g, "C", domain.NodeKindFunc)
	if a == nil || b == nil || c == nil {
		t.Fatalf("missing func nodes: a=%v b=%v c=%v", a, b, c)
	}

	if !hasEdge(g, a.ID, b.ID, domain.EdgeKindCalls) {
		t.Fatalf("expected calls edge A->B")
	}
	if !hasEdge(g, b.ID, c.ID, domain.EdgeKindCalls) {
		t.Fatalf("expected calls edge B->C")
	}
	if hasEdge(g, c.ID, a.ID, domain.EdgeKindCalls) {
		t.Fatalf("did not expect calls edge C->A")
	}
}

func TestBuildNodeCounts(t *testing.T) {
	g := buildGraph(t, loadFixture(t, "with_struct"))
	want := map[domain.NodeKind]int{
		domain.NodeKindPackage:   1,
		domain.NodeKindStruct:    1,
		domain.NodeKindInterface: 0,
		domain.NodeKindFunc:      0,
		domain.NodeKindMethod:    2, // Area + Scale
		domain.NodeKindField:     2, // Width + Height
		domain.NodeKindVar:       0,
		domain.NodeKindConst:     0,
	}
	for kind, n := range want {
		if got := g.Stats.ByKind[kind]; got != n {
			t.Fatalf("kind %q count = %d, want %d (full: %+v)", kind, got, n, g.Stats.ByKind)
		}
	}

	// Containment: package -> Box, Area, Scale; Box -> Width, Height.
	box := nodeByName(g, "Box", domain.NodeKindStruct)
	if box == nil {
		t.Fatal("expected struct Box")
	}
	width := nodeByName(g, "Width", domain.NodeKindField)
	height := nodeByName(g, "Height", domain.NodeKindField)
	if width == nil || height == nil {
		t.Fatalf("missing field nodes: width=%v height=%v", width, height)
	}
	if !hasEdge(g, box.ID, width.ID, domain.EdgeKindContains) {
		t.Fatalf("expected contains Box->Width")
	}
	if !hasEdge(g, box.ID, height.ID, domain.EdgeKindContains) {
		t.Fatalf("expected contains Box->Height")
	}

	pkgID := nodeByName(g, "withstruct", domain.NodeKindPackage).ID
	if !hasEdge(g, pkgID, box.ID, domain.EdgeKindContains) {
		t.Fatalf("expected contains package->Box")
	}
}

func TestBuildEmbedded(t *testing.T) {
	g := buildGraph(t, loadFixture(t, "embedded"))

	outer := nodeByName(g, "Outer", domain.NodeKindStruct)
	inner := nodeByName(g, "Inner", domain.NodeKindStruct)
	if outer == nil || inner == nil {
		t.Fatalf("missing struct nodes: outer=%v inner=%v", outer, inner)
	}
	if !hasEdge(g, outer.ID, inner.ID, domain.EdgeKindEmbeds) {
		t.Fatalf("expected embeds edge Outer->Inner")
	}

	reader := nodeByName(g, "Reader", domain.NodeKindInterface)
	super := nodeByName(g, "SuperReader", domain.NodeKindInterface)
	if reader == nil || super == nil {
		t.Fatalf("missing interface nodes: reader=%v super=%v", reader, super)
	}
	if !hasEdge(g, super.ID, reader.ID, domain.EdgeKindEmbeds) {
		t.Fatalf("expected embeds edge SuperReader->Reader")
	}
}

func TestStableIDs(t *testing.T) {
	res := loadFixture(t, "with_struct")
	first := buildGraph(t, res)
	second := buildGraph(t, res)

	if len(first.Nodes) != len(second.Nodes) {
		t.Fatalf("node count drift: %d vs %d", len(first.Nodes), len(second.Nodes))
	}
	a := indexNodeIDs(first.Nodes)
	b := indexNodeIDs(second.Nodes)
	for id := range a {
		if !b[id] {
			t.Fatalf("node id %q missing in second build", id)
		}
	}

	if len(first.Edges) != len(second.Edges) {
		t.Fatalf("edge count drift: %d vs %d", len(first.Edges), len(second.Edges))
	}
	for i := range first.Edges {
		if first.Edges[i].ID != second.Edges[i].ID {
			t.Fatalf("edge[%d] id drift: %s vs %s", i, first.Edges[i].ID, second.Edges[i].ID)
		}
	}
}

func TestProgressChannelClosed(t *testing.T) {
	res := loadFixture(t, "simple")
	progress := make(chan float64, 16)

	var (
		wg    sync.WaitGroup
		ticks []float64
	)
	wg.Add(1)
	go func() {
		defer wg.Done()
		for v := range progress {
			ticks = append(ticks, v)
		}
	}()

	if _, err := graph.New(nil).Build(context.Background(), graph.BuildInput{
		Packages: res.LivePackages,
		Reduced:  res.Packages,
	}, progress); err != nil {
		t.Fatalf("Build: %v", err)
	}
	wg.Wait()

	if len(ticks) == 0 {
		t.Fatal("no progress emitted")
	}
	if ticks[0] != 0.0 {
		t.Fatalf("first tick = %v, want 0.0", ticks[0])
	}
	if ticks[len(ticks)-1] != 1.0 {
		t.Fatalf("last tick = %v, want 1.0", ticks[len(ticks)-1])
	}
	if !sort.SliceIsSorted(ticks, func(i, j int) bool { return ticks[i] <= ticks[j] }) {
		t.Fatalf("progress not monotonic: %v", ticks)
	}
}

func TestBuildContextCanceled(t *testing.T) {
	res := loadFixture(t, "simple")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := graph.New(nil).Build(ctx, graph.BuildInput{
		Packages: res.LivePackages,
		Reduced:  res.Packages,
	}, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

func TestBuildEmptyInput(t *testing.T) {
	g, err := graph.New(nil).Build(context.Background(), graph.BuildInput{}, nil)
	if err != nil {
		t.Fatalf("Build empty: %v", err)
	}
	if g.Stats.NodeCount != 0 || g.Stats.EdgeCount != 0 {
		t.Fatalf("expected empty graph, got %+v", g.Stats)
	}
	for _, k := range domain.AllNodeKinds {
		if _, ok := g.Stats.ByKind[k]; !ok {
			t.Fatalf("ByKind missing entry for %q", k)
		}
	}
}

// --- helpers ---

func nodeByName(g *domain.Graph, name string, kind domain.NodeKind) *domain.Node {
	for i := range g.Nodes {
		if g.Nodes[i].Name == name && g.Nodes[i].Kind == kind {
			return &g.Nodes[i]
		}
	}
	return nil
}

func countEdges(g *domain.Graph, kind domain.EdgeKind) int {
	n := 0
	for i := range g.Edges {
		if g.Edges[i].Kind == kind {
			n++
		}
	}
	return n
}

func hasEdge(g *domain.Graph, src, tgt string, kind domain.EdgeKind) bool {
	for i := range g.Edges {
		e := g.Edges[i]
		if e.Source == src && e.Target == tgt && e.Kind == kind {
			return true
		}
	}
	return false
}

func indexNodeIDs(nodes []domain.Node) map[string]bool {
	out := make(map[string]bool, len(nodes))
	for i := range nodes {
		out[nodes[i].ID] = true
	}
	return out
}
