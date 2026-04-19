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

// waitGone polls until the path no longer exists or the deadline expires. It
// is used by the sweeper test which is timing-sensitive — the eviction
// happens on the goroutine's ticker tick, not synchronously.
func waitGone(t *testing.T, path string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("path %s still exists after %v", path, timeout)
}

func TestSweeperEvictsExpiredProjects(t *testing.T) {
	clock := &manualClock{now: time.Date(2026, 4, 19, 10, 0, 0, 0, time.UTC)}
	rootTmp := filepath.Join(t.TempDir(), "sources")
	rootCache := filepath.Join(t.TempDir(), "cache")
	mgr, err := cache.New(cache.Options{
		RootTmp:       rootTmp,
		RootCache:     rootCache,
		IdleTTL:       50 * time.Millisecond,
		SweepInterval: 10 * time.Millisecond,
		Clock:         clock,
	})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	stale, err := mgr.NewProject("stale", 0, 0)
	if err != nil {
		t.Fatalf("NewProject stale: %v", err)
	}
	fresh, err := mgr.NewProject("fresh", 0, 0)
	if err != nil {
		t.Fatalf("NewProject fresh: %v", err)
	}

	// Move the clock forward so only `stale` is past the TTL.
	clock.advance(100 * time.Millisecond)
	if _, err := mgr.GetProject(fresh.Meta.ID); err != nil {
		t.Fatalf("GetProject fresh: %v", err)
	}

	waitGone(t, stale.SourcesDir, 2*time.Second)
	waitGone(t, stale.CacheDir, 2*time.Second)

	if _, err := os.Stat(fresh.SourcesDir); err != nil {
		t.Fatalf("fresh sources removed prematurely: %v", err)
	}
	if _, err := os.Stat(fresh.CacheDir); err != nil {
		t.Fatalf("fresh cache removed prematurely: %v", err)
	}

	if _, err := mgr.GetProject(stale.Meta.ID); !errors.Is(err, domain.ErrProjectNotFound) {
		t.Errorf("GetProject stale after sweep = %v, want ErrProjectNotFound", err)
	}
	list := mgr.ListProjects()
	if len(list) != 1 || list[0].ID != fresh.Meta.ID {
		t.Errorf("ListProjects = %+v, want only fresh", list)
	}
}

func TestSweeperShutsDownOnClose(t *testing.T) {
	mgr, err := cache.New(cache.Options{
		RootTmp:       filepath.Join(t.TempDir(), "sources"),
		RootCache:     filepath.Join(t.TempDir(), "cache"),
		IdleTTL:       time.Hour,
		SweepInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	// Let the sweeper tick at least once before Close.
	time.Sleep(20 * time.Millisecond)
	done := make(chan error, 1)
	go func() { done <- mgr.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Close: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not return — sweeper did not shut down")
	}
}
