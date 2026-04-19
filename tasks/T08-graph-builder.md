# T08: GraphBuilder

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (разделы: 2.1 FR-05, 2.2 FR-08, 3.1 NFR-01)
- `docs/architecture.md` (разделы: 3.2 GraphBuilder, 4 Data model, ADR-07)
- `docs/design.md` (разделы: 5.1 8 NodeKind, 5.2 6 EdgeKind)
- `docs/diagrams/rendered/05-data-model.png`

## Зависимости
- **T01** — пакет `server/internal/graph/`.
- **T04** — `Node`, `Edge`, `Graph`, `NodeKind`, `EdgeKind`, `NodeID`, `EdgeID`, `Warning`.
- **T07** — `parser.LoadResult` (включая живые `*types.Package`) + `ReducedPackage`.

## Цель
Реализовать `graph.Builder`: из загруженных пакетов строит `domain.Graph` с 8 типами узлов и 5 типами рёбер (`imports`, `contains`, `calls`, `embeds`, `references`). Ребро `implements` — в отдельной задаче **T09**.

## Scope

### В scope
- `server/internal/graph/builder.go`:
  - `type Builder struct{ logger *slog.Logger }`
  - `type BuildInput struct{ Packages []*packages.Package; Reduced []*parser.ReducedPackage }`
  - `func (b *Builder) Build(ctx context.Context, in BuildInput, progress chan<- float64) (*domain.Graph, error)`
  - Узлы (итерация по `pkg.TypesInfo.Defs` + `pkg.Types.Scope().Names()`):
    - `package`: один узел на пакет (`Node.ID = domain.NodeID(pkg.PkgPath, "", "")`)
    - `struct`, `interface`: из `*types.Named`/`*types.Alias`/`*types.TypeName` с `Underlying()` типа `*types.Struct`/`*types.Interface`
    - `func`, `method`: `*types.Func`; метод отличается по `Signature.Recv() != nil`
    - `field`: поля `struct` — итерация `Struct.NumFields()` (узлы с родителем-структурой через ребро `contains`)
    - `var`, `const`: `*types.Var` в pkg scope (не локальные переменные — локальные вне scope MVP, ADR-07)
  - Рёбра:
    - `imports`: от `package` A → `package` B для каждого импорта (`pkg.Imports`)
    - `contains`: от `package` → его типы/функции/var/const; от `struct` → её поля; от `interface` → её методы
    - `calls`: из тела функций/методов через `ast.Inspect` + `pkg.TypesInfo.Uses[ident]` на `*types.Func`. Для MVP — дубликаты ребра объединяются, `Edge.Weight = count`
    - `embeds`: `struct { A }` или `interface { I }` — через `Struct.Field(i).Embedded()` или `Interface.EmbeddedType(i)`
    - `references`: прочие уводы `TypesInfo.Uses` (читаем `var`, `const`, `types.TypeName`) — как слабое «depends on»
  - Поле `Node.Reachable` **не заполняется здесь** (это делает ReachabilityAnalyzer T11).
  - Поле `Node.IsEntry` не заполняется (EntryPointsResolver T10).
  - Прогресс: обход по пакетам, emit `float64` по мере завершения каждого.
  - Возвращать `Graph{Nodes, Edges, Warnings, Stats, SchemaVersion}` c заполненным `Stats.ByKind` и счётчиками.
- `server/internal/graph/ast_calls.go` — хелперы извлечения `calls` из AST (используя `pkg.Syntax` + `TypesInfo.Uses`).
- `server/internal/graph/*_test.go`:
  - Таблично: `testdata/simple` (3 функции A→B→C), `testdata/with_struct` (struct + поля + метод), `testdata/embedded` (`struct { Inner }` → `embeds` + наследованные методы).
  - `TestBuildNodeCounts` — ожидаемые counts по kind совпадают с расчётом (FR-05).
  - `TestBuildEdges` — для A→B→C: `calls` ребра A→B и B→C существуют, C→A отсутствует.
  - `TestStableIDs` — повторный `Build` на том же input → те же `Node.ID`.

### Вне scope
- `implements` рёбра (интерфейсы через `types.Implements`) — **T09**.
- `reachable` маркировка — **T11**.
- Entry-points — **T10**.

## Технические детали
- `go/types`: `*types.Named`, `*types.Struct`, `*types.Interface`, `*types.Signature`. Документация: https://pkg.go.dev/go/types. `types.Unalias(t)` — для разворачивания type aliases.
- `calls`: итерируем `pkg.Syntax` (AST-файлы), для каждого `*ast.CallExpr` смотрим `TypesInfo.Uses[ident]` → если `*types.Func` — добавляем ребро (source = enclosing func, target = called func). Helper `enclosingFunc(fset, node)` через простой обход.
- Edge dedup: `map[struct{Src,Tgt string; Kind EdgeKind}]*Edge`, инкремент `Weight`.
- `NodeID` из T04 — стабильность ID критична для FR-26/ADR-07.
- Поля `Exported`, `Package`, `File`, `Line`, `Doc` — заполняются через `token.Position(obj.Pos())` и `obj.Name()[0]` uppercase.

## Acceptance criteria
- [ ] `testdata/simple` (пакет с 3 функциями A→B→C): Graph содержит 1 package-node + 3 func-node; 3 contains + 2 calls = 5 рёбер минимум.
- [ ] `testdata/with_struct`: узлы для struct, её полей, её методов; рёбра `contains` от struct к полям; `contains` от пакета к struct.
- [ ] `testdata/embedded`: `struct Inner` embedded в `Outer` → есть ребро `Outer -embeds-> Inner`; методы Inner доступны и на Outer — но это реализуется не тут, а в T09.
- [ ] Stable IDs: повторный Build → идентичные `Node.ID`/`Edge.ID`.
- [ ] FR-05 acceptance: для контрольного testdata кол-ва узлов по `Kind` совпадают с заранее посчитанными (±0).
- [ ] Prod-progress канал закрыт после Build.

## План тестирования

### Unit-тесты
- См. выше. Coverage ≥ 75 %.

### Integration-тесты
- Вся T07+T08 pipeline на `testdata/` через вызов `parser.Load` → `graph.Build`. Ожидаемые counts зафиксированы в `expected.json` рядом с testdata.

### E2E / Browser-тесты
- Не применимо.

## Definition of Done
- [ ] Линтеры и тесты зелёные.
- [ ] Coverage `internal/graph` ≥ 75 %.
- [ ] Коммиты `feat(graph): …`.
- [ ] PR, merge, `tasks/README.md` T08 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t08-graph-builder`
3. Начни с узлов, затем рёбра по одному kind за раз + тест.
4. PR, merge.

## Out-of-band
- Размытая граница `calls` vs `references`: договор — `calls` строго между функциями (включая методы). Чтение `var`/`const` — `references`. Если на реальных данных `calls` взрываются > 10× от `nodes` — вероятно баг dedup. Остановись и уточни.
