package cache_test

import (
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// TestConcurrentWriteGraphReadGraphAtomicity hammers a single project with N
// writers and M readers in parallel. Because writeAtomic uses
// CreateTemp+Rename a reader must always observe a complete graph value, not
// a half-written one. The test asserts that every successful read decodes to
// one of the two known states (or to a fully equal version of either).
func TestConcurrentWriteGraphReadGraphAtomicity(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("race", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}

	graphV1 := sampleGraph()
	graphV1.Nodes[0].Name = "version-A"
	graphV2 := sampleGraph()
	graphV2.Nodes[0].Name = "version-B"

	// Seed with v1 so readers never observe ErrStaleCache.
	if err := mgr.WriteGraph(project.Meta.ID, graphV1); err != nil {
		t.Fatalf("seed WriteGraph: %v", err)
	}

	const writers = 50
	const readers = 50
	const iterations = 20
	var wg sync.WaitGroup
	var readFailures atomic.Int64
	var unexpected atomic.Int64

	wg.Add(writers + readers)
	for i := 0; i < writers; i++ {
		i := i
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				g := graphV1
				if (i+j)%2 == 0 {
					g = graphV2
				}
				if err := mgr.WriteGraph(project.Meta.ID, g); err != nil {
					unexpected.Add(1)
					t.Errorf("WriteGraph: %v", err)
					return
				}
			}
		}()
	}
	for i := 0; i < readers; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				got, err := mgr.ReadGraph(project.Meta.ID)
				if err != nil {
					if errors.Is(err, cache.ErrStaleCache) || errors.Is(err, cache.ErrSchemaMismatch) {
						readFailures.Add(1)
						unexpected.Add(1)
						t.Errorf("ReadGraph saw stale state: %v", err)
						return
					}
					unexpected.Add(1)
					t.Errorf("ReadGraph: %v", err)
					return
				}
				if !reflect.DeepEqual(got, graphV1) && !reflect.DeepEqual(got, graphV2) {
					unexpected.Add(1)
					t.Errorf("ReadGraph returned unexpected payload: %+v", got)
					return
				}
			}
		}()
	}
	wg.Wait()
	if readFailures.Load() != 0 {
		t.Fatalf("%d readers observed stale state — atomic write violated", readFailures.Load())
	}
	if unexpected.Load() != 0 {
		t.Fatalf("%d unexpected errors during race test", unexpected.Load())
	}
}

// TestConcurrentNewAndDeleteProjects exercises the manager-wide registry
// under contention. Each goroutine creates a project and immediately deletes
// it; the test ensures no panic / data race fires under -race and that the
// in-memory map is empty at the end.
func TestConcurrentNewAndDeleteProjects(t *testing.T) {
	mgr := newTestManager(t)
	const goroutines = 32
	const perGoroutine = 25

	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < perGoroutine; j++ {
				p, err := mgr.NewProject("race", 0, 0)
				if err != nil {
					t.Errorf("NewProject: %v", err)
					return
				}
				if err := mgr.DeleteProject(p.Meta.ID); err != nil {
					t.Errorf("DeleteProject: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()
	if got := mgr.ListProjects(); len(got) != 0 {
		t.Errorf("ListProjects after churn = %d, want 0", len(got))
	}
}

// TestAnalyzeMutexSerialisesPerProject confirms the AnalyzeMu lock embedded
// in *Project actually mediates exclusive access (this is what T13 will rely
// on). The test fails if the second goroutine grabs the mutex before the
// first releases it.
func TestAnalyzeMutexSerialisesPerProject(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("ex", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	var holders atomic.Int32
	start := make(chan struct{})

	const goroutines = 8
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			<-start
			project.AnalyzeMu.Lock()
			defer project.AnalyzeMu.Unlock()
			if got := holders.Add(1); got != 1 {
				t.Errorf("AnalyzeMu allowed %d concurrent holders", got)
			}
			holders.Add(-1)
		}()
	}
	close(start)
	wg.Wait()

	// And ParseOnce must run its callback exactly once even under contention.
	var ran atomic.Int32
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			project.ParseOnce.Do(func() { ran.Add(1) })
		}()
	}
	wg.Wait()
	if ran.Load() != 1 {
		t.Errorf("ParseOnce ran %d times, want 1", ran.Load())
	}

	if id := domain.ProjectID(project.Meta.ID); !id.IsValid() {
		t.Errorf("project ID lost validity: %q", id)
	}
}
