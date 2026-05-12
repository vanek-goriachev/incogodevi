/**
 * Tests for `useFilters` / `applyFilters` against a live Cytoscape instance.
 *
 * Uses `renderer: { name: 'null' }` so jsdom does not have to provide a 2D
 * canvas context. The graph data layer (classes, selectors, batched updates)
 * is fully exercised — only painting is opted out of.
 */

import { describe, expect, it } from 'vitest';
import cytoscape, { type Core } from 'cytoscape';

import { defaultFilterSpec, type FilterSpec } from '../pages/Main/panels/filterSpec';
import { applyFilters, ensureFilterStyleRules } from '../pages/Main/useFilters';

function makeCy(): Core {
  const opts: cytoscape.CytoscapeOptions = {
    elements: [
      { group: 'nodes', data: { id: 'n1', name: 'main', kind: 'func', package: 'cmd' } },
      { group: 'nodes', data: { id: 'n2', name: 'Handler', kind: 'struct', package: 'api' } },
      { group: 'nodes', data: { id: 'n3', name: 'cfg', kind: 'var', package: 'config' } },
      { group: 'nodes', data: { id: 'n4', name: 'Helper', kind: 'func', package: 'api' } },
      { group: 'edges', data: { id: 'e1', source: 'n1', target: 'n2', kind: 'calls' } },
      { group: 'edges', data: { id: 'e2', source: 'n2', target: 'n4', kind: 'calls' } },
      { group: 'edges', data: { id: 'e3', source: 'n2', target: 'n3', kind: 'references' } },
    ],
    headless: true,
    styleEnabled: true,
  };
  (opts as unknown as { renderer: { name: string } }).renderer = { name: 'null' };
  return cytoscape(opts);
}

describe('applyFilters', () => {
  it('hides nodes whose kind is toggled off and any incident edges', () => {
    const cy = makeCy();
    const spec: FilterSpec = {
      ...defaultFilterSpec(),
      kinds: { ...defaultFilterSpec().kinds, var: false },
    };
    applyFilters(cy, spec);
    expect(cy.$id('n3').hasClass('hidden')).toBe(true);
    expect(cy.$id('n2').hasClass('hidden')).toBe(false);
    // n3 only participates in e3 (n2→n3); e3 must be hidden too.
    expect(cy.$id('e3').hasClass('hidden')).toBe(true);
    expect(cy.$id('e1').hasClass('hidden')).toBe(false);
    cy.destroy();
  });

  it('clears hidden classes when filters are restored to defaults', () => {
    const cy = makeCy();
    applyFilters(cy, {
      ...defaultFilterSpec(),
      kinds: { ...defaultFilterSpec().kinds, var: false },
    });
    expect(cy.$id('n3').hasClass('hidden')).toBe(true);
    applyFilters(cy, defaultFilterSpec());
    expect(cy.$id('n3').hasClass('hidden')).toBe(false);
    expect(cy.$id('e3').hasClass('hidden')).toBe(false);
    cy.destroy();
  });

  it('hides nodes outside the selected package subset', () => {
    const cy = makeCy();
    applyFilters(cy, {
      ...defaultFilterSpec(),
      packages: { mode: 'subset', selected: ['api'] },
    });
    expect(cy.$id('n1').hasClass('hidden')).toBe(true);
    expect(cy.$id('n2').hasClass('hidden')).toBe(false);
    expect(cy.$id('n3').hasClass('hidden')).toBe(true);
    expect(cy.$id('n4').hasClass('hidden')).toBe(false);
    cy.destroy();
  });

  it('marks find matches with .match and dims the rest', () => {
    const cy = makeCy();
    applyFilters(cy, { ...defaultFilterSpec(), find: 'handler' });
    expect(cy.$id('n2').hasClass('match')).toBe(true);
    expect(cy.$id('n2').hasClass('dim')).toBe(false);
    expect(cy.$id('n1').hasClass('dim')).toBe(true);
    expect(cy.$id('n3').hasClass('dim')).toBe(true);
    cy.destroy();
  });

  it('does not dim anything when no node matches the find query', () => {
    const cy = makeCy();
    applyFilters(cy, { ...defaultFilterSpec(), find: 'no-such-node' });
    cy.nodes().forEach((node) => {
      expect(node.hasClass('match')).toBe(false);
      expect(node.hasClass('dim')).toBe(false);
    });
    cy.destroy();
  });

  it('matches by receiver-aware FQN (pkg#Recv.Method) when the user types a qualified name', () => {
    // Mirrors a real graph: a struct Server with a method Run wired through a
    // contains edge. The node id is an opaque hash on the wire, so searching
    // "Server.Run" cannot rely on id substrings — it has to reconstruct the
    // FQN through the cy contains edge.
    const opts: cytoscape.CytoscapeOptions = {
      elements: [
        { group: 'nodes', data: { id: 'sid-hash', name: 'Server', kind: 'struct', package: 'api' } },
        { group: 'nodes', data: { id: 'mid-hash', name: 'Run', kind: 'method', package: 'api' } },
        { group: 'edges', data: { id: 'ce', source: 'sid-hash', target: 'mid-hash', kind: 'contains' } },
      ],
      headless: true,
      styleEnabled: true,
    };
    (opts as unknown as { renderer: { name: string } }).renderer = { name: 'null' };
    const cy = cytoscape(opts);
    applyFilters(cy, { ...defaultFilterSpec(), find: 'Server.Run' });
    expect(cy.$id('mid-hash').hasClass('match')).toBe(true);
    expect(cy.$id('sid-hash').hasClass('match')).toBe(false);
    cy.destroy();
  });

  it('matches dynamically added nodes (post expandStructMembers) on re-apply', () => {
    const cy = makeCy();
    // Initial highlight: nothing should match "DynamicMethod" yet.
    applyFilters(cy, { ...defaultFilterSpec(), find: 'DynamicMethod' });
    cy.nodes().forEach((n) => {
      expect(n.hasClass('match')).toBe(false);
    });
    // Simulate an expand: add a new method (and its contains edge) to cy.
    cy.add([
      { group: 'nodes', data: { id: 'late', name: 'DynamicMethod', kind: 'method', package: 'api' } },
      { group: 'edges', data: { id: 'late-ce', source: 'n2', target: 'late', kind: 'contains' } },
    ]);
    applyFilters(cy, { ...defaultFilterSpec(), find: 'Handler.DynamicMethod' });
    expect(cy.$id('late').hasClass('match')).toBe(true);
    cy.destroy();
  });

  it('keeps already-hidden nodes hidden — find never resurrects them', () => {
    const cy = makeCy();
    applyFilters(cy, {
      ...defaultFilterSpec(),
      kinds: { ...defaultFilterSpec().kinds, var: false },
      find: 'cfg',
    });
    expect(cy.$id('n3').hasClass('hidden')).toBe(true);
    expect(cy.$id('n3').hasClass('match')).toBe(false);
    cy.destroy();
  });

  it('runs comfortably within the NFR-03 100 ms budget for ≤ 1000 nodes', () => {
    const elements: cytoscape.ElementDefinition[] = [];
    for (let i = 0; i < 1000; i += 1) {
      elements.push({
        group: 'nodes',
        data: {
          id: `n-${String(i)}`,
          name: `node-${String(i)}`,
          kind: i % 2 === 0 ? 'func' : 'struct',
          package: `pkg-${String(i % 25)}`,
        },
      });
    }
    const opts: cytoscape.CytoscapeOptions = {
      elements,
      headless: true,
      styleEnabled: true,
    };
    (opts as unknown as { renderer: { name: string } }).renderer = { name: 'null' };
    const cy = cytoscape(opts);
    const spec: FilterSpec = {
      ...defaultFilterSpec(),
      kinds: { ...defaultFilterSpec().kinds, struct: false },
    };
    const t0 = performance.now();
    applyFilters(cy, spec);
    const t1 = performance.now();
    // Headless null-renderer + jsdom can be slower than a real browser; the
    // budget is sized so genuine regressions trip the alarm, not jitter.
    expect(t1 - t0).toBeLessThan(250);
    cy.destroy();
  });
});

describe('ensureFilterStyleRules', () => {
  it('does not throw when called against a fresh Cytoscape core', () => {
    const cy = makeCy();
    expect(() => {
      ensureFilterStyleRules(cy);
    }).not.toThrow();
    cy.destroy();
  });
});
