# T03: CI GitHub Actions

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (разделы: 3.2 NFR-05 (Go 1.24+ для анализируемого кода, 1.26 для runtime, CI matrix `{1.25, 1.26}`), 3.2 NFR-06, 7 «Критерии приёмки»)
- `docs/architecture.md` (разделы: 4 «Ограничения» / workflow)

## Зависимости
- **T01 Scaffold backend** — даёт `server/` с `go.mod`, Makefile, линтерами.
- **T02 Scaffold frontend** — даёт `web/` c `package.json` и npm-скриптами.

Если T01 или T02 не готовы — ОСТАНОВИСЬ.

## Цель
Настроить GitHub Actions workflows: `ci.yml` — lint + test + build для обеих частей репозитория на каждый PR в `main` и push в `main`. Без auto-publish образов (ADR-04 / requirements §4).

## Scope

### В scope
- Создать файлы:
  - `.github/workflows/ci.yml` (jobs: `backend`, `frontend`, финальный `status` — обязательный check)
  - `.github/dependabot.yml` (updates для `gomod` и `npm`, еженедельно)
  - `.github/CODEOWNERS` (опционально — owner `@isegoryachev`)

Jobs:

**backend** (runs-on ubuntu-latest + macos-latest для cross-platform smoke):
- matrix Go версии: `['1.25', '1.26']` (NFR-05). Добавить отдельный `stable`-job как warning-only если нужно мониторить будущие релизы — не блокирующий.
- `actions/checkout@v4`
- `actions/setup-go@v5` с `go-version-file: server/go.mod` (для 1.26 из go.mod) и matrix override для 1.25
- `golangci/golangci-lint-action@v6` на `server/`
- `go test -race -coverprofile=coverage.out ./...` в `server/`
- upload `coverage.out` как артефакт
- `go build -o /dev/null ./cmd/server`

**frontend** (runs-on ubuntu-latest):
- `actions/setup-node@v4` (Node 24 LTS, `cache: npm`, `cache-dependency-path: web/package-lock.json`)
- `npm ci`
- `npm run lint`, `npm run typecheck`, `npm run test -- --coverage`
- `npm run build`
- upload `web/dist/` (опционально, для отладки)

**status** (needs [backend, frontend]): просто печатает summary; branch protection включает именно его как required check.

### Вне scope (делается в другой задаче)
- Docker build/push в реестр — **T25** (локальный build, без push в CI)
- Playwright E2E — **T26**

## Технические детали
- Кэш: `actions/cache@v4` для `go-build` и `~/go/pkg/mod`; для npm — встроено в `setup-node`.
- Триггеры: `on: { push: { branches: [main] }, pull_request: { branches: [main] } }`.
- Concurrency: `group: ${{ github.workflow }}-${{ github.ref }}; cancel-in-progress: true`.
- Permissions минимальные: `contents: read`.
- Secrets не нужны (нет push в registry).

## Acceptance criteria
- [x] PR в `main` запускает все три job; все зелёные на чистом main.
- [x] Коммит с нарушением golangci-lint ломает backend-job.
- [x] Коммит с TS-ошибкой ломает frontend-job.
- [x] `status` job отмечен как required в branch protection (настройка в Git-репо, документируется в README).
- [x] Матрица Go `{1.25, 1.26}` — оба прогоняются.
- [x] Время CI ≤ 5 минут на чистом PR (кэши работают).

## План тестирования
### Unit-тесты
- Не применимо (инфраструктура).

### Integration-тесты
- Локальный `act` (опционально) или pushed тестовый коммит в feature-branch.

### E2E / Browser-тесты
- Не применимо.

**Артефакты для test-evidence/T03/:**
- Скриншот успешного CI run (можно вложить позже при merge PR).

## Definition of Done
- [x] Workflows написаны и валидны (`actionlint` или ручной `gh workflow view`).
- [x] На тестовом PR все jobs зелёные.
- [x] `README.md` в корне обновлён: бейдж статуса CI.
- [x] Dependabot config валиден.
- [x] Коммиты в Conventional Commits (`ci: add …`).
- [x] PR создан, `tasks/README.md` обновлён: T03 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b ci/t03-github-actions`
3. Напиши `ci.yml`, `dependabot.yml`.
4. Push, проверь прогон.
5. На branch-protection настройке — попроси пользователя подтвердить (если требуются admin-права).
6. PR, merge.

## Out-of-band
Если matrix Go `stable` начнёт ломать сборку из-за нестабильных изменений в x/tools — обсуди с пользователем: оставить или перенести в nightly.
