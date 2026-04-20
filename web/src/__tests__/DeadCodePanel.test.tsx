/**
 * Component tests for the right-rail Dead-code panel (T23).
 *
 * Verifies the report fetch lifecycle (loading -> ready / empty / error),
 * the formatted row content, the export buttons, and the row click
 * behaviour that delegates to a Cytoscape `cy.center` + onSelectNode call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError, type ApiClient } from '../api/client';
import type { DeadCodeReport, Graph } from '../api/types';
import { DeadCodePanel } from '../pages/Main/panels/DeadCodePanel';

function buildGraph(): Graph {
  return {
    project_id: 'pid',
    generated_at: '2026-04-19T00:00:00Z',
    aggregation: 'none',
    stats: { node_count: 2, edge_count: 0, by_kind: {}, dead_count: 2 },
    nodes: [
      {
        id: 'hashed-mongo-close',
        name: 'Close',
        kind: 'method',
        package: 'github.com/acme/store',
        file: 'store/mongo.go',
        line: 128,
        exported: true,
        reachable: false,
        is_entry: false,
      },
      {
        id: 'hashed-helper',
        name: 'DeprecatedHelper',
        kind: 'func',
        package: 'github.com/acme/util',
        file: 'internal/util/helper.go',
        line: 42,
        exported: true,
        reachable: false,
        is_entry: false,
      },
    ],
    edges: [],
    warnings: [],
  };
}

function buildReport(overrides: Partial<DeadCodeReport> = {}): DeadCodeReport {
  return {
    project_id: 'pid',
    generated_at: '2026-04-19T00:00:00Z',
    entries_count: 2,
    entries: [
      {
        kind: 'method',
        fqn: 'github.com/acme/store#MongoStore.Close',
        file: 'store/mongo.go',
        line: 128,
        package: 'github.com/acme/store',
        name: 'Close',
        reason: 'unreachable',
      },
      {
        kind: 'func',
        fqn: 'github.com/acme/util#DeprecatedHelper',
        file: 'internal/util/helper.go',
        line: 42,
        package: 'github.com/acme/util',
        name: 'DeprecatedHelper',
        reason: 'unreachable',
      },
    ],
    ...overrides,
  };
}

interface FakeCyOptions {
  selector?: string;
  centerSpy?: ReturnType<typeof vi.fn>;
  empty?: boolean;
}

interface FakeCy {
  $id: ReturnType<typeof vi.fn>;
  center: ReturnType<typeof vi.fn>;
}

function makeFakeCy(opts: FakeCyOptions = {}): FakeCy {
  const center = opts.centerSpy ?? vi.fn();
  const collection = {
    empty: () => opts.empty === true,
    nonempty: () => opts.empty !== true,
  };
  return {
    $id: vi.fn(() => collection),
    center,
  };
}

function makeApiClient(opts: {
  jsonImpl?: () => Promise<DeadCodeReport>;
  txtImpl?: () => Promise<string>;
}): {
  client: ApiClient;
  jsonSpy: ReturnType<typeof vi.fn>;
  txtSpy: ReturnType<typeof vi.fn>;
} {
  const jsonSpy = vi.fn(opts.jsonImpl ?? (() => Promise.resolve(buildReport())));
  const txtSpy = vi.fn(opts.txtImpl ?? (() => Promise.resolve('')));
  // Stub the bare minimum surface DeadCodePanel touches.
  const client = {
    getDeadCode: vi.fn((_id: string, format: 'json' | 'txt') => {
      return format === 'json' ? jsonSpy() : txtSpy();
    }),
  } as unknown as ApiClient;
  return { client, jsonSpy, txtSpy };
}

describe('<DeadCodePanel />', () => {
  beforeEach(() => {
    vi.useRealTimers();
    // Stub URL.createObjectURL / revokeObjectURL because jsdom omits them.
    if (typeof URL.createObjectURL !== 'function') {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: vi.fn(() => 'blob:mock'),
      });
    } else {
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    }
    if (typeof URL.revokeObjectURL !== 'function') {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: vi.fn(),
      });
    } else {
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the idle state when no project id is provided', () => {
    const { client } = makeApiClient({});
    render(
      <DeadCodePanel
        apiClient={client}
        projectId={undefined}
        projectName=""
        refreshKey={0}
        cy={null}
        graph={null}
      />,
    );
    expect(screen.getByTestId('dead-panel-idle')).toBeInTheDocument();
  });

  it('shows a skeleton while loading', () => {
    let resolve: (r: DeadCodeReport) => void = () => {};
    const { client } = makeApiClient({
      jsonImpl: () => new Promise<DeadCodeReport>((r) => { resolve = r; }),
    });
    render(
      <DeadCodePanel
        apiClient={client}
        projectId="pid"
        projectName="demo"
        refreshKey={0}
        cy={null}
        graph={null}
      />,
    );
    expect(screen.getByTestId('dead-panel-loading')).toBeInTheDocument();
    resolve(buildReport({ entries_count: 0, entries: [] }));
  });

  it('renders the entries with kind, fqn and file:line', async () => {
    const { client } = makeApiClient({});
    render(
      <DeadCodePanel
        apiClient={client}
        projectId="pid"
        projectName="demo"
        refreshKey={0}
        cy={null}
        graph={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('dead-panel-list')).toBeInTheDocument();
    });
    expect(screen.getByTestId('dead-panel-count')).toHaveTextContent('(2)');
    const row = screen.getByTestId(
      'dead-panel-row-github.com/acme/store#MongoStore.Close',
    );
    expect(row).toHaveTextContent('method');
    expect(row).toHaveTextContent('github.com/acme/store#MongoStore.Close');
    expect(row).toHaveTextContent('store/mongo.go:128');
  });

  it('shows the empty 🎉 message when there are no dead entries', async () => {
    const { client } = makeApiClient({
      jsonImpl: () => Promise.resolve(buildReport({ entries_count: 0, entries: [] })),
    });
    render(
      <DeadCodePanel
        apiClient={client}
        projectId="pid"
        projectName="demo"
        refreshKey={0}
        cy={null}
        graph={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('dead-panel-empty')).toHaveTextContent(
        'No dead code detected',
      );
    });
  });

  it('renders an inline error and a Retry button on a generic failure', async () => {
    const { client } = makeApiClient({
      jsonImpl: () => Promise.reject(new ApiError(500, { code: 'server_error', message: 'boom' })),
    });
    render(
      <DeadCodePanel
        apiClient={client}
        projectId="pid"
        projectName="demo"
        refreshKey={0}
        cy={null}
        graph={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('dead-panel-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('dead-panel-retry')).toBeInTheDocument();
  });

  it('hides the retry button when the error is no_graph_yet', async () => {
    const { client } = makeApiClient({
      jsonImpl: () =>
        Promise.reject(new ApiError(404, { code: 'no_graph_yet', message: 'not yet' })),
    });
    render(
      <DeadCodePanel
        apiClient={client}
        projectId="pid"
        projectName="demo"
        refreshKey={0}
        cy={null}
        graph={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('dead-panel-error')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('dead-panel-retry')).toBeNull();
  });

  it('TXT export hits the API with the txt format', async () => {
    const { client, txtSpy } = makeApiClient({
      txtImpl: () => Promise.resolve('method github.com/acme/store#MongoStore.Close — store/mongo.go:128\n'),
    });
    render(
      <DeadCodePanel
        apiClient={client}
        projectId="pid"
        projectName="demo"
        refreshKey={0}
        cy={null}
        graph={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('dead-panel-list')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByTestId('dead-panel-export-txt'));
    await waitFor(() => {
      expect(txtSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('JSON export re-fetches the json report and triggers a download', async () => {
    const { client, jsonSpy } = makeApiClient({});
    render(
      <DeadCodePanel
        apiClient={client}
        projectId="pid"
        projectName="demo"
        refreshKey={0}
        cy={null}
        graph={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('dead-panel-list')).toBeInTheDocument();
    });
    expect(jsonSpy).toHaveBeenCalledTimes(1); // initial fetch
    await userEvent.click(screen.getByTestId('dead-panel-export-json'));
    await waitFor(() => {
      // initial fetch + download fetch
      expect(jsonSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('row click centres the cy viewport on the matching node', async () => {
    const { client } = makeApiClient({});
    const fakeCy = makeFakeCy();
    const onSelect = vi.fn();
    render(
      <DeadCodePanel
        apiClient={client}
        projectId="pid"
        projectName="demo"
        refreshKey={0}
        cy={fakeCy as unknown as Parameters<typeof DeadCodePanel>[0]['cy']}
        graph={buildGraph()}
        onSelectNode={onSelect}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('dead-panel-list')).toBeInTheDocument();
    });
    await userEvent.click(
      screen.getByTestId('dead-panel-row-github.com/acme/store#MongoStore.Close'),
    );
    expect(fakeCy.$id).toHaveBeenCalledWith('hashed-mongo-close');
    expect(fakeCy.center).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('hashed-mongo-close');
  });

  it('row click is a no-op when the node is not in the cy core', async () => {
    const { client } = makeApiClient({});
    const fakeCy = makeFakeCy({ empty: true });
    const onSelect = vi.fn();
    render(
      <DeadCodePanel
        apiClient={client}
        projectId="pid"
        projectName="demo"
        refreshKey={0}
        cy={fakeCy as unknown as Parameters<typeof DeadCodePanel>[0]['cy']}
        graph={buildGraph()}
        onSelectNode={onSelect}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('dead-panel-list')).toBeInTheDocument();
    });
    await userEvent.click(
      screen.getByTestId('dead-panel-row-github.com/acme/store#MongoStore.Close'),
    );
    expect(fakeCy.center).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('row click is a no-op when the entry is not in the graph snapshot', async () => {
    const { client } = makeApiClient({});
    const fakeCy = makeFakeCy();
    const onSelect = vi.fn();
    render(
      <DeadCodePanel
        apiClient={client}
        projectId="pid"
        projectName="demo"
        refreshKey={0}
        cy={fakeCy as unknown as Parameters<typeof DeadCodePanel>[0]['cy']}
        graph={null}
        onSelectNode={onSelect}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('dead-panel-list')).toBeInTheDocument();
    });
    await userEvent.click(
      screen.getByTestId('dead-panel-row-github.com/acme/store#MongoStore.Close'),
    );
    expect(fakeCy.center).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('refetches when refreshKey changes', async () => {
    const { client, jsonSpy } = makeApiClient({});
    const { rerender } = render(
      <DeadCodePanel
        apiClient={client}
        projectId="pid"
        projectName="demo"
        refreshKey={0}
        cy={null}
        graph={null}
      />,
    );
    await waitFor(() => {
      expect(jsonSpy).toHaveBeenCalledTimes(1);
    });
    rerender(
      <DeadCodePanel
        apiClient={client}
        projectId="pid"
        projectName="demo"
        refreshKey={1}
        cy={null}
        graph={null}
      />,
    );
    await waitFor(() => {
      expect(jsonSpy).toHaveBeenCalledTimes(2);
    });
  });
});
