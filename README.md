# Go Dependencies Visualizer

[![CI](https://github.com/vanek-goriachev/incogodevi/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vanek-goriachev/incogodevi/actions/workflows/ci.yml)

Interactive tool for static analysis and visualization of dependencies in Go codebases. Builds a reachability graph from one or more entry points, highlights dead code, and provides an interactive browser-based UI for exploration and refactoring.

## Status

Early development.

## Quick start (Docker)

The production image bundles the React/Cytoscape SPA inside the Go binary, so a single container is enough to run the whole tool:

```bash
docker run --rm -p 8080:8080 ghcr.io/vanek-goriachev/go-viz:dev
# then open http://localhost:8080
```

Healthcheck: `curl http://localhost:8080/api/healthz` returns `200 OK` with the bundled version string.

To persist the on-disk artefact cache across container restarts, mount a volume on `/tmp/go-viz-cache`:

```bash
docker run --rm -p 8080:8080 -v go-viz-cache:/tmp/go-viz-cache ghcr.io/vanek-goriachev/go-viz:dev
```

### Building the image locally

```bash
make docker-build-local            # current architecture, loaded into the local daemon
make docker-run                    # run what was just built
make docker-build VERSION=v0.1.0   # multi-arch (linux/amd64 + linux/arm64) via buildx
```

The image is built from a three-stage `Dockerfile`:

1. `node:24-alpine` builds the Vite SPA into `web/dist`.
2. `golang:1.26-alpine` copies it into `server/internal/web/dist`, then compiles the server with `CGO_ENABLED=0 -trimpath -ldflags "-s -w -X main.version=..."`.
3. `gcr.io/distroless/static-debian12:nonroot` is the runtime — no shell, runs as uid 65532, ~15 MB total.

Reproducibility: `-trimpath` plus pinned base images mean two consecutive builds of the same commit produce byte-identical binaries (the image digests will still differ because of build timestamps in the OCI manifest).

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
