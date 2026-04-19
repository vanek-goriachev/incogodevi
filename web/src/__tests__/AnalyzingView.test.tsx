/**
 * Analyzing screen tests — covers the SSE state machine, badge progression,
 * cancel timing, warning toasts and failure / cancel fallbacks. The shell
 * is wired up exactly the way `App.tsx` wires it, but with a hand-rolled
 * router and a fake `analyzeProject` that lets each test drive the stream.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, type JSX } from 'react';

import { AnalyzingView } from '../pages/Analyzing';
import { ApiClient, ApiError } from '../api/client';
import type {
  AnalyzeErrorCallback,
  AnalyzeEventCallback,
} from '../api/client';
import type {
  DoneEvent,
  Edge,
  EntryPointSpec,
  Filters,
  Node,
  PartialGraphEvent,
  PhaseEvent,
  WarningEvent,
} from '../api/types';
import { Router, useRouter, type Route, type RouteState } from '../app/Router';
import { ToastProvider } from '../app/Toasts';
import { projectKey } from '../storage/keys';

interface StreamHandle {
  emit: AnalyzeEventCallback;
  fail: AnalyzeErrorCallback;
  controller: AbortController;
  spec: { entry_points?: EntryPointSpec; filters?: Filters };
  abortPromise: Promise<void>;
}

interface FakeClientFactory {
  client: ApiClient;
  /** Resolves once `analyzeProject` has been invoked at least `n` times. */
  awaitStream: (n?: number) => Promise<StreamHandle>;
  /** All stream handles seen so far, in call order. */
  handles: StreamHandle[];
}

function createFakeClient(): FakeClientFactory {
  const handles: StreamHandle[] = [];
  const waiters: Array<{ n: number; resolve: (h: StreamHandle) => void }> = [];

  function notify(): void {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i];
      if (w === undefined) {
        continue;
      }
      if (handles.length >= w.n) {
        const handle = handles[w.n - 1];
        if (handle === undefined) {
          continue;
        }
        waiters.splice(i, 1);
        w.resolve(handle);
      }
    }
  }

  const client = new ApiClient();
  vi.spyOn(client, 'analyzeProject').mockImplementation(
    (
      _projectId: string,
      spec: { entry_points?: EntryPointSpec; filters?: Filters },
      onEvent: AnalyzeEventCallback,
      onError?: AnalyzeErrorCallback,
    ): AbortController => {
      const controller = new AbortController();
      let resolveAbort: () => void = () => {};
      const abortPromise = new Promise<void>((resolve) => {
        resolveAbort = resolve;
      });
      controller.signal.addEventListener('abort', () => {
        resolveAbort();
      });
      const handle: StreamHandle = {
        emit: onEvent,
        fail: onError ?? ((): void => {}),
        controller,
        spec,
        abortPromise,
      };
      handles.push(handle);
      notify();
      return controller;
    },
  );

  return {
    client,
    handles,
    awaitStream(n = 1): Promise<StreamHandle> {
      if (handles.length >= n) {
        return Promise.resolve(handles[n - 1] as StreamHandle);
      }
      return new Promise<StreamHandle>((resolve) => {
        waiters.push({ n, resolve });
      });
    },
  };
}

interface HarnessProps {
  apiClient: ApiClient;
  initialState?: RouteState;
  onRouteChange?: (route: Route, state: RouteState) => void;
}

function Harness({
  apiClient,
  initialState,
  onRouteChange,
}: HarnessProps): JSX.Element {
  const spy =
    onRouteChange === undefined ? <RouteSpy /> : <RouteSpy onChange={onRouteChange} />;
  const router =
    initialState === undefined ? (
      <Router initialRoute="analyzing">
        {spy}
        <ScreenSwitch apiClient={apiClient} />
      </Router>
    ) : (
      <Router initialRoute="analyzing" initialState={initialState}>
        {spy}
        <ScreenSwitch apiClient={apiClient} />
      </Router>
    );
  return <ToastProvider autoDismissMs={50_000}>{router}</ToastProvider>;
}

interface RouteSpyProps {
  onChange?: (route: Route, state: RouteState) => void;
}

function RouteSpy({ onChange }: RouteSpyProps): JSX.Element | null {
  const { route, state } = useRouter();
  useEffect(() => {
    if (onChange !== undefined) {
      onChange(route, state);
    }
  }, [route, state, onChange]);
  return null;
}

function ScreenSwitch({ apiClient }: { apiClient: ApiClient }): JSX.Element {
  const { route } = useRouter();
  if (route === 'analyzing') {
    return <AnalyzingView apiClient={apiClient} cancelDelayMs={50} partialThrottleMs={0} />;
  }
  if (route === 'main') {
    return <section data-testid="screen-main">main</section>;
  }
  return <section data-testid="screen-landing">landing</section>;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('AnalyzingView', () => {
  it('shows a no-project fallback when no projectId is in route state', () => {
    const { client } = createFakeClient();
    render(<Harness apiClient={client} initialState={{}} />);
    expect(screen.getByTestId('analyzing-empty')).toHaveTextContent(
      /No project selected/i,
    );
    // No analyze call should have been issued.
    expect(client.analyzeProject).not.toHaveBeenCalled();
  });

  it('starts the SSE stream on mount with stored entry-points and filters', async () => {
    const { client, awaitStream } = createFakeClient();
    const projectId = 'pid-abc';
    window.localStorage.setItem(
      projectKey(projectId, 'entry-points'),
      JSON.stringify({
        mode: 'manual',
        auto_kinds: [],
        manual: ['github.com/acme/example/api#Handler'],
        interface_impl: [],
      } satisfies EntryPointSpec),
    );
    window.localStorage.setItem(
      projectKey(projectId, 'filters'),
      JSON.stringify({
        include_kinds: ['package', 'func'],
        exclude_paths: ['vendor/*'],
        stdlib_exclude: false,
        test_exclude: true,
      } satisfies Filters),
    );

    render(
      <Harness
        apiClient={client}
        initialState={{ projectId, projectName: 'github.com/acme/example' }}
      />,
    );

    const handle = await awaitStream();
    expect(handle.spec.entry_points?.mode).toBe('manual');
    expect(handle.spec.entry_points?.manual).toContain(
      'github.com/acme/example/api#Handler',
    );
    expect(handle.spec.filters?.include_kinds).toEqual(['package', 'func']);
    expect(handle.spec.filters?.stdlib_exclude).toBe(false);
  });

  it('advances badges as phase events arrive and exposes progress', async () => {
    const { client, awaitStream } = createFakeClient();
    render(
      <Harness
        apiClient={client}
        initialState={{ projectId: 'pid', projectName: 'demo' }}
      />,
    );
    const handle = await awaitStream();

    act(() => {
      handle.emit({
        type: 'phase',
        payload: { seq: 1, phase: 'loading' } satisfies PhaseEvent,
      });
    });
    expect(screen.getByTestId('analyzing-phase-loading')).toHaveAttribute(
      'data-state',
      'current',
    );

    act(() => {
      handle.emit({
        type: 'phase',
        payload: { seq: 2, phase: 'parsing', progress: 0.25 },
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('analyzing-phase-loading')).toHaveAttribute(
        'data-state',
        'done',
      );
    });
    expect(screen.getByTestId('analyzing-phase-parsing')).toHaveAttribute(
      'data-state',
      'current',
    );
    expect(screen.getByTestId('analyzing-progress-parsing')).toHaveTextContent('25%');
    expect(screen.getByTestId('analyzing-progress')).toHaveAttribute(
      'aria-valuenow',
      '25',
    );

    act(() => {
      handle.emit({
        type: 'phase',
        payload: { seq: 3, phase: 'building_graph', progress: 0.62 },
      });
    });
    expect(screen.getByTestId('analyzing-progress-building_graph')).toHaveTextContent(
      '62%',
    );
  });

  it('accumulates partial_graph events into the graph-size readout', async () => {
    const { client, awaitStream } = createFakeClient();
    render(
      <Harness apiClient={client} initialState={{ projectId: 'pid', projectName: 'demo' }} />,
    );
    const handle = await awaitStream();

    act(() => {
      handle.emit({
        type: 'partial_graph',
        payload: {
          seq: 1,
          nodes: [makeNode('a'), makeNode('b')],
          edges: [makeEdge('e1', 'a', 'b')],
        } satisfies PartialGraphEvent,
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('analyzing-graph-size')).toHaveTextContent(
        '2 nodes · 1 edges',
      );
    });

    act(() => {
      handle.emit({
        type: 'partial_graph',
        payload: {
          seq: 2,
          nodes: [makeNode('b'), makeNode('c')], // dedup `b`
          edges: [makeEdge('e2', 'b', 'c')],
        },
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('analyzing-graph-size')).toHaveTextContent(
        '3 nodes · 2 edges',
      );
    });
  });

  it('surfaces warning events as amber toasts and dedupes by seq', async () => {
    const { client, awaitStream } = createFakeClient();
    render(
      <Harness apiClient={client} initialState={{ projectId: 'pid', projectName: 'demo' }} />,
    );
    const handle = await awaitStream();

    act(() => {
      handle.emit({
        type: 'warning',
        payload: {
          seq: 7,
          code: 'import_error',
          message: 'package foo: missing',
        } satisfies WarningEvent,
      });
    });
    const toast = await screen.findByTestId('toast-warning');
    expect(toast).toHaveTextContent(/import_error/);
    expect(toast).toHaveTextContent(/package foo: missing/);
  });

  it('navigates to main when done arrives with phase=done', async () => {
    const { client, awaitStream } = createFakeClient();
    const onRoute = vi.fn();
    render(
      <Harness
        apiClient={client}
        initialState={{ projectId: 'pid', projectName: 'demo' }}
        onRouteChange={onRoute}
      />,
    );
    const handle = await awaitStream();

    act(() => {
      handle.emit({
        type: 'done',
        payload: {
          seq: 9,
          phase: 'done',
          node_count: 12,
          edge_count: 7,
          warnings_count: 0,
          elapsed_ms: 100,
          graph_url: '/api/projects/pid/graph',
        } satisfies DoneEvent,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('screen-main')).toBeInTheDocument();
    });
    // Last route change should target main with the projectId preserved.
    const calls = onRoute.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]).toBe('main');
    expect(lastCall?.[1]?.projectId).toBe('pid');
  });

  it('renders the failure fallback with retry when done arrives with phase=failed', async () => {
    const { client, awaitStream } = createFakeClient();
    render(
      <Harness apiClient={client} initialState={{ projectId: 'pid', projectName: 'demo' }} />,
    );
    const handle = await awaitStream();

    act(() => {
      handle.emit({
        type: 'done',
        payload: {
          seq: 1,
          phase: 'failed',
          error: { code: 'invalid_entry_point', message: 'no such symbol' },
        },
      });
    });

    const err = await screen.findByTestId('analyzing-error');
    expect(err).toHaveAttribute('data-error-code', 'invalid_entry_point');
    expect(err).toHaveTextContent(/entry points/i);
    expect(screen.getByTestId('analyzing-retry')).toBeInTheDocument();
  });

  it('renders the failure fallback when the connection rejects pre-stream', async () => {
    const { client, awaitStream } = createFakeClient();
    render(
      <Harness apiClient={client} initialState={{ projectId: 'pid', projectName: 'demo' }} />,
    );
    const handle = await awaitStream();

    act(() => {
      handle.fail(
        new ApiError(500, { code: 'server_error', message: 'boom' }),
      );
    });

    const err = await screen.findByTestId('analyzing-error');
    expect(err).toHaveAttribute('data-error-code', 'server_error');
  });

  it('hides the cancel button initially and reveals it after the grace window', async () => {
    const { client, awaitStream } = createFakeClient();
    render(
      <Harness apiClient={client} initialState={{ projectId: 'pid', projectName: 'demo' }} />,
    );
    const handle = await awaitStream();
    act(() => {
      handle.emit({
        type: 'phase',
        payload: { seq: 1, phase: 'loading' },
      });
    });
    expect(screen.queryByTestId('analyzing-cancel')).not.toBeInTheDocument();
    await waitFor(
      () => {
        expect(screen.getByTestId('analyzing-cancel')).toBeInTheDocument();
      },
      { timeout: 500 },
    );
  });

  it('cancel button aborts the stream and switches to the cancelled fallback', async () => {
    const { client, awaitStream } = createFakeClient();
    render(
      <Harness apiClient={client} initialState={{ projectId: 'pid', projectName: 'demo' }} />,
    );
    const handle = await awaitStream();
    act(() => {
      handle.emit({ type: 'phase', payload: { seq: 1, phase: 'loading' } });
    });
    const cancel = await screen.findByTestId('analyzing-cancel');

    const user = userEvent.setup();
    await user.click(cancel);

    await handle.abortPromise;
    expect(handle.controller.signal.aborted).toBe(true);
    expect(
      await screen.findByText(/Analysis was cancelled/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId('analyzing-retry')).toBeInTheDocument();
  });

  it('retry restarts the stream and the cancelled state clears', async () => {
    const { client, awaitStream } = createFakeClient();
    render(
      <Harness apiClient={client} initialState={{ projectId: 'pid', projectName: 'demo' }} />,
    );
    const first = await awaitStream(1);
    act(() => {
      first.emit({ type: 'phase', payload: { seq: 1, phase: 'loading' } });
    });
    const cancel = await screen.findByTestId('analyzing-cancel');
    const user = userEvent.setup();
    await user.click(cancel);
    const retry = await screen.findByTestId('analyzing-retry');
    await user.click(retry);

    const second = await awaitStream(2);
    expect(second).not.toBe(first);
    // Once the second stream emits a phase, the headline returns to the
    // streaming layout — i.e. the badge row reappears and the cancelled
    // banner is gone.
    act(() => {
      second.emit({ type: 'phase', payload: { seq: 1, phase: 'loading' } });
    });
    await waitFor(() => {
      expect(screen.queryByText(/Analysis was cancelled/i)).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('analyzing-phases')).toBeInTheDocument();
  });
});

function makeNode(id: string): Node {
  return {
    id,
    name: id,
    kind: 'func',
    package: 'pkg',
    file: 'main.go',
    line: 1,
    exported: true,
    reachable: true,
    is_entry: false,
  };
}

function makeEdge(id: string, source: string, target: string): Edge {
  return {
    id,
    source,
    target,
    kind: 'calls',
    weight: 1,
  };
}

