// Package graph turns a typed snapshot from the parser into the canonical
// domain.Graph used by the rest of the analysis pipeline.
//
// Builder walks every package returned by parser.Parser.Load and produces:
//
//   - eight kinds of nodes (package, struct, interface, func, method, field,
//     var, const) keyed by stable SHA-1 identifiers (ADR-07);
//   - five kinds of edges (imports, contains, calls, embeds, references).
//
// The implements relation is intentionally left to the InterfaceResolver
// (T09); reachability flags are filled in by the ReachabilityAnalyzer (T11).
//
// See docs/architecture.md §3.2 (GraphBuilder), §4 (Data model) and ADR-07.
package graph
