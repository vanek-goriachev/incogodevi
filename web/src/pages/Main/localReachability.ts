/**
 * Pure-frontend reachability fallback for re-analyze flows.
 *
 * Background: `docs/tech-debt.md` documents an open issue where a second
 * `POST /analyze` against a cached project returns an empty graph. Until the
 * orchestrator is fixed, this helper lets the entry-points panel still
 * deliver the J2 user journey ("change entry points → graph re-colours")
 * by recomputing reachability locally instead of trusting the empty server
 * response.
 *
 * The local computation is intentionally simpler than the backend:
 *
 *   - Only `is_entry` flips and `reachable` flips are mutated. Edges,
 *     packages and structural classifications are left untouched because
 *     the reachability question is the only thing the user changed.
 *   - Reachability follows outgoing `calls`, `contains`, `embeds`,
 *     `references` and `implements` edges — the same edge kinds the
 *     `ReachabilityAnalyzer` walks (architecture.md §4 "ReachabilityKinds").
 *   - Auto-mode `func main` detection mimics `EntryPointsResolver`: any node
 *     of kind `func` named exactly `main` whose package name is the last
 *     segment of an importable `cmd/...` path is considered a main.
 *     The exact heuristic is best-effort — false positives only widen the
 *     reachable set, which is the safe direction for the fallback.
 */

import type { EntryPointSpec, Graph, Node } from '../../api/types';
import { nodeToFqn } from './panels/fqn';

/** Edge kinds that propagate reachability. */
const REACH_EDGE_KINDS: ReadonlySet<string> = new Set([
  'calls',
  'contains',
  'embeds',
  'references',
  'implements',
]);

/**
 * Recompute `is_entry` and `reachable` flags from `spec` and return a fresh
 * graph snapshot. Returns the original graph reference when nothing changed
 * so React can short-circuit with `Object.is`.
 */
export function recomputeReachability(graph: Graph, spec: EntryPointSpec): Graph {
  const entryIds = pickEntryIds(graph, spec);
  if (entryIds.size === 0) {
    return rebuildGraph(graph, entryIds, new Set());
  }
  const adjacency = buildAdjacency(graph);
  const reachable = bfs(entryIds, adjacency);
  return rebuildGraph(graph, entryIds, reachable);
}

/** Pick the set of entry-point node ids from `spec`. */
function pickEntryIds(graph: Graph, spec: EntryPointSpec): Set<string> {
  const out = new Set<string>();
  const autoOn = (spec.mode === 'auto' || spec.mode === 'mixed') && spec.auto_kinds.includes('main');
  if (autoOn) {
    for (const node of graph.nodes) {
      if (isLikelyMain(node)) {
        out.add(node.id);
      }
    }
  }
  if (spec.manual.length > 0) {
    const manual = new Set(spec.manual);
    for (const node of graph.nodes) {
      const fqn = nodeToFqn(node, graph);
      if (fqn !== null && manual.has(fqn)) {
        out.add(node.id);
      }
    }
  }
  return out;
}

/** True for `func main` nodes living in any package. */
function isLikelyMain(node: Node): boolean {
  return node.kind === 'func' && node.name === 'main';
}

/** Build an outgoing adjacency map keyed by node id. */
function buildAdjacency(graph: Graph): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!REACH_EDGE_KINDS.has(edge.kind)) {
      continue;
    }
    const list = map.get(edge.source);
    if (list === undefined) {
      map.set(edge.source, [edge.target]);
    } else {
      list.push(edge.target);
    }
  }
  return map;
}

/** Standard BFS — returns every reachable id, including the seeds. */
function bfs(seeds: ReadonlySet<string>, adjacency: ReadonlyMap<string, readonly string[]>): Set<string> {
  const visited = new Set<string>(seeds);
  const queue: string[] = Array.from(seeds);
  while (queue.length > 0) {
    const head = queue.shift() as string;
    const neighbours = adjacency.get(head);
    if (neighbours === undefined) {
      continue;
    }
    for (const next of neighbours) {
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      queue.push(next);
    }
  }
  return visited;
}

/** Compose the new `Graph` snapshot — flips `is_entry` and `reachable`. */
function rebuildGraph(
  graph: Graph,
  entryIds: ReadonlySet<string>,
  reachable: ReadonlySet<string>,
): Graph {
  let mutated = false;
  const nodes: Node[] = graph.nodes.map((node) => {
    const wantEntry = entryIds.has(node.id);
    const wantReach = reachable.has(node.id) || entryIds.has(node.id);
    if (node.is_entry === wantEntry && node.reachable === wantReach) {
      return node;
    }
    mutated = true;
    return { ...node, is_entry: wantEntry, reachable: wantReach };
  });
  if (!mutated) {
    return graph;
  }
  const deadCount = nodes.filter((n) => !n.reachable).length;
  return {
    ...graph,
    nodes,
    stats: {
      ...graph.stats,
      dead_count: deadCount,
    },
  };
}
