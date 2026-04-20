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
- **Mitigation in T22 (2026-04-20):** the frontend now detects the empty-graph
  response (`web/src/pages/Main/MainView.tsx::handleReanalyzeDone`) and falls
  back to a local BFS reachability recompute against the previously loaded
  graph (`web/src/pages/Main/localReachability.ts`). The user gets a toast
  warning that highlight is local-only until the backend bug is fixed.

## Resolved

### dockerfile: distroless runtime lacks go toolchain

- **Where:** `Dockerfile` runtime stage (was `gcr.io/distroless/static-debian12`).
- **Symptom:** Every analysis ran inside the container failed with
  `parser: packages.Load: err: go command required, not found: exec: "go": executable file not found in $PATH`.
  The error surfaced as the "Analysis failed" screen on Landing → upload.
- **Discovered by:** T26 (2026-04-20) end-to-end run against the Docker image
  rebuilt from T25 commit.
- **Resolved by:** T26 (2026-04-20). Switched the runtime base image to
  `golang:1.26-alpine` so `golang.org/x/tools/go/packages.Load` (ADR-02)
  has the `go` toolchain it requires. Added a non-root user, a writable
  `GOCACHE` / `GOMODCACHE` under `/home/nonroot`, `GOTOOLCHAIN=local`, and
  a pre-created `/tmp/go-viz-cache` directory. Image grew from ~15 MB
  (distroless) to ~280 MB (alpine + Go), accepted as the cost of running
  the analyzer end-to-end. ADR-04 should be updated when the architecture
  doc is next revisited.

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
