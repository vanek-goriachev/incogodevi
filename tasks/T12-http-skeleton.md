# T12: HTTP-скелет + middleware + `/api/healthz`

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (3.1 NFR-04, 3.3 NFR-08, 3.5 NFR-13/14)
- `docs/architecture.md` (3.1 HTTP Server + SSEStreamer + Embedded FS, ADR-11 «без фреймворков»)
- `docs/api-contract.md` (§0 общие соглашения, §7 healthz, envelope ошибок)

## Зависимости
- **T01** — пакет `server/internal/api/`, `cmd/server/main.go`, Makefile.
- **T04** — `APIError`, `ProjectID`, все `Err*`.
- **T05** — `cache.Manager` (инстанцируем в `main.go`).

## Цель
Заложить HTTP-скелет: `net/http.ServeMux` с method-based routing (Go 1.22+, доступно в Go 1.26), middleware-цепочка (panic-recover, request-id, slog access log, MaxBytesReader per-route, CORS same-origin), конвертация `APIError` → JSON envelope, `/api/healthz` реальный, `/api/projects` заглушка (возвращает 501 пока). Плюс `embed.FS` placeholder для `web/dist/`.

## Scope

### В scope
- `server/internal/api/server.go`:
  - `type Server struct{ mux *http.ServeMux; logger *slog.Logger; cache cache.Manager; startedAt time.Time; version string }`
  - `func NewServer(cfg Config) *Server` — собирает `mux`, навешивает middleware, регистрирует routes.
  - Routes (method-based):
    - `GET /api/healthz` → реальный ответ `{status, version, uptime_sec, active_projects}` (api-contract §7)
    - `POST /api/projects` → 501 Not Implemented placeholder (реализуется в T14)
    - `POST /api/projects/{id}/analyze` → 501 placeholder (T15)
    - `GET /api/projects/{id}/graph` → 501 (T16)
    - `GET /api/projects/{id}/dead-code` → 501 (T16)
    - `DELETE /api/projects/{id}` → реализуется здесь: cache.DeleteProject(id) → 204 / 404
    - `GET /api/projects` → реализуется здесь: cache.ListProjects() → JSON (§6)
    - `GET /` → `http.FileServer(http.FS(embedFS))` из `internal/web/dist` (пока пустой каталог с `.gitkeep`)
  - Response helper: `func writeJSON(w, status int, v any)`; `func writeAPIError(w, err error)` — смотрит на `errors.As(err, *APIError)` и пишет envelope (§0).
- `server/internal/api/middleware.go`:
  - `Recover`: ловит panic, пишет 500 + `{error:{code:"internal", message:"internal error"}}`, логирует `slog.Error` со stacktrace.
  - `RequestID`: UUID в header `X-Request-Id` (если нет — генерируем `crypto/rand`).
  - `AccessLog`: после запроса `slog.Info` с method/path/status/duration/size.
  - `MaxBytesReader(limit int64)`: helper-обёртка, применяется точечно на `POST /api/projects` (50 МБ — NFR-04/14).
  - `CORS`: только same-origin (проверка `Origin == ""` ИЛИ `Origin` матчит `Host`); иначе 403. Это важно для локального use-case.
- `server/internal/web/embed.go`:
  - `//go:embed all:dist` → `var DistFS embed.FS`
  - На этапе T12 каталог `server/internal/web/dist/` содержит только `.gitkeep` — embed'ит пустую ФС; полноценный `web/dist/` кладётся в T25 Dockerfile. В dev-режиме прописываем заглушку `index.html` с сообщением «dev server, run vite separately».
  - Отдача через `http.FileServerFS(DistFS)`.
- `server/cmd/server/main.go`:
  - Инициализация `cache.Manager`, `api.Server`, `http.Server{Handler: server.Mux(), …}`. Graceful shutdown по SIGINT/SIGTERM (уже есть в T01).
- `server/internal/api/*_test.go`:
  - `httptest.NewServer(api.NewServer(testCfg))` + табличные тесты на каждый route:
    - `GET /api/healthz` → 200 + JSON.
    - `DELETE /api/projects/<unknown>` → 404 + `project_not_found`.
    - `POST /api/projects/<id>/analyze` → 501.
    - Panic в hidden debug handler → Recover ловит, 500 + envelope.
    - `MaxBytesReader` — POST с 60 МБ тела → 413 + `archive_too_large`.
    - CORS: `Origin: https://evil.com` → 403.

### Вне scope
- Реальные анализ-хендлеры — **T14/T15/T16**.
- SSE streaming — **T13/T15**.
- Полный `web/dist/` — **T25**.

## Технические детали
- Routing: `mux.HandleFunc("POST /api/projects/{id}/analyze", handler)`; `id := r.PathValue("id")` — Go 1.22+ API (подтверждено для 1.26).
- Middleware pattern: `func(http.Handler) http.Handler`; wrap mux в порядке: `AccessLog(RequestID(Recover(CORS(mux))))`.
- Валидация `ProjectID` через `domain.ProjectID.UnmarshalText(r.PathValue("id"))` — если невалидный формат, сразу 404 `project_not_found` (без утечки подробностей).
- SSE streaming требует `WriteTimeout=0` на `http.Server` (уже в T01) и `ResponseWriter.(http.Flusher)` — проверь, что wrapper `ResponseWriter` в middleware не «съедает» Flusher (использовать `httpsnoop` или кастомный wrapper, сохраняющий `http.Flusher` interface; **вариант**: не оборачивать ResponseWriter в размер-трекинг-wrapper для SSE-route — выделить две цепочки middleware).
- `embed.FS` с пустым каталогом в репо: кладём `server/internal/web/dist/.gitkeep` и `index.html` с заглушкой.

## Acceptance criteria
- [ ] `GET /api/healthz` возвращает 200 + JSON с ненулевым `uptime_sec`.
- [ ] `POST /api/projects` возвращает 501 с envelope `{error:{code:"not_implemented"}}` (пока, заменится в T14).
- [ ] `DELETE /api/projects/<id>` возвращает 204 для существующего (сперва создать через `cache.Manager`) и 404 для отсутствующего.
- [ ] `GET /api/projects` возвращает список с корректным `count`.
- [ ] Panic-инъекция через тестовый endpoint → 500 + envelope + лог-запись с stack.
- [ ] CORS: `Origin: https://evil` → 403.
- [ ] `GET /` возвращает 200 + HTML заглушку (или 404 на отсутствующий ассет) — main point: сервер не падает при пустом dist.
- [ ] SSE-проверка: dummy handler с `Flusher.Flush()` работает через цепочку middleware (unit-тест на `httptest.ResponseRecorder` с `http.Flusher` assertion).

## План тестирования

### Unit-тесты
- В `api_test.go` табличные тесты routes + негативные (404/400/403/413/501).
- `middleware_test.go` для каждого middleware.
- Coverage `internal/api` ≥ 70 %.

### Integration-тесты
- Поднимаем реальный `httptest.NewServer` и делаем HTTP-запросы.

### E2E / Browser-тесты
- Не применимо (JS + Playwright в T26).

## Definition of Done
- [ ] Линтеры и тесты зелёные.
- [ ] Coverage `internal/api` ≥ 70 %.
- [ ] `curl localhost:8080/api/healthz` и все стабы работают локально.
- [ ] Коммиты `feat(api): http skeleton + middleware`.
- [ ] PR, merge, `tasks/README.md` T12 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t12-http-skeleton`
3. Mux → middleware → routes → embed → тесты.
4. PR, merge.

## Out-of-band
- Если ResponseWriter-wrapper ломает `http.Flusher` для SSE — остановись и продумай, как сохранить `Flusher`/`Hijacker` через wrapper (например, type-assert и делегирование). Не соглашайся на костыль, который ломает NFR-02.
