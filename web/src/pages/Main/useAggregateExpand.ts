/**
 * Double-click "expand package" hook for the aggregated graph view (T24).
 *
 * When the backend returns a package-aggregated snapshot (FR-18: graphs above
 * 1 000 nodes), each package is collapsed into a single node with `kind ==
 * "package"`. Double-tapping such a node fires `GET /graph?scope=<pkg>` which
 * returns the detailed sub-graph for that one package (api-contract §3); the
 * hook then swaps the package node out for its children and runs an
 * incremental fcose layout that pins the surrounding still-aggregated
 * neighbours so they do not jump around.
 *
 * State is intentionally local: the hook does not persist the expanded set
 * because re-runs of `/analyze` invalidate IDs (ADR-07 keeps them stable
 * across runs but the topology can change). It does, however, debounce
 * repeated double-clicks on the same package so a slow HTTP round-trip is
 * not amplified into a stack of overlapping layouts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Core,
  ElementDefinition,
  EventObject,
  LayoutOptions,
  NodeSingular,
} from 'cytoscape';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/client';
import type { Edge, Node } from '../../api/types';

/** Maximum number of packages allowed to be expanded at once (NFR-03). */
export const EXPAND_LIMIT = 3;

export interface UseAggregateExpandOptions {
  apiClient: ApiClient;
  /** Project id whose graph is currently rendered. */
  projectId: string | undefined;
  /** Live Cytoscape core; the hook is a no-op while it is null. */
  cy: Core | null;
  /**
   * Aggregation mode of the current snapshot. Expansion is only wired up
   * when the server returned a package-aggregated graph; otherwise the
   * double-click handler short-circuits.
   */
  aggregation: 'none' | 'package' | undefined;
  /** Reduce-motion preference; disables fcose animation when true. */
  reducedMotion: boolean;
  /**
   * Surface user-facing error text (toast). The hook produces friendly
   * single-line messages that map api-contract error codes to plain English.
   */
  onError?: (message: string) => void;
  /**
   * Surface a non-blocking informational toast (e.g. "limit reached"). When
   * omitted the hook stays silent.
   */
  onInfo?: (message: string) => void;
}

export interface UseAggregateExpandApi {
  /**
   * Set of package paths that have been expanded so far on the current
   * graph snapshot. Read-only; consumers should not mutate it.
   */
  expandedPackages: ReadonlySet<string>;
  /**
   * Imperative escape hatch for tests / context-menu actions. Returns a
   * promise that resolves once the expansion finishes (success or error).
   */
  expand: (packagePath: string) => Promise<void>;
}

/**
 * Wire `cy.dbltap` on package nodes to the expand flow. Returns the live
 * set of already-expanded package paths plus an imperative trigger.
 */
export function useAggregateExpand(
  options: UseAggregateExpandOptions,
): UseAggregateExpandApi {
  const {
    apiClient,
    projectId,
    cy,
    aggregation,
    reducedMotion,
    onError,
    onInfo,
  } = options;

  const [expandedPackages, setExpandedPackages] = useState<Set<string>>(
    () => new Set<string>(),
  );

  // Snapshot the latest non-React state in refs so the dbltap handler stays
  // stable across renders and never reads a stale closure.
  const expandedRef = useRef<Set<string>>(expandedPackages);
  expandedRef.current = expandedPackages;
  const inFlightRef = useRef<Set<string>>(new Set<string>());

  // Reset the expansion set whenever the snapshot identity changes (project
  // switch, re-analyze, aggregation flip). Every fresh graph starts clean.
  useEffect(() => {
    setExpandedPackages(new Set<string>());
    inFlightRef.current.clear();
  }, [projectId, aggregation]);

  const expand = useCallback(
    async (packagePath: string): Promise<void> => {
      if (cy === null || projectId === undefined || projectId === '') {
        return;
      }
      if (aggregation !== 'package') {
        return;
      }
      if (packagePath === '') {
        return;
      }
      if (expandedRef.current.has(packagePath) || inFlightRef.current.has(packagePath)) {
        return;
      }
      if (expandedRef.current.size >= EXPAND_LIMIT) {
        if (onInfo !== undefined) {
          onInfo(`Already expanded ${String(EXPAND_LIMIT)} packages; collapse one to expand another.`);
        }
        return;
      }
      inFlightRef.current.add(packagePath);
      try {
        const detail = await apiClient.getGraph(projectId, { scope: packagePath });
        applyExpansion(cy, packagePath, detail.nodes, detail.edges, reducedMotion);
        setExpandedPackages((prev) => {
          if (prev.has(packagePath)) {
            return prev;
          }
          const next = new Set(prev);
          next.add(packagePath);
          return next;
        });
      } catch (err) {
        if (onError !== undefined) {
          onError(messageForError(err, packagePath));
        }
      } finally {
        inFlightRef.current.delete(packagePath);
      }
    },
    [apiClient, projectId, cy, aggregation, reducedMotion, onError, onInfo],
  );

  // Subscribe to dbltap on package nodes. We rebind on every cy / aggregation
  // change so the handler always sees the right `expand` closure.
  useEffect(() => {
    if (cy === null) {
      return undefined;
    }
    if (aggregation !== 'package') {
      return undefined;
    }
    const handler = (evt: EventObject): void => {
      const node = evt.target as NodeSingular;
      const pkg = (node.data('package') as string | undefined) ?? '';
      if (pkg === '') {
        return;
      }
      void expand(pkg);
    };
    cy.on('dbltap', 'node[kind="package"]', handler);
    return () => {
      cy.off('dbltap', 'node[kind="package"]', handler);
    };
  }, [cy, aggregation, expand]);

  return { expandedPackages, expand };
}

/**
 * Replace `packagePath`'s aggregated node with the detailed sub-graph and
 * run an incremental fcose layout. Pre-existing nodes outside the new
 * sub-graph stay locked so the user does not lose their mental map.
 */
function applyExpansion(
  cy: Core,
  packagePath: string,
  nodes: Node[],
  edges: Edge[],
  reducedMotion: boolean,
): void {
  if (nodes.length === 0) {
    // Nothing to add — the package is empty after filtering. Just drop the
    // aggregated node so the user sees the gesture took effect.
    cy.batch(() => {
      cy.nodes(`node[package="${cssEscape(packagePath)}"][kind="package"]`).remove();
    });
    return;
  }

  // Use the aggregated node's centre as the seed position so the new sub-
  // graph appears where the user clicked rather than off-screen.
  const aggregated = cy.nodes(`node[package="${cssEscape(packagePath)}"][kind="package"]`);
  const seed = aggregated.nonempty() ? aggregated.first().position() : { x: 0, y: 0 };

  const additions: ElementDefinition[] = [];
  const newIds = new Set<string>();
  for (const node of nodes) {
    if (cy.$id(node.id).nonempty()) {
      // The node is already on the canvas — usually an entry-point node that
      // belongs to several packages. Skip the duplicate insert; let the
      // incoming `data()` win below.
      cy.$id(node.id).data(node as unknown as Record<string, unknown>);
      continue;
    }
    additions.push({
      group: 'nodes',
      data: node as unknown as Record<string, unknown>,
      classes: classesFor(node),
      position: { x: seed.x, y: seed.y },
    });
    newIds.add(node.id);
  }
  for (const edge of edges) {
    if (cy.$id(edge.id).nonempty()) {
      continue;
    }
    additions.push({
      group: 'edges',
      data: edge as unknown as Record<string, unknown>,
    });
  }

  cy.batch(() => {
    aggregated.remove();
    if (additions.length > 0) {
      cy.add(additions);
    }
  });

  if (newIds.size === 0) {
    return;
  }

  // Lock the surrounding still-aggregated neighbours so the layout only
  // shuffles the freshly inserted children. fcose honours `lock()`
  // automatically because locked nodes are treated as `fixedNodeConstraint`.
  let newCollection = cy.collection();
  for (const id of newIds) {
    newCollection = newCollection.union(cy.$id(id));
  }
  const others = cy.nodes().difference(newCollection);
  others.lock();
  try {
    const layoutOpts: LayoutOptions = reducedMotion
      ? ({
          name: 'fcose',
          animate: false,
          randomize: false,
          quality: 'default',
          nodeRepulsion: 4500,
          idealEdgeLength: 80,
          fit: false,
        } as unknown as LayoutOptions)
      : ({
          name: 'fcose',
          animate: 'end',
          animationDuration: 350,
          randomize: false,
          quality: 'default',
          nodeRepulsion: 4500,
          idealEdgeLength: 80,
          fit: false,
        } as unknown as LayoutOptions);
    try {
      cy.layout(layoutOpts).run();
    } catch {
      // fcose may not be registered (tests with a stripped-down core); the
      // elements are already inserted at the seed position so a failing
      // layout is non-fatal.
    }
  } finally {
    others.unlock();
  }
}

/** Compute the list of CSS classes attached to a node. Mirrors GraphCanvas. */
function classesFor(node: Node): string {
  const classes: string[] = [];
  if (!node.reachable) {
    classes.push('dead');
  }
  if (node.is_entry) {
    classes.push('entry');
  }
  return classes.join(' ');
}

/**
 * Translate an unknown error from `apiClient.getGraph` into a user-facing
 * line. `invalid_scope` is the only path the user actively triggered; the
 * rest map to the generic "failed to expand" wording from the task spec.
 */
function messageForError(err: unknown, packagePath: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_scope') {
      return `Package ${packagePath} not found in the current graph.`;
    }
    if (err.status >= 500 || err.code === 'network_error') {
      return `Failed to expand ${packagePath}; please retry.`;
    }
    return `Could not expand ${packagePath}: ${err.message}`;
  }
  return `Failed to expand ${packagePath}; please retry.`;
}

/**
 * Escape `value` for inline use inside a Cytoscape selector. Cytoscape uses
 * a CSS-like grammar where `/` and `.` are valid identifier characters but
 * must still be wrapped to avoid colliding with selector syntax.
 */
function cssEscape(value: string): string {
  return value.replace(/(["\\])/g, '\\$1');
}
