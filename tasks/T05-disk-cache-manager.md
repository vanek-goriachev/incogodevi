# T05: DiskCacheManager

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (разделы: 3.3 NFR-08, NFR-10)
- `docs/architecture.md` (разделы: 2 «Контейнеры» / Disk cache, 3.4 DiskCacheManager, ADR-03, ADR-10, ADR-12)
- `docs/api-contract.md` (разделы: 0 project_id, 1 expires_at)

## Зависимости
- **T01** — скелет и `internal/cache` директория.
- **T04** — `ProjectID`, `Graph`, `DeadCodeReport`, `SchemaVersion`, `APIError`, `ErrProjectNotFound`.

## Цель
Реализовать `DiskCacheManager` — централизованный владелец путей `$TMPDIR/go-viz/sources/<id>/` и `$TMPDIR/go-viz-cache/<id>/`. Атомарные записи (`CreateTemp + Rename`), TTL-sweeper (30 мин idle, проверка каждые 60 с), операции read/write для `meta.json`, `parsed.gob`, `graph.json`, `dead-code.json`, tracking `LastAccessAt`.

## Scope

### В scope
- Создать `server/internal/cache/cache.go`:
  - `type Manager interface`:
    - `NewProject(name string, sizeBytes int64, fileCount int) (*Project, error)`
    - `GetProject(id domain.ProjectID) (*Project, error)` — обновляет `LastAccessAt`
    - `ListProjects() []ProjectMeta`
    - `DeleteProject(id domain.ProjectID) error`
    - `SourcesDir(id domain.ProjectID) string`
    - `ReadMeta(id) (*ProjectMeta, error)` / `WriteMeta(id, *ProjectMeta) error`
    - `ReadGraph(id) (*domain.Graph, error)` / `WriteGraph(id, *domain.Graph) error`
    - `ReadDeadCode(id) (*domain.DeadCodeReport, error)` / `WriteDeadCode(id, *domain.DeadCodeReport) error`
    - `ReadParsedBlob(id) (io.ReadCloser, error)` / `WriteParsedBlob(id) (io.WriteCloser, error)` (для `parsed.gob`)
    - `Close() error` — останавливает sweeper
  - `type Project struct{ Meta ProjectMeta; SourcesDir, CacheDir string; parseOnce sync.Once; analyzeMu sync.Mutex }` (ADR-10)
  - `type ProjectMeta struct{ ID domain.ProjectID; Name string; UploadedAt, LastAccessAt, ExpiresAt time.Time; SizeBytes int64; FileCount int; SchemaVersion int }`
- `server/internal/cache/atomic.go` — `writeAtomic(path string, write func(io.Writer) error) error` через `os.CreateTemp` в том же каталоге + `os.Rename`.
- `server/internal/cache/sweeper.go` — goroutine sweep по TTL `30*time.Minute`, cancelable через `context.Context`.
- `server/internal/cache/*_test.go`:
  - happy-path: NewProject → WriteGraph → ReadGraph
  - race write/read через горутины с `-race`
  - SchemaVersion mismatch → `ErrSchemaMismatch` (возврат nil + ошибка, не panic)
  - TTL sweeper: project старше TTL удаляется; не старше — остаётся
  - Delete во время analyze (mutex занят) — задача T13/T14 использует `analyzeMu`; тут тест, что concurrency-safe
- Использовать `filepath.Join`, `os.MkdirAll(dir, 0o700)`.

### Вне scope
- HTTP-эндпоинты `DELETE /api/projects/{id}` и `GET /api/projects` — **T12** (они зовут наш Manager).
- Распаковка ZIP в SourcesDir — **T06**.
- Запись parsed.gob содержимого — **T07**.

## Технические детали
- Корни путей настраиваются через опции в `cache.New(opts Options)`: `Options{ RootTmp, RootCache string; IdleTTL time.Duration; SweepInterval time.Duration; Logger *slog.Logger }`. Default: `os.TempDir()` + подкаталоги.
- `WriteMeta/Graph/DeadCode` — JSON с `SchemaVersion` на верхнем уровне. При чтении: если `SchemaVersion != domain.CurrentSchemaVersion` → `ErrSchemaMismatch` + log.Warn.
- `WriteParsedBlob` возвращает `io.WriteCloser`, под капотом `CreateTemp + gzip.Writer` (опционально) — договорись с T07. Минимум: plain `*os.File` + `Rename` на Close. Без gzip пока.
- TTL idle: project считается idle, если `LastAccessAt + IdleTTL < now`. Sweeper удаляет `CacheDir` + `SourcesDir`, удаляет из in-memory карты.
- `NewProjectID` зовём из `internal/domain` (T04).

## Acceptance criteria
- [ ] `cache.New(opts).NewProject("my", 1024, 10)` создаёт каталоги с правами `0700`, возвращает Project с корректным ID.
- [ ] WriteGraph → ReadGraph возвращает deep-equal Graph; на диске `graph.json` валидный JSON.
- [ ] Повреждённый `graph.json` → ReadGraph возвращает `ErrStaleCache` (не panic).
- [ ] SchemaVersion mismatch → `ErrSchemaMismatch`.
- [ ] Concurrent `WriteGraph` (2 горутины) не приводит к полу-записанному файлу (проверяется: читатель всегда видит либо старую, либо новую версию целиком).
- [ ] TTL sweeper удаляет каталоги просроченного проекта (тест с короткой TTL и fake clock или `time.Now()` stub).
- [ ] `ListProjects()` возвращает ровно те, что активны; порядок по UploadedAt DESC.
- [ ] `DeleteProject` идемпотентен: повторный вызов → `nil` error (или `ErrProjectNotFound` — зафиксировать в контракте и в тесте).

## План тестирования

### Unit-тесты
- `cache_test.go`: NewProject, GetProject, ListProjects, DeleteProject (включая идемпотентность).
- `atomic_test.go`: имитация падения при записи (panic в колбэк) — целевой файл не создаётся, tmp удаляется.
- `sweeper_test.go`: с малой TTL (`10ms`) и ручным ticker-ом (через interface `Clock`).
- `schema_test.go`: записываем старой версии → читаем → mismatch.
- `race_test.go`: N=50 горутин WriteGraph + M=50 ReadGraph, `-race`.
Coverage ≥ 80 %.

### Integration-тесты
- Запуск Manager с реальным `t.TempDir()` (без моков файловой системы).

### E2E / Browser-тесты
- Не применимо.

## Definition of Done
- [ ] `go vet`, `golangci-lint run`, `go test -race` — чисто.
- [ ] Coverage ≥ 80 % в пакете cache.
- [ ] Коммиты в Conventional Commits (`feat(cache): …`).
- [ ] PR, merge, `tasks/README.md` T05 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t05-disk-cache-manager`
3. Имплементация → тесты → лайт-бенчмарк (опционально).
4. Push, PR, merge.

## Out-of-band
Если архитектурно хочется включить gzip для `parsed.gob` — сначала согласуй с T07 (читатель должен знать формат). По умолчанию — plain binary.
