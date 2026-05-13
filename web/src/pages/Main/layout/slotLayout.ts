/**
 * Slot-based positioner for the Layer Editor (R12 / feat/layer-editor).
 *
 * Replaces (or wraps) the canvas-wide pass that used to live exclusively in
 * `reachDepth.ts`. The new flow is:
 *
 *   1. Compute the per-node BFS depth using the same first-visit BFS as
 *      `computeReachDepthPositions`.
 *   2. Resolve every node to its slot + lane via `resolveLanes()` (folder
 *      groups win over BFS depths under the longest-prefix-first rule).
 *   3. For each slot:
 *        - x = `topPadding + slotIndex * layerGap`
 *        - the slot's vertical band is split among its stacked lanes
 *          proportionally to lane size
 *        - within each lane, nodes are placed via barycenter ordering
 *          against parents in the previous SLOT (the visual flow is
 *          left-to-right at the slot level, regardless of what BFS depth a
 *          node lived in originally). Multi-column wrap when the lane
 *          exceeds `maxNodesPerColumn`.
 *   4. Nodes unreachable from any entry AND not matched by a folder group
 *      are dropped into the same compact grid below the reachable region as
 *      in the legacy positioner.
 *
 * Determinism: same input → same output (≤1 px). The barycenter heuristic
 * runs in slot order, and ties break alphabetically, so the function is
 * idempotent. R8 invariant is preserved by callers — they pass only the
 * top-level (non-compound-child) nodes; scoped per-compound layouts continue
 * to run in `useAggregateExpand`.
 */

import {
  laneKeyOf,
  resolveLanes,
  type LaneInputNode,
  type LaneResolution,
  type LayerEditorState,
} from './laneMapping';

export interface SlotLayoutNode {
  id: string;
  /** Package path used for folder-group prefix matching. */
  package: string;
  /** Whether this node is an entry-point (seeds the BFS at depth 0). */
  isEntry?: boolean;
  width?: number;
  height?: number;
}

export interface SlotLayoutEdge {
  source: string;
  target: string;
}

export interface SlotLayoutOptions {
  /** Canvas height in layout units. Same role as the legacy positioner. */
  canvasHeight: number;
  /** Top/left padding. Defaults to 80. */
  topPadding?: number;
  /** Horizontal gap between slots. Defaults to 360. */
  layerGap?: number;
  /** Min vertical gap between adjacent nodes in a sub-column. Defaults to 110. */
  minNodeGap?: number;
  /** Max nodes per sub-column before wrapping. Defaults to 14. */
  maxNodesPerColumn?: number;
  /** Horizontal gap between wrapped sub-columns inside one slot/lane. */
  columnGap?: number;
  /** Node-size aware buffer when computing per-pair vertical gaps. */
  nodeBuffer?: number;
  /** Dead-region anchor offset. */
  deadRegion?: { dx: number; dy: number };
}

export interface SlotLayoutPosition {
  x: number;
  y: number;
}

export interface SlotLayoutResult {
  positions: Map<string, SlotLayoutPosition>;
  /** Lane resolution that drove the layout — useful for chip counts in UI. */
  resolution: LaneResolution;
  /** Per-node BFS depth (computed for the editor chip counters). */
  bfsDepths: Map<string, number>;
}

/**
 * Compute slot-based positions for every node.
 *
 * The function is the canvas-wide positioner; per-compound scoped layouts
 * continue to run in `useAggregateExpand`.
 */
export function computeSlotPositions(
  nodes: readonly SlotLayoutNode[],
  edges: readonly SlotLayoutEdge[],
  entryIds: ReadonlySet<string>,
  state: LayerEditorState,
  opts: SlotLayoutOptions,
): SlotLayoutResult {
  const out = new Map<string, SlotLayoutPosition>();
  const canvasHeight = Math.max(400, opts.canvasHeight);
  const topPadding = opts.topPadding ?? 80;
  const layerGap = opts.layerGap ?? 360;
  const minNodeGap = opts.minNodeGap ?? 110;
  const maxNodesPerColumn = Math.max(2, opts.maxNodesPerColumn ?? 14);
  const columnGap = opts.columnGap ?? layerGap * 0.45;
  const nodeBuffer = opts.nodeBuffer ?? 30;
  const deadDx = opts.deadRegion?.dx ?? 0;
  const deadDy = opts.deadRegion?.dy ?? layerGap;

  if (nodes.length === 0) {
    return {
      positions: out,
      resolution: { byNode: new Map(), laneByKey: new Map(), nodesByLaneKey: new Map() },
      bfsDepths: new Map(),
    };
  }

  // Dedupe nodes by id and index per-node metadata.
  const seen = new Set<string>();
  const uniqueNodes: SlotLayoutNode[] = [];
  const widthById = new Map<string, number>();
  const heightById = new Map<string, number>();
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    uniqueNodes.push(n);
    if (typeof n.width === 'number' && Number.isFinite(n.width) && n.width > 0) {
      widthById.set(n.id, n.width);
    }
    if (typeof n.height === 'number' && Number.isFinite(n.height) && n.height > 0) {
      heightById.set(n.id, n.height);
    }
  }

  // Effective entries = nodes marked isEntry plus the explicit set.
  const effectiveEntries = new Set<string>();
  for (const n of uniqueNodes) {
    if (n.isEntry === true) effectiveEntries.add(n.id);
  }
  for (const id of entryIds) {
    if (seen.has(id)) effectiveEntries.add(id);
  }

  // Adjacency lists.
  const adj = new Map<string, string[]>();
  const radj = new Map<string, string[]>();
  for (const e of edges) {
    if (!seen.has(e.source) || !seen.has(e.target)) continue;
    let a = adj.get(e.source);
    if (a === undefined) {
      a = [];
      adj.set(e.source, a);
    }
    a.push(e.target);
    let b = radj.get(e.target);
    if (b === undefined) {
      b = [];
      radj.set(e.target, b);
    }
    b.push(e.source);
  }

  // BFS — first-visit wins, encodes min canonical depth.
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const id of effectiveEntries) {
    depth.set(id, 0);
    queue.push(id);
  }
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    const d = depth.get(cur) as number;
    const children = adj.get(cur);
    if (children === undefined) continue;
    for (const child of children) {
      if (depth.has(child)) continue;
      depth.set(child, d + 1);
      queue.push(child);
    }
  }

  // Resolve every node to its lane.
  const laneInput: LaneInputNode[] = uniqueNodes.map((n) => ({
    id: n.id,
    package: n.package,
    depth: depth.get(n.id),
  }));
  const resolution = resolveLanes(laneInput, state);

  // Pre-compute per-lane node order. We pick the same "barycenter against
  // previous slot" heuristic as the legacy positioner so a manual rearrange
  // still reads top-to-bottom by parent y.
  //
  // Build a map slotIndex → array of (laneKey, ids) preserving lane stack
  // order within the slot. Lanes that exist in the resolution but the user
  // moved out of every slot keep slotIndex = -1 and fall into the dead grid
  // below.
  type SlotBucket = {
    slotIndex: number;
    lanes: Array<{ laneKey: string; nodeIds: string[] }>;
  };
  const bySlot = new Map<number, SlotBucket>();
  // Track lane key → stackIndex so lane order inside the slot matches what
  // the user set up in the editor.
  for (const slotIndex of Array.from(
    new Set(Array.from(resolution.byNode.values()).map((a) => a.slotIndex)),
  ).sort((a, b) => a - b)) {
    if (slotIndex < 0) continue;
    bySlot.set(slotIndex, { slotIndex, lanes: [] });
  }
  // Populate using the editor state's lane ordering inside each slot.
  state.slots.forEach((slot, slotIndex) => {
    if (slot.lanes.length === 0) return;
    let bucket = bySlot.get(slotIndex);
    if (bucket === undefined) {
      bucket = { slotIndex, lanes: [] };
      bySlot.set(slotIndex, bucket);
    }
    for (const lane of slot.lanes) {
      const key = laneKeyOf(lane);
      const ids = resolution.nodesByLaneKey.get(key) ?? [];
      bucket.lanes.push({ laneKey: key, nodeIds: ids.slice() });
    }
  });

  // Sort slot indices ascending for the left-to-right sweep.
  const slotIndices = Array.from(bySlot.keys()).sort((a, b) => a - b);

  const layerYById = new Map<string, number>();
  const xByLaneKey = new Map<string, number>(); // x of each lane's primary column

  // Sub-column gap function reused from the legacy positioner.
  const pairGap = (a: string, b: string): number => {
    const ha = heightById.get(a);
    const hb = heightById.get(b);
    if (ha === undefined && hb === undefined) return minNodeGap;
    const half = (ha ?? 0) / 2 + (hb ?? 0) / 2;
    return Math.max(minNodeGap, half + nodeBuffer);
  };

  // Helpful: previous-slot y for each node, for the barycenter pass.
  const prevSlotYOf = (id: string): number | undefined => layerYById.get(id);

  // Vertical band per slot is the full canvas minus padding. Lanes within
  // the slot split that band proportionally to node count (≥ 1).
  const usable = Math.max(120, canvasHeight - 2 * topPadding);

  for (const slotIndex of slotIndices) {
    const bucket = bySlot.get(slotIndex);
    if (bucket === undefined) continue;
    const slotX = topPadding + slotIndex * layerGap;

    // Skip slots with no live lanes.
    const liveLanes = bucket.lanes.filter((l) => l.nodeIds.length > 0);
    if (liveLanes.length === 0) {
      continue;
    }

    // Allocate vertical bands proportional to lane size.
    const totalNodes = liveLanes.reduce((s, l) => s + l.nodeIds.length, 0);
    let yCursor = topPadding;
    for (const laneInfo of liveLanes) {
      const share = laneInfo.nodeIds.length / totalNodes;
      const bandHeight = Math.max(minNodeGap, usable * share);
      // Within the lane, sort by barycenter of parents whose y was already set
      // (i.e. in an earlier slotIndex). Fall back to alphabetical.
      const ids = laneInfo.nodeIds;
      const barycenter = new Map<string, number>();
      for (const id of ids) {
        const parents = radj.get(id) ?? [];
        let sum = 0;
        let count = 0;
        for (const p of parents) {
          const py = prevSlotYOf(p);
          if (py === undefined) continue;
          // Only consider parents from a STRICTLY EARLIER slot to keep
          // determinism and reflect the left-to-right flow.
          const parentAssignment = resolution.byNode.get(p);
          if (parentAssignment === undefined) continue;
          if (parentAssignment.slotIndex >= slotIndex) continue;
          sum += py;
          count += 1;
        }
        if (count > 0) {
          barycenter.set(id, sum / count);
        }
      }
      ids.sort((a, b) => {
        const ba = barycenter.get(a);
        const bb = barycenter.get(b);
        if (ba === undefined && bb === undefined) return a < b ? -1 : a > b ? 1 : 0;
        if (ba === undefined) return 1;
        if (bb === undefined) return -1;
        if (ba !== bb) return ba - bb;
        return a < b ? -1 : a > b ? 1 : 0;
      });

      // Multi-column wrap. baseColumnSize keeps the layout symmetric.
      const layerSize = ids.length;
      const columnCount = Math.max(1, Math.ceil(layerSize / maxNodesPerColumn));
      const baseColumnSize = Math.ceil(layerSize / columnCount);

      for (let col = 0; col < columnCount; col += 1) {
        const start = col * baseColumnSize;
        const end = Math.min(layerSize, start + baseColumnSize);
        const colIds = ids.slice(start, end);
        if (colIds.length === 0) continue;

        const offsets: number[] = [0];
        for (let i = 1; i < colIds.length; i += 1) {
          const prev = colIds[i - 1] as string;
          const cur = colIds[i] as string;
          offsets.push((offsets[i - 1] as number) + pairGap(prev, cur));
        }
        const totalHeight = offsets[offsets.length - 1] ?? 0;

        const bandMid = yCursor + bandHeight / 2;
        const firstHalf = (heightById.get(colIds[0] as string) ?? 0) / 2;
        const lastHalf = (heightById.get(colIds[colIds.length - 1] as string) ?? 0) / 2;
        const topEdge = yCursor + firstHalf;
        const bottomEdge = yCursor + bandHeight - lastHalf;
        let y0 = bandMid - totalHeight / 2;
        if (y0 < topEdge) y0 = topEdge;
        if (y0 + totalHeight > bottomEdge) {
          y0 = Math.max(topEdge, bottomEdge - totalHeight);
        }

        const x = slotX + col * columnGap;
        if (col === 0) {
          xByLaneKey.set(laneInfo.laneKey, x);
        }
        colIds.forEach((id, idx) => {
          const y = y0 + (offsets[idx] as number);
          out.set(id, { x, y });
          layerYById.set(id, y);
        });
      }

      yCursor += bandHeight;
    }
  }

  // Dead region: nodes that ended up with slotIndex === -1 (no folder match,
  // no BFS lane in any slot, or unreachable) go below the reachable bbox.
  const deadIds: string[] = [];
  for (const n of uniqueNodes) {
    const a = resolution.byNode.get(n.id);
    if (a === undefined || a.slotIndex < 0) {
      deadIds.push(n.id);
    }
  }
  if (deadIds.length > 0) {
    let maxX = -Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    for (const p of out.values()) {
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
      if (p.x < minX) minX = p.x;
    }
    if (!Number.isFinite(maxX)) maxX = topPadding;
    if (!Number.isFinite(maxY)) maxY = topPadding;
    if (!Number.isFinite(minX)) minX = topPadding;
    const ox = minX + deadDx;
    const oy = maxY + deadDy;
    layoutDeadRegion(deadIds, out, ox, oy, minNodeGap);
  }

  return { positions: out, resolution, bfsDepths: depth };
}

function layoutDeadRegion(
  ids: readonly string[],
  out: Map<string, SlotLayoutPosition>,
  ox: number,
  oy: number,
  minNodeGap: number,
): void {
  if (ids.length === 0) return;
  const sorted = [...ids].sort();
  const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
  const gap = Math.max(60, minNodeGap * 0.6);
  sorted.forEach((id, idx) => {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    out.set(id, { x: ox + c * gap, y: oy + r * gap });
  });
}
