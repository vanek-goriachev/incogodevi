// Package parser wraps golang.org/x/tools/go/packages to load a Go module
// from disk into a typed snapshot suitable for graph construction.
//
// The package implements two halves of the same pipeline:
//
//   - A live load via packages.Load that returns both a serialisable
//     []*ReducedPackage and the live []*packages.Package required by the
//     downstream interface resolver (T09).
//   - A read-through cache backed by the cache.Manager. The cached payload
//     is the gob-encoded ReducedPackage slice plus a SchemaVersion header;
//     it is sufficient for the graph builder (T08) but does not include
//     live *types.Package, so callers that need types.Implements must fall
//     back to a fresh load.
//
// See docs/architecture.md §3.2 (Parser) and ADR-12.
package parser
