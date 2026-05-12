/**
 * Unit tests for the pure package-tree positioner.
 *
 * Cytoscape-free: the function under test takes raw string paths and returns
 * a `Map<string, {x,y}>`. The point of this test file is to lock down the
 * three guarantees the GraphCanvas integration relies on:
 *   1. Determinism — identical input (modulo order) yields identical output.
 *   2. Common-prefix elision — packages sharing a module root collapse so
 *      the tree is not stacked four levels deep against the canvas edge.
 *   3. Sane handling of edge cases (empty input, single package, deep tree).
 */

import { describe, expect, it } from 'vitest';

import { computePackageTreePositions } from '../../pages/Main/layout/packageTree';

describe('computePackageTreePositions', () => {
  it('returns an empty map for an empty input', () => {
    expect(computePackageTreePositions([])).toEqual(new Map());
  });

  it('handles a single package', () => {
    const out = computePackageTreePositions(['github.com/x/y/main']);
    expect(out.size).toBe(1);
    const p = out.get('github.com/x/y/main');
    expect(p).toBeDefined();
    expect(Number.isFinite(p!.x)).toBe(true);
    expect(Number.isFinite(p!.y)).toBe(true);
  });

  it('is deterministic — input order does not affect output', () => {
    const a = computePackageTreePositions([
      'm/x/internal/api',
      'm/x/internal/db',
      'm/x/cmd/server',
    ]);
    const b = computePackageTreePositions([
      'm/x/cmd/server',
      'm/x/internal/db',
      'm/x/internal/api',
    ]);
    expect(Object.fromEntries(a)).toEqual(Object.fromEntries(b));
  });

  it('places siblings on the same y row', () => {
    const out = computePackageTreePositions([
      'm/x/internal/api',
      'm/x/internal/db',
      'm/x/internal/store',
    ]);
    const ya = out.get('m/x/internal/api')!.y;
    const yb = out.get('m/x/internal/db')!.y;
    const yc = out.get('m/x/internal/store')!.y;
    expect(ya).toBe(yb);
    expect(yb).toBe(yc);
  });

  it('elides the common module prefix shared by every package', () => {
    // Both packages share `github.com/x/y` — the tree should root at the
    // first distinguishing segment (cmd / internal), so the depth (y) of
    // the leaves is small.
    const out = computePackageTreePositions([
      'github.com/x/y/cmd/server',
      'github.com/x/y/internal/api',
    ]);
    // Leaves are at depth=1 after elision (parent=cmd|internal, leaf=server|api).
    const a = out.get('github.com/x/y/cmd/server')!;
    const b = out.get('github.com/x/y/internal/api')!;
    // Equal y → siblings of an elided common parent.
    expect(a.y).toBe(b.y);
    // x distinct — not stacked.
    expect(a.x).not.toBe(b.x);
  });

  it('puts deeper packages on a lower row than shallower ones', () => {
    const out = computePackageTreePositions([
      'm/x/cmd',
      'm/x/internal/api/middleware',
    ]);
    const cmd = out.get('m/x/cmd')!;
    const deep = out.get('m/x/internal/api/middleware')!;
    expect(deep.y).toBeGreaterThan(cmd.y);
  });

  it('honours custom spacing options', () => {
    const out = computePackageTreePositions(
      ['m/a', 'm/b'],
      { horizontalGap: 1000, verticalGap: 1000, originX: 50, originY: 100 },
    );
    const a = out.get('m/a')!;
    const b = out.get('m/b')!;
    expect(Math.abs(a.x - b.x)).toBe(1000);
    expect(a.y).toBe(100);
  });

  it('dedupes repeated paths in the input', () => {
    const out = computePackageTreePositions(['m/a', 'm/a', 'm/b']);
    expect(out.size).toBe(2);
  });

  it('returns finite numbers for every position', () => {
    const paths = [
      'm/a/b/c',
      'm/a/b/d',
      'm/a/e',
      'm/f',
      'm/g/h/i/j/k',
    ];
    const out = computePackageTreePositions(paths);
    for (const [, p] of out) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    expect(out.size).toBe(paths.length);
  });
});
