package cache_test

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// newTestManager wires a Manager with two t.TempDir trees and the supplied
// options. The default IdleTTL is intentionally large so background sweeps do
// not interfere with non-sweeper tests.
func newTestManager(t *testing.T, override ...func(*cache.Options)) cache.Manager {
	t.Helper()
	opts := cache.Options{
		RootTmp:       filepath.Join(t.TempDir(), "sources"),
		RootCache:     filepath.Join(t.TempDir(), "cache"),
		IdleTTL:       time.Hour,
		SweepInterval: time.Hour,
	}
	for _, fn := range override {
		fn(&opts)
	}
	mgr, err := cache.New(opts)
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() {
		if err := mgr.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return mgr
}

func sampleGraph() *domain.Graph {
	return &domain.Graph{
		Nodes: []domain.Node{{
			ID:      "abc123",
			Name:    "Foo",
			Kind:    domain.NodeKindFunc,
			Package: "example.com/pkg",
			File:    "main.go",
			Line:    7,
		}},
		Edges: []domain.Edge{{
			ID:     "edge1",
			Source: "abc123",
			Target: "abc123",
			Kind:   domain.EdgeKindCalls,
			Weight: 1,
		}},
		Warnings: []domain.Warning{{Code: "test", Message: "ok"}},
		Stats: domain.GraphStats{
			NodeCount: 1,
			EdgeCount: 1,
			ByKind:    map[domain.NodeKind]int{domain.NodeKindFunc: 1},
		},
		SchemaVersion: domain.CurrentSchemaVersion,
	}
}

func sampleDeadCode(id domain.ProjectID) *domain.DeadCodeReport {
	return &domain.DeadCodeReport{
		ProjectID:    id,
		GeneratedAt:  time.Date(2026, 4, 19, 10, 0, 0, 0, time.UTC),
		EntriesCount: 1,
		Entries: []domain.DeadCodeEntry{{
			Kind:    domain.NodeKindFunc,
			FQN:     "example.com/pkg.Foo",
			Package: "example.com/pkg",
			Name:    "Foo",
			File:    "main.go",
			Line:    7,
			Reason:  "unreachable",
		}},
	}
}

func TestNewProjectCreatesDirectoriesWithSecurePermissions(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("acme/example", 1024, 10)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	if !project.Meta.ID.IsValid() {
		t.Fatalf("project ID %q is not valid", project.Meta.ID)
	}
	if project.Meta.Name != "acme/example" {
		t.Errorf("name = %q, want %q", project.Meta.Name, "acme/example")
	}
	if project.Meta.SizeBytes != 1024 || project.Meta.FileCount != 10 {
		t.Errorf("size/file count not preserved: %+v", project.Meta)
	}
	if project.Meta.SchemaVersion != domain.CurrentSchemaVersion {
		t.Errorf("schema version = %d, want %d", project.Meta.SchemaVersion, domain.CurrentSchemaVersion)
	}
	if project.Meta.ExpiresAt.Before(project.Meta.UploadedAt) {
		t.Errorf("expires_at %v before uploaded_at %v", project.Meta.ExpiresAt, project.Meta.UploadedAt)
	}

	for _, dir := range []string{project.SourcesDir, project.CacheDir} {
		info, err := os.Stat(dir)
		if err != nil {
			t.Fatalf("stat %s: %v", dir, err)
		}
		if !info.IsDir() {
			t.Fatalf("%s is not a directory", dir)
		}
		if perm := info.Mode().Perm(); perm != 0o700 {
			t.Errorf("%s perm = %#o, want 0700", dir, perm)
		}
	}

	// meta.json must exist and be readable via ReadMeta.
	meta, err := mgr.ReadMeta(project.Meta.ID)
	if err != nil {
		t.Fatalf("ReadMeta: %v", err)
	}
	if meta.ID != project.Meta.ID {
		t.Errorf("ReadMeta ID = %q, want %q", meta.ID, project.Meta.ID)
	}
}

func TestWriteAndReadGraphRoundTrip(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("example", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	want := sampleGraph()
	if err := mgr.WriteGraph(project.Meta.ID, want); err != nil {
		t.Fatalf("WriteGraph: %v", err)
	}
	got, err := mgr.ReadGraph(project.Meta.ID)
	if err != nil {
		t.Fatalf("ReadGraph: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("graph round-trip mismatch:\n got=%+v\nwant=%+v", got, want)
	}

	// File on disk must be valid JSON.
	graphPath := filepath.Join(project.CacheDir, "graph.json")
	raw, err := os.ReadFile(graphPath)
	if err != nil {
		t.Fatalf("read graph file: %v", err)
	}
	if len(raw) == 0 || raw[0] != '{' {
		t.Fatalf("graph.json does not look like JSON: %q", string(raw[:min(20, len(raw))]))
	}
}

func TestGraphMTime(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("example", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	if _, err := mgr.GraphMTime(project.Meta.ID); !errors.Is(err, domain.ErrNoGraphYet) {
		t.Fatalf("GraphMTime missing = %v, want ErrNoGraphYet", err)
	}
	if err := mgr.WriteGraph(project.Meta.ID, sampleGraph()); err != nil {
		t.Fatalf("WriteGraph: %v", err)
	}
	got, err := mgr.GraphMTime(project.Meta.ID)
	if err != nil {
		t.Fatalf("GraphMTime: %v", err)
	}
	if got.IsZero() || time.Since(got) > time.Minute {
		t.Errorf("GraphMTime returned %v, expected a recent timestamp", got)
	}
}

func TestWriteAndReadDeadCodeRoundTrip(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("example", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	want := sampleDeadCode(project.Meta.ID)
	if err := mgr.WriteDeadCode(project.Meta.ID, want); err != nil {
		t.Fatalf("WriteDeadCode: %v", err)
	}
	got, err := mgr.ReadDeadCode(project.Meta.ID)
	if err != nil {
		t.Fatalf("ReadDeadCode: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dead-code round-trip mismatch:\n got=%+v\nwant=%+v", got, want)
	}
}

func TestParsedBlobRoundTrip(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("example", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	wc, err := mgr.WriteParsedBlob(project.Meta.ID)
	if err != nil {
		t.Fatalf("WriteParsedBlob: %v", err)
	}
	payload := []byte("parsed-snapshot-bytes")
	if _, err := wc.Write(payload); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := wc.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	rc, err := mgr.ReadParsedBlob(project.Meta.ID)
	if err != nil {
		t.Fatalf("ReadParsedBlob: %v", err)
	}
	defer func() {
		if err := rc.Close(); err != nil {
			t.Errorf("close parsed blob: %v", err)
		}
	}()
	got, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("read all: %v", err)
	}
	if string(got) != string(payload) {
		t.Errorf("parsed blob = %q, want %q", got, payload)
	}
}

func TestReadGraphReturnsNoGraphYetWhenMissing(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("example", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	if _, err := mgr.ReadGraph(project.Meta.ID); !errors.Is(err, domain.ErrNoGraphYet) {
		t.Fatalf("missing graph returned %v, want ErrNoGraphYet", err)
	}
	if _, err := mgr.ReadDeadCode(project.Meta.ID); !errors.Is(err, domain.ErrNoGraphYet) {
		t.Fatalf("missing dead-code returned %v, want ErrNoGraphYet", err)
	}
	if _, err := mgr.ReadParsedBlob(project.Meta.ID); !errors.Is(err, cache.ErrStaleCache) {
		t.Fatalf("missing parsed blob returned %v, want ErrStaleCache", err)
	}
}

func TestReadGraphReturnsStaleCacheWhenCorrupt(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("example", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	graphPath := filepath.Join(project.CacheDir, "graph.json")
	if err := os.WriteFile(graphPath, []byte("not json"), 0o600); err != nil {
		t.Fatalf("write corrupt graph: %v", err)
	}
	_, err = mgr.ReadGraph(project.Meta.ID)
	if !errors.Is(err, cache.ErrStaleCache) {
		t.Fatalf("corrupt graph returned %v, want ErrStaleCache", err)
	}
}

func TestUnknownProjectReturnsErrProjectNotFound(t *testing.T) {
	mgr := newTestManager(t)
	id := domain.NewProjectID()
	if _, err := mgr.GetProject(id); !errors.Is(err, domain.ErrProjectNotFound) {
		t.Errorf("GetProject = %v, want ErrProjectNotFound", err)
	}
	if _, err := mgr.ReadMeta(id); !errors.Is(err, domain.ErrProjectNotFound) {
		t.Errorf("ReadMeta = %v, want ErrProjectNotFound", err)
	}
	if _, err := mgr.ReadGraph(id); !errors.Is(err, domain.ErrProjectNotFound) {
		t.Errorf("ReadGraph = %v, want ErrProjectNotFound", err)
	}
	if err := mgr.WriteGraph(id, sampleGraph()); !errors.Is(err, domain.ErrProjectNotFound) {
		t.Errorf("WriteGraph = %v, want ErrProjectNotFound", err)
	}
}

func TestGetProjectRefreshesLastAccessAt(t *testing.T) {
	clock := &manualClock{now: time.Date(2026, 4, 19, 10, 0, 0, 0, time.UTC)}
	mgr := newTestManager(t, func(o *cache.Options) {
		o.Clock = clock
	})
	project, err := mgr.NewProject("ex", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	first := project.Meta.LastAccessAt
	clock.advance(15 * time.Minute)

	got, err := mgr.GetProject(project.Meta.ID)
	if err != nil {
		t.Fatalf("GetProject: %v", err)
	}
	if !got.Meta.LastAccessAt.After(first) {
		t.Fatalf("LastAccessAt did not move: first=%v, got=%v", first, got.Meta.LastAccessAt)
	}

	// meta.json on disk must reflect the refreshed LastAccessAt.
	meta, err := mgr.ReadMeta(project.Meta.ID)
	if err != nil {
		t.Fatalf("ReadMeta: %v", err)
	}
	if !meta.LastAccessAt.Equal(got.Meta.LastAccessAt) {
		t.Fatalf("meta.json LastAccessAt = %v, want %v", meta.LastAccessAt, got.Meta.LastAccessAt)
	}
}

func TestListProjectsOrderedByUploadedAtDescending(t *testing.T) {
	clock := &manualClock{now: time.Date(2026, 4, 19, 10, 0, 0, 0, time.UTC)}
	mgr := newTestManager(t, func(o *cache.Options) {
		o.Clock = clock
	})
	first, err := mgr.NewProject("first", 1, 1)
	if err != nil {
		t.Fatalf("NewProject first: %v", err)
	}
	clock.advance(time.Minute)
	second, err := mgr.NewProject("second", 2, 2)
	if err != nil {
		t.Fatalf("NewProject second: %v", err)
	}
	clock.advance(time.Minute)
	third, err := mgr.NewProject("third", 3, 3)
	if err != nil {
		t.Fatalf("NewProject third: %v", err)
	}

	list := mgr.ListProjects()
	if len(list) != 3 {
		t.Fatalf("len(list) = %d, want 3", len(list))
	}
	wantOrder := []domain.ProjectID{third.Meta.ID, second.Meta.ID, first.Meta.ID}
	for i, want := range wantOrder {
		if list[i].ID != want {
			t.Errorf("list[%d] = %s, want %s", i, list[i].ID, want)
		}
	}
}

func TestDeleteProjectIsIdempotent(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("ex", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	if err := mgr.DeleteProject(project.Meta.ID); err != nil {
		t.Fatalf("first DeleteProject: %v", err)
	}
	if err := mgr.DeleteProject(project.Meta.ID); err != nil {
		t.Fatalf("second DeleteProject (idempotent): %v", err)
	}
	// Both directories should be gone.
	if _, err := os.Stat(project.SourcesDir); !os.IsNotExist(err) {
		t.Errorf("sources dir still exists: %v", err)
	}
	if _, err := os.Stat(project.CacheDir); !os.IsNotExist(err) {
		t.Errorf("cache dir still exists: %v", err)
	}
	// Subsequent operations on deleted project must report not-found.
	if _, err := mgr.GetProject(project.Meta.ID); !errors.Is(err, domain.ErrProjectNotFound) {
		t.Errorf("GetProject after delete = %v, want ErrProjectNotFound", err)
	}
}

func TestSourcesDirReturnsPathEvenForUnknown(t *testing.T) {
	mgr := newTestManager(t)
	id := domain.NewProjectID()
	got := mgr.SourcesDir(id)
	if got == "" {
		t.Fatalf("SourcesDir returned empty path")
	}
	// And for known projects it points to the actual dir.
	project, err := mgr.NewProject("ex", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	if mgr.SourcesDir(project.Meta.ID) != project.SourcesDir {
		t.Errorf("SourcesDir for known project diverged")
	}
}

func TestCloseTwiceIsSafe(t *testing.T) {
	mgr := newTestManager(t)
	if err := mgr.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := mgr.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if _, err := mgr.NewProject("after-close", 0, 0); !errors.Is(err, cache.ErrManagerClosed) {
		t.Errorf("NewProject after Close = %v, want ErrManagerClosed", err)
	}
}

func TestWriteMetaUpdatesInMemoryAndDisk(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("orig", 1, 1)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	updated := project.Meta
	updated.Name = "renamed"
	updated.SizeBytes = 9999
	if err := mgr.WriteMeta(project.Meta.ID, &updated); err != nil {
		t.Fatalf("WriteMeta: %v", err)
	}
	got, err := mgr.ReadMeta(project.Meta.ID)
	if err != nil {
		t.Fatalf("ReadMeta: %v", err)
	}
	if got.Name != "renamed" || got.SizeBytes != 9999 {
		t.Errorf("ReadMeta = %+v, want renamed/9999", got)
	}
	// WriteMeta on missing project → ErrProjectNotFound.
	if err := mgr.WriteMeta(domain.NewProjectID(), &updated); !errors.Is(err, domain.ErrProjectNotFound) {
		t.Errorf("WriteMeta unknown = %v, want ErrProjectNotFound", err)
	}
}

// manualClock is a deterministic Clock used by sweeper and time-sensitive
// tests. It is goroutine-safe so the background sweeper may read while the
// test driver advances time.
type manualClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *manualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *manualClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}
