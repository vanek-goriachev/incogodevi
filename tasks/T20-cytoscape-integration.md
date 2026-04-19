# T20: Cytoscape integration (graph render, zoom, pan, drag, styling, dead highlight)

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (2.3 FR-11..FR-15, FR-17, 3.1 NFR-02/03, 3.3 NFR-09)
- `docs/architecture.md` (§2 Browser SPA, ADR-01)
- `docs/api-contract.md` (§3 GET /graph)
- `docs/design.md` (§3.3 Main wireframe, §4 Interaction, §5.1/5.2/5.3/5.4 styling, §6 accessibility)

## Зависимости
- **T16 GET /graph** — endpoint готов.
- **T17 App shell** — ApiClient, Theme, Layout.
- **T19 Analyzing view** — accumulated partial graph (может быть hand-off в main).

## Цель
Реализовать главный экран Main: интеграция Cytoscape.js 3.33, отрисовка узлов и рёбер из `GET /graph` (или accumulated state), стилизация согласно design.md §5, базовые интеракции (zoom, pan, drag, click, hover-tooltip), подсветка мёртвого кода (FR-15).

## Scope

### В scope
- `web/src/pages/Main/MainView.tsx` — контейнер: left rail placeholder (T21–T23), Cytoscape canvas, right rail placeholder (T22–T24).
- `web/src/pages/Main/GraphCanvas.tsx`:
  - Монтирует Cytoscape.js на `<div ref={cyRef}>` через `cytoscape({container: cyRef.current, elements: [], style: […], layout: {name:'fcose'}, wheelSensitivity: 0.2})`.
  - `useEffect` на graph (Node/Edge arrays): добавляет/удаляет элементы через `cy.add()` / `cy.remove()` с учётом стабильных `id` (FR-11, FR-26).
  - Стили узлов — 8 NodeKind: shape/fill/border согласно design.md §5.1 (`cy.style().selector('node[kind="struct"]').style({...})`). Аналогично для EdgeKind (§5.2): `line-style` solid/dashed/dotted, цвета.
  - Dead-node стиль: селектор `node.dead` → `opacity: 0.45`, `border-style: dashed`, badge «×» через `text-background-*` или overlay. Класс присваивается `cy.$('#<id>').addClass('dead')` для `!Reachable`.
  - Entry-point стиль: `node.entry` → double border + star-badge.
  - Layout: `fcose` (cytoscape-fcose plugin) по умолчанию; `locked:true` для entry-узлов с computed top-row positions (§5.4, до 12 штук).
  - Interactions:
    - `tap` на узел → вызывает prop `onSelectNode(nodeId)` (Info panel в T22).
    - `mouseover` → tooltip (hover ≥ 300 мс) — через отдельный компонент `Tooltip.tsx`, position follows cursor.
    - `drag` узла — Cytoscape built-in; позиция сохраняется через `usePositionsStorage` (T17).
    - `wheel` → zoom; `drag empty` → pan.
    - `cy.fit()` на `f` hotkey.
- `web/src/pages/Main/graph-styles.ts` — экспорт `cytoscape.StylesheetJson[]` (const), использует CSS-переменные из theme через `getComputedStyle(document.documentElement)` на mount и при смене темы (observer на `data-theme` attr).
- `web/src/pages/Main/Tooltip.tsx` — hover-tooltip с полями `kind`, `name`, `package`, `file:line`.
- `web/src/pages/Main/useGraphData.ts` — hook: на входе `projectId` → fetch `GET /api/projects/{id}/graph` с query `aggregate=auto`; возвращает `{graph, warnings, loading, error}`. Если `len(Nodes) > 1000` — сервер уже вернул aggregated; клиент использует как есть (expand в T24).
- `web/src/__tests__/GraphCanvas.test.tsx`:
  - vitest + jsdom; Cytoscape монтируется в `canvas` stub; проверяем что `cy.add` вызвано с ожидаемыми элементами.
  - Класс `.dead` навешен для `!Reachable`.
  - `onSelectNode` вызывается на имитацию `tap` события (`cy.$('#id').emit('tap')`).
  - Стили применяются через селекторы (sanity — `cy.style()` non-null).

### Вне scope
- Filters panel (FR-14) — **T21**.
- Entry-points / Info panels — **T22**.
- Dead-code report panel и modes switcher — **T23**.
- Export PNG/SVG + expand aggregated — **T24**.

## Технические детали
- Cytoscape.js **3.33.2** (+ `cytoscape-fcose` — community layout, latest stable). Проверь на старте задачи `js.cytoscape.org` и `npm show cytoscape-fcose version`.
- `cytoscape-svg` **подключается в T24** для SVG-экспорта.
- Bundle: cytoscape ~250 KB min+gz; total SPA до 500 KB gzip — приемлемо (требование архитектуры ADR-01).
- Перерендер на большом графе (~1k узлов): batching через `cy.batch(() => {...})`; layout один раз после batch (NFR-03).
- Accessibility: `<div role="application" aria-label="Dependency graph">`; клавиатурные shortcuts: `f` fit, `+/-` zoom (когда canvas в focus).
- `prefers-reduced-motion` → `cy.layout({animate: false})`.

### UI visual requirements
- Normal: граф согласно §3.3 wireframe, 3-column layout, левый/правый rails — placeholder для T21–T23.
- Loading: «refreshing…» small spinner поверх графа (не блокирующий).
- Error: «Connection lost» overlay (design §3.4) через ErrorBoundary/T17.
- Empty (filter скрыл всё): центрированный текст «no nodes» (design §7).
Цвета из tokens.css; dead и entry styling — §5.3/5.4.

## Acceptance criteria
- [ ] FR-11: граф виден после получения JSON ≤ 5 с (NFR-02 sanity — для ≤ 1000 nodes).
- [ ] FR-12: zoom колёсиком, pan drag empty.
- [ ] FR-13: drag узла, рёбра пересчитаны.
- [ ] FR-15: `!Reachable` узлы отличимы (opacity + dashed border + badge).
- [ ] FR-17: hover ≥ 300 мс → tooltip с полями kind/name/package/file:line.
- [ ] Entry узлы имеют double border + star + (≤ 12) прибиты к верхнему ряду.
- [ ] Stable positions: после reload и restore (`getGraph`) — позиции узлов восстановлены из localStorage.
- [ ] NFR-03: toggle theme (light→dark) → перерисовка ≤ 100 мс без layout-сброса.
- [ ] Accessibility: focus ring на canvas при Tab; `role="application"` присутствует.

## План тестирования

### Unit-тесты
- vitest + jsdom для компонентов; snapshot styles.
- Coverage Main graph ≥ 60 % (много canvas-логики — частично покрывается E2E).

### Integration-тесты
- Не применимо.

### E2E / Browser-тесты (обязательно)
webapp-testing. В `test-evidence/T20/`:
- Скриншоты: full graph render, dead highlight, hover tooltip, after drag.
- Лог zoom/pan/drag interactions.

Сценарии:
- **J1**: upload `testdata/simple` → analyze → main-view → увидеть граф с узлами 8 kind'ов и dead-подсветкой.
- **J2**: wheel-zoom, drag node, hover tooltip, fit по `f`.
- **J3**: reload страницы → позиции восстановлены (FR-26 sanity).

## Definition of Done
- [ ] `npm run …` всё зелёное.
- [ ] `test-evidence/T20/` содержит артефакты.
- [ ] Коммиты `feat(web): cytoscape integration`.
- [ ] PR, merge, `tasks/README.md` T20 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t20-cytoscape-integration`
3. GraphCanvas скелет → styles → interactions → dead highlight → positions persist → E2E.
4. PR, merge.

## Out-of-band
- Если fcose на большом графе (~1k+) тормозит > 500 мс — попробуй `cytoscape-cose-bilkent` или `cola.js`. Если всё ещё плохо — запрос агрегации с сервера (T16 уже поддерживает `aggregate=package`).
- Если cytoscape ESM-импорт конфликтует с Vite — используй `cytoscape/dist/cytoscape.esm.js` и задокументируй.
