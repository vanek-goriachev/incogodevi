/**
 * Pure ranker for the entry-point picker combobox.
 *
 * Given a flat symbol catalogue (see `SymbolEntry` in `api/types.ts`) and a
 * search needle, returns the best-matching candidates in descending order
 * of relevance, truncated to `limit`. The ranker is intentionally extracted
 * from the React component so it can be unit-tested without a Cytoscape /
 * DOM mock — `EntryPointsPanel.test.tsx` covers the component glue, this
 * module covers the matching semantics.
 *
 * Match rules (mirrors the pattern PR #49 introduced in `useFilters.ts`):
 *
 *   - Case-insensitive substring match against either the human-friendly
 *     `name` (which already encodes `Type.Method` for methods) OR the
 *     receiver-aware canonical `fqn` (`pkg#Type.Method`).
 *   - Empty needle returns the first `limit` candidates as-is (alphabetical
 *     order is preserved from the server's response).
 *
 * Scoring tiers (higher = closer to the top):
 *
 *   3  name starts with the needle           — most predictable hit
 *   2  name contains the needle as a word    — token match
 *   1  name contains the needle              — substring fall-back
 *   0  only the FQN matches (package path)   — last resort
 *
 * Ties break on shorter name length, then alphabetical package.
 */

import type { SymbolEntry } from '../../../api/types';

/** Default candidate cap surfaced by the picker dropdown. */
export const DEFAULT_PICKER_LIMIT = 10;

export interface RankedSymbol {
  symbol: SymbolEntry;
  score: number;
}

/**
 * Rank `symbols` against `query` and return up to `limit` best matches.
 *
 * Stable: when two entries have the same score, the originally-earlier one
 * wins, so the server's package-then-name ordering survives ties.
 */
export function rankSymbols(
  symbols: readonly SymbolEntry[],
  query: string,
  limit: number = DEFAULT_PICKER_LIMIT,
): SymbolEntry[] {
  const needle = query.trim().toLowerCase();
  if (limit <= 0) {
    return [];
  }
  if (needle === '') {
    return symbols.slice(0, limit);
  }

  const ranked: { entry: SymbolEntry; score: number; index: number }[] = [];
  for (let i = 0; i < symbols.length; i += 1) {
    const entry = symbols[i];
    if (entry === undefined) {
      continue;
    }
    const score = scoreSymbol(entry, needle);
    if (score < 0) {
      continue;
    }
    ranked.push({ entry, score, index: i });
  }

  ranked.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    if (a.entry.name.length !== b.entry.name.length) {
      return a.entry.name.length - b.entry.name.length;
    }
    if (a.entry.package !== b.entry.package) {
      return a.entry.package.localeCompare(b.entry.package);
    }
    return a.index - b.index;
  });

  return ranked.slice(0, limit).map((r) => r.entry);
}

/**
 * Returns `-1` when neither the name nor the FQN matches, otherwise the
 * scoring tier (0..3). Exported for unit testing only.
 */
export function scoreSymbol(entry: SymbolEntry, needle: string): number {
  const name = entry.name.toLowerCase();
  const fqn = entry.fqn.toLowerCase();

  if (name.startsWith(needle)) {
    return 3;
  }
  // Word-boundary inside `Type.Method` or split on '.'/'_' — cheap heuristic
  // that avoids a heavy tokenizer for the common Go casing.
  const parts = name.split(/[._]/);
  for (const part of parts) {
    if (part === needle) {
      return 2;
    }
    if (part.startsWith(needle)) {
      return 2;
    }
  }
  if (name.includes(needle)) {
    return 1;
  }
  if (fqn.includes(needle)) {
    return 0;
  }
  return -1;
}
