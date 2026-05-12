package reach

import (
	"sort"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// Aggregate collapses g into a package-level graph.
//
// The result has exactly one node per package observed in g.Nodes. Edges are
// reduced to imports-edges between distinct packages, with weights summed
// across the source edges that touched the same (src_pkg, tgt_pkg) pair. Each
// package node carries a stable Node.ID derived from its package path
// (ADR-07), a ChildCount that excludes the package node itself, and a
// Reachable flag set to true when at least one of its children is reachable.
//
// Warnings, SchemaVersion and the by-kind histogram in Stats are propagated
// from g so the aggregated view round-trips through the cache and the HTTP
// layer with the same metadata.
//
// The function never mutates g.
func Aggregate(g *domain.Graph) *domain.Graph {
	if g == nil {
		return nil
	}

	type packageBucket struct {
		Name       string
		Path       string
		Reachable  bool
		External   bool
		ChildCount int
		DeadCount  int
	}

	buckets := make(map[string]*packageBucket)
	pkgOrder := make([]string, 0)
	pkgIDByPath := make(map[string]string)
	nodePackage := make(map[string]string, len(g.Nodes))

	// Seed buckets with explicit package nodes so the resulting view keeps
	// their declared name (Go short name) and so child_count below excludes
	// them. Project-local non-package nodes that do not have a matching
	// package node still produce a synthetic bucket — this keeps the
	// aggregator robust on partial graphs (NFR-08).
	for i := range g.Nodes {
		n := &g.Nodes[i]
		nodePackage[n.ID] = n.Package
		if n.Kind != domain.NodeKindPackage {
			continue
		}
		if _, ok := buckets[n.Package]; ok {
			continue
		}
		buckets[n.Package] = &packageBucket{Name: n.Name, Path: n.Package, Reachable: n.Reachable, External: n.External}
		pkgOrder = append(pkgOrder, n.Package)
		pkgIDByPath[n.Package] = n.ID
	}

	for i := range g.Nodes {
		n := &g.Nodes[i]
		if n.Kind == domain.NodeKindPackage {
			continue
		}
		if n.Package == "" {
			continue
		}
		bucket, ok := buckets[n.Package]
		if !ok {
			bucket = &packageBucket{Name: shortName(n.Package), Path: n.Package, External: n.External}
			buckets[n.Package] = bucket
			pkgOrder = append(pkgOrder, n.Package)
			pkgIDByPath[n.Package] = domain.NodeID(n.Package, "", "")
		}
		bucket.ChildCount++
		if n.Reachable {
			bucket.Reachable = true
		} else {
			bucket.DeadCount++
		}
	}

	sort.Strings(pkgOrder)

	nodes := make([]domain.Node, 0, len(pkgOrder))
	for _, pkg := range pkgOrder {
		bucket := buckets[pkg]
		// partial_dead = at least one but not every child is dead.
		// fully_dead   = every child (and there is at least one) is dead.
		// Both flags stay false on packages without children so the FE only
		// renders the marker when the data backs it up (R4-5).
		partial := bucket.ChildCount > 0 && bucket.DeadCount > 0 && bucket.DeadCount < bucket.ChildCount
		fully := bucket.ChildCount > 0 && bucket.DeadCount == bucket.ChildCount
		nodes = append(nodes, domain.Node{
			ID:          pkgIDByPath[pkg],
			Name:        bucket.Name,
			Kind:        domain.NodeKindPackage,
			Package:     bucket.Path,
			Exported:    true,
			Reachable:   bucket.Reachable,
			ChildCount:  bucket.ChildCount,
			DeadCount:   bucket.DeadCount,
			PartialDead: partial,
			FullyDead:   fully,
			External:    bucket.External,
		})
	}

	type pairKey struct {
		Src, Tgt string
	}
	pairs := make(map[pairKey]int)
	pairOrder := make([]pairKey, 0)

	for _, e := range g.Edges {
		if e.Kind != domain.EdgeKindImports {
			continue
		}
		srcPkg := nodePackage[e.Source]
		tgtPkg := nodePackage[e.Target]
		if srcPkg == "" || tgtPkg == "" || srcPkg == tgtPkg {
			continue
		}
		srcID, ok := pkgIDByPath[srcPkg]
		if !ok {
			continue
		}
		tgtID, ok := pkgIDByPath[tgtPkg]
		if !ok {
			continue
		}
		key := pairKey{Src: srcID, Tgt: tgtID}
		if _, exists := pairs[key]; !exists {
			pairOrder = append(pairOrder, key)
		}
		pairs[key] += e.Weight
	}

	sort.SliceStable(pairOrder, func(i, j int) bool {
		if pairOrder[i].Src != pairOrder[j].Src {
			return pairOrder[i].Src < pairOrder[j].Src
		}
		return pairOrder[i].Tgt < pairOrder[j].Tgt
	})

	edges := make([]domain.Edge, 0, len(pairOrder))
	for _, key := range pairOrder {
		edges = append(edges, domain.Edge{
			ID:     domain.EdgeID(key.Src, key.Tgt, domain.EdgeKindImports),
			Source: key.Src,
			Target: key.Tgt,
			Kind:   domain.EdgeKindImports,
			Weight: pairs[key],
		})
	}

	deadCount := 0
	for i := range nodes {
		if !nodes[i].Reachable {
			deadCount++
		}
	}

	stats := domain.GraphStats{
		NodeCount: len(nodes),
		EdgeCount: len(edges),
		DeadCount: deadCount,
		ByKind:    map[domain.NodeKind]int{domain.NodeKindPackage: len(nodes)},
	}

	return &domain.Graph{
		Nodes:         nodes,
		Edges:         edges,
		Warnings:      append([]domain.Warning(nil), g.Warnings...),
		Stats:         stats,
		SchemaVersion: g.SchemaVersion,
	}
}

// shortName returns the trailing component of a Go package path, used as a
// best-effort display name when no explicit package node is present in g.
//
// Examples:
//
//	"example.com/foo/bar"  -> "bar"
//	"main"                  -> "main"
//	""                      -> ""
func shortName(pkgPath string) string {
	if pkgPath == "" {
		return ""
	}
	for i := len(pkgPath) - 1; i >= 0; i-- {
		if pkgPath[i] == '/' {
			return pkgPath[i+1:]
		}
	}
	return pkgPath
}
