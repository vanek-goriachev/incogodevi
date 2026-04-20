# Tech Debt Log

A running list of issues discovered during implementation that fall outside
the scope of the task that uncovered them. Each entry must point at the file,
the symptom and the recommended follow-up.

## Open

### orchestrator: re-analyze on cached project produces empty graph

- **Where:** `server/internal/orchestrator/` cache-hit path in `Run` /
  `RunReserved`. When `parser.Load` returns a cached `parsed.gob` (so
  `LivePackages` is empty and `TypesUnavailable=true`), the graph builder is
  invoked with no live packages and emits a 0-node graph plus a
  `types_unavailable` warning.
- **Symptom:** A second `POST /api/projects/{id}/analyze` for the same
  project completes successfully but returns an empty graph. Frontend
  currently never re-triggers analyze for the same id, so users do not see
  this; surfaced during T21 E2E debugging.
- **Discovered by:** T21 (2026-04-20).
- **Suggested fix:** when `LivePackages` is empty, the orchestrator should
  either (a) re-parse without using the cached `parsed.gob`, or (b) skip
  graph rebuild and load `graph.json` directly from cache. Pick whichever
  matches `docs/architecture.md` ADR-02 intent.

## Resolved

### graph: addCallsAndReferences crashes on FuncDecl without Body

- **Where:** `server/internal/graph/ast_calls.go` (the `*ast.FuncDecl` and
  `*ast.FuncLit` branches in `walkFile`).
- **Symptom:** `ast.Inspect(node.Body, ...)` panicked with a nil-pointer
  dereference when a parsed file contained a function declaration without a
  body (e.g. assembly-implemented stdlib functions or method stubs in
  external packages loaded transitively via `NeedDeps`).
- **Discovered by:** T09. Adding a fixture that imported `"io"` triggered
  the panic during the second build pass; removing the import side-stepped
  the symptom but the underlying bug remained.
- **Resolved by:** T10 (2026-04-19). Both branches now skip the descent
  when `node.Body == nil`. A regression fixture (`testdata/funcdecl_nobody`)
  and `TestBuildHandlesBodylessFuncDecl` in `internal/graph` cover the
  code path.
