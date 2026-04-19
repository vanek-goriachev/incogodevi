# server

Go backend for the Go Dependencies Visualizer. The binary currently exposes
project upload (`POST /api/projects`), the analysis stream
(`POST /api/projects/{id}/analyze`) and the supporting management endpoints
(`GET /api/healthz`, `GET /api/projects`, `DELETE /api/projects/{id}`). The
remaining read endpoints (`GET /…/graph`, `GET /…/dead-code`) arrive in later
tasks (see `tasks/README.md`).

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

## Uploading a project

Upload a Go source archive with `multipart/form-data`. The `archive` field is
required; `name` is optional and falls back to the module path parsed from
`go.mod` (api-contract.md §1).

```sh
curl -sS -X POST http://localhost:8080/api/projects \
     -F archive=@./my-go-project.zip \
     -F name="my local go project"
```

Successful response (HTTP 201):

```json
{
  "project_id": "hs3NwQ1jZCEtj8pKmXKg9g",
  "name": "github.com/acme/example",
  "uploaded_at": "2026-04-18T12:34:56Z",
  "size_bytes": 1048576,
  "file_count": 142,
  "expires_at": "2026-04-18T13:04:56Z"
}
```

Common error envelopes (`{"error": {"code": …, "message": …}}`):

| HTTP | code                     | when                                              |
| ---- | ------------------------ | ------------------------------------------------- |
| 400  | `invalid_zip`            | missing `archive` field, broken multipart, bad zip |
| 400  | `go_mod_missing`         | no `go.mod` in archive root or first sub-folder    |
| 400  | `zip_slip_detected`      | path traversal entry caught before disk write     |
| 413  | `archive_too_large`      | request body exceeds 50 MiB pre-unpack            |
| 422  | `file_count_exceeded`    | more than 10 000 archive entries                  |
| 422  | `unpacked_size_exceeded` | unpacked size exceeds 500 MiB (zip-bomb guard)    |

Examples:

```sh
# Missing field
curl -sS -X POST http://localhost:8080/api/projects -F name="solo"
# → 400 {"error":{"code":"invalid_zip","message":"missing archive field"}}

# Archive without go.mod
curl -sS -X POST http://localhost:8080/api/projects -F archive=@./no-mod.zip
# → 400 {"error":{"code":"go_mod_missing","message":"valid Go module not found"}}
```

## Running an analysis

Once a project is uploaded, kick off the analysis pipeline. The endpoint
streams Server-Sent Events (`text/event-stream`); use `curl -N` so the buffer
is not closed prematurely. An empty body uses the documented defaults
(api-contract.md §2):

```sh
curl -N -X POST http://localhost:8080/api/projects/<project_id>/analyze \
     -H 'Content-Type: application/json' \
     -d '{}'
```

A custom request narrows the entry points and filters:

```sh
curl -N -X POST http://localhost:8080/api/projects/<project_id>/analyze \
     -H 'Content-Type: application/json' \
     -d '{
       "entry_points": {"mode":"auto","auto_kinds":["main","init"]},
       "filters":      {"include_kinds":["function","method"],"stdlib_exclude":true}
     }'
```

Sample stream (newlines added for clarity):

```
event: stage
data: {"stage":"parsing","detail":"…"}

event: progress
data: {"stage":"reach","percent":42}

event: done
data: {"status":"ok","duration_ms":1234}
```

Pre-stream errors are still JSON envelopes:

| HTTP | code                   | when                                                |
| ---- | ---------------------- | --------------------------------------------------- |
| 400  | `invalid_body`         | malformed / oversized JSON, unknown / trailing keys |
| 400  | `invalid_filters`      | `include_kinds` value is not a known node kind      |
| 400  | `invalid_entry_point`  | malformed FQN in `manual` / `interface_impl` lists  |
| 404  | `project_not_found`    | project id missing or evicted                       |
| 409  | `analysis_in_progress` | another `/analyze` for the same project is running  |
| 413  | `body_too_large`       | request body exceeds 1 MiB                          |

Once the SSE stream has started, every recoverable failure surfaces as a
`done:failed` event because the client already received `200 OK`.

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
