/**
 * Tests for the bulk package-filter controls added to `<FiltersPanel />`
 * in feat/overlap-presets-package-filter.
 *
 * Covers:
 *   - substring matching is case-insensitive and path-agnostic (scattered
 *     mocks across folders all match the same filter),
 *   - the `/regex/` checkbox switches the matcher to a RegExp,
 *   - "Скрыть найденные" / "Показать найденные" flip the same
 *     `packages.selected` flags as the per-package checkboxes,
 *   - "Создать группу из фильтра" fires the parent callback with the
 *     longest common prefix (or the literal filter when no LCP exists),
 *   - pure helpers (`packagePathMatches`, `longestCommonPathPrefix`,
 *     `compilePackageRegex`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { useState } from 'react';

import type { Graph } from '../api/types';
import {
  FiltersPanel,
  compilePackageRegex,
  longestCommonPathPrefix,
  packagePathMatches,
} from '../pages/Main/panels/FiltersPanel';
import {
  defaultFilterSpec,
  type FilterSpec,
} from '../pages/Main/panels/filterSpec';

function makeGraphWithMocks(): Graph {
  return {
    project_id: 'p1',
    generated_at: '2026-05-12T00:00:00Z',
    aggregation: 'none',
    stats: { node_count: 0, edge_count: 0, by_kind: {}, dead_count: 0 },
    nodes: [
      {
        id: 'n1',
        name: 'A',
        kind: 'func',
        package: 'a/mocks/foo',
        file: '',
        line: 0,
        exported: false,
        reachable: true,
        is_entry: false,
      },
      {
        id: 'n2',
        name: 'B',
        kind: 'func',
        package: 'b/mocks/bar',
        file: '',
        line: 0,
        exported: false,
        reachable: true,
        is_entry: false,
      },
      {
        id: 'n3',
        name: 'C',
        kind: 'func',
        package: 'c/realimpl',
        file: '',
        line: 0,
        exported: false,
        reachable: true,
        is_entry: false,
      },
    ],
    edges: [],
    warnings: [],
  };
}

interface HarnessProps {
  initial?: FilterSpec;
  onChangeSpy?: (spec: FilterSpec) => void;
  onCreateGroupSpy?: (prefix: string) => void;
}

function Harness({
  initial,
  onChangeSpy,
  onCreateGroupSpy,
}: HarnessProps): JSX.Element {
  const [spec, setSpec] = useState<FilterSpec>(initial ?? defaultFilterSpec());
  // Always wire onCreateGroupFromFilter so the test toggles between an
  // observable spy and a no-op closure — never an `undefined` prop, which
  // exactOptionalPropertyTypes would reject.
  const onCreate = onCreateGroupSpy ?? ((_p: string) => {});
  return (
    <FiltersPanel
      graph={makeGraphWithMocks()}
      value={spec}
      onChange={(next) => {
        setSpec(next);
        onChangeSpy?.(next);
      }}
      onCreateGroupFromFilter={onCreate}
    />
  );
}

describe('packagePathMatches helper', () => {
  it('returns true for case-insensitive substring matches', () => {
    expect(packagePathMatches('a/Mocks/foo', 'mocks', false)).toBe(true);
    expect(packagePathMatches('a/realimpl', 'mocks', false)).toBe(false);
  });
  it('returns false on an empty needle', () => {
    expect(packagePathMatches('any/path', '', false)).toBe(false);
  });
  it('returns true for regex matches and false for non-matching', () => {
    const r = compilePackageRegex('^a/');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(packagePathMatches('a/mocks/foo', '^a/', true, r.regex)).toBe(true);
      expect(packagePathMatches('b/mocks/bar', '^a/', true, r.regex)).toBe(false);
    }
  });
});

describe('compilePackageRegex', () => {
  it('rejects an empty pattern', () => {
    const r = compilePackageRegex('');
    expect(r.ok).toBe(false);
  });
  it('rejects an invalid pattern with a useful error', () => {
    const r = compilePackageRegex('[invalid(');
    expect(r.ok).toBe(false);
  });
  it('accepts a valid pattern and compiles a case-insensitive regex', () => {
    const r = compilePackageRegex('mocks');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.regex.test('a/MOCKS/foo')).toBe(true);
    }
  });
});

describe('longestCommonPathPrefix', () => {
  it('returns the LCP of multiple paths, trimming trailing slashes', () => {
    expect(
      longestCommonPathPrefix(['a/mocks/foo', 'a/mocks/bar', 'a/mocks/baz']),
    ).toBe('a/mocks');
  });
  it('returns the single path when given one element', () => {
    expect(longestCommonPathPrefix(['a/mocks/foo'])).toBe('a/mocks/foo');
  });
  it('returns empty string when paths share no prefix', () => {
    expect(longestCommonPathPrefix(['a/x', 'b/y'])).toBe('');
  });
});

describe('<FiltersPanel /> bulk filter', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches scattered mocks across different folders by substring', async () => {
    render(<Harness />);
    const input = screen.getByTestId(
      'filters-package-bulk-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'mocks' } });
    expect(
      screen.getByTestId('filters-package-bulk-count').textContent ?? '',
    ).toContain('2');
    expect(
      screen.queryByTestId('filters-package-bulk-match-a/mocks/foo'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('filters-package-bulk-match-b/mocks/bar'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('filters-package-bulk-match-c/realimpl'),
    ).toBeNull();
  });

  it('regex mode honours the /<pattern>/ flag and surfaces parse errors', async () => {
    render(<Harness />);
    const cb = screen.getByTestId('filters-package-bulk-regex') as HTMLInputElement;
    fireEvent.click(cb);
    const input = screen.getByTestId(
      'filters-package-bulk-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '^a/' } });
    expect(
      screen.queryByTestId('filters-package-bulk-match-a/mocks/foo'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('filters-package-bulk-match-b/mocks/bar'),
    ).toBeNull();
    // Invalid regex → empty match list + red border via aria-invalid.
    fireEvent.change(input, { target: { value: '[unclosed(' } });
    expect(
      screen.queryByTestId('filters-package-bulk-match-a/mocks/foo'),
    ).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('Скрыть найденные flips per-package visibility for matched packages', async () => {
    const spy = vi.fn<(s: FilterSpec) => void>();
    render(<Harness onChangeSpy={spy} />);
    fireEvent.change(
      screen.getByTestId('filters-package-bulk-input') as HTMLInputElement,
      { target: { value: 'mocks' } },
    );
    const hideBtn = screen.getByTestId(
      'filters-package-bulk-hide',
    ) as HTMLButtonElement;
    expect(hideBtn.disabled).toBe(false);
    await userEvent.click(hideBtn);
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0];
    expect(last?.packages.mode).toBe('subset');
    // Only c/realimpl remains visible.
    expect(last?.packages.selected).toEqual(['c/realimpl']);
  });

  it('Создать группу из фильтра derives longest common prefix', async () => {
    const groupSpy = vi.fn<(prefix: string) => void>();
    render(<Harness onCreateGroupSpy={groupSpy} />);
    fireEvent.change(
      screen.getByTestId('filters-package-bulk-input') as HTMLInputElement,
      { target: { value: 'mocks' } },
    );
    await userEvent.click(screen.getByTestId('filters-package-bulk-group'));
    expect(groupSpy).toHaveBeenCalled();
    const prefix = groupSpy.mock.calls[0]?.[0] ?? '';
    // The two matches share no common segment beyond their leaf — LCP is
    // empty, so we fall back to the literal filter "mocks".
    expect(prefix).toBe('mocks');
  });
});
