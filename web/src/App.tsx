import { useCallback, useState } from 'react';

type HealthState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; payload: string }
  | { status: 'error'; message: string };

const HEALTH_ENDPOINT = '/api/healthz';

function App() {
  const [health, setHealth] = useState<HealthState>({ status: 'idle' });

  const checkApi = useCallback(async () => {
    setHealth({ status: 'loading' });
    try {
      const response = await fetch(HEALTH_ENDPOINT, {
        headers: { Accept: 'application/json, text/plain;q=0.9' },
      });
      if (!response.ok) {
        setHealth({
          status: 'error',
          message: `HTTP ${String(response.status)} ${response.statusText}`,
        });
        return;
      }
      const body = (await response.text()).trim();
      setHealth({ status: 'ok', payload: body || 'ok' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'network error';
      setHealth({ status: 'error', message });
    }
  }, []);

  return (
    <main className="app-shell">
      <h1>Go Dependencies Visualizer</h1>
      <p>Frontend scaffold ready. Backend health probe is wired through the dev proxy.</p>
      <button type="button" onClick={() => void checkApi()} disabled={health.status === 'loading'}>
        check API
      </button>
      <output aria-live="polite" data-testid="health-status">
        {renderHealth(health)}
      </output>
    </main>
  );
}

function renderHealth(state: HealthState): string {
  switch (state.status) {
    case 'idle':
      return '';
    case 'loading':
      return 'Checking…';
    case 'ok':
      return `OK: ${state.payload}`;
    case 'error':
      return `Error: ${state.message}`;
  }
}

export default App;
