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
import { layoutOptionsFor } from './GraphCanvas';

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
  /**
   * Optional callback fired once after a successful expansion finishes
   * adding new nodes to the canvas (R4-3). Historically wired to the same
   * code path as the "Re-layout" button so the full canvas would re-flow
   * once new members landed — but that forced a `quality: 'proof'`,
   * `randomize: true` fcose pass over the whole ~700-node Xray canvas on
   * every double-click, producing multi-second freezes (R8 Task A).
   *
   * The option is kept so the "Collapse all" flow (which drops every
   * expanded member in one shot) can still request a fresh layout, but
   * `applyExpansion` no longer triggers it automatically. The scoped
   * expansion layout in this module places the new compound's children
   * locally; the surrounding canvas stays put.
   */
  onRequestRelayout?: () => void;
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
   * Issues a `level=struct` request — methods/fields stay hidden until the
   * user dbltaps a struct (see `expandStructMembers`).
   */
  expand: (packagePath: string) => Promise<void>;
  /**
   * Reveal the direct children of a struct/interface node already on the
   * canvas. The members are positioned in a tight ring around the struct
   * so the visual cluster stays cohesive. No-op when the node is not a
   * struct/interface or its members are already on the canvas.
   */
  expandStructMembers: (structId: string) => Promise<void>;
  /**
   * Undo a package expansion: remove every node whose `package` equals
   * `packagePath` and re-insert the aggregated single-package node at the
   * centroid of the removed cluster. No-op when the package was never
   * expanded.
   */
  collapsePackage: (packagePath: string) => void;
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
  // Cache of aggregated package nodes keyed by package path. Populated when
  // we expand a package; consumed by `collapsePackage` so the user can undo
  // the expansion without a re-fetch round-trip.
  const aggregatedCacheRef = useRef<Map<string, Node>>(new Map<string, Node>());
  // Track structs whose members have already been pulled in so we do not
  // re-issue `level=members` requests on a second dbltap.
  const expandedStructsRef = useRef<Set<string>>(new Set<string>());

  // Reset the expansion set whenever the snapshot identity changes (project
  // switch, re-analyze, aggregation flip). Every fresh graph starts clean.
  useEffect(() => {
    setExpandedPackages(new Set<string>());
    inFlightRef.current.clear();
    aggregatedCacheRef.current.clear();
    expandedStructsRef.current.clear();
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
        // Snapshot the aggregated node before applyExpansion drops it so the
        // user can undo the expansion via collapsePackage without a refetch.
        const aggregatedNode = cy.nodes(
          `node[package="${cssEscape(packagePath)}"][kind="package"]`,
        );
        if (aggregatedNode.nonempty()) {
          const data = aggregatedNode.first().data() as unknown as Node;
          aggregatedCacheRef.current.set(packagePath, { ...data });
        }
        const detail = await apiClient.getGraph(projectId, {
          scope: packagePath,
          level: 'struct',
        });
        applyExpansion(
          cy,
          packagePath,
          detail.nodes,
          detail.edges,
          reducedMotion,
        );
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
    [
      apiClient,
      projectId,
      cy,
      aggregation,
      reducedMotion,
      onError,
      onInfo,
    ],
  );

  const expandStructMembers = useCallback(
    async (structId: string): Promise<void> => {
      if (cy === null || projectId === undefined || projectId === '') {
        return;
      }
      if (structId === '') {
        return;
      }
      if (expandedStructsRef.current.has(structId) || inFlightRef.current.has(structId)) {
        return;
      }
      const structNode = cy.$id(structId);
      if (structNode.empty()) {
        return;
      }
      const kind = String(structNode.data('kind') ?? '');
      if (kind !== 'struct' && kind !== 'interface') {
        return;
      }
      const pkg = String(structNode.data('package') ?? '');
      if (pkg === '') {
        return;
      }
      inFlightRef.current.add(structId);
      try {
        const detail = await apiClient.getGraph(projectId, {
          scope: pkg,
          level: 'members',
          parent: structId,
        });
        applyMemberExpansion(
          cy,
          structId,
          detail.nodes,
          detail.edges,
        );
        expandedStructsRef.current.add(structId);
      } catch (err) {
        if (onError !== undefined) {
          onError(messageForError(err, pkg));
        }
      } finally {
        inFlightRef.current.delete(structId);
      }
    },
    [apiClient, projectId, cy, onError],
  );

  const collapsePackage = useCallback(
    (packagePath: string): void => {
      if (cy === null) {
        return;
      }
      if (packagePath === '') {
        return;
      }
      const cached = aggregatedCacheRef.current.get(packagePath);
      const escaped = cssEscape(packagePath);
      const members = cy.nodes(`node[package="${escaped}"]`);
      if (members.empty()) {
        return;
      }
      // Compute centroid of the cluster so the re-inserted aggregated node
      // appears where the user dispersed it from.
      let cx = 0;
      let cy0 = 0;
      let count = 0;
      members.forEach((n) => {
        const p = n.position();
        cx += p.x;
        cy0 += p.y;
        count += 1;
      });
      const center = count > 0 ? { x: cx / count, y: cy0 / count } : { x: 0, y: 0 };

      // Snapshot the ids of the members we are about to remove so we can
      // walk every other package's @boundary edges below and re-anchor any
      // that still pointed at one of those soon-to-be-doomed members.
      const memberIds = new Set<string>();
      members.forEach((n) => {
        memberIds.add(n.id());
      });
      const aggregatedId =
        cached !== undefined ? cached.id : '';

      // Find every boundary edge currently on the canvas (regardless of which
      // package owns it) whose source or target points at a member we are
      // about to drop. After collapse, those endpoints must be rewritten to
      // the freshly re-inserted aggregated package node so the cross-package
      // arrow stays visible. Without this rewrite the edges would either be
      // removed by Cytoscape (orphaned endpoint) or, worse, kept as dangling
      // shadows pointing into empty space — the bug described in R4-1.
      type EdgeRewrite = {
        oldId: string;
        newId: string;
        source: string;
        target: string;
        kind: string;
        weight: number;
        wasSourceMember: boolean;
        wasTargetMember: boolean;
      };
      const rewrites: EdgeRewrite[] = [];
      if (aggregatedId !== '') {
        cy.edges('[id $= "@boundary"]').forEach((e) => {
          const oldId = e.id();
          const src = e.source().id();
          const tgt = e.target().id();
          const srcIsMember = memberIds.has(src);
          const tgtIsMember = memberIds.has(tgt);
          if (!srcIsMember && !tgtIsMember) {
            return;
          }
          const newSource = srcIsMember ? aggregatedId : src;
          const newTarget = tgtIsMember ? aggregatedId : tgt;
          if (newSource === newTarget) {
            // Self-loop on the aggregated package — drop, not useful.
            return;
          }
          // Synthesise a stable id so duplicate boundary edges (same pair
          // collapsed multiple times) collapse into one.
          const kind = String(e.data('kind') ?? '');
          const weight = Number(e.data('weight') ?? 1);
          const newId = `${newSource}__${newTarget}__${kind}@boundary`;
          rewrites.push({
            oldId,
            newId,
            source: newSource,
            target: newTarget,
            kind,
            weight,
            wasSourceMember: srcIsMember,
            wasTargetMember: tgtIsMember,
          });
        });
      }

      cy.batch(() => {
        members.connectedEdges().remove();
        members.forEach((n) => {
          expandedStructsRef.current.delete(n.id());
        });
        members.remove();
        if (cached !== undefined) {
          cy.add({
            group: 'nodes',
            data: cached as unknown as Record<string, unknown>,
            classes: classesFor(cached),
            position: center,
          });
        }
        // Now that the aggregated package node is back, re-add the rewritten
        // boundary edges. Skip duplicates (same id may show up if multiple
        // members of the collapsed package were endpoints of edges from the
        // same foreign package node).
        const seenIds = new Set<string>();
        for (const rw of rewrites) {
          if (seenIds.has(rw.newId)) {
            continue;
          }
          if (cy.$id(rw.newId).nonempty()) {
            seenIds.add(rw.newId);
            continue;
          }
          // Defensive: both endpoints must exist on the canvas before
          // cy.add(), otherwise Cytoscape throws "nonexistent source/target".
          if (cy.$id(rw.source).empty() || cy.$id(rw.target).empty()) {
            continue;
          }
          cy.add({
            group: 'edges',
            data: {
              id: rw.newId,
              source: rw.source,
              target: rw.target,
              kind: rw.kind,
              weight: rw.weight,
            },
          });
          seenIds.add(rw.newId);
        }
      });
      aggregatedCacheRef.current.delete(packagePath);
      setExpandedPackages((prev) => {
        if (!prev.has(packagePath)) {
          return prev;
        }
        const next = new Set(prev);
        next.delete(packagePath);
        return next;
      });
    },
    [cy],
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

  // Subscribe to dbltap on struct/interface nodes — second-level drill-down.
  useEffect(() => {
    if (cy === null) {
      return undefined;
    }
    const handler = (evt: EventObject): void => {
      const node = evt.target as NodeSingular;
      void expandStructMembers(node.id());
    };
    cy.on('dbltap', 'node[kind="struct"]', handler);
    cy.on('dbltap', 'node[kind="interface"]', handler);
    return () => {
      cy.off('dbltap', 'node[kind="struct"]', handler);
      cy.off('dbltap', 'node[kind="interface"]', handler);
    };
  }, [cy, expandStructMembers]);

  return { expandedPackages, expand, expandStructMembers, collapsePackage };
}

/**
 * Add the children returned by `level=members` near the parent struct/
 * interface node. Existing canvas nodes referenced by the response are
 * left untouched (we only update their data); new member nodes get a
 * tight ring around the parent so the cluster stays visually cohesive.
 *
 * Returns the count of newly added member nodes so the caller can decide
 * whether a follow-up full re-layout is worth running (R4-3).
 */
function applyMemberExpansion(
  cy: Core,
  parentId: string,
  nodes: Node[],
  edges: Edge[],
): number {
  const parent = cy.$id(parentId);
  if (parent.empty()) {
    return 0;
  }
  const seed = parent.position();

  const incoming: Node[] = [];
  for (const node of nodes) {
    if (node.id === parentId) {
      continue;
    }
    if (cy.$id(node.id).nonempty()) {
      cy.$id(node.id).data(node as unknown as Record<string, unknown>);
      continue;
    }
    incoming.push(node);
  }

  // Tight ring — members must read as a cluster around the parent struct.
  const radius = Math.max(60, Math.min(140, 40 + incoming.length * 4));
  const additions: ElementDefinition[] = [];
  const addedIds = new Set<string>();
  incoming.forEach((node, idx) => {
    const angle = (2 * Math.PI * idx) / Math.max(1, incoming.length);
    additions.push({
      group: 'nodes',
      data: node as unknown as Record<string, unknown>,
      classes: classesFor(node),
      position: {
        x: seed.x + Math.cos(angle) * radius,
        y: seed.y + Math.sin(angle) * radius,
      },
    });
    addedIds.add(node.id);
  });
  for (const edge of edges) {
    if (cy.$id(edge.id).nonempty()) {
      continue;
    }
    if (cy.$id(edge.source).empty() || cy.$id(edge.target).empty()) {
      // The endpoint will appear in this same batch; it's safe to skip the
      // existence check because additions are added before the loop ends.
      // Falls through below.
    }
    additions.push({
      group: 'edges',
      data: edge as unknown as Record<string, unknown>,
    });
  }

  if (additions.length === 0) {
    return 0;
  }

  cy.batch(() => {
    cy.add(additions);
  });
  return addedIds.size;
}

/**
 * Replace `packagePath`'s aggregated node with the detailed sub-graph and
 * run an incremental fcose layout. Pre-existing nodes outside the new
 * sub-graph stay locked so the user does not lose their mental map.
 *
 * Returns the count of newly-added member nodes so the caller can decide
 * whether a follow-up full re-layout is worth running (R4-3).
 */
function applyExpansion(
  cy: Core,
  packagePath: string,
  nodes: Node[],
  edges: Edge[],
  reducedMotion: boolean,
): number {
  if (nodes.length === 0) {
    // Nothing to add — the package is empty after filtering. Just drop the
    // aggregated node so the user sees the gesture took effect.
    cy.batch(() => {
      cy.nodes(`node[package="${cssEscape(packagePath)}"][kind="package"]`).remove();
    });
    return 0;
  }

  // Use the aggregated node's centre as the seed position so the new sub-
  // graph appears where the user clicked rather than off-screen. Unlike the
  // pre-R4 implementation we do NOT remove the aggregated node — it stays
  // on the canvas and becomes the visual compound parent of its members
  // (R4-4). Cytoscape detects compound parents purely by `parent:` data on
  // children, so wiring `parent: <pkgNodeId>` on each new member is enough.
  const aggregated = cy.nodes(`node[package="${cssEscape(packagePath)}"][kind="package"]`);
  const seed = aggregated.nonempty() ? aggregated.first().position() : { x: 0, y: 0 };
  const aggregatedId = aggregated.nonempty() ? aggregated.first().id() : '';

  // Promote the aggregated node into a compound parent. The class is the FE's
  // signal for a stylesheet rule that strips the badge fill and uses a dashed
  // outline so it reads as a container instead of a node. The badge label is
  // also replaced by a plain package-name label.
  if (aggregated.nonempty()) {
    aggregated.addClass('pkg-compound');
    aggregated.data('expanded', true);
  }

  // Plan positions for new children up-front: a concentric ring around the
  // seed (the old package node's centre). Pre-placement matters because
  // fcose with all-equal seed positions can take many iterations to
  // disentangle and meanwhile the surrounding graph is locked so the user
  // sees a frozen blob. The ring radius scales with child count so dense
  // packages do not collide with neighbouring still-aggregated nodes.
  const incomingNodes: Node[] = [];
  for (const node of nodes) {
    if (node.id === aggregatedId) {
      // Server's scope response includes the package's own aggregated node;
      // skip — it is already on the canvas, now serving as compound parent.
      continue;
    }
    if (cy.$id(node.id).nonempty()) {
      // The node is already on the canvas — usually a foreign package node
      // included as boundary context. Refresh its data, do not re-insert.
      cy.$id(node.id).data(node as unknown as Record<string, unknown>);
      continue;
    }
    incomingNodes.push(node);
  }

  const ringRadius = Math.max(120, Math.min(360, 30 + incomingNodes.length * 6));
  const additions: ElementDefinition[] = [];
  const newIds = new Set<string>();
  incomingNodes.forEach((node, idx) => {
    const angle = (2 * Math.PI * idx) / Math.max(1, incomingNodes.length);
    const data: Record<string, unknown> = {
      ...(node as unknown as Record<string, unknown>),
    };
    // Wire the compound parent. Only do this for nodes that genuinely belong
    // to the package being expanded — foreign boundary nodes keep their own
    // package and stay outside the box.
    if (aggregatedId !== '' && node.package === packagePath) {
      data['parent'] = aggregatedId;
    }
    additions.push({
      group: 'nodes',
      data,
      classes: classesFor(node),
      position: {
        x: seed.x + Math.cos(angle) * ringRadius,
        y: seed.y + Math.sin(angle) * ringRadius,
      },
    });
    newIds.add(node.id);
  });
  // Tag any contains edge that lives entirely inside the new compound — i.e.
  // package -> member of this expanded package — with `contains-internal` so
  // the base stylesheet hides it. The compound's dashed border already
  // expresses "these nodes belong to this package"; the radial fan of edges
  // that R4-4 inadvertently exposed (R5 Bug #2) was both visual noise AND
  // the root cause of the over-wide compound bounding box (R5 Bug #1) —
  // fcose treats those edges as springs that push children apart.
  for (const edge of edges) {
    if (cy.$id(edge.id).nonempty()) {
      continue;
    }
    const isInternalContains =
      edge.kind === 'contains' &&
      aggregatedId !== '' &&
      edge.source === aggregatedId &&
      newIds.has(edge.target);
    additions.push({
      group: 'edges',
      data: edge as unknown as Record<string, unknown>,
      ...(isInternalContains ? { classes: 'contains-internal' } : {}),
    });
  }

  cy.batch(() => {
    if (additions.length > 0) {
      cy.add(additions);
    }
  });

  if (newIds.size === 0) {
    return 0;
  }

  // Build the collection of freshly inserted nodes plus their incident edges
  // — this is the only sub-graph fcose is allowed to relax. The surrounding
  // still-aggregated nodes stay exactly where they are (no lock needed since
  // we scope the layout via `eles`, but we keep the user-interaction re-arm).
  // Internal contains edges are excluded from the layout collection so fcose
  // does not factor them into its force model — otherwise they would still
  // act as springs even though they are visually hidden.
  let newCollection = cy.collection();
  for (const id of newIds) {
    newCollection = newCollection.union(cy.$id(id));
  }
  const layoutEles = newCollection
    .union(newCollection.connectedEdges())
    .difference(cy.edges('.contains-internal'));

  cy.userPanningEnabled(true);
  cy.userZoomingEnabled(true);

  // Compound-aware fcose tuning (R5): the layout runs over the compound parent
  // + new children, so `nestingFactor` controls how much the simulation
  // squeezes children inside the parent. A small value keeps the cluster tight
  // and the compound's bounding box hugs its members. nodeRepulsion is dialed
  // down a touch for the same reason — the previous 4500 was tuned for the
  // unboxed (R3) flow where members spread across the canvas.
  //
  // R7: source these from the shared `layoutOptionsFor('expansion', ...)`
  // helper so the canvas-wide and per-compound tunings live next to each
  // other and stay in sync. The helper omits `eles`; we attach it here since
  // only this call site scopes the layout to the freshly added sub-graph.
  const baseExpansionOpts = layoutOptionsFor(
    'expansion',
    { nodes: [], edges: [] } as unknown as Parameters<typeof layoutOptionsFor>[1],
    reducedMotion,
  ) as unknown as Record<string, unknown>;
  const layoutOpts: LayoutOptions = {
    ...baseExpansionOpts,
    eles: layoutEles,
  } as unknown as LayoutOptions;

  // Finishing touches: re-arm pan/zoom in case fcose's animation left the
  // core half-disabled. We deliberately do NOT call `cy.fit(newCollection)`
  // — that would re-frame the viewport onto just the new sub-graph and
  // shove the surrounding still-aggregated packages off-screen, destroying
  // the user's mental map.
  const finishExpansion = (): void => {
    try {
      cy.userPanningEnabled(true);
      cy.userZoomingEnabled(true);
    } catch {
      // Best-effort polish — never surface a layout-time exception as a
      // "Failed to expand" toast. The nodes are already on the canvas.
    }
  };

  try {
    // Run the layout via `eles.layout(...)` so the `eles` scoping is
    // honoured by every fcose version (fcose ignores the `eles` option
    // passed to `cy.layout`). Pre-placed positions seed the simulation;
    // randomize=false keeps them sticky so children fan out from the
    // package's old centre instead of teleporting elsewhere.
    const layoutHandle = layoutEles.layout(layoutOpts);
    cy.one('layoutstop', finishExpansion);
    layoutHandle.run();
  } catch {
    // fcose may not be registered (tests with a stripped-down core); the
    // elements are already at their seed positions so a failing layout is
    // non-fatal.
    finishExpansion();
  }
  return newIds.size;
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
