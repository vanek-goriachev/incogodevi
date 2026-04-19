# server

Go backend for the Go Dependencies Visualizer. At this stage the binary
exposes only `GET /api/healthz`; analysis endpoints arrive in later tasks
(see `tasks/README.md`).

## Requirements

- Go 1.26 or later (matches `go.mod`, see `docs/architecture.md` ADR-04).
- `golangci-lint` v2 for `make lint`.

## Quick start

From the repository root:

```sh
make build      # produces server/bin/server
make run        # builds and runs on :8080
```

Then in another shell:

```sh
curl http://localhost:8080/api/healthz
```

Expected response:

```json
{"status":"ok","version":"0.1.0-dev","uptime_sec":0,"active_projects":0}
```

## Configuration

| Environment variable | Default  | Description                             |
| -------------------- | -------- | --------------------------------------- |
| `GOVIZ_ADDR`         | `:8080`  | Listen address passed to `http.Server`. |
| `GOVIZ_LOG_LEVEL`    | `info`   | One of `debug`, `info`, `warn`, `error`. |

## Development targets

| Target       | What it does                                              |
| ------------ | --------------------------------------------------------- |
| `make lint`  | Runs `golangci-lint` over `./...`.                        |
| `make test`  | Runs `go test -race -coverprofile=coverage.out ./...`.    |
| `make build` | Builds a static binary into `server/bin/server`.          |
| `make run`   | Builds and starts the server in the foreground.           |
| `make tidy`  | Runs `go mod tidy`.                                       |

## Layout

```
server/
  cmd/server/        # main package, HTTP entrypoint
  internal/
    api/             # HTTP handlers and middleware (T12+)
    cache/           # disk cache manager (T05)
    domain/          # domain types (T04)
    entry/           # entry-points resolver (T10)
    graph/           # graph builder + interface resolver (T08, T09)
    loader/          # project loader / ZIP unpacker (T06)
    orchestrator/    # analysis orchestrator (T13)
    parser/          # Go source parser (T07)
    reach/           # reachability analyzer (T11)
    web/             # embedded SPA bundle (T25)
```

Graceful shutdown is wired to `SIGINT` and `SIGTERM`; the server logs
`"server shutting down"` and exits within ten seconds.
