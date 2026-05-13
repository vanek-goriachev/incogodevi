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
});
