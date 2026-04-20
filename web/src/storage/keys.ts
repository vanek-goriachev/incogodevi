/**
 * Canonical localStorage keys for the SPA.
 *
 * Mirrors `docs/design.md` §8. Centralizing key names prevents typos and
 * keeps the "forget project" cleanup logic in sync with everything that
 * writes per-project state.
 */

export const STORAGE_PREFIX = 'go-viz';

export const RECENT_PROJECTS_KEY = `${STORAGE_PREFIX}:recent-projects`;
export const THEME_KEY = `${STORAGE_PREFIX}:theme`;

export type ProjectScopedField =
  | 'entry-points'
  | 'filters'
  | 'positions'
  | 'layout'
  | 'dead-mode'
  | 'collapsed'
  | 'expanded-packages';

/** Build a per-project storage key, e.g. `go-viz:abcd:filters`. */
export function projectKey(projectId: string, field: ProjectScopedField): string {
  return `${STORAGE_PREFIX}:${projectId}:${field}`;
}

/** Predicate that matches every per-project key for the given id. */
export function isProjectKey(projectId: string, key: string): boolean {
  return key.startsWith(`${STORAGE_PREFIX}:${projectId}:`);
}
