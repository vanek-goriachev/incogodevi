# T10: EntryPointsResolver

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (разделы: 2.2 FR-06, FR-07, FR-10)
- `docs/architecture.md` (раздел 3.2 EntryPointsResolver, ADR-09)
- `docs/api-contract.md` (`POST /analyze` body `entry_points` §2, ошибка `invalid_entry_point`)
- `docs/design.md` (5.4 Entry points styling, J2 «смена entry points»)

## Зависимости
- **T04** — `EntryPointSpec`, `EntryPointMode`, `ErrInvalidEntryPoint`.
- **T07** — `*types.Package` с полными `Scope()`.
- **T08** — существующий `Graph` с узлами и стабильными IDs.

## Цель
Реализовать `entry.Resolver`: из `EntryPointSpec` (auto | manual | mixed) + `*types.Package[]` + `Graph` — возвращает set из `[]string` (Node.ID точек входа), валидирует manual-FQN, выдаёт `ErrInvalidEntryPoint` для несуществующих.

## Scope

### В scope
- `server/internal/entry/resolver.go`:
  - `type Resolver struct{ logger *slog.Logger }`
  - `func (r *Resolver) Resolve(spec domain.EntryPointSpec, pkgs []*packages.Package, g *domain.Graph) ([]string, []domain.Warning, error)`
    - `mode=auto`: найти все `func main()` в пакетах `package main` внутри project (т. е. пакеты, чей `PkgPath` входит в project module; не stdlib) → собрать Node.ID этих функций (FR-06, FR-10).
    - `manual`: для каждого FQN `pkg/path#Type.Method` (или `pkg/path#Func`):
      - распарсить: split по `#` → pkg и member; split member по `.` → type (опц.) и name.
      - `scope := findPackage(pkgs, pkgPath).Types.Scope()`
      - `obj := scope.Lookup(name)` — если type.method: сначала `scope.Lookup(type)` → `*types.Named` → итерировать `NumMethods()` → `Method(i).Name() == method`.
      - если obj не найден → добавить в `invalidFQNs []string`, продолжить.
      - если все manual успешны → не добавлять warning; если хотя бы один невалиден — вернуть `ErrInvalidEntryPoint` с details `{fqns: [...]}` (API-contract §2).
    - `interface_impl []string` (FQN интерфейсов): для каждого — найти все implementations (через ребра `implements` из Graph), включить их методы в entry set (расширяет auto/manual).
    - Дедуплицировать, отсортировать по `NodeID` для стабильности.
    - Возвращать `ids []string` + `warnings` (пустые) + `error`.
  - Модифицировать Graph (Node.IsEntry = true) — делает **вызывающий** (T13/T15 оркестратор); резолвер не мутирует.
- `server/internal/entry/resolver_test.go`:
  - `TestAutoSingleMain`: пакет main с `func main()` → 1 entry.
  - `TestAutoMultipleMain`: monorepo `cmd/a` + `cmd/b` → 2 entries (FR-06 acceptance).
  - `TestManualFunc`: `pkg#Func` → резолвится.
  - `TestManualMethod`: `pkg#Type.Method` → резолвится.
  - `TestManualInvalid`: `pkg#Nope` → `ErrInvalidEntryPoint` с `details.fqns=["pkg#Nope"]`.
  - `TestInterfaceImpl`: `interface_impl=["pkg#Store"]` → все методы всех реализаций включены.
  - `TestMixedMode`: `auto + manual` → union.

### Вне scope
- BFS/DFS reachability — **T11**.
- HTTP парсинг body — **T15**.
- UI панель управления entry points — **T22**.

## Технические детали
- Формат manual FQN: `<pkgPath>#<TypeName>.<MethodName>` или `<pkgPath>#<FuncName>` (без Type).
- Валидация на старте: пустые или malformed FQN (без `#`, неверные символы) → сразу `ErrInvalidEntryPoint`.
- «Project local» пакеты определяются module prefix из `go.mod` module path (передаётся через config или извлекается из первого пакета с `Module != nil`).
- `scope.Lookup` возвращает экспортированные и неэкспортированные objects — это ок (пользователь может задать не-exported).

## Acceptance criteria
- [ ] FR-06 acceptance: monorepo `cmd/a/main.go` + `cmd/b/main.go` → resolver возвращает 2 entry IDs соответствующих `main` функций.
- [ ] FR-07 acceptance: manual `pkg/api#Handler` (с методами) → резолвится, метод становится entry.
- [ ] Invalid manual → `ErrInvalidEntryPoint`, details содержит список невалидных FQN.
- [ ] `interface_impl` расширяет set — все implementations включены.
- [ ] Стабильность: идентичный input → идентичный output.

## План тестирования

### Unit-тесты
- Таблично-ориентированные, с testdata Go-проектов `testdata/main_multiple`, `testdata/iface_impls`.
- Coverage ≥ 85 %.

### Integration-тесты
- Полный прогон parser(T07) + builder(T08) + iface(T09) + resolver на testdata.

### E2E / Browser-тесты
- Не применимо (UI в T22, HTTP в T15).

## Definition of Done
- [ ] Линтеры и тесты зелёные.
- [ ] Coverage `internal/entry` ≥ 85 %.
- [ ] Коммиты `feat(entry): …`.
- [ ] PR, merge, `tasks/README.md` T10 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t10-entry-points-resolver`
3. API → auto → manual → interface_impl → тесты.
4. PR, merge.

## Out-of-band
- Формат FQN `pkg/path#Type.Method` документировать в API-contract и UI — он должен отображаться пользователю как подсказка. Если появится желание использовать `.` в pkg-path как разделитель (что создаст неоднозначность) — предложи `/` и остановись на этом.
