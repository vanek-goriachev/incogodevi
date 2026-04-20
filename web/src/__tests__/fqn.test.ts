/**
 * Unit tests for the FQN helpers used by the entry-points panel and the
 * context menu.
 */

import { describe, expect, it } from 'vitest';

import type { Node } from '../api/types';
import { isValidFqn, nodeToFqn } from '../pages/Main/panels/fqn';

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

  it('builds pkg#Type.Method for a method node', () => {
    const node = makeNode({ kind: 'method', name: 'Server.ServeHTTP', package: 'api' });
    expect(nodeToFqn(node)).toBe('api#Server.ServeHTTP');
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
