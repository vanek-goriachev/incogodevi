package parser_test

import (
	"context"
	"encoding/gob"
	"errors"
	"io"
	"path/filepath"
	"testing"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/parser"
)

func TestNewPanicsOnNilManager(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic on nil manager")
		}
	}()
	_ = parser.New(nil, nil)
}

func TestLoadEmptySources(t *testing.T) {
	mgr := newManager(t)
	project, err := mgr.NewProject("empty", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	// Leave SourcesDir empty; packages.Load will return zero packages.
	p := parser.New(mgr, nil)
	progress := make(chan float64, 4)
	done := make(chan struct{})
	var ticks []float64
	go func() { ticks = drainProgress(progress); close(done) }()

	res, err := p.Load(context.Background(), project.Meta.ID, progress)
	<-done
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	// packages.Load may surface an empty pseudo-package with errors when the
	// directory contains no Go sources. We do not assert the exact count;
	// the contract is that the call succeeds and produces a final 1.0 tick.
	_ = res
	if len(ticks) < 2 || ticks[0] != 0.0 || ticks[len(ticks)-1] != 1.0 {
		t.Fatalf("expected at least [0,1] progress, got %v", ticks)
	}
}

func TestLoadMissingSourcesDir(t *testing.T) {
	mgr := newManager(t)
	id := domain.NewProjectID()
	p := parser.New(mgr, nil)
	_, err := p.Load(context.Background(), id, nil)
	if err == nil {
		t.Fatalf("expected error for unknown project id")
	}
}

func TestSchemaMismatchTriggersRebuild(t *testing.T) {
	mgr := newManager(t)
	id := fixtureProject(t, mgr, "simple")
	p := parser.New(mgr, nil)

	if _, err := p.Load(context.Background(), id, nil); err != nil {
		t.Fatalf("first Load: %v", err)
	}

	// Re-encode the blob with a deliberately wrong schema version so the
	// envelope decodes cleanly but the version check rejects it.
	type fakeEnvelope struct {
		SchemaVersion int
		Packages      []parser.ReducedPackage
	}
	wc, err := mgr.WriteParsedBlob(id)
	if err != nil {
		t.Fatalf("WriteParsedBlob: %v", err)
	}
	if err := gob.NewEncoder(wc).Encode(fakeEnvelope{SchemaVersion: 999}); err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := wc.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	res, err := p.Load(context.Background(), id, nil)
	if err != nil {
		t.Fatalf("Load after schema bump: %v", err)
	}
	if res.FromCache {
		t.Fatalf("schema mismatch should force a rebuild")
	}
}

func TestProgressMonotonicLargerProject(t *testing.T) {
	mgr := newManager(t)
	id := fixtureProject(t, mgr, "with_interfaces")
	p := parser.New(mgr, nil)

	progress := make(chan float64, 64)
	done := make(chan struct{})
	var ticks []float64
	go func() { ticks = drainProgress(progress); close(done) }()
	if _, err := p.Load(context.Background(), id, progress); err != nil {
		t.Fatalf("Load: %v", err)
	}
	<-done

	if len(ticks) < 2 {
		t.Fatalf("expected at least 2 ticks, got %v", ticks)
	}
	for i := 1; i < len(ticks); i++ {
		if ticks[i] < ticks[i-1] {
			t.Fatalf("progress regression at %d: %v", i, ticks)
		}
	}
}

// failingCache is a cache.Manager wrapper that overrides only the methods the
// parser exercises. The base manager handles the rest so tests stay focused
// on the failure scenario.
type failingCache struct {
	cache.Manager
	failWrite bool
	failRead  bool
}

func (f *failingCache) WriteParsedBlob(id domain.ProjectID) (io.WriteCloser, error) {
	if f.failWrite {
		return nil, errors.New("synthetic write failure")
	}
	return f.Manager.WriteParsedBlob(id)
}

func (f *failingCache) ReadParsedBlob(id domain.ProjectID) (io.ReadCloser, error) {
	if f.failRead {
		return nil, errors.New("synthetic read failure")
	}
	return f.Manager.ReadParsedBlob(id)
}

func TestLoadCacheWriteFailureSurfacesWarning(t *testing.T) {
	base, err := cache.New(cache.Options{
		RootTmp:       filepath.Join(t.TempDir(), "sources"),
		RootCache:     filepath.Join(t.TempDir(), "cache"),
		IdleTTL:       time.Hour,
		SweepInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() { _ = base.Close() })

	id := fixtureProject(t, base, "simple")
	failing := &failingCache{Manager: base, failWrite: true}
	p := parser.New(failing, nil)

	res, err := p.Load(context.Background(), id, nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	hasWarn := false
	for _, w := range res.Warnings {
		if w.Code == "cache_write_failed" {
			hasWarn = true
		}
	}
	if !hasWarn {
		t.Fatalf("expected cache_write_failed warning, got %+v", res.Warnings)
	}
}

func TestLoadCacheReadFailureFallsThrough(t *testing.T) {
	base, err := cache.New(cache.Options{
		RootTmp:       filepath.Join(t.TempDir(), "sources"),
		RootCache:     filepath.Join(t.TempDir(), "cache"),
		IdleTTL:       time.Hour,
		SweepInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() { _ = base.Close() })

	id := fixtureProject(t, base, "simple")
	failing := &failingCache{Manager: base, failRead: true}
	p := parser.New(failing, nil)

	res, err := p.Load(context.Background(), id, nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if res.FromCache {
		t.Fatalf("cache read failure must fall through to live load")
	}
}

func BenchmarkLoadSimple(b *testing.B) {
	mgr, err := cache.New(cache.Options{
		RootTmp:       filepath.Join(b.TempDir(), "sources"),
		RootCache:     filepath.Join(b.TempDir(), "cache"),
		IdleTTL:       time.Hour,
		SweepInterval: time.Hour,
	})
	if err != nil {
		b.Fatalf("cache.New: %v", err)
	}
	b.Cleanup(func() { _ = mgr.Close() })

	project, err := mgr.NewProject("bench", 0, 0)
	if err != nil {
		b.Fatalf("NewProject: %v", err)
	}
	if err := copyTree(filepath.Join("testdata", "simple"), project.SourcesDir); err != nil {
		b.Fatalf("copy: %v", err)
	}
	p := parser.New(mgr, nil)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := p.Load(context.Background(), project.Meta.ID, nil); err != nil {
			b.Fatalf("Load: %v", err)
		}
	}
}
