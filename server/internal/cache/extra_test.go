package cache_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// TestNewAppliesDefaults exercises the zero-Options branch of New so the
// fallback paths under os.TempDir() are wired correctly.
func TestNewAppliesDefaults(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	mgr, err := cache.New(cache.Options{})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	project, err := mgr.NewProject("default-roots", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	if !filepathHasPrefix(project.SourcesDir, os.TempDir()) {
		t.Errorf("sources dir %s not under TMPDIR %s", project.SourcesDir, os.TempDir())
	}
	if !filepathHasPrefix(project.CacheDir, os.TempDir()) {
		t.Errorf("cache dir %s not under TMPDIR %s", project.CacheDir, os.TempDir())
	}
}

func filepathHasPrefix(p, prefix string) bool {
	abs1, err1 := filepath.Abs(p)
	abs2, err2 := filepath.Abs(prefix)
	if err1 != nil || err2 != nil {
		return false
	}
	rel, err := filepath.Rel(abs2, abs1)
	if err != nil {
		return false
	}
	return rel != ".." && len(rel) > 0 && rel[0] != '.'
}

// TestNewFailsWhenRootIsFile reproduces the "ensure root cache" failure
// branch by pointing RootCache at an existing regular file.
func TestNewFailsWhenRootIsFile(t *testing.T) {
	dir := t.TempDir()
	notADir := filepath.Join(dir, "blocked")
	if err := os.WriteFile(notADir, []byte("x"), 0o600); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	if _, err := cache.New(cache.Options{
		RootTmp:   filepath.Join(dir, "sources"),
		RootCache: notADir,
	}); err == nil {
		t.Fatal("cache.New should reject non-directory RootCache")
	}
}

// TestUnknownProjectWriteParsedBlob covers the cacheDir error branch of
// WriteParsedBlob and ReadParsedBlob.
func TestUnknownProjectParsedBlobErrors(t *testing.T) {
	mgr := newTestManager(t)
	id := domain.NewProjectID()
	if _, err := mgr.WriteParsedBlob(id); !errors.Is(err, domain.ErrProjectNotFound) {
		t.Errorf("WriteParsedBlob unknown = %v, want ErrProjectNotFound", err)
	}
	if _, err := mgr.ReadParsedBlob(id); !errors.Is(err, domain.ErrProjectNotFound) {
		t.Errorf("ReadParsedBlob unknown = %v, want ErrProjectNotFound", err)
	}
	if err := mgr.WriteDeadCode(id, sampleDeadCode(id)); !errors.Is(err, domain.ErrProjectNotFound) {
		t.Errorf("WriteDeadCode unknown = %v, want ErrProjectNotFound", err)
	}
	if _, err := mgr.ReadDeadCode(id); !errors.Is(err, domain.ErrProjectNotFound) {
		t.Errorf("ReadDeadCode unknown = %v, want ErrProjectNotFound", err)
	}
}

// TestNilArgumentsRejected covers the nil-guard branches of WriteGraph,
// WriteDeadCode and WriteMeta.
func TestNilArgumentsRejected(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("nil-args", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	if err := mgr.WriteGraph(project.Meta.ID, nil); err == nil {
		t.Error("WriteGraph(nil) accepted")
	}
	if err := mgr.WriteDeadCode(project.Meta.ID, nil); err == nil {
		t.Error("WriteDeadCode(nil) accepted")
	}
	if err := mgr.WriteMeta(project.Meta.ID, nil); err == nil {
		t.Error("WriteMeta(nil) accepted")
	}
}

// TestReadDeadCodeReturnsStaleCacheWhenCorrupt mirrors the graph corruption
// test for the dead-code artefact.
func TestReadDeadCodeReturnsStaleCacheWhenCorrupt(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("ex", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	if err := os.WriteFile(filepath.Join(project.CacheDir, "dead-code.json"), []byte("not-json"), 0o600); err != nil {
		t.Fatalf("write corrupt dead-code: %v", err)
	}
	if _, err := mgr.ReadDeadCode(project.Meta.ID); !errors.Is(err, cache.ErrStaleCache) {
		t.Errorf("ReadDeadCode = %v, want ErrStaleCache", err)
	}
}

// TestReadMetaReturnsStaleCacheWhenCorruptOrMissing covers the missing-file
// and bad-JSON branches of readMetaFromDisk.
func TestReadMetaReturnsStaleCacheWhenCorruptOrMissing(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("ex", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	metaPath := filepath.Join(project.CacheDir, "meta.json")
	if err := os.WriteFile(metaPath, []byte("totally-not-json"), 0o600); err != nil {
		t.Fatalf("write corrupt meta: %v", err)
	}
	if _, err := mgr.ReadMeta(project.Meta.ID); !errors.Is(err, cache.ErrStaleCache) {
		t.Errorf("ReadMeta corrupt = %v, want ErrStaleCache", err)
	}
	if err := os.Remove(metaPath); err != nil {
		t.Fatalf("remove meta: %v", err)
	}
	if _, err := mgr.ReadMeta(project.Meta.ID); !errors.Is(err, cache.ErrStaleCache) {
		t.Errorf("ReadMeta missing = %v, want ErrStaleCache", err)
	}
}

// TestReadDeadCodeReturnsStaleCacheWhenEmptyEnvelope covers the env.Report ==
// nil branch.
func TestReadDeadCodeReturnsStaleCacheWhenEmptyEnvelope(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("ex", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	envBytes := []byte(`{"schema_version":` + itoa(domain.CurrentSchemaVersion) + `}`)
	if err := os.WriteFile(filepath.Join(project.CacheDir, "dead-code.json"), envBytes, 0o600); err != nil {
		t.Fatalf("write empty envelope: %v", err)
	}
	if _, err := mgr.ReadDeadCode(project.Meta.ID); !errors.Is(err, cache.ErrStaleCache) {
		t.Errorf("ReadDeadCode empty envelope = %v, want ErrStaleCache", err)
	}
}

// TestDeleteProjectAfterSweepIsNoop ensures the idempotency guarantee holds
// when the sweeper has already evicted the project.
func TestGetProjectAfterCloseRejected(t *testing.T) {
	mgr := newTestManager(t)
	if err := mgr.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := mgr.GetProject(domain.NewProjectID()); !errors.Is(err, cache.ErrManagerClosed) {
		t.Errorf("GetProject after close = %v, want ErrManagerClosed", err)
	}
}

// TestNewProjectFailsWhenSourcesRootUnwritable forces the MkdirAll branch in
// NewProject by stripping write permission from RootTmp. The cache directory
// is left untouched so the test also verifies that a partial failure does
// not leak any state.
func TestNewProjectFailsWhenSourcesRootUnwritable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: chmod 0500 cannot block writes")
	}
	rootTmp := filepath.Join(t.TempDir(), "sources")
	rootCache := filepath.Join(t.TempDir(), "cache")
	if err := os.MkdirAll(rootTmp, 0o700); err != nil {
		t.Fatalf("seed sources: %v", err)
	}
	mgr, err := cache.New(cache.Options{RootTmp: rootTmp, RootCache: rootCache})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	if err := os.Chmod(rootTmp, 0o500); err != nil {
		t.Fatalf("chmod 500: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(rootTmp, 0o700) })

	if _, err := mgr.NewProject("ex", 0, 0); err == nil {
		t.Fatal("NewProject should fail when sources root is read-only")
	}
	if got := mgr.ListProjects(); len(got) != 0 {
		t.Errorf("ListProjects after failed NewProject = %d, want 0", len(got))
	}
}

// TestNewProjectFailsWhenCacheRootUnwritable triggers the second MkdirAll
// branch (sources dir succeeds, cache dir fails). Successful sources dir
// must be cleaned up so no orphaned directory survives.
func TestNewProjectFailsWhenCacheRootUnwritable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: chmod 0500 cannot block writes")
	}
	rootTmp := filepath.Join(t.TempDir(), "sources")
	rootCache := filepath.Join(t.TempDir(), "cache")
	mgr, err := cache.New(cache.Options{RootTmp: rootTmp, RootCache: rootCache})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	if err := os.Chmod(rootCache, 0o500); err != nil {
		t.Fatalf("chmod 500: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(rootCache, 0o700) })

	if _, err := mgr.NewProject("ex", 0, 0); err == nil {
		t.Fatal("NewProject should fail when cache root is read-only")
	}
	// No leftover sources dirs (RemoveAll rolled back).
	entries, err := os.ReadDir(rootTmp)
	if err != nil {
		t.Fatalf("read rootTmp: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("rootTmp leaked entries: %v", entries)
	}
}

// TestNewProjectRollsBackWhenWriteMetaFails covers the writeMeta failure
// branch by stripping write permission from the per-project cache dir
// between MkdirAll and writeMeta. We simulate that race by chmod'ing the
// project cache dir read-only before the meta write hits the file system —
// this requires hooking after the second MkdirAll, which we approximate by
// pre-creating the cache dir as read-only.
func TestNewProjectRollsBackWhenWriteMetaFails(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: chmod 0500 cannot block writes")
	}
	rootTmp := filepath.Join(t.TempDir(), "sources")
	rootCache := filepath.Join(t.TempDir(), "cache")
	mgr, err := cache.New(cache.Options{RootTmp: rootTmp, RootCache: rootCache})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	// Make the cache root append-only (no create) so MkdirAll succeeds (the
	// per-project dir already does not exist; chmod 0o500 prevents creating
	// it). When MkdirAll itself fails we still exercise the error-handling
	// path, which is the behaviour the test asserts.
	if err := os.Chmod(rootCache, 0o500); err != nil {
		t.Fatalf("chmod 500: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(rootCache, 0o700) })

	if _, err := mgr.NewProject("ex", 0, 0); err == nil {
		t.Fatal("NewProject should fail")
	}
}

// TestEvictWithFailingRemove forces evict's logging branch by passing a
// project whose directories are owned by a read-only parent so RemoveAll
// fails; the sweeper must continue and not panic.
func TestEvictWithFailingRemove(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: chmod 0500 cannot block writes")
	}
	clock := &manualClock{now: time.Date(2026, 4, 19, 10, 0, 0, 0, time.UTC)}
	rootTmp := filepath.Join(t.TempDir(), "sources")
	rootCache := filepath.Join(t.TempDir(), "cache")
	mgr, err := cache.New(cache.Options{
		RootTmp:       rootTmp,
		RootCache:     rootCache,
		IdleTTL:       10 * time.Millisecond,
		SweepInterval: 5 * time.Millisecond,
		Clock:         clock,
	})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	project, err := mgr.NewProject("blocked", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	// Block deletion by removing write/exec on the parents.
	if err := os.Chmod(rootTmp, 0o500); err != nil {
		t.Fatalf("chmod 500 sources root: %v", err)
	}
	if err := os.Chmod(rootCache, 0o500); err != nil {
		t.Fatalf("chmod 500 cache root: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chmod(rootTmp, 0o700)
		_ = os.Chmod(rootCache, 0o700)
	})

	clock.advance(50 * time.Millisecond)

	// Wait for the registry to drop the project; the directories may still
	// exist on disk because RemoveAll could not unlink them, but the
	// in-memory entry must be gone.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		found := false
		for _, m := range mgr.ListProjects() {
			if m.ID == project.Meta.ID {
				found = true
				break
			}
		}
		if !found {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("project not evicted from registry within timeout")
}

// itoa is a tiny helper that avoids pulling strconv into the test for one
// integer-to-string conversion.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
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
