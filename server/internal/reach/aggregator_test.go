package reach_test

import (
	"fmt"
	"testing"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/reach"
)

// makeLargeGraph fabricates a synthetic graph with three packages and a fixed
// number of children per package. It is used to assert the aggregator's
// behaviour on graphs that exceed the FR-18 threshold without spinning up the
// full parser pipeline.
func makeLargeGraph(packages []string, perPkg int) *domain.Graph {
	nodes := make([]domain.Node, 0, len(packages)*(perPkg+1))
	edges := make([]domain.Edge, 0)

	pkgIDs := make(map[string]string, len(packages))
	for _, pkg := range packages {
		id := domain.NodeID(pkg, "", "")
		pkgIDs[pkg] = id
		nodes = append(nodes, domain.Node{
			ID:       id,
			Name:     pkg,
			Kind:     domain.NodeKindPackage,
			Package:  pkg,
			Exported: true,
		})
		for i := 0; i < perPkg; i++ {
			name := fmt.Sprintf("Fn%d", i)
			childID := domain.NodeID(pkg, "", name)
			nodes = append(nodes, domain.Node{
				ID:        childID,
				Name:      name,
				Kind:      domain.NodeKindFunc,
				Package:   pkg,
				Reachable: i%3 == 0,
				File:      pkg + "/file.go",
				Line:      i + 1,
			})
			edges = append(edges, domain.Edge{
				ID:     domain.EdgeID(id, childID, domain.EdgeKindContains),
				Source: id,
				Target: childID,
				Kind:   domain.EdgeKindContains,
				Weight: 1,
			})
		}
	}

	// Cross-package import edges with weight 2 to verify weight summation
	// across multiple imports of the same target package.
	for i := 0; i < len(packages)-1; i++ {
		src := pkgIDs[packages[i]]
		tgt := pkgIDs[packages[i+1]]
		for j := 0; j < 2; j++ {
			edges = append(edges, domain.Edge{
				ID:     domain.EdgeID(src, tgt, domain.EdgeKindImports),
				Source: src,
				Target: tgt,
				Kind:   domain.EdgeKindImports,
				Weight: 1,
			})
		}
	}

	return &domain.Graph{
		Nodes:         nodes,
		Edges:         edges,
		SchemaVersion: domain.CurrentSchemaVersion,
	}
}

func TestAggregateReducesToPackageGraph(t *testing.T) {
	pkgs := []string{"example.com/m/a", "example.com/m/b", "example.com/m/c"}
	g := makeLargeGraph(pkgs, 500)
	if len(g.Nodes) <= 1000 {
		t.Fatalf("expected > 1000 nodes for FR-18 case, got %d", len(g.Nodes))
	}

	agg := reach.Aggregate(g)
	if agg == nil {
		t.Fatal("aggregate returned nil")
	}
	if len(agg.Nodes) != len(pkgs) {
		t.Fatalf("expected %d package nodes, got %d", len(pkgs), len(agg.Nodes))
	}
	for _, n := range agg.Nodes {
		if n.Kind != domain.NodeKindPackage {
			t.Fatalf("node %s kind=%s, want package", n.ID, n.Kind)
		}
		if n.ChildCount != 500 {
			t.Fatalf("node %s child_count=%d, want 500", n.ID, n.ChildCount)
		}
	}
}

func TestAggregateStableNodeIDs(t *testing.T) {
	pkgs := []string{"example.com/m/x", "example.com/m/y"}
	g := makeLargeGraph(pkgs, 10)
	agg := reach.Aggregate(g)

	for _, pkg := range pkgs {
		want := domain.NodeID(pkg, "", "")
		var found bool
		for _, n := range agg.Nodes {
			if n.ID == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("aggregated graph missing stable id %s for package %s", want, pkg)
		}
	}
}

func TestAggregateReachableIfAnyChildReachable(t *testing.T) {
	pkgPath := "example.com/single"
	g := &domain.Graph{
		Nodes: []domain.Node{
			{ID: "p", Kind: domain.NodeKindPackage, Name: "single", Package: pkgPath, Reachable: false},
			{ID: "f1", Kind: domain.NodeKindFunc, Name: "F1", Package: pkgPath, Reachable: false},
			{ID: "f2", Kind: domain.NodeKindFunc, Name: "F2", Package: pkgPath, Reachable: true},
		},
		SchemaVersion: domain.CurrentSchemaVersion,
	}
	agg := reach.Aggregate(g)
	if len(agg.Nodes) != 1 {
		t.Fatalf("expected 1 aggregate node, got %d", len(agg.Nodes))
	}
	if !agg.Nodes[0].Reachable {
		t.Fatal("package must be reachable when any child is")
	}
	if agg.Nodes[0].ChildCount != 2 {
		t.Fatalf("child_count=%d, want 2", agg.Nodes[0].ChildCount)
	}
}

func TestAggregateImportEdgesOnly(t *testing.T) {
	pkgs := []string{"example.com/m/a", "example.com/m/b"}
	g := makeLargeGraph(pkgs, 3)
	agg := reach.Aggregate(g)
	for _, e := range agg.Edges {
		if e.Kind != domain.EdgeKindImports {
			t.Fatalf("edge %+v: only imports allowed in aggregate", e)
		}
		if e.Source == e.Target {
			t.Fatalf("self-loop must be skipped: %+v", e)
		}
	}
	// Two imports collapsed into one edge with weight 2.
	if len(agg.Edges) != 1 {
		t.Fatalf("expected 1 aggregated import edge, got %d (%+v)", len(agg.Edges), agg.Edges)
	}
	if agg.Edges[0].Weight != 2 {
		t.Fatalf("expected weight=2 (sum of two source imports), got %d", agg.Edges[0].Weight)
	}
}

func TestAggregateStatsRecomputed(t *testing.T) {
	pkgs := []string{"example.com/a", "example.com/b", "example.com/c"}
	g := makeLargeGraph(pkgs, 4)
	// Mark first package's children to flip its Reachable flag.
	for i := range g.Nodes {
		if g.Nodes[i].Package == "example.com/a" {
			g.Nodes[i].Reachable = true
		} else {
			g.Nodes[i].Reachable = false
		}
	}
	agg := reach.Aggregate(g)
	if agg.Stats.NodeCount != 3 {
		t.Fatalf("Stats.NodeCount=%d, want 3", agg.Stats.NodeCount)
	}
	if agg.Stats.EdgeCount != len(agg.Edges) {
		t.Fatalf("Stats.EdgeCount=%d != len(Edges)=%d", agg.Stats.EdgeCount, len(agg.Edges))
	}
	if agg.Stats.DeadCount != 2 {
		t.Fatalf("Stats.DeadCount=%d, want 2", agg.Stats.DeadCount)
	}
	if agg.Stats.ByKind[domain.NodeKindPackage] != 3 {
		t.Fatalf("ByKind[package]=%d, want 3", agg.Stats.ByKind[domain.NodeKindPackage])
	}
}

func TestAggregateNilGraph(t *testing.T) {
	if got := reach.Aggregate(nil); got != nil {
		t.Fatalf("expected nil for nil input, got %+v", got)
	}
}

func TestAggregateEmptyGraph(t *testing.T) {
	g := &domain.Graph{SchemaVersion: domain.CurrentSchemaVersion}
	agg := reach.Aggregate(g)
	if len(agg.Nodes) != 0 || len(agg.Edges) != 0 {
		t.Fatalf("expected empty aggregate, got nodes=%d edges=%d", len(agg.Nodes), len(agg.Edges))
	}
}

func TestAggregateSyntheticBucketWithoutPackageNode(t *testing.T) {
	// Older or partial graphs may emit children without their package node.
	// The aggregator should still produce a sane bucket using the path.
	g := &domain.Graph{
		Nodes: []domain.Node{
			{ID: "f", Kind: domain.NodeKindFunc, Name: "F", Package: "example.com/x", Reachable: true},
		},
		SchemaVersion: domain.CurrentSchemaVersion,
	}
	agg := reach.Aggregate(g)
	if len(agg.Nodes) != 1 {
		t.Fatalf("expected 1 synthetic package node, got %d", len(agg.Nodes))
	}
	if agg.Nodes[0].Name != "x" {
		t.Fatalf("synthetic package should use trailing path component, got %q", agg.Nodes[0].Name)
	}
	if !agg.Nodes[0].Reachable {
		t.Fatal("synthetic bucket should inherit child reachability")
	}
	if agg.Nodes[0].ID != domain.NodeID("example.com/x", "", "") {
		t.Fatalf("synthetic id %s differs from canonical NodeID", agg.Nodes[0].ID)
	}
}

func TestAggregateDoesNotMutateInput(t *testing.T) {
	pkgs := []string{"example.com/m/a", "example.com/m/b"}
	g := makeLargeGraph(pkgs, 5)
	originalNodes := append([]domain.Node(nil), g.Nodes...)
	originalEdges := append([]domain.Edge(nil), g.Edges...)
	_ = reach.Aggregate(g)
	if len(g.Nodes) != len(originalNodes) || len(g.Edges) != len(originalEdges) {
		t.Fatal("aggregate must not resize input slices")
	}
	for i := range originalNodes {
		if g.Nodes[i] != originalNodes[i] {
			t.Fatalf("node %d mutated: %+v vs %+v", i, g.Nodes[i], originalNodes[i])
		}
	}
}
