# web — Go Dependencies Visualizer SPA

React 19 + TypeScript 6 + Vite 8 single-page app. Static bundle is embedded
into the Go backend binary via `embed.FS` (see `docs/architecture.md`, ADR-04).

## Requirements

- Node.js 24 LTS or newer.
- npm 10+.

## Scripts

| Command            | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| `npm run dev`      | Start Vite dev server on `http://localhost:5173`. Proxies `/api/*` to `http://localhost:8080` (Go backend). |
| `npm run build`    | Type-check (`tsc --noEmit`) then produce a production bundle in `dist/`. |
| `npm run preview`  | Serve the built bundle locally for smoke testing.                  |
| `npm run lint`     | Run ESLint over `src/`.                                            |
| `npm run typecheck`| Run TypeScript in no-emit mode.                                    |
| `npm run test`     | Run the Vitest suite once (CI mode).                               |

## Layout

```
web/
  index.html              entry point
  src/
    App.tsx               placeholder shell with API health probe
    main.tsx              React 19 root bootstrap (createRoot)
    styles/               CSS reset and design tokens (mirrors design.md §5.6)
    __tests__/            Vitest + React Testing Library smoke tests
    test/setup.ts         jest-dom matchers + auto-cleanup
  vite.config.ts          plugin-react, dev proxy `/api → :8080`
  vitest.config.ts        jsdom environment, RTL setup
  tsconfig.json           strict TypeScript 6 config
  .eslintrc.cjs           ESLint with @typescript-eslint + react + react-hooks
  .prettierrc.json        formatting rules
  .browserslistrc         supported browsers (NFR-06)
```

## Backend integration (dev mode)

1. Start the backend: `cd ../server && make run` (port 8080).
2. In another terminal: `cd ../web && npm run dev` (port 5173).
3. Open `http://localhost:5173` and click **check API** — the request flows
   through Vite's proxy to `GET /api/healthz` on the Go backend.

For production, `npm run build` writes the bundle to `web/dist/`. The Go
binary embeds that directory and serves it under `GET /` (T12+).
