/**
 * GraphCanvas component tests.
 *
 * Cytoscape ships a canvas renderer that depends on
 * `HTMLCanvasElement.getContext('2d')`, which jsdom intentionally does not
 * implement. Tests opt into Cytoscape's `renderer: { name: 'null' }` to keep
 * the data layer (elements, classes, events, positions) live without ever
 * touching a 2D context. The tooltip and accessibility attributes are
 * verified through Testing Library because they live in plain DOM.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { Graph } from '../api/types';
import { GraphCanvas, type GraphCanvasProps } from '../pages/Main/GraphCanvas';
import type { ThemeTokens } from '../pages/Main/graph-styles';

const THEME: ThemeTokens = {
  fg: '#0f172a',
  fgMuted: '#475569',
  bg: '#ffffff',
  bgElevated: '#f8fafc',
  accent: '#3b82f6',
  border: '#cbd5f5',
};

const FIXTURE_GRAPH: Graph = {
  project_id: 'p-test',
  generated_at: '2026-04-19T10:00:00Z',
  aggregation: 'none',
  stats: {
    node_count: 3,
    edge_count: 2,
    by_kind: { func: 2, struct: 1 },
    dead_count: 1,
  },
  nodes: [
    {
      id: 'n-main',
      name: 'main',
      kind: 'func',
      package: 'cmd',
      file: 'cmd/main.go',
      line: 1,
      exported: false,
      reachable: true,
      is_entry: true,
    },
    {
      id: 'n-handler',
      name: 'Handler',
      kind: 'struct',
      package: 'api',
      file: 'api/handler.go',
      line: 12,
      exported: true,
      reachable: true,
      is_entry: false,
    },
    {
      id: 'n-dead',
      name: 'unused',
      kind: 'func',
      package: 'util',
      file: 'util/unused.go',
      line: 7,
      exported: false,
      reachable: false,
      is_entry: false,
    },
  ],
  edges: [
    { id: 'e-1', source: 'n-main', target: 'n-handler', kind: 'calls', weight: 1 },
    { id: 'e-2', source: 'n-handler', target: 'n-dead', kind: 'references', weight: 1 },
  ],
  warnings: [],
};

interface CytoscapeProbe {
  $id: (id: string) => {
    emit: (name: string) => void;
    nonempty: () => boolean;
    empty: () => boolean;
    hasClass: (name: string) => boolean;
  };
  fit: (...args: unknown[]) => void;
  destroy: () => void;
}

function readCy(): CytoscapeProbe {
  const container = screen.getByTestId('graph-canvas') as HTMLElement & {
    _cyreg?: { cy?: CytoscapeProbe };
  };
  const cy = container._cyreg?.cy;
  if (cy === undefined) {
    throw new Error('Cytoscape instance not registered on container');
  }
  return cy;
}

function renderCanvas(overrides: Partial<GraphCanvasProps> = {}): void {
  const props: GraphCanvasProps = {
    graph: FIXTURE_GRAPH,
    theme: THEME,
    projectId: 'p-test',
    reducedMotion: true,
    rendererOverride: { name: 'null' },
    ...overrides,
  };
  render(<GraphCanvas {...props} />);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('<GraphCanvas />', () => {
  it('renders the application landmark with an aria label', () => {
    renderCanvas({ graph: null });
    const canvas = screen.getByTestId('graph-canvas');
    expect(canvas).toHaveAttribute('role', 'application');
    expect(canvas).toHaveAttribute('aria-label', 'Dependency graph');
    expect(canvas).toHaveAttribute('tabindex', '0');
  });

  it('updates the aria label with node and edge counts', () => {
    renderCanvas();
    const canvas = screen.getByTestId('graph-canvas');
    expect(canvas.getAttribute('aria-label')).toContain('3 nodes');
    expect(canvas.getAttribute('aria-label')).toContain('2 edges');
  });

  it('shows the empty state when the graph has zero nodes', () => {
    const empty: Graph = { ...FIXTURE_GRAPH, nodes: [], edges: [] };
    renderCanvas({ graph: empty });
    expect(screen.getByTestId('graph-canvas-empty')).toBeInTheDocument();
  });

  it('mounts a Cytoscape instance and registers the supplied nodes', async () => {
    renderCanvas();
    await waitFor(() => {
      expect(readCy().$id('n-main').nonempty()).toBe(true);
    });
    expect(readCy().$id('n-handler').nonempty()).toBe(true);
    expect(readCy().$id('n-dead').nonempty()).toBe(true);
  });

  it('marks unreachable nodes with .dead and entry nodes with .entry', async () => {
    renderCanvas();
    await waitFor(() => {
      expect(readCy().$id('n-dead').nonempty()).toBe(true);
    });
    expect(readCy().$id('n-dead').hasClass('dead')).toBe(true);
    expect(readCy().$id('n-handler').hasClass('dead')).toBe(false);
    expect(readCy().$id('n-main').hasClass('entry')).toBe(true);
    expect(readCy().$id('n-handler').hasClass('entry')).toBe(false);
  });

  it('invokes onSelectNode when a node tap fires', async () => {
    const onSelect = vi.fn<(id: string | null) => void>();
    renderCanvas({ onSelectNode: onSelect });
    await waitFor(() => {
      expect(readCy().$id('n-main').nonempty()).toBe(true);
    });
    act(() => {
      readCy().$id('n-main').emit('tap');
    });
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith('n-main');
    });
  });

  it('shows the hover tooltip after a 300 ms dwell', async () => {
    renderCanvas();
    await waitFor(() => {
      expect(readCy().$id('n-handler').nonempty()).toBe(true);
    });
    vi.useFakeTimers();
    try {
      act(() => {
        readCy().$id('n-handler').emit('mouseover');
      });
      expect(screen.queryByTestId('graph-tooltip')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(310);
      });
      // Switch back to real timers so React's microtask flush works.
      vi.useRealTimers();
      await waitFor(() => {
        expect(screen.getByTestId('graph-tooltip-name')).toHaveTextContent('Handler');
      });
      expect(screen.getByTestId('graph-tooltip-package')).toHaveTextContent('api');
      expect(screen.getByTestId('graph-tooltip-file')).toHaveTextContent(
        'api/handler.go:12',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('fits the graph when the f hotkey is pressed', async () => {
    renderCanvas();
    await waitFor(() => {
      expect(readCy().$id('n-main').nonempty()).toBe(true);
    });
    const fitSpy = vi.spyOn(readCy(), 'fit');
    fireEvent.keyDown(screen.getByTestId('graph-canvas'), { key: 'f' });
    expect(fitSpy).toHaveBeenCalled();
  });

  it('invokes onPinOverflow when entry count exceeds ENTRY_PIN_LIMIT', async () => {
    // Build a graph with 13 entry-marked nodes — one over the documented
    // pin limit — and assert the callback fires with the actual count. This
    // guards the demo contract requirement that the overflow surfaces as a
    // user-visible warning rather than a silent visual failure.
    const entries = Array.from({ length: 13 }, (_, i) => ({
      id: `n-entry-${String(i)}`,
      name: `entry${String(i)}`,
      kind: 'func' as const,
      package: 'cmd',
      file: 'cmd/main.go',
      line: i + 1,
      exported: false,
      reachable: true,
      is_entry: true,
    }));
    const overflowGraph: Graph = {
      ...FIXTURE_GRAPH,
      nodes: entries,
      edges: [],
      stats: { ...FIXTURE_GRAPH.stats, node_count: entries.length, edge_count: 0 },
    };
    const onPinOverflow = vi.fn<(n: number, limit: number) => void>();
    renderCanvas({ graph: overflowGraph, onPinOverflow });
    await waitFor(() => {
      expect(onPinOverflow).toHaveBeenCalledWith(13, 12);
    });
  });
});
