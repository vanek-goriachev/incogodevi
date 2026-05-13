/**
 * Pure-function tests for `computeSlotPositions` (R12).
 *
 * Covers:
 *   - idempotence to ≤1 px,
 *   - lanes stack inside a slot proportionally,
 *   - multi-column wrap when a lane exceeds maxNodesPerColumn,
 *   - dead-region fallback for unreachable + unmatched nodes,
 *   - the integration sanity-check: a folder group's nodes land at slotIndex's x.
 */

import { describe, expect, it } from 'vitest';

import { defaultLayerEditorState, type LayerEditorState } from '../pages/Main/layout/laneMapping';
import {
  computeSlotPositions,
  type SlotLayoutEdge,
  type SlotLayoutNode,
} from '../pages/Main/layout/slotLayout';

function makeNodes(specs: Array<[string, string, boolean?]>): SlotLayoutNode[] {
  return specs.map(([id, pkg, entry]) => ({
    id,
    package: pkg,
    isEntry: entry === true,
  }));
}

describe('computeSlotPositions', () => {
  it('idempotent to ≤1 px on the same input', () => {
    const nodes = makeNodes([
      ['entry', 'cmd', true],
      ['a', 'internal/api', false],
      ['b', 'internal/api', false],
      ['c', 'internal/db', false],
    ]);
    const edges: SlotLayoutEdge[] = [
      { source: 'entry', target: 'a' },
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const state = defaultLayerEditorState([0, 1, 2, 3]);
    const r1 = computeSlotPositions(nodes, edges, new Set(), state, {
      canvasHeight: 1200,
      layerGap: 300,
      minNodeGap: 100,
    });
    const r2 = computeSlotPositions(nodes, edges, new Set(), state, {
      canvasHeight: 1200,
      layerGap: 300,
      minNodeGap: 100,
    });
    for (const [id, p1] of r1.positions.entries()) {
      const p2 = r2.positions.get(id);
      expect(p2).toBeDefined();
      expect(Math.abs(p1.x - p2!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p1.y - p2!.y)).toBeLessThanOrEqual(1);
    }
  });

  it('folder-group node lands at its slot x', () => {
    const nodes = makeNodes([
      ['entry', 'cmd', true],
      ['p1', 'databases/postgres', false],
    ]);
    const edges: SlotLayoutEdge[] = [
      { source: 'entry', target: 'p1' },
    ];
    const state: LayerEditorState = {
      version: 1,
      groups: [{ id: 'g', name: 'DBs', prefix: 'databases' }],
      // Slot 0 holds BFS:0; slot 1 holds the folder lane (instead of BFS:1).
      slots: [
        { lanes: [{ kind: 'bfs', depth: 0 }] },
        { lanes: [{ kind: 'folder', id: 'g', name: 'DBs', prefix: 'databases' }] },
      ],
      unassigned: [],
    };
    const r = computeSlotPositions(nodes, edges, new Set(), state, {
      canvasHeight: 1200,
      topPadding: 50,
      layerGap: 200,
      minNodeGap: 100,
    });
    const entryPos = r.positions.get('entry')!;
    const p1Pos = r.positions.get('p1')!;
    // entry → slot 0 (x = 50); p1 → slot 1 (x = 50 + 200 = 250).
    expect(entryPos.x).toBe(50);
    expect(p1Pos.x).toBe(250);
  });

  it('multi-column wrap engages when lane exceeds maxNodesPerColumn', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `n${String(i)}`);
    const nodes = makeNodes(ids.map((id) => [id, 'foo'] as [string, string]));
    nodes[0]!.isEntry = true;
    const edges: SlotLayoutEdge[] = ids.slice(1).map((id) => ({ source: 'n0', target: id }));
    const state = defaultLayerEditorState([0, 1]);
    const r = computeSlotPositions(nodes, edges, new Set(), state, {
      canvasHeight: 1200,
      layerGap: 300,
      minNodeGap: 100,
      maxNodesPerColumn: 5,
      columnGap: 80,
    });
    // The 19 children all land at slot 1 with x = topPadding + layerGap + col*columnGap.
    // Expect ≥2 distinct x positions in slot 1.
    const xsInSlot1 = new Set<number>();
    for (let i = 1; i < ids.length; i += 1) {
      const p = r.positions.get(ids[i] as string)!;
      xsInSlot1.add(p.x);
    }
    expect(xsInSlot1.size).toBeGreaterThan(1);
  });

  it('lane stacking inside a slot keeps each lane in its band', () => {
    const nodes = makeNodes([
      ['entry', 'cmd', true],
      ['a', 'internal/api', false],
      ['b', 'internal/api', false],
      ['c', 'internal/db', false],
    ]);
    const edges: SlotLayoutEdge[] = [
      { source: 'entry', target: 'a' },
      { source: 'entry', target: 'b' },
      { source: 'entry', target: 'c' },
    ];
    // Slot 0 holds BFS:0. Slot 1 stacks BFS:1 (a,b) on top of a folder lane
    // claiming `internal/db` (c).
    const state: LayerEditorState = {
      version: 1,
      groups: [{ id: 'g', name: 'DB', prefix: 'internal/db' }],
      slots: [
        { lanes: [{ kind: 'bfs', depth: 0 }] },
        {
          lanes: [
            { kind: 'bfs', depth: 1 },
            { kind: 'folder', id: 'g', name: 'DB', prefix: 'internal/db' },
          ],
        },
      ],
      unassigned: [],
    };
    const r = computeSlotPositions(nodes, edges, new Set(), state, {
      canvasHeight: 800,
      topPadding: 50,
      layerGap: 200,
      minNodeGap: 80,
    });
    const aY = r.positions.get('a')!.y;
    const bY = r.positions.get('b')!.y;
    const cY = r.positions.get('c')!.y;
    // c is in the bottom folder lane → its y is strictly greater than
    // max(a.y, b.y) by virtue of band ordering.
    expect(cY).toBeGreaterThan(Math.max(aY, bY));
  });

  it('orphan / unreachable nodes land in the dead-region below', () => {
    const nodes = makeNodes([
      ['entry', 'cmd', true],
      ['orphan', 'isolated', false],
    ]);
    const state = defaultLayerEditorState([0]);
    const r = computeSlotPositions(nodes, [], new Set(), state, {
      canvasHeight: 1200,
      topPadding: 50,
      layerGap: 200,
      minNodeGap: 100,
      deadRegion: { dx: 0, dy: 220 },
    });
    const orphan = r.positions.get('orphan')!;
    const entry = r.positions.get('entry')!;
    expect(orphan.y).toBeGreaterThan(entry.y);
  });

  // -------- Bug 1 (feat/overlap-presets-package-filter): dynamic widths --------
  // Slots populated with nodes of widths {200, 800, 300} must produce x-positions
  // such that the boxes (centred at each x) do not overlap. The legacy fixed-
  // pitch positioner would space them at slotIndex * layerGap regardless of
  // width, so the 800-wide middle slot would punch through both neighbours.
  it('non-overlapping x: dynamic slot widths handle widely-varying nodes', () => {
    const nodes: SlotLayoutNode[] = [
      { id: 'a', package: 'pkg-a', isEntry: true, width: 200, height: 60 },
      { id: 'b', package: 'pkg-b', width: 800, height: 60 },
      { id: 'c', package: 'pkg-c', width: 300, height: 60 },
    ];
    const edges: SlotLayoutEdge[] = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const dims = new Map<string, { width: number; height: number }>([
      ['a', { width: 200, height: 60 }],
      ['b', { width: 800, height: 60 }],
      ['c', { width: 300, height: 60 }],
    ]);
    const state = defaultLayerEditorState([0, 1, 2]);
    const r = computeSlotPositions(nodes, edges, new Set(), state, {
      canvasHeight: 1200,
      topPadding: 50,
      minNodeGap: 100,
      intraSlotPadding: 80,
      interSlotGap: 120,
      nodeDimensions: dims,
    });
    const pa = r.positions.get('a')!;
    const pb = r.positions.get('b')!;
    const pc = r.positions.get('c')!;
    // Reconstruct bbox extents: each centre ± width/2.
    const extents = [
      { x1: pa.x - 100, x2: pa.x + 100 },
      { x1: pb.x - 400, x2: pb.x + 400 },
      { x1: pc.x - 150, x2: pc.x + 150 },
    ];
    for (let i = 0; i < extents.length; i += 1) {
      for (let j = i + 1; j < extents.length; j += 1) {
        const a = extents[i]!;
        const b = extents[j]!;
        const overlap = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        expect(overlap).toBeLessThan(0);
      }
    }
  });

  // Lane stacking inside ONE slot with heights {100, 600, 200} must not have
  // any pair of lane y-bands intersecting once you account for actual node
  // heights. The old proportional-height code would only have made the
  // 600-tall lane consume more vertical share but still let its top exceed
  // the lane above it.
  it('non-overlapping y: lane heights honour per-node outerHeight', () => {
    // Slot 0 has BFS 0; slot 1 stacks BFS 1 (tall) on top of folder (short).
    const nodes: SlotLayoutNode[] = [
      { id: 'entry', package: 'cmd', isEntry: true, width: 120, height: 100 },
      { id: 't1', package: 'tall', width: 120, height: 600 },
      { id: 's1', package: 'short', width: 120, height: 200 },
    ];
    const edges: SlotLayoutEdge[] = [
      { source: 'entry', target: 't1' },
      { source: 'entry', target: 's1' },
    ];
    const dims = new Map<string, { width: number; height: number }>([
      ['entry', { width: 120, height: 100 }],
      ['t1', { width: 120, height: 600 }],
      ['s1', { width: 120, height: 200 }],
    ]);
    const state: LayerEditorState = {
      version: 1,
      groups: [{ id: 'g', name: 'Short', prefix: 'short' }],
      slots: [
        { lanes: [{ kind: 'bfs', depth: 0 }] },
        {
          lanes: [
            { kind: 'bfs', depth: 1 },
            { kind: 'folder', id: 'g', name: 'Short', prefix: 'short' },
          ],
        },
      ],
      unassigned: [],
    };
    const r = computeSlotPositions(nodes, edges, new Set(), state, {
      canvasHeight: 1200,
      topPadding: 50,
      minNodeGap: 80,
      intraSlotPadding: 80,
      interSlotGap: 120,
      nodeDimensions: dims,
    });
    const t = r.positions.get('t1')!;
    const s = r.positions.get('s1')!;
    // tall lane lives above short lane; the tall node's bottom must clear the
    // short node's top by at least minNodeGap (80) since they live in different
    // lanes.
    const tBottom = t.y + 300; // height 600 → ±300
    const sTop = s.y - 100; // height 200 → ±100
    expect(sTop).toBeGreaterThanOrEqual(tBottom + 79); // tolerance for minNodeGap
  });

  // Idempotence under varied dimensions: two calls with the same dim map
  // must produce identical positions to ≤1 px (independent of which lane
  // each node falls into).
  it('idempotent under varied per-node dimensions', () => {
    const nodes: SlotLayoutNode[] = [
      { id: 'a', package: 'cmd', isEntry: true },
      { id: 'b', package: 'internal/api' },
      { id: 'c', package: 'internal/api' },
      { id: 'd', package: 'internal/db' },
    ];
    const edges: SlotLayoutEdge[] = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'b', target: 'd' },
    ];
    const dims = new Map<string, { width: number; height: number }>([
      ['a', { width: 150, height: 60 }],
      ['b', { width: 420, height: 220 }],
      ['c', { width: 220, height: 80 }],
      ['d', { width: 320, height: 140 }],
    ]);
    const state = defaultLayerEditorState([0, 1, 2]);
    const opts = {
      canvasHeight: 1200,
      topPadding: 50,
      minNodeGap: 80,
      intraSlotPadding: 80,
      interSlotGap: 120,
      nodeDimensions: dims,
    };
    const r1 = computeSlotPositions(nodes, edges, new Set(), state, opts);
    const r2 = computeSlotPositions(nodes, edges, new Set(), state, opts);
    for (const [id, p1] of r1.positions.entries()) {
      const p2 = r2.positions.get(id);
      expect(p2).toBeDefined();
      expect(Math.abs(p1.x - p2!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p1.y - p2!.y)).toBeLessThanOrEqual(1);
    }
  });
});
