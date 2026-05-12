/**
 * Unit tests for the FQN helpers used by the entry-points panel and the
 * context menu.
 */

import { describe, expect, it } from 'vitest';

import cytoscape, { type Core } from 'cytoscape';

import type { Edge, Graph, Node } from '../api/types';
import { cyNodeToFqn, isValidFqn, nodeToFqn } from '../pages/Main/panels/fqn';

function makeCy(elements: cytoscape.ElementDefinition[]): Core {
  const opts: cytoscape.CytoscapeOptions = {
    elements,
    headless: true,
    styleEnabled: true,
  };
  (opts as unknown as { renderer: { name: string } }).renderer = { name: 'null' };
  return cytoscape(opts);
}

function makeNode(overrides: Partial<Node>): Node {
  return {
    id: 'id',
    name: 'Handler',
    kind: 'func',
    package: 'github.com/acme/api',
    file: 'api/handler.go',
    line: 12,
    exported: true,
    reachable: true,
    is_entry: false,
    ...overrides,
  };
}

function makeGraph(nodes: Node[], edges: Edge[] = []): Graph {
  return {
    project_id: 'test-project',
    generated_at: '2025-01-01T00:00:00Z',
    aggregation: 'none',
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      by_kind: {},
      dead_count: 0,
    },
    nodes,
    edges,
    warnings: [],
  };
}

describe('isValidFqn', () => {
  const validCases = [
    'pkg#Func',
    'github.com/acme/api#Handler',
    'github.com/acme/api#Server.ServeHTTP',
    'a/b/c#Type1.Method2',
    'pkg#_underscore',
  ];
  it.each(validCases)('accepts %s', (fqn) => {
    expect(isValidFqn(fqn)).toBe(true);
  });

  const invalidCases = [
    '',
    'pkg',
    '#Func',
    'pkg#',
    'pkg#1Func',
    'pkg with spaces#Func',
    'pkg#Func.With.Three.Parts',
    'pkg##Func',
    'pkg#Func()',
  ];
  it.each(invalidCases)('rejects %s', (fqn) => {
    expect(isValidFqn(fqn)).toBe(false);
  });
});

describe('nodeToFqn', () => {
  it('builds pkg#Name for a function node', () => {
    const node = makeNode({ kind: 'func', name: 'Handler', package: 'api' });
    expect(nodeToFqn(node)).toBe('api#Handler');
  });

  it('builds pkg#Type.Method for a method node using the contains-edge parent', () => {
    // Method nodes carry `Name = methodName` (no receiver) on the wire, so
    // the FQN helper must recover the receiver from the graph's contains
    // edges. Without this lookup the resulting FQN would be `api#ServeHTTP`
    // which the server's entry resolver cannot match against any symbol.
    const method = makeNode({
      id: 'method-id',
      kind: 'method',
      name: 'ServeHTTP',
      package: 'api',
    });
    const parent = makeNode({
      id: 'struct-id',
      kind: 'struct',
      name: 'Server',
      package: 'api',
    });
    const graph = makeGraph([parent, method], [
      {
        id: 'edge-id',
        source: parent.id,
        target: method.id,
        kind: 'contains',
        weight: 1,
      },
    ]);
    expect(nodeToFqn(method, graph)).toBe('api#Server.ServeHTTP');
  });

  it('returns null for a method node when the graph has no contains-edge', () => {
    const method = makeNode({ id: 'm', kind: 'method', name: 'ServeHTTP', package: 'api' });
    const graph = makeGraph([method]);
    expect(nodeToFqn(method, graph)).toBeNull();
    expect(nodeToFqn(method)).toBeNull();
  });

  it('returns null for non-callable kinds', () => {
    const kinds: Node['kind'][] = ['package', 'struct', 'interface', 'field', 'var', 'const'];
    for (const kind of kinds) {
      expect(nodeToFqn(makeNode({ kind }))).toBeNull();
    }
  });

  it('returns null when the package or name is empty', () => {
    expect(nodeToFqn(makeNode({ package: '' }))).toBeNull();
    expect(nodeToFqn(makeNode({ name: '' }))).toBeNull();
  });
});

describe('cyNodeToFqn', () => {
  it('reads receiver from cy contains edges for a method node', () => {
    const cy = makeCy([
      { group: 'nodes', data: { id: 'sid', name: 'Server', kind: 'struct', package: 'api' } },
      { group: 'nodes', data: { id: 'mid', name: 'Run', kind: 'method', package: 'api' } },
      { group: 'edges', data: { id: 'e1', source: 'sid', target: 'mid', kind: 'contains' } },
    ]);
    expect(cyNodeToFqn(cy.$id('mid'), cy)).toBe('api#Server.Run');
    cy.destroy();
  });

  it('builds pkg#Name for a function node', () => {
    const cy = makeCy([
      { group: 'nodes', data: { id: 'fid', name: 'Handler', kind: 'func', package: 'api' } },
    ]);
    expect(cyNodeToFqn(cy.$id('fid'), cy)).toBe('api#Handler');
    cy.destroy();
  });

  it('returns null for a method with no contains edge', () => {
    const cy = makeCy([
      { group: 'nodes', data: { id: 'mid', name: 'Run', kind: 'method', package: 'api' } },
    ]);
    expect(cyNodeToFqn(cy.$id('mid'), cy)).toBeNull();
    cy.destroy();
  });

  it('returns null for non-callable kinds', () => {
    const cy = makeCy([
      { group: 'nodes', data: { id: 'p', name: 'pkg', kind: 'package', package: 'api' } },
    ]);
    expect(cyNodeToFqn(cy.$id('p'), cy)).toBeNull();
    cy.destroy();
  });
});
