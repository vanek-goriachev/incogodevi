# T07: Parser + parsed.gob кэш

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (разделы: 2.1 FR-03/04/05, 3.1 NFR-01, 3.3 NFR-08)
- `docs/architecture.md` (разделы: 3.2 Parser, ADR-02, ADR-12)
- `docs/api-contract.md` (endpoints: `POST /analyze` §2 — понимание phase `parsing`)
- `docs/diagrams/rendered/04-flow-sse-sequence.png`

## Зависимости
- **T01** — пакет `server/internal/parser/`.
- **T04** — `Warning`, `AnalysisPhase`, `SchemaVersion`.
- **T05** — `cache.Manager.WriteParsedBlob/ReadParsedBlob`, `SourcesDir`.
- **T06** — готовый `SourcesDir` с распакованным проектом + валидным `go.mod`.

## Цель
Реализовать `parser.Parser`: обёртка над `golang.org/x/tools/go/packages.Load` с полным `LoadMode`, read-through кэш `parsed.gob`, сбор `Warning[]` без падения на `packages.Errors` (NFR-08), прогресс-каналом для `AnalysisPhase.parsing`.

## Scope

### В scope
- `server/internal/parser/parser.go`:
  - `type Parser struct{ cache cache.Manager; logger *slog.Logger }`
  - `type LoadResult struct{ Packages []*ReducedPackage; Warnings []domain.Warning; ElapsedMS int }`
  - `func (p *Parser) Load(ctx context.Context, id domain.ProjectID, progress chan<- float64) (*LoadResult, error)`
    - Сначала пробует `cache.ReadParsedBlob(id)` → `gob.Decode` → если схема валидна и не stale → вернуть кэш.
    - Иначе: `packages.Config{Mode: packages.NeedName|NeedFiles|NeedCompiledGoFiles|NeedImports|NeedDeps|NeedTypes|NeedTypesInfo|NeedSyntax|NeedModule, Dir: SourcesDir, Context: ctx, Env: append(os.Environ(), "GOFLAGS=-mod=mod"), Logf: nil}`
    - `packages.Load(cfg, "./...")` на `SourcesDir`.
    - Обход `packages.Visit`: для каждого пакета, если `len(pkg.Errors) > 0` — добавить `Warning{Code:"import_error", Message: err.Msg, Package: pkg.PkgPath}`; продолжить (NFR-08).
    - Стрим `progress` в диапазоне [0.0..1.0] по мере обработки пакетов (кол-во обработанных / общее).
    - Построить `[]*ReducedPackage` — минимальный снапшот, достаточный для GraphBuilder (T08): `PkgPath`, `Name`, `Imports []string`, `Types []ReducedType`, `Funcs []ReducedFunc`, `Vars/Consts []ReducedValue`. Нужно сохранить `types.Object` FQN и location (файл/строка) через `pkg.Fset.Position(obj.Pos())`. **Сам `*types.Package` не сериализуется** — он нужен GraphBuilder'у сразу после парсинга.
    - Записать через `cache.WriteParsedBlob(id)` → `gob.Encode(reducedPackages)`.
  - `type ReducedType struct{ FQN, Name, Kind string /* "struct"|"interface"|"alias"|"named" */; Fields []ReducedField; Methods []ReducedFunc; Embedded []string; File string; Line int }`
  - `type ReducedFunc struct{ FQN, Name, RecvType string; File string; Line int; IsMethod, Exported bool }`
  - `type ReducedField struct{ Name, TypeRef string; Exported bool; File string; Line int }`
  - `type ReducedValue struct{ FQN, Name, Kind string; File string; Line int; Exported bool }`
  - Gob-регистрация: `init()` с `gob.Register(ReducedPackage{})` и т.д.
- `server/internal/parser/walker.go`: итерация `pkg.TypesInfo.Defs` + `pkg.Types.Scope()` для наполнения `ReducedPackage`.
- `server/internal/parser/*_test.go`:
  - testdata: 2-3 мини-Go-проекта (`testdata/simple/`, `testdata/with_interfaces/`, `testdata/broken_import/`).
  - `TestLoadHappy`, `TestLoadCached` (второй раз быстрее), `TestLoadPartialWithWarnings` (broken import → Warning + остальные пакеты обработаны), `TestContextCancel`, `TestProgress` (ожидаем монотонно возрастающий stream).
  - Coverage ≥ 70 %.

### Вне scope
- Построение `domain.Graph` из ReducedPackage — **T08**.
- Загрузка типов интерфейсов и `types.Implements` — **T09**.
- SSE эмиты прогресса в HTTP — **T13/T15**.

## Технические детали
- `golang.org/x/tools/go/packages` v0.44+ (сверить с https://pkg.go.dev/golang.org/x/tools/go/packages на старте).
- **GraphBuilder (T08) нуждается в живом `*types.Package`**, а не в ReducedPackage. Решение: первая загрузка возвращает и ReducedPackage, и `[]*packages.Package` (не сериализуется). Второй вызов (cached) отдаёт только ReducedPackage и флаг `TypesUnavailable=true` — GraphBuilder в этом случае работает по ReducedPackage. Проверь с T08/T09: нужен ли им живой `types.Package` или можно вынести в ReducedPackage все нужные факты. **Если не уверен — остановись и согласуй API с будущим исполнителем T08/T09 через пользователя.**
- `GOFLAGS=-mod=mod` + отдельный `GOPATH=SourcesDir/../gopath` — чтобы не мусорить системный GOPATH. Документировать в slog на debug-level.
- При отсутствии сети и vendor: `packages.Errors` → warnings, продолжаем (ADR-02).
- SchemaVersion в заголовке `parsed.gob`: gob-encode `struct{ Version int; Pkgs []ReducedPackage }`; при несовпадении — rebuild.

## Acceptance criteria
- [ ] Happy path: `testdata/simple` → `LoadResult.Packages` содержит ровно `N` пакетов (тест знает N).
- [ ] Broken import: пакет с несуществующим импортом → `Warnings` non-empty, остальные пакеты обработаны.
- [ ] Cache hit: повторный `Load(ctx, id, …)` после первого — ≤ 10 % времени первого (бенчмарк-фактор).
- [ ] Progress stream: первый tick `0`, последний tick `1.0`, значения монотонно неубывающие.
- [ ] Context cancel во время Load → `ctx.Err() == context.Canceled` возвращается наружу.
- [ ] SchemaVersion bump → old `parsed.gob` инвалидируется, делается rebuild.

## План тестирования

### Unit-тесты
- Таблично с `testdata/`: happy, with-interfaces, broken-import, empty.
- Бенчмарк `BenchmarkLoadSimple` — информативный, не блокирующий.
- Coverage ≥ 70 %.

### Integration-тесты
- Прогон на реальном мини-Go-проекте (один из `testdata/`), сравнение с заранее посчитанным количеством сущностей (FR-05 acceptance).

### E2E / Browser-тесты
- Не применимо.

## Definition of Done
- [ ] `go vet`, `golangci-lint run`, `go test -race` — чисто
- [ ] Coverage `internal/parser` ≥ 70 %
- [ ] Коммиты `feat(parser): …`
- [ ] PR, merge, `tasks/README.md` T07 `[x]`

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t07-parser`
3. API ReducedPackage → walker → cache integration → тесты.
4. PR, merge.

## Out-of-band
- Если `packages.Load` в офлайн-режиме падает на testdata из-за stdlib-импортов — скорее всего нужен базовый `GOMODCACHE` с зеркалом. Задокументируй требование в README; для CI — `setup-go` уже даёт toolchain и `GOMODCACHE`.
- Если определишь, что `*types.Package` действительно нужен GraphBuilder'у (а он нужен для `types.Implements` в T09), **не сериализуй его** — просто пометь, что cache-hit не даёт быстрого пути для T09 (делаем rebuild в этом случае). Согласуй с пользователем.
