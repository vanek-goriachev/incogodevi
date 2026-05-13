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
 *        - x = prefix-sum of dynamic slot widths
 *          (`max(outerWidth) + intraSlotPadding` per slot, separated by
 *          `interSlotGap`).
 *        - the slot's vertical band is split among its stacked lanes
 *          according to ACTUAL lane heights — each lane consumes
 *          `sum(outerHeight) + (n-1)*minNodeGap` (or `max-column-height
 *          × column-count` when wrapped). Lane y-positions are prefix-sum
 *          starting at the slot's `topPadding`.
 *        - within each lane, nodes are placed via barycenter ordering
 *          against parents in the previous SLOT.
 *   4. Nodes unreachable from any entry AND not matched by a folder group
 *      are dropped into the same compact grid below the reachable region as
 *      in the legacy positioner.
 *
 * Determinism: same input → same output (≤1 px). The barycenter heuristic
 * runs in slot order, and ties break alphabetically, so the function is
 * idempotent. R8 invariant is preserved by callers — they pass only the
 * top-level (non-compound-child) nodes; scoped per-compound layouts continue
 * to run in `useAggregateExpand`.
 *
 * **Bug 1 fix (this PR — feat/overlap-presets-package-filter).** Before this
 * PR `slotLayout` placed every slot at a FIXED `slotIndex * layerGap` and
 * split a slot's vertical band proportionally to its node count. Expanded
 * compounds however have a width 2–3× the badge of an aggregated package
 * node and a height 4–10× a leaf, so their bounding boxes regularly
 * overlapped neighbours on both x and y. The new code reads per-node
 * `outerWidth/Height` via `opts.nodeDimensions` and lays out slots / lanes
 * by actual dimensions; the legacy fixed-grid behaviour stays available when
 * dimensions are not provided (back-compat for tests + callers).
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
  /**
   * Horizontal gap between slots when per-node dimensions are NOT supplied.
   * Defaults to 360. With dimensions, dynamic slot widths take over and
   * this is ignored in favour of `interSlotGap`.
   */
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
  /**
   * Per-node outer-bounding-box dimensions. When supplied, slot widths are
   * `max(width) + intraSlotPadding` for each slot and lane heights are
   * `sum(height) + (n-1)*minNodeGap` (capped at `maxLaneHeight`). Missing
   * entries fall back to a small default so a caller can pass a partial
   * map without crashing the layout.
   */
  nodeDimensions?: ReadonlyMap<string, { width: number; height: number }>;
  /** Horizontal padding inside a slot column. Defaults to 80. */
  intraSlotPadding?: number;
  /** Gap between adjacent slots (added on top of slot widths). Defaults to 120. */
  interSlotGap?: number;
  /**
   * Hard ceiling on per-lane height before sub-column wrapping engages
   * (independent of `maxNodesPerColumn`). Defaults to 1800.
   */
  maxLaneHeight?: number;
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

/** Default per-node footprint when no dimension is supplied for an id. */
const DEFAULT_NODE_WIDTH = 160;
const DEFAULT_NODE_HEIGHT = 60;

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
  const nodeBuffer = opts.nodeBuffer ?? 24;
  const intraSlotPadding = opts.intraSlotPadding ?? 80;
  const interSlotGap = opts.interSlotGap ?? 120;
  const maxLaneHeight = Math.max(400, opts.maxLaneHeight ?? 1800);
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
    // Per-node inline dims take precedence; fall back to the dimension map.
    if (typeof n.width === 'number' && Number.isFinite(n.width) && n.width > 0) {
      widthById.set(n.id, n.width);
    }
    if (typeof n.height === 'number' && Number.isFinite(n.height) && n.height > 0) {
      heightById.set(n.id, n.height);
    }
  }
  if (opts.nodeDimensions !== undefined) {
    for (const [id, dim] of opts.nodeDimensions.entries()) {
      if (!seen.has(id)) continue;
      if (!widthById.has(id) && Number.isFinite(dim.width) && dim.width > 0) {
        widthById.set(id, dim.width);
      }
      if (!heightById.has(id) && Number.isFinite(dim.height) && dim.height > 0) {
        heightById.set(id, dim.height);
      }
    }
  }
  const widthOf = (id: string): number => widthById.get(id) ?? DEFAULT_NODE_WIDTH;
  const heightOf = (id: string): number => heightById.get(id) ?? DEFAULT_NODE_HEIGHT;

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
    const half = heightOf(a) / 2 + heightOf(b) / 2;
    return Math.max(minNodeGap, half + nodeBuffer);
  };

  // Helpful: previous-slot y for each node, for the barycenter pass.
  const prevSlotYOf = (id: string): number | undefined => layerYById.get(id);

  // -------------------------------------------------------------------------
  // Pre-pass: compute the required width of every slot, sorted by slot index.
  // Without per-node dimensions we use the legacy fixed-pitch grid so existing
  // callers that don't measure their nodes keep behaviour parity.
  // -------------------------------------------------------------------------
  const hasDims = opts.nodeDimensions !== undefined;

  /** Required width per slotIndex; missing slot indices keep a default width. */
  const slotWidthByIndex = new Map<number, number>();
  for (const slotIndex of slotIndices) {
    const bucket = bySlot.get(slotIndex);
    if (bucket === undefined) continue;
    let maxW = 0;
    for (const laneInfo of bucket.lanes) {
      for (const id of laneInfo.nodeIds) {
        const w = widthOf(id);
        if (w > maxW) maxW = w;
      }
    }
    if (maxW === 0) maxW = DEFAULT_NODE_WIDTH;
    slotWidthByIndex.set(slotIndex, maxW + intraSlotPadding);
  }

  /**
   * Resolve a slot's left-edge x. With dimensions: prefix-sum of slot widths
   * + interSlotGap. Without: legacy fixed pitch `slotIndex * layerGap`.
   * Returns the CENTRE x of the slot column (so per-node positioning slots
   * the node centroid on the slot's centre).
   */
  const slotCentreX = (slotIndex: number): number => {
    if (!hasDims) {
      return topPadding + slotIndex * layerGap;
    }
    let cursor = topPadding;
    for (const idx of slotIndices) {
      const width = slotWidthByIndex.get(idx) ?? DEFAULT_NODE_WIDTH + intraSlotPadding;
      if (idx === slotIndex) {
        return cursor + width / 2;
      }
      cursor += width + interSlotGap;
    }
    // Fallback when slotIndex is not present in slotIndices (e.g. trailing
    // empty slot from the editor's "+ new slot" placeholder).
    return cursor;
  };

  for (const slotIndex of slotIndices) {
    const bucket = bySlot.get(slotIndex);
    if (bucket === undefined) continue;
    const slotX = slotCentreX(slotIndex);

    // Skip slots with no live lanes.
    const liveLanes = bucket.lanes.filter((l) => l.nodeIds.length > 0);
    if (liveLanes.length === 0) {
      continue;
    }

    // -----------------------------------------------------------------------
    // Per-lane height plan. Compute the actual height each lane will consume,
    // including multi-column wrap. This gives us prefix-sum lane y-positions
    // and avoids any reliance on the (often-degenerate) canvas height share.
    // -----------------------------------------------------------------------
    type LaneHeightPlan = {
      laneKey: string;
      nodeIds: string[];
      orderedIds: string[];
      columnCount: number;
      baseColumnSize: number;
      laneHeight: number;
    };
    const lanePlans: LaneHeightPlan[] = [];
    for (const laneInfo of liveLanes) {
      const ids = laneInfo.nodeIds;
      // Within the lane, sort by barycenter of parents whose y was already set
      // (i.e. in an earlier slotIndex). Fall back to alphabetical.
      const barycenter = new Map<string, number>();
      for (const id of ids) {
        const parents = radj.get(id) ?? [];
        let sum = 0;
        let count = 0;
        for (const p of parents) {
          const py = prevSlotYOf(p);
          if (py === undefined) continue;
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
      const orderedIds = ids.slice().sort((a, b) => {
        const ba = barycenter.get(a);
        const bb = barycenter.get(b);
        if (ba === undefined && bb === undefined) return a < b ? -1 : a > b ? 1 : 0;
        if (ba === undefined) return 1;
        if (bb === undefined) return -1;
        if (ba !== bb) return ba - bb;
        return a < b ? -1 : a > b ? 1 : 0;
      });

      // Decide column count: cap by maxNodesPerColumn AND by maxLaneHeight.
      let columnCount = Math.max(1, Math.ceil(orderedIds.length / maxNodesPerColumn));
      let baseColumnSize = Math.ceil(orderedIds.length / columnCount);

      const columnHeight = (size: number, startIdx: number): number => {
        if (size <= 0) return 0;
        let h = 0;
        for (let i = 0; i < size; i += 1) {
          const id = orderedIds[startIdx + i];
          if (id === undefined) continue;
          h += heightOf(id);
        }
        const gaps = size - 1 > 0 ? (size - 1) * minNodeGap : 0;
        return h + gaps;
      };
      const tallestColumn = (): number => {
        let h = 0;
        for (let c = 0; c < columnCount; c += 1) {
          const start = c * baseColumnSize;
          const end = Math.min(orderedIds.length, start + baseColumnSize);
          const colH = columnHeight(end - start, start);
          if (colH > h) h = colH;
        }
        return h;
      };
      // Grow columns until the tallest stays under maxLaneHeight or until each
      // column has just one node (the trivial wrap).
      while (
        tallestColumn() > maxLaneHeight &&
        columnCount < orderedIds.length
      ) {
        columnCount += 1;
        baseColumnSize = Math.ceil(orderedIds.length / columnCount);
      }
      const laneHeight = tallestColumn();
      lanePlans.push({
        laneKey: laneInfo.laneKey,
        nodeIds: ids,
        orderedIds,
        columnCount,
        baseColumnSize,
        laneHeight,
      });
    }

    // -----------------------------------------------------------------------
    // Place each lane top-down. y0 of the lane is the prefix-sum of preceding
    // lane heights + `minNodeGap` separators. canvasHeight only acts as a
    // hint for legacy callers — when dims are supplied we let the lane
    // stack grow naturally below `topPadding`.
    // -----------------------------------------------------------------------
    const usableLegacy = Math.max(120, canvasHeight - 2 * topPadding);
    const totalNodes = liveLanes.reduce((s, l) => s + l.nodeIds.length, 0);

    let yCursor = topPadding;
    lanePlans.forEach((plan, laneIdx) => {
      const laneCount = plan.orderedIds.length;
      const bandHeight = hasDims
        ? plan.laneHeight
        : Math.max(
            minNodeGap,
            (usableLegacy * laneCount) / Math.max(1, totalNodes),
          );

      const layerSize = plan.orderedIds.length;
      const columnCount = plan.columnCount;
      const baseColumnSize = plan.baseColumnSize;
      const slotWidth = slotWidthByIndex.get(slotIndex) ??
        DEFAULT_NODE_WIDTH + intraSlotPadding;

      for (let col = 0; col < columnCount; col += 1) {
        const start = col * baseColumnSize;
        const end = Math.min(layerSize, start + baseColumnSize);
        const colIds = plan.orderedIds.slice(start, end);
        if (colIds.length === 0) continue;

        const offsets: number[] = [0];
        for (let i = 1; i < colIds.length; i += 1) {
          const prev = colIds[i - 1] as string;
          const cur = colIds[i] as string;
          offsets.push((offsets[i - 1] as number) + pairGap(prev, cur));
        }
        const lastH = heightOf(colIds[colIds.length - 1] as string);
        const totalHeight = (offsets[offsets.length - 1] as number) + lastH;

        // Centre the sub-column inside the lane's band.
        const bandMid = yCursor + bandHeight / 2;
        let y0 = bandMid - totalHeight / 2 + heightOf(colIds[0] as string) / 2;

        // Distribute columns horizontally within the slot's width with a
        // narrower step than the slot itself so multiple columns can share
        // the slot without spilling into the next one.
        const usableWidth = Math.max(0, slotWidth - intraSlotPadding);
        const stepX = columnCount > 1
          ? Math.min(columnGap, usableWidth / Math.max(1, columnCount - 1))
          : 0;
        const colStartX = slotX - ((columnCount - 1) * stepX) / 2;
        const x = colStartX + col * stepX;

        if (col === 0) {
          xByLaneKey.set(plan.laneKey, x);
        }
        colIds.forEach((id, idx) => {
          const y = y0 + (offsets[idx] as number);
          out.set(id, { x, y });
          layerYById.set(id, y);
        });
      }

      // Step the y-cursor past this lane, leaving a small gap between lanes.
      yCursor += bandHeight + (laneIdx === lanePlans.length - 1 ? 0 : minNodeGap);
    });
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

  // Suppress unused-variable lint — kept for downstream callers that may
  // wish to inspect the lane → primary-column x map.
  void xByLaneKey;

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
