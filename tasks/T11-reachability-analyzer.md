# T11: ReachabilityAnalyzer + агрегация пакетов

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (разделы: 2.2 FR-08, 2.3 FR-18, 2.4 FR-19, FR-20)
- `docs/architecture.md` (3.2 ReachabilityAnalyzer, ADR-06 package aggregation)
- `docs/api-contract.md` (`GET /graph?aggregate=…` §3, `GET /dead-code` §4)

## Зависимости
- **T04** — `Graph`, `Node.Reachable`, `DeadCodeEntry`, `DeadCodeReport`.
- **T08** — существующий `Graph` с рёбрами (`calls`, `contains`, `imports`, `embeds`, `references`).
- **T09** — рёбра `implements`.
- **T10** — список entry Node.ID.

## Цель
Реализовать:
1. `reach.Analyzer`: BFS/DFS от entry points через traversable edges (`calls`, `references`, `implements`, `contains`, `embeds`, `imports` — по direction from entry) → маркирует `Node.Reachable`, возвращает `DeadCodeReport` (FR-19, FR-20).
2. `reach.Aggregator`: если `len(Graph.Nodes) > 1000` — отдаёт альтернативный «package-aggregated» граф (один узел = один пакет, `child_count`), сохраняя стабильные `Node.ID` (ADR-06/07).

## Scope

### В scope
- `server/internal/reach/analyzer.go`:
  - `type Analyzer struct{ logger *slog.Logger }`
  - `func (a *Analyzer) Mark(g *domain.Graph, entryIDs []string) error` — мутирует `g.Nodes[i].Reachable`, `g.Stats.DeadCount`.
    - Построить adjacency list `map[NodeID][]Edge` по тем рёбрам, которые считаем «достижимость»:
      - `calls` — прямое направление source→target
      - `implements` — source (тип) → target (интерфейс); и наоборот: если entry — интерфейс, то и реализации достижимы (решаем: **в обе стороны** через implements, но только из entry, где entry — interface)
      - `contains` — в обе стороны (entry-метод означает struct, содержащая её, тоже достижима; entry-struct означает её поля достижимы)
      - `embeds` — source→target (Outer embed Inner → Inner достижим)
      - `references` — source→target (использование var/const)
      - `imports` — НЕ используем для reachability (пакет импортирует пакет ≠ используются все его функции)
    - BFS от entryIDs; `reached := set[NodeID]`.
    - `for i := range g.Nodes { g.Nodes[i].Reachable = reached[g.Nodes[i].ID] }` (по индексу — `for _, n := range` даёт копию, мутация теряется).
    - `g.Stats.DeadCount = total - |reached|`.
  - `func (a *Analyzer) DeadCode(g *domain.Graph) *domain.DeadCodeReport`:
    - Собрать все `Node.Reachable == false` (кроме `NodeKind.package` — пакеты не помечаем dead, их dead-ность определяется по всем детям).
    - Заполнить `DeadCodeEntry{Kind, FQN, Package, Name, File, Line, Reason:"unreachable"}`.
- `server/internal/reach/aggregator.go`:
  - `func Aggregate(g *domain.Graph) *domain.Graph`: группировка по `Node.Package`.
    - Один узел на пакет: `Node{ID: NodeID(pkg, "", ""), Kind: package, Name: pkg, Reachable: any child reachable, ChildCount: N}`.
    - Рёбра: только `imports` между пакетами (остальные убираем или сливаем в метаданные).
    - Результат: `Graph` с `len(Nodes) == len(packages)`, `Stats` пересчитан.
- `server/internal/reach/*_test.go`:
  - `TestReachLinear`: A→B→C, entry={A} → все reachable; entry={B} → A dead, B/C reachable.
  - `TestReachDisconnected`: A и B не связаны, entry={A,B} → оба reachable, остальные dead.
  - `TestDeadCodeReport`: содержит верные FQN/file/line.
  - `TestAggregator`: 3 пакета с 1500 узлами → Aggregate возвращает 3-узловый граф с `ChildCount[pkg]=N`.
  - `TestFR19Acceptance`: из requirements §2.4 — контрольный testdata с предрасчитанным списком dead → результат совпадает 100 %.

### Вне scope
- `text/plain` и `application/json` рендер отчёта в ответ HTTP — **T16**.
- Агрегация отображаемая на клиенте (compound nodes) — Cytoscape в **T24**.
- `POST /expand?package=…` — **T24 (nice-to-have)**, вне MVP пути.

## Технические детали
- Поле `Node.ChildCount` уже определено в T04 (`json:"child_count,omitempty"`) — используй его для package-aggregated узлов.
- Performance: BFS O(V+E). Для 50k LOC — ~десятки тысяч nodes, сотни тысяч edges → ≤ 100 мс (не bottleneck NFR-01).
- Edge direction table — вынеси в `reach.traversable()` constants, чтобы было легко править.

## Acceptance criteria
- [ ] FR-08 acceptance: A→B→C, entry={A} → 3 reachable; entry={B} → 2 reachable, A dead.
- [ ] FR-10 acceptance: entry={A,B} несвязанные → 2 компонента связности, каждая достижима от своего entry.
- [ ] FR-19 acceptance: 100 % precision/recall на `testdata/deadcode_case`.
- [ ] FR-20 acceptance: `DeadCodeReport.Entries` формат `kind pkg.name file:line`, пустой список обрабатывается корректно.
- [ ] FR-18 acceptance: > 1000 nodes → Aggregate возвращает package-level граф; `Node.ID` пакета стабилен.

## План тестирования

### Unit-тесты
- Таблично, синтетические графы (без нужды в testdata Go-проекта).
- Coverage ≥ 85 %.

### Integration-тесты
- Прогон T07→T08→T09→T10→T11 на `testdata/deadcode_case` — ожидаемый DeadCodeReport зафиксирован в `expected.json`.

### E2E / Browser-тесты
- Не применимо.

## Definition of Done
- [ ] Линтеры и тесты зелёные.
- [ ] Coverage `internal/reach` ≥ 85 %.
- [ ] Бенчмарк `BenchmarkReach` на среднем testdata (50k LOC) — фиксируем в comments.
- [ ] Коммиты `feat(reach): …`.
- [ ] PR, merge, `tasks/README.md` T11 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t11-reachability`
3. Analyzer → DeadCode → Aggregator → тесты.
4. PR, merge.

## Out-of-band
- Если BFS оказывается bottleneck для 50k LOC (редко, но возможно из-за allocs в adjacency map) — переключись на slice-based adjacency с пре-allocated capacity; профайлинг через `go test -bench`.
