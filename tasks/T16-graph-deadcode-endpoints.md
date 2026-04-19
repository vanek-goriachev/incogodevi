# T16: `GET /graph` + `GET /dead-code` + exporter

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (2.3 FR-18, 2.4 FR-19/20, 2.5 FR-23/24)
- `docs/architecture.md` (3.2 Exporter, ADR-06 aggregation)
- `docs/api-contract.md` (§3 GET /graph, §4 GET /dead-code)

## Зависимости
- **T04** — `Graph`, `DeadCodeReport`, типы.
- **T05** — `cache.Manager.ReadGraph/ReadDeadCode`.
- **T11** — `reach.Aggregator` для package-aggregated graph.
- **T12 / T15** — HTTP-скелет, авторитативный analyze-pipeline (он же пишет в cache).

## Цель
Реализовать два GET endpoint'а + exporter для dead-code в форматах JSON и TXT; корректно обрабатывать `aggregate=auto|package|none`, `include_dead`, `format=json|txt`, `download=1` (Content-Disposition).

## Scope

### В scope
- `server/internal/api/graph_handler.go`:
  - `GET /api/projects/{id}/graph`:
    - `cache.ReadGraph(id)` → `domain.Graph` или `ErrProjectNotFound` (404) или `ErrNoGraphYet` (404 `no_graph_yet`) или `ErrStaleCache` (503).
    - Query params: `aggregate` default `auto`; `include_dead` default `true`; **`scope=<package/path>`** (optional, для раскрытия одного пакета в aggregated режиме — см. T24).
    - Если `aggregate=package` ИЛИ (`aggregate=auto` AND `len(Nodes) > 1000`) → `reach.Aggregate(g)`.
    - Если `scope` указан → отфильтровать `Nodes` до узлов с `Node.Package == scope` (плюс сам package-node, если остаётся) + рёбра, где **оба** конца из этого пакета; `aggregation == "none"` в ответе. При неизвестном `scope` → 400 `invalid_scope` со списком валидных в `details.packages`.
    - Если `include_dead=false` → фильтровать `Reachable==true` на сервере (рёбра, оба конца должны быть live).
    - Response: JSON по схеме api-contract §3 (project_id, generated_at, aggregation, stats, nodes, edges, warnings).
- `server/internal/api/deadcode_handler.go`:
  - `GET /api/projects/{id}/dead-code`:
    - Query `format=json|txt` (default `json`; можно через `Accept`).
    - `download=1` → `Content-Disposition: attachment; filename="<project>-dead-code.<ext>"`.
    - `cache.ReadDeadCode(id)` → 200 или 404.
    - JSON: `exporter.RenderJSON(report)`.
    - TXT: `exporter.RenderTXT(report)` — строки формата `<kind> <fqn> — <file>:<line>`; пустой отчёт → `"no dead code detected\n"` (FR-20).
  - `format` не в `{json, txt}` → 400 `invalid_format`.
- `server/internal/exporter/exporter.go`:
  - `func RenderTXT(r *domain.DeadCodeReport) []byte`
  - `func RenderJSON(r *domain.DeadCodeReport) ([]byte, error)`
  - Детерминированный порядок: sort по `Package`, `File`, `Line`.
- Тесты:
  - `graph_handler_test.go`: happy, aggregate auto/package/none, include_dead toggle, 404, 503.
  - `deadcode_handler_test.go`: JSON, TXT, download flag, invalid_format.
  - `exporter_test.go`: round-trip RenderJSON → Unmarshal; RenderTXT ровно совпадает с ожидаемым snapshot (golden file).

### Вне scope
- SSE — T13/T15.
- `POST /expand?package=…` (nice-to-have) — **T24** (клиентский аспект), может быть добавлено позже.

## Технические детали
- JSON теги в Graph/DeadCodeReport — snake_case per api-contract.
- `aggregation` field в ответе: `"auto"` → фактическое решение указывается как `"package"` или `"none"`; клиент должен видеть `aggregation == "package"` если агрегирован.
- `exporter.RenderTXT` использует `fmt.Fprintf` и `bytes.Buffer`; LF line endings (`\n`), UTF-8, без BOM (FR-23).

## Acceptance criteria
- [ ] `GET /graph` happy → 200 + валидный JSON, `stats.dead_count` совпадает с `len(dead)`.
- [ ] `GET /graph?aggregate=package` → `aggregation == "package"`, `nodes` только package-уровня.
- [ ] `GET /graph?scope=foo/bar` → только узлы этого пакета; `aggregation == "none"`; неизвестный `scope` → 400 `invalid_scope`.
- [ ] `GET /graph?include_dead=false` → нет `Reachable==false` узлов и рёбер, где хоть один конец dead.
- [ ] `GET /dead-code?format=txt` → `text/plain; charset=utf-8`, формат совпадает с FR-20.
- [ ] `GET /dead-code?format=txt&download=1` → `Content-Disposition: attachment; filename="*-dead-code.txt"`.
- [ ] `GET /dead-code?format=json` → `application/json`, валидная схема FR-24.
- [ ] Empty: `no dead code detected\n` для TXT и `entries:[]` для JSON.
- [ ] 404 `no_graph_yet` для проекта без analyze.

## План тестирования

### Unit-тесты
- Табличные, golden files для TXT.
- Coverage handler'ов + exporter ≥ 85 %.

### Integration-тесты
- End-to-end через upload (T14) + analyze (T15) + GET (T16) на `testdata/simple`.

### E2E / Browser-тесты
- В T26 — через Playwright: кнопка «Export TXT» скачивает файл.

## Definition of Done
- [ ] Линтеры и тесты зелёные.
- [ ] Coverage ≥ 85 %.
- [ ] Коммиты `feat(api): graph+deadcode endpoints + exporter`.
- [ ] PR, merge, `tasks/README.md` T16 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t16-graph-deadcode`
3. Exporter → handlers → тесты (включая golden).
4. PR, merge.

## Out-of-band
- Если агрегация на `len(Nodes) > 1000` даёт ответ > 10 МБ JSON — значит агрегатор возвращает слишком много package-уровня рёбер; ревизируй threshold.
