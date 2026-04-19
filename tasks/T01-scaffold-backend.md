# T01: Scaffold backend

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (разделы: 4 «Ограничения», 3.2 NFR-05, 3.2 NFR-07)
- `docs/architecture.md` (разделы: 2 «Контейнеры», 3 «Компоненты backend», ADR-11)
- `docs/api-contract.md` — общие соглашения (не применимо на уровне эндпоинтов)
- `docs/design.md` — не применимо

## Зависимости
Стартовая задача. Предусловий по merged-в-main коду нет.

## Цель
Создать минимальный скелет backend-части: `go.mod`, точку входа `cmd/server/main.go`, базовую директорную структуру под архитектуру (10 компонент), Makefile c основными таргетами, `.golangci.yml`, README. Без бизнес-логики — только компилируемый «hello» на `net/http` с health endpoint заглушкой.

## Scope

### В scope
- Создать/изменить файлы:
  - `server/go.mod` (module path `github.com/<user>/go-viz/server`, `go 1.26` — stable stable на 2026-04-19 per architecture.md ADR-04 / NFR-05; исполнитель обязан свериться с https://go.dev/doc/devel/release в начале работы)
  - `server/cmd/server/main.go` (инициализация `*slog.Logger`, `http.ServeMux`, `/api/healthz` заглушка, `http.Server` с timeouts, graceful shutdown на SIGTERM/SIGINT)
  - `server/internal/domain/.gitkeep`
  - `server/internal/cache/.gitkeep`
  - `server/internal/loader/.gitkeep`
  - `server/internal/parser/.gitkeep`
  - `server/internal/graph/.gitkeep`
  - `server/internal/entry/.gitkeep`
  - `server/internal/reach/.gitkeep`
  - `server/internal/api/.gitkeep`
  - `server/internal/orchestrator/.gitkeep`
  - `server/internal/web/.gitkeep` (под `embed.FS`)
  - `Makefile` (таргеты: `lint`, `test`, `build`, `run`, `tidy`)
  - `.golangci.yml` (enabled: `govet`, `errcheck`, `staticcheck`, `gosimple`, `ineffassign`, `unused`, `gofmt`, `revive`)
  - `server/README.md` (краткая инструкция `make build && make run`)
  - Обновить корневой `.gitignore`: `server/bin/`, `coverage.out`, `*.prof`

### Вне scope (делается в другой задаче)
- Доменные типы — **T04**
- DiskCache, Loader, Parser, GraphBuilder и т. д. — **T05..T11**
- Реальные HTTP-эндпоинты — **T12..T16**
- Embed frontend → в **T25** (Dockerfile build передаёт `web/dist` в Go-stage)

## Технические детали
- Модульная раскладка соответствует §3 architecture.md. Все компоненты в `server/internal/*` — не экспортируемые наружу пакеты.
- `cmd/server/main.go`:
  - `slog.New(slog.NewJSONHandler(os.Stdout, nil))` + `slog.SetDefault`
  - `http.Server{Addr: ":8080", ReadHeaderTimeout: 10*time.Second, WriteTimeout: 0 /* SSE требует streaming */, IdleTimeout: 120*time.Second}`
  - `signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)` для graceful shutdown с 10-секундным `Shutdown(ctx)`.
  - ENV: `GOVIZ_ADDR` (default `:8080`), `GOVIZ_LOG_LEVEL` (default `info`).
- `/api/healthz` возвращает `{"status":"ok","version":"0.1.0-dev","uptime_sec":<int>,"active_projects":0}` (см. `api-contract.md §7`).
- Makefile — POSIX-sh compatible; `lint` = `golangci-lint run ./...`; `test` = `go test -race -coverprofile=coverage.out ./...`; `build` = `CGO_ENABLED=0 go build -o bin/server ./cmd/server`.

## Acceptance criteria
- [ ] `go version` в CI и локально — 1.26+; `server/go.mod` содержит `go 1.26`.
- [ ] `make build` успешно собирает `server/bin/server`.
- [ ] `make lint` выполняется без ошибок (golangci-lint установлен локально/в CI).
- [ ] `make test` зелёный (даже если тестов пока нет — `go test ./...` не падает).
- [ ] `./server/bin/server &` слушает `:8080`; `curl http://localhost:8080/api/healthz` возвращает JSON с `status=="ok"` и кодом 200.
- [ ] `SIGINT` приводит к логу «server shutting down» и exit 0 в течение ≤ 2 с.
- [ ] Все директории `server/internal/*` присутствуют (с `.gitkeep`).

## План тестирования

### Unit-тесты
- `cmd/server/main_test.go` опционален; если делать — smoke-тест healthz через `httptest.NewServer` c минимально выделенным `newMux()` хелпером.

### Integration-тесты
- Не применимо.

### E2E / Browser-тесты
- Не применимо (нет UI).

## Definition of Done
- [ ] Код компилируется без предупреждений
- [ ] `go vet ./...` чистый
- [ ] `golangci-lint run` чистый
- [ ] `make build` / `make run` работают
- [ ] `curl` healthz даёт ожидаемый JSON
- [ ] Коммиты в Conventional Commits (`chore(scaffold): …`)
- [ ] PR создан, `tasks/README.md` обновлён: T01 `[x]`

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b chore/t01-scaffold-backend`
3. Создай структуру, минимальный `main.go`, Makefile, `.golangci.yml`.
4. `make lint test build run` — проверь всё.
5. Коммит(ы), push, PR, merge.

## Out-of-band
Если неоднозначно (например, вопрос про multi-module vs monorepo) — уточни у пользователя. По architecture.md принято: один модуль `server/`, один `web/`, монорепо в корне.
