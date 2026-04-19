// Package entry resolves the seed set for the reachability traversal from a
// domain.EntryPointSpec.
//
// Three modes are supported:
//
//   - "auto": every func main() declared in a project-local "package main".
//   - "manual": user-supplied fully-qualified names of the form
//     "<pkgPath>#<TypeName>.<MethodName>" or "<pkgPath>#<FuncName>".
//   - "mixed": union of auto and manual.
//
// Independently of the mode, the InterfaceImpl list expands the result with
// the methods of every project-local type that satisfies the listed
// interfaces (FR-09). Resolution never mutates the graph; the orchestrator
// (T13/T15) flips Node.IsEntry on the returned IDs.
//
// See docs/architecture.md §3.2 (EntryPointsResolver), ADR-09 and
// docs/api-contract.md §2 ("invalid_entry_point").
package entry
