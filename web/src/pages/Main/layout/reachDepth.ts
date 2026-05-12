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
 *   4. y for layer k = topPadding + k * layerGap.
 *   5. Nodes unreachable from any entry are packed into a compact square
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
  const deadDx = opts.deadRegion?.dx ?? 120;
  const deadDy = opts.deadRegion?.dy ?? 120;

  // Validate ids and dedupe — multiple incoming nodes with the same id are
  // treated as one for layout purposes.
  const seen = new Set<string>();
  const uniqueNodes: LayoutNode[] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    uniqueNodes.push(n);
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

    // Assign x-positions across the canvas width.
    const usable = canvasWidth - 2 * topPadding;
    const layerSize = layer.length;
    const gap = layerSize <= 1 ? 0 : Math.max(usable / (layerSize - 1), minNodeGap);
    const totalWidth = gap * (layerSize - 1);
    const x0 = topPadding + (usable - totalWidth) / 2;
    const y = topPadding + d * layerGap;
    layer.forEach((id, idx) => {
      const x = x0 + idx * gap;
      out.set(id, { x, y });
      layerXById.set(id, x);
    });
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
