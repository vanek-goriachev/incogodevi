/**
 * Per-project persistence + reducer for the Layer Editor state (R12).
 *
 * Key: `go-viz:<projectId>:layer-editor`. The hook:
 *
 *   - reads the persisted state on mount and migrates legacy payloads,
 *   - derives a default state from the BFS depths present in the current
 *     graph when nothing is persisted (one slot per depth, alphabetical),
 *   - exposes a small API (`addGroup`, `moveLane`, `removeGroup`, `reset`,
 *     `setState`) so the editor bar can mutate state without re-implementing
 *     storage logic.
 *
 * Persistence is best-effort — quota/SecurityError exceptions are silently
 * swallowed so localStorage hiccups never crash the editor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { projectKey } from '../../storage/keys';
import {
  LAYER_EDITOR_STATE_VERSION,
  defaultLayerEditorState,
  laneKeyOf,
  migrateLayerEditorState,
  type FolderGroup,
  type Lane,
  type LayerEditorState,
  type Slot,
} from './layout/laneMapping';

/** Imperative API returned to the consumer. */
export interface UseLayerEditorStateApi {
  state: LayerEditorState;
  setState: (next: LayerEditorState) => void;
  /** Add a brand-new folder group. The new lane lands in `unassigned`. */
  addGroup: (name: string, prefix: string) => void;
  /** Remove a folder group; any place it appeared in is dropped. */
  removeGroup: (id: string) => void;
  /**
   * Move a lane (identified by laneKey) from its current location into the
   * given slot at the given stack position. `toSlotIndex = -1` parks the
   * lane in `unassigned`.
   */
  moveLane: (laneKey: string, toSlotIndex: number, toStackIndex: number) => void;
  /** Restore the default state derived from BFS depths. */
  reset: () => void;
}

export interface UseLayerEditorStateOptions {
  projectId: string | undefined;
  /** Per-node BFS depth driver — feeds the default state when nothing persisted. */
  bfsDepths: readonly number[];
  /** When set to `false`, the hook never reads/writes localStorage (tests). */
  persist?: boolean;
}

/**
 * Default state cache so React renders don't recompute on every tick.
 */
function useDefault(bfsDepths: readonly number[]): LayerEditorState {
  // Re-derive only when the actual depth list changes by value. ESLint's
  // exhaustive-deps rule wants the whole `bfsDepths` array in the dep list
  // but that compares by reference, defeating the memo.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => defaultLayerEditorState(bfsDepths), [bfsDepths.join(',')]);
}

export function useLayerEditorState(
  options: UseLayerEditorStateOptions,
): UseLayerEditorStateApi {
  const { projectId, bfsDepths, persist = true } = options;
  const defaultState = useDefault(bfsDepths);
  const lastProjectIdRef = useRef<string | undefined>(undefined);

  // Initial state: try localStorage first; else fall back to defaults.
  const [state, setStateRaw] = useState<LayerEditorState>(() => {
    if (!persist) return defaultState;
    if (projectId === undefined || projectId === '') return defaultState;
    const persisted = readPersisted(projectId);
    if (persisted !== null) {
      return persisted;
    }
    return defaultState;
  });

  // When projectId changes (route nav, post-upload), reload the persisted
  // state for the new project (or default).
  useEffect(() => {
    if (lastProjectIdRef.current === projectId) return;
    lastProjectIdRef.current = projectId;
    if (projectId === undefined || projectId === '') {
      setStateRaw(defaultState);
      return;
    }
    if (!persist) {
      setStateRaw(defaultState);
      return;
    }
    const persisted = readPersisted(projectId);
    setStateRaw(persisted ?? defaultState);
  }, [projectId, persist, defaultState]);

  // When the default state changes (graph topology landed, new depths
  // appeared), backfill any missing BFS lanes into the persisted state so a
  // user that has not touched the editor still sees all depths.
  useEffect(() => {
    setStateRaw((prev) => {
      const known = new Set<string>();
      for (const slot of prev.slots) {
        for (const lane of slot.lanes) known.add(laneKeyOf(lane));
      }
      for (const lane of prev.unassigned) known.add(laneKeyOf(lane));
      const missing: Lane[] = [];
      for (const slot of defaultState.slots) {
        for (const lane of slot.lanes) {
          if (!known.has(laneKeyOf(lane))) {
            missing.push(lane);
          }
        }
      }
      if (missing.length === 0) {
        return prev;
      }
      // Append each missing BFS lane as its own slot on the right so we never
      // silently consume the user's arrangement on the left.
      const newSlots = [...prev.slots, ...missing.map((l) => ({ lanes: [l] }))];
      return { ...prev, slots: newSlots };
    });
  }, [defaultState]);

  const setState = useCallback(
    (next: LayerEditorState) => {
      setStateRaw(next);
      if (persist && projectId !== undefined && projectId !== '') {
        try {
          window.localStorage.setItem(
            projectKey(projectId, 'layer-editor'),
            JSON.stringify(next),
          );
        } catch {
          /* best-effort */
        }
      }
    },
    [projectId, persist],
  );

  const addGroup = useCallback(
    (name: string, prefix: string) => {
      const trimmed = prefix.trim();
      if (trimmed === '') return;
      const trimmedName = name.trim() === '' ? trimmed : name.trim();
      // Generate a stable id from the prefix + a salt; collisions just dedupe.
      const id = `g_${trimmed}_${Math.random().toString(36).slice(2, 7)}`;
      const newGroup: FolderGroup = { id, name: trimmedName, prefix: trimmed };
      // Land the new lane in `unassigned` so the user explicitly drags it.
      const newLane: Lane = { kind: 'folder', id, name: trimmedName, prefix: trimmed };
      setState({
        ...state,
        groups: [...state.groups, newGroup],
        unassigned: [...state.unassigned, newLane],
      });
    },
    [state, setState],
  );

  const removeGroup = useCallback(
    (groupId: string) => {
      const groups = state.groups.filter((g) => g.id !== groupId);
      const stripLanes = (lanes: Lane[]): Lane[] =>
        lanes.filter((l) => !(l.kind === 'folder' && l.id === groupId));
      const slots: Slot[] = state.slots.map((s) => ({ lanes: stripLanes(s.lanes) }));
      const unassigned = stripLanes(state.unassigned);
      setState({ ...state, groups, slots, unassigned });
    },
    [state, setState],
  );

  const moveLane = useCallback(
    (laneKey: string, toSlotIndex: number, toStackIndex: number) => {
      // 1. Find the lane and remove it from wherever it lives.
      let found: Lane | null = null;
      const slots: Slot[] = state.slots.map((s) => {
        const lanes: Lane[] = [];
        for (const lane of s.lanes) {
          if (laneKeyOf(lane) === laneKey && found === null) {
            found = lane;
            continue;
          }
          lanes.push(lane);
        }
        return { lanes };
      });
      let unassigned: Lane[] = state.unassigned.slice();
      const idx = unassigned.findIndex((l) => laneKeyOf(l) === laneKey);
      if (idx !== -1 && found === null) {
        found = unassigned[idx] ?? null;
        unassigned.splice(idx, 1);
      }
      if (found === null) return; // No-op: lane not found.

      // 2. Insert at the destination.
      if (toSlotIndex < 0) {
        unassigned = [...unassigned, found];
      } else {
        // Grow slots array if the user dropped into a slot index past the
        // current length — that's how "drop on the rightmost empty slot
        // placeholder" promotes a new column.
        while (slots.length <= toSlotIndex) {
          slots.push({ lanes: [] });
        }
        const target = slots[toSlotIndex]!;
        const lanes = target.lanes.slice();
        const safeIndex = Math.max(0, Math.min(toStackIndex, lanes.length));
        lanes.splice(safeIndex, 0, found);
        slots[toSlotIndex] = { lanes };
      }
      // 3. Drop any trailing empty slot at the very end so the editor doesn't
      // accumulate phantom slots after repeated drags.
      while (slots.length > 0 && (slots[slots.length - 1]?.lanes.length ?? 0) === 0) {
        slots.pop();
      }
      setState({ ...state, slots, unassigned });
    },
    [state, setState],
  );

  const reset = useCallback(() => {
    setState(defaultState);
  }, [defaultState, setState]);

  return { state, setState, addGroup, removeGroup, moveLane, reset };
}

function readPersisted(projectId: string): LayerEditorState | null {
  try {
    const raw = window.localStorage.getItem(projectKey(projectId, 'layer-editor'));
    if (raw === null || raw === '') return null;
    const parsed = JSON.parse(raw) as unknown;
    const migrated = migrateLayerEditorState(parsed);
    if (migrated === null) return null;
    // Stamp the current version so future reads can detect downgrades.
    return { ...migrated, version: LAYER_EDITOR_STATE_VERSION };
  } catch {
    return null;
  }
}
