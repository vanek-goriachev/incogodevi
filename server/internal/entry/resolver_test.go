package entry_test

import (
	"context"
	"errors"
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
)

// fixture bundles the parser snapshot and the built graph for a test fixture.
// Resolver tests need both: pkgs to drive Scope().Lookup, graph to look up
// implements- and contains-edges.
type fixture struct {
	Pkgs  []parser.LivePackage
	Graph *domain.Graph
}

// loadFixture mirrors the helper used by the graph package tests but also
// runs the GraphBuilder so the resolver has a populated graph to query.
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

func TestAutoSingleMain(t *testing.T) {
	fx := loadFixture(t, "manual") // "manual" fixture has no main; auto must yield zero ids
	ids, warns, err := entry.New(nil).Resolve(domain.DefaultEntryPointSpec(), fx.Pkgs, fx.Graph)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(ids) != 0 {
		t.Fatalf("expected zero auto entries, got %d (%v)", len(ids), ids)
	}
	if !hasWarning(warns, "no_auto_entry_points") {
		t.Fatalf("expected no_auto_entry_points warning, got %+v", warns)
	}
}

func TestAutoMultipleMain(t *testing.T) {
	fx := loadFixture(t, "main_multiple")
	ids, warns, err := entry.New(nil).Resolve(domain.DefaultEntryPointSpec(), fx.Pkgs, fx.Graph)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(warns) != 0 {
		t.Fatalf("expected no warnings, got %+v", warns)
	}
	wantA := domain.NodeID("example.com/multimain/cmd/a", "", "main")
	wantB := domain.NodeID("example.com/multimain/cmd/b", "", "main")
	if !contains(ids, wantA) || !contains(ids, wantB) {
		t.Fatalf("auto entries missing expected mains: ids=%v wantA=%s wantB=%s", ids, wantA, wantB)
	}
	if len(ids) != 2 {
		t.Fatalf("expected exactly 2 auto entries, got %d (%v)", len(ids), ids)
	}
	if !sort.StringsAreSorted(ids) {
		t.Fatalf("expected sorted ids, got %v", ids)
	}
}

func TestManualFunc(t *testing.T) {
	fx := loadFixture(t, "manual")
	spec := domain.EntryPointSpec{
		Mode:   domain.EntryPointModeManual,
		Manual: []string{"example.com/manual/api#Run"},
	}
	ids, _, err := entry.New(nil).Resolve(spec, fx.Pkgs, fx.Graph)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	want := domain.NodeID("example.com/manual/api", "", "Run")
	if !contains(ids, want) {
		t.Fatalf("expected free-function id %s, got %v", want, ids)
	}
	if len(ids) != 1 {
		t.Fatalf("expected exactly one manual id, got %v", ids)
	}
}

func TestManualMethod(t *testing.T) {
	fx := loadFixture(t, "manual")
	spec := domain.EntryPointSpec{
		Mode:   domain.EntryPointModeManual,
		Manual: []string{"example.com/manual/api#Handler.Serve"},
	}
	ids, _, err := entry.New(nil).Resolve(spec, fx.Pkgs, fx.Graph)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	want := domain.NodeID("example.com/manual/api", "Handler", "Serve")
	if !contains(ids, want) {
		t.Fatalf("expected method id %s, got %v", want, ids)
	}
}

func TestManualInvalid(t *testing.T) {
	fx := loadFixture(t, "manual")
	spec := domain.EntryPointSpec{
		Mode:   domain.EntryPointModeManual,
		Manual: []string{"example.com/manual/api#Nope", "example.com/manual/api#Handler.Missing"},
	}
	ids, _, err := entry.New(nil).Resolve(spec, fx.Pkgs, fx.Graph)
	if err == nil {
		t.Fatalf("expected error for invalid FQNs, got ids=%v", ids)
	}
	if !errors.Is(err, domain.ErrInvalidEntryPoint) {
		t.Fatalf("expected errors.Is(err, ErrInvalidEntryPoint), got %v", err)
	}
	apiErr, ok := err.(interface{ Error() string })
	if !ok {
		t.Fatalf("error does not satisfy basic interface: %T", err)
	}
	_ = apiErr

	var iee *entry.InvalidEntryPointError
	if !errors.As(err, &iee) {
		t.Fatalf("expected *InvalidEntryPointError, got %T", err)
	}
	if iee.Code != "invalid_entry_point" || iee.HTTPStatus != 400 {
		t.Fatalf("unexpected envelope: %+v", iee.APIError)
	}
	fqns, ok := iee.Details["fqns"].([]string)
	if !ok {
		t.Fatalf("expected details.fqns []string, got %T (%v)", iee.Details["fqns"], iee.Details["fqns"])
	}
	if len(fqns) != 2 {
		t.Fatalf("expected 2 invalid fqns, got %v", fqns)
	}
}

func TestManualMalformed(t *testing.T) {
	fx := loadFixture(t, "manual")
	cases := []string{
		"",
		"no-hash-here",
		"#starts-with-hash",
		"ends-with#",
		"pkg#.LeadingDot",
		"pkg#TrailingDot.",
	}
	for _, raw := range cases {
		spec := domain.EntryPointSpec{Mode: domain.EntryPointModeManual, Manual: []string{raw}}
		_, _, err := entry.New(nil).Resolve(spec, fx.Pkgs, fx.Graph)
		if err == nil {
			t.Fatalf("expected error for malformed FQN %q", raw)
		}
		if !errors.Is(err, domain.ErrInvalidEntryPoint) {
			t.Fatalf("FQN %q: want ErrInvalidEntryPoint, got %v", raw, err)
		}
	}
}

func TestInterfaceImpl(t *testing.T) {
	fx := loadFixture(t, "iface_impls")
	spec := domain.EntryPointSpec{
		Mode:          domain.EntryPointModeManual,
		Manual:        []string{},
		InterfaceImpl: []string{"example.com/ifaceimpls/store#Store"},
	}
	ids, _, err := entry.New(nil).Resolve(spec, fx.Pkgs, fx.Graph)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	wantMethods := []string{
		domain.NodeID("example.com/ifaceimpls/store", "MemStore", "Get"),
		domain.NodeID("example.com/ifaceimpls/store", "MemStore", "Put"),
		domain.NodeID("example.com/ifaceimpls/store", "FileStore", "Get"),
		domain.NodeID("example.com/ifaceimpls/store", "FileStore", "Put"),
	}
	for _, want := range wantMethods {
		if !contains(ids, want) {
			t.Fatalf("expected method id %s in interface_impl expansion; got %v", want, ids)
		}
	}
}

func TestInterfaceImplInvalid(t *testing.T) {
	fx := loadFixture(t, "iface_impls")
	spec := domain.EntryPointSpec{
		Mode:          domain.EntryPointModeManual,
		InterfaceImpl: []string{"example.com/ifaceimpls/store#NotAnIface"},
	}
	_, _, err := entry.New(nil).Resolve(spec, fx.Pkgs, fx.Graph)
	if !errors.Is(err, domain.ErrInvalidEntryPoint) {
		t.Fatalf("expected ErrInvalidEntryPoint, got %v", err)
	}
}

func TestMixedMode(t *testing.T) {
	fx := loadFixture(t, "main_multiple")
	spec := domain.EntryPointSpec{
		Mode:   domain.EntryPointModeMixed,
		Manual: []string{"example.com/multimain/lib#Helper"},
	}
	ids, _, err := entry.New(nil).Resolve(spec, fx.Pkgs, fx.Graph)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	wantA := domain.NodeID("example.com/multimain/cmd/a", "", "main")
	wantB := domain.NodeID("example.com/multimain/cmd/b", "", "main")
	wantH := domain.NodeID("example.com/multimain/lib", "", "Helper")
	for _, want := range []string{wantA, wantB, wantH} {
		if !contains(ids, want) {
			t.Fatalf("mixed mode missing id %s, got %v", want, ids)
		}
	}
}

func TestStability(t *testing.T) {
	fx := loadFixture(t, "main_multiple")
	spec := domain.EntryPointSpec{
		Mode:   domain.EntryPointModeMixed,
		Manual: []string{"example.com/multimain/lib#Helper"},
	}
	first, _, err := entry.New(nil).Resolve(spec, fx.Pkgs, fx.Graph)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, _, err := entry.New(nil).Resolve(spec, fx.Pkgs, fx.Graph)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if len(first) != len(second) {
		t.Fatalf("length drift: %d vs %d", len(first), len(second))
	}
	for i := range first {
		if first[i] != second[i] {
			t.Fatalf("id drift at %d: %s vs %s", i, first[i], second[i])
		}
	}
}

func TestUnknownMode(t *testing.T) {
	fx := loadFixture(t, "manual")
	spec := domain.EntryPointSpec{Mode: "wat"}
	_, _, err := entry.New(nil).Resolve(spec, fx.Pkgs, fx.Graph)
	if !errors.Is(err, domain.ErrInvalidEntryPoint) {
		t.Fatalf("expected ErrInvalidEntryPoint, got %v", err)
	}
}

func TestNilGraph(t *testing.T) {
	fx := loadFixture(t, "manual")
	_, _, err := entry.New(nil).Resolve(domain.DefaultEntryPointSpec(), fx.Pkgs, nil)
	if err == nil {
		t.Fatal("expected error on nil graph")
	}
}

func TestDuplicatesAreCollapsed(t *testing.T) {
	fx := loadFixture(t, "manual")
	spec := domain.EntryPointSpec{
		Mode:   domain.EntryPointModeManual,
		Manual: []string{"example.com/manual/api#Run", "example.com/manual/api#Run"},
	}
	ids, _, err := entry.New(nil).Resolve(spec, fx.Pkgs, fx.Graph)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(ids) != 1 {
		t.Fatalf("expected duplicates collapsed, got %v", ids)
	}
}

// --- helpers ---

func contains(haystack []string, needle string) bool {
	for _, h := range haystack {
		if h == needle {
			return true
		}
	}
	return false
}

func hasWarning(ws []domain.Warning, code string) bool {
	for _, w := range ws {
		if w.Code == code {
			return true
		}
	}
	return false
}
