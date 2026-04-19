# T04: Доменные типы

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (разделы: 2.1–2.6, 5 MVP)
- `docs/architecture.md` (разделы: 4 «Data model», ADR-07, ADR-12)
- `docs/api-contract.md` (разделы: 1, 2, 3, 4 — все response-схемы, envelope ошибок)
- `docs/design.md` (разделы: 5.1, 5.2 — 8 NodeKind, 6 EdgeKind)
- `docs/diagrams/rendered/05-data-model.png`

## Зависимости
- **T01 Scaffold backend** — даёт `server/internal/domain/` директорию и `go.mod`.

## Цель
Зафиксировать доменные типы в `server/internal/domain/`: `Node`, `Edge`, `Graph`, `Warning`, `DeadCodeEntry`, `EntryPointSpec`, `Filters`, `AnalysisStatus`, `SSEEvent`, `NodeKind`, `EdgeKind`, `AnalysisPhase`, `SchemaVersion`. Сериализация в JSON (для API) + регистрация в `encoding/gob` (для disk cache `parsed.gob` в T07). Полное покрытие unit-тестами маршалинга.

## Scope

### В scope
- Создать:
  - `server/internal/domain/ids.go` — `ProjectID string`, функция `NewProjectID() ProjectID` (16 random bytes → URL-safe base64 без padding, 22 симв.; см. `api-contract.md §0`).
  - `server/internal/domain/node.go` — `NodeKind string` (enum + `IsValid()`), `Node struct{ ID, Name string; Kind NodeKind; Package, File string; Line int; Exported, Reachable, IsEntry bool; Doc string; ChildCount int }` (`ChildCount` с `json:"child_count,omitempty"`, нужен для package-aggregated узлов в T11 — у обычных узлов = 0 и в JSON не попадает). Функция `NodeID(pkg, typeName, member string) string` — SHA-1 16-hex (ADR-07).
  - `server/internal/domain/edge.go` — `EdgeKind string` (enum), `Edge struct{ ID, Source, Target string; Kind EdgeKind; Weight int }`. `EdgeID(source, target string, kind EdgeKind) string`.
  - `server/internal/domain/graph.go` — `Graph struct{ Nodes []Node; Edges []Edge; Warnings []Warning; Stats GraphStats; SchemaVersion int }`, `GraphStats struct{ NodeCount, EdgeCount, DeadCount int; ByKind map[NodeKind]int }`.
  - `server/internal/domain/status.go` — `AnalysisPhase string` (enum: `loading|parsing|building_graph|reachability|exporting|done|failed`), `AnalysisStatus struct{ Phase AnalysisPhase; Progress float64; Message string; Elapsed time.Duration }`.
  - `server/internal/domain/entry.go` — `EntryPointMode string` (`auto|manual|mixed`), `EntryPointSpec struct{ Mode EntryPointMode; AutoKinds []string; Manual []string; InterfaceImpl []string }`, default-заполнитель.
  - `server/internal/domain/filters.go` — `Filters struct{ IncludeKinds []NodeKind; ExcludePaths []string; StdlibExclude, TestExclude bool }`.
  - `server/internal/domain/deadcode.go` — `DeadCodeEntry struct{ Kind NodeKind; FQN, Package, Name, File string; Line int; Reason string }`, `DeadCodeReport struct{ ProjectID ProjectID; GeneratedAt time.Time; Entries []DeadCodeEntry }`.
  - `server/internal/domain/warning.go` — `Warning struct{ Code, Message string; Package, File string }`.
  - `server/internal/domain/sse.go` — `SSEEvent struct{ Type string; Seq int; Payload any }`, константы `EventPhase, EventPartialGraph, EventWarning, EventDone`.
  - `server/internal/domain/schema.go` — `const CurrentSchemaVersion = 1`.
  - `server/internal/domain/errors.go` — typed errors: `ErrProjectNotFound`, `ErrNoGraphYet`, `ErrInvalidEntryPoint`, `ErrZipSlip`, `ErrGoModMissing`, `ErrArchiveTooLarge`, `ErrFileCountExceeded`, `ErrUnpackedSizeExceeded`, `ErrAnalysisInProgress`; и `APIError struct{ Code, Message string; Details map[string]any; HTTPStatus int }` с методом `Error()`.
  - `server/internal/domain/*_test.go` — таблично-ориентированные тесты для каждого файла: JSON round-trip, `IsValid()` для enum, гашение unknown-значений, стабильность `NodeID` / `EdgeID` (одинаковые входы → одинаковый выход; разные — разные).
  - `server/internal/domain/gob.go` — `init()` с `gob.Register(Node{})`, `gob.Register(Edge{})`, `gob.Register(Graph{})` и reduced snapshot-тип для parsed.gob (заполняется позже в T07, но регистрация enums уже здесь).

### Вне scope
- Сама сериализация `parsed.gob` reduced snapshot — **T07**.
- HTTP response envelope (converter `APIError` → `{error:{code,message,details}}`) — **T12**.

## Технические детали
- `NodeKind` допустимые: `"package" | "struct" | "interface" | "func" | "method" | "field" | "var" | "const"` (design.md §5.1).
- `EdgeKind`: `"imports" | "contains" | "calls" | "embeds" | "implements" | "references"` (design.md §5.2 / architecture.md §4).
- `AnalysisPhase` — строки строго из api-contract.md §2.
- `NodeID`:
  ```go
  func NodeID(pkg, typeName, member string) string {
      canon := pkg
      if typeName != "" { canon += "#" + typeName }
      if member != ""   { canon += "." + member }
      sum := sha1.Sum([]byte(canon))
      return hex.EncodeToString(sum[:])[:16]
  }
  ```
- JSON теги — camelCase в wire, snake_case допустимо только если так в api-contract.md (там snake_case для ответов → используем snake_case).
- `ProjectID` имплементирует `MarshalText`/`UnmarshalText` + валидация regexp `^[A-Za-z0-9_-]{22}$`.
- `APIError` сериализуется как `{code, message, details}` без `http_status`.

## Acceptance criteria
- [ ] Все типы скомпилированы без предупреждений.
- [ ] `NodeID` детерминирован: тест с 5 разными входами показывает уникальные ID длины 16 (hex).
- [ ] JSON round-trip для каждой публичной структуры: `Marshal` → `Unmarshal` → deep-equal.
- [ ] `Node.ChildCount == 0` не сериализуется в JSON (`omitempty`), а `ChildCount > 0` — сериализуется как `child_count`.
- [ ] `NodeKind("xxx").IsValid() == false` и true для всех 8 из спеки.
- [ ] `NewProjectID()` возвращает строку длины 22 и `ProjectID.UnmarshalText` отклоняет недопустимые.
- [ ] `gob.Register` для всех экспортируемых концретных типов под интерфейс `any` в `SSEEvent.Payload` (Node, Edge, Graph, Warning, AnalysisStatus).

## План тестирования

### Unit-тесты
Целевой coverage ≥ 90 % для пакета `domain` (чистые типы).
- `NodeID` — табличный: 5 вариаций (package only, struct, method, embedded member, empty pkg) → ожидаемые первые 16 символов SHA-1 предрасчитаны.
- `EdgeID` — аналогично.
- `NodeKind.IsValid`, `EdgeKind.IsValid`, `AnalysisPhase.IsValid` — каждая валидная строка + 2 невалидные.
- `ProjectID` — `NewProjectID` возвращает корректный regexp; round-trip через MarshalText.
- `APIError.Error()` читаемый.
- Round-trip JSON: Node, Edge, Graph (с 100 узлами), DeadCodeReport, Warning, AnalysisStatus, SSEEvent (с Payload=*PhaseStatus).
- Round-trip gob: Graph + Warning.

### Integration-тесты
- Не применимо.

### E2E / Browser-тесты
- Не применимо.

## Definition of Done
- [ ] `go vet ./...` чистый
- [ ] `golangci-lint run ./...` чистый
- [ ] `go test -race -coverprofile=coverage.out ./internal/domain/...` ≥ 90 %
- [ ] Коммиты в Conventional Commits (`feat(domain): …`)
- [ ] PR создан, `tasks/README.md` обновлён: T04 `[x]`

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t04-domain-types`
3. Реализуй типы один файл за раз + тесты.
4. `make lint test` зелёно.
5. Коммит(ы), push, PR, merge.

## Out-of-band
Если встретишь нестыковку в `api-contract.md` vs `architecture.md` (напр., разные имена полей) — ОСТАНОВИСЬ и спроси пользователя; не правь документы сам.
