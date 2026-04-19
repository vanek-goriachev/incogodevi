# T15: `POST /api/projects/{id}/analyze` — SSE

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (2.2 FR-06..FR-10, 2.4 FR-19, 3.1 NFR-01/02, 3.3 NFR-08)
- `docs/architecture.md` (§5 Dynamic view, ADR-03, ADR-10)
- `docs/api-contract.md` (§2 полностью)

## Зависимости
- **T10 EntryPointsResolver**, **T11 ReachabilityAnalyzer** — через оркестратор.
- **T13 Orchestrator + SSEStreamer** — делает основную работу.
- **T12 HTTP-скелет** — routes.

## Цель
Подключить реальный SSE-поток на `POST /api/projects/{id}/analyze`: парсинг тела (`EntryPointSpec`+`Filters`), вызов `Orchestrator.Run`, корректная обработка отключения клиента, ошибки (404/409/400).

## Scope

### В scope
- `server/internal/api/analyze_handler.go`:
  - Handler `POST /api/projects/{id}/analyze`:
    - Валидация `{id}` — `ProjectID` regex + `cache.GetProject(id)` → `ErrProjectNotFound` → 404 `project_not_found`.
    - Декод body (JSON): `var req struct{ EntryPoints *domain.EntryPointSpec; Filters *domain.Filters }`. Пустое тело допустимо → defaults.
    - Валидация `include_kinds`: каждая строка должна быть допустимым `NodeKind.IsValid()` → иначе 400 `invalid_filters`.
    - `stream, err := api.NewSSEStreamer(w)` — если `Flusher` нет → 500.
    - `stream.Emit` сразу первый `phase:{loading}` — клиент видит keepalive.
    - `Orchestrator.Run(ctx, id, spec, filters, stream)`:
      - `ErrAnalysisInProgress` — **НО мы уже отправили SSE headers** → эмитим `done:{failed, error:{code:"analysis_in_progress"}}` и закрываем (поздно переключаться на 409). Альтернатива: проверить `inflight` **до** `NewSSEStreamer` и вернуть настоящий 409 JSON. Предпочти второй путь.
      - `ErrInvalidEntryPoint` — аналогично: если проверить до SSE (сделать preflight resolve в orchestrator или отдельный метод) → 400 `invalid_entry_point`. Иначе — `done:{failed, error:…}`.
    - На клиентский disconnect (ctx.Done) — orchestrator сам сворачивается; handler возвращается.
- Preflight метод на Orchestrator: `PreflightValidate(id, spec, filters) error` — проверяет единственную быструю вещь: invalid entry points FQN. Для этого нужен уже распарсенный проект (parsed.gob из cache), иначе отложить валидацию manual до основной phase. Если parsed.gob нет → валидировать формат FQN (структурно), а семантическую ошибку отправлять в SSE done:failed.
- `analyze_handler_test.go`:
  - `TestHappyPath` — upload (через T14) → analyze → получаем всю последовательность events.
  - `TestProjectNotFound` → 404 (обычный JSON, не SSE).
  - `TestInvalidFilter` → 400 (обычный JSON).
  - `TestEmptyBody` — defaults применяются, happy path.
  - `TestSingleFlight` — два одновременных analyze на один id → второй получает 409.
  - `TestClientDisconnect` — cancel client mid-stream → server завершается ≤ 500 ms, cache не повреждён.

### Вне scope
- Фронтенд-потребление SSE — **T19**.
- `GET /graph` fallback — **T16**.
- Performance benchmarks NFR-01 — внутри этой задачи добавим `go test -bench` на `testdata/medium` (≥ 50k LOC пока нет — бенчмарк на synthetic, финальная проверка на `testdata/medium` в T26).

## Технические детали
- POST с body (JSON) + streaming response — единственный способ, т.к. EventSource не умеет POST. Клиент использует `fetch()` + ReadableStream (T19).
- Заголовки SSE задаёт `NewSSEStreamer`. Дополнительно `w.WriteHeader(200)` **должен быть до** первого `Flush()`.
- Чтение тела: `r.Body` ограничен небольшим размером (≤ 1 МБ) — `http.MaxBytesReader(w, r.Body, 1<<20)`.
- На ошибке парсинга JSON — `400 invalid_filters` (или отдельный `invalid_body`).

## Acceptance criteria
- [ ] SSE headers выставлены корректно: `text/event-stream`, `no-cache`, `keep-alive`, `X-Accel-Buffering: no`.
- [ ] Happy path: последовательность events включает `phase:loading`, `phase:parsing` (опц), `phase:building_graph`, ≥1 `partial_graph`, `phase:reachability`, `phase:exporting`, `done`.
- [ ] NFR-02 sanity: для `testdata/simple` первый `partial_graph` приходит < 5 с.
- [ ] 404 `project_not_found` для несуществующего id — обычный JSON, не SSE.
- [ ] 409 `analysis_in_progress` отдаётся как JSON, не как SSE-done.
- [ ] 400 `invalid_filters` — обычный JSON.
- [ ] Client disconnect → server cleanly завершается.
- [ ] Bench: `BenchmarkAnalyzeSimple` зафиксирован в тестах (sanity-check NFR-01 на малом проекте; полноценный 50k LOC бенч — в T26).

## План тестирования

### Unit-тесты
- В `analyze_handler_test.go` через `httptest` + собственный примитивный SSE-парсер (переиспользуется с фронт-тестом T19).
- Coverage `analyze_handler` ≥ 80 %.

### Integration-тесты
- Прогон на `testdata/simple` и `testdata/with_interfaces` end-to-end.

### E2E / Browser-тесты
- Оставлено на **T26** (полный journey upload+analyze+graph через Playwright).

## Definition of Done
- [ ] Линтеры и тесты зелёные.
- [ ] Coverage ≥ 80 %.
- [ ] `curl -N -X POST -H "Accept: text/event-stream" …/analyze -d '{"entry_points":{"mode":"auto"}}'` показывает корректный stream (запиши пример в `server/README.md`).
- [ ] Коммиты `feat(api): analyze sse endpoint`.
- [ ] PR, merge, `tasks/README.md` T15 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t15-analyze-sse`
3. Handler + preflight + тесты.
4. PR, merge.

## Out-of-band
- Если nginx/прокси между тестовым окружением и клиентом буферизует SSE — нужен `X-Accel-Buffering: no` (уже есть). В README `localhost only for MVP`.
- Если `go test -bench` на `testdata/simple` показывает >> ожидаемого — не блокируй мёрдж, создай issue и продолжи; NFR-01 проверяется на `testdata/medium` в T26.
