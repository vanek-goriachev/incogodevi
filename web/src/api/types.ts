/**
 * Shared API and domain types for the SPA.
 *
 * Mirrors `docs/api-contract.md` (envelope, endpoints) and the data model
 * from `docs/architecture.md` §4. Keep these in sync with the Go backend
 * (`server/internal/domain`).
 */

/** Eight node kinds produced by GraphBuilder (architecture §4). */
export type NodeKind =
  | 'package'
  | 'struct'
  | 'interface'
  | 'func'
  | 'method'
  | 'field'
  | 'var'
  | 'const';

/** Six edge kinds produced by GraphBuilder (architecture §4). */
export type EdgeKind =
  | 'imports'
  | 'contains'
  | 'calls'
  | 'embeds'
  | 'implements'
  | 'references';

export interface Node {
  id: string;
  name: string;
  kind: NodeKind;
  package: string;
  file: string;
  line: number;
  exported: boolean;
  reachable: boolean;
  is_entry: boolean;
  doc?: string;
  /**
   * Number of child symbols collapsed into this node when the graph view is
   * package-aggregated (ADR-06). Omitted for ordinary nodes; the backend sends
   * it only on aggregated package nodes.
   */
  child_count?: number;
  /**
   * True for nodes that belong to a package outside the user's main module
   * (stdlib or third-party deps loaded transitively via packages.Load
   * NeedDeps). Used to optionally hide such nodes via the Filters panel
   * and to short-circuit "expand" double-click on aggregated package nodes
   * that have no project symbols to scope into.
   */
  external?: boolean;
  /**
   * Number of unreachable children rolled up into a package-aggregated node
   * (R4-5). Populated by the backend only on aggregated `kind: package` nodes;
   * absent everywhere else. Used by the frontend to surface a partial-dead
   * marker without re-counting client-side.
   */
  dead_count?: number;
  /**
   * True when an aggregated package node owns at least one — but not all —
   * dead children (R4-5). The frontend renders these with an amber dashed
   * border so the package reads "contains dead code" without being demoted
   * to fully dead.
   */
  partial_dead?: boolean;
  /**
   * True when every child of an aggregated package node is dead (R4-5).
   * Renders with a heavier dashed border + faded fill.
   */
  fully_dead?: boolean;
}

export interface Edge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
}

export interface Warning {
  code: string;
  message: string;
  package?: string;
  file?: string;
}

export interface GraphStats {
  node_count: number;
  edge_count: number;
  by_kind: Partial<Record<NodeKind, number>>;
  dead_count: number;
}

export interface Graph {
  project_id: string;
  generated_at: string;
  aggregation: 'none' | 'package';
  stats: GraphStats;
  nodes: Node[];
  edges: Edge[];
  warnings: Warning[];
}

export interface DeadCodeEntry {
  kind: NodeKind;
  fqn: string;
  file: string;
  line: number;
  package: string;
  name: string;
  reason: string;
}

export interface DeadCodeReport {
  project_id: string;
  generated_at: string;
  entries_count: number;
  entries: DeadCodeEntry[];
}

export interface ProjectMeta {
  project_id: string;
  name: string;
  uploaded_at: string;
  size_bytes: number;
  file_count: number;
  expires_at: string;
}

/** Default kind set when Filters is omitted (api-contract §2 defaults). */
export const ALL_NODE_KINDS: readonly NodeKind[] = [
  'package',
  'struct',
  'interface',
  'func',
  'method',
  'field',
  'var',
  'const',
];

/** Edge kinds in their canonical render order (used by the legend panel). */
export const ALL_EDGE_KINDS: readonly EdgeKind[] = [
  'imports',
  'contains',
  'calls',
  'embeds',
  'implements',
  'references',
];

export interface Filters {
  include_kinds: NodeKind[];
  exclude_paths: string[];
  stdlib_exclude: boolean;
  test_exclude: boolean;
}

export type EntryPointMode = 'auto' | 'manual' | 'mixed';

export interface EntryPointSpec {
  mode: EntryPointMode;
  auto_kinds: string[];
  manual: string[];
  interface_impl: string[];
}

export type AnalysisPhase =
  | 'loading'
  | 'parsing'
  | 'building_graph'
  | 'reachability'
  | 'exporting'
  | 'done'
  | 'failed';

/** SSE event types emitted by AnalysisOrchestrator (api-contract §2). */
export type SSEEventType = 'phase' | 'partial_graph' | 'warning' | 'done';

export interface PhaseEvent {
  seq: number;
  phase: AnalysisPhase;
  progress?: number;
  message?: string;
}

export interface PartialGraphEvent {
  seq: number;
  nodes: Node[];
  edges: Edge[];
}

export interface WarningEvent extends Warning {
  seq: number;
}

export interface DoneEvent {
  seq: number;
  phase: 'done' | 'failed';
  node_count?: number;
  edge_count?: number;
  warnings_count?: number;
  elapsed_ms?: number;
  graph_url?: string;
  error?: ApiErrorPayload;
}

export interface HealthResponse {
  status: 'ok';
  version: string;
  uptime_sec: number;
  active_projects: number;
}

/** Error envelope returned by the backend on non-2xx responses. */
export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiErrorEnvelope {
  error: ApiErrorPayload;
}
