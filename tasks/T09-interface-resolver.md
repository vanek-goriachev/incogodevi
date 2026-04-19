# T09: InterfaceResolver — рёбра `implements`

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (раздел: 2.2 FR-09)
- `docs/architecture.md` (ADR-05 «`types.Implements` + `types.NewMethodSet`», 3.2 GraphBuilder)
- `docs/design.md` (раздел 5.2 EdgeKind `implements`)

## Зависимости
- **T04** — `Edge`, `EdgeKind.Implements`, `EdgeID`.
- **T07** — `*types.Package`, `*types.Interface`, `*types.Named`.
- **T08** — существующий `Graph` с узлами `struct`/`interface` и `Node.ID` из `types.Object`.

## Цель
Дополнить graph-строитель: для каждой пары `(*types.Named, *types.Interface)` из проекта добавить ребро `implements` когда `types.Implements(types.NewPointer(T), I)` — true. Учесть embedding через `types.NewMethodSet` и type aliases через `types.Unalias`.

## Scope

### В scope
- `server/internal/graph/implements.go`:
  - `type ImplementsResolver struct{ logger *slog.Logger }`
  - `func (r *ImplementsResolver) Resolve(ctx context.Context, pkgs []*packages.Package, nodesByTypeFQN map[string]string) ([]domain.Edge, error)`
    - Собрать все `*types.Interface` из project packages (только non-empty interfaces, `.NumMethods() > 0` — пустой интерфейс `any` не считаем).
    - Собрать все `*types.Named` (structs, named types).
    - Для каждой пары (T, I): `types.Implements(types.NewPointer(T), I)` (учитывает pointer receivers и embedded-методы через `NewMethodSet`).
    - Если ок и `T != I` (interface не реализует сам себя в нашем графе) → добавить `Edge{Source: NodeID(T), Target: NodeID(I), Kind: implements, Weight: 1}`.
    - Dedup по `EdgeID`.
    - Развернуть type aliases через `types.Unalias` перед сравнением.
    - Прогресс: `progress chan<- float64` — значение = (done pairs) / (|T|·|I|).
- Интеграция в `graph.Builder`: после базовых рёбер (T08) вызвать `ImplementsResolver.Resolve`, смержить рёбра.
- `server/internal/graph/implements_test.go`:
  - `testdata/iface_single_impl`: интерфейс `I`, реализация `A` без embedding → ребро есть.
  - `testdata/iface_embedded`: `struct Outer { Inner }`, `Inner` реализует `I` через методы с pointer receiver → ребро `Outer -implements-> I` присутствует.
  - `testdata/iface_alias`: `type Alias = Concrete` → `Alias` тоже имплементирует `I`.
  - `testdata/iface_empty`: пустой `any` не порождает рёбер (иначе O(N²) флуд).
  - `TestEdgeStability` — два запуска дают одинаковый set рёбер.

### Вне scope
- Сбор базовых рёбер — **T08**.
- Использование `implements` в entry-points для «включить все реализации» — **T10**.

## Технические детали
- Канонический паттерн (ADR-05):
  ```go
  for _, T := range namedTypes {
      pT := types.NewPointer(T) // ловим pointer receivers
      for _, I := range projectIfaces {
          if types.Implements(pT, I) { emit(T, I) }
      }
  }
  ```
- Если `T` — interface сам (T.Underlying() — `*types.Interface`) → пропускаем (граф без interface→interface `implements`; embedded-интерфейс моделируется `embeds` в T08).
- `types.NewMethodSet(T)` используется автоматически внутри `Implements` — явный вызов не нужен, но полезен для debug/log.
- Перфоманс: O(|T| · |I|) — для 50 000 LOC ориентировочно 5 000 × 500 = 2.5 M проверок, укладывается в NFR-01.
- Type aliases (Go 1.22+, enabled by default в 1.23): используй `types.Unalias(t).(*types.Named)` при необходимости.
- Stdlib interfaces (io.Reader, http.Handler и т. д.) — **считать ли их interfaces?** Per design: рисуем `implements` только на **project-local** интерфейсы (иначе будут сотни рёбер к `io.Reader`). Фильтр: `I.Obj().Pkg().Path()` ∈ множество project PkgPaths.

## Acceptance criteria
- [ ] FR-09 acceptance (из requirements): 2 реализации интерфейса `I`, только одна используется в entry points → вторая помечена dead (это делает T11; здесь — обе имеют ребро `implements` к `I`).
- [ ] Embedded-случай: Outer имеет `implements → I` (через Inner).
- [ ] Type alias: `type A = Concrete` → `A` имплементирует всё, что `Concrete`.
- [ ] Stdlib interface `io.Reader` — **нет** рёбер `implements` если не включён в проект (по дефолту).
- [ ] Прогон T07+T08+T09 на `testdata/with_interfaces` даёт графы с ожидаемым set `implements` рёбер.
- [ ] `Edge.ID` стабилен между запусками.

## План тестирования

### Unit-тесты
- Таблично: одиночный impl, embedded, alias, pointer receiver, value receiver, несколько реализаций.
- Coverage ≥ 80 %.

### Integration-тесты
- Полный прогон `testdata/with_interfaces` → ожидаемые рёбра из `expected.json`.

### E2E / Browser-тесты
- Не применимо.

## Definition of Done
- [ ] Линтеры и тесты зелёные.
- [ ] Coverage пакета graph ≥ 80 %.
- [ ] Бенчмарк `BenchmarkImplements` на testdata — оставить результат в comment для sanity; fail-threshold не ставим (железо разное).
- [ ] Коммиты `feat(graph): implements edges …`.
- [ ] PR, merge, `tasks/README.md` T09 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t09-interface-resolver`
3. Реализация + testdata + тесты + бенчмарк.
4. PR, merge.

## Out-of-band
- Если на крупном реальном проекте пара (T, I) даёт > 10k рёбер — пересмотри фильтрацию stdlib. Спроси пользователя, если ограничивать ещё сильнее (напр., только интерфейсы, которые явно упоминаются в entry-points поддереве).
