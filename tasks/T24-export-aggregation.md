# T24: PNG/SVG export + Aggregation expand (client-side)

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (2.3 FR-18, 2.5 FR-21/22)
- `docs/architecture.md` (ADR-06 aggregation)
- `docs/api-contract.md` (§3 GET /graph — c параметрами `aggregate` и `scope`)
- `docs/design.md` (§3.3 Export bottom-right buttons)

## Зависимости
- **T16 GET /graph** — endpoint готов, поддерживает `aggregate=auto|package|none` и `scope=<pkg>`.
- **T20 Cytoscape integration** — `cy` доступен.

## Цель
Экспорт графа в PNG (через `cy.png()` — встроенное) и SVG (через `cytoscape-svg`). Плюс: раскрытие package-узла в aggregated графе по двойному клику → детальный подграф только этого пакета через `GET /graph?scope=<pkg>`.

## Scope

### В scope
- `web/src/pages/Main/panels/ExportPanel.tsx`:
  - Кнопки `[Export PNG]`, `[Export SVG]` внизу правого rail (§3.3 wireframe).
  - PNG: `cy.png({output: 'blob', bg: themedBgColor, scale: 2, full: false /* visible viewport */})` → download `<project>-graph-<timestamp>.png`.
  - SVG: подключить `cytoscape-svg` extension (`cytoscape.use(cytoscapeSvg)`); вызов `cy.svg({...})` → string → Blob → download.
  - Имя файла формируется в `export.ts` helper.
- `web/src/pages/Main/useAggregateExpand.ts`:
  - Если текущий граф `aggregation == "package"`:
    - Обработчик `cy.on('dbltap', 'node[kind="package"]', handler)`: double-click на package-узел → `ApiClient.fetchGraph(projectId, { scope: pkgPath })` → получает узлы и рёбра только этого пакета (`aggregation == "none"` в response).
  - Expand UX: при double-click на package-node → заменить его на детальный подграф (удалить package-node, добавить его nodes/edges). Позиции — через fcose re-layout только для новых узлов (`fixedNodeConstraint` для уже размещённых соседей-пакетов).
  - Обработка ошибок: 400 `invalid_scope` → toast "package not found"; 5xx → toast "failed to expand, retry".
  - State: хранить множество развернутых пакетов `expandedPackages: Set<string>` чтобы не разворачивать повторно.
- `web/src/pages/Main/graph-styles.ts` — расширяем стили для aggregated package-node (бейдж `child_count`).
- `__tests__/`:
  - `ExportPanel.test.tsx`: click PNG → `cy.png` вызван; click SVG → `cy.svg` вызван.
  - Integration: проверить что ссылка на скачивание корректно создаётся.

### Вне scope
- Серверный `?scope=<pkg>` параметр `GET /graph` — реализуется в **T16** (не здесь).
- Compound nodes (Cytoscape parent/child) для визуального вложения — nice-to-have, не в MVP.

## Технические детали
- `cytoscape-svg` **community** extension (kaluginserg/cytoscape-svg, v0.4.x). Pin version. Проверить, что совместим с Cytoscape 3.33.
- PNG через `cy.png({output:'blob', scale:2})` — high-res для защиты. Background = current theme bg.
- SVG через `cy.svg({full:true, bg: themedBg})` — полный граф (не viewport).
- Filename helper: `slugify(projectName) + '-graph-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png'`.
- Aggregation expand полагается на `scope` query-параметр (реализован в T16). Контракт: `aggregation == "none"` в ответе → клиент знает, что это детальный подграф.

### UI visual requirements
- Normal: 2 кнопки.
- Loading: мини-spinner на кнопке во время генерации PNG/SVG (для большого графа 1k+ узлов может занять 1-2 с).
- Error: toast «export failed».

## Acceptance criteria
- [ ] FR-21: PNG download работает, файл открывается.
- [ ] FR-22: SVG download работает, файл открывается в браузере и векторном редакторе, валидный XML.
- [ ] FR-18 acceptance: граф с > 1000 узлами изначально aggregated (по пакетам); double-click на package-узел → детальный подграф этого пакета; Node.ID стабилен (ADR-07).
- [ ] Export name содержит projectName и timestamp.
- [ ] Performance: PNG для 1k узлов < 2 с; SVG — не проверяем (blocking OK для MVP).

## План тестирования

### Unit-тесты
- vitest + mocks `cy.png` / `cy.svg`.

### Integration-тесты
- Backend unit-тест на `GET /graph?scope=<pkg>` — покрыт в T16.

### E2E / Browser-тесты (обязательно)
webapp-testing. В `test-evidence/T24/`:
- Скриншоты: export buttons; aggregated graph (для middle testdata); expanded view после double-click.
- Скачанные PNG/SVG в `test-evidence/T24/artifacts/`.

Сценарии:
- **J1**: small testdata → Export PNG → файл скачан и открывается.
- **J2**: medium testdata (1k+ узлов) → aggregated показан → double-click на package-узел → expand.
- **J3**: Export SVG → файл открывается в Firefox.

## Definition of Done
- [ ] `npm run …` зелёное.
- [ ] `test-evidence/T24/` артефакты.
- [ ] Коммиты `feat(web): export + aggregation expand`.
- [ ] PR, merge, `tasks/README.md` T24 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t24-export-aggregation`
3. ExportPanel → aggregation expand (через `scope` из T16) → testdata medium check → E2E.
4. PR, merge.

## Out-of-band
- Если `cytoscape-svg` не совместим с Cytoscape 3.33 — fallback на inline `cy.jpg` или `cy.png` как PNG-only и согласовать временный отказ от FR-22 с пользователем (блокирующий вопрос).
- Если expand пакета с сотнями узлов ломает fcose performance (NFR-03) — рассмотри инкрементальный layout с фиксированными соседями и ограничение на количество одновременно развернутых пакетов (N=3).
