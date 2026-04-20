/**
 * Hook-level tests for `useGraphData`. The Graph endpoint is exercised
 * end-to-end in the GraphCanvas suite; here we cover the lifecycle states
 * and the `refresh` trigger in isolation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { ApiClient, ApiError } from '../api/client';
import type { Graph } from '../api/types';
import { useGraphData } from '../pages/Main/useGraphData';

const SAMPLE_GRAPH: Graph = {
  project_id: 'p1',
  generated_at: '2026-04-19T10:00:00Z',
  aggregation: 'none',
  stats: { node_count: 1, edge_count: 0, by_kind: { func: 1 }, dead_count: 0 },
  nodes: [
    {
      id: 'n1',
      name: 'main',
      kind: 'func',
      package: 'main',
      file: 'main.go',
      line: 1,
      exported: true,
      reachable: true,
      is_entry: true,
    },
  ],
  edges: [],
  warnings: [],
};

function makeClient(graph: Graph): ApiClient {
  const client = new ApiClient();
  vi.spyOn(client, 'getGraph').mockResolvedValue(graph);
  return client;
}

function makeFailingClient(error: ApiError): ApiClient {
  const client = new ApiClient();
  vi.spyOn(client, 'getGraph').mockRejectedValue(error);
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useGraphData', () => {
  it('starts in idle when no projectId is provided', () => {
    const client = new ApiClient();
    const { result } = renderHook(() => useGraphData({ apiClient: client, projectId: undefined }));
    expect(result.current.state.status).toBe('idle');
  });

  it('transitions loading -> ready on a successful fetch', async () => {
    const client = makeClient(SAMPLE_GRAPH);
    const { result } = renderHook(() => useGraphData({ apiClient: client, projectId: 'p1' }));
    expect(['loading', 'idle']).toContain(result.current.state.status);
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });
    if (result.current.state.status === 'ready') {
      expect(result.current.state.graph.project_id).toBe('p1');
    }
  });

  it('transitions to error on a rejected fetch', async () => {
    const client = makeFailingClient(
      new ApiError(404, { code: 'project_not_found', message: 'gone' }),
    );
    const { result } = renderHook(() => useGraphData({ apiClient: client, projectId: 'p1' }));
    await waitFor(() => {
      expect(result.current.state.status).toBe('error');
    });
    if (result.current.state.status === 'error') {
      expect(result.current.state.error.code).toBe('project_not_found');
    }
  });

  it('refresh() re-runs the fetch', async () => {
    const client = makeClient(SAMPLE_GRAPH);
    const spy = client.getGraph as unknown as ReturnType<typeof vi.fn>;
    const { result } = renderHook(() => useGraphData({ apiClient: client, projectId: 'p1' }));
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });
    expect(spy).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
