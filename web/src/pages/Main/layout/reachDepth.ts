/**
 * Reach-depth deterministic positioner (replaces PR #51's directory tidy-tree).
 *
 * Layout strategy:
 *   1. BFS over the directed graph defined by `edges` (source → target)
 *      seeded with every node id in `entryIds`. Each node's canonical depth
 *      is the minimum distance from any entry. Back-edges and cross-edges
 *      do not change a node's depth (first-visit wins).
 *   2. Layer 0 (entries) is sorted alphabetically by id (deterministic).
 *   3. For each layer k ≥ 1, x positions are chosen by the average of each
 *      node's *parents-on-layer-(k-1)* barycenter — i.e. the single-pass
 *      Sugiyama-style heuristic. Nodes without any parent on the previous
 *      layer fall back to id-alphabetical (a back-edge can carry them).
 *   4. y for layer k = topPadding + k * layerGap. When a layer would not
 *      fit on a single row (more than `maxNodesPerRow` nodes), it wraps
 *      onto multiple rows separated by `rowGap` (< `layerGap`) so the
 *      visual hierarchy "rows inside a layer, gap between layers" still
 *      reads at a glance. Subsequent layers are pushed down by the actual
 *      row count of the previous layer, not the raw `layerGap`.
 *   5. Optional per-node `width` overrides `minNodeGap` for any adjacent
 *      pair whose half-widths plus a small visual buffer exceed it. This
 *      prevents two wide compound parents from overlapping their bounding
 *      boxes when expanded packages enter the canvas-wide layer.
 *   6. Nodes unreachable from any entry are packed into a compact square
 *      grid in the lower-right of the reachable region so they read as
 *      "outside the call tree" without flooding the canvas.
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
   * horizontal centre-to-centre distance between adjacent nodes instead of
   * the flat `minNodeGap`. Callers reading Cytoscape's `outerWidth()` pass
   * the live rendered width so wide compound parents do not overlap.
   */
  width?: number;
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
  /** Canvas width in layout units; determines per-layer horizontal spread. */
  canvasWidth: number;
  /** Top padding (also doubles as the left margin). Defaults to 80. */
  topPadding?: number;
  /** Vertical gap between depth layers. Defaults to 180. */
  layerGap?: number;
  /** Minimum horizontal gap between adjacent nodes on a layer. Defaults to 200. */
  minNodeGap?: number;
  /**
   * Maximum number of nodes placed on a single row within one layer. When a
   * layer has more nodes than this, the row wraps onto additional sub-rows
   * separated by `rowGap`. Defaults to 14 — large enough for a typical
   * cross-package tier without forcing tiny canvases to wrap, small enough
   * that the 60-package layers seen on Xray-core do not stretch out to a
   * 15 000 px ribbon.
   */
  maxNodesPerRow?: number;
  /**
   * Vertical gap between sub-rows belonging to the same layer. Should be
   * visibly tighter than `layerGap` so the user can tell layers apart from
   * intra-layer wrap rows. Defaults to `layerGap * 0.4` (auto-derived).
   */
  rowGap?: number;
  /**
   * Visual padding added to half-width sums when computing per-pair gaps
   * from `LayoutNode.width`. Defaults to 30 px. Only used when at least
   * one of the adjacent nodes has a defined `width`.
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

  const canvasWidth = Math.max(400, opts.canvasWidth);
  const topPadding = opts.topPadding ?? 80;
  const layerGap = opts.layerGap ?? 180;
  const minNodeGap = opts.minNodeGap ?? 200;
  const maxNodesPerRow = Math.max(2, opts.maxNodesPerRow ?? 14);
  // `rowGap` defaults to a fraction of `layerGap` so the visual rule
  // "rows inside a layer tight, gap between layers visibly larger" holds
  // automatically as callers tune `layerGap`. The 0.4 factor keeps a
  // 200 px `layerGap` at a 80 px intra-layer row gap — the demo contract
  // calls for ≥ 2.5x ratio between layers and within-layer rows.
  const rowGap = opts.rowGap ?? layerGap * 0.4;
  const nodeBuffer = opts.nodeBuffer ?? 30;
  const deadDx = opts.deadRegion?.dx ?? 120;
  const deadDy = opts.deadRegion?.dy ?? 120;

  // Validate ids and dedupe — multiple incoming nodes with the same id are
  // treated as one for layout purposes. Index widths by id for the
  // per-pair gap computation later on.
  const seen = new Set<string>();
  const uniqueNodes: LayoutNode[] = [];
  const widthById = new Map<string, number>();
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    uniqueNodes.push(n);
    if (typeof n.width === 'number' && Number.isFinite(n.width) && n.width > 0) {
      widthById.set(n.id, n.width);
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

  // Layers k ≥ 1 — barycenter of parents on layer (k-1). Falls back to
  // alphabetical when a node has no parent at the previous layer (it was
  // reached via a deeper back-edge during BFS).
  const layerXById = new Map<string, number>();
  const depths = Array.from(byDepth.keys()).sort((a, b) => a - b);

  // Compute per-pair minimum gap for two ids on the same row. Centre-to-
  // centre distance must be at least `(widthA + widthB)/2 + buffer` when
  // both widths are known, otherwise `minNodeGap` is the floor.
  const pairGap = (a: string, b: string): number => {
    const wa = widthById.get(a);
    const wb = widthById.get(b);
    if (wa === undefined && wb === undefined) {
      return minNodeGap;
    }
    const half = (wa ?? 0) / 2 + (wb ?? 0) / 2;
    return Math.max(minNodeGap, half + nodeBuffer);
  };

  // y-cursor advances per *visual row* — entries are layer 0, wrapped sub-
  // rows still count as part of the same logical depth but consume a row's
  // worth of vertical space. Tracking it on a running cursor keeps inter-
  // layer gaps independent of how many sub-rows the previous layer used.
  let yCursor = topPadding;

  for (const d of depths) {
    const layer = byDepth.get(d) ?? [];
    if (d === 0) {
      // Already sorted alphabetically above.
    } else {
      // Compute barycenter — average x of parents on layer d-1. A parent is
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
          const px = layerXById.get(p);
          if (px === undefined) continue;
          sum += px;
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

    // Split the layer into rows. Each row holds at most `maxNodesPerRow`
    // entries; rows preserve the layer's sort order so the barycenter
    // heuristic still flows left-to-right.
    const layerSize = layer.length;
    const rowCount = Math.max(1, Math.ceil(layerSize / maxNodesPerRow));
    const baseRowSize = Math.ceil(layerSize / rowCount);

    // Assign x-positions across the canvas width.
    const usable = canvasWidth - 2 * topPadding;

    for (let row = 0; row < rowCount; row += 1) {
      const start = row * baseRowSize;
      const end = Math.min(layerSize, start + baseRowSize);
      const rowIds = layer.slice(start, end);
      if (rowIds.length === 0) continue;

      // Pairwise required gaps (width-aware) drive total row width. Build a
      // running offset array so determinism is preserved (same row → same
      // offsets) and per-pair widths feed directly into placement.
      const offsets: number[] = [0];
      for (let i = 1; i < rowIds.length; i += 1) {
        const prev = rowIds[i - 1] as string;
        const cur = rowIds[i] as string;
        offsets.push((offsets[i - 1] as number) + pairGap(prev, cur));
      }
      const totalWidth = offsets[offsets.length - 1] ?? 0;

      // Centre the row inside the usable canvas band, but never let
      // half-widths poke past the padded edges.
      const rowMid = topPadding + usable / 2;
      const firstHalf = (widthById.get(rowIds[0] as string) ?? 0) / 2;
      const lastHalf = (widthById.get(rowIds[rowIds.length - 1] as string) ?? 0) / 2;
      const leftEdge = topPadding + firstHalf;
      const rightEdge = topPadding + usable - lastHalf;
      let x0 = rowMid - totalWidth / 2;
      if (x0 < leftEdge) x0 = leftEdge;
      if (x0 + totalWidth > rightEdge) {
        // Overflow: shrink-fit by re-centering against the usable band; we
        // still keep determinism, and downstream zoom-cap fit handles the
        // residual overflow visually.
        x0 = Math.max(leftEdge, rightEdge - totalWidth);
      }

      const y = yCursor + row * rowGap;
      rowIds.forEach((id, idx) => {
        const x = x0 + (offsets[idx] as number);
        out.set(id, { x, y });
        layerXById.set(id, x);
      });
    }

    // Advance the y-cursor by (rowCount-1) intra-layer row gaps plus one
    // full inter-layer gap so the next layer is *visibly* separated.
    yCursor += (rowCount - 1) * rowGap + layerGap;
  }

  // Compact dead region for unreachable nodes — lower-right of the reachable
  // bounding box, with a small offset.
  const deadIds: string[] = [];
  for (const n of uniqueNodes) {
    if (!reachable.has(n.id)) {
      deadIds.push(n.id);
    }
  }
  if (deadIds.length > 0) {
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of out.values()) {
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(maxX)) maxX = topPadding;
    if (!Number.isFinite(maxY)) maxY = topPadding;
    const ox = maxX + deadDx;
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
