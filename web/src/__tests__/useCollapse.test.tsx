/**
 * `useCollapse` hook tests.
 *
 * Spins up a real Cytoscape instance in the null-renderer mode (the same
 * trick `GraphCanvas.test.tsx` uses) so the BFS over outgoing edges runs
 * against a live graph model without ever touching a 2D context.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import cytoscape, { type Core } from 'cytoscape';

import {
  COLLAPSED_HIDDEN_CLASS,
  COLLAPSED_ROOT_CLASS,
  useCollapse,
} from '../pages/Main/useCollapse';

function buildCy(): Core {
  return cytoscape({
    elements: [
      { group: 'nodes', data: { id: 'root' } },
      { group: 'nodes', data: { id: 'child-a' } },
      { group: 'nodes', data: { id: 'child-b' } },
      { group: 'nodes', data: { id: 'grandchild' } },
      { group: 'nodes', data: { id: 'sibling' } },
      { group: 'edges', data: { id: 'e1', source: 'root', target: 'child-a', kind: 'calls' } },
      { group: 'edges', data: { id: 'e2', source: 'root', target: 'child-b', kind: 'contains' } },
      { group: 'edges', data: { id: 'e3', source: 'child-a', target: 'grandchild', kind: 'calls' } },
      { group: 'edges', data: { id: 'e4', source: 'sibling', target: 'root', kind: 'calls' } },
    ],
    headless: true,
    styleEnabled: false,
  });
}

describe('useCollapse', () => {
  let cy: Core;

  beforeEach(() => {
    window.localStorage.clear();
    cy = buildCy();
  });

  afterEach(() => {
    cy.destroy();
  });

  it('starts with an empty collapsed set', () => {
    const { result } = renderHook(() => useCollapse(cy, 'p1'));
    expect(result.current.collapsedIds.size).toBe(0);
  });

  it('hides every reachable descendant when a root is collapsed', () => {
    const { result } = renderHook(() => useCollapse(cy, 'p1'));
    act(() => {
      result.current.collapse('root');
    });
    expect(result.current.collapsedIds.has('root')).toBe(true);
    expect(cy.$id('child-a').hasClass(COLLAPSED_HIDDEN_CLASS)).toBe(true);
    expect(cy.$id('child-b').hasClass(COLLAPSED_HIDDEN_CLASS)).toBe(true);
    expect(cy.$id('grandchild').hasClass(COLLAPSED_HIDDEN_CLASS)).toBe(true);
    // The root itself is not hidden — only its descendants.
    expect(cy.$id('root').hasClass(COLLAPSED_HIDDEN_CLASS)).toBe(false);
    expect(cy.$id('root').hasClass(COLLAPSED_ROOT_CLASS)).toBe(true);
    // Sibling lives off the upstream path; should remain visible.
    expect(cy.$id('sibling').hasClass(COLLAPSED_HIDDEN_CLASS)).toBe(false);
  });

  it('restores descendants on expand', () => {
    const { result } = renderHook(() => useCollapse(cy, 'p1'));
    act(() => {
      result.current.collapse('root');
    });
    act(() => {
      result.current.expand('root');
    });
    expect(result.current.collapsedIds.size).toBe(0);
    expect(cy.$id('child-a').hasClass(COLLAPSED_HIDDEN_CLASS)).toBe(false);
    expect(cy.$id('child-b').hasClass(COLLAPSED_HIDDEN_CLASS)).toBe(false);
    expect(cy.$id('grandchild').hasClass(COLLAPSED_HIDDEN_CLASS)).toBe(false);
    expect(cy.$id('root').hasClass(COLLAPSED_ROOT_CLASS)).toBe(false);
  });

  it('toggle flips the collapsed state idempotently', () => {
    const { result } = renderHook(() => useCollapse(cy, 'p1'));
    act(() => {
      result.current.toggle('child-a');
    });
    expect(result.current.collapsedIds.has('child-a')).toBe(true);
    act(() => {
      result.current.toggle('child-a');
    });
    expect(result.current.collapsedIds.has('child-a')).toBe(false);
  });

  it('persists the collapsed set to localStorage', () => {
    const { result } = renderHook(() => useCollapse(cy, 'project-x'));
    act(() => {
      result.current.collapse('root');
    });
    const raw = window.localStorage.getItem('go-viz:project-x:collapsed');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as { v: number; ids: string[] };
    expect(parsed.ids).toContain('root');
  });

  it('expandAll empties the set in a single update', () => {
    const { result } = renderHook(() => useCollapse(cy, 'p1'));
    act(() => {
      result.current.collapse('root');
      result.current.collapse('child-a');
    });
    expect(result.current.collapsedIds.size).toBeGreaterThanOrEqual(1);
    act(() => {
      result.current.expandAll();
    });
    expect(result.current.collapsedIds.size).toBe(0);
  });
});
