# T14: `POST /api/projects` — загрузка ZIP

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (2.1 FR-01/02, 3.1 NFR-04, 3.5 NFR-13/14)
- `docs/architecture.md` (3.2 ProjectLoader, 3.1 HTTP)
- `docs/api-contract.md` (§1 POST /api/projects — полный контракт request/response/errors)

## Зависимости
- **T06 ProjectLoader** — основной бизнес-логика распаковки.
- **T12 HTTP-скелет** — mux, middleware, envelope ошибок.

## Цель
Подключить `loader.Loader` к реальному HTTP endpoint: multipart/form-data → 201 Created с `{project_id, name, uploaded_at, size_bytes, file_count, expires_at}`; полный набор ошибок (400/413/422).

## Scope

### В scope
- `server/internal/api/projects_handler.go` (расширяет `Server` из T12):
  - Handler `POST /api/projects`:
    - `http.MaxBytesReader(w, r.Body, 50*1024*1024)` (NFR-14).
    - `r.ParseMultipartForm(32 << 20)` с ограничением in-memory.
    - `file, header, err := r.FormFile("archive")` — отсутствие поля → 400 `invalid_zip`.
    - `name := r.FormValue("name")` (опциональный).
    - `meta, err := loader.Load(ctx, file, header.Size, name)`
    - mapping ошибок → HTTP статусы:
      - `ErrArchiveTooLarge` → 413 `archive_too_large`
      - `ErrZipSlip` → 400 `zip_slip_detected`
      - `ErrGoModMissing` → 400 `go_mod_missing`
      - `ErrFileCountExceeded` → 422 `file_count_exceeded`
      - `ErrUnpackedSizeExceeded` → 422 `unpacked_size_exceeded`
      - прочие → 400 `invalid_zip` (логировать через slog с request_id)
    - Success → 201, body из `ProjectMeta` (api-contract §1 response).
- Обновить `routes` в T12-серверах (убрать 501 stub, подключить handler).
- `projects_handler_test.go`:
  - `TestHappyPath` — multipart с маленьким валидным ZIP (in-memory) → 201 + корректный JSON.
  - `TestNoArchiveField` → 400 `invalid_zip`.
  - `TestTooLarge` — тело 60 МБ → 413 `archive_too_large` (без чтения всего тела).
  - `TestZipSlip` → 400 `zip_slip_detected`.
  - `TestNoGoMod` → 400 `go_mod_missing`.
  - `TestFileCount` — 11 000 фиктивных entries → 422.
  - `TestIdempotency` — повторная загрузка = два разных project_id.

### Вне scope
- Analyze endpoint (SSE) — **T15**.
- UI upload (drag-n-drop) — **T18**.

## Технические детали
- multipart: memory limit `32 MB`; остальное на диск в tmp (стандартное поведение `ParseMultipartForm`). После handler завершения — `r.MultipartForm.RemoveAll()` в defer.
- Response JSON: поля согласно api-contract.md §1 (snake_case).
- `expires_at = uploaded_at + 30 * time.Minute`.
- Content-Length валидация: если ≤ 0 → 400 `invalid_zip`.
- Логирование: `slog.Info("project_uploaded", slog.String("id", ...), slog.Int64("size", ...), ...)` — не логировать имя файла из header (PII-esque).

## Acceptance criteria
- [x] Happy: `curl -F archive=@valid.zip http://.../api/projects` → 201 + JSON.
- [x] 60 МБ → 413 (проверяем, что сервер не зачитал 60 МБ в память — через `io.LimitReader` или `http.MaxBytesReader`).
- [x] zip-slip → 400, никакой записи на диск.
- [x] FR-01 acceptance из requirements: валидный ZIP принят с HTTP 200/201, невалидный (без `go.mod`) → HTTP 400 с «valid Go module not found».
- [x] Все error-код'ы совпадают с api-contract.md §1.
- [x] После успешной загрузки cache.Manager содержит проект, TTL = 30 мин.

## План тестирования

### Unit-тесты
- Табличные, через `httptest`.
- Фикстуры ZIP из T06 — переиспользуем или пересобираем in-memory.
- Coverage для handler ≥ 80 %.

### Integration-тесты
- End-to-end HTTP → loader → cache с реальным `t.TempDir()`.

### E2E / Browser-тесты
- В рамках T14 не нужно (UI в T18). В **T26** — через Playwright с реальным upload.

## Definition of Done
- [x] Линтеры и тесты зелёные.
- [x] `curl` прогоны happy + error — документированы в README (`server/README.md`).
- [x] Коммиты `feat(api): post projects handler`.
- [x] PR, merge, `tasks/README.md` T14 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t14-post-projects`
3. Handler → routes wiring → тесты.
4. PR, merge.

## Out-of-band
- Если `ParseMultipartForm` на 50 МБ даёт OOM в CI (ubuntu-latest 7 GB RAM — должно быть ок) — перейти на `r.MultipartReader()` streaming. Документировать изменение.
