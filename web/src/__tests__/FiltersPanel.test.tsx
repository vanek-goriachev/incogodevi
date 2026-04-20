/**
 * Unit tests for `<FiltersPanel />`.
 *
 * The panel is "controlled" by its parent: every interaction has to push a
 * new spec through `onChange`, never mutate state on the side. The tests
 * therefore drive the panel through props and assert the shape of the
 * dispatched spec — there is no Cytoscape involvement at this layer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { useState } from 'react';

import type { Graph } from '../api/types';
import { FIND_DEBOUNCE_MS, FiltersPanel } from '../pages/Main/panels/FiltersPanel';
import {
  defaultFilterSpec,
  type FilterSpec,
} from '../pages/Main/panels/filterSpec';

function makeGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    project_id: 'p1',
    generated_at: '2026-04-19T00:00:00Z',
    aggregation: 'none',
    stats: { node_count: 0, edge_count: 0, by_kind: {}, dead_count: 0 },
    nodes: [
      {
        id: 'pkg:api',
        name: 'api',
        kind: 'package',
        package: 'api',
        file: '',
        line: 0,
        exported: true,
        reachable: true,
        is_entry: false,
      },
      {
        id: 'fn:Handler',
        name: 'Handler',
        kind: 'func',
        package: 'api',
        file: 'api/handler.go',
        line: 12,
        exported: true,
        reachable: true,
        is_entry: false,
      },
      {
        id: 'st:Server',
        name: 'Server',
        kind: 'struct',
        package: 'api',
        file: 'api/server.go',
        line: 3,
        exported: true,
        reachable: true,
        is_entry: false,
      },
      {
        id: 'var:cfg',
        name: 'cfg',
        kind: 'var',
        package: 'config',
        file: 'config/config.go',
        line: 4,
        exported: false,
        reachable: true,
        is_entry: false,
      },
    ],
    edges: [],
    warnings: [],
    ...overrides,
  };
}

interface HarnessProps {
  graph: Graph | null;
  initial?: FilterSpec;
  onChangeSpy?: (spec: FilterSpec) => void;
}

function Harness({ graph, initial, onChangeSpy }: HarnessProps): JSX.Element {
  const [spec, setSpec] = useState<FilterSpec>(initial ?? defaultFilterSpec());
  return (
    <FiltersPanel
      graph={graph}
      value={spec}
      onChange={(next) => {
        setSpec(next);
        onChangeSpy?.(next);
      }}
    />
  );
}

describe('<FiltersPanel />', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders all eight node-kind toggles checked by default', () => {
    render(<Harness graph={makeGraph()} />);
    const expectedKinds = [
      'package',
      'struct',
      'interface',
      'func',
      'method',
      'field',
      'var',
      'const',
    ] as const;
    for (const kind of expectedKinds) {
      const row = screen.getByTestId(`filters-kind-${kind}`);
      const cb = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(cb).not.toBeNull();
      expect(cb.checked).toBe(true);
    }
  });

  it('disables checkboxes for kinds that are absent in the current graph', () => {
    render(<Harness graph={makeGraph()} />);
    const row = screen.getByTestId('filters-kind-method');
    const cb = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(cb.disabled).toBe(true);
    const fnRow = screen.getByTestId('filters-kind-func');
    const fnCb = fnRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(fnCb.disabled).toBe(false);
  });

  it('emits an updated spec when a kind toggle is flipped off', async () => {
    const spy = vi.fn<(spec: FilterSpec) => void>();
    render(<Harness graph={makeGraph()} onChangeSpy={spy} />);
    const cb = screen
      .getByTestId('filters-kind-func')
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    await userEvent.click(cb);
    expect(spy).toHaveBeenCalled();
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0];
    expect(last?.kinds.func).toBe(false);
    expect(last?.kinds.struct).toBe(true);
  });

  it('moves to subset mode when a single package is unchecked', async () => {
    const spy = vi.fn<(spec: FilterSpec) => void>();
    render(<Harness graph={makeGraph()} onChangeSpy={spy} />);
    const cb = screen.getByTestId('filters-package-api') as HTMLInputElement;
    await userEvent.click(cb);
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0];
    expect(last?.packages.mode).toBe('subset');
    // Started in 'all' mode (selected = []); unchecking 'api' must yield the
    // remaining packages explicitly so the spec is unambiguous on reload.
    expect(last?.packages.selected).toEqual(['config']);
  });

  it('collapses back to all-mode when every package is re-selected', async () => {
    const spy = vi.fn<(spec: FilterSpec) => void>();
    const initial: FilterSpec = {
      ...defaultFilterSpec(),
      packages: { mode: 'subset', selected: ['config'] },
    };
    render(<Harness graph={makeGraph()} initial={initial} onChangeSpy={spy} />);
    const cb = screen.getByTestId('filters-package-api') as HTMLInputElement;
    expect(cb.checked).toBe(false);
    await userEvent.click(cb);
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0];
    expect(last?.packages.mode).toBe('all');
    expect(last?.packages.selected).toEqual([]);
  });

  it('debounces find input changes by FIND_DEBOUNCE_MS', () => {
    vi.useFakeTimers();
    const spy = vi.fn<(spec: FilterSpec) => void>();
    render(<Harness graph={makeGraph()} onChangeSpy={spy} />);
    const find = screen.getByTestId('filters-find') as HTMLInputElement;
    act(() => {
      fireEvent.change(find, { target: { value: 'han' } });
    });
    expect(spy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(FIND_DEBOUNCE_MS + 5);
    });
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[spy.mock.calls.length - 1]?.[0].find).toBe('han');
  });

  it('clears the find query when Escape is pressed inside the input', async () => {
    const spy = vi.fn<(spec: FilterSpec) => void>();
    render(
      <Harness
        graph={makeGraph()}
        initial={{ ...defaultFilterSpec(), find: 'handler' }}
        onChangeSpy={spy}
      />,
    );
    const find = screen.getByTestId('filters-find') as HTMLInputElement;
    expect(find.value).toBe('handler');
    fireEvent.keyDown(find, { key: 'Escape' });
    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
    expect(spy.mock.calls[spy.mock.calls.length - 1]?.[0].find).toBe('');
    expect(find.value).toBe('');
  });

  it('focuses the find input when the global / hotkey fires', () => {
    render(<Harness graph={makeGraph()} />);
    const find = screen.getByTestId('filters-find') as HTMLInputElement;
    expect(document.activeElement).not.toBe(find);
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(find);
  });

  it('ignores the / hotkey when the user is typing in another input', () => {
    render(
      <div>
        <input data-testid="other-input" />
        <Harness graph={makeGraph()} />
      </div>,
    );
    const other = screen.getByTestId('other-input') as HTMLInputElement;
    other.focus();
    fireEvent.keyDown(other, { key: '/' });
    const find = screen.getByTestId('filters-find') as HTMLInputElement;
    expect(document.activeElement).toBe(other);
    expect(document.activeElement).not.toBe(find);
  });

  it('shows the package search input only past PACKAGE_SEARCH_THRESHOLD', () => {
    const big: Graph = makeGraph({
      nodes: Array.from({ length: 25 }, (_, i) => ({
        id: `n-${String(i)}`,
        name: `n-${String(i)}`,
        kind: 'func',
        package: `pkg-${String(i)}`,
        file: '',
        line: 0,
        exported: false,
        reachable: true,
        is_entry: false,
      })),
    });
    render(<Harness graph={big} />);
    expect(screen.getByTestId('filters-package-search')).toBeInTheDocument();
  });

  it('reset clears every panel-controlled field', async () => {
    const spy = vi.fn<(spec: FilterSpec) => void>();
    const initial: FilterSpec = {
      ...defaultFilterSpec(),
      kinds: { ...defaultFilterSpec().kinds, var: false },
      packages: { mode: 'subset', selected: ['api'] },
      find: 'handler',
    };
    render(<Harness graph={makeGraph()} initial={initial} onChangeSpy={spy} />);
    await userEvent.click(screen.getByTestId('filters-reset'));
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0];
    expect(last).toEqual(defaultFilterSpec());
  });
});
