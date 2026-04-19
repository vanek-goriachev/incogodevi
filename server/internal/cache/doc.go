// Package cache implements DiskCacheManager — the centralised owner of the
// per-project sources and artifact directories on disk.
//
// All other backend components (loader, parser, orchestrator, HTTP handlers)
// must access these paths only through the Manager interface so file-system
// layout, atomic writes and TTL-based eviction stay encapsulated in one place
// (architecture.md §3.4, ADR-03, ADR-10, ADR-12).
//
// Layout under the configured roots is:
//
//	<RootTmp>/<project_id>/        — extracted Go sources (T06).
//	<RootCache>/<project_id>/      — analysis artifacts:
//	    meta.json                   — ProjectMeta envelope.
//	    parsed.gob                  — reduced *types.Package snapshot (T07).
//	    graph.json                  — domain.Graph for /graph (T16).
//	    dead-code.json              — domain.DeadCodeReport for /dead-code (T16).
//
// Writes are atomic: each artifact is first written to a sibling temporary
// file and then renamed into place (os.CreateTemp + os.Rename). Readers
// therefore observe either the previous version or the new one in full and
// never a half-written file.
//
// Idle projects are reaped by a background sweeper goroutine: a project whose
// LastAccessAt is older than the configured IdleTTL is removed from the
// in-memory registry together with both of its directories.
package cache
