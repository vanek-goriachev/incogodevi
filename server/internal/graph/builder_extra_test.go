package graph_test

import (
	"context"
	"testing"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/graph"
)

func TestBuildMultiPackage(t *testing.T) {
	g := buildGraph(t, loadFixture(t, "multi_pkg"))

	apiPkg := nodeByName(g, "api", domain.NodeKindPackage)
	libPkg := nodeByName(g, "lib", domain.NodeKindPackage)
	if apiPkg == nil || libPkg == nil {
		t.Fatalf("missing package nodes: api=%v lib=%v", apiPkg, libPkg)
	}
	if !hasEdge(g, apiPkg.ID, libPkg.ID, domain.EdgeKindImports) {
		t.Fatalf("expected imports edge api->lib")
	}

	run := nodeByName(g, "Run", domain.NodeKindFunc)
	bump := nodeByName(g, "Bump", domain.NodeKindFunc)
	if run == nil || bump == nil {
		t.Fatalf("missing func nodes: run=%v bump=%v", run, bump)
	}
	if !hasEdge(g, run.ID, bump.ID, domain.EdgeKindCalls) {
		t.Fatalf("expected cross-package calls edge Run->Bump")
	}

	// Cross-package var/const reads land as references-edges.
	pi := nodeByName(g, "Pi", domain.NodeKindConst)
	counter := nodeByName(g, "Counter", domain.NodeKindVar)
	label := nodeByName(g, "Label", domain.NodeKindConst)
	if pi == nil || counter == nil || label == nil {
		t.Fatalf("missing value nodes: pi=%v counter=%v label=%v", pi, counter, label)
	}
	if !hasEdge(g, run.ID, pi.ID, domain.EdgeKindReferences) {
		t.Fatalf("expected references edge Run->Pi")
	}
	if !hasEdge(g, run.ID, label.ID, domain.EdgeKindReferences) {
		t.Fatalf("expected references edge Run->Label")
	}

	// var/const are containment children of their owning package.
	if !hasEdge(g, libPkg.ID, counter.ID, domain.EdgeKindContains) {
		t.Fatalf("expected contains lib->Counter")
	}
	if !hasEdge(g, libPkg.ID, pi.ID, domain.EdgeKindContains) {
		t.Fatalf("expected contains lib->Pi")
	}
}

func TestBuildCallEdgeWeightDedup(t *testing.T) {
	g := buildGraph(t, loadFixture(t, "duplicate_calls"))
	caller := nodeByName(g, "Caller", domain.NodeKindFunc)
	callee := nodeByName(g, "Target", domain.NodeKindFunc)
	if caller == nil || callee == nil {
		t.Fatalf("missing func nodes: caller=%v callee=%v", caller, callee)
	}
	for _, e := range g.Edges {
		if e.Source == caller.ID && e.Target == callee.ID && e.Kind == domain.EdgeKindCalls {
			if e.Weight < 2 {
				t.Fatalf("expected weight >= 2 (Caller calls Target twice), got %d", e.Weight)
			}
			return
		}
	}
	t.Fatalf("expected calls edge Caller->Target")
}

func TestBuildHandlesBodylessFuncDecl(t *testing.T) {
	// Regression test for the nil-pointer crash in addCallsAndReferences
	// when a parsed file contains a function declaration without a body
	// (e.g. assembly-implemented helpers). Building used to panic; with
	// the nil-body guard in place it must succeed and still register the
	// declarations as Func nodes.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Build panicked on body-less FuncDecl: %v", r)
		}
	}()

	g := buildGraph(t, loadFixture(t, "funcdecl_nobody"))

	if extern := nodeByName(g, "extern", domain.NodeKindFunc); extern == nil {
		t.Fatalf("expected extern Func node to be present")
	}
	caller := nodeByName(g, "Caller", domain.NodeKindFunc)
	if caller == nil {
		t.Fatalf("expected Caller Func node to be present")
	}
}

func TestBuildOnReducedOnlyEmitsWarning(t *testing.T) {
	res := loadFixture(t, "simple")
	// Strip the live view so addPackage falls back to the no-types branch.
	res.LivePackages[0].Types = nil
	res.LivePackages[0].TypesInfo = nil
	res.LivePackages[0].Syntax = nil

	g, err := graph.New(nil).Build(context.Background(), graph.BuildInput{
		Packages: res.LivePackages,
		Reduced:  res.Packages,
	}, nil)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}

	found := false
	for _, w := range g.Warnings {
		if w.Code == "graph_skip_no_types" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected graph_skip_no_types warning, got %+v", g.Warnings)
	}
}
