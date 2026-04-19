# T13: AnalysisOrchestrator + SSEStreamer

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (3.1 NFR-01/02, 3.3 NFR-08/09)
- `docs/architecture.md` (3.1 SSEStreamer, 3.3 AnalysisOrchestrator, 5 Dynamic view, ADR-03, ADR-10)
- `docs/api-contract.md` (`POST /analyze` §2 SSE events, envelope ошибок)
- `docs/diagrams/rendered/04-flow-sse-sequence.png`

## Зависимости
- **T04** — `SSEEvent`, `AnalysisPhase`, `AnalysisStatus`, `Warning`, `Graph`.
- **T05** — `cache.Manager`, `Project.analyzeMu`.
- **T07** — `parser.Load` с progress-каналом.
- **T08/T09/T10/T11** — построители графа и reachability.
- **T12** — HTTP-скелет и middleware.

## Цель
Реализовать оркестратор: склеивает parser → graphBuilder → implementsResolver → entryResolver → reachAnalyzer → exporter в единый pipeline внутри per-project-ID goroutine; стримит SSE-события (`phase`, `partial_graph`, `warning`, `done`) через `SSEStreamer`. Single-flight per project_id (`sync.Map[id]*sync.Mutex`).

Отдельно: `SSEStreamer` — thin обёртка над `ResponseWriter` для `text/event-stream`.

## Scope

### В scope
- `server/internal/api/sse.go`:
  - `type SSEStreamer struct{ w http.ResponseWriter; flusher http.Flusher; seq int; enc *json.Encoder }`
  - `func NewSSEStreamer(w http.ResponseWriter) (*SSEStreamer, error)` — ставит headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`; type-assert `w.(http.Flusher)` — иначе ошибка.
  - `func (s *SSEStreamer) Emit(eventType string, payload any) error` — формат `event: <type>\ndata: <json>\n\n`, после `Flush()`. Инкремент `seq`.
  - `func (s *SSEStreamer) Close() error` — finalize.
- `server/internal/orchestrator/orchestrator.go`:
  - `type Orchestrator struct{ cache cache.Manager; parser *parser.Parser; builder *graph.Builder; iface *graph.ImplementsResolver; resolver *entry.Resolver; reach *reach.Analyzer; logger *slog.Logger; inflight sync.Map /* map[ProjectID]*sync.Mutex */ }`
  - `func (o *Orchestrator) Run(ctx context.Context, id domain.ProjectID, spec domain.EntryPointSpec, filters domain.Filters, stream *api.SSEStreamer) error`
    - Берём per-id mutex; если уже locked — возвращаем `ErrAnalysisInProgress` (409).
    - `defer recover()` — при panic: `stream.Emit("done", {phase:"failed", error:{...}})` + лог.
    - Последовательность:
      1. `stream.Emit("phase", {phase:"loading"})`
      2. `parser.Load(ctx, id, progressCh)` — на каждый progress-tick можно эмитить `phase:{phase:"parsing", progress:X}`.
      3. `stream.Emit("phase", {phase:"building_graph"})`; `builder.Build(...)`; `iface.Resolve(...)`.
      4. Периодически эмитим `partial_graph` — например, каждые 100 узлов: подвыборка уже построенных.
      5. `stream.Emit("phase", {phase:"reachability"})`; `resolver.Resolve(...)`; `reach.Mark(...)`.
      6. Помечаем `Node.IsEntry = true` для entry IDs.
      7. `reach.DeadCode(...)` → `DeadCodeReport`.
      8. `stream.Emit("phase", {phase:"exporting"})`; записать `graph.json` + `dead-code.json` в cache.
      9. Собираем все `Warning` и эмитим `stream.Emit("warning", w)` (за каждую или массив — см. контракт).
      10. `stream.Emit("done", {phase:"done", node_count, edge_count, warnings_count, elapsed_ms, graph_url})`.
    - Throttle `partial_graph` эмитов — max 1 per 100ms (чтобы не забить SSE буфер).
    - Context cancel (клиент закрыл EventSource) → graceful exit: лог, mutex отпускается в defer. Файлы cache уже записаны либо не записаны — consistent (atomic write из T05).
- `server/internal/api/sse_test.go`:
  - `TestSSEFormat` — emit → проверка заголовков + корректного формата `event:…\ndata:…\n\n`.
  - `TestSSESeq` — последовательность seq монотонна.
- `server/internal/orchestrator/orchestrator_test.go`:
  - `TestPipelineHappy` — `testdata/simple` → Emit последовательности включают `loading`, `parsing`, `building_graph`, `reachability`, `exporting`, `done`.
  - `TestSingleFlight` — два параллельных `Run` на один id → второй получает `ErrAnalysisInProgress`.
  - `TestPanicRecovery` — inject panic в сервис-mock → `stream.Emit("done", {failed, error})` корректно.
  - `TestContextCancel` — cancel mid-run → clean exit, последующий Run на том же id работает.
  - `TestWarningPassthrough` — parser возвращает warning → эмитится `warning` событие.

### Вне scope
- HTTP entry point `POST /analyze` — **T15** (он вызывает Orchestrator).
- `exporter` модуль (TXT/JSON рендер отчёта) — в рамках T13 пишем просто JSON через cache; форматирование для `/dead-code` endpoint — **T16**.

## Технические детали
- `sync.Map[id]*sync.Mutex` — ленивое создание mutex на первый запрос по id; sweeper в T05 удаляет запись из map при `DeleteProject`.
- SSE буфер эмитов: `time.Ticker(100ms)` для throttle `partial_graph`; остальные события — моментально.
- Формат `partial_graph`: `{seq, nodes:[...subset], edges:[...subset]}`. На клиенте (T19/T20) узлы добавляются incrementally.
- `done` payload содержит `graph_url:"/api/projects/<id>/graph"` — клиент делает fallback GET при реконнекте.
- Log-correlation: все slog-записи оркестратора должны содержать `project_id` через `slog.With`.

## Acceptance criteria
- [ ] Happy path на `testdata/simple`: SSE поток содержит (в порядке) `phase:loading`, `phase:parsing*`, `phase:building_graph`, ≥1 `partial_graph`, `phase:reachability`, `phase:exporting`, `done`.
- [ ] `done.elapsed_ms` > 0, `node_count` и `edge_count` совпадают с cache'd `graph.json`.
- [ ] Single-flight: второй `Run` во время активного → `ErrAnalysisInProgress`.
- [ ] Panic inject → `done.phase == "failed"`, соединение закрыто.
- [ ] Cancel client → server завершается ≤ 500 ms, `ctx.Err() == context.Canceled`.
- [ ] `warning` события прокидываются из parser.
- [ ] NFR-02 acceptance (sanity, не окончательная проверка): первый `partial_graph` прилетает < 5 с от старта на `testdata/simple`.

## План тестирования

### Unit-тесты
- Моки для `parser`/`builder`/`iface`/`resolver`/`reach` (интерфейсы в `orchestrator_deps.go`).
- Проверка порядка и семантики SSE-событий через `httptest.NewRecorder` — после Emit читаем буфер построчно.
- Coverage `internal/orchestrator` ≥ 80 %.

### Integration-тесты
- Реальный pipeline на `testdata/simple` + `testdata/with_interfaces` через `httptest.NewServer`.

### E2E / Browser-тесты
- Не применимо (выполнится в T26 через Playwright).

## Definition of Done
- [ ] Линтеры и тесты зелёные.
- [ ] Coverage `internal/orchestrator` ≥ 80 %.
- [ ] Коммиты `feat(orch): sse pipeline`.
- [ ] PR, merge, `tasks/README.md` T13 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t13-orchestrator-sse`
3. SSEStreamer → интерфейсы зависимостей → Run → integration.
4. PR, merge.

## Out-of-band
- Если при throttle `partial_graph` клиент видит узлы только в `done` (а не по ходу анализа) — NFR-02 не выполнится. Если бенчмарк показывает > 5 с до первого `partial_graph` — останавливайся и меняй стратегию (эмитить nodes раньше — во время билдинга, а не после).
