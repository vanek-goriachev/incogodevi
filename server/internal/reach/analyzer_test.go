package reach_test

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/entry"
	"github.com/vanek-goriachev/incogodevi/server/internal/graph"
	"github.com/vanek-goriachev/incogodevi/server/internal/parser"
	"github.com/vanek-goriachev/incogodevi/server/internal/reach"
)

// node is a tiny helper to build synthetic Node values without spelling out
// every field. Tests focus on Reachable/Kind, the rest is metadata.
func node(id, name string, kind domain.NodeKind, pkg string) domain.Node {
	return domain.Node{
		ID:       id,
		Name:     name,
		Kind:     kind,
		Package:  pkg,
		File:     pkg + "/" + name + ".go",
		Line:     1,
		Exported: true,
	}
}

// edge is the matching helper for Edge values.
func edge(src, tgt string, kind domain.EdgeKind) domain.Edge {
	return domain.Edge{
		ID:     domain.EdgeID(src, tgt, kind),
		Source: src,
		Target: tgt,
		Kind:   kind,
		Weight: 1,
	}
}

// graphFromNodes assembles a Graph and seeds Stats so tests can verify
// DeadCount updates.
func graphFromNodes(nodes []domain.Node, edges []domain.Edge) *domain.Graph {
	stats := domain.GraphStats{
		NodeCount: len(nodes),
		EdgeCount: len(edges),
		ByKind:    map[domain.NodeKind]int{},
	}
	for _, n := range nodes {
		stats.ByKind[n.Kind]++
	}
	return &domain.Graph{
		Nodes:         nodes,
		Edges:         edges,
		Stats:         stats,
		SchemaVersion: domain.CurrentSchemaVersion,
	}
}

func TestMarkLinearFromHead(t *testing.T) {
	g := graphFromNodes(
		[]domain.Node{
			node("a", "A", domain.NodeKindFunc, "pkg"),
			node("b", "B", domain.NodeKindFunc, "pkg"),
			node("c", "C", domain.NodeKindFunc, "pkg"),
		},
		[]domain.Edge{
			edge("a", "b", domain.EdgeKindCalls),
			edge("b", "c", domain.EdgeKindCalls),
		},
	)
	if err := reach.New(nil).Mark(g, []string{"a"}); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	for _, n := range g.Nodes {
		if !n.Reachable {
			t.Fatalf("node %s expected reachable", n.ID)
		}
	}
	if g.Stats.DeadCount != 0 {
		t.Fatalf("expected DeadCount=0, got %d", g.Stats.DeadCount)
	}
}

func TestMarkLinearFromMiddle(t *testing.T) {
	g := graphFromNodes(
		[]domain.Node{
			node("a", "A", domain.NodeKindFunc, "pkg"),
			node("b", "B", domain.NodeKindFunc, "pkg"),
			node("c", "C", domain.NodeKindFunc, "pkg"),
		},
		[]domain.Edge{
			edge("a", "b", domain.EdgeKindCalls),
			edge("b", "c", domain.EdgeKindCalls),
		},
	)
	if err := reach.New(nil).Mark(g, []string{"b"}); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	want := map[string]bool{"a": false, "b": true, "c": true}
	for _, n := range g.Nodes {
		if n.Reachable != want[n.ID] {
			t.Fatalf("node %s: reachable=%t want=%t", n.ID, n.Reachable, want[n.ID])
		}
	}
	if g.Stats.DeadCount != 1 {
		t.Fatalf("expected DeadCount=1, got %d", g.Stats.DeadCount)
	}
}

func TestMarkDisconnected(t *testing.T) {
	g := graphFromNodes(
		[]domain.Node{
			node("a", "A", domain.NodeKindFunc, "pkg"),
			node("b", "B", domain.NodeKindFunc, "pkg"),
			node("c", "C", domain.NodeKindFunc, "pkg"),
			node("d", "D", domain.NodeKindFunc, "pkg"),
		},
		nil,
	)
	if err := reach.New(nil).Mark(g, []string{"a", "b"}); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	want := map[string]bool{"a": true, "b": true, "c": false, "d": false}
	for _, n := range g.Nodes {
		if n.Reachable != want[n.ID] {
			t.Fatalf("node %s: reachable=%t want=%t", n.ID, n.Reachable, want[n.ID])
		}
	}
	if g.Stats.DeadCount != 2 {
		t.Fatalf("expected DeadCount=2, got %d", g.Stats.DeadCount)
	}
}

func TestMarkContainsParentToChildOnly(t *testing.T) {
	// Contains is unidirectional (parent → child) since R4-6: reaching a
	// child must NOT pull in its container or its container's siblings,
	// otherwise a single live method snowballs through its struct, package,
	// and every other symbol the package owns. Reaching the package, on the
	// other hand, exposes every contained member as live.
	g := graphFromNodes(
		[]domain.Node{
			node("p", "pkg", domain.NodeKindPackage, "pkg"),
			node("s", "S", domain.NodeKindStruct, "pkg"),
			node("m", "M", domain.NodeKindMethod, "pkg"),
			node("orphan", "Orphan", domain.NodeKindFunc, "pkg"),
		},
		[]domain.Edge{
			edge("p", "s", domain.EdgeKindContains),
			edge("s", "m", domain.EdgeKindContains),
			edge("p", "orphan", domain.EdgeKindContains),
		},
	)
	// Entry on the method only keeps the method itself alive.
	if err := reach.New(nil).Mark(g, []string{"m"}); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	wantFromMethod := map[string]bool{"p": false, "s": false, "m": true, "orphan": false}
	for _, n := range g.Nodes {
		if n.Reachable != wantFromMethod[n.ID] {
			t.Fatalf("entry=m: node %s reachable=%t want=%t", n.ID, n.Reachable, wantFromMethod[n.ID])
		}
	}

	// Entry on the package keeps every contained member alive.
	if err := reach.New(nil).Mark(g, []string{"p"}); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	wantFromPackage := map[string]bool{"p": true, "s": true, "m": true, "orphan": true}
	for _, n := range g.Nodes {
		if n.Reachable != wantFromPackage[n.ID] {
			t.Fatalf("entry=p: node %s reachable=%t want=%t", n.ID, n.Reachable, wantFromPackage[n.ID])
		}
	}
}

func TestMarkImplementsBidirectional(t *testing.T) {
	g := graphFromNodes(
		[]domain.Node{
			node("iface", "I", domain.NodeKindInterface, "pkg"),
			node("structA", "A", domain.NodeKindStruct, "pkg"),
			node("structB", "B", domain.NodeKindStruct, "pkg"),
		},
		[]domain.Edge{
			edge("structA", "iface", domain.EdgeKindImplements),
			edge("structB", "iface", domain.EdgeKindImplements),
		},
	)
	if err := reach.New(nil).Mark(g, []string{"iface"}); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	for _, n := range g.Nodes {
		if !n.Reachable {
			t.Fatalf("node %s expected reachable from interface entry", n.ID)
		}
	}
}

func TestMarkImportsNotTraversed(t *testing.T) {
	// A package importing another does not by itself prove that any symbol
	// inside the imported package is used; imports must not reach members.
	g := graphFromNodes(
		[]domain.Node{
			node("pa", "a", domain.NodeKindPackage, "a"),
			node("pb", "b", domain.NodeKindPackage, "b"),
			node("ab_func", "Helper", domain.NodeKindFunc, "b"),
		},
		[]domain.Edge{
			edge("pa", "pb", domain.EdgeKindImports),
			edge("pb", "ab_func", domain.EdgeKindContains),
		},
	)
	if err := reach.New(nil).Mark(g, []string{"pa"}); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	if !findNode(g, "pa").Reachable {
		t.Fatal("entry pa should be reachable")
	}
	if findNode(g, "pb").Reachable {
		t.Fatal("imports should not reach pb from pa")
	}
	if findNode(g, "ab_func").Reachable {
		t.Fatal("imports should not reach symbols in pb")
	}
}

func TestMarkUnknownEntryIDsSkipped(t *testing.T) {
	g := graphFromNodes(
		[]domain.Node{node("a", "A", domain.NodeKindFunc, "pkg")},
		nil,
	)
	if err := reach.New(nil).Mark(g, []string{"a", "ghost"}); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	if !g.Nodes[0].Reachable {
		t.Fatal("known entry should still be reachable")
	}
}

func TestMarkResetsExistingFlag(t *testing.T) {
	g := graphFromNodes(
		[]domain.Node{
			node("a", "A", domain.NodeKindFunc, "pkg"),
			node("b", "B", domain.NodeKindFunc, "pkg"),
		},
		nil,
	)
	g.Nodes[0].Reachable = true
	g.Nodes[1].Reachable = true
	if err := reach.New(nil).Mark(g, []string{"a"}); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	if !g.Nodes[0].Reachable {
		t.Fatal("a stays reachable")
	}
	if g.Nodes[1].Reachable {
		t.Fatal("b must be cleared on a fresh Mark")
	}
}

func TestMarkNilGraph(t *testing.T) {
	if err := reach.New(nil).Mark(nil, nil); err == nil {
		t.Fatal("expected error on nil graph")
	}
}

func TestMarkEmptyEntries(t *testing.T) {
	g := graphFromNodes(
		[]domain.Node{
			node("a", "A", domain.NodeKindFunc, "pkg"),
			node("b", "B", domain.NodeKindFunc, "pkg"),
		},
		[]domain.Edge{edge("a", "b", domain.EdgeKindCalls)},
	)
	if err := reach.New(nil).Mark(g, nil); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	for _, n := range g.Nodes {
		if n.Reachable {
			t.Fatalf("with no entries, %s must be dead", n.ID)
		}
	}
	if g.Stats.DeadCount != len(g.Nodes) {
		t.Fatalf("DeadCount=%d, want %d", g.Stats.DeadCount, len(g.Nodes))
	}
}

func TestDeadCodeReport(t *testing.T) {
	// Two packages so the entry's contains-chain stays inside its own
	// package (live), and the other package's struct/method land in the
	// report as expected dead entries.
	g := graphFromNodes(
		[]domain.Node{
			node("p1", "live", domain.NodeKindPackage, "live"),
			node("free", "Free", domain.NodeKindFunc, "live"),
			node("p2", "dead", domain.NodeKindPackage, "dead"),
			node("s", "S", domain.NodeKindStruct, "dead"),
			node("m", "Method", domain.NodeKindMethod, "dead"),
		},
		[]domain.Edge{
			edge("p1", "free", domain.EdgeKindContains),
			edge("p2", "s", domain.EdgeKindContains),
			edge("s", "m", domain.EdgeKindContains),
		},
	)
	if err := reach.New(nil).Mark(g, []string{"free"}); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	report := reach.New(nil).DeadCode(g)
	if report.EntriesCount != len(report.Entries) {
		t.Fatalf("EntriesCount=%d does not match Entries len=%d", report.EntriesCount, len(report.Entries))
	}
	// p2 (a package) is unreachable but excluded from the report. We expect
	// the struct + its method to surface, sorted by FQN.
	if report.EntriesCount != 2 {
		t.Fatalf("expected 2 dead entries, got %d (%+v)", report.EntriesCount, report.Entries)
	}
	wantFQNs := []string{"dead.S", "dead.S.Method"}
	got := []string{report.Entries[0].FQN, report.Entries[1].FQN}
	for i := range wantFQNs {
		if got[i] != wantFQNs[i] {
			t.Fatalf("entry[%d].FQN=%q, want %q (got=%v)", i, got[i], wantFQNs[i], got)
		}
	}
	if report.Entries[1].Kind != domain.NodeKindMethod {
		t.Fatalf("method entry has wrong kind: %s", report.Entries[1].Kind)
	}
	for _, e := range report.Entries {
		if e.Reason != "unreachable" {
			t.Fatalf("entry %s: reason=%q, want unreachable", e.FQN, e.Reason)
		}
	}
}

func TestDeadCodeReportSorted(t *testing.T) {
	g := graphFromNodes(
		[]domain.Node{
			node("z", "Z", domain.NodeKindFunc, "pkg"),
			node("a", "A", domain.NodeKindFunc, "pkg"),
			node("m", "M", domain.NodeKindFunc, "pkg"),
		},
		nil,
	)
	if err := reach.New(nil).Mark(g, nil); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	report := reach.New(nil).DeadCode(g)
	got := make([]string, 0, len(report.Entries))
	for _, e := range report.Entries {
		got = append(got, e.FQN)
	}
	if !sort.StringsAreSorted(got) {
		t.Fatalf("expected sorted FQNs, got %v", got)
	}
}

func TestDeadCodeIgnoresPackages(t *testing.T) {
	g := graphFromNodes(
		[]domain.Node{
			node("p", "p", domain.NodeKindPackage, "p"),
			node("dead", "Dead", domain.NodeKindFunc, "p"),
		},
		nil,
	)
	if err := reach.New(nil).Mark(g, nil); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	report := reach.New(nil).DeadCode(g)
	for _, e := range report.Entries {
		if e.Kind == domain.NodeKindPackage {
			t.Fatalf("packages must not appear in the dead-code report (got %+v)", e)
		}
	}
	if report.EntriesCount != 1 || report.Entries[0].FQN != "p.Dead" {
		t.Fatalf("expected single Dead entry, got %+v", report.Entries)
	}
}

func TestDeadCodeIgnoresExternal(t *testing.T) {
	g := graphFromNodes(
		[]domain.Node{
			node("p", "p", domain.NodeKindPackage, "p"),
			node("dead", "DeadOwn", domain.NodeKindFunc, "p"),
			{
				ID:       "ext",
				Name:     "DeadExt",
				Kind:     domain.NodeKindFunc,
				Package:  "fmt",
				File:     "fmt/print.go",
				Line:     1,
				Exported: true,
				External: true,
			},
		},
		nil,
	)
	if err := reach.New(nil).Mark(g, nil); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	report := reach.New(nil).DeadCode(g)
	for _, e := range report.Entries {
		if e.Package == "fmt" || e.Name == "DeadExt" {
			t.Fatalf("external node leaked into report: %+v", e)
		}
	}
	if report.EntriesCount != 1 || report.Entries[0].FQN != "p.DeadOwn" {
		t.Fatalf("expected single internal dead entry, got %+v", report.Entries)
	}
}

func TestDeadCodeNilGraph(t *testing.T) {
	r := reach.New(nil).DeadCode(nil)
	if r == nil {
		t.Fatal("expected non-nil report on nil graph")
	}
	if len(r.Entries) != 0 {
		t.Fatalf("expected zero entries, got %d", len(r.Entries))
	}
}

func TestDeadCodeFieldFQN(t *testing.T) {
	g := graphFromNodes(
		[]domain.Node{
			node("p", "p", domain.NodeKindPackage, "p"),
			node("s", "S", domain.NodeKindStruct, "p"),
			node("f", "Field", domain.NodeKindField, "p"),
		},
		[]domain.Edge{
			edge("p", "s", domain.EdgeKindContains),
			edge("s", "f", domain.EdgeKindContains),
		},
	)
	if err := reach.New(nil).Mark(g, nil); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	report := reach.New(nil).DeadCode(g)
	for _, e := range report.Entries {
		if e.Kind == domain.NodeKindField && e.FQN != "p.S.Field" {
			t.Fatalf("field FQN=%q, want %q", e.FQN, "p.S.Field")
		}
	}
}

func TestDeadCodeMethodWithoutParentFallback(t *testing.T) {
	// A method whose parent contains-edge is missing (synthetic graph).
	// formatFQN must fall back to "<pkg>.<name>" instead of panicking.
	g := graphFromNodes(
		[]domain.Node{
			node("orphan_m", "Orphan", domain.NodeKindMethod, "p"),
		},
		nil,
	)
	if err := reach.New(nil).Mark(g, nil); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	report := reach.New(nil).DeadCode(g)
	if len(report.Entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(report.Entries))
	}
	if report.Entries[0].FQN != "p.Orphan" {
		t.Fatalf("fallback FQN=%q, want %q", report.Entries[0].FQN, "p.Orphan")
	}
}

func TestDeadCodeEmptyWhenAllReachable(t *testing.T) {
	g := graphFromNodes(
		[]domain.Node{node("a", "A", domain.NodeKindFunc, "pkg")},
		nil,
	)
	if err := reach.New(nil).Mark(g, []string{"a"}); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	report := reach.New(nil).DeadCode(g)
	if report.EntriesCount != 0 {
		t.Fatalf("expected empty report, got %d entries", report.EntriesCount)
	}
}

// TestFR19Acceptance walks the full pipeline (parser -> graph -> entry ->
// reach) on a fixture whose dead set is known. The expected list lives in
// testdata/deadcode_case/expected.json so the fixture and the assertion stay
// in sync.
func TestFR19Acceptance(t *testing.T) {
	fx := loadFixture(t, "deadcode_case")

	res := entryNew(t)
	ids, _, err := res.Resolve(domain.EntryPointSpec{
		Mode:   domain.EntryPointModeManual,
		Manual: []string{"example.com/deadcase/app#Run"},
	}, fx.Pkgs, fx.Graph)
	if err != nil {
		t.Fatalf("entry.Resolve: %v", err)
	}

	if err := reach.New(nil).Mark(fx.Graph, ids); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	report := reach.New(nil).DeadCode(fx.Graph)

	gotByFQN := map[string]domain.DeadCodeEntry{}
	for _, e := range report.Entries {
		gotByFQN[e.FQN] = e
	}

	expected := loadExpectedDead(t, filepath.Join("testdata", "deadcode_case", "expected.json"))
	for _, want := range expected {
		got, ok := gotByFQN[want.FQN]
		if !ok {
			t.Fatalf("missing dead entry %q in report (have: %v)", want.FQN, fqnList(report.Entries))
		}
		if got.Kind != want.Kind {
			t.Errorf("entry %s: kind=%s, want %s", want.FQN, got.Kind, want.Kind)
		}
		if got.Reason != "unreachable" {
			t.Errorf("entry %s: reason=%s, want unreachable", want.FQN, got.Reason)
		}
	}
	if len(gotByFQN) != len(expected) {
		t.Fatalf("dead set size mismatch: got %d, want %d (got=%v want=%v)",
			len(gotByFQN), len(expected), fqnList(report.Entries), expectedFQNs(expected))
	}
}

func TestMarkConcurrentReads(t *testing.T) {
	g := graphFromNodes(
		[]domain.Node{
			node("a", "A", domain.NodeKindFunc, "pkg"),
			node("b", "B", domain.NodeKindFunc, "pkg"),
		},
		[]domain.Edge{edge("a", "b", domain.EdgeKindCalls)},
	)
	if err := reach.New(nil).Mark(g, []string{"a"}); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	// Concurrent read-only access to the marked graph: this protects against
	// regressions where Mark accidentally retained mutable shared state.
	done := make(chan struct{})
	for i := 0; i < 8; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			a := reach.New(nil)
			_ = a.DeadCode(g)
		}()
	}
	for i := 0; i < 8; i++ {
		<-done
	}
}

// --- helpers ---

func findNode(g *domain.Graph, id string) *domain.Node {
	for i := range g.Nodes {
		if g.Nodes[i].ID == id {
			return &g.Nodes[i]
		}
	}
	return nil
}

type fixture struct {
	Pkgs  []parser.LivePackage
	Graph *domain.Graph
}

func loadFixture(t *testing.T, name string) fixture {
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

	res, err := parser.New(mgr, nil).Load(context.Background(), project.Meta.ID, nil)
	if err != nil {
		t.Fatalf("parser.Load: %v", err)
	}
	if res.TypesUnavailable {
		t.Fatalf("expected live types from a fresh load")
	}

	g, err := graph.New(nil).Build(context.Background(), graph.BuildInput{
		Packages: res.LivePackages,
		Reduced:  res.Packages,
	}, nil)
	if err != nil {
		t.Fatalf("graph.Build: %v", err)
	}
	return fixture{Pkgs: res.LivePackages, Graph: g}
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// expected.json sits next to the Go sources but must not leak into
		// the temp project tree fed to packages.Load.
		if !d.IsDir() && filepath.Base(path) == "expected.json" {
			return nil
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

func entryNew(t *testing.T) *entry.Resolver {
	t.Helper()
	return entry.New(nil)
}

type expectedDead struct {
	FQN  string          `json:"fqn"`
	Kind domain.NodeKind `json:"kind"`
}

func loadExpectedDead(t *testing.T, path string) []expectedDead {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read expected.json: %v", err)
	}
	var out []expectedDead
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("decode expected.json: %v", err)
	}
	return out
}

func fqnList(entries []domain.DeadCodeEntry) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.FQN)
	}
	return out
}

func expectedFQNs(in []expectedDead) []string {
	out := make([]string, 0, len(in))
	for _, e := range in {
		out = append(out, e.FQN)
	}
	return out
}
