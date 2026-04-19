package reach_test

import (
	"fmt"
	"testing"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/reach"
)

// BenchmarkReach exercises Mark on a synthetic graph sized to approximate the
// "average 50 kLOC project" target referenced by NFR-01. Indicative numbers
// from a 2024 MacBook Pro M3 Pro (darwin/arm64, Go 1.26, -benchtime=2x):
//
//	BenchmarkReach/nodes=2000-12    ~0.5 ms/op   ~0.7 MB/op
//	BenchmarkReach/nodes=20000-12   ~4.7 ms/op   ~6.8 MB/op
//
// Both comfortably below the 100 ms guidance in tasks/T11-reachability.md.
func BenchmarkReach(b *testing.B) {
	for _, size := range []int{2_000, 20_000} {
		b.Run(fmt.Sprintf("nodes=%d", size), func(b *testing.B) {
			g := makeBenchGraph(size)
			analyzer := reach.New(nil)
			ids := []string{g.Nodes[0].ID}
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if err := analyzer.Mark(g, ids); err != nil {
					b.Fatalf("Mark: %v", err)
				}
			}
		})
	}
}

// makeBenchGraph builds a "linear plus cross-call" graph: every node calls
// its successor, plus every 16th node has a back-edge into a random earlier
// node so the BFS frontier stays interesting.
func makeBenchGraph(n int) *domain.Graph {
	nodes := make([]domain.Node, n)
	edges := make([]domain.Edge, 0, n*2)
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("n%07d", i)
		nodes[i] = domain.Node{
			ID:      id,
			Name:    id,
			Kind:    domain.NodeKindFunc,
			Package: "bench",
			File:    "bench.go",
			Line:    i + 1,
		}
	}
	for i := 0; i < n-1; i++ {
		edges = append(edges, domain.Edge{
			ID:     domain.EdgeID(nodes[i].ID, nodes[i+1].ID, domain.EdgeKindCalls),
			Source: nodes[i].ID,
			Target: nodes[i+1].ID,
			Kind:   domain.EdgeKindCalls,
			Weight: 1,
		})
		if i > 0 && i%16 == 0 {
			edges = append(edges, domain.Edge{
				ID:     domain.EdgeID(nodes[i].ID, nodes[i/2].ID, domain.EdgeKindReferences),
				Source: nodes[i].ID,
				Target: nodes[i/2].ID,
				Kind:   domain.EdgeKindReferences,
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
