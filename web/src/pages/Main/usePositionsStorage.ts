/**
 * Per-project storage for Cytoscape node positions.
 *
 * `localStorage` key: `go-viz:<id>:positions` (design.md §8). Writes are
 * debounced (500 ms) because Cytoscape fires `position` on every dragged
 * frame. The hook returns a stable read function and a setter so the
 * component does not re-render every time positions change.
 */

import { useCallback, useEffect, useRef } from 'react';

import { projectKey } from '../../storage/keys';

/** Map of `nodeId → {x, y}` positions stored in localStorage. */
export type PositionMap = Record<string, { x: number; y: number }>;

/** Public API of `usePositionsStorage`. */
export interface PositionsStorage {
  /** Snapshot of the persisted positions for the current project. */
  read: () => PositionMap;
  /** Schedule a debounced write of the supplied positions. */
  write: (next: PositionMap) => void;
  /** Drop the persisted positions for the current project. */
  clear: () => void;
}

const DEFAULT_DEBOUNCE_MS = 500;

/**
 * Read/write the positions map keyed by `projectId`. Writes are debounced
 * so a long drag burst translates into a single localStorage hit.
 *
 * The returned API object is stable across renders so consumers can use it
 * as a `useEffect` dependency without retriggering on every parent render.
 */
export function usePositionsStorage(
  projectId: string | undefined,
  debounceMs = DEFAULT_DEBOUNCE_MS,
): PositionsStorage {
  const pendingRef = useRef<PositionMap | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectIdRef = useRef<string | undefined>(projectId);
  projectIdRef.current = projectId;
  const debounceRef = useRef<number>(debounceMs);
  debounceRef.current = debounceMs;

  const flush = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const id = projectIdRef.current;
    const value = pendingRef.current;
    pendingRef.current = null;
    if (id === undefined || id === '' || value === null) {
      return;
    }
    try {
      window.localStorage.setItem(projectKey(id, 'positions'), JSON.stringify(value));
    } catch {
      // quota exceeded or storage disabled — best-effort
    }
  }, []);

  // Flush pending writes on unmount or `projectId` switch so positions are
  // never lost between navigations.
  useEffect(() => {
    return () => {
      flush();
    };
  }, [flush, projectId]);

  // Build the API object once. The internals consult refs so swapping
  // `projectId` does not break consumers that captured the stable handle.
  const apiRef = useRef<PositionsStorage | null>(null);
  if (apiRef.current === null) {
    apiRef.current = {
      read: (): PositionMap => {
        const id = projectIdRef.current;
        if (id === undefined || id === '') {
          return {};
        }
        try {
          const raw = window.localStorage.getItem(projectKey(id, 'positions'));
          if (raw === null || raw === '') {
            return {};
          }
          const parsed = JSON.parse(raw) as unknown;
          if (parsed === null || typeof parsed !== 'object') {
            return {};
          }
          return parsed as PositionMap;
        } catch {
          return {};
        }
      },
      write: (next: PositionMap): void => {
        pendingRef.current = next;
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          flush();
        }, debounceRef.current);
      },
      clear: (): void => {
        pendingRef.current = null;
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const id = projectIdRef.current;
        if (id === undefined || id === '') {
          return;
        }
        try {
          window.localStorage.removeItem(projectKey(id, 'positions'));
        } catch {
          // ignore
        }
      },
    };
  }
  return apiRef.current;
}
