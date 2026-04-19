# T02: Scaffold frontend

## Контекст
Ты работаешь над проектом Go Dependencies Visualizer (курсовой ВШЭ БПИ236). Обязательно прочитай перед началом:
- `docs/requirements.md` (разделы: 3.2 NFR-06, 4 «Ограничения»)
- `docs/architecture.md` (разделы: 2 «Контейнеры», ADR-01, ADR-04)
- `docs/design.md` (разделы: 1 Principles, 5.6 Typography, 6 Accessibility)
- `docs/diagrams/rendered/02-containers.png`

## Зависимости
Стартовая задача (параллельно с T01).

## Цель
Создать скелет SPA: Vite 8 + React 19.2 + TypeScript 6 + eslint + prettier + vitest + React Testing Library. Пустой layout «Hello + health». Bundle собирается в `web/dist/` под последующий `embed.FS` из backend. Версии сверяются со свежими релиз-нотами **на старте задачи** (react.dev/versions, vitejs.dev/blog, typescriptlang.org).

## Scope

### В scope
- Создать файлы:
  - `web/package.json` (deps: `react@^19.2`, `react-dom@^19.2`, `cytoscape@^3.33`, `cytoscape-svg@^0.4` — community extension kaluginserg/cytoscape-svg, pinned; devDeps: `vite@^8`, `@vitejs/plugin-react`, `typescript@^6`, `eslint`, `@typescript-eslint/*`, `eslint-plugin-react`, `eslint-plugin-react-hooks`, `prettier`, `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `@axe-core/react`). **НЕ** добавлять `@microsoft/fetch-event-source` — не поддерживается с 2021 (см. api-contract.md §2). SSE-клиент пишется руками в T19 (~50 строк TS на `fetch` + `ReadableStream`).
  - `web/tsconfig.json` (strict true, target ES2020, module ESNext, jsx react-jsx)
  - `web/vite.config.ts` (plugin-react, outDir `dist`, base `/`, server proxy `/api` → `http://localhost:8080`)
  - `web/.eslintrc.cjs` + `web/.prettierrc.json`
  - `web/.browserslistrc` (`last 2 Chrome versions`, `last 2 Firefox versions`, `last 2 Edge versions`, `last 2 Safari versions`)
  - `web/index.html` (`<html lang="en">`, `<title>Go Dependencies Visualizer</title>`, `<div id="root">`)
  - `web/src/main.tsx`, `web/src/App.tsx` (заглушка «Go Dependencies Visualizer» + кнопка «check API» → `fetch('/api/healthz')`)
  - `web/src/styles/reset.css`, `web/src/styles/tokens.css` (CSS-переменные из design.md §5.6)
  - `web/src/vite-env.d.ts`
  - `web/src/__tests__/App.test.tsx` (smoke: рендерится заголовок)
  - `web/vitest.config.ts` (jsdom, setupFiles для `@testing-library/jest-dom`)
  - `web/README.md`

### Вне scope (делается в другой задаче)
- Приложенческий shell (routing, theme, toasts, API-client) — **T17**
- Landing / upload — **T18**
- Cytoscape и панели — **T20..T24**

## Технические детали
- **React 19.2** (`createRoot` из `react-dom/client`, legacy `ReactDOM.render` удалён), **TypeScript 6 strict**.
- `vite.config.ts` dev-proxy: `server: { proxy: { '/api': 'http://localhost:8080' } }` — чтобы dev-режим ходил в Go-backend без CORS.
- CSS-переменные в `tokens.css`:
  - `--font-ui`, `--font-mono` (design.md §5.6)
  - `--color-bg`, `--color-fg` (light default, переопределяется в `@media (prefers-color-scheme: dark)`)
- `browserslistrc` соответствует NFR-06.
- Скрипты в `package.json`:
  - `dev` → `vite`
  - `build` → `tsc --noEmit && vite build`
  - `preview` → `vite preview`
  - `lint` → `eslint src --ext .ts,.tsx`
  - `test` → `vitest run`
  - `typecheck` → `tsc --noEmit`

## Acceptance criteria
- [ ] `cd web && npm install` проходит без ошибок на Node 24 LTS (Node 20 EOL 2026-04-30).
- [ ] `npm run typecheck` чистый.
- [ ] `npm run lint` чистый.
- [ ] `npm run test` зелёный (1 smoke-тест проходит).
- [ ] `npm run build` создаёт `web/dist/index.html` + ассеты; размер bundle (gzip) под `400 КБ` (без Cytoscape логики пока — чисто baseline).
- [ ] `npm run dev` открывает страницу на `:5173`, заголовок `Go Dependencies Visualizer` виден.
- [ ] `<html lang="en">` — проверено.

## План тестирования

### Unit-тесты
- `App.test.tsx` — рендерит заголовок, кнопка «check API» присутствует, tab-order корректный.

### Integration-тесты
- Не применимо.

### E2E / Browser-тесты
- Smoke browser-тест в рамках этой задачи не обязателен (нет функциональности). Первый E2E прогоняется в **T26** после того, как все панели готовы.

## Definition of Done
- [ ] `npm ci && npm run build && npm run lint && npm run test && npm run typecheck` — всё зелёное.
- [ ] `web/dist/` создаётся корректно.
- [ ] Коммиты в Conventional Commits (`chore(web): scaffold …`).
- [ ] PR создан, `tasks/README.md` обновлён: T02 `[x]`.

## Как работать
1. `git checkout main && git pull`
2. `git checkout -b chore/t02-scaffold-frontend`
3. `npm create vite@latest web -- --template react-ts` (или вручную) — подчистить до требуемой раскладки.
4. Добавить deps, конфиги, smoke-тест, README.
5. `npm run build && npm run test` — зелёно.
6. Коммит(ы), push, PR, merge.

## Out-of-band
Если Node-версия в CI/локально не определена — уточни. По ADR-04 принято Node 24 (alpine) в Docker stage (Node 20 EOL 2026-04-30). Если появится Vite 9 / React 20 к моменту старта — зафиксируй **текущие** стабильные версии, не слепо последние.
