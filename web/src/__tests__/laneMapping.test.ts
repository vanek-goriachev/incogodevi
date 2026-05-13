/**
 * Pure-function tests for the Layer Editor's lane resolver (R12).
 *
 * Covers:
 *   - longest-prefix-first match wins,
 *   - exclusivity: a folder-group claims its members out of the BFS lane,
 *   - unmatched packages fall back to their BFS-depth lane,
 *   - empty / malformed states do not crash,
 *   - default state seeds one slot per BFS depth.
 */

import { describe, expect, it } from 'vitest';

import {
  defaultLayerEditorState,
  laneKeyOf,
  matchesPrefix,
  migrateLayerEditorState,
  pickFolderGroup,
  resolveLanes,
  sortGroupsByLongestPrefixFirst,
  type FolderGroup,
  type LaneInputNode,
} from '../pages/Main/layout/laneMapping';

describe('matchesPrefix', () => {
  it('matches an exact package name', () => {
    expect(matchesPrefix('databases', 'databases')).toBe(true);
  });
  it('matches when package starts with prefix + slash', () => {
    expect(matchesPrefix('databases/postgres', 'databases')).toBe(true);
    expect(matchesPrefix('databases/postgres/conn', 'databases')).toBe(true);
  });
  it('does not match a longer adjacent name', () => {
    expect(matchesPrefix('databases-archive', 'databases')).toBe(false);
  });
  it('rejects empty prefix to avoid swallowing the universe', () => {
    expect(matchesPrefix('databases', '')).toBe(false);
  });
});

describe('sortGroupsByLongestPrefixFirst', () => {
  it('orders by prefix length desc, ties alphabetically', () => {
    const groups: FolderGroup[] = [
      { id: 'a', name: 'A', prefix: 'databases' },
      { id: 'b', name: 'B', prefix: 'databases/postgres' },
      { id: 'c', name: 'C', prefix: 'cmd' },
      { id: 'd', name: 'D', prefix: 'app' },
    ];
    const sorted = sortGroupsByLongestPrefixFirst(groups);
    expect(sorted.map((g) => g.prefix)).toEqual([
      'databases/postgres',
      'databases',
      'app',
      'cmd',
    ]);
  });
});

describe('pickFolderGroup — longest prefix wins', () => {
  it('picks longest matching prefix', () => {
    const groups: FolderGroup[] = [
      { id: 'a', name: 'A', prefix: 'databases' },
      { id: 'b', name: 'B', prefix: 'databases/postgres' },
    ];
    const sorted = sortGroupsByLongestPrefixFirst(groups);
    const matched = pickFolderGroup('databases/postgres/conn', sorted);
    expect(matched?.id).toBe('b');
  });
  it('falls back to shorter prefix when longer does not match', () => {
    const groups: FolderGroup[] = [
      { id: 'a', name: 'A', prefix: 'databases' },
      { id: 'b', name: 'B', prefix: 'databases/postgres' },
    ];
    const sorted = sortGroupsByLongestPrefixFirst(groups);
    const matched = pickFolderGroup('databases/mongo/conn', sorted);
    expect(matched?.id).toBe('a');
  });
  it('returns null when no prefix matches', () => {
    const groups: FolderGroup[] = [
      { id: 'a', name: 'A', prefix: 'cmd' },
    ];
    const sorted = sortGroupsByLongestPrefixFirst(groups);
    expect(pickFolderGroup('internal/api', sorted)).toBeNull();
  });
});

describe('resolveLanes', () => {
  it('default state assigns each BFS depth to its own slot exclusively', () => {
    const state = defaultLayerEditorState([0, 1, 2]);
    expect(state.slots).toHaveLength(3);
    const nodes: LaneInputNode[] = [
      { id: 'a', package: 'cmd/server', depth: 0 },
      { id: 'b', package: 'internal/api', depth: 1 },
      { id: 'c', package: 'internal/db', depth: 2 },
    ];
    const res = resolveLanes(nodes, state);
    expect(res.byNode.get('a')?.slotIndex).toBe(0);
    expect(res.byNode.get('b')?.slotIndex).toBe(1);
    expect(res.byNode.get('c')?.slotIndex).toBe(2);
  });

  it('folder-group claims members out of BFS lane (exclusivity)', () => {
    const state = defaultLayerEditorState([0, 1, 2]);
    // Insert a folder lane into slot 0 (sharing with bfs:0). The package
    // `databases/postgres` is BFS-depth 2 (would otherwise go to slot 2).
    state.groups.push({ id: 'g1', name: 'DBs', prefix: 'databases' });
    state.slots[0]!.lanes.push({
      kind: 'folder',
      id: 'g1',
      name: 'DBs',
      prefix: 'databases',
    });
    const nodes: LaneInputNode[] = [
      { id: 'entry', package: 'cmd', depth: 0 },
      { id: 'db1', package: 'databases/postgres', depth: 2 },
      { id: 'db2', package: 'databases', depth: 2 },
      { id: 'api', package: 'internal/api', depth: 1 },
    ];
    const res = resolveLanes(nodes, state);
    // db1 should land in slot 0 (folder group), not slot 2 (BFS).
    expect(res.byNode.get('db1')?.slotIndex).toBe(0);
    expect(res.byNode.get('db1')?.laneKey).toBe('folder:g1');
    expect(res.byNode.get('db2')?.slotIndex).toBe(0);
    // api (unmatched) keeps its BFS lane.
    expect(res.byNode.get('api')?.slotIndex).toBe(1);
    expect(res.byNode.get('api')?.laneKey).toBe('bfs:1');
  });

  it('longest-prefix-first resolution', () => {
    const state = defaultLayerEditorState([0]);
    state.groups.push(
      { id: 'g-short', name: 'DBs', prefix: 'databases' },
      { id: 'g-long', name: 'PG', prefix: 'databases/postgres' },
    );
    state.slots[0]!.lanes.push(
      { kind: 'folder', id: 'g-short', name: 'DBs', prefix: 'databases' },
      { kind: 'folder', id: 'g-long', name: 'PG', prefix: 'databases/postgres' },
    );
    const nodes: LaneInputNode[] = [
      { id: 'pg1', package: 'databases/postgres/conn', depth: 0 },
      { id: 'db-other', package: 'databases/mongo', depth: 0 },
    ];
    const res = resolveLanes(nodes, state);
    expect(res.byNode.get('pg1')?.laneKey).toBe('folder:g-long');
    expect(res.byNode.get('db-other')?.laneKey).toBe('folder:g-short');
  });

  it('nodes without depth and without folder match return slotIndex -1', () => {
    const state = defaultLayerEditorState([0]);
    const nodes: LaneInputNode[] = [
      { id: 'orphan', package: 'foo/bar', depth: undefined },
    ];
    const res = resolveLanes(nodes, state);
    expect(res.byNode.get('orphan')?.slotIndex).toBe(-1);
  });

  it('lane existing in state.unassigned shows slotIndex -1 with valid laneKey', () => {
    const state = defaultLayerEditorState([0]);
    state.groups.push({ id: 'g', name: 'G', prefix: 'x' });
    state.unassigned.push({ kind: 'folder', id: 'g', name: 'G', prefix: 'x' });
    const nodes: LaneInputNode[] = [
      { id: 'x1', package: 'x/y', depth: 0 },
    ];
    const res = resolveLanes(nodes, state);
    expect(res.byNode.get('x1')?.slotIndex).toBe(-1);
    expect(res.byNode.get('x1')?.laneKey).toBe('folder:g');
  });

  it('empty groups → every node falls into its BFS lane', () => {
    const state = defaultLayerEditorState([0, 1]);
    const nodes: LaneInputNode[] = [
      { id: 'a', package: 'foo', depth: 0 },
      { id: 'b', package: 'bar', depth: 1 },
    ];
    const res = resolveLanes(nodes, state);
    expect(res.byNode.get('a')?.laneKey).toBe(laneKeyOf({ kind: 'bfs', depth: 0 }));
    expect(res.byNode.get('b')?.laneKey).toBe(laneKeyOf({ kind: 'bfs', depth: 1 }));
  });
});

describe('migrateLayerEditorState', () => {
  it('returns null for non-object inputs', () => {
    expect(migrateLayerEditorState(null)).toBeNull();
    expect(migrateLayerEditorState('garbage')).toBeNull();
  });

  it('drops malformed lanes silently and keeps the rest', () => {
    const out = migrateLayerEditorState({
      version: 1,
      groups: [{ id: 'a', name: 'A', prefix: 'p' }, { id: 'b' /* missing fields */ }],
      slots: [
        { lanes: [{ kind: 'bfs', depth: 0 }, { kind: 'unknown' }, { kind: 'folder', id: 'a', name: 'A', prefix: 'p' }] },
      ],
      unassigned: 'not an array',
    });
    expect(out).not.toBeNull();
    expect(out!.groups).toHaveLength(1);
    expect(out!.slots[0]!.lanes).toHaveLength(2);
    expect(out!.unassigned).toEqual([]);
  });
});

describe('defaultLayerEditorState', () => {
  it('produces one slot per depth, sorted ascending, dropping negatives', () => {
    const state = defaultLayerEditorState([2, 1, 1, -1, 0]);
    expect(state.slots.map((s) => (s.lanes[0] as { kind: 'bfs'; depth: number }).depth)).toEqual([0, 1, 2]);
    expect(state.groups).toEqual([]);
    expect(state.unassigned).toEqual([]);
  });
});
