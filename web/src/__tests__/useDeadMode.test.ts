/**
 * Unit tests for the dead-code display-mode hook.
 *
 * The hook itself is exercised through `applyDeadMode` (the synchronous
 * primitive) plus a thin React harness around `useDeadMode`. The harness is
 * deliberately minimal — multi-component integration with Cytoscape lives
 * in the panel and switcher tests where it is more meaningful.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import cytoscape, { type Core } from 'cytoscape';

import {
  DEAD_MODE_ORDER,
  DEFAULT_DEAD_MODE,
  HIDE_DEAD_CLASS,
  HIDE_LIVE_CLASS,
  applyDeadMode,
  useDeadMode,
} from '../pages/Main/useDeadMode';
import { projectKey } from '../storage/keys';

function buildCore(): Core {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const options = {
    container,
    renderer: { name: 'null' },
    elements: [
      { group: 'nodes', data: { id: 'a' } },
      { group: 'nodes', data: { id: 'b' }, classes: 'dead' },
      { group: 'nodes', data: { id: 'c' }, classes: 'dead' },
      { group: 'edges', data: { id: 'a-b', source: 'a', target: 'b' } },
      { group: 'edges', data: { id: 'b-c', source: 'b', target: 'c' } },
    ],
  };
  return cytoscape(options as unknown as cytoscape.CytoscapeOptions);
}

describe('applyDeadMode', () => {
  let cy: Core;

  beforeEach(() => {
    cy = buildCore();
  });

  afterEach(() => {
    cy.destroy();
  });

  it('strips both hide classes in live-dead', () => {
    cy.elements().addClass(HIDE_LIVE_CLASS);
    cy.elements().addClass(HIDE_DEAD_CLASS);
    applyDeadMode(cy, 'live-dead');
    expect(cy.elements(`.${HIDE_LIVE_CLASS}`).length).toBe(0);
    expect(cy.elements(`.${HIDE_DEAD_CLASS}`).length).toBe(0);
  });

  it('hides dead nodes and their incident edges in live-only', () => {
    applyDeadMode(cy, 'live-only');
    expect(cy.$id('b').hasClass(HIDE_DEAD_CLASS)).toBe(true);
    expect(cy.$id('c').hasClass(HIDE_DEAD_CLASS)).toBe(true);
    expect(cy.$id('a').hasClass(HIDE_DEAD_CLASS)).toBe(false);
    // a-b touches b (dead) -> hidden; b-c touches both dead -> hidden
    expect(cy.$id('a-b').hasClass(HIDE_DEAD_CLASS)).toBe(true);
    expect(cy.$id('b-c').hasClass(HIDE_DEAD_CLASS)).toBe(true);
  });

  it('hides live nodes and their incident edges in dead-only', () => {
    applyDeadMode(cy, 'dead-only');
    expect(cy.$id('a').hasClass(HIDE_LIVE_CLASS)).toBe(true);
    expect(cy.$id('b').hasClass(HIDE_LIVE_CLASS)).toBe(false);
    expect(cy.$id('c').hasClass(HIDE_LIVE_CLASS)).toBe(false);
    // a-b touches a (live) -> hidden; b-c touches no live -> not hidden
    expect(cy.$id('a-b').hasClass(HIDE_LIVE_CLASS)).toBe(true);
    expect(cy.$id('b-c').hasClass(HIDE_LIVE_CLASS)).toBe(false);
  });

  it('mirrors the mode onto the container data attribute', () => {
    applyDeadMode(cy, 'live-only');
    const container = cy.container();
    expect(container?.dataset['deadMode']).toBe('live-only');
    applyDeadMode(cy, 'dead-only');
    expect(container?.dataset['deadMode']).toBe('dead-only');
  });

  it('switching between modes does not leave stale classes', () => {
    applyDeadMode(cy, 'live-only');
    applyDeadMode(cy, 'dead-only');
    expect(cy.elements(`.${HIDE_DEAD_CLASS}`).length).toBe(0);
    applyDeadMode(cy, 'live-dead');
    expect(cy.elements(`.${HIDE_LIVE_CLASS}`).length).toBe(0);
    expect(cy.elements(`.${HIDE_DEAD_CLASS}`).length).toBe(0);
  });
});

describe('useDeadMode', () => {
  const projectId = 'pid-test';

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns the default mode when storage is empty', () => {
    const { result } = renderHook(() => useDeadMode(projectId, null));
    expect(result.current.mode).toBe(DEFAULT_DEAD_MODE);
  });

  it('reads the persisted mode from localStorage', () => {
    window.localStorage.setItem(
      projectKey(projectId, 'dead-mode'),
      JSON.stringify('dead-only'),
    );
    const { result } = renderHook(() => useDeadMode(projectId, null));
    expect(result.current.mode).toBe('dead-only');
  });

  it('persists setMode changes', () => {
    const { result } = renderHook(() => useDeadMode(projectId, null));
    act(() => {
      result.current.setMode('live-only');
    });
    expect(result.current.mode).toBe('live-only');
    expect(window.localStorage.getItem(projectKey(projectId, 'dead-mode'))).toBe(
      JSON.stringify('live-only'),
    );
  });

  it('cycle walks through the documented order', () => {
    const { result } = renderHook(() => useDeadMode(projectId, null));
    expect(result.current.mode).toBe(DEAD_MODE_ORDER[1]);
    act(() => { result.current.cycle(); });
    expect(result.current.mode).toBe(DEAD_MODE_ORDER[2]);
    act(() => { result.current.cycle(); });
    expect(result.current.mode).toBe(DEAD_MODE_ORDER[0]);
    act(() => { result.current.cycle(); });
    expect(result.current.mode).toBe(DEAD_MODE_ORDER[1]);
  });

  it('falls back to default for malformed persisted values', () => {
    window.localStorage.setItem(projectKey(projectId, 'dead-mode'), '"bogus"');
    const { result } = renderHook(() => useDeadMode(projectId, null));
    expect(result.current.mode).toBe(DEFAULT_DEAD_MODE);
  });

  it('applies classes via cy when one is provided', () => {
    const cy = buildCore();
    try {
      const { result } = renderHook(() => useDeadMode(projectId, cy));
      act(() => {
        result.current.setMode('live-only');
      });
      expect(cy.$id('b').hasClass(HIDE_DEAD_CLASS)).toBe(true);
    } finally {
      cy.destroy();
    }
  });

  it('refresh re-applies the current mode to newly added elements', () => {
    const cy = buildCore();
    try {
      const { result } = renderHook(() => useDeadMode(projectId, cy));
      act(() => {
        result.current.setMode('live-only');
      });
      // Add a fresh dead node after the initial application.
      cy.add({ group: 'nodes', data: { id: 'd' }, classes: 'dead' });
      expect(cy.$id('d').hasClass(HIDE_DEAD_CLASS)).toBe(false);
      act(() => {
        result.current.refresh();
      });
      expect(cy.$id('d').hasClass(HIDE_DEAD_CLASS)).toBe(true);
    } finally {
      cy.destroy();
    }
  });
});
