/**
 * Unit tests for the local-reachability fallback used when the cached
 * re-analyze tech-debt issue surfaces.
 */

import { describe, expect, it } from 'vitest';

import type { EntryPointSpec, Graph, Node, Edge } from '../api/types';
import { recomputeReachability } from '../pages/Main/localReachability';

function makeNode(overrides: Partial<Node>): Node {
  return {
    id: 'n',
    name: 'n',
    kind: 'func',
    package: 'pkg',
    file: 'f.go',
    line: 1,
    exported: true,
    reachable: false,
    is_entry: false,
    ...overrides,
  };
}

function makeEdge(overrides: Partial<Edge>): Edge {
  return {
    id: 'e',
    source: 'a',
    target: 'b',
    kind: 'calls',
    weight: 1,
    ...overrides,
  };
}

function fixture(): Graph {
  const nodes: Node[] = [
    makeNode({ id: 'main', name: 'main', kind: 'func', package: 'cmd/app' }),
    makeNode({ id: 'used', name: 'Used' }),
    makeNode({ id: 'leaf', name: 'Leaf' }),
    makeNode({ id: 'orphan', name: 'Orphan', reachable: true, is_entry: true }),
  ];
  const edges: Edge[] = [
    makeEdge({ id: 'e1', source: 'main', target: 'used' }),
    makeEdge({ id: 'e2', source: 'used', target: 'leaf' }),
  ];
  return {
    project_id: 'p',
    generated_at: '2026-04-19T10:00:00Z',
    aggregation: 'none',
    stats: { node_count: 4, edge_count: 2, by_kind: {}, dead_count: 0 },
    nodes,
    edges,
    warnings: [],
  };
}

describe('recomputeReachability', () => {
  it('marks func main and reachable descendants when auto mode is on', () => {
    const spec: EntryPointSpec = {
      mode: 'auto',
      auto_kinds: ['main'],
      manual: [],
      interface_impl: [],
    };
    const out = recomputeReachability(fixture(), spec);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get('main')?.is_entry).toBe(true);
    expect(byId.get('main')?.reachable).toBe(true);
    expect(byId.get('used')?.reachable).toBe(true);
    expect(byId.get('leaf')?.reachable).toBe(true);
    expect(byId.get('orphan')?.is_entry).toBe(false);
    expect(byId.get('orphan')?.reachable).toBe(false);
  });

  it('honours a manual FQN entry', () => {
    const spec: EntryPointSpec = {
      mode: 'manual',
      auto_kinds: [],
      manual: ['pkg#Used'],
      interface_impl: [],
    };
    const out = recomputeReachability(fixture(), spec);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get('used')?.is_entry).toBe(true);
    expect(byId.get('used')?.reachable).toBe(true);
    expect(byId.get('leaf')?.reachable).toBe(true);
    expect(byId.get('main')?.reachable).toBe(false);
  });

  it('marks every node as dead when no entry point is selected', () => {
    const spec: EntryPointSpec = {
      mode: 'manual',
      auto_kinds: [],
      manual: [],
      interface_impl: [],
    };
    const out = recomputeReachability(fixture(), spec);
    expect(out.nodes.every((n) => !n.reachable)).toBe(true);
    expect(out.stats.dead_count).toBe(4);
  });

  it('returns the same reference when nothing actually changed', () => {
    const graph = fixture();
    // Pre-mark everyone reachable per the auto-spec result so the
    // recomputation should be a no-op.
    const preComputed: Graph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'orphan'
          ? { ...n, is_entry: false, reachable: false }
          : { ...n, is_entry: n.id === 'main', reachable: true },
      ),
    };
    const spec: EntryPointSpec = {
      mode: 'auto',
      auto_kinds: ['main'],
      manual: [],
      interface_impl: [],
    };
    const out = recomputeReachability(preComputed, spec);
    expect(out).toBe(preComputed);
  });
});
