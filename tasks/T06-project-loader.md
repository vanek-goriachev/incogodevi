# T06: ProjectLoader (ZIP upload, distro, zip-slip guard)

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (разделы: 2.1 FR-01/02/03, 3.1 NFR-04, 3.3 NFR-08, 3.5 NFR-13/14)
- `docs/architecture.md` (разделы: 3.2 ProjectLoader, ADR-08)
- `docs/api-contract.md` (endpoints: `POST /api/projects` §1 — контракт успеха и ошибок)
- `docs/design.md` — не применимо (UI-часть в T18)
- `docs/diagrams/rendered/03-components-backend.png`

## Зависимости
Merged в `main` должны быть:
- **T01 Scaffold backend** — даёт пакет `server/internal/loader/` и `go.mod`.
- **T04 Доменные типы** — даёт `ProjectID`, `APIError`, `ErrZipSlip`, `ErrGoModMissing`, `ErrArchiveTooLarge`, `ErrFileCountExceeded`, `ErrUnpackedSizeExceeded`, `Warning`.
- **T05 DiskCacheManager** — даёт `cache.Manager.NewProject(…)` и `SourcesDir(id)`.

Если чего-то нет — ОСТАНОВИСЬ.

## Цель
Реализовать `loader.Loader`: принимает `io.Reader` (multipart file) и `int64` (размер), безопасно распаковывает ZIP в `SourcesDir`, валидирует `go.mod`, лимиты, возвращает `*domain.ProjectMeta` для записи через cache.Manager.

## Scope

### В scope
- `server/internal/loader/loader.go`:
  - `type Loader struct{ cache cache.Manager; cfg LoaderConfig; logger *slog.Logger }`
  - `type LoaderConfig struct{ MaxArchiveBytes int64 /*50MB*/; MaxFiles int /*10000*/; MaxUnpackedBytes int64 /*500MB*/ }`
  - `func (l *Loader) Load(ctx context.Context, r io.Reader, size int64, displayName string) (*domain.ProjectMeta, error)`
    - Проверить `size ≤ MaxArchiveBytes` до чтения (NFR-14, ошибка `ErrArchiveTooLarge`).
    - Читать ZIP через `zip.NewReader`; ПОТРЕБУЕТСЯ предварительная запись в `io.ReaderAt` — использовать `io.ReadAll` с предохранителем `http.MaxBytesReader` (в T12/T14 оборачивается; здесь ждём уже ограниченный Reader) либо stream через `os.CreateTemp`.
    - До полной распаковки посчитать количество entries и суммарный `UncompressedSize64`; при превышении — `ErrFileCountExceeded` или `ErrUnpackedSizeExceeded`.
    - Для каждого `*zip.File`:
      - `cleaned := filepath.Clean(f.Name)`; reject if `strings.HasPrefix(cleaned, "..")` or `filepath.IsAbs(cleaned)` or `strings.Contains(cleaned, "..\\")` (windows) — вернуть `ErrZipSlip`.
      - Создать каталоги с `os.MkdirAll(..., 0o700)`.
      - Писать файл через `io.CopyN(dst, src, maxPerFile)` с счётчиком суммарного; превышение → откат (удалить частично распакованный каталог) + ошибка.
    - После распаковки: найти `go.mod` (в корне или первой подпапке — первый побеждает). Если нет → `ErrGoModMissing` + откат. Парсить `module <name>` — использовать `golang.org/x/mod/modfile` (готовый парсер, sub-dependency x/mod).
    - `displayName` — если пустой, взять module name.
    - Заполнить `ProjectMeta{ID, Name, UploadedAt=now, ExpiresAt=now+30m, SizeBytes=size, FileCount, SchemaVersion}` и сохранить через `cache.WriteMeta`.
    - Вернуть meta.
  - Rollback: при любой ошибке — `cache.DeleteProject(id)` (эффективно `RemoveAll(SourcesDir)` и `CacheDir`).
- `server/internal/loader/loader_test.go`:
  - Валидный ZIP с go.mod в корне — happy path.
  - Валидный ZIP с go.mod в подпапке `repo-v1/go.mod` — happy path с offset.
  - ZIP без go.mod → `ErrGoModMissing`.
  - ZIP с `../escape/file.go` → `ErrZipSlip`, никакого файла не создано.
  - ZIP с 11 000 файлов (stub) → `ErrFileCountExceeded` **до** полной распаковки.
  - ZIP-bomb: entry с `UncompressedSize64 = 600MB` → `ErrUnpackedSizeExceeded`.
  - Размер `size > 50MB` → `ErrArchiveTooLarge`.
- Testdata: `server/internal/loader/testdata/<scenario>.zip` — маленькие фикстуры, собираемые `go generate` (опционально) или вручную (документируется в README пакета).

### Вне scope
- HTTP-хендлер `POST /api/projects` и `MaxBytesReader` обвязка — **T14**.
- Парсинг через `go/packages` — **T07**.
- Stream-чтение multipart большого файла — реализовано в T14.

## Технические детали
- Лимиты (NFR-04): `MaxArchiveBytes=50*1024*1024`, `MaxFiles=10000`, `MaxUnpackedBytes=500*1024*1024`.
- Использовать `archive/zip` (stdlib) + `filepath.Clean` + проверка на `..` и абсолютные пути (ADR-08).
- Для `module` парсинга — `golang.org/x/mod/modfile.Parse` (v0.25+). Добавить в `go.mod` если ещё нет (будет подтянут транзитивно с `x/tools` всё равно).
- Права: директории `0700`, файлы `0600` (NFR-13).
- На ошибке любой фазы — гарантированно вызвать `cache.DeleteProject(id)` в `defer` (паттерн commit/rollback: флаг `committed bool`; `defer { if !committed { rollback() } }`).
- Контекст: `ctx.Done()` — прервать распаковку на текущем `*zip.File`, rollback.

## Acceptance criteria
- [ ] Happy path: валидный ZIP → `ProjectMeta.ID` валиден, `SourcesDir` содержит распакованные файлы с правами `0600`.
- [ ] zip-slip вход (`../etc/passwd`) → `ErrZipSlip`, никакого файла вне SourcesDir не создано.
- [ ] > 10 000 entries → `ErrFileCountExceeded` до любого I/O записи.
- [ ] zip-bomb → `ErrUnpackedSizeExceeded`, частично распакованное удалено.
- [ ] Отсутствие go.mod → `ErrGoModMissing` + rollback.
- [ ] `modfile.ParseLax` извлекает правильное module name из `go.mod`.
- [ ] Концеллация `ctx` прерывает распаковку; `SourcesDir` очищен.

## План тестирования

### Unit-тесты
- `TestZipSlip`, `TestNoGoMod`, `TestHappyPath`, `TestHappyPathSubdir`, `TestTooLarge`, `TestTooManyFiles`, `TestZipBomb`, `TestContextCancel`.
- Фикстуры ZIP генерируются в `TestMain` через `archive/zip.Writer` in-memory, чтобы не коммитить бинарные файлы.
- Coverage ≥ 80 %.

### Integration-тесты
- В рамках пакета: реальный `t.TempDir()`, реальная `cache.Manager` из T05.

### E2E / Browser-тесты
- Не применимо (HTTP-слой в T14; E2E в T26).

## Definition of Done
- [ ] `go vet`, `golangci-lint run` чисто
- [ ] `go test -race -coverprofile=coverage.out ./internal/loader/...` ≥ 80 %
- [ ] Коммиты в Conventional Commits (`feat(loader): …`)
- [ ] PR создан, `tasks/README.md` обновлён: T06 `[x]`

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t06-project-loader`
3. Реализация + тесты (генераторы ZIP in-memory).
4. `make lint test` зелёно.
5. PR, merge.

## Out-of-band
Если обнаружишь, что `io.ReadAll` на 50 MB в память — проблемно для процесса с 2 ГБ RAM (NFR-07) — переведи распаковку на временный файл (`os.CreateTemp` → `zip.OpenReader`), удали в defer. Спроси пользователя, если необходимо менять профиль использования памяти.
