/**
 * Top-level application component.
 *
 * Composition order is intentional:
 *   ErrorBoundary  — catches all subtree exceptions (NFR-09).
 *   ThemeProvider  — owns `<html data-theme>` so toasts and screens see it.
 *   ToastProvider  — toast viewport mounts before `Router` so any screen
 *                    can call `useToast()`.
 *   Router         — switches between Landing / Analyzing / Main / Error.
 *
 * Concrete screen content lands in T18..T23; T17 ships placeholder shells
 * so the routing wiring is exercisable end-to-end.
 */

import { useCallback, useMemo, type JSX } from 'react';

import { ErrorBoundary } from './ErrorBoundary';
import { Layout } from './Layout';
import { RouteSwitch, Router, useRouter } from './Router';
import { ThemeProvider, useTheme, type ThemeChoice } from './theme';
import { ToastProvider, useToast } from './Toasts';
import { ApiClient } from '../api/client';

const SHELL_VERSION = '0.1.0';

const apiClient = new ApiClient();

function App(): JSX.Element {
  const handleResetToLanding = useCallback(() => {
    // ErrorBoundary fired — the simplest deterministic recovery is a hard
    // reload, which also re-runs `localStorage` restoration on the next mount.
    window.location.reload();
  }, []);

  return (
    <ErrorBoundary onReset={handleResetToLanding}>
      <ThemeProvider>
        <ToastProvider>
          <Router initialRoute="landing">
            <Shell />
          </Router>
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

function Shell(): JSX.Element {
  const screens = useMemo(
    () => ({
      landing: <LandingPlaceholder />,
      analyzing: <AnalyzingPlaceholder />,
      main: <MainPlaceholder />,
      error: <ErrorPlaceholder />,
    }),
    [],
  );

  return (
    <div className="app-shell" data-testid="app-shell">
      <TopBar />
      <RouteSwitch routes={screens} />
    </div>
  );
}

function TopBar(): JSX.Element {
  const { theme, setTheme } = useTheme();
  const { route, navigate } = useRouter();

  return (
    <header className="app-shell__top-bar" data-testid="app-shell-top-bar">
      <h1 className="app-shell__title">Go Dependencies Visualizer</h1>
      <nav className="app-shell__nav" aria-label="Primary">
        <button
          type="button"
          aria-current={route === 'landing' ? 'page' : undefined}
          onClick={() => {
            navigate('landing');
          }}
        >
          Landing
        </button>
        <button
          type="button"
          aria-current={route === 'analyzing' ? 'page' : undefined}
          onClick={() => {
            navigate('analyzing');
          }}
        >
          Analyzing
        </button>
        <button
          type="button"
          aria-current={route === 'main' ? 'page' : undefined}
          onClick={() => {
            navigate('main');
          }}
        >
          Main
        </button>
      </nav>
      <label className="app-shell__theme">
        <span className="visually-hidden">Theme</span>
        <select
          value={theme}
          onChange={(evt) => {
            setTheme(evt.target.value as ThemeChoice);
          }}
          data-testid="theme-select"
        >
          <option value="auto">Auto</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
    </header>
  );
}

function LandingPlaceholder(): JSX.Element {
  const { showToast } = useToast();
  const { navigate } = useRouter();
  const checkApi = useCallback(() => {
    apiClient
      .healthz()
      .then((info) => {
        showToast(`Backend ok — uptime ${String(info.uptime_sec)}s`, 'success');
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'unknown error';
        showToast(`Health check failed: ${message}`, 'error');
      });
  }, [showToast]);

  return (
    <section className="screen screen--landing" data-testid="screen-landing">
      <h2>Welcome</h2>
      <p>
        Drop a Go project ZIP to start. Upload UI ships in T18; this shell only
        verifies routing, theme, toasts and API plumbing.
      </p>
      <div className="screen__actions">
        <button type="button" onClick={checkApi}>
          check API
        </button>
        <button
          type="button"
          onClick={() => {
            navigate('analyzing');
          }}
        >
          Simulate analyze
        </button>
      </div>
      <footer className="screen__footer">
        <small>Shell version {SHELL_VERSION}</small>
      </footer>
    </section>
  );
}

function AnalyzingPlaceholder(): JSX.Element {
  return (
    <section className="screen screen--analyzing" data-testid="screen-analyzing">
      <h2>Analyzing</h2>
      <p>SSE phase ticker lands in T19.</p>
    </section>
  );
}

function MainPlaceholder(): JSX.Element {
  return (
    <section className="screen screen--main" data-testid="screen-main">
      <Layout
        topBar={<strong>Project info</strong>}
        leftRail={<small>Entry points · Filters</small>}
        rightRail={<small>Info · Dead code · Export</small>}
      >
        <p>Cytoscape canvas mounts here in T20.</p>
      </Layout>
    </section>
  );
}

function ErrorPlaceholder(): JSX.Element {
  const { navigate } = useRouter();
  return (
    <section className="screen screen--error" data-testid="screen-error" role="alert">
      <h2>Connection lost</h2>
      <p>
        Could not reach the server. Local data (entry points, filters and node
        positions) is kept in this browser.
      </p>
      <div className="screen__actions">
        <button
          type="button"
          onClick={() => {
            navigate('landing');
          }}
        >
          Back to landing
        </button>
      </div>
    </section>
  );
}

export default App;
