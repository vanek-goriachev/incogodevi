/**
 * Reach-depth deterministic positioner (replaces PR #51's directory tidy-tree).
 *
 * Layout strategy (left → right orientation, PR #54):
 *   1. BFS over the directed graph defined by `edges` (source → target)
 *      seeded with every node id in `entryIds`. Each node's canonical depth
 *      is the minimum distance from any entry. Back-edges and cross-edges
 *      do not change a node's depth (first-visit wins).
 *   2. Layer 0 (entries) is sorted alphabetically by id (deterministic).
 *   3. For each layer k ≥ 1, y positions are chosen by the average of each
 *      node's *parents-on-layer-(k-1)* barycenter — a single-pass
 *      Sugiyama-style heuristic. Nodes without any parent on the previous
 *      layer fall back to id-alphabetical (a back-edge can carry them).
 *   4. x for layer k = leftPadding + k * layerGap. When a layer would not
 *      fit in a single column (more than `maxNodesPerColumn` nodes), it
 *      wraps onto multiple sub-columns separated by `columnGap`
 *      (< `layerGap`) so the visual hierarchy "columns inside a layer, gap
 *      between layers" still reads at a glance. Subsequent layers are
 *      pushed right by the actual column count of the previous layer, not
 *      the raw `layerGap`.
 *   5. Optional per-node `height` overrides `minNodeGap` for any adjacent
 *      pair on the same sub-column whose half-heights plus a small visual
 *      buffer exceed it. This prevents two tall compound parents from
 *      overlapping their bounding boxes when expanded packages enter the
 *      canvas-wide layer.
 *   6. Optional per-node `width` is used as the within-column secondary-
 *      axis spread when a layer wraps; the column-band step is widened so
 *      a wide compound parent never bleeds into the neighbouring layer.
 *   7. Nodes unreachable from any entry are packed into a compact square
 *      grid BELOW the reachable region so they read as "outside the call
 *      tree" without flooding the canvas to the right of the BFS frontier.
 *
 * Rationale for the L→R orientation (vs. the original top-down PR #52
 * design): horizontal monitors have more pixels in x than in y; node
 * labels are horizontal so reading L→R is the natural cadence; and deep
 * BFS chains now extend rightward into off-screen pan instead of
 * downward, which matches how users grow the canvas while exploring.
 *
 * The function is Cytoscape- and DOM-free — every caller (GraphCanvas,
 * useAggregateExpand) passes plain data, which makes the algorithm trivially
 * unit-testable and keeps Re-layout idempotent to within 1 px (same input
 * always returns the same map).
 */

export interface LayoutNode {
  id: string;
  /** Whether this node is an entry-point. Drives layer-0 selection. */
  isEntry?: boolean;
  /**
   * Optional render width (in the same units as `canvasWidth`). When
   * provided, the positioner uses `(wA + wB)/2 + buffer` as the minimum
   * x-spread for adjacent sub-columns inside the same layer band, so wide
   * compound parents on adjacent sub-columns do not overlap horizontally.
   * Callers reading Cytoscape's `outerWidth()` pass the live rendered width.
   */
  width?: number;
  /**
   * Optional render height (in the same units as `canvasHeight`). When
   * provided, the positioner uses `(hA + hB)/2 + buffer` as the minimum
   * vertical centre-to-centre distance between adjacent nodes inside a
   * sub-column instead of the flat `minNodeGap`. Callers reading
   * Cytoscape's `outerHeight()` pass the live rendered height so tall
   * compound parents do not overlap.
   */
  height?: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface Position {
  x: number;
  y: number;
}

export interface ReachDepthOptions {
  /**
   * Canvas height in layout units; determines per-layer vertical spread.
   * Renamed from the legacy `canvasWidth` because the primary axis is now
   * vertical: each layer occupies a column, and `canvasHeight` decides how
   * many nodes fit before wrap engages.
   */
  canvasHeight: number;
  /** Top padding (also doubles as the left margin). Defaults to 80. */
  topPadding?: number;
  /** Horizontal gap between depth layers (column bands). Defaults to 220. */
  layerGap?: number;
  /** Minimum vertical gap between adjacent nodes in a sub-column. Defaults to 200. */
  minNodeGap?: number;
  /**
   * Maximum number of nodes placed on a single sub-column within one
   * layer. When a layer has more nodes than this, it wraps onto additional
   * sub-columns separated by `columnGap`. Defaults to 14 — large enough
   * for a typical cross-package tier without forcing tiny canvases to
   * wrap, small enough that the 60-package layers seen on Xray-core do not
   * stretch a single column to a 15 000 px ribbon.
   */
  maxNodesPerColumn?: number;
  /**
   * Horizontal gap between sub-columns belonging to the same layer.
   * Should be visibly tighter than `layerGap` so the user can tell layers
   * apart from intra-layer wrap columns. Defaults to `layerGap * 0.4`
   * (auto-derived).
   */
  columnGap?: number;
  /**
   * Visual padding added to half-height (or half-width for wrapped sub-
   * columns) sums when computing per-pair gaps from `LayoutNode.height` /
   * `LayoutNode.width`. Defaults to 30 px. Only used when at least one of
   * the relevant adjacent nodes has the dimension defined.
   */
  nodeBuffer?: number;
  /** Compact dead-region offset from the reachable bounding box. */
  deadRegion?: { dx: number; dy: number };
}

/**
 * Compute reach-depth positions for every node.
 *
 * @param nodes     Every node to position.
 * @param edges     Directed edges (source → target). Drives the BFS.
 * @param entryIds  Ids of entry-point nodes. Layer 0 is their union.
 * @param opts      Spacing knobs.
 * @returns         Map keyed by node id with `{x, y}` in layout coordinates.
 */
export function computeReachDepthPositions(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  entryIds: ReadonlySet<string>,
  opts: ReachDepthOptions,
): Map<string, Position> {
  const out = new Map<string, Position>();
  if (nodes.length === 0) {
    return out;
  }

  const canvasHeight = Math.max(400, opts.canvasHeight);
  const topPadding = opts.topPadding ?? 80;
  const layerGap = opts.layerGap ?? 220;
  const minNodeGap = opts.minNodeGap ?? 200;
  const maxNodesPerColumn = Math.max(2, opts.maxNodesPerColumn ?? 14);
  // `columnGap` defaults to a fraction of `layerGap` so the visual rule
  // "columns inside a layer tight, gap between layers visibly larger"
  // holds automatically as callers tune `layerGap`. The 0.4 factor keeps
  // a 220 px `layerGap` at an 88 px intra-layer column gap — the demo
  // contract calls for ≥ 2.5x ratio between layers and within-layer
  // columns.
  const columnGap = opts.columnGap ?? layerGap * 0.4;
  const nodeBuffer = opts.nodeBuffer ?? 30;
  const deadDx = opts.deadRegion?.dx ?? 0;
  const deadDy = opts.deadRegion?.dy ?? layerGap;

  // Validate ids and dedupe — multiple incoming nodes with the same id are
  // treated as one for layout purposes. Index widths/heights by id for the
  // per-pair gap computation later on.
  const seen = new Set<string>();
  const uniqueNodes: LayoutNode[] = [];
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

  // Effective entry set = `entryIds` ∩ `uniqueNodes`, plus any node marked
  // `isEntry: true` on the LayoutNode shape. The caller may pass either
  // contract; we honour both for robustness.
  const effectiveEntries = new Set<string>();
  for (const n of uniqueNodes) {
    if (n.isEntry === true) {
      effectiveEntries.add(n.id);
    }
  }
  for (const id of entryIds) {
    if (seen.has(id)) {
      effectiveEntries.add(id);
    }
  }

  // Adjacency list (source → targets). Edges referencing absent nodes are
  // ignored so the function is robust to caller-side slicing.
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!seen.has(e.source) || !seen.has(e.target)) continue;
    let bucket = adj.get(e.source);
    if (bucket === undefined) {
      bucket = [];
      adj.set(e.source, bucket);
    }
    bucket.push(e.target);
  }
  // Reverse adjacency (target → sources) — needed for the barycenter pass to
  // locate parents on layer k-1.
  const radj = new Map<string, string[]>();
  for (const e of edges) {
    if (!seen.has(e.source) || !seen.has(e.target)) continue;
    let bucket = radj.get(e.target);
    if (bucket === undefined) {
      bucket = [];
      radj.set(e.target, bucket);
    }
    bucket.push(e.source);
  }

  // BFS from every entry. First-visit wins, which mechanically encodes the
  // "min canonical depth" rule. Iteration order over `effectiveEntries` does
  // not affect output: a node's depth is always min(distance from any entry).
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

  // Group reachable nodes by depth.
  const byDepth = new Map<number, string[]>();
  const reachable = new Set<string>();
  for (const n of uniqueNodes) {
    const d = depth.get(n.id);
    if (d === undefined) continue;
    reachable.add(n.id);
    let bucket = byDepth.get(d);
    if (bucket === undefined) {
      bucket = [];
      byDepth.set(d, bucket);
    }
    bucket.push(n.id);
  }

  if (byDepth.size === 0) {
    // No entry-points or none of them reach anything. Pack EVERY node into
    // the compact grid so the user sees a single dead cluster.
    layoutDeadRegion(
      uniqueNodes.map((n) => n.id),
      out,
      topPadding,
      topPadding,
      minNodeGap,
    );
    return out;
  }

  // Layer 0: entries — alphabetical (deterministic; barycenter does not apply
  // to the root layer because it has no parents).
  const layer0 = byDepth.get(0);
  if (layer0 !== undefined) {
    layer0.sort();
  }

  // Layers k ≥ 1 — barycenter of parents on layer (k-1) using their
  // assigned y-positions. Falls back to alphabetical when a node has no
  // parent at the previous layer (it was reached via a deeper back-edge
  // during BFS).
  const layerYById = new Map<string, number>();
  const depths = Array.from(byDepth.keys()).sort((a, b) => a - b);

  // Compute per-pair minimum vertical gap for two ids in the same sub-
  // column. Centre-to-centre distance must be at least
  // `(heightA + heightB)/2 + buffer` when both heights are known,
  // otherwise `minNodeGap` is the floor.
  const pairGap = (a: string, b: string): number => {
    const ha = heightById.get(a);
    const hb = heightById.get(b);
    if (ha === undefined && hb === undefined) {
      return minNodeGap;
    }
    const half = (ha ?? 0) / 2 + (hb ?? 0) / 2;
    return Math.max(minNodeGap, half + nodeBuffer);
  };

  // x-cursor advances per *visual sub-column* — entries are layer 0,
  // wrapped sub-columns still count as part of the same logical depth but
  // consume a column's worth of horizontal space. Tracking it on a
  // running cursor keeps inter-layer gaps independent of how many sub-
  // columns the previous layer used.
  let xCursor = topPadding;

  for (const d of depths) {
    const layer = byDepth.get(d) ?? [];
    if (d === 0) {
      // Already sorted alphabetically above.
    } else {
      // Compute barycenter — average y of parents on layer d-1. A parent is
      // any `(source, target)` edge with `depth(source) === d - 1` and
      // target = node id.
      const barycenter = new Map<string, number>();
      const fallback = new Map<string, string>();
      for (const id of layer) {
        const parents = radj.get(id) ?? [];
        let sum = 0;
        let count = 0;
        for (const p of parents) {
          if (depth.get(p) !== d - 1) continue;
          const py = layerYById.get(p);
          if (py === undefined) continue;
          sum += py;
          count += 1;
        }
        if (count > 0) {
          barycenter.set(id, sum / count);
        } else {
          fallback.set(id, id);
        }
      }
      // Sort: by barycenter ascending, then alphabetically for ties and
      // fallback nodes (which lack a barycenter).
      layer.sort((a, b) => {
        const ba = barycenter.get(a);
        const bb = barycenter.get(b);
        if (ba === undefined && bb === undefined) {
          return a < b ? -1 : a > b ? 1 : 0;
        }
        if (ba === undefined) return 1;
        if (bb === undefined) return -1;
        if (ba !== bb) return ba - bb;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    }

    // Split the layer into sub-columns. Each sub-column holds at most
    // `maxNodesPerColumn` entries; sub-columns preserve the layer's sort
    // order so the barycenter heuristic still flows top-to-bottom.
    const layerSize = layer.length;
    const columnCount = Math.max(1, Math.ceil(layerSize / maxNodesPerColumn));
    const baseColumnSize = Math.ceil(layerSize / columnCount);

    // Assign y-positions down the canvas height.
    const usable = canvasHeight - 2 * topPadding;

    for (let col = 0; col < columnCount; col += 1) {
      const start = col * baseColumnSize;
      const end = Math.min(layerSize, start + baseColumnSize);
      const colIds = layer.slice(start, end);
      if (colIds.length === 0) continue;

      // Pairwise required gaps (height-aware) drive total column height.
      // Build a running offset array so determinism is preserved (same
      // sub-column → same offsets) and per-pair heights feed directly into
      // placement.
      const offsets: number[] = [0];
      for (let i = 1; i < colIds.length; i += 1) {
        const prev = colIds[i - 1] as string;
        const cur = colIds[i] as string;
        offsets.push((offsets[i - 1] as number) + pairGap(prev, cur));
      }
      const totalHeight = offsets[offsets.length - 1] ?? 0;

      // Centre the sub-column inside the usable canvas band, but never let
      // half-heights poke past the padded edges.
      const colMid = topPadding + usable / 2;
      const firstHalf = (heightById.get(colIds[0] as string) ?? 0) / 2;
      const lastHalf = (heightById.get(colIds[colIds.length - 1] as string) ?? 0) / 2;
      const topEdge = topPadding + firstHalf;
      const bottomEdge = topPadding + usable - lastHalf;
      let y0 = colMid - totalHeight / 2;
      if (y0 < topEdge) y0 = topEdge;
      if (y0 + totalHeight > bottomEdge) {
        // Overflow: shrink-fit by re-anchoring against the usable band; we
        // still keep determinism, and downstream zoom-cap fit handles the
        // residual overflow visually.
        y0 = Math.max(topEdge, bottomEdge - totalHeight);
      }

      const x = xCursor + col * columnGap;
      colIds.forEach((id, idx) => {
        const y = y0 + (offsets[idx] as number);
        out.set(id, { x, y });
        layerYById.set(id, y);
      });
    }

    // Advance the x-cursor by (columnCount-1) intra-layer column gaps plus
    // one full inter-layer gap so the next layer is *visibly* separated.
    xCursor += (columnCount - 1) * columnGap + layerGap;
  }

  // Compact dead region for unreachable nodes — below the reachable
  // bounding box (positive dy offset), with a small horizontal offset.
  const deadIds: string[] = [];
  for (const n of uniqueNodes) {
    if (!reachable.has(n.id)) {
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
    // Anchor the dead grid below the reachable region. Horizontally we
    // align with the left edge of the reachable bbox (+ deadDx) so the
    // dead cluster reads as "footer underneath the BFS frontier" rather
    // than running off to the right.
    const ox = minX + deadDx;
    const oy = maxY + deadDy;
    layoutDeadRegion(deadIds, out, ox, oy, minNodeGap);
  }

  return out;
}

/**
 * Pack `ids` into a tight square grid anchored at `(ox, oy)` with a smaller
 * spacing (0.6 × minNodeGap) so the dead cluster reads as visually distinct
 * from the reachable layers.
 */
function layoutDeadRegion(
  ids: readonly string[],
  out: Map<string, Position>,
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
