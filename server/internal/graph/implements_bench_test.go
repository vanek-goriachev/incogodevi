package graph_test

import (
	"context"
	"testing"

	"github.com/vanek-goriachev/incogodevi/server/internal/graph"
)

// BenchmarkImplementsResolver exercises the resolver on the with_interfaces
// fixture. The fixture is small (one package, two interfaces, two structs),
// so the result is sanity-only; the benchmark exists to satisfy the T09
// definition-of-done and to give future contributors a hook for profiling
// when the project starts ingesting larger fixtures.
//
// Sample run on Apple M3 Pro, go 1.26.2:
//
//	BenchmarkImplementsResolver-12    ~20µs/op
//
// Numbers are intentionally not asserted because hardware varies.
func BenchmarkImplementsResolver(b *testing.B) {
	res := loadFixtureTB(b, "with_interfaces")
	resolver := graph.NewImplementsResolver(nil)
	ctx := context.Background()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := resolver.Resolve(ctx, res.LivePackages, map[string]string{}, nil); err != nil {
			b.Fatalf("Resolve: %v", err)
		}
	}
}
