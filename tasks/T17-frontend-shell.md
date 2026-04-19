# T17: Frontend app shell (routing, theme, toasts, API client, localStorage)

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (2.6 FR-25/26, 3.3 NFR-09/10, 3.4 NFR-11/12)
- `docs/architecture.md` (§2 Browser SPA)
- `docs/api-contract.md` (§0 envelope ошибок — клиент должен уметь распарсить)
- `docs/design.md` (§3 wireframes, §5.5 Palettes, §5.6 Typography, §6 Accessibility, §8 LocalStorage schema)
- `docs/diagrams/rendered/02-containers.png`

## Зависимости
- **T02 Scaffold frontend** — готовый Vite/React/TS setup.

## Цель
Создать «каркас» SPA: Router (простейший — state-based, без react-router, чтобы не раздувать bundle), theme provider (light/dark/auto по `prefers-color-scheme`), Error Boundary, toasts-система, typed API-клиент (`fetch` wrapper c envelope обработкой), кастомный SSE-парсер, localStorage hooks с схемой из design.md §8.

## Scope

### В scope
- `web/src/app/App.tsx` — верхний компонент: ErrorBoundary → ThemeProvider → ToastProvider → Router.
- `web/src/app/Router.tsx` — state-based роутинг: enum `Route = 'landing' | 'analyzing' | 'main' | 'error'`; передаётся через Context; переходы через `navigate(...)`.
- `web/src/app/theme.tsx`:
  - `ThemeProvider` — читает `go-viz:theme` из localStorage (`light|dark|auto`), применяет `prefers-color-scheme`; выдаёт `data-theme` атрибут на `<html>`.
  - Hook `useTheme()`: `{theme, setTheme}`.
  - CSS-переменные в `styles/tokens.css` (свеже продолжаем из T02): light + dark наборы.
- `web/src/app/ErrorBoundary.tsx` — React 19 класс-компонент; при ошибке показывает экран «Connection lost / Application error» с кнопками Retry / Back to landing (design.md §3.4).
- `web/src/app/Toasts.tsx`:
  - `ToastProvider`, `useToast()` → `{showToast(msg, level)}`
  - 4 уровня: `info|success|warning|error`, auto-dismiss 5 с, dismissable по клику.
  - Визуально: правый верхний угол, стек, accessible (`role="status"`, `aria-live="polite"`).
- `web/src/api/client.ts`:
  - `class ApiClient`:
    - `uploadProject(file: File, name?: string): Promise<ProjectMeta>` — multipart POST, прогресс через `XMLHttpRequest.upload.onprogress` (fetch не даёт upload progress в текущих spec).
    - `analyzeProject(id, spec, filters, onEvent): AbortController` — открывает SSE через `fetch()` + `ReadableStream`, парсит `event:`/`data:` формат, вызывает `onEvent(type, payload)`.
    - `getGraph(id, opts): Promise<Graph>`.
    - `getDeadCode(id, format: 'json'|'txt'): Promise<string|DeadCodeReport>`.
    - `deleteProject(id): Promise<void>`.
    - `healthz(): Promise<HealthResponse>`.
  - Обработка envelope ошибок: если `response.ok == false`, парсить `{error:{code, message, details}}` и бросать `ApiError` с полями.
  - Base URL из `import.meta.env.VITE_API_BASE` default `''` (same-origin). В dev Vite-proxy `/api → :8080`.
- `web/src/api/sse.ts`:
  - `parseSSEStream(reader: ReadableStreamDefaultReader, onEvent): Promise<void>` — ~50 строк, разделитель `\n\n`, префиксы `event:`, `data:`, `id:`. Unit-тесты на разные chunk boundaries. **Не импортируй `@microsoft/fetch-event-source`** (unsupported).
- `web/src/api/types.ts` — TS-типы соответствующие domain + api-contract: `NodeKind`, `EdgeKind`, `Node`, `Edge`, `Graph`, `DeadCodeEntry`, `DeadCodeReport`, `Warning`, `ProjectMeta`, `EntryPointSpec`, `Filters`, `AnalysisPhase`, `SSEEventType`.
- `web/src/storage/keys.ts` + `useLocalStorage.ts`:
  - Ключи по design.md §8: `recent-projects`, `go-viz:<id>:entry-points|filters|positions|layout|dead-mode`, `go-viz:theme`.
  - Hook `useLocalStorage<T>(key, initial): [T, setT]` — с JSON sync, multi-tab `storage` event listener.
  - Throttled положения узлов — отдельный `usePositionsStorage(projectId)` с 500 мс debounce.
- `web/src/styles/tokens.css` — CSS-переменные (цвета палитры, фонты); light и dark варианты.
- `web/src/styles/reset.css` — минимальный CSS-reset.
- `web/src/app/Layout.tsx` — 3-column layout (рельс/graph/рельс) как базовый скелет, используется в **T20**.
- `web/src/__tests__/` — vitest:
  - `theme.test.tsx` — переключение theme, проверка `data-theme` атрибута.
  - `toasts.test.tsx` — showToast появляется и автодисмис.
  - `sse.test.ts` — парсер на синтетических потоках.
  - `api-client.test.ts` — моки `fetch`, проверка envelope-обработки.
  - `useLocalStorage.test.tsx` — round-trip.

### Вне scope
- Landing (drag-n-drop) — **T18**.
- Analyzing view (SSE UI) — **T19**.
- Cytoscape integration — **T20**.
- Конкретные panels — **T21..T23**.
- Export и агрегация — **T24**.

## Технические детали
- React 19.2 (`createRoot`), StrictMode включён.
- TS 6 strict; `noUncheckedIndexedAccess: true`; Enforced via tsconfig.
- CSS: plain CSS + CSS Modules **или** только tokens.css + BEM-подобные классы; без CSS-in-JS (ADR-01). Выбор CSS Modules — зафиксируй в `README.md` пакета web.
- `fetch()` + `ReadableStream.getReader()` для SSE; chunk decoding через `TextDecoder('utf-8', {fatal: true, stream: true})`. Клиент должен корректно обрабатывать boundary на `\n\n` через несколько chunks.
- Accessibility: `html lang="en"`, focus-visible, `prefers-reduced-motion` — учитывается ThemeProvider'ом (disables transitions). `@axe-core/react` в dev-bundle.
- Bundle size target: shell < 150 KB gzip (до Cytoscape).

## Acceptance criteria
- [x] Router переключает state; `?route=main` deep-link не поддерживается для MVP.
- [x] ThemeProvider применяет `data-theme="dark"` при `prefers-color-scheme: dark`, сохраняет выбор пользователя.
- [x] ErrorBoundary ловит ошибку в дочернем компоненте (unit-тест) и показывает fallback UI, не роняя всё приложение (NFR-09).
- [x] Toasts появляются и автодисмиссятся через 5 с; `role="status"` для screen reader.
- [x] ApiClient.uploadProject: 413 → `ApiError{code:"archive_too_large"}`.
- [x] SSE-парсер: тест с несколькими chunks и частичными event-блоками корректно собирает событие.
- [x] `useLocalStorage` сохраняет и восстанавливает.
- [x] `npm run build` ≤ 200 KB gzip.
- [x] `npm run lint`, `typecheck`, `test` — зелёные.

## План тестирования

### Unit-тесты
- vitest + @testing-library/react. Coverage shell-пакетов ≥ 70 %.

### Integration-тесты
- Не применимо (нет backend интеграции без реализованных панелей).

### E2E / Browser-тесты
- В T26 (полный journey).

### UI visual requirements
Поведение в нормальном состоянии — пустой «App ready» экран с theme применённой. В ErrorBoundary — экран из design.md §3.4. Loading/Empty — per design.md §7 матрица. Пока только shell — полный UI в T18+.

## Definition of Done
- [x] `npm run typecheck && npm run lint && npm run test && npm run build` — зелёные.
- [x] `web/README.md` описывает архитектуру src (routing, theme, api, storage).
- [x] Коммиты `feat(web): app shell`.
- [x] PR, merge, `tasks/README.md` T17 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b feat/t17-frontend-shell`
3. Theme → Toasts → ErrorBoundary → ApiClient → SSE parser → localStorage hooks → тесты.
4. PR, merge.

## Out-of-band
- Если tsconfig `noUncheckedIndexedAccess` ломает cytoscape typings при подключении в T20 — обсуди откат на `false` или локальные `as const` обходы. Остановись и спроси.
