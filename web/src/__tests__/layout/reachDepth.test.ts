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
 *   6. Multi-row wrap — when a layer exceeds `maxNodesPerRow`, it splits
 *      onto rows separated by `rowGap`; the next layer is still pushed by
 *      a full `layerGap`.
 *   7. Per-node width — neighbours' centre-to-centre distance respects
 *      `(wA + wB)/2 + buffer` when widths are supplied, preventing
 *      bounding-box overlap for wide compound parents.
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
    // Layer 0: P1, P2, P3 — alphabetically sorted ids. Default `minNodeGap`
    // gives them centre-to-centre 200 px (or wider if the canvas allows).
    // Parents map: A ← P1, P2 (avg lo); B ← P3 (avg hi); C ← P1, P3 (avg mid).
    // Expected layer-1 order left→right: A, C, B.
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

  // ----------- Multi-row wrap (Bug 1 fix) -----------
  it('wraps a layer onto multiple rows when its size exceeds maxNodesPerRow', () => {
    // 10 entries, maxNodesPerRow = 4 → 3 rows of 4/4/2 (uniform-ish: 4+4+2).
    const entries: LayoutNode[] = [];
    const entryIds = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const id = `e${String(i).padStart(2, '0')}`;
      entries.push({ id, isEntry: true });
      entryIds.add(id);
    }
    const out = computeReachDepthPositions(entries, [], entryIds, {
      canvasWidth: 1600,
      topPadding: 80,
      layerGap: 200,
      minNodeGap: 200,
      maxNodesPerRow: 4,
      rowGap: 80,
    });
    // Distinct y values = number of rows.
    const ys = new Set<number>();
    for (const id of entryIds) {
      ys.add(out.get(id)!.y);
    }
    expect(ys.size).toBeGreaterThan(1);
    expect(ys.size).toBeLessThanOrEqual(4);
    // Row gap is strictly smaller than layer gap.
    const sortedYs = Array.from(ys).sort((a, b) => a - b);
    const dy = (sortedYs[1] as number) - (sortedYs[0] as number);
    expect(dy).toBe(80);
    expect(dy).toBeLessThan(200);
  });

  it('keeps a clear layerGap between depth tiers even when the previous layer wrapped', () => {
    // 6 entries (wrap into 2 rows at maxNodesPerRow=3), each pointing to a
    // single child. The child must sit a full layerGap below the LAST row
    // of the parent layer — i.e. the inter-layer gap is preserved across
    // wrapped layers.
    const nodes: LayoutNode[] = [];
    const edges: LayoutEdge[] = [];
    const entryIds = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const id = `e${i}`;
      nodes.push({ id, isEntry: true });
      entryIds.add(id);
    }
    nodes.push({ id: 'child' });
    for (let i = 0; i < 6; i += 1) {
      edges.push({ source: `e${i}`, target: 'child' });
    }
    const out = computeReachDepthPositions(nodes, edges, entryIds, {
      canvasWidth: 1200,
      topPadding: 80,
      layerGap: 200,
      minNodeGap: 200,
      maxNodesPerRow: 3,
      rowGap: 80,
    });
    // The entry layer must have two distinct y values.
    const entryYs = new Set<number>();
    for (let i = 0; i < 6; i += 1) {
      entryYs.add(out.get(`e${i}`)!.y);
    }
    expect(entryYs.size).toBe(2);
    const lastRowY = Math.max(...entryYs);
    const childY = out.get('child')!.y;
    // Child sits a full layerGap below the last entry row.
    expect(childY - lastRowY).toBe(200);
    // Demo contract: between-layer gap must visibly exceed within-layer
    // row gap.
    expect(childY - lastRowY).toBeGreaterThan(80 * 2);
  });

  it('wrap output is still deterministic for the same inputs', () => {
    const entries: LayoutNode[] = [];
    const entryIds = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const id = `e${String(i).padStart(2, '0')}`;
      entries.push({ id, isEntry: true });
      entryIds.add(id);
    }
    const opts = {
      canvasWidth: 1600,
      topPadding: 80,
      layerGap: 200,
      minNodeGap: 200,
      maxNodesPerRow: 5,
      rowGap: 90,
    } as const;
    const out1 = computeReachDepthPositions(entries, [], entryIds, opts);
    const out2 = computeReachDepthPositions(entries, [], entryIds, opts);
    expect(Object.fromEntries(out1)).toEqual(Object.fromEntries(out2));
  });

  // ----------- Per-node width (Bug 3 fix) -----------
  it('per-node width prevents adjacent bounding-box overlap on the same row', () => {
    // Two adjacent wide nodes: each width 300; minNodeGap 200 alone would
    // allow centres 200 px apart → boxes overlap by 100 px. With per-node
    // widths supplied + buffer 40, centres must end up ≥ 340 px apart.
    const nodes: LayoutNode[] = [
      { id: 'a', isEntry: true, width: 300 },
      { id: 'b', isEntry: true, width: 300 },
      { id: 'c', isEntry: true, width: 100 },
    ];
    const out = computeReachDepthPositions(
      nodes,
      [],
      new Set(['a', 'b', 'c']),
      {
        canvasWidth: 2000,
        topPadding: 80,
        layerGap: 200,
        minNodeGap: 200,
        nodeBuffer: 40,
      },
    );
    const ax = out.get('a')!.x;
    const bx = out.get('b')!.x;
    const cx = out.get('c')!.x;
    // Sorted alphabetically: a then b then c. a-b centres ≥ 300/2 + 300/2 + 40 = 340.
    expect(bx - ax).toBeGreaterThanOrEqual(340 - 1); // allow 1 px rounding
    // b-c centres ≥ 300/2 + 100/2 + 40 = 240, also above minNodeGap=200.
    expect(cx - bx).toBeGreaterThanOrEqual(240 - 1);
  });

  it('falls back to minNodeGap when no width is supplied', () => {
    // No widths → behaviour matches the legacy fixed-gap path.
    const nodes: LayoutNode[] = [
      { id: 'a', isEntry: true },
      { id: 'b', isEntry: true },
    ];
    const out = computeReachDepthPositions(
      nodes,
      [],
      new Set(['a', 'b']),
      {
        canvasWidth: 800,
        topPadding: 80,
        layerGap: 200,
        minNodeGap: 220,
      },
    );
    const ax = out.get('a')!.x;
    const bx = out.get('b')!.x;
    expect(bx - ax).toBeGreaterThanOrEqual(220 - 1);
  });

  it('idempotence preserved when per-node widths and wrap are combined', () => {
    const nodes: LayoutNode[] = [];
    const entryIds = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      const id = `n${String(i).padStart(2, '0')}`;
      nodes.push({ id, isEntry: true, width: 120 + (i % 3) * 80 });
      entryIds.add(id);
    }
    const opts = {
      canvasWidth: 1400,
      topPadding: 80,
      layerGap: 200,
      minNodeGap: 200,
      maxNodesPerRow: 3,
      rowGap: 70,
      nodeBuffer: 30,
    } as const;
    const out1 = computeReachDepthPositions(nodes, [], entryIds, opts);
    const out2 = computeReachDepthPositions(nodes, [], entryIds, opts);
    expect(Object.fromEntries(out1)).toEqual(Object.fromEntries(out2));
  });
});
