/**
 * `useCollapse` — hides the descendants of a node so the user can prune a
 * branch without removing it from the underlying graph (FR-16).
 *
 * Implementation:
 *
 *   - Maintains a `Set<string>` of collapsed root ids in React state.
 *   - For each collapsed root, walks the outgoing `calls`, `contains`,
 *     `embeds` and `references` edges with a breadth-first traversal,
 *     marking every reached node (excluding the root itself) with the
 *     `.collapsed-hidden` class.
 *   - Cytoscape's stylesheet rule then sets `display: none` on that class.
 *   - The set is persisted under `go-viz:<id>:collapsed` so a tab reload
 *     restores the same hidden branches alongside positions and filters
 *     (design.md §8 — collapsed state is an extension of `positions`).
 *
 * Re-collapsing is idempotent: marking a node as collapsed twice has no
 * additional effect, and uncollapsing a non-collapsed root is a no-op.
 *
 * The hook is intentionally Cytoscape-aware. The traversal cannot be done
 * client-side from the React state because edges only live inside the
 * Cytoscape model after `GraphCanvas` mounts.
 */

import type { Core, EdgeSingular, NodeSingular, StylesheetStyle } from 'cytoscape';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { projectKey } from '../../storage/keys';

/** CSS class added to nodes that the user collapsed (or descendants thereof). */
export const COLLAPSED_HIDDEN_CLASS = 'collapsed-hidden';

/** Root nodes carry an extra class so the panel can label them as collapsed. */
export const COLLAPSED_ROOT_CLASS = 'collapsed-root';

/** Edge kinds traversed when expanding a collapsed root. */
const TRAVERSED_EDGE_KINDS: ReadonlySet<string> = new Set([
  'calls',
  'contains',
  'embeds',
  'references',
]);

/** Stylesheet rules attached on first hook activation per Cytoscape instance. */
const COLLAPSE_STYLE_RULES: StylesheetStyle[] = [
  {
    selector: `.${COLLAPSED_HIDDEN_CLASS}`,
    style: {
      display: 'none',
    },
  },
  {
    selector: `node.${COLLAPSED_ROOT_CLASS}`,
    style: {
      'border-style': 'dotted',
      'border-width': 3,
    },
  },
];

export interface UseCollapseApi {
  /** Set of currently collapsed root ids. */
  collapsedIds: ReadonlySet<string>;
  /** Mark `nodeId` as collapsed and hide its descendants. */
  collapse: (nodeId: string) => void;
  /** Restore the descendants of `nodeId`. */
  expand: (nodeId: string) => void;
  /** Toggle: collapse if not yet collapsed, expand otherwise. */
  toggle: (nodeId: string) => void;
  /** Restore everything; useful for "Show all" affordance. */
  expandAll: () => void;
}

/** Persisted shape kept stable across schema versions. */
interface PersistedCollapseState {
  v: 1;
  ids: string[];
}

function readPersisted(projectId: string | undefined): Set<string> {
  if (projectId === undefined || projectId === '') {
    return new Set();
  }
  try {
    const raw = window.localStorage.getItem(projectKey(projectId, 'collapsed'));
    if (raw === null) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as PersistedCollapseState | null;
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.ids)) {
      return new Set();
    }
    return new Set(parsed.ids.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function writePersisted(projectId: string | undefined, ids: ReadonlySet<string>): void {
  if (projectId === undefined || projectId === '') {
    return;
  }
  try {
    const payload: PersistedCollapseState = { v: 1, ids: Array.from(ids).sort() };
    window.localStorage.setItem(projectKey(projectId, 'collapsed'), JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage disabled — keep state in memory only.
  }
}

/**
 * Public hook. `cy` may be `null` while the canvas mounts; the hook keeps
 * the set of collapsed ids in React state regardless and applies them to
 * Cytoscape as soon as the instance becomes available.
 */
export function useCollapse(
  cy: Core | null,
  projectId: string | undefined,
): UseCollapseApi {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => readPersisted(projectId));

  // Reset state when the project changes — collapsed ids are not portable
  // across projects.
  useEffect(() => {
    setCollapsedIds(readPersisted(projectId));
  }, [projectId]);

  // Snapshot guard — a fresh effect loop after `cy` mounts re-applies the
  // current set without re-walking the graph again.
  const lastAppliedRef = useRef<Set<string> | null>(null);

  // Apply the set to Cytoscape on every change (or whenever a new instance
  // mounts). The traversal cost is O(nodes + edges) in the worst case but
  // typically much smaller; collapsing is rare so the budget is generous.
  useEffect(() => {
    if (cy === null) {
      lastAppliedRef.current = null;
      return;
    }
    ensureCollapseStyleRules(cy);
    applyCollapsedSet(cy, collapsedIds);
    lastAppliedRef.current = new Set(collapsedIds);
  }, [cy, collapsedIds]);

  const persist = useCallback(
    (ids: ReadonlySet<string>) => {
      writePersisted(projectId, ids);
    },
    [projectId],
  );

  const collapse = useCallback(
    (nodeId: string) => {
      setCollapsedIds((prev) => {
        if (prev.has(nodeId)) {
          return prev;
        }
        const next = new Set(prev);
        next.add(nodeId);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const expand = useCallback(
    (nodeId: string) => {
      setCollapsedIds((prev) => {
        if (!prev.has(nodeId)) {
          return prev;
        }
        const next = new Set(prev);
        next.delete(nodeId);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const toggle = useCallback(
    (nodeId: string) => {
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) {
          next.delete(nodeId);
        } else {
          next.add(nodeId);
        }
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const expandAll = useCallback(() => {
    setCollapsedIds((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      const next = new Set<string>();
      persist(next);
      return next;
    });
  }, [persist]);

  return useMemo<UseCollapseApi>(
    () => ({
      collapsedIds,
      collapse,
      expand,
      toggle,
      expandAll,
    }),
    [collapsedIds, collapse, expand, toggle, expandAll],
  );
}

/**
 * Add the collapse stylesheet rules to a Cytoscape instance.
 *
 * Mirrors the pattern from `useFilters.ensureFilterStyleRules` — the live
 * stylesheet is rebuilt on theme switches, so this routine is idempotent
 * and safe to call from every effect.
 */
export function ensureCollapseStyleRules(cy: Core): void {
  let styleApi: unknown;
  try {
    styleApi = cy.style();
  } catch {
    return;
  }
  if (styleApi === null || styleApi === undefined) {
    return;
  }
  const styleSelector = (styleApi as {
    selector?: (s: string) => {
      style: (props: Record<string, unknown>) => { update: () => void };
    };
  }).selector;
  if (typeof styleSelector !== 'function') {
    return;
  }
  for (const rule of COLLAPSE_STYLE_RULES) {
    const props = rule.style as unknown as Record<string, unknown>;
    try {
      styleSelector(rule.selector).style(props).update();
    } catch {
      return;
    }
  }
}

/**
 * Recompute and apply the hidden / root classes for the supplied collapsed
 * set. Wipes previous state first so removing a root from the set always
 * un-hides the affected descendants.
 */
export function applyCollapsedSet(cy: Core, collapsed: ReadonlySet<string>): void {
  cy.batch(() => {
    cy.elements().removeClass(`${COLLAPSED_HIDDEN_CLASS} ${COLLAPSED_ROOT_CLASS}`);
    if (collapsed.size === 0) {
      return;
    }
    const hidden = new Set<string>();
    for (const rootId of collapsed) {
      const root = cy.$id(rootId);
      if (root.empty()) {
        continue;
      }
      root.addClass(COLLAPSED_ROOT_CLASS);
      collectDescendants(cy, rootId, hidden);
    }
    for (const id of hidden) {
      cy.$id(id).addClass(COLLAPSED_HIDDEN_CLASS);
    }
    cy.edges().forEach((edge: EdgeSingular) => {
      const source = edge.source();
      const target = edge.target();
      if (
        source.hasClass(COLLAPSED_HIDDEN_CLASS) ||
        target.hasClass(COLLAPSED_HIDDEN_CLASS)
      ) {
        edge.addClass(COLLAPSED_HIDDEN_CLASS);
      }
    });
  });
}

/**
 * BFS over outgoing edges of the four traversed kinds, accumulating ids.
 * The root itself is not added to `into` — only its descendants.
 */
function collectDescendants(cy: Core, rootId: string, into: Set<string>): void {
  const queue: string[] = [rootId];
  const visited = new Set<string>([rootId]);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const node = cy.$id(current);
    if (node.empty()) {
      continue;
    }
    const outgoing = node.outgoers('edge');
    outgoing.forEach((edge: EdgeSingular) => {
      const kind = String(edge.data('kind'));
      if (!TRAVERSED_EDGE_KINDS.has(kind)) {
        return;
      }
      const target = edge.target() as NodeSingular;
      const targetId = target.id();
      if (visited.has(targetId)) {
        return;
      }
      visited.add(targetId);
      into.add(targetId);
      queue.push(targetId);
    });
  }
}
