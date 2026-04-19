# T19: Analyzing view (SSE consumer, phase badges, partial rendering)

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (3.1 NFR-02, 3.3 NFR-08/09)
- `docs/architecture.md` (§5 Dynamic view)
- `docs/api-contract.md` (§2 SSE events детально)
- `docs/design.md` (§2 J1, §3.2 Analyzing wireframe, §7 states)

## Зависимости
- **T15 POST /analyze (SSE)** — backend готов.
- **T17 App shell** — ApiClient, SSE parser, Toasts, Router.

## Цель
Реализовать экран «Analyzing»: подписывается на SSE через ApiClient, показывает phase-бейджи и прогресс-бар, inline-warnings, auto-переход на Main на `done`. Cancel-кнопка появляется после 3 с в одной фазе (design.md §3.2). Накапливает `partial_graph` в state (будет использовано Main/T20 для инкрементальной отрисовки).

## Scope

### В scope
- `web/src/pages/Analyzing/AnalyzingView.tsx`:
  - Загружает entry-points spec и filters из localStorage (defaults если нет).
  - `useEffect`: при монтировании вызывает `apiClient.analyzeProject(id, spec, filters, onEvent)` и возвращает abortController для `cancel`.
  - Обработчики:
    - `phase`: обновить текущую phase и progress.
    - `partial_graph`: merge узлов/рёбер в state (`Map<nodeId, Node>` dedup).
    - `warning`: push в toasts (amber, dismissable).
    - `done`:
      - `phase == "done"` → navigate to `main` route с `projectId` + accumulated graph (или re-fetch `GET /graph`).
      - `phase == "failed"` → показать fallback UI c кнопкой Retry, сохраняем warnings.
- `web/src/pages/Analyzing/PhaseBadges.tsx` — ряд бейджей: `[✓ loading] [✓ parsing] [● building_graph 62%] [ reachability] [ done]`, `✓` для завершённых, `●` с процентом для текущей.
- `web/src/pages/Analyzing/CancelButton.tsx` — `useEffect` с `setTimeout(3000)` на каждый новый phase; `clearTimeout` на следующий. При истечении — `setShowCancel(true)`. Кнопка вызывает `abortController.abort()` → server видит `ctx.Canceled` → SSE соединение закрывается.
- `web/src/pages/Analyzing/index.ts` — экспорт.
- `web/src/__tests__/AnalyzingView.test.tsx`:
  - Mock ApiClient, симулирует поток SSE: phases → partial → warning → done.
  - Проверка: бейджи обновляются; progress bar рендерится; warning-toast появляется; на `done` вызван `navigate('main')`.
  - Cancel-кнопка: скрыта до 3 с; после — видна; клик вызывает abort; state «analysis interrupted» с Retry.
  - Ошибка на соединении (server 500 до SSE) → fallback экран с Retry.

### Вне scope
- Main graph rendering — **T20** (использует accumulated state).
- Cytoscape — **T20**.

## Технические детали
- `apiClient.analyzeProject` возвращает `AbortController` — для cancel.
- AccumulatedGraph: `{nodes: Map<string, Node>, edges: Map<string, Edge>}` — хранится в ref, transferring to Main на `done`.
- Throttle обновлений UI: `partial_graph` может приходить часто; используем `useDeferredValue` или ручной throttle 100мс чтобы не ре-рендерить на каждый chunk.
- NFR-02: первый `partial_graph` → first paint. Требование: `<= 5 s` с момента получения JSON до ready. Тут — рендер бейджей моментальный, сам граф — T20.
- Reduced motion: если `prefers-reduced-motion` — отключить transitions бейджей.

### UI visual requirements
- Normal: phase badges + progress (design.md §3.2).
- Loading (сам экран — это loading-состояние приложения).
- Error: fallback с Retry (design.md §7).
- Empty: не применимо (этот экран только при активной загрузке).

## Acceptance criteria
- [ ] Получение `phase:loading`, `phase:parsing` и т. д. обновляет бейджи в порядке.
- [ ] Cancel button: скрыта первые 3 с, видна после.
- [ ] Cancel → server видит отмену (через abort), UI показывает «analysis interrupted».
- [ ] Warning событие → amber toast сверху-справа, dismissable.
- [ ] `done.failed` → fallback UI с Retry.
- [ ] `done` → navigate to main-view.
- [ ] Bundle shell+analyzing < 200 KB gzip.
- [ ] `prefers-reduced-motion` учитывается.

## План тестирования

### Unit-тесты
- vitest + RTL + fake SSE stream.
- Coverage Analyzing ≥ 75 %.

### Integration-тесты
- Не применимо (backend замокан).

### E2E / Browser-тесты (обязательно)
webapp-testing skill. В `test-evidence/T19/`:
- Скриншоты: phase badges в mid-run, warning toast, cancel button appeared.
- Лог прогона.

Сценарии:
- **J1**: upload (T18) → Analyzing → переход на Main (backend реально анализирует `testdata/simple`).
- **J2**: cancel mid-run → state "interrupted" → Retry восстанавливает поток.
- **J3**: simulate server error (backend не запущен) → fallback UI.

## Definition of Done
- [ ] `npm run …` всё зелёное.
- [ ] `test-evidence/T19/` содержит артефакты.
- [ ] Коммиты `feat(web): analyzing sse view`.
- [ ] PR, merge, `tasks/README.md` T19 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t19-analyzing-view`
3. Состояние-редьюсер → PhaseBadges → CancelButton → интеграция → E2E.
4. PR, merge.

## Out-of-band
- Если `partial_graph` throttle даёт заметный «залипший» прогресс (UI не обновляется) — уменьшить throttle или перейти на `startTransition`. Спроси при сомнениях.
