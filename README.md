# Go Dependencies Visualizer

[![CI](https://github.com/vanek-goriachev/incogodevi/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vanek-goriachev/incogodevi/actions/workflows/ci.yml)

Interactive tool for static analysis and visualization of dependencies in Go codebases. Builds a reachability graph from one or more entry points, highlights dead code, and provides an interactive browser-based UI for exploration and refactoring.

## Status

Early development.

## Quick start

TBD — see `docs/operator-manual.md` once available.

## Development

See `docs/` for requirements, architecture, API contract, and decomposition into tasks.

## Continuous Integration

GitHub Actions runs on every push and pull request to `main` (`.github/workflows/ci.yml`):

- **backend**: `gofmt`, `go vet`, `golangci-lint`, `go test -race -coverprofile=coverage.out`, and `go build ./cmd/server`. Matrix: `{ubuntu-latest, macos-latest} x {Go 1.25, Go 1.26}`.
- **frontend**: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test -- --coverage`, `npm run build` on Node 24.
- **status**: aggregate gate that depends on both jobs and is the single required check for branch protection on `main`.

Branch protection on `main` should require the `status` check to succeed before merge. Dependency updates are managed by Dependabot (`.github/dependabot.yml`) for `gomod`, `npm`, and `github-actions` ecosystems.

## License

MIT
