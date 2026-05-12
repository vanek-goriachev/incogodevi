/**
 * Unit tests for the reach-depth pure positioner.
 *
 * The function under test is Cytoscape-free: it accepts plain `LayoutNode`,
 * `LayoutEdge` and `entryIds` data and returns a `Map<id, {x,y}>`. The tests
 * lock down the algorithm's guarantees:
 *   1. BFS min-depth from entries — multi-source, first-visit wins.
 *   2. Back-edges do not change a node's canonical depth.
 *   3. Unreachable nodes pack into a compact grid offset from the reachable
 *      bounding box (not a wide column).
 *   4. Barycenter ordering on layer k uses the average parent x on k-1.
 *   5. Determinism — identical inputs return deeply-equal maps.
 */

import { describe, expect, it } from 'vitest';

import {
  computeReachDepthPositions,
  type LayoutEdge,
  type LayoutNode,
} from '../../pages/Main/layout/reachDepth';

const OPTS = {
  canvasWidth: 1200,
  topPadding: 80,
  layerGap: 200,
  minNodeGap: 200,
  deadRegion: { dx: 200, dy: 160 },
} as const;

describe('computeReachDepthPositions', () => {
  it('returns an empty map for an empty input', () => {
    const out = computeReachDepthPositions([], [], new Set(), OPTS);
    expect(out.size).toBe(0);
  });

  it('produces 4 layers for a single 3-deep chain rooted at an entry', () => {
    const nodes: LayoutNode[] = [
      { id: 'e', isEntry: true },
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    const edges: LayoutEdge[] = [
      { source: 'e', target: 'a' },
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const out = computeReachDepthPositions(nodes, edges, new Set(['e']), OPTS);
    const ye = out.get('e')!.y;
    const ya = out.get('a')!.y;
    const yb = out.get('b')!.y;
    const yc = out.get('c')!.y;
    expect(ya).toBeGreaterThan(ye);
    expect(yb).toBeGreaterThan(ya);
    expect(yc).toBeGreaterThan(yb);
    // Layer 1 sits below the entry by exactly one layerGap.
    expect(ya - ye).toBe(OPTS.layerGap);
  });

  it('two entries pointing at the same node yield min-depth = 1', () => {
    const nodes: LayoutNode[] = [
      { id: 'e1', isEntry: true },
      { id: 'e2', isEntry: true },
      { id: 'x' },
    ];
    const edges: LayoutEdge[] = [
      { source: 'e1', target: 'x' },
      { source: 'e2', target: 'x' },
    ];
    const out = computeReachDepthPositions(
      nodes,
      edges,
      new Set(['e1', 'e2']),
      OPTS,
    );
    // Both entries on the same row.
    expect(out.get('e1')!.y).toBe(out.get('e2')!.y);
    // x is exactly one layer down.
    expect(out.get('x')!.y - out.get('e1')!.y).toBe(OPTS.layerGap);
  });

  it('back-edges do not lower a node already placed at a shallower depth', () => {
    // e → a → b ; b → a (back-edge). a's depth must stay 1, not 3.
    const nodes: LayoutNode[] = [
      { id: 'e', isEntry: true },
      { id: 'a' },
      { id: 'b' },
    ];
    const edges: LayoutEdge[] = [
      { source: 'e', target: 'a' },
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' }, // back-edge
    ];
    const out = computeReachDepthPositions(nodes, edges, new Set(['e']), OPTS);
    const ya = out.get('a')!.y;
    const yb = out.get('b')!.y;
    expect(ya).toBeLessThan(yb);
    expect(ya - out.get('e')!.y).toBe(OPTS.layerGap);
  });

  it('packs unreachable nodes into a compact grid offset from the reachable region', () => {
    const nodes: LayoutNode[] = [
      { id: 'e', isEntry: true },
      { id: 'a' },
      { id: 'd1' }, // unreachable
      { id: 'd2' },
      { id: 'd3' },
      { id: 'd4' },
    ];
    const edges: LayoutEdge[] = [{ source: 'e', target: 'a' }];
    const out = computeReachDepthPositions(nodes, edges, new Set(['e']), OPTS);
    // Reachable bounding box max
    const reachableMaxX = Math.max(out.get('e')!.x, out.get('a')!.x);
    const reachableMaxY = Math.max(out.get('e')!.y, out.get('a')!.y);
    for (const id of ['d1', 'd2', 'd3', 'd4']) {
      const p = out.get(id)!;
      expect(p.x).toBeGreaterThan(reachableMaxX);
      expect(p.y).toBeGreaterThan(reachableMaxY);
    }
    // Compact grid — 4 nodes in a 2x2 (sqrt(4)=2 columns).
    const d1 = out.get('d1')!;
    const d3 = out.get('d3')!;
    // d3 sits on the second row of the 2-column grid → larger y than d1.
    expect(d3.y).toBeGreaterThan(d1.y);
  });

  it('barycenter ordering: layer-1 nodes sort by average parent x', () => {
    // Layer 0: P1 (x=100), P2 (x=300), P3 (x=500) — alphabetically sorted ids.
    // Parents map: A ← P1, P2 (avg=200); B ← P3 (avg=500); C ← P1, P3 (avg=300).
    // Expected layer-1 order left→right: A (200), C (300), B (500).
    const nodes: LayoutNode[] = [
      { id: 'P1', isEntry: true },
      { id: 'P2', isEntry: true },
      { id: 'P3', isEntry: true },
      { id: 'A' },
      { id: 'B' },
      { id: 'C' },
    ];
    const edges: LayoutEdge[] = [
      { source: 'P1', target: 'A' },
      { source: 'P2', target: 'A' },
      { source: 'P3', target: 'B' },
      { source: 'P1', target: 'C' },
      { source: 'P3', target: 'C' },
    ];
    const out = computeReachDepthPositions(
      nodes,
      edges,
      new Set(['P1', 'P2', 'P3']),
      OPTS,
    );
    const ax = out.get('A')!.x;
    const bx = out.get('B')!.x;
    const cx = out.get('C')!.x;
    // Left-to-right order: A, C, B
    expect(ax).toBeLessThan(cx);
    expect(cx).toBeLessThan(bx);
  });

  it('is idempotent — calling twice with the same input returns deeply-equal positions', () => {
    const nodes: LayoutNode[] = [
      { id: 'e', isEntry: true },
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    const edges: LayoutEdge[] = [
      { source: 'e', target: 'a' },
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const a = computeReachDepthPositions(nodes, edges, new Set(['e']), OPTS);
    const b = computeReachDepthPositions(nodes, edges, new Set(['e']), OPTS);
    expect(Object.fromEntries(a)).toEqual(Object.fromEntries(b));
  });

  it('entries-only graph still places entries deterministically on layer 0', () => {
    const nodes: LayoutNode[] = [
      { id: 'a', isEntry: true },
      { id: 'b', isEntry: true },
      { id: 'c', isEntry: true },
    ];
    const out1 = computeReachDepthPositions(
      nodes,
      [],
      new Set(['a', 'b', 'c']),
      OPTS,
    );
    const out2 = computeReachDepthPositions(
      [...nodes].reverse(),
      [],
      new Set(['c', 'b', 'a']),
      OPTS,
    );
    expect(Object.fromEntries(out1)).toEqual(Object.fromEntries(out2));
    // All three on the same y (layer 0).
    expect(out1.get('a')!.y).toBe(out1.get('b')!.y);
    expect(out1.get('b')!.y).toBe(out1.get('c')!.y);
    // x in alphabetical order
    expect(out1.get('a')!.x).toBeLessThan(out1.get('b')!.x);
    expect(out1.get('b')!.x).toBeLessThan(out1.get('c')!.x);
  });
});
