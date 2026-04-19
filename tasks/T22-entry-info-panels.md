# T22: Entry-points + Info panels + Context menu + Collapse

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (2.2 FR-07, 2.3 FR-16/17, 2.6 FR-25/26, 3.3 NFR-09)
- `docs/api-contract.md` (§2 entry_points в body, `invalid_entry_point`)
- `docs/design.md` (§2 J2, §3.3 Entry points rail + Info rail, §4 Interaction table, §5.4 Entry styling, §8 localStorage)

## Зависимости
- **T15 POST /analyze** — triggers re-analyze при смене entry points.
- **T19 Analyzing view** — показывает phase badges для re-analyze.
- **T20 Cytoscape** — `cy` API для hide/show subtree, context menu.

## Цель
Реализовать:
1. **Entry points panel** (left rail, под filters): список активных entry points, кнопка «Add entry point» (открывает диалог выбора из `cy.nodes()` или ввод FQN), удаление.
2. **Info panel** (right rail): при tap на узел — показывает kind, file:line, sigature (если есть в `doc`), кнопка «Add as entry point» и «Go to file:line» (копировать path).
3. **Right-click context menu**: `Info`, `Add as entry`, `Hide subtree`, `Go to file:line`.
4. **Collapse subtree**: hide все потомки выбранного узла (FR-16).

## Scope

### В scope
- `web/src/pages/Main/panels/EntryPointsPanel.tsx`:
  - Загружает spec из `localStorage('go-viz:<id>:entry-points')` или defaults `{mode:'auto'}`.
  - Показывает: чекбокс «all main» (toggles `mode=auto`), список manual entries (с `[remove]`), кнопка `[+ Add entry point]`.
  - Add → диалог: либо select из `cy.nodes()[kind=func|method]` с поиском, либо textarea для ввода FQN в формате `pkg#Type.Method`.
  - Change → вызывает `POST /analyze` с новым spec → открывает Analyzing-экран встык (SSE фаза reachability быстрая, ≤ 1 s на cached parse). Error `invalid_entry_point` → inline ошибка в диалоге.
- `web/src/pages/Main/panels/InfoPanel.tsx`:
  - Props: `selectedNode: Node | null`.
  - Empty state: «Select a node to see details».
  - Fields: kind, name, package, file:line, exported, reachable/dead, doc.
  - Кнопки: `[+ Add as entry point]` (вызывает `onAddEntry(fqn)` → EntryPointsPanel.addManual(fqn)), `[Copy path]` (`navigator.clipboard.writeText(`${file}:${line}`)`).
- `web/src/pages/Main/ContextMenu.tsx`:
  - Нативный right-click handler на Cytoscape (`cy.on('cxttap', ...)`), custom `<ul>` menu абсолютно позиционирован.
  - Пункты: `Info` → открывает Info panel, `Add as entry`, `Hide subtree`, `Copy path`.
- `web/src/pages/Main/useCollapse.ts`:
  - Hook: `collapsedIDs: Set<string>`, методы `collapse(id)`, `expand(id)`.
  - `collapse(id)`: BFS по исходящим `calls/contains/embeds/references` рёбрам → `cy.$(descendants).addClass('collapsed')` → style hides.
  - `expand(id)`: обратное.
  - State persist в `localStorage('go-viz:<id>:collapsed')` (опционально).
- `__tests__/`:
  - `EntryPointsPanel.test.tsx`: toggle all-main, add manual, remove, invalid_entry_point shows inline.
  - `InfoPanel.test.tsx`: selected node → поля отображены; «Add as entry» вызывает callback.
  - `ContextMenu.test.tsx`: right-click — menu появляется; клик на пункт закрывает menu и вызывает handler.
  - `useCollapse.test.ts`: collapse → descendants hidden.

### Вне scope
- Dead-code panel — **T23**.
- Export — **T24**.

## Технические детали
- `POST /analyze` для re-analyze: запускаем тот же UploadFlow → Analyzing-экран, но в «быстром» режиме (parsed.gob кэширован, должно быть быстро). Показывать mini-progress поверх graph вместо отдельного полностраничного экрана, чтобы не терять контекст (design.md «Реактивность смены entry points»).
- FQN формат: `pkg#Type.Method` или `pkg#Func`. Tooltip в диалоге объясняет.
- `cy.on('tap', 'node', handler)` — клик; `cy.on('cxttap', 'node', handler)` — right-click. `tap` с shift = multi-select (design.md).
- `Add as entry point` из Info panel → добавляет в manual list + auto-submit re-analyze.
- Collapse state восстанавливается после re-analyze (если узлы те же — стабильные IDs).

### UI visual requirements
- Normal: EntryPoints и Info panels согласно §3.3 wireframe.
- Loading: во время re-analyze — mini-overlay, не блокирующий остальной UI.
- Error: `invalid_entry_point` → inline message в диалоге; не ломает остальные entries.
- Empty: Info — «Select a node»; EntryPoints — всегда есть хотя бы «all main».

## Acceptance criteria
- [ ] FR-07: ввод `pkg#Type.Method` валидный → re-analyze → узел становится корневым, подсветка пересчитана. Валидный тест: J2 из design.md.
- [ ] FR-16: right-click → «Hide subtree» → узел и его потомки скрыты; повторно → возвращены.
- [ ] FR-17: hover ≥ 300 мс → tooltip (уже в T20); click → Info panel показывает те же поля.
- [ ] FR-25: EntryPoints rail содержит add/remove, Info — details.
- [ ] FR-26: entry points persist через reload.
- [ ] invalid FQN → inline error, список не изменяется.
- [ ] NFR-09: ошибка добавления дубликата entry → toast, UI не ломается.

## План тестирования

### Unit-тесты
- vitest + RTL, coverage ≥ 75 %.

### Integration-тесты
- Не применимо.

### E2E / Browser-тесты (обязательно)
webapp-testing. В `test-evidence/T22/`:
- Скриншоты: entry panel normal, info panel opened, context menu, after collapse.
- Лог re-analyze flow.

Сценарии:
- **J1**: загружен testdata, click на узел → info panel; add as entry → список обновлён + re-analyze.
- **J2**: right-click → hide subtree → потомки скрыты; expand → вернулись.
- **J3**: valid manual FQN добавлен → re-analyze; invalid → inline error.

## Definition of Done
- [ ] `npm run …` зелёное.
- [ ] `test-evidence/T22/` артефакты.
- [ ] Коммиты `feat(web): entry+info panels + context menu`.
- [ ] PR, merge, `tasks/README.md` T22 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t22-entry-info-panels`
3. Info panel → Entry panel → Context menu → Collapse → E2E.
4. PR, merge.

## Out-of-band
- Если re-analyze занимает >> ожидаемой 1 s (нет `parsed.gob` hit) — остановись и проверь, что T07 действительно читает cache, и что повторный запрос не перезапускает parser.
