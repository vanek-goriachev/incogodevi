// Package reach marks reachable nodes in a dependency graph and derives the
// dead-code report that ships in /api/projects/{id}/dead-code responses.
//
// The Analyzer runs a BFS traversal from a seed set of entry-point Node.IDs
// (resolved by the entry package, T10) through a curated subset of the edge
// kinds emitted by the graph builder. Nodes reachable from at least one seed
// have their Reachable flag set to true; the rest are surfaced as
// DeadCodeEntry values in a DeadCodeReport (FR-19, FR-20).
//
// The Aggregator collapses a large graph into a package-level view — one node
// per package, imports-edges deduplicated across packages — so the frontend
// does not have to render tens of thousands of vertices at once (FR-18,
// ADR-06). Node.IDs remain stable across aggregated and detailed views
// (ADR-07), which lets the UI preserve positions between modes.
//
// The package exposes no HTTP concerns; serialisation and the aggregation
// heuristic (kick in at > 1000 nodes) live in the api layer (T16).
package reach
