# web — Go Dependencies Visualizer SPA

React 19 + TypeScript 6 + Vite 8 single-page app. The static bundle is
embedded into the Go backend binary via `embed.FS` (see `docs/architecture.md`,
ADR-04).

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

## Source layout

```
web/
  index.html              entry point
  src/
    main.tsx              React 19 root bootstrap (createRoot + StrictMode)
    app/
      App.tsx             ErrorBoundary → ThemeProvider → ToastProvider → Router
      Router.tsx          state-based routing (no react-router); 4 routes
      Layout.tsx          3-column shell (left rail / graph / right rail)
      theme.tsx           ThemeProvider + useTheme; light/dark/auto
      Toasts.tsx          ToastProvider + useToast; 4 levels, 5s auto-dismiss
      ErrorBoundary.tsx   React 19 class boundary; "Connection lost" fallback
    api/
      client.ts           ApiClient (fetch + XHR for upload progress)
      sse.ts              parseSSEStream — chunk-tolerant SSE reader
      types.ts            TS mirrors of the Go domain model + API envelope
    storage/
      keys.ts             canonical localStorage key namespace (`go-viz:*`)
      useLocalStorage.ts  useLocalStorage + useDebouncedLocalStorage hooks
    styles/
      reset.css           minimal CSS reset
      tokens.css          CSS variables (palette, typography); dark via [data-theme]
      app.css             app-shell, screens, layout, toasts, error-screen
    __tests__/            Vitest + @testing-library/react suites
    test/setup.ts         jest-dom matchers, RTL cleanup, jsdom Storage shim
  vite.config.ts          plugin-react, dev proxy `/api → :8080`
  vitest.config.ts        jsdom environment, RTL setup
  tsconfig.json           strict TypeScript 6, noUncheckedIndexedAccess
  .eslintrc.cjs           ESLint with @typescript-eslint + react + react-hooks
  .prettierrc.json        formatting rules
  .browserslistrc         supported browsers (NFR-06)
```

## Architecture

### Routing
A tiny state-based router (`src/app/Router.tsx`) owns the `Route` enum and
exposes `useRouter()`. Deep links are intentionally not supported in the MVP
(see `docs/design.md`); the four screens are `landing`, `analyzing`, `main`,
`error`. Avoiding `react-router` keeps the shell bundle under 100 KB gzip.

### Theming
`ThemeProvider` reads `go-viz:theme` (`light | dark | auto`) from
`localStorage`, subscribes to `prefers-color-scheme` and
`prefers-reduced-motion`, and writes `data-theme` / `data-reduced-motion`
attributes on `<html>`. CSS variables in `tokens.css` switch on
`[data-theme="dark"]`.

### Toasts
`ToastProvider` renders a top-right stack inside a `role="status"
aria-live="polite"` viewport. Toasts auto-dismiss after 5 s and can be
clicked to close earlier. Four severities: `info | success | warning | error`.

### Error boundary
`ErrorBoundary` is a React 19 class component that catches render-time
exceptions in any subtree and shows the "Application error" screen from
`docs/design.md` §3.4. The user can `Retry` (clear the error) or
`Back to landing` (the host calls `onReset` — `App.tsx` does a hard
`window.location.reload()` so storage-backed state is restored cleanly).

### API client
`ApiClient` is a typed `fetch` wrapper. `uploadProject` uses
`XMLHttpRequest` because the Fetch standard does not yet expose
`upload.onprogress`. `analyzeProject` returns an `AbortController`; cancelling
it aborts the in-flight `fetch` and the SSE loop unwinds cleanly. Non-2xx
responses always reject with `ApiError` carrying the envelope `code`,
`message` and optional `details` from `docs/api-contract.md` §0.

### SSE parsing
`parseSSEStream` consumes a `ReadableStreamDefaultReader<Uint8Array>` and
emits `SSEEvent` records keyed by event name. It tolerates events split
across chunks, chunks containing several events, and multi-byte UTF-8
sequences split mid-codepoint (the underlying `TextDecoder` runs in
`stream` mode).

### Storage
`src/storage/keys.ts` centralises the namespace. `useLocalStorage` is the
general-purpose hook (multi-tab `storage` event sync included);
`useDebouncedLocalStorage` flushes high-frequency updates after 500 ms and is
the foundation for node-position persistence (T20+).

## CSS strategy
Plain CSS — no CSS-in-JS, no preprocessor. `tokens.css` owns CSS variables
(palette, typography, radii, shadow). `app.css` owns layout primitives. Per
component, classes use BEM-like names (`block`, `block__element`,
`block--modifier`). CSS Modules can be opted into per file as the codebase
grows; T17 ships none yet because the shell has very few selectors.

## Backend integration (dev mode)

1. Start the backend: `cd ../server && make run` (port 8080).
2. In another terminal: `cd ../web && npm run dev` (port 5173).
3. Open `http://localhost:5173` and click **check API** in the landing
   placeholder — the request flows through Vite's proxy to
   `GET /api/healthz` on the Go backend, and the result appears as a toast.

For production, `npm run build` writes the bundle to `web/dist/`. The Go
binary embeds that directory and serves it under `GET /` (T12+).
