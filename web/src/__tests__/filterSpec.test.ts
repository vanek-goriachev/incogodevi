/**
 * Pure-function tests for the persisted FilterSpec shape and its normalizer.
 */

import { describe, expect, it } from 'vitest';

import {
  defaultFilterSpec,
  filterSpecEqual,
  normalizeFilterSpec,
} from '../pages/Main/panels/filterSpec';

describe('defaultFilterSpec', () => {
  it('enables every node kind by default', () => {
    const spec = defaultFilterSpec();
    expect(spec.kinds.package).toBe(true);
    expect(spec.kinds.const).toBe(true);
    expect(spec.find).toBe('');
    expect(spec.packages).toEqual({ mode: 'all', selected: [] });
  });
});

describe('normalizeFilterSpec', () => {
  it('returns defaults when input is null or not an object', () => {
    expect(normalizeFilterSpec(null)).toEqual(defaultFilterSpec());
    expect(normalizeFilterSpec(42)).toEqual(defaultFilterSpec());
    expect(normalizeFilterSpec('oops')).toEqual(defaultFilterSpec());
  });

  it('merges partially valid inputs onto defaults', () => {
    const result = normalizeFilterSpec({
      v: 1,
      kinds: { func: false, made_up: true },
      packages: { mode: 'subset', selected: ['api', 7, 'config'] },
      find: 'handler',
    });
    expect(result.kinds.func).toBe(false);
    expect(result.kinds.struct).toBe(true); // unchanged default
    expect(result.packages.mode).toBe('subset');
    expect(result.packages.selected).toEqual(['api', 'config']);
    expect(result.find).toBe('handler');
  });

  it('falls back to all-mode when packages.mode is unknown', () => {
    const result = normalizeFilterSpec({ packages: { mode: 'whatever' } });
    expect(result.packages.mode).toBe('all');
  });
});

describe('filterSpecEqual', () => {
  it('returns true for structurally identical specs', () => {
    expect(filterSpecEqual(defaultFilterSpec(), defaultFilterSpec())).toBe(true);
  });

  it('detects a change in any single kind toggle', () => {
    const a = defaultFilterSpec();
    const b = { ...defaultFilterSpec(), kinds: { ...defaultFilterSpec().kinds, var: false } };
    expect(filterSpecEqual(a, b)).toBe(false);
  });

  it('detects a change in find or packages', () => {
    const a = defaultFilterSpec();
    expect(filterSpecEqual(a, { ...a, find: 'x' })).toBe(false);
    expect(
      filterSpecEqual(a, { ...a, packages: { mode: 'subset', selected: ['api'] } }),
    ).toBe(false);
  });
});
