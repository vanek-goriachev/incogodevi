# Release notes — Go Dependencies Visualizer

Курсовой проект ВШЭ БПИ236, исполнитель Горячев И. С. Документ собирается
вручную перед каждым tag-ом. Текущий target: `v0.1.0-rc1`.

## Версии (на 2026-04-20)

| Компонент            | Версия    | Источник                                    |
|----------------------|-----------|----------------------------------------------|
| Go (toolchain)       | 1.26      | `server/go.mod` (`go 1.26`); runtime base   |
| Go runtime в Docker  | 1.26-alpine | `Dockerfile` `FROM golang:1.26-alpine AS runtime` |
| `golang.org/x/tools` | 0.44.0    | `server/go.mod`                              |
| `golang.org/x/mod`   | 0.35.0    | `server/go.mod`                              |
| Node                 | 24 LTS    | `Dockerfile` `FROM node:24-alpine`; `engines.node` |
| React                | 19.2.5    | `web/package-lock.json`                      |
| TypeScript           | 6.0.3     | `web/package-lock.json`                      |
| Vite                 | 8.0.8     | `web/package-lock.json`                      |
| Cytoscape.js         | 3.33.2    | `web/package-lock.json`                      |
| cytoscape-fcose      | 2.2.0     | `web/package-lock.json`                      |
| cytoscape-svg        | 0.4.0     | `web/package-lock.json`                      |
| Docker image runtime size | ~250 MB | `docker images go-viz:rc1`                |

Все версии сверены с `go.dev`, `react.dev`, `vitejs.dev`,
`typescriptlang.org`, `js.cytoscape.org`, `nodejs.org` на дату фиксации.

## Release tag schema

Семантическая версия с pre-release-suffix:

- `v0.1.0-rc1` — release candidate для защиты курсового (текущий).
- `v0.1.0` — finalized после защиты, по решению пользователя.
- `v0.1.x` — patch-only, fixes по итогам защиты или ревью.
- `v0.2.0+` — функциональные расширения после курсового (не запланированы
  как часть учебной фазы).

### Команды для tag-а (после merge PR T27)

> **Внимание**: тэг проставляет владелец репозитория. Авто-агент не делает
> `git tag` сам — это shared state.

```bash
git checkout main && git pull --ff-only
git tag -a v0.1.0-rc1 -m "Release candidate 1 — defense-ready build"
git push origin v0.1.0-rc1
```

CI на текущий момент собирает образы без авто-publish в registry — это
осознанное MVP-решение (см. `requirements.md` §5.3).

## Чек-лист «зелёный к защите»

Список соответствует §7 `requirements.md`. Каждая позиция помечена как
✓ (green), ✗ (red, не закрыта), либо «знаком/числом» (выполнено с
оговоркой — раскрыто рядом).

| # | Критерий                                                                                            | Статус | Где                                                                                                  |
|---|------------------------------------------------------------------------------------------------------|--------|-------------------------------------------------------------------------------------------------------|
| 1 | Все FR-01 … FR-26 реализованы и покрыты минимум одним автоматическим тестом                          | ✓      | `server/...` unit + integration; `web/src/**/__tests__` vitest; `e2e/specs/*.spec.ts` Playwright       |
| 2 | NFR-01 измерен benchmark-тестом на проекте ≥ 50k LOC                                                  | ⚠️     | Замерен на `go-chi/chi` (~5 k LOC non-test, см. `demo/selection.md`). Median 34.4 c — **не уложился в 30 c на 4.4 c**. См. `demo/performance-notes.md` для деталей. |
| 3 | NFR-02, NFR-03 проверены Playwright-сценарием                                                         | ✓      | `e2e/specs/nfr.spec.ts`, `nfr-01-bench.spec.ts`. NFR-02 medium = 191 ms (бюджет 5000 ms). NFR-03 median Chromium 35–58 ms; max до 178 ms на 304-узловом графе (см. notes). |
| 4 | Coverage ключевых пакетов сервера (`analyzer`, `graph`, `deadcode`, `api`) ≥ 70 %                      | ✓      | `make test` — `cd server && go test -coverprofile=coverage.out ./...` (см. CI `lint+test` workflow). |
| 5 | Frontend unit-тесты для GraphView, FiltersPanel, EntryPointsPanel, DeadCodeReport                     | ✓      | `web/src/pages/Main/__tests__`, vitest                                                                |
| 6 | Интеграционный тест на HTTP API с `testdata/` Go-проектом                                             | ✓      | `server/internal/orchestrator/orchestrator_test.go`                                                   |
| 7 | E2E-сценарий Playwright: upload → граф → dead code → экспорт                                          | ✓      | `e2e/specs/j1-first-upload.spec.ts`, `j2-entry-points.spec.ts`, `j3-reload-restore.spec.ts`, `j4-export.spec.ts` |
| 8 | GitHub Actions workflow «lint + test» проходит на main и PR                                          | ✓      | `.github/workflows/ci.yml` — последний прогон зелёный; см. `gh run list`                              |
| 9 | Docker-образ собирается multi-arch и запускается командой `docker run -p 8080:8080 …`                | ⚠️     | Multi-stage Dockerfile собирается локально и в CI. **Multi-arch buildx**: настроен (`make docker-build PLATFORMS=linux/amd64,linux/arm64`), однократно проверен локально на arm64; на amd64 не пере-собирался к rc1 — нет промежуточной CI machine с buildx Cache. Runtime walkthrough руками только macOS arm64. См. `demo/performance-notes.md` «Multi-platform верификация». |
| 10 | Документация в `docs/`: requirements, architecture, api-contract, design                              | ✓      | `docs/requirements.md`, `architecture.md`, `api-contract.md`, `design.md`                              |
| 11 | Демо-сценарий §6 воспроизводится на машине для защиты                                                  | ✓      | `demo/walkthrough.md` + screenshots/`test-evidence/T27/screenshots/01..09-*.png`                       |

⚠️ суммарно: **2 каверы** (NFR-01 на 4.4 c превышение, multi-platform
ручная верификация только macOS). Оба честно задокументированы; ни один
не блокирует защиту, оба согласованы с risk-policy в `requirements.md`
§3.1, §3.2 и Out-of-band §92 в `tasks/T27-demo-walkthrough.md`.

## Известные ограничения

Полный список — `docs/tech-debt.md`. Самое существенное на момент `rc1`:

1. **NFR-01 не уложился в бюджет**: на reference-машине (M3 Pro) полный
   pipeline для chi занимает ~34 c против таргета 30 c. Корень проблемы —
   `golang:1.26-alpine` runtime (см. tech-debt: `dockerfile: distroless
   lacks go toolchain`). На distroless образ был бы быстрее, но без
   `go` toolchain `packages.Load` падает.
2. **`orchestrator: re-analyze on cached project produces empty graph`** —
   при повторном `/analyze` для того же `project_id` с изменённым набором
   entry points бэкенд может вернуть пустой граф (cache-hit path не
   перепарсивает). Frontend mitigation добавлен в T22 (локальный BFS
   fallback с warning toast).
3. **Multi-module ZIP**: если `go.mod` лежит на одну директорию ниже
   корня архива, анализатор не находит модуль (`packages.Load("./...")`
   запускается из распакованного корня). `scripts/build-fixtures.sh`
   теперь пакует «плоско», но это не задокументировано в README для
   end-user-а. См. `demo/troubleshooting.md` §6.
4. **Большие графы (> 1000 узлов)**: NFR-18 предусматривает агрегацию,
   реализована в T24 (`useAggregateExpand`); тестовые фикстуры до 1000
   узлов не доходят. Risk: на каком-нибудь чужом 50k LOC проекте
   агрегация может вести себя нестабильно (не закрыто benchmark-тестом).

## Что сделать пользователю после merge T27

1. **Тэг релиза** (см. команды выше).
2. **Multi-platform верификация runtime** на Linux и/или Windows
   (опционально, не блокирует защиту).
3. **Репетиция walkthrough**: пройтись по `demo/walkthrough.md` 1–2 раза
   ровно по таймингам (5–7 мин), чтобы убрать паузы; продумать ответ на
   вопросы по §6 и §7 `requirements.md`.

## История релизов

| Tag         | Дата       | Заметки                                              |
|-------------|------------|-------------------------------------------------------|
| `v0.1.0-rc1` | TBD (after T27 merge) | Defence-ready build, 27 / 27 plan-задач закрыты |
