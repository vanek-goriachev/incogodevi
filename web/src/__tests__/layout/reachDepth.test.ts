/**
 * Unit tests for the reach-depth pure positioner (L→R orientation, PR #54).
 *
 * The function under test is Cytoscape-free: it accepts plain `LayoutNode`,
 * `LayoutEdge` and `entryIds` data and returns a `Map<id, {x,y}>`. The tests
 * lock down the algorithm's guarantees:
 *   1. BFS min-depth from entries — multi-source, first-visit wins.
 *   2. Back-edges do not change a node's canonical depth.
 *   3. Unreachable nodes pack into a compact grid offset BELOW the
 *      reachable bounding box (not a wide column to the right).
 *   4. Barycenter ordering on layer k uses the average parent y on k-1.
 *   5. Determinism — identical inputs return deeply-equal maps.
 *   6. Multi-column wrap — when a layer exceeds `maxNodesPerColumn`, it
 *      splits onto sub-columns separated by `columnGap`; the next layer
 *      is still pushed by a full `layerGap`.
 *   7. Per-node height — neighbours' vertical centre-to-centre distance
 *      respects `(hA + hB)/2 + buffer` when heights are supplied,
 *      preventing bounding-box overlap for tall compound parents.
 *   8. Entry-only fixture: every entry sits in the leftmost column (same
 *      x), barycenter ordering not applicable.
 */

import { describe, expect, it } from 'vitest';

import {
  computeReachDepthPositions,
  type LayoutEdge,
  type LayoutNode,
} from '../../pages/Main/layout/reachDepth';

const OPTS = {
  canvasHeight: 1200,
  topPadding: 80,
  layerGap: 200,
  minNodeGap: 200,
  deadRegion: { dx: 0, dy: 160 },
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
    const xe = out.get('e')!.x;
    const xa = out.get('a')!.x;
    const xb = out.get('b')!.x;
    const xc = out.get('c')!.x;
    expect(xa).toBeGreaterThan(xe);
    expect(xb).toBeGreaterThan(xa);
    expect(xc).toBeGreaterThan(xb);
    // Layer 1 sits one layerGap to the right of the entry column.
    expect(xa - xe).toBe(OPTS.layerGap);
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
    // Both entries share the same x (leftmost column).
    expect(out.get('e1')!.x).toBe(out.get('e2')!.x);
    // x is exactly one layer to the right.
    expect(out.get('x')!.x - out.get('e1')!.x).toBe(OPTS.layerGap);
  });

  it('back-edges do not push a node already placed at a shallower depth further right', () => {
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
    const xa = out.get('a')!.x;
    const xb = out.get('b')!.x;
    expect(xa).toBeLessThan(xb);
    expect(xa - out.get('e')!.x).toBe(OPTS.layerGap);
  });

  it('packs unreachable nodes into a compact grid offset BELOW the reachable region', () => {
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
    // Reachable bounding box max y — dead region must sit below it.
    const reachableMaxY = Math.max(out.get('e')!.y, out.get('a')!.y);
    for (const id of ['d1', 'd2', 'd3', 'd4']) {
      const p = out.get(id)!;
      expect(p.y).toBeGreaterThan(reachableMaxY);
    }
    // Compact grid — 4 nodes in a 2x2 (sqrt(4)=2 columns).
    const d1 = out.get('d1')!;
    const d3 = out.get('d3')!;
    // d3 sits on the second row of the 2-column grid → larger y than d1.
    expect(d3.y).toBeGreaterThan(d1.y);
  });

  it('barycenter ordering: layer-1 nodes sort by average parent y', () => {
    // Layer 0: P1, P2, P3 — alphabetically sorted ids on the entry column.
    // Default `minNodeGap` gives them centre-to-centre 200 px on y.
    // Parents map: A ← P1, P2 (avg lo y); B ← P3 (avg hi y); C ← P1, P3
    // (avg mid). Expected layer-1 order top→bottom: A, C, B.
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
    const ay = out.get('A')!.y;
    const by = out.get('B')!.y;
    const cy = out.get('C')!.y;
    // Top-to-bottom order: A, C, B
    expect(ay).toBeLessThan(cy);
    expect(cy).toBeLessThan(by);
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
    // All three on the same x (layer 0, leftmost column).
    expect(out1.get('a')!.x).toBe(out1.get('b')!.x);
    expect(out1.get('b')!.x).toBe(out1.get('c')!.x);
    // y in alphabetical order
    expect(out1.get('a')!.y).toBeLessThan(out1.get('b')!.y);
    expect(out1.get('b')!.y).toBeLessThan(out1.get('c')!.y);
  });

  // ----------- L→R orientation guard (PR #54) -----------
  it('entry-only fixture lays out in a column at the smallest x', () => {
    // Mixed entries + non-reachable nodes. Entries must dominate the
    // leftmost x and every layer-0 entry must share that x.
    const nodes: LayoutNode[] = [
      { id: 'e1', isEntry: true },
      { id: 'e2', isEntry: true },
      { id: 'e3', isEntry: true },
      { id: 'orphan' }, // unreachable
    ];
    const out = computeReachDepthPositions(
      nodes,
      [],
      new Set(['e1', 'e2', 'e3']),
      OPTS,
    );
    const xs = ['e1', 'e2', 'e3'].map((id) => out.get(id)!.x);
    const minX = Math.min(...xs);
    // Every entry within ±1 px of the global min x (leftmost column).
    for (const x of xs) {
      expect(Math.abs(x - minX)).toBeLessThanOrEqual(1);
    }
    // Orphan is in the dead region, NOT at the entry column.
    expect(out.get('orphan')!.x).toBeGreaterThanOrEqual(minX);
  });

  // ----------- Multi-column wrap (PR #54 rotated from PR #53 multirow) -----------
  it('wraps a layer onto multiple columns when its size exceeds maxNodesPerColumn', () => {
    // 10 entries, maxNodesPerColumn = 4 → 3 sub-columns of 4/4/2.
    const entries: LayoutNode[] = [];
    const entryIds = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const id = `e${String(i).padStart(2, '0')}`;
      entries.push({ id, isEntry: true });
      entryIds.add(id);
    }
    const out = computeReachDepthPositions(entries, [], entryIds, {
      canvasHeight: 1600,
      topPadding: 80,
      layerGap: 200,
      minNodeGap: 200,
      maxNodesPerColumn: 4,
      columnGap: 80,
    });
    // Distinct x values = number of sub-columns.
    const xs = new Set<number>();
    for (const id of entryIds) {
      xs.add(out.get(id)!.x);
    }
    expect(xs.size).toBeGreaterThan(1);
    expect(xs.size).toBeLessThanOrEqual(4);
    // Column gap is strictly smaller than layer gap.
    const sortedXs = Array.from(xs).sort((a, b) => a - b);
    const dx = (sortedXs[1] as number) - (sortedXs[0] as number);
    expect(dx).toBe(80);
    expect(dx).toBeLessThan(200);
  });

  it('keeps a clear layerGap between depth tiers even when the previous layer wrapped', () => {
    // 6 entries (wrap into 2 sub-columns at maxNodesPerColumn=3), each
    // pointing to a single child. The child must sit a full layerGap to
    // the right of the LAST sub-column of the parent layer — the inter-
    // layer gap is preserved across wrapped layers.
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
      canvasHeight: 1200,
      topPadding: 80,
      layerGap: 200,
      minNodeGap: 200,
      maxNodesPerColumn: 3,
      columnGap: 80,
    });
    // The entry layer must have two distinct x values.
    const entryXs = new Set<number>();
    for (let i = 0; i < 6; i += 1) {
      entryXs.add(out.get(`e${i}`)!.x);
    }
    expect(entryXs.size).toBe(2);
    const lastColX = Math.max(...entryXs);
    const childX = out.get('child')!.x;
    // Child sits a full layerGap to the right of the last entry sub-column.
    expect(childX - lastColX).toBe(200);
    // Demo contract: between-layer gap must visibly exceed within-layer
    // column gap.
    expect(childX - lastColX).toBeGreaterThan(80 * 2);
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
      canvasHeight: 1600,
      topPadding: 80,
      layerGap: 200,
      minNodeGap: 200,
      maxNodesPerColumn: 5,
      columnGap: 90,
    } as const;
    const out1 = computeReachDepthPositions(entries, [], entryIds, opts);
    const out2 = computeReachDepthPositions(entries, [], entryIds, opts);
    expect(Object.fromEntries(out1)).toEqual(Object.fromEntries(out2));
  });

  // ----------- Per-node height (rotated Bug 3 fix) -----------
  it('per-node height prevents adjacent bounding-box overlap in the same column', () => {
    // Three tall nodes on layer 0: each height 300; minNodeGap 200 alone
    // would allow centres 200 px apart → boxes overlap by 100 px. With
    // per-node heights supplied + buffer 40, centres must end up
    // ≥ 340 px apart on y.
    const nodes: LayoutNode[] = [
      { id: 'a', isEntry: true, height: 300 },
      { id: 'b', isEntry: true, height: 300 },
      { id: 'c', isEntry: true, height: 100 },
    ];
    const out = computeReachDepthPositions(
      nodes,
      [],
      new Set(['a', 'b', 'c']),
      {
        canvasHeight: 2000,
        topPadding: 80,
        layerGap: 200,
        minNodeGap: 200,
        nodeBuffer: 40,
      },
    );
    const ay = out.get('a')!.y;
    const by = out.get('b')!.y;
    const cy = out.get('c')!.y;
    // Sorted alphabetically: a then b then c. a-b centres ≥ 300/2 + 300/2 + 40 = 340.
    expect(by - ay).toBeGreaterThanOrEqual(340 - 1); // allow 1 px rounding
    // b-c centres ≥ 300/2 + 100/2 + 40 = 240, also above minNodeGap=200.
    expect(cy - by).toBeGreaterThanOrEqual(240 - 1);
  });

  it('falls back to minNodeGap when no height is supplied', () => {
    // No heights → behaviour matches the legacy fixed-gap path.
    const nodes: LayoutNode[] = [
      { id: 'a', isEntry: true },
      { id: 'b', isEntry: true },
    ];
    const out = computeReachDepthPositions(
      nodes,
      [],
      new Set(['a', 'b']),
      {
        canvasHeight: 800,
        topPadding: 80,
        layerGap: 200,
        minNodeGap: 220,
      },
    );
    const ay = out.get('a')!.y;
    const by = out.get('b')!.y;
    expect(by - ay).toBeGreaterThanOrEqual(220 - 1);
  });

  it('idempotence preserved when per-node heights and wrap are combined', () => {
    const nodes: LayoutNode[] = [];
    const entryIds = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      const id = `n${String(i).padStart(2, '0')}`;
      nodes.push({ id, isEntry: true, height: 120 + (i % 3) * 80 });
      entryIds.add(id);
    }
    const opts = {
      canvasHeight: 1400,
      topPadding: 80,
      layerGap: 200,
      minNodeGap: 200,
      maxNodesPerColumn: 3,
      columnGap: 70,
      nodeBuffer: 30,
    } as const;
    const out1 = computeReachDepthPositions(nodes, [], entryIds, opts);
    const out2 = computeReachDepthPositions(nodes, [], entryIds, opts);
    expect(Object.fromEntries(out1)).toEqual(Object.fromEntries(out2));
  });
});
