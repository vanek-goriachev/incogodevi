# T21: Filters panel (8 kinds toggle + package filter + find-by-name)

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (2.3 FR-14, 2.6 FR-26, 3.1 NFR-03)
- `docs/architecture.md` (§2 Browser SPA)
- `docs/design.md` (§3.3 left rail «Filter», §4 Interaction table, §8 localStorage)

## Зависимости
- **T20 Cytoscape integration** — граф и его API (`cy`).
- **T17 App shell** — useLocalStorage, Theme.

## Цель
Реализовать левый rail `Filter` панель: 8 тумблеров по NodeKind (включение/отключение), package-filter (dropdown с checkboxes), find-by-name (input с фильтрацией). Применение — чисто клиентский CSS-class toggle на Cytoscape, без запроса к серверу. Persist в localStorage (design.md §8).

## Scope

### В scope
- `web/src/pages/Main/panels/FiltersPanel.tsx`:
  - 8 `<label><input type="checkbox">` для `package|struct|interface|func|method|field|var|const`.
  - Section `Packages`: `<details>` со списком чекбоксов (dedup из `graph.nodes.map(n => n.package)`). Поиск в подстроке если пакетов > 20.
  - Section `Find`: `<input type="search">` фильтр по name/fqn (live с debounce 150 мс).
  - State локальный в компоненте, синхронизируется с `useLocalStorage('go-viz:<id>:filters')`.
  - On change — вызывает prop `onFiltersChange(filters)`.
- `web/src/pages/Main/useFilters.ts`:
  - Hook: получает cy-ref и filters → применяет CSS-классы:
    - `node[kind="var"].hidden { display: none }` + `cy.$('node[kind="var"]').addClass('hidden')` когда тумблер выключен.
    - `cy.batch(() => {...})` для массовых изменений (< 100 мс per NFR-03).
  - Find: `cy.$(`node[name *= "${query}"]`).addClass('highlight')` и `cy.$('.highlight').not(matching).removeClass(...)` — цикл.
- `web/src/pages/Main/panels/FiltersPanel.module.css` — стили.
- Keyboard: `/` фокусирует find-input (global keydown listener).
- `__tests__/FiltersPanel.test.tsx`:
  - Toggle kind → onFiltersChange вызван с обновлённым spec.
  - Filter state сохраняется в localStorage.
  - Find: ввод `handler` → onFiltersChange({find: "handler"}).
  - `/` keybind фокусирует input.

### Вне scope
- Backend-фильтрация (exclude_paths, stdlib_exclude, test_exclude) — это живёт в `EntryPointSpec` (T10/T15). Эта панель — чисто клиентские view-фильтры.
- Entry-points panel / Info panel — **T22**.
- Dead-code modes (Live only / Live+dead / Dead only) — **T23**.

## Технические детали
- `filters` в client-state ≠ server-side `Filters` (они разные концепции — server filters управляют тем, что попадает в граф; client filters управляют тем, что видно).
- CSS-class strategy vs display:none: класс с `display: none` в stylesheet → Cytoscape корректно пересчитывает layout? Для NFR-03 хочется **не** перелаять layout. Решение: `visibility: hidden` на уровне узла через `cy.style().selector('.hidden').style({display:'none'})` — Cytoscape API поддерживает.
- Debounce 150 мс для find-input через `useDeferredValue` или manual `useEffect`+`setTimeout`.
- Accessibility: каждый checkbox имеет `<label>` с aria-label; input type=search имеет role=searchbox.

### UI visual requirements
- Normal: список checkboxes с иконками/цветами kinds (maps to §5.1 legend).
- Loading: отсутствует (чисто клиентское).
- Error: при сбое sync с localStorage — tostr «could not save filter preferences», state не ломается.
- Empty: если в графе нет ни одного kind (напр., 0 interfaces) — checkbox показан но disabled.

## Acceptance criteria
- [ ] FR-14: 8 тумблеров присутствуют; выключение `func` → все func-узлы исчезают без запроса к серверу.
- [ ] NFR-03: toggle → время до полного перерендера < 100 мс для графа до 1000 узлов (проверить в DevTools Performance в E2E).
- [ ] FR-26: при reload те же фильтры восстанавливаются из localStorage.
- [ ] Find-input: ввод подсвечивает совпадения, Esc очищает.
- [ ] `/` hotkey фокусирует search.
- [ ] Keyboard navigable, focus ring visible.

## План тестирования

### Unit-тесты
- vitest + RTL, coverage ≥ 80 %.

### Integration-тесты
- Не применимо.

### E2E / Browser-тесты (обязательно)
webapp-testing. В `test-evidence/T21/`:
- Скриншоты: panel normal, kind toggled off, search highlights.
- Performance trace (NFR-03): DevTools profile < 100 мс.

Сценарии:
- **J1**: граф загружен → toggle `var` off → var-узлы исчезают.
- **J2**: search `Handler` → 1+ совпадений подсвечены.
- **J3**: reload → фильтр сохранён.

## Definition of Done
- [ ] `npm run …` зелёное.
- [ ] `test-evidence/T21/` артефакты.
- [ ] Коммиты `feat(web): filters panel`.
- [ ] PR, merge, `tasks/README.md` T21 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t21-filters-panel`
3. Компонент → hook интеграции с cy → persist → E2E.
4. PR, merge.

## Out-of-band
- Если `display:none` на 500+ узлах стоит 300 мс в Cytoscape — переведи на `.style('visibility', 'hidden')` + `.style('events', 'no')`, layout не пересчитывается.
