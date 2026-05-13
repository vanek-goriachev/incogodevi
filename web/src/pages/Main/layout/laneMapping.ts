/**
 * Lane-mapping module for the Layer Editor (R12 / feat/layer-editor).
 *
 * The Layer Editor lets the user pull packages out of their BFS-depth lane
 * into named folder-groups, and freely arrange any lane (BFS or folder-group)
 * into a "slot" (an x-column on the canvas). This module is the pure resolver
 * that, given the BFS depths and the user-edited layer state, assigns every
 * node to its `{ slotIndex, stackIndex, laneIndex }` triple.
 *
 * Resolution rules (user-confirmed):
 *
 *   1. **Exclusive grouping.** A package matching a folder-group prefix is
 *      PULLED OUT of its BFS-depth lane and placed only in that folder-group.
 *      The original BFS-depth lane still exists but is missing that package.
 *   2. **Prefix match.** `databases` matches any package whose path is
 *      `databases` or starts with `databases/`. NOT a glob.
 *   3. **Longest-prefix-first.** If multiple prefixes match, the LONGEST
 *      wins. Implementation sorts prefixes by length descending before
 *      iterating. Ties (same length) are broken by lexicographic order so
 *      the mapping stays deterministic.
 *
 * The module is React- and Cytoscape-free; consumers feed it plain data and
 * read back a `Map<nodeId, LaneAssignment>` plus an enriched layout
 * description that the positioner consumes.
 */

/** A single lane in the editor — either a BFS-depth lane or a folder-group. */
export type Lane =
  | { kind: 'bfs'; depth: number }
  | { kind: 'folder'; id: string; name: string; prefix: string };

/** Vertical column on the canvas; a slot can hold many lanes stacked top-down. */
export interface Slot {
  lanes: Lane[];
}

/** Folder group declared by the user: name + prefix match. */
export interface FolderGroup {
  id: string;
  name: string;
  prefix: string;
}

/**
 * Top-level state managed by the editor and persisted to localStorage.
 *
 * `version` is bumped on breaking schema changes so the persistence layer
 * can migrate or discard older payloads safely.
 */
export interface LayerEditorState {
  version: number;
  groups: FolderGroup[];
  /** Slots arranged left-to-right; each holds 0..N lanes stacked top-down. */
  slots: Slot[];
  /** Lanes that exist but the user temporarily parked outside any slot. */
  unassigned: Lane[];
}

/** Current schema version. */
export const LAYER_EDITOR_STATE_VERSION = 1;

/** Inputs for resolving a node to its lane. */
export interface LaneInputNode {
  id: string;
  /** Package path (already normalised; matches the backend `package` field). */
  package: string;
  /** Optional BFS depth. `undefined` means the node is unreachable. */
  depth: number | undefined;
}

/** A node's final position in the slot grid. */
export interface LaneAssignment {
  /** Which slot (x-column) the node lives in; -1 for unassigned. */
  slotIndex: number;
  /** Which lane WITHIN the slot the node lives in (top-to-bottom). */
  stackIndex: number;
  /** Global lane identifier — distinct keys for unique (kind, key) lanes. */
  laneKey: string;
}

/** Resolution output for downstream layout. */
export interface LaneResolution {
  /** Per-node assignment; nodes that have no slot return slotIndex = -1. */
  byNode: Map<string, LaneAssignment>;
  /** Lookup by `laneKey` → the lane spec (for chip labels, counts, etc.). */
  laneByKey: Map<string, Lane>;
  /** Lookup by `laneKey` → ordered list of node ids that landed in it. */
  nodesByLaneKey: Map<string, string[]>;
}

/** Deterministic key for a lane (so two lanes with same logical id collapse). */
export function laneKeyOf(lane: Lane): string {
  if (lane.kind === 'bfs') {
    return `bfs:${String(lane.depth)}`;
  }
  return `folder:${lane.id}`;
}

/**
 * Sort folder groups by prefix length descending (longest-prefix-first).
 * Ties broken by prefix value so the order is fully deterministic.
 */
export function sortGroupsByLongestPrefixFirst(
  groups: readonly FolderGroup[],
): FolderGroup[] {
  const copy = groups.slice();
  copy.sort((a, b) => {
    if (a.prefix.length !== b.prefix.length) {
      return b.prefix.length - a.prefix.length;
    }
    if (a.prefix < b.prefix) return -1;
    if (a.prefix > b.prefix) return 1;
    return 0;
  });
  return copy;
}

/**
 * Does `pkg` match `prefix` under the "prefix" rule?
 *
 *   - Equal strings match (e.g. `databases` matches `databases`).
 *   - `pkg` starts with `prefix + "/"` matches (so `databases/postgres/conn`
 *     matches `databases/postgres` but NOT `databases-archive`).
 *
 * Empty prefix never matches anything — it would otherwise swallow the entire
 * package universe and produce a single-lane editor.
 */
export function matchesPrefix(pkg: string, prefix: string): boolean {
  if (prefix === '') {
    return false;
  }
  if (pkg === prefix) {
    return true;
  }
  return pkg.startsWith(prefix + '/');
}

/**
 * Find the folder group that owns `pkg` under the longest-prefix-first rule.
 * Returns `null` when no group matches.
 */
export function pickFolderGroup(
  pkg: string,
  groupsSortedLongestFirst: readonly FolderGroup[],
): FolderGroup | null {
  for (const g of groupsSortedLongestFirst) {
    if (matchesPrefix(pkg, g.prefix)) {
      return g;
    }
  }
  return null;
}

/** Build a default `LayerEditorState` from the set of BFS depths present. */
export function defaultLayerEditorState(depths: readonly number[]): LayerEditorState {
  const unique = Array.from(new Set(depths)).filter((d) => d >= 0).sort((a, b) => a - b);
  return {
    version: LAYER_EDITOR_STATE_VERSION,
    groups: [],
    slots: unique.map((d) => ({ lanes: [{ kind: 'bfs', depth: d }] })),
    unassigned: [],
  };
}

/**
 * Resolve every node to its slot / lane assignment.
 *
 *   - Group lookup is sorted by longest-prefix-first before iteration so the
 *     deterministic tie-break is enforced uniformly.
 *   - Folder lanes claim their members exclusively (R12 rule #1).
 *   - Nodes whose lane is not present in any slot keep slotIndex = -1.
 *     Callers may fall those nodes back to a default lane.
 */
export function resolveLanes(
  nodes: readonly LaneInputNode[],
  state: LayerEditorState,
): LaneResolution {
  const byNode = new Map<string, LaneAssignment>();
  const laneByKey = new Map<string, Lane>();
  const nodesByLaneKey = new Map<string, string[]>();

  // Pre-index slot/stack by lane key for O(1) lookup during the per-node loop.
  const slotByLaneKey = new Map<string, { slotIndex: number; stackIndex: number }>();
  state.slots.forEach((slot, slotIndex) => {
    slot.lanes.forEach((lane, stackIndex) => {
      const key = laneKeyOf(lane);
      // Last-write wins when the same lane appears twice (shouldn't happen on
      // healthy state, but defensive against user-edited localStorage).
      slotByLaneKey.set(key, { slotIndex, stackIndex });
      laneByKey.set(key, lane);
    });
  });
  state.unassigned.forEach((lane) => {
    const key = laneKeyOf(lane);
    if (!laneByKey.has(key)) {
      laneByKey.set(key, lane);
    }
  });

  const sortedGroups = sortGroupsByLongestPrefixFirst(state.groups);

  for (const node of nodes) {
    let lane: Lane | null = null;

    // 1. Folder-group with longest matching prefix wins (exclusive).
    const matched = pickFolderGroup(node.package, sortedGroups);
    if (matched !== null) {
      lane = { kind: 'folder', id: matched.id, name: matched.name, prefix: matched.prefix };
    } else if (node.depth !== undefined && node.depth >= 0) {
      // 2. BFS-depth lane otherwise.
      lane = { kind: 'bfs', depth: node.depth };
    }

    if (lane === null) {
      // Unreachable + no folder match → leave unplaced; positioner can stash
      // these in the dead-region or whatever fallback the caller prefers.
      byNode.set(node.id, { slotIndex: -1, stackIndex: -1, laneKey: '' });
      continue;
    }

    const key = laneKeyOf(lane);
    const slotPos = slotByLaneKey.get(key);
    if (slotPos === undefined) {
      // Lane exists logically but the user moved it out of every slot.
      byNode.set(node.id, { slotIndex: -1, stackIndex: -1, laneKey: key });
    } else {
      byNode.set(node.id, {
        slotIndex: slotPos.slotIndex,
        stackIndex: slotPos.stackIndex,
        laneKey: key,
      });
    }
    if (!laneByKey.has(key)) {
      laneByKey.set(key, lane);
    }
    let bucket = nodesByLaneKey.get(key);
    if (bucket === undefined) {
      bucket = [];
      nodesByLaneKey.set(key, bucket);
    }
    bucket.push(node.id);
  }

  return { byNode, laneByKey, nodesByLaneKey };
}

/**
 * Migrate a possibly-malformed persisted state to a healthy `LayerEditorState`.
 *
 * Returns `null` when the input is unrecoverable (caller should fall back to
 * the default state). Forward-compatible: a newer `version` is accepted if
 * the shape parses — defensive when a user downgrades the SPA build.
 */
export function migrateLayerEditorState(input: unknown): LayerEditorState | null {
  if (input === null || typeof input !== 'object') {
    return null;
  }
  const obj = input as Partial<LayerEditorState> & Record<string, unknown>;
  if (!Array.isArray(obj.slots)) {
    return null;
  }
  const groups: FolderGroup[] = [];
  if (Array.isArray(obj.groups)) {
    for (const g of obj.groups) {
      if (g !== null && typeof g === 'object') {
        const gg = g as Partial<FolderGroup>;
        if (
          typeof gg.id === 'string' &&
          typeof gg.name === 'string' &&
          typeof gg.prefix === 'string'
        ) {
          groups.push({ id: gg.id, name: gg.name, prefix: gg.prefix });
        }
      }
    }
  }
  const slots: Slot[] = [];
  for (const s of obj.slots) {
    if (s === null || typeof s !== 'object') continue;
    const ss = s as Partial<Slot>;
    const lanes = sanitiseLanes(ss.lanes);
    slots.push({ lanes });
  }
  const unassigned = sanitiseLanes(obj.unassigned);
  return {
    version: typeof obj.version === 'number' ? obj.version : LAYER_EDITOR_STATE_VERSION,
    groups,
    slots,
    unassigned,
  };
}

function sanitiseLanes(input: unknown): Lane[] {
  if (!Array.isArray(input)) return [];
  const out: Lane[] = [];
  for (const x of input) {
    if (x === null || typeof x !== 'object') continue;
    const xx = x as Partial<Lane> & Record<string, unknown>;
    if (xx.kind === 'bfs' && typeof xx.depth === 'number' && Number.isFinite(xx.depth)) {
      out.push({ kind: 'bfs', depth: xx.depth });
    } else if (
      xx.kind === 'folder' &&
      typeof xx.id === 'string' &&
      typeof xx.name === 'string' &&
      typeof xx.prefix === 'string'
    ) {
      out.push({ kind: 'folder', id: xx.id, name: xx.name, prefix: xx.prefix });
    }
  }
  return out;
}
