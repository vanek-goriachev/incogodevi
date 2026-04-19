# T26: E2E Playwright suite (full journeys + NFR-02/03 measurements)

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (7 Критерии приёмки, 3.1 NFR-01/02/03, 3.3 NFR-09)
- `docs/architecture.md` (§5 Dynamic view — happy path)
- `docs/design.md` (§2 user journeys J1..J4)
- `docs/api-contract.md` — для sanity на expected responses

## Зависимости
- **T25 Dockerfile** — полный production-образ для E2E run.
- Полный стек реализован: T01..T24.

## Цель
Playwright-набор браузерных тестов, покрывающих:
- J1 (first upload → граф),
- J2 (смена entry points),
- J3 (reload → restore),
- J4 (export dead-code),
- NFR-02 (≤ 5 s до первой отрисовки), NFR-03 (< 100 мс toggle filter),
- NFR-09 (UI выживает серверные ошибки).
Тесты запускаются против Docker-контейнера либо live `vite dev + go run` (оба режима).

## Scope

### В scope
- `e2e/playwright.config.ts`:
  - projects: `chromium`, `webkit` (minimal requirement — NFR-06 matrix).
  - baseURL: `http://localhost:8080` (Docker) или `http://localhost:5173` (dev) — через env var.
  - traces: `retain-on-failure`; screenshots: `only-on-failure`.
- `e2e/fixtures/`:
  - **Стратегия:** zip'ы НЕ коммитятся в git. Собираются скриптом `scripts/build-fixtures.sh` из pinned upstream SHA; результат кэшируется в `e2e/fixtures/.cache/` (в `.gitignore`). `simple.zip` как исключение (≤ 2 MB синтетический testdata) коммитится в git как обычный файл — см. ниже.
  - `scripts/build-fixtures.sh` — bash-скрипт:
    - Читает `e2e/fixtures/manifest.json` с парами `{name, upstream_url, sha}` (напр. `{"medium", "https://github.com/go-chi/chi", "<pinned-sha>"}`).
    - Для каждой записи: если zip не в кэше → `git clone --depth=1 <url> /tmp/<name> && cd /tmp/<name> && git checkout <sha> && zip -r <cache>/<name>.zip .`.
    - Идемпотентный; `--force` для пересборки.
  - `e2e/fixtures/simple/` — синтетический мини-проект (5–10 файлов) с известными dead-entries, хранится как исходники в git; `simple.zip` генерится тем же скриптом локально из этой директории.
  - `e2e/fixtures/medium.zip` — собирается из upstream (`go-chi/chi` или аналог, финальный выбор в T27); SHA пин.
  - Playwright suite вызывает `build-fixtures.sh` в `globalSetup` (skip если кэш свежий).
- `e2e/specs/j1-first-upload.spec.ts` — J1 happy.
- `e2e/specs/j2-entry-points.spec.ts` — J2: add manual entry → граф пересчитан.
- `e2e/specs/j3-reload-restore.spec.ts` — J3: reload → позиции/фильтры восстановлены.
- `e2e/specs/j4-export.spec.ts` — J4: скачивание TXT и JSON, проверка содержимого.
- `e2e/specs/nfr.spec.ts`:
  - NFR-02: `performance.mark` — измеряем delta от получения JSON до cy.ready событие.
  - NFR-03: `performance.now` вокруг toggle-filter → < 100 мс.
  - NFR-09: simulate network error через route interception → ErrorBoundary, Retry работает.
- `e2e/specs/nfr-01-bench.spec.ts` (optional, slow):
  - medium testdata → upload+analyze — общее время ≤ 30 с (NFR-01 acceptance). Skip на slow CI runners с `test.slow()`.
- `e2e/helpers/upload.ts` — хелпер для drag-drop zip через `setInputFiles`.
- `e2e/helpers/sse.ts` — ожидание `done` через `page.waitForResponse` или custom evaluate.
- Makefile: `e2e` таргет → `cd e2e && npx playwright test`.
- CI: добавить отдельный workflow job `e2e` (не в `ci.yml`, а в `e2e.yml` — запускается по `workflow_dispatch` либо на main-push), чтобы не замедлять PR-ы. Уточни у пользователя.

### Вне scope
- Демо-скрипт для защиты — **T27**.
- Визуальные регрессы (Chromatic/Percy) — не нужно для MVP.

## Технические детали
- Playwright **1.59** (см. verified versions); chromium + webkit.
- `e2e/package.json` — отдельный npm-модуль или внутри `web/`? Рекомендую `e2e/` как изолированный модуль чтобы не раздувать frontend bundle.
- Run modes:
  - **Dev**: `npm run dev` (web, proxy) + `go run ./cmd/server` → playwright против `localhost:5173`.
  - **Docker**: `docker run -p 8080:8080 go-viz:dev` → playwright против `localhost:8080`.
  - `BASE_URL` env переключает.
- В CI: spin-up Docker container перед playwright job; использовать `services.` в GitHub Actions.

### UI visual requirements (для документирования в спеке)
- J1 finish: screenshot `test-evidence/T26/j1-final.png` показывает граф с узлами и dead-highlight.
- J2 finish: `j2-after-add-entry.png` — новый entry в списке и граф пересчитан.
- J3 finish: `j3-positions-restored.png` — позиции из localStorage.
- J4 finish: скачанные файлы в `test-evidence/T26/downloads/`.

## Acceptance criteria
- [ ] Все spec-ы зелёные в Chromium и WebKit.
- [ ] NFR-02 замерен: измеренное значение ≤ 5000 мс.
- [ ] NFR-03 замерен: измеренное значение < 100 мс.
- [ ] NFR-09: при 500 от сервера ErrorBoundary + Retry восстанавливает, не reload.
- [ ] J1-J4 полностью проходят на реальном Docker-контейнере.
- [ ] `test-evidence/T26/` содержит screenshots + traces для каждого spec.
- [ ] NFR-01 (если bench запущен): total analyze time ≤ 30 с на medium testdata на reference-железе.

## План тестирования

### Unit-тесты
- Не применимо — это задача про E2E.

### Integration-тесты
- N/A — сам Playwright suite = integration.

### E2E / Browser-тесты
- Целиком scope этой задачи.

## Definition of Done
- [ ] `npx playwright test` локально зелёный на обоих projects.
- [ ] `test-evidence/T26/` содержит traces, screenshots, downloads.
- [ ] README описывает как запускать E2E локально (dev + docker).
- [ ] Коммиты `test(e2e): playwright suite`.
- [ ] PR, merge, `tasks/README.md` T26 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b test/t26-e2e-playwright`
3. Fixtures → helpers → specs → NFR measurements → CI job.
4. PR, merge.

## Out-of-band
- Если CI отрезан от интернета (corporate runners) — `build-fixtures.sh` не сможет склонировать upstream; fallback — pre-built zip в GitHub Actions cache (`actions/cache` по `manifest.json` hash). Либо (если блокирует защиту) — договориться с пользователем о временном коммите medium.zip в git.
- Если Chromium и WebKit дают разный timing — документируй; NFR-02 замеряется в Chromium (целевой браузер для защиты).
- NFR-01 bench требует medium 50k LOC. Если подходящего testdata нет на старте — замерь на ~15-20k и зафиксируй экстраполяцию в PR description; финальный бенч — с T27 demo-project.
