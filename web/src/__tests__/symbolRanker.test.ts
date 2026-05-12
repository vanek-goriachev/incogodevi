/**
 * Unit tests for the entry-point picker ranker. The ranker is a pure
 * function so we exercise it without a React or Cytoscape mock.
 */

import { describe, expect, it } from 'vitest';

import type { SymbolEntry } from '../api/types';
import { rankSymbols, scoreSymbol } from '../pages/Main/panels/symbolRanker';

function sym(partial: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'fqn'>): SymbolEntry {
  return {
    id: partial.id ?? partial.fqn,
    kind: partial.kind ?? 'func',
    package: partial.package ?? partial.fqn.split('#')[0] ?? '',
    name: partial.name,
    fqn: partial.fqn,
  };
}

describe('rankSymbols', () => {
  const fixture: SymbolEntry[] = [
    sym({ name: 'Server.Run', fqn: 'a/internal/server#Server.Run', kind: 'method' }),
    sym({ name: 'Worker.Run', fqn: 'a/internal/worker#Worker.Run', kind: 'method' }),
    sym({ name: 'runOnce', fqn: 'a/cmd/agent#runOnce' }),
    sym({ name: 'main', fqn: 'a/cmd/agent#main' }),
    sym({ name: 'HandleHTTP', fqn: 'a/internal/http#HandleHTTP' }),
  ];

  it('returns the full list (up to limit) for empty needle', () => {
    expect(rankSymbols(fixture, '', 3)).toHaveLength(3);
    expect(rankSymbols(fixture, '   ', 10)).toHaveLength(fixture.length);
  });

  it('matches case-insensitively', () => {
    const ranked = rankSymbols(fixture, 'RUN', 10);
    const fqns = ranked.map((r) => r.fqn);
    expect(fqns).toContain('a/internal/server#Server.Run');
    expect(fqns).toContain('a/internal/worker#Worker.Run');
    expect(fqns).toContain('a/cmd/agent#runOnce');
    expect(fqns).not.toContain('a/internal/http#HandleHTTP');
  });

  it('prefers prefix matches over substring matches', () => {
    const ranked = rankSymbols(fixture, 'run', 10);
    expect(ranked[0]?.fqn).toBe('a/cmd/agent#runOnce');
  });

  it('prefers word-boundary matches (Type.Method split) over plain substring', () => {
    // "Run" matches as a word inside `Server.Run` and `Worker.Run`. Both
    // beat any hypothetical entry where "run" only appears mid-identifier.
    const withMidMatch = [
      ...fixture,
      sym({ name: 'OverrunCheck', fqn: 'a/util#OverrunCheck' }),
    ];
    const ranked = rankSymbols(withMidMatch, 'run', 10);
    const middleIdx = ranked.findIndex((r) => r.fqn === 'a/util#OverrunCheck');
    const wordIdx = ranked.findIndex((r) => r.fqn === 'a/internal/server#Server.Run');
    expect(wordIdx).toBeLessThan(middleIdx);
  });

  it('matches the package path when nothing else matches', () => {
    const ranked = rankSymbols(fixture, 'cmd/agent', 10);
    expect(ranked.map((r) => r.fqn)).toEqual(
      expect.arrayContaining(['a/cmd/agent#runOnce', 'a/cmd/agent#main']),
    );
  });

  it('respects the limit argument', () => {
    expect(rankSymbols(fixture, 'run', 1)).toHaveLength(1);
    expect(rankSymbols(fixture, 'run', 0)).toHaveLength(0);
  });

  it('scoreSymbol returns -1 for unrelated entries', () => {
    expect(
      scoreSymbol(
        sym({ name: 'Alpha', fqn: 'pkg#Alpha' }),
        'zeta',
      ),
    ).toBe(-1);
  });
});
