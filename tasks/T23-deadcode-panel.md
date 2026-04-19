# T23: Dead-code panel + Dead-code display modes + TXT/JSON export

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (2.4 FR-19/20, 2.5 FR-23/24, 3.1 NFR-03, 2.6 FR-26)
- `docs/api-contract.md` (§4 GET /dead-code)
- `docs/design.md` (§2 J4, §3.3 right rail «Dead code», §5.3 display modes, §8 localStorage)

## Зависимости
- **T16 GET /dead-code** — endpoint готов.
- **T20 Cytoscape integration** — базовый dead-highlight.
- **T17 App shell** — ApiClient.

## Цель
Правая панель «Dead code (N)»: список мёртвых сущностей + кнопки экспорта TXT/JSON. Верхний-бар сегментированный контрол «Dead-code display mode»: `Live only | Live + dead 0.45 (default) | Dead only` (design.md §5.3). Переключение — чисто клиентский CSS-class toggle (< 100 мс, NFR-03). Persist в localStorage.

## Scope

### В scope
- `web/src/pages/Main/panels/DeadCodePanel.tsx`:
  - Загружает report через `apiClient.getDeadCode(id, 'json')` один раз после analyze-done; обновляется на re-analyze.
  - Список: `{kind} {pkg}.{name} — {file}:{line}` (форматирование из FR-20).
  - Кнопка `[TXT]` → `apiClient.getDeadCode(id, 'txt')` с `download=1` → browser download `<project>-dead-code-<timestamp>.txt`.
  - Кнопка `[JSON]` → аналогично, `.json`.
  - Пустой список → «No dead code detected 🎉» (design.md §7).
  - Клик на строку → `cy.center(cy.$('#' + entry.node_id))` (автоскролл графа к узлу).
- `web/src/pages/Main/DeadModeSwitcher.tsx`:
  - Top-bar сегментированный контрол (3 опции); hotkey `d` циклит.
  - On change → `useDeadMode()` hook → применяет CSS-класс на cy-контейнере: `data-dead-mode="live-only|live-dead|dead-only"`.
  - Cytoscape style rules (добавляется в graph-styles T20): селекторы используют `:parent` и `.dead` с `display:none` в режимах «live only» / «dead only».
  - Persist в `localStorage('go-viz:<id>:dead-mode')`.
- `web/src/pages/Main/useDeadMode.ts`:
  - Hook, возвращает `{mode, setMode}`; применяет классы в `cy`.
- `__tests__/`:
  - `DeadCodePanel.test.tsx`: список рендерится; empty case; TXT/JSON клики вызывают apiClient с правильными args; клик на строку → cy.center.
  - `DeadModeSwitcher.test.tsx`: cycle через `d` hotkey; persist; правильный класс установлен.
  - `useDeadMode.test.ts`: применение классов корректно.

### Вне scope
- PNG/SVG export + expand aggregated — **T24**.

## Технические детали
- Скачивание файла: `fetch` → `blob()` → `URL.createObjectURL` → `<a href download>`; либо более простое `window.location = URL` с `?download=1` (сервер установит Content-Disposition).
- Sort: сервер уже сортирует (T16 exporter). Клиент — не пересортирует.
- Accessibility: кнопки экспорта имеют `aria-label`; список — `<ul>` + `<li>`; клик на `<li>` с `role="button"` + keyboard Enter.
- Dark theme: стили панели используют tokens.css.

### UI visual requirements
- Normal: список строк с иконками kinds, кнопки TXT/JSON, индикатор количества в заголовке.
- Loading: skeleton рядами (3 шт) или spinner.
- Error: «Could not load dead-code report» + Retry.
- Empty: «No dead code detected 🎉».
- Modes:
  - `Live only`: панель показывает «n/a» или скрыта — либо держим список всегда видимым, но граф скрывает dead.
  - `Dead only`: граф показывает dead, live скрыт — для аудита.
  - `Live + dead 0.45` (default): всё видно, dead приглушён.

## Acceptance criteria
- [ ] FR-20: список формат совпадает с `kind pkg.Name — file:line`.
- [ ] FR-23: TXT download — корректный файл, UTF-8, LF, без BOM (сервер уже выдаёт правильно).
- [ ] FR-24: JSON download — валидный JSON по схеме.
- [ ] NFR-03: смена mode → ≤ 100 мс перерендера (client-only CSS toggle).
- [ ] Persist mode через reload.
- [ ] Hotkey `d` циклит Live-only → Live+dead → Dead-only.
- [ ] Клик на entry → граф центрируется на узле.
- [ ] Empty: 🎉 сообщение.

## План тестирования

### Unit-тесты
- vitest + RTL, coverage ≥ 80 %.

### Integration-тесты
- Не применимо.

### E2E / Browser-тесты (обязательно)
webapp-testing. В `test-evidence/T23/`:
- Скриншоты: panel с entries, empty state, Live-only / Dead-only режимы.
- Лог: цикл `d` hotkey, download TXT.

Сценарии:
- **J1**: `testdata/deadcode_case` (заранее known dead) → panel списывает; скачать TXT → файл содержит тех же сущностей.
- **J2**: Переключение mode через `d` → граф показывает только live / только dead.
- **J3**: Клик на строку → граф центруется на узле.

## Definition of Done
- [ ] `npm run …` зелёное.
- [ ] `test-evidence/T23/` артефакты.
- [ ] Коммиты `feat(web): dead-code panel + modes`.
- [ ] PR, merge, `tasks/README.md` T23 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t23-deadcode-panel`
3. Panel → DeadModeSwitcher → persist → E2E.
4. PR, merge.

## Out-of-band
- Если Safari блокирует download через `<a download>` при cross-origin — используем `window.location.href = '/api/.../dead-code?format=txt&download=1'` на same-origin. На localhost same-origin гарантирован.
