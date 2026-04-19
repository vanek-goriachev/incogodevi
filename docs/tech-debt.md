# Tech Debt Log

A running list of issues discovered during implementation that fall outside
the scope of the task that uncovered them. Each entry must point at the file,
the symptom and the recommended follow-up.

## Open

### graph: addCallsAndReferences crashes on FuncDecl without Body

- **Where:** `server/internal/graph/ast_calls.go:38-43` (the `*ast.FuncDecl`
  branch in `walkFile`).
- **Symptom:** `ast.Inspect(node.Body, ...)` panics with a nil-pointer
  dereference when a parsed file contains a function declaration without a
  body (e.g. assembly-implemented stdlib functions or method stubs in
  external packages loaded transitively via `NeedDeps`).
- **Discovered by:** T09. Adding a fixture that imported `"io"` triggered the
  panic during the second build pass; removing the import side-stepped the
  symptom but the underlying bug remains.
- **Suggested fix:** guard with `if node.Body == nil { return false }` before
  the inner `ast.Inspect`. Belongs in a follow-up T08 hardening task or
  whichever future task starts importing stdlib packages in fixtures.
