/**
 * Client-side `FilterSpec` — what is currently visible on the Cytoscape
 * canvas. Distinct from the server-side `Filters` (api/types.ts) which
 * controls what enters the graph in the first place; this spec only toggles
 * visibility of nodes already in the snapshot (design.md §3.3 left rail
 * "Filter", FR-14).
 *
 * Persisted as JSON under `go-viz:<id>:filters` (design.md §8). The shape is
 * versioned with `v` so future schema changes can fall back gracefully.
 */

import { ALL_NODE_KINDS, type NodeKind } from '../../../api/types';

/** Visibility tumbler per node kind (FR-14). */
export type KindVisibility = Record<NodeKind, boolean>;

/**
 * Persisted client-side filter state.
 *
 *   - `kinds`     map of NodeKind → visible? (default: every kind on)
 *   - `packages`  in `subset` mode only nodes whose package is in `selected`
 *                 are visible; in `all` mode every package is visible
 *   - `find`      substring match against node `name` and fully-qualified
 *                 `id` (case-insensitive); empty string means no highlight
 */
export interface FilterSpec {
  v: 1;
  kinds: KindVisibility;
  packages: { mode: 'all' | 'subset'; selected: string[] };
  find: string;
}

/** Sentinel returned by `defaultFilterSpec()`. */
export function defaultFilterSpec(): FilterSpec {
  const kinds = {} as KindVisibility;
  for (const k of ALL_NODE_KINDS) {
    kinds[k] = true;
  }
  return {
    v: 1,
    kinds,
    packages: { mode: 'all', selected: [] },
    find: '',
  };
}

/**
 * Hardening read: accepts an arbitrary value (typically the parsed JSON read
 * from `localStorage`) and returns a fully-formed `FilterSpec`. Missing or
 * invalid fields fall back to defaults so a corrupted persisted value never
 * crashes the panel.
 */
export function normalizeFilterSpec(input: unknown): FilterSpec {
  const base = defaultFilterSpec();
  if (input === null || typeof input !== 'object') {
    return base;
  }
  const obj = input as Partial<FilterSpec> & Record<string, unknown>;
  if (obj.kinds !== null && typeof obj.kinds === 'object') {
    for (const k of ALL_NODE_KINDS) {
      const v = (obj.kinds as Record<string, unknown>)[k];
      if (typeof v === 'boolean') {
        base.kinds[k] = v;
      }
    }
  }
  if (obj.packages !== null && typeof obj.packages === 'object') {
    const pkgs = obj.packages as { mode?: unknown; selected?: unknown };
    if (pkgs.mode === 'subset' || pkgs.mode === 'all') {
      base.packages.mode = pkgs.mode;
    }
    if (Array.isArray(pkgs.selected)) {
      base.packages.selected = pkgs.selected.filter(
        (item): item is string => typeof item === 'string',
      );
    }
  }
  if (typeof obj.find === 'string') {
    base.find = obj.find;
  }
  return base;
}

/** Convenience equality used by the visibility hook to skip no-op updates. */
export function filterSpecEqual(a: FilterSpec, b: FilterSpec): boolean {
  if (a.find !== b.find) {
    return false;
  }
  if (a.packages.mode !== b.packages.mode) {
    return false;
  }
  if (a.packages.selected.length !== b.packages.selected.length) {
    return false;
  }
  for (let i = 0; i < a.packages.selected.length; i += 1) {
    if (a.packages.selected[i] !== b.packages.selected[i]) {
      return false;
    }
  }
  for (const k of ALL_NODE_KINDS) {
    if (a.kinds[k] !== b.kinds[k]) {
      return false;
    }
  }
  return true;
}
