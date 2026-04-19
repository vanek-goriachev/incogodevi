package orchestrator_test

import (
	"context"
	"errors"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/vanek-goriachev/incogodevi/server/internal/api"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/orchestrator"
)

func TestPreflightValidate_OK(t *testing.T) {
	o := orchestrator.New(orchestrator.Options{
		Cache: &noopCache{}, Parser: &fakeParser{}, Builder: &fakeBuilder{},
		Resolver: &fakeResolver{}, Reach: &fakeReach{},
	})
	if err := o.PreflightValidate(domain.DefaultEntryPointSpec(), domain.DefaultFilters()); err != nil {
		t.Fatalf("default spec must pass preflight: %v", err)
	}
	good := domain.EntryPointSpec{
		Mode:          domain.EntryPointModeMixed,
		Manual:        []string{"example.com/foo#Handler", "example.com/foo#Handler.ServeHTTP"},
		InterfaceImpl: []string{"example.com/foo#Store"},
	}
	if err := o.PreflightValidate(good, domain.DefaultFilters()); err != nil {
		t.Fatalf("well-formed spec rejected: %v", err)
	}
}

func TestPreflightValidate_BadMode(t *testing.T) {
	o := orchestrator.New(orchestrator.Options{
		Cache: &noopCache{}, Parser: &fakeParser{}, Builder: &fakeBuilder{},
		Resolver: &fakeResolver{}, Reach: &fakeReach{},
	})
	spec := domain.EntryPointSpec{Mode: domain.EntryPointMode("nonsense")}
	err := o.PreflightValidate(spec, domain.DefaultFilters())
	if err == nil {
		t.Fatal("bad mode must fail preflight")
	}
	if !errors.Is(err, domain.ErrInvalidEntryPoint) {
		t.Fatalf("err must wrap ErrInvalidEntryPoint: %v", err)
	}
	var apiErr *domain.APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err must carry *domain.APIError: %v", err)
	}
	if apiErr.Code != "invalid_entry_point" {
		t.Fatalf("code = %q", apiErr.Code)
	}
}

func TestPreflightValidate_MalformedFQN(t *testing.T) {
	o := orchestrator.New(orchestrator.Options{
		Cache: &noopCache{}, Parser: &fakeParser{}, Builder: &fakeBuilder{},
		Resolver: &fakeResolver{}, Reach: &fakeReach{},
	})
	cases := []struct {
		name string
		spec domain.EntryPointSpec
	}{
		{"manual missing hash", domain.EntryPointSpec{Mode: domain.EntryPointModeManual, Manual: []string{"example.com/foo.Handler"}}},
		{"manual empty type", domain.EntryPointSpec{Mode: domain.EntryPointModeManual, Manual: []string{"example.com/foo#"}}},
		{"manual leading dot", domain.EntryPointSpec{Mode: domain.EntryPointModeManual, Manual: []string{"example.com/foo#.Method"}}},
		{"manual trailing dot", domain.EntryPointSpec{Mode: domain.EntryPointModeManual, Manual: []string{"example.com/foo#Type."}}},
		{"interface_impl with member", domain.EntryPointSpec{Mode: domain.EntryPointModeMixed, InterfaceImpl: []string{"example.com/foo#Iface.Method"}}},
		{"interface_impl empty", domain.EntryPointSpec{Mode: domain.EntryPointModeMixed, InterfaceImpl: []string{"  "}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := o.PreflightValidate(c.spec, domain.DefaultFilters())
			if err == nil {
				t.Fatal("malformed FQN must fail preflight")
			}
			if !errors.Is(err, domain.ErrInvalidEntryPoint) {
				t.Fatalf("err must wrap ErrInvalidEntryPoint: %v", err)
			}
		})
	}
}

func TestReserveSingleFlight(t *testing.T) {
	o := orchestrator.New(orchestrator.Options{
		Cache: &noopCache{}, Parser: &fakeParser{}, Builder: &fakeBuilder{},
		Resolver: &fakeResolver{}, Reach: &fakeReach{},
	})
	id := domain.NewProjectID()
	release, ok := o.Reserve(id)
	if !ok {
		t.Fatal("first Reserve must succeed")
	}
	_, ok = o.Reserve(id)
	if ok {
		t.Fatal("second Reserve must fail while first is held")
	}
	release()
	release2, ok := o.Reserve(id)
	if !ok {
		t.Fatal("Reserve must succeed after release")
	}
	release2()
}

func TestReserveReleaseIsIdempotent(t *testing.T) {
	o := orchestrator.New(orchestrator.Options{
		Cache: &noopCache{}, Parser: &fakeParser{}, Builder: &fakeBuilder{},
		Resolver: &fakeResolver{}, Reach: &fakeReach{},
	})
	id := domain.NewProjectID()
	release, ok := o.Reserve(id)
	if !ok {
		t.Fatal("Reserve failed")
	}
	release()
	release() // must not panic
}

func TestRunReservedSucceedsWithoutInternalReserve(t *testing.T) {
	id := domain.NewProjectID()
	o := orchestrator.New(orchestrator.Options{
		Cache: &noopCache{}, Parser: &fakeParser{}, Builder: &fakeBuilder{},
		Resolver: &fakeResolver{}, Reach: &fakeReach{},
	})
	release, ok := o.Reserve(id)
	if !ok {
		t.Fatal("Reserve failed")
	}
	defer release()
	rec := httptest.NewRecorder()
	stream, _ := api.NewSSEStreamer(rec)
	if err := o.RunReserved(context.Background(), id, domain.DefaultEntryPointSpec(), domain.DefaultFilters(), stream); err != nil {
		t.Fatalf("RunReserved returned %v", err)
	}
}

func TestRunReservedRejectsNilStream(t *testing.T) {
	o := orchestrator.New(orchestrator.Options{
		Cache: &noopCache{}, Parser: &fakeParser{}, Builder: &fakeBuilder{},
		Resolver: &fakeResolver{}, Reach: &fakeReach{},
	})
	if err := o.RunReserved(context.Background(), domain.NewProjectID(), domain.DefaultEntryPointSpec(), domain.DefaultFilters(), nil); err == nil {
		t.Fatal("RunReserved must reject nil stream")
	}
}

func TestReserveSurvivesConcurrency(t *testing.T) {
	o := orchestrator.New(orchestrator.Options{
		Cache: &noopCache{}, Parser: &fakeParser{}, Builder: &fakeBuilder{},
		Resolver: &fakeResolver{}, Reach: &fakeReach{},
	})
	id := domain.NewProjectID()
	const workers = 16
	var wg sync.WaitGroup
	wg.Add(workers)
	var winners int
	var mu sync.Mutex
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			release, ok := o.Reserve(id)
			if ok {
				mu.Lock()
				winners++
				mu.Unlock()
				release()
			}
		}()
	}
	wg.Wait()
	if winners == 0 {
		t.Fatal("at least one Reserve must succeed under contention")
	}
}
