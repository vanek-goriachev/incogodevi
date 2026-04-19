/**
 * Helpers around the `go-viz:recent-projects` localStorage entry (design.md §8).
 *
 * The list is LIFO with a hard cap of 10. Re-uploading an already-known
 * project moves it to the top instead of duplicating it.
 */

import { RECENT_PROJECTS_KEY, STORAGE_PREFIX } from './keys';

/** Shape persisted under `go-viz:recent-projects` (design.md §8). */
export interface RecentProject {
  project_id: string;
  name: string;
  uploaded_at: string;
}

export const RECENT_PROJECTS_LIMIT = 10;

/** Read the current list; returns an empty array on first run or parse error. */
export function readRecentProjects(): RecentProject[] {
  try {
    const raw = window.localStorage.getItem(RECENT_PROJECTS_KEY);
    if (raw === null) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isRecentProject);
  } catch {
    return [];
  }
}

/**
 * Insert (or move-to-top) a project. Returns the new list so callers can
 * forward it to React state without re-reading storage.
 */
export function upsertRecentProject(
  current: RecentProject[],
  next: RecentProject,
): RecentProject[] {
  const without = current.filter((p) => p.project_id !== next.project_id);
  return [next, ...without].slice(0, RECENT_PROJECTS_LIMIT);
}

/** Remove `projectId` from the list and return the new array. */
export function removeRecentProject(
  current: RecentProject[],
  projectId: string,
): RecentProject[] {
  return current.filter((p) => p.project_id !== projectId);
}

/**
 * Delete every per-project key (`go-viz:<id>:*`) from localStorage. Called by
 * the "Forget" button so users cleanly drop a project's settings.
 */
export function purgeProjectStorage(projectId: string): void {
  const prefix = `${STORAGE_PREFIX}:${projectId}:`;
  // Snapshot keys first because `removeItem` invalidates the live index.
  const toDelete: string[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (key !== null && key.startsWith(prefix)) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    window.localStorage.removeItem(key);
  }
}

function isRecentProject(value: unknown): value is RecentProject {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v['project_id'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['uploaded_at'] === 'string'
  );
}
