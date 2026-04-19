# Tech Debt Log

A running list of issues discovered during implementation that fall outside
the scope of the task that uncovered them. Each entry must point at the file,
the symptom and the recommended follow-up.

## Open

_(none)_

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
