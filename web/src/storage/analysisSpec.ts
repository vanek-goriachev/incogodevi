/**
 * Helpers to read the per-project analysis spec from localStorage.
 *
 * Mirrors the storage schema in `docs/design.md` §8 — `go-viz:<id>:entry-points`
 * and `go-viz:<id>:filters`. The values are written by the entry-points and
 * filters panels (T21 / T22). This module provides typed read access plus
 * defaults so the Analyzing view can issue a meaningful first-run analysis
 * even before the user has touched those panels.
 *
 * Defaults follow `docs/api-contract.md` §2: `mode: "auto"`, all 8 node kinds,
 * `stdlib_exclude: true`, `test_exclude: true`. These match the backend
 * defaults; sending them explicitly keeps the wire payload deterministic.
 */

import { ALL_NODE_KINDS, type EntryPointSpec, type Filters } from '../api/types';
import { projectKey } from './keys';

/** Default `EntryPointSpec` used when no per-project value is stored. */
export const DEFAULT_ENTRY_POINT_SPEC: EntryPointSpec = {
  mode: 'auto',
  auto_kinds: ['main'],
  manual: [],
  interface_impl: [],
};

/** Default `Filters` value used when no per-project value is stored. */
export const DEFAULT_FILTERS: Filters = {
  include_kinds: [...ALL_NODE_KINDS],
  exclude_paths: [],
  stdlib_exclude: true,
  test_exclude: true,
};

/** Read the persisted entry-point spec or return a fresh defaults copy. */
export function readEntryPointSpec(projectId: string): EntryPointSpec {
  const raw = readJson(projectKey(projectId, 'entry-points'));
  if (raw === null || typeof raw !== 'object') {
    return cloneSpec(DEFAULT_ENTRY_POINT_SPEC);
  }
  const candidate = raw as Partial<EntryPointSpec>;
  if (!isValidMode(candidate.mode)) {
    return cloneSpec(DEFAULT_ENTRY_POINT_SPEC);
  }
  return {
    mode: candidate.mode,
    auto_kinds: stringArray(candidate.auto_kinds, DEFAULT_ENTRY_POINT_SPEC.auto_kinds),
    manual: stringArray(candidate.manual, DEFAULT_ENTRY_POINT_SPEC.manual),
    interface_impl: stringArray(
      candidate.interface_impl,
      DEFAULT_ENTRY_POINT_SPEC.interface_impl,
    ),
  };
}

/** Read the persisted filters or return a fresh defaults copy. */
export function readFilters(projectId: string): Filters {
  const raw = readJson(projectKey(projectId, 'filters'));
  if (raw === null || typeof raw !== 'object') {
    return cloneFilters(DEFAULT_FILTERS);
  }
  const candidate = raw as Partial<Filters>;
  return {
    include_kinds: filterKnownKinds(candidate.include_kinds),
    exclude_paths: stringArray(candidate.exclude_paths, DEFAULT_FILTERS.exclude_paths),
    stdlib_exclude:
      typeof candidate.stdlib_exclude === 'boolean'
        ? candidate.stdlib_exclude
        : DEFAULT_FILTERS.stdlib_exclude,
    test_exclude:
      typeof candidate.test_exclude === 'boolean'
        ? candidate.test_exclude
        : DEFAULT_FILTERS.test_exclude,
  };
}

function cloneSpec(spec: EntryPointSpec): EntryPointSpec {
  return {
    mode: spec.mode,
    auto_kinds: [...spec.auto_kinds],
    manual: [...spec.manual],
    interface_impl: [...spec.interface_impl],
  };
}

function cloneFilters(filters: Filters): Filters {
  return {
    include_kinds: [...filters.include_kinds],
    exclude_paths: [...filters.exclude_paths],
    stdlib_exclude: filters.stdlib_exclude,
    test_exclude: filters.test_exclude,
  };
}

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return null;
    }
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isValidMode(value: unknown): value is EntryPointSpec['mode'] {
  return value === 'auto' || value === 'manual' || value === 'mixed';
}

function stringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  return value.filter((v): v is string => typeof v === 'string');
}

function filterKnownKinds(value: unknown): Filters['include_kinds'] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_FILTERS.include_kinds];
  }
  const known = new Set<string>(ALL_NODE_KINDS);
  const out = value.filter((v): v is string => typeof v === 'string' && known.has(v));
  if (out.length === 0) {
    return [...DEFAULT_FILTERS.include_kinds];
  }
  return out as Filters['include_kinds'];
}
