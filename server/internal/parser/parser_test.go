package parser_test

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/parser"
)

// fixtureProject copies one of the testdata trees into a fresh project owned
// by the supplied cache.Manager. It returns the new project ID so callers can
// invoke Parser.Load against it.
func fixtureProject(t *testing.T, mgr cache.Manager, fixture string) domain.ProjectID {
	t.Helper()
	src := filepath.Join("testdata", fixture)
	stat, err := os.Stat(src)
	if err != nil || !stat.IsDir() {
		t.Fatalf("missing fixture %q: %v", fixture, err)
	}

	project, err := mgr.NewProject(fixture, 0, 0)
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	if err := copyTree(src, project.SourcesDir); err != nil {
		t.Fatalf("copy fixture: %v", err)
	}
	return project.Meta.ID
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

// newManager builds a cache.Manager rooted at t.TempDir.
func newManager(t *testing.T) cache.Manager {
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
	return mgr
}

// drainProgress reads every value emitted on ch into the returned slice.
func drainProgress(ch <-chan float64) []float64 {
	var out []float64
	for v := range ch {
		out = append(out, v)
	}
	return out
}

func TestLoadHappy(t *testing.T) {
	mgr := newManager(t)
	id := fixtureProject(t, mgr, "simple")
	p := parser.New(mgr, nil)

	progress := make(chan float64, 64)
	var (
		wg    sync.WaitGroup
		ticks []float64
	)
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticks = drainProgress(progress)
	}()

	res, err := p.Load(context.Background(), id, progress)
	wg.Wait()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if res.FromCache {
		t.Fatalf("first Load should not be a cache hit")
	}
	if res.TypesUnavailable {
		t.Fatalf("first Load should expose live types")
	}

	want := map[string]bool{
		"example.com/simple/cmd/app":       true,
		"example.com/simple/internal/util": true,
	}
	for _, pkg := range res.Packages {
		delete(want, pkg.PkgPath)
	}
	if len(want) != 0 {
		t.Fatalf("missing project packages: %v", want)
	}

	utilPkg := findPkg(res.Packages, "example.com/simple/internal/util")
	if utilPkg == nil {
		t.Fatal("util package missing from result")
	}
	if findType(utilPkg, "Greeting") == nil {
		t.Fatalf("expected struct Greeting in util")
	}
	if findFunc(utilPkg, "Greet") == nil {
		t.Fatalf("expected func Greet in util")
	}

	mainPkg := findPkg(res.Packages, "example.com/simple/cmd/app")
	if mainPkg == nil {
		t.Fatal("main package missing from result")
	}
	if findConst(mainPkg, "Version") == nil {
		t.Fatal("expected const Version in main")
	}

	if len(ticks) == 0 {
		t.Fatal("no progress emitted")
	}
	if ticks[0] != 0.0 {
		t.Fatalf("first progress tick = %v, want 0.0", ticks[0])
	}
	if ticks[len(ticks)-1] != 1.0 {
		t.Fatalf("last progress tick = %v, want 1.0", ticks[len(ticks)-1])
	}
	if !sort.SliceIsSorted(ticks, func(i, j int) bool { return ticks[i] <= ticks[j] }) {
		t.Fatalf("progress not monotonic: %v", ticks)
	}
}

func TestLoadCached(t *testing.T) {
	mgr := newManager(t)
	id := fixtureProject(t, mgr, "simple")
	p := parser.New(mgr, nil)

	first, err := p.Load(context.Background(), id, nil)
	if err != nil {
		t.Fatalf("first Load: %v", err)
	}
	if first.FromCache {
		t.Fatal("first Load should be a miss")
	}

	progress := make(chan float64, 4)
	var ticks []float64
	done := make(chan struct{})
	go func() { ticks = drainProgress(progress); close(done) }()

	second, err := p.Load(context.Background(), id, progress)
	<-done
	if err != nil {
		t.Fatalf("second Load: %v", err)
	}
	if !second.FromCache {
		t.Fatalf("second Load should be served from cache")
	}
	if !second.TypesUnavailable {
		t.Fatalf("cache hit must mark TypesUnavailable=true")
	}
	if len(second.Packages) != len(first.Packages) {
		t.Fatalf("cached package count = %d, want %d", len(second.Packages), len(first.Packages))
	}
	if len(ticks) == 0 || ticks[len(ticks)-1] != 1.0 {
		t.Fatalf("cache hit progress tail not 1.0: %v", ticks)
	}
}

func TestLoadPartialWithWarnings(t *testing.T) {
	mgr := newManager(t)
	id := fixtureProject(t, mgr, "broken_import")
	p := parser.New(mgr, nil)

	res, err := p.Load(context.Background(), id, nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(res.Warnings) == 0 {
		t.Fatalf("expected at least one warning for broken import")
	}
	hasImportError := false
	for _, w := range res.Warnings {
		if w.Code == "import_error" {
			hasImportError = true
			break
		}
	}
	if !hasImportError {
		t.Fatalf("expected an import_error warning, got %+v", res.Warnings)
	}
	// The healthy sibling must still be in the snapshot.
	if findPkg(res.Packages, "example.com/broken/ok") == nil {
		t.Fatalf("healthy package not loaded; broken import aborted analysis")
	}
}

func TestContextCancel(t *testing.T) {
	mgr := newManager(t)
	id := fixtureProject(t, mgr, "simple")
	p := parser.New(mgr, nil)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := p.Load(ctx, id, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

func TestLoadInterfaceFixture(t *testing.T) {
	mgr := newManager(t)
	id := fixtureProject(t, mgr, "with_interfaces")
	p := parser.New(mgr, nil)

	res, err := p.Load(context.Background(), id, nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	pkg := findPkg(res.Packages, "example.com/zoo/animal")
	if pkg == nil {
		t.Fatalf("animal package missing")
	}
	speaker := findType(pkg, "Speaker")
	if speaker == nil || speaker.Kind != "interface" {
		t.Fatalf("Speaker should be an interface, got %+v", speaker)
	}
	dog := findType(pkg, "Dog")
	if dog == nil || dog.Kind != "struct" {
		t.Fatalf("Dog should be a struct, got %+v", dog)
	}
	if len(dog.Methods) == 0 {
		t.Fatalf("Dog must expose at least one method")
	}
}

func TestSchemaBumpInvalidatesCache(t *testing.T) {
	mgr := newManager(t)
	id := fixtureProject(t, mgr, "simple")
	p := parser.New(mgr, nil)

	if _, err := p.Load(context.Background(), id, nil); err != nil {
		t.Fatalf("first Load: %v", err)
	}

	// Replace the parsed.gob payload with an envelope from a different
	// schema version. The parser must treat that as a miss.
	wc, err := mgr.WriteParsedBlob(id)
	if err != nil {
		t.Fatalf("WriteParsedBlob: %v", err)
	}
	if _, err := io.WriteString(wc, "not a valid envelope"); err != nil {
		t.Fatalf("write garbage: %v", err)
	}
	if err := wc.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	res, err := p.Load(context.Background(), id, nil)
	if err != nil {
		t.Fatalf("Load after corruption: %v", err)
	}
	if res.FromCache {
		t.Fatalf("expected cache miss after corrupting the blob")
	}
}

// --- helpers ---

func findPkg(pkgs []*parser.ReducedPackage, path string) *parser.ReducedPackage {
	for _, p := range pkgs {
		if p.PkgPath == path {
			return p
		}
	}
	return nil
}

func findType(pkg *parser.ReducedPackage, name string) *parser.ReducedType {
	for i := range pkg.Types {
		if pkg.Types[i].Name == name {
			return &pkg.Types[i]
		}
	}
	return nil
}

func findFunc(pkg *parser.ReducedPackage, name string) *parser.ReducedFunc {
	for i := range pkg.Funcs {
		if pkg.Funcs[i].Name == name {
			return &pkg.Funcs[i]
		}
	}
	return nil
}

func findConst(pkg *parser.ReducedPackage, name string) *parser.ReducedValue {
	for i := range pkg.Consts {
		if pkg.Consts[i].Name == name {
			return &pkg.Consts[i]
		}
	}
	return nil
}
