/**
 * Unit tests for the aggregation-expand hook (T24, FR-18).
 *
 * Drives the hook against a real (null-renderer) Cytoscape core seeded with
 * a couple of aggregated package nodes. The `apiClient.getGraph` call is
 * stubbed to return a fixture sub-graph so we can verify that the hook
 * swaps the package node out for its children and tracks the expanded set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import cytoscape, { type Core } from 'cytoscape';

import { ApiError, type ApiClient } from '../api/client';
import type { Graph } from '../api/types';
import { useAggregateExpand } from '../pages/Main/useAggregateExpand';

function buildAggregatedCore(): Core {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const options = {
    container,
    renderer: { name: 'null' },
    elements: [
      {
        group: 'nodes',
        data: {
          id: 'pkg-a',
          name: 'a',
          kind: 'package',
          package: 'example.com/a',
          file: '',
          line: 0,
          exported: true,
          reachable: true,
          is_entry: false,
          child_count: 5,
        },
      },
      {
        group: 'nodes',
        data: {
          id: 'pkg-b',
          name: 'b',
          kind: 'package',
          package: 'example.com/b',
          file: '',
          line: 0,
          exported: true,
          reachable: true,
          is_entry: false,
          child_count: 3,
        },
      },
      {
        group: 'edges',
        data: {
          id: 'e-a-b',
          source: 'pkg-a',
          target: 'pkg-b',
          kind: 'imports',
          weight: 1,
        },
      },
    ],
  };
  return cytoscape(options as unknown as cytoscape.CytoscapeOptions);
}

function detailGraph(pkg: string): Graph {
  return {
    project_id: 'pid',
    generated_at: '2026-04-19T00:00:00Z',
    aggregation: 'none',
    stats: { node_count: 2, edge_count: 1, by_kind: { func: 2 }, dead_count: 0 },
    nodes: [
      {
        id: `${pkg}-fn1`,
        name: 'Foo',
        kind: 'func',
        package: pkg,
        file: 'foo.go',
        line: 1,
        exported: true,
        reachable: true,
        is_entry: false,
      },
      {
        id: `${pkg}-fn2`,
        name: 'Bar',
        kind: 'func',
        package: pkg,
        file: 'bar.go',
        line: 1,
        exported: true,
        reachable: true,
        is_entry: false,
      },
    ],
    edges: [
      {
        id: `${pkg}-e1`,
        source: `${pkg}-fn1`,
        target: `${pkg}-fn2`,
        kind: 'calls',
        weight: 1,
      },
    ],
    warnings: [],
  };
}

function makeApiClient(impl: (id: string, opts: { scope?: string }) => Promise<Graph>): {
  client: ApiClient;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(impl);
  const client = { getGraph: spy } as unknown as ApiClient;
  return { client, spy };
}

describe('useAggregateExpand', () => {
  let cy: Core;

  beforeEach(() => {
    cy = buildAggregatedCore();
  });

  afterEach(() => {
    cy.destroy();
  });

  it('starts with an empty expanded set', () => {
    const { client } = makeApiClient(() => Promise.resolve(detailGraph('example.com/a')));
    const { result } = renderHook(() =>
      useAggregateExpand({
        apiClient: client,
        projectId: 'pid',
        cy,
        aggregation: 'package',
        reducedMotion: true,
      }),
    );
    expect(result.current.expandedPackages.size).toBe(0);
  });

  it('expands a package and removes the aggregated node', async () => {
    const { client, spy } = makeApiClient((_, opts) =>
      Promise.resolve(detailGraph(opts.scope ?? '')),
    );
    const { result } = renderHook(() =>
      useAggregateExpand({
        apiClient: client,
        projectId: 'pid',
        cy,
        aggregation: 'package',
        reducedMotion: true,
      }),
    );

    await act(async () => {
      await result.current.expand('example.com/a');
    });

    expect(spy).toHaveBeenCalledWith('pid', { scope: 'example.com/a' });
    expect(cy.$id('pkg-a').empty()).toBe(true);
    expect(cy.$id('example.com/a-fn1').nonempty()).toBe(true);
    expect(cy.$id('example.com/a-fn2').nonempty()).toBe(true);
    expect(cy.$id('example.com/a-e1').nonempty()).toBe(true);
    expect(result.current.expandedPackages.has('example.com/a')).toBe(true);
  });

  it('does nothing when the same package is expanded twice', async () => {
    const { client, spy } = makeApiClient((_, opts) =>
      Promise.resolve(detailGraph(opts.scope ?? '')),
    );
    const { result } = renderHook(() =>
      useAggregateExpand({
        apiClient: client,
        projectId: 'pid',
        cy,
        aggregation: 'package',
        reducedMotion: true,
      }),
    );

    await act(async () => {
      await result.current.expand('example.com/a');
    });
    await act(async () => {
      await result.current.expand('example.com/a');
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('surfaces invalid_scope errors via onError', async () => {
    const { client } = makeApiClient(() =>
      Promise.reject(
        new ApiError(400, { code: 'invalid_scope', message: 'bad scope' }),
      ),
    );
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useAggregateExpand({
        apiClient: client,
        projectId: 'pid',
        cy,
        aggregation: 'package',
        reducedMotion: true,
        onError,
      }),
    );

    await act(async () => {
      await result.current.expand('example.com/missing');
    });

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
    );
    expect(result.current.expandedPackages.size).toBe(0);
  });

  it('surfaces 5xx as a retryable failure message', async () => {
    const { client } = makeApiClient(() =>
      Promise.reject(new ApiError(500, { code: 'server_error', message: 'boom' })),
    );
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useAggregateExpand({
        apiClient: client,
        projectId: 'pid',
        cy,
        aggregation: 'package',
        reducedMotion: true,
        onError,
      }),
    );

    await act(async () => {
      await result.current.expand('example.com/a');
    });

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('please retry'),
    );
  });

  it('skips when aggregation is not package', async () => {
    const { client, spy } = makeApiClient((_, opts) =>
      Promise.resolve(detailGraph(opts.scope ?? '')),
    );
    const { result } = renderHook(() =>
      useAggregateExpand({
        apiClient: client,
        projectId: 'pid',
        cy,
        aggregation: 'none',
        reducedMotion: true,
      }),
    );

    await act(async () => {
      await result.current.expand('example.com/a');
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('respects the per-snapshot expand limit and surfaces an info message', async () => {
    const { client, spy } = makeApiClient((_, opts) =>
      Promise.resolve(detailGraph(opts.scope ?? '')),
    );
    const onInfo = vi.fn();
    const { result } = renderHook(() =>
      useAggregateExpand({
        apiClient: client,
        projectId: 'pid',
        cy,
        aggregation: 'package',
        reducedMotion: true,
        onInfo,
      }),
    );

    // Pre-populate the expanded set up to the limit.
    await act(async () => {
      await result.current.expand('example.com/a');
    });
    await act(async () => {
      await result.current.expand('example.com/b');
    });
    // Add a third aggregated node and try to push past the limit.
    cy.add({
      group: 'nodes',
      data: {
        id: 'pkg-c',
        name: 'c',
        kind: 'package',
        package: 'example.com/c',
        file: '',
        line: 0,
        exported: true,
        reachable: true,
        is_entry: false,
        child_count: 2,
      },
    });
    cy.add({
      group: 'nodes',
      data: {
        id: 'pkg-d',
        name: 'd',
        kind: 'package',
        package: 'example.com/d',
        file: '',
        line: 0,
        exported: true,
        reachable: true,
        is_entry: false,
        child_count: 1,
      },
    });
    await act(async () => {
      await result.current.expand('example.com/c');
    });

    const callCount = spy.mock.calls.length;
    await act(async () => {
      await result.current.expand('example.com/d');
    });
    expect(spy.mock.calls.length).toBe(callCount);
    expect(onInfo).toHaveBeenCalledWith(expect.stringContaining('Already expanded'));
  });
});
