package graph_test

import (
	"context"
	"errors"
	"sort"
	"sync"
	"testing"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/graph"
)

func TestImplementsSingleImpl(t *testing.T) {
	g := buildGraph(t, loadFixture(t, "iface_single_impl"))

	iface := nodeByName(g, "Greeter", domain.NodeKindInterface)
	english := nodeByName(g, "EnglishGreeter", domain.NodeKindStruct)
	french := nodeByName(g, "FrenchGreeter", domain.NodeKindStruct)
	if iface == nil || english == nil || french == nil {
		t.Fatalf("missing nodes: iface=%v english=%v french=%v", iface, english, french)
	}

	if !hasEdge(g, english.ID, iface.ID, domain.EdgeKindImplements) {
		t.Fatalf("expected implements edge EnglishGreeter -> Greeter")
	}
	if !hasEdge(g, french.ID, iface.ID, domain.EdgeKindImplements) {
		t.Fatalf("expected implements edge FrenchGreeter -> Greeter")
	}
	if hasEdge(g, iface.ID, iface.ID, domain.EdgeKindImplements) {
		t.Fatalf("interface must not implement itself")
	}
}

func TestImplementsEmbedded(t *testing.T) {
	g := buildGraph(t, loadFixture(t, "iface_embedded"))

	iface := nodeByName(g, "Worker", domain.NodeKindInterface)
	outer := nodeByName(g, "Outer", domain.NodeKindStruct)
	inner := nodeByName(g, "Inner", domain.NodeKindStruct)
	if iface == nil || outer == nil || inner == nil {
		t.Fatalf("missing nodes: iface=%v outer=%v inner=%v", iface, outer, inner)
	}
	if !hasEdge(g, inner.ID, iface.ID, domain.EdgeKindImplements) {
		t.Fatalf("expected implements edge Inner -> Worker (pointer receiver)")
	}
	if !hasEdge(g, outer.ID, iface.ID, domain.EdgeKindImplements) {
		t.Fatalf("expected implements edge Outer -> Worker (via embedded *Inner)")
	}
}

func TestImplementsAlias(t *testing.T) {
	g := buildGraph(t, loadFixture(t, "iface_alias"))

	iface := nodeByName(g, "Greeter", domain.NodeKindInterface)
	concrete := nodeByName(g, "Concrete", domain.NodeKindStruct)
	if iface == nil || concrete == nil {
		t.Fatalf("missing nodes: iface=%v concrete=%v", iface, concrete)
	}
	if !hasEdge(g, concrete.ID, iface.ID, domain.EdgeKindImplements) {
		t.Fatalf("expected implements edge Concrete -> Greeter")
	}

	// AliasGreeter resolves through types.Unalias to Concrete; the resolver
	// must still emit the implements edge for the Concrete node (the alias
	// shares its identifier with Concrete via the canonical NodeID scheme).
	implementsCount := countEdges(g, domain.EdgeKindImplements)
	if implementsCount < 1 {
		t.Fatalf("expected at least one implements edge, got %d", implementsCount)
	}
}

func TestImplementsEmptyInterfaceProducesNoEdges(t *testing.T) {
	g := buildGraph(t, loadFixture(t, "iface_empty"))

	if got := countEdges(g, domain.EdgeKindImplements); got != 0 {
		t.Fatalf("expected zero implements edges for empty interface, got %d", got)
	}
}

func TestImplementsMultipleImplementations(t *testing.T) {
	g := buildGraph(t, loadFixture(t, "iface_multi_impl"))

	iface := nodeByName(g, "Speaker", domain.NodeKindInterface)
	loud := nodeByName(g, "Loud", domain.NodeKindStruct)
	quiet := nodeByName(g, "Quiet", domain.NodeKindStruct)
	if iface == nil || loud == nil || quiet == nil {
		t.Fatalf("missing nodes: iface=%v loud=%v quiet=%v", iface, loud, quiet)
	}
	if !hasEdge(g, loud.ID, iface.ID, domain.EdgeKindImplements) {
		t.Fatalf("expected implements edge Loud -> Speaker")
	}
	if !hasEdge(g, quiet.ID, iface.ID, domain.EdgeKindImplements) {
		t.Fatalf("expected implements edge Quiet -> Speaker")
	}
}

func TestImplementsSkipsStdlibInterfaces(t *testing.T) {
	g := buildGraph(t, loadFixture(t, "iface_stdlib"))

	echo := nodeByName(g, "Echo", domain.NodeKindStruct)
	if echo == nil {
		t.Fatalf("missing struct node Echo")
	}
	for _, e := range g.Edges {
		if e.Kind != domain.EdgeKindImplements {
			continue
		}
		if e.Source == echo.ID {
			t.Fatalf("did not expect implements edge from Echo to a stdlib interface (got target %s)", e.Target)
		}
	}
}

func TestImplementsIntegrationWithInterfaces(t *testing.T) {
	g := buildGraph(t, loadFixture(t, "with_interfaces"))

	speaker := nodeByName(g, "Speaker", domain.NodeKindInterface)
	closer := nodeByName(g, "Closer", domain.NodeKindInterface)
	dog := nodeByName(g, "Dog", domain.NodeKindStruct)
	cat := nodeByName(g, "Cat", domain.NodeKindStruct)
	if speaker == nil || closer == nil || dog == nil || cat == nil {
		t.Fatalf("missing nodes: speaker=%v closer=%v dog=%v cat=%v", speaker, closer, dog, cat)
	}

	wantTrue := []struct{ src, tgt string }{
		{dog.ID, speaker.ID},
		{cat.ID, speaker.ID},
		{dog.ID, closer.ID},
	}
	for _, p := range wantTrue {
		if !hasEdge(g, p.src, p.tgt, domain.EdgeKindImplements) {
			t.Fatalf("expected implements edge %s -> %s", p.src, p.tgt)
		}
	}

	// Cat does not declare Close so the (Cat, Closer) pair must not produce
	// an edge.
	if hasEdge(g, cat.ID, closer.ID, domain.EdgeKindImplements) {
		t.Fatalf("did not expect implements edge Cat -> Closer")
	}
}

func TestImplementsEdgeStability(t *testing.T) {
	res := loadFixture(t, "with_interfaces")
	first := buildGraph(t, res)
	second := buildGraph(t, res)

	get := func(g *domain.Graph) []string {
		var ids []string
		for _, e := range g.Edges {
			if e.Kind == domain.EdgeKindImplements {
				ids = append(ids, e.ID)
			}
		}
		sort.Strings(ids)
		return ids
	}
	a := get(first)
	b := get(second)
	if len(a) != len(b) {
		t.Fatalf("implements edge count drift: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("implements edge id drift at %d: %s vs %s", i, a[i], b[i])
		}
	}
}

func TestImplementsResolverContextCanceled(t *testing.T) {
	res := loadFixture(t, "with_interfaces")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	resolver := graph.NewImplementsResolver(nil)
	_, err := resolver.Resolve(ctx, res.LivePackages, map[string]string{}, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

func TestImplementsResolverProgressClosed(t *testing.T) {
	res := loadFixture(t, "with_interfaces")
	progress := make(chan float64, 32)

	var (
		wg    sync.WaitGroup
		ticks []float64
	)
	wg.Add(1)
	go func() {
		defer wg.Done()
		for v := range progress {
			ticks = append(ticks, v)
		}
	}()

	resolver := graph.NewImplementsResolver(nil)
	if _, err := resolver.Resolve(context.Background(), res.LivePackages, map[string]string{}, progress); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	wg.Wait()

	if len(ticks) == 0 {
		t.Fatal("expected at least one progress tick")
	}
	if ticks[0] != 0.0 {
		t.Fatalf("first tick = %v, want 0.0", ticks[0])
	}
	if ticks[len(ticks)-1] != 1.0 {
		t.Fatalf("last tick = %v, want 1.0", ticks[len(ticks)-1])
	}
	if !sort.SliceIsSorted(ticks, func(i, j int) bool { return ticks[i] <= ticks[j] }) {
		t.Fatalf("progress not monotonic: %v", ticks)
	}
}

func TestImplementsResolverEmptyInputProgress(t *testing.T) {
	progress := make(chan float64, 4)
	var (
		wg    sync.WaitGroup
		ticks []float64
	)
	wg.Add(1)
	go func() {
		defer wg.Done()
		for v := range progress {
			ticks = append(ticks, v)
		}
	}()

	edges, err := graph.NewImplementsResolver(nil).Resolve(context.Background(), nil, nil, progress)
	if err != nil {
		t.Fatalf("Resolve nil pkgs: %v", err)
	}
	wg.Wait()

	if len(edges) != 0 {
		t.Fatalf("expected zero edges, got %d", len(edges))
	}
	if len(ticks) == 0 || ticks[len(ticks)-1] != 1.0 {
		t.Fatalf("expected final 1.0 progress tick, got %v", ticks)
	}
}

func TestImplementsResolverIgnoresUnknownNodeIDs(t *testing.T) {
	res := loadFixture(t, "iface_single_impl")

	// An empty FQN map should suppress every emission because no endpoint
	// can be looked up.
	edges, err := graph.NewImplementsResolver(nil).Resolve(context.Background(), res.LivePackages, map[string]string{}, nil)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(edges) != 0 {
		t.Fatalf("expected zero edges with empty index, got %d", len(edges))
	}
}
