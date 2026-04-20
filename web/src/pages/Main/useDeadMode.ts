/**
 * Dead-code display mode hook (design.md §5.3).
 *
 * Owns one of three string values — `live-only`, `live-dead` (default) and
 * `dead-only` — persisted under `go-viz:<id>:dead-mode`. The hook also keeps
 * the Cytoscape graph elements annotated with `mode-hide-live` /
 * `mode-hide-dead` classes so the stylesheet declared in `graph-styles.ts`
 * can hide the irrelevant subset with a pure CSS-class selector
 * (NFR-03 ≤ 100 ms — no layout, no fetch, no diff).
 *
 * The data-mode attribute on the Cytoscape container is mirrored as well so
 * end-to-end tests can read the current mode without poking the cy core.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { Core } from 'cytoscape';

import { projectKey } from '../../storage/keys';
import { useLocalStorage } from '../../storage/useLocalStorage';

/** Three display modes from design.md §5.3. */
export type DeadMode = 'live-only' | 'live-dead' | 'dead-only';

/** Default mode: show everything with dead nodes faded (design.md §5.3). */
export const DEFAULT_DEAD_MODE: DeadMode = 'live-dead';

/** Ordered list used by the hotkey cycle and the segmented control. */
export const DEAD_MODE_ORDER: readonly DeadMode[] = [
  'live-only',
  'live-dead',
  'dead-only',
];

/** Class added to live elements when only dead should remain visible. */
export const HIDE_LIVE_CLASS = 'mode-hide-live';
/** Class added to dead elements when only live should remain visible. */
export const HIDE_DEAD_CLASS = 'mode-hide-dead';

export interface UseDeadModeResult {
  mode: DeadMode;
  setMode: (next: DeadMode) => void;
  /** Cycle to the next mode in `DEAD_MODE_ORDER`. */
  cycle: () => void;
  /**
   * Re-apply the current mode to all elements on the cy core. Use this
   * after the graph topology changed so newly added nodes/edges inherit
   * the correct visibility classes.
   */
  refresh: () => void;
}

/**
 * Subscribe to the persisted dead-mode and apply it to a Cytoscape core.
 *
 * Behaviour:
 *
 *   - In `live-only` mode every `.dead` element gains the
 *     `mode-hide-dead` class — the stylesheet maps that to
 *     `display: none`.
 *   - In `dead-only` mode every non-dead element (and every edge whose
 *     source or target is live) gains the `mode-hide-live` class.
 *   - In `live-dead` mode (default) both classes are stripped so the
 *     standard 0.45 opacity overlay from §5.3 takes over.
 *
 * The container's `data-dead-mode` attribute mirrors the active value so
 * E2E suites can assert mode changes without hooking into the cy registry.
 */
export function useDeadMode(
  projectId: string | undefined,
  cy: Core | null,
): UseDeadModeResult {
  const storageKey = projectKey(projectId ?? '__none__', 'dead-mode');
  const [stored, setStored] = useLocalStorage<DeadMode>(storageKey, DEFAULT_DEAD_MODE);
  const mode = normalizeMode(stored);

  // Track the latest cy + mode in refs so `refresh` can be a stable
  // callback. Stable identity matters because the parent calls it from a
  // useEffect dependency array.
  const cyRef = useRef<Core | null>(cy);
  cyRef.current = cy;
  const modeRef = useRef<DeadMode>(mode);
  modeRef.current = mode;

  useEffect(() => {
    if (cy === null) {
      return;
    }
    applyDeadMode(cy, mode);
  }, [cy, mode]);

  const setMode = useCallback(
    (next: DeadMode) => {
      setStored(normalizeMode(next));
    },
    [setStored],
  );

  const cycle = useCallback(() => {
    setStored((prev) => {
      const current = normalizeMode(prev);
      const idx = DEAD_MODE_ORDER.indexOf(current);
      const nextIdx = (idx + 1) % DEAD_MODE_ORDER.length;
      return DEAD_MODE_ORDER[nextIdx] ?? DEFAULT_DEAD_MODE;
    });
  }, [setStored]);

  const refresh = useCallback(() => {
    const core = cyRef.current;
    if (core === null) {
      return;
    }
    applyDeadMode(core, modeRef.current);
  }, []);

  return { mode, setMode, cycle, refresh };
}

/**
 * Apply `mode` to `cy` by toggling the hide classes and the container
 * data attribute. Exported for unit testing in isolation from the hook.
 */
export function applyDeadMode(cy: Core, mode: DeadMode): void {
  cy.batch(() => {
    const all = cy.elements();
    all.removeClass(HIDE_LIVE_CLASS);
    all.removeClass(HIDE_DEAD_CLASS);

    if (mode === 'live-only') {
      const dead = cy.nodes('.dead');
      dead.addClass(HIDE_DEAD_CLASS);
      // Edges incident to a dead endpoint must hide too — otherwise dangling
      // arrows linger over empty space.
      dead.connectedEdges().addClass(HIDE_DEAD_CLASS);
      return;
    }

    if (mode === 'dead-only') {
      const live = cy.nodes().difference(cy.nodes('.dead'));
      live.addClass(HIDE_LIVE_CLASS);
      // Hide every edge that touches at least one live node — the dead-only
      // view shows the orphan dead subgraph.
      live.connectedEdges().addClass(HIDE_LIVE_CLASS);
    }
  });

  const container = cy.container();
  if (container !== null) {
    container.dataset['deadMode'] = mode;
  }
}

/** Coerce arbitrary input back to a known mode value. */
function normalizeMode(value: unknown): DeadMode {
  if (value === 'live-only' || value === 'live-dead' || value === 'dead-only') {
    return value;
  }
  return DEFAULT_DEAD_MODE;
}
