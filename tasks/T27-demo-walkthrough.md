# T27: Demo projects + scripted walkthrough для защиты

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (§6 Демо на защите, §7 Критерии приёмки)
- `docs/architecture.md` (§9 Deployment, §11 политика версий)
- `docs/design.md` (§2 user journeys)

## Зависимости
- **T25 Dockerfile** — run-on-any-machine образ готов.
- **T26 E2E suite** — полное покрытие функциональности зелёное.

## Цель
Подготовить два публичных Go-проекта как demo testdata (малый 5–10k LOC и средний 30–50k LOC), проверить на них весь pipeline, NFR-01 (30 с на medium), зафиксировать сценарий защиты step-by-step, собрать presentation-ready материалы.

## Scope

### В scope
- `demo/selection.md` — финальный выбор проектов с обоснованием:
  - Small: `urfave/cli` vs `spf13/cobra` — выбрать + пин commit/tag, запаковать в `demo/fixtures/small.zip`.
  - Medium: `go-chi/chi` (или сопоставимый ~30–50k LOC) — пин commit/tag, `demo/fixtures/medium.zip`.
  - Обоснование: количество LOC, наличие достаточного dead-code для демо, зависимости разрешаются offline (vendor или public modules).
- `demo/walkthrough.md` — скрипт защиты (5–7 минут):
  1. `docker run --rm -p 8080:8080 go-viz:rc1` → открыть http://localhost:8080.
  2. Перетащить `small.zip` → показать Analyzing view (phase badges).
  3. Увидеть граф ≤ 5 с (NFR-02) — показать zoom/pan/drag, hover tooltip.
  4. Показать подсветку мёртвого кода (FR-15) + Dead-code panel.
  5. Переключить display mode `d` → Dead-only — аудит.
  6. Добавить manual entry point (пример из small проекта) — показать пересчёт графа.
  7. Export SVG + TXT отчёт.
  8. (Если время) Загрузить `medium.zip` → показать агрегацию (FR-18), фильтры по типам (FR-14).
- `demo/performance-notes.md` — результаты замеров на reference-железе защитника:
  - NFR-01: end-to-end от upload до first done на medium (≤ 30 с).
  - NFR-02: до первого paint (≤ 5 с).
  - NFR-03: toggle filter (< 100 мс).
  - Содержимое: таблица с 3 прогонами, median/p95.
- `demo/troubleshooting.md` — план B при сбоях:
  - Если Docker не запустился → локальный `make build && ./server/bin/server` + `cd web && npm run build && serve dist/`.
  - Если nginx/прокси режет SSE → запасной `curl -N` показ.
  - Если medium не укладывается в 30 с — отдельный вариант с ещё меньшим проектом.
- Итоговый `RELEASE.md` в корне:
  - Версии (Go 1.26.X, React 19.2.X, Vite 8.X, TS 6.0.X, Cytoscape 3.33.X, Node 24 LTS) — сверить с архив-точкой 2026-04-19+.
  - Release tag schema: `v0.1.0-rc1` etc.
  - Чек-лист «зелёный к защите» (см. Acceptance ниже).
- Build tagged release образа локально (или через GH Actions tag-trigger — вне MVP CI).

### Вне scope
- Live-production deployment куда-либо — MVP «локальный dev-тул».
- Video-запись демо — optional, решает исполнитель.

## Технические детали
- `demo/fixtures/*.zip` — pinned upstream repositories на конкретные git SHA. **Переиспользовать инфраструктуру T26:** `scripts/build-fixtures.sh` + `e2e/fixtures/manifest.json` уже умеют собирать zip из pinned SHA. Для демо — либо расширить тот же `manifest.json` новыми записями (`demo-small`, `demo-medium`), либо симлинками переиспользовать `e2e/fixtures/*.zip`. Не дублировать скрипт.
- Performance замеры — через `e2e/specs/nfr-01-bench.spec.ts` из T26 на reference-железе.
- Если `go/packages` в offline-режиме не резолвит dependencies — пересобрать ZIP с `go mod vendor`.

## Acceptance criteria
- [ ] Оба ZIP собраны, положены в `demo/fixtures/`, pinned по SHA.
- [ ] На small: весь walkthrough проходит без ошибок, время первого paint ≤ 5 с.
- [ ] На medium: анализ ≤ 30 с (NFR-01) на reference-железе.
- [ ] `docker run go-viz:rc1` реально работает на macOS, Linux, Windows (минимум две из трёх — руками проверено, зафиксировано в performance-notes).
- [ ] Walkthrough скрипт повторяем в 2 независимых прогонах (не полагается на кэш).
- [ ] `RELEASE.md` содержит точные версии и release-тег.
- [ ] Все требования §7 Критерии приёмки проекта отмечены как выполненные в `RELEASE.md` (финальный checkbox-лист).

## План тестирования

### Unit-тесты
- Не применимо.

### Integration-тесты
- Прогон E2E T26 на demo-fixtures (вместо synthetic) — `BASE_URL=http://localhost:8080 FIXTURE=demo/fixtures/small.zip npx playwright test`.

### E2E / Browser-тесты (обязательно)
- Полный walkthrough вручную + прогон автоматики в T26 на demo-zips.
- `test-evidence/T27/`: скриншоты ключевых шагов; video (optional); performance report.

## Definition of Done
- [ ] `demo/`, `RELEASE.md`, performance-notes.md, walkthrough.md — заполнены.
- [ ] `docker run …` проверен на 2+ платформах.
- [ ] NFR-01 зафиксирован замером.
- [ ] Все требования §7 requirements.md зелёные.
- [ ] Коммиты `docs(demo): release walkthrough + fixtures` + tag `v0.1.0-rc1`.
- [ ] PR, merge, `tasks/README.md` T27 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b docs/t27-demo-walkthrough`
3. Выбрать и запаковать проекты. Руками прогнать walkthrough. Измерить NFR. Написать документы. Проверить на второй платформе.
4. PR, merge, git tag.

## Out-of-band
- Если medium-проект стабильно не укладывается в NFR-01 → документируй reality (`elapsed 42 s`), внеси в known-issues, **не** снижай NFR без консультации с пользователем. Возможно: заменить medium на проект поменьше для защиты.
- Если имеется 1 неделя до защиты и nice-to-have (layouts fcose/concentric/dagre selector) легко впихивается — обсуди с пользователем short-term доп. задачу. Но не в рамках T27.
