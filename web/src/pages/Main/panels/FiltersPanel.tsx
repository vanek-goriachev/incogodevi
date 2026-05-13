/**
 * Left-rail "Filter" panel (design.md §3.3).
 *
 * Renders three sections:
 *
 *   1. Eight `<NodeKind>` checkboxes (FR-14). Each row carries a colored
 *      legend swatch that mirrors the per-kind palette from design.md §5.1
 *      so the UI doubles as a graph legend.
 *   2. A `Packages` collapsible with a checkbox per package present in the
 *      current graph snapshot. A search input appears once the package count
 *      passes `PACKAGE_SEARCH_THRESHOLD` so dense projects stay usable.
 *   3. A `Find` search input that highlights matching nodes. Updates are
 *      debounced (`FIND_DEBOUNCE_MS`) so per-keystroke writes do not stall
 *      the canvas. The global `/` hotkey focuses this input (design.md §4).
 *
 * The panel is "controlled" — `value`/`onChange` flow ownership of the spec
 * up to `MainView`, which both persists it to `localStorage` and forwards it
 * to `useFilters` for application onto Cytoscape. Keeping persistence out of
 * this component makes it trivial to mount in tests.
 */

import type { Core } from 'cytoscape';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { ALL_NODE_KINDS, type Graph, type NodeKind } from '../../../api/types';
import { NODE_KIND_STYLES } from '../graph-styles';
import {
  defaultFilterSpec,
  filterSpecEqual,
  type FilterSpec,
} from './filterSpec';
import './FiltersPanel.css';

/** Show the package-search input once the package list grows past this. */
export const PACKAGE_SEARCH_THRESHOLD = 20;

/**
 * Maximum number of matched package paths the bulk-filter UI lists at once.
 * Past this we show a "…еще N" hint so a project with thousands of mocks
 * does not paint the DOM into oblivion.
 */
export const PACKAGE_FILTER_PREVIEW_LIMIT = 30;

/**
 * Hard ceiling on the bulk-filter regex length. Acts as a soft mitigation
 * against catastrophic-backtracking patterns the user might paste in by
 * accident. Combined with the try/catch around `new RegExp`, a malicious
 * pattern is silently rejected (empty match set + red border) instead of
 * locking up the React render loop.
 */
export const PACKAGE_FILTER_MAX_REGEX_LENGTH = 200;

/** Debounce for the `Find` input: spec mandates 150 ms (task §В scope). */
export const FIND_DEBOUNCE_MS = 150;

/**
 * Friendly per-kind labels — uppercase first letter so they line up nicely as
 * column headings even on dense screens.
 */
const KIND_LABELS: Readonly<Record<NodeKind, string>> = {
  package: 'Packages',
  struct: 'Structs',
  interface: 'Interfaces',
  func: 'Functions',
  method: 'Methods',
  field: 'Fields',
  var: 'Vars',
  const: 'Consts',
};

export interface FiltersPanelProps {
  /** Latest graph snapshot — used to derive the package list and disabled state. */
  graph: Graph | null;
  /** Current filter spec (typically loaded from localStorage by the parent). */
  value: FilterSpec;
  /** Notify the parent of any user-initiated change. */
  onChange: (next: FilterSpec) => void;
  /**
   * Live Cytoscape core. When provided, kind counts and the package list are
   * derived from `cy.nodes()` and refreshed on `add` / `remove` events so the
   * panel reflects the actual on-canvas elements (R4-2). After a package
   * expansion the React `graph` prop still references the aggregated snapshot
   * — only the cy core knows the freshly inserted member nodes.
   */
  cy?: Core | null;
  /**
   * Optional callback wired from `MainView`. Triggered by the bulk filter
   * UI's "Создать группу из фильтра" button — the filter section computes
   * the longest common prefix across matched packages (or falls back to the
   * filter string itself) and asks the Layer Editor to open its "+ Группа"
   * form with that prefix pre-filled. Wiring goes through `MainView` rather
   * than a global to keep the React tree explicit.
   */
  onCreateGroupFromFilter?: (prefix: string) => void;
}

/**
 * Snapshot of the on-canvas (or fallback graph-prop) population that the
 * panel uses to derive its kind counts, package list, and external split.
 */
interface CanvasSnapshot {
  kindCounts: Record<NodeKind, number>;
  packages: string[];
  externalPackages: Set<string>;
  externalCount: number;
}

/** Empty snapshot used when neither `cy` nor `graph` is available. */
function emptySnapshot(): CanvasSnapshot {
  const counts = {} as Record<NodeKind, number>;
  for (const k of ALL_NODE_KINDS) {
    counts[k] = 0;
  }
  return {
    kindCounts: counts,
    packages: [],
    externalPackages: new Set<string>(),
    externalCount: 0,
  };
}

/**
 * Snapshot derived from the live Cytoscape core. Walks `cy.nodes()` once,
 * collects per-kind counts, the deduplicated package list, and the set of
 * packages whose representative node carries `external: true`. We classify
 * a package as external if any of its on-canvas nodes is external — the
 * backend always tags every node from a stdlib/third-party package, so a
 * single positive vote is sufficient and saves a follow-up ratio check.
 */
function snapshotFromCy(cy: Core): CanvasSnapshot {
  const snap = emptySnapshot();
  const pkgSet = new Set<string>();
  cy.nodes().forEach((n) => {
    const kind = String(n.data('kind') ?? '') as NodeKind;
    if (snap.kindCounts[kind] !== undefined) {
      snap.kindCounts[kind] += 1;
    }
    const pkg = String(n.data('package') ?? '');
    if (pkg !== '') {
      pkgSet.add(pkg);
      if (n.data('external') === true) {
        snap.externalPackages.add(pkg);
      }
    }
    if (n.data('external') === true) {
      snap.externalCount += 1;
    }
  });
  snap.packages = Array.from(pkgSet).sort((a, b) => a.localeCompare(b));
  return snap;
}

/** Snapshot derived from the React graph snapshot (fallback before cy mounts). */
function snapshotFromGraph(graph: Graph | null): CanvasSnapshot {
  const snap = emptySnapshot();
  if (graph === null) {
    return snap;
  }
  const pkgSet = new Set<string>();
  for (const n of graph.nodes) {
    if (snap.kindCounts[n.kind] !== undefined) {
      snap.kindCounts[n.kind] += 1;
    }
    if (n.package !== '') {
      pkgSet.add(n.package);
      if (n.external === true) {
        snap.externalPackages.add(n.package);
      }
    }
    if (n.external === true) {
      snap.externalCount += 1;
    }
  }
  snap.packages = Array.from(pkgSet).sort((a, b) => a.localeCompare(b));
  return snap;
}

/**
 * Match `pkg` against `needle`. Substring mode is case-insensitive; regex
 * mode honours JavaScript's `RegExp` flags inferred from `/<pattern>/<flags>`
 * notation. Returns `false` for any invalid input combination (caller
 * filters with the same helper, but the regex-error path uses
 * `compilePackageRegex` to surface the parse failure to the UI).
 */
export function packagePathMatches(
  pkg: string,
  needle: string,
  useRegex: boolean,
  regex?: RegExp | null,
): boolean {
  if (needle === '') return false;
  if (useRegex) {
    if (regex === null || regex === undefined) return false;
    try {
      return regex.test(pkg);
    } catch {
      return false;
    }
  }
  return pkg.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Compile a regex from the user's text input. Returns `{ ok, regex }` on
 * success and `{ ok: false, error }` on parse failure / over-long input so
 * the panel can render a red border + empty list.
 */
export function compilePackageRegex(
  raw: string,
): { ok: true; regex: RegExp } | { ok: false; error: string } {
  if (raw === '') {
    return { ok: false, error: 'Пустой шаблон' };
  }
  if (raw.length > PACKAGE_FILTER_MAX_REGEX_LENGTH) {
    return { ok: false, error: 'Слишком длинный шаблон' };
  }
  try {
    return { ok: true, regex: new RegExp(raw, 'i') };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Невалидный шаблон',
    };
  }
}

/**
 * Longest common prefix across `packages`. Used by "Создать группу из
 * фильтра" to seed the Layer Editor's "+ Группа" form. When the matched
 * packages do not share a usable common prefix (length < 1 OR a single
 * character that is not a path segment), we fall back to the filter
 * string itself (caller decides). Pure function — exported for tests.
 */
export function longestCommonPathPrefix(packages: readonly string[]): string {
  if (packages.length === 0) return '';
  if (packages.length === 1) return packages[0] ?? '';
  let prefix = packages[0] ?? '';
  for (let i = 1; i < packages.length; i += 1) {
    const cur = packages[i] ?? '';
    let j = 0;
    while (j < prefix.length && j < cur.length && prefix[j] === cur[j]) {
      j += 1;
    }
    prefix = prefix.slice(0, j);
    if (prefix === '') break;
  }
  // Trim trailing partial path segments — `a/mocks/foo` and `a/mocks/bar`
  // produce `a/mocks/` which we want to surface as `a/mocks`.
  while (prefix.length > 0 && prefix.endsWith('/')) {
    prefix = prefix.slice(0, -1);
  }
  return prefix;
}

/**
 * Filters panel. Keeps a small amount of internal state for the (debounced)
 * `find` input and the package-search filter; persistent filter state lives in
 * `value` and is updated through `onChange`.
 */
export function FiltersPanel({
  graph,
  value,
  onChange,
  cy = null,
  onCreateGroupFromFilter,
}: FiltersPanelProps): JSX.Element {
  // Bumped on every cy `add` / `remove` so the snapshot memo recomputes.
  // We don't read this counter directly — its mere presence in the dep array
  // is what forces `useMemo` to re-run.
  const [cyTopologyTick, setCyTopologyTick] = useState<number>(0);

  useEffect(() => {
    if (cy === null) {
      return undefined;
    }
    const bump = (): void => {
      setCyTopologyTick((n) => n + 1);
    };
    cy.on('add', 'node', bump);
    cy.on('remove', 'node', bump);
    cy.on('data', 'node', bump);
    // Initial sync — the cy core may already hold the graph by the time the
    // panel mounts (route change inside an SPA, hot reload, etc.).
    bump();
    return () => {
      cy.off('add', 'node', bump);
      cy.off('remove', 'node', bump);
      cy.off('data', 'node', bump);
    };
  }, [cy]);

  // Prefer the live cy snapshot (R4-2). Falls back to the React graph prop
  // only when the cy core is not yet mounted — for an instant after the
  // first analyse the panel still has data to render.
  // cyTopologyTick is part of the dep array on purpose — see effect above:
  // it is the signal that cy.nodes() may have changed even though the cy
  // reference itself is stable. Eslint can't tell so we silence the rule.
  const snapshot = useMemo<CanvasSnapshot>(
    () => {
      if (cy !== null) {
        return snapshotFromCy(cy);
      }
      return snapshotFromGraph(graph);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cy, graph, cyTopologyTick],
  );

  const packages = snapshot.packages;
  const kindCounts = snapshot.kindCounts;

  // R4-7: split packages into the user's own module vs external (stdlib,
  // third-party). The split is purely visual; both lists feed the same
  // FilterSpec.packages so the existing "subset" logic doesn't change.
  const localPackages = useMemo(
    () => packages.filter((p) => !snapshot.externalPackages.has(p)),
    [packages, snapshot.externalPackages],
  );
  const externalPackages = useMemo(
    () => packages.filter((p) => snapshot.externalPackages.has(p)),
    [packages, snapshot.externalPackages],
  );

  const [findDraft, setFindDraft] = useState<string>(value.find);
  const [packageQuery, setPackageQuery] = useState<string>('');
  // Bulk package-filter state. `bulkQuery` is the text in the input;
  // `bulkUseRegex` flips between substring (default) and regex modes. The
  // panel re-derives the live match list on every keystroke without
  // debouncing — the matching is O(packageCount) and well inside the
  // NFR-03 budget even on 1000-package graphs.
  const [bulkQuery, setBulkQuery] = useState<string>('');
  const [bulkUseRegex, setBulkUseRegex] = useState<boolean>(false);
  const findInputRef = useRef<HTMLInputElement | null>(null);

  // Keep the local input draft in sync if the parent rewrites the spec
  // (e.g. cross-tab `storage` event, project switch).
  useEffect(() => {
    setFindDraft(value.find);
  }, [value.find]);

  // Debounce the find input so successive keystrokes do not flush the
  // Cytoscape highlighter on every character.
  useEffect(() => {
    if (findDraft === value.find) {
      return undefined;
    }
    const timer = setTimeout(() => {
      onChange({ ...value, find: findDraft });
    }, FIND_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [findDraft, value, onChange]);

  // `/` global hotkey — focus the search input. Skip when the user is already
  // typing in another input/textarea so we do not steal focus.
  useEffect(() => {
    function onKey(evt: KeyboardEvent): void {
      if (evt.key !== '/') {
        return;
      }
      if (evt.metaKey || evt.ctrlKey || evt.altKey) {
        return;
      }
      const tgt = evt.target;
      if (tgt instanceof HTMLElement) {
        const tag = tgt.tagName.toLowerCase();
        const isEditable =
          tag === 'input' || tag === 'textarea' || tgt.isContentEditable;
        if (isEditable) {
          return;
        }
      }
      const node = findInputRef.current;
      if (node !== null) {
        evt.preventDefault();
        node.focus();
        node.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const handleKindToggle = useCallback(
    (kind: NodeKind, on: boolean) => {
      const next: FilterSpec = {
        ...value,
        kinds: { ...value.kinds, [kind]: on },
      };
      if (!filterSpecEqual(next, value)) {
        onChange(next);
      }
    },
    [value, onChange],
  );

  const handlePackageToggle = useCallback(
    (pkg: string, on: boolean) => {
      // In 'all' mode the `selected` list is empty; expand it to the full
      // set first so the user's intent ("show all but X") survives a single
      // uncheck. Once the user re-selects everything the mode collapses back
      // to 'all' for parity with the initial state.
      const baseline =
        value.packages.mode === 'all'
          ? new Set(packages)
          : new Set(value.packages.selected);
      if (on) {
        baseline.add(pkg);
      } else {
        baseline.delete(pkg);
      }
      const selected = Array.from(baseline).sort((a, b) => a.localeCompare(b));
      const mode: 'all' | 'subset' =
        selected.length === packages.length ? 'all' : 'subset';
      onChange({
        ...value,
        packages: { mode, selected: mode === 'all' ? [] : selected },
      });
    },
    [value, packages, onChange],
  );

  const handleResetPackages = useCallback(() => {
    onChange({ ...value, packages: { mode: 'all', selected: [] } });
  }, [value, onChange]);

  const handleResetAll = useCallback(() => {
    setFindDraft('');
    onChange(defaultFilterSpec());
  }, [onChange]);

  const handleHideExternalToggle = useCallback(
    (on: boolean) => {
      if (value.hideExternal === on) {
        return;
      }
      onChange({ ...value, hideExternal: on });
    },
    [value, onChange],
  );

  const externalCount = snapshot.externalCount;

  const handleFindChange = useCallback(
    (evt: React.ChangeEvent<HTMLInputElement>) => {
      setFindDraft(evt.target.value);
    },
    [],
  );

  const handleFindKeyDown = useCallback(
    (evt: React.KeyboardEvent<HTMLInputElement>) => {
      if (evt.key === 'Escape') {
        evt.preventDefault();
        setFindDraft('');
        if (value.find !== '') {
          onChange({ ...value, find: '' });
        }
        evt.currentTarget.blur();
      }
    },
    [value, onChange],
  );

  // -------------------------------------------------------------------------
  // Bulk package filter (Feature 3 — this PR). Derives the matching package
  // list from `bulkQuery` + `bulkUseRegex`. The match flows into:
  //   - the preview list shown under the input (visual confirmation),
  //   - the "Скрыть найденные" / "Показать найденные" buttons which mutate
  //     the SAME per-package visibility flags the existing checkboxes use,
  //   - the "Создать группу из фильтра" button which feeds the longest
  //     common prefix of matched packages back to the Layer Editor.
  // -------------------------------------------------------------------------
  const bulkRegexResult = useMemo(() => {
    if (!bulkUseRegex) return null;
    if (bulkQuery === '') return null;
    return compilePackageRegex(bulkQuery);
  }, [bulkQuery, bulkUseRegex]);

  const bulkMatches = useMemo<string[]>(() => {
    if (bulkQuery === '') return [];
    if (bulkUseRegex) {
      if (bulkRegexResult === null || !bulkRegexResult.ok) return [];
      return packages.filter((p) =>
        packagePathMatches(p, bulkQuery, true, bulkRegexResult.regex),
      );
    }
    return packages.filter((p) =>
      packagePathMatches(p, bulkQuery, false, null),
    );
  }, [packages, bulkQuery, bulkUseRegex, bulkRegexResult]);

  const bulkRegexError =
    bulkUseRegex && bulkQuery !== '' && bulkRegexResult !== null && !bulkRegexResult.ok
      ? bulkRegexResult.error
      : null;

  // Bulk-action plumbing: flipping visibility for a SET of packages should
  // route through the same FilterSpec mutation as the per-package
  // checkboxes. We compute the resulting `selected` list + mode in one
  // shot so the spec change is atomic.
  const applyBulkVisibility = useCallback(
    (matchedPackages: readonly string[], on: boolean) => {
      if (matchedPackages.length === 0) return;
      const baseline =
        value.packages.mode === 'all'
          ? new Set(packages)
          : new Set(value.packages.selected);
      for (const pkg of matchedPackages) {
        if (on) baseline.add(pkg);
        else baseline.delete(pkg);
      }
      const selected = Array.from(baseline).sort((a, b) => a.localeCompare(b));
      const mode: 'all' | 'subset' =
        selected.length === packages.length ? 'all' : 'subset';
      onChange({
        ...value,
        packages: { mode, selected: mode === 'all' ? [] : selected },
      });
    },
    [value, packages, onChange],
  );

  const handleBulkHide = useCallback(() => {
    applyBulkVisibility(bulkMatches, false);
  }, [applyBulkVisibility, bulkMatches]);
  const handleBulkShow = useCallback(() => {
    applyBulkVisibility(bulkMatches, true);
  }, [applyBulkVisibility, bulkMatches]);

  const handleCreateGroupFromFilter = useCallback(() => {
    if (onCreateGroupFromFilter === undefined) return;
    if (bulkMatches.length === 0) return;
    const lcp = longestCommonPathPrefix(bulkMatches);
    // Fall back to the literal filter query when the LCP is empty or too
    // short to be a useful prefix on its own.
    const prefix = lcp.length >= 2 ? lcp : bulkQuery;
    onCreateGroupFromFilter(prefix);
  }, [bulkMatches, bulkQuery, onCreateGroupFromFilter]);

  const filteredLocalPackages = useMemo(() => {
    if (packageQuery === '') {
      return localPackages;
    }
    const needle = packageQuery.toLowerCase();
    return localPackages.filter((p) => p.toLowerCase().includes(needle));
  }, [localPackages, packageQuery]);

  const filteredExternalPackages = useMemo(() => {
    if (packageQuery === '') {
      return externalPackages;
    }
    const needle = packageQuery.toLowerCase();
    return externalPackages.filter((p) => p.toLowerCase().includes(needle));
  }, [externalPackages, packageQuery]);

  const renderPackageRow = useCallback(
    (pkg: string): JSX.Element => {
      const isOn =
        value.packages.mode === 'all' || value.packages.selected.includes(pkg);
      return (
        <li key={pkg}>
          <label className="filters-panel__row">
            <input
              type="checkbox"
              checked={isOn}
              onChange={(evt) => {
                handlePackageToggle(pkg, evt.target.checked);
              }}
              aria-label={`Toggle package ${pkg}`}
              data-testid={`filters-package-${pkg}`}
            />
            <span className="filters-panel__row-label filters-panel__row-label--mono">
              {pkg}
            </span>
          </label>
        </li>
      );
    },
    [value.packages, handlePackageToggle],
  );

  return (
    <section className="filters-panel" aria-label="Filters" data-testid="filters-panel">
      <header className="filters-panel__head">
        <h3 className="filters-panel__title">Filter</h3>
        <button
          type="button"
          className="filters-panel__reset"
          onClick={handleResetAll}
          data-testid="filters-reset"
        >
          reset
        </button>
      </header>

      <div className="filters-panel__group" data-testid="filters-external-group">
        <label
          className={`filters-panel__row${externalCount === 0 ? ' filters-panel__row--disabled' : ''}`}
          data-testid="filters-hide-external"
        >
          <input
            type="checkbox"
            checked={value.hideExternal}
            disabled={externalCount === 0}
            onChange={(evt) => {
              handleHideExternalToggle(evt.target.checked);
            }}
            aria-label="Hide external packages"
          />
          <span className="filters-panel__row-label">Hide external packages</span>
          <span className="filters-panel__row-count" data-testid="filters-external-count">
            {externalCount}
          </span>
        </label>
        <p className="filters-panel__hint">
          Stdlib and third-party deps loaded transitively.
        </p>
      </div>

      <fieldset className="filters-panel__group" data-testid="filters-kinds">
        <legend className="filters-panel__legend">Show kinds</legend>
        {ALL_NODE_KINDS.map((kind) => {
          const count = kindCounts[kind];
          const disabled = count === 0;
          const style = NODE_KIND_STYLES[kind];
          return (
            <label
              key={kind}
              className={`filters-panel__row${disabled ? ' filters-panel__row--disabled' : ''}`}
              data-testid={`filters-kind-${kind}`}
            >
              <input
                type="checkbox"
                checked={value.kinds[kind]}
                disabled={disabled}
                onChange={(evt) => {
                  handleKindToggle(kind, evt.target.checked);
                }}
                aria-label={`Toggle ${KIND_LABELS[kind]}`}
              />
              <span
                aria-hidden="true"
                className="filters-panel__swatch"
                style={{ backgroundColor: style.fill, borderColor: style.border }}
              />
              <span className="filters-panel__row-label">{KIND_LABELS[kind]}</span>
              <span className="filters-panel__row-count" data-testid={`filters-kind-count-${kind}`}>
                {count}
              </span>
            </label>
          );
        })}
      </fieldset>

      <div
        className="filters-panel__group filters-panel__group--bulk"
        data-testid="filters-package-bulk"
      >
        <label
          className="filters-panel__legend"
          htmlFor="filters-package-bulk-input"
        >
          Фильтр пакетов
        </label>
        <input
          id="filters-package-bulk-input"
          type="search"
          className={`filters-panel__pkg-search${
            bulkRegexError !== null ? ' filters-panel__pkg-search--error' : ''
          }`}
          placeholder={bulkUseRegex ? '/^mocks$/' : 'mocks'}
          value={bulkQuery}
          onChange={(evt) => {
            setBulkQuery(evt.target.value);
          }}
          aria-label="Bulk package filter"
          aria-invalid={bulkRegexError !== null}
          spellCheck={false}
          autoComplete="off"
          data-testid="filters-package-bulk-input"
        />
        <label className="filters-panel__row filters-panel__row--inline">
          <input
            type="checkbox"
            checked={bulkUseRegex}
            onChange={(evt) => {
              setBulkUseRegex(evt.target.checked);
            }}
            aria-label="Toggle regex matching"
            data-testid="filters-package-bulk-regex"
          />
          <span className="filters-panel__row-label">Regex</span>
        </label>
        {bulkRegexError !== null ? (
          <p className="filters-panel__hint filters-panel__hint--error">
            {bulkRegexError}
          </p>
        ) : null}
        <p
          className="filters-panel__hint"
          data-testid="filters-package-bulk-count"
        >
          {bulkQuery === ''
            ? 'Введите фильтр, чтобы скрыть или показать пакеты разом.'
            : `Найдено ${String(bulkMatches.length)} пакетов`}
        </p>
        {bulkMatches.length > 0 ? (
          <ul
            className="filters-panel__pkg-list filters-panel__pkg-list--bulk"
            data-testid="filters-package-bulk-list"
          >
            {bulkMatches.slice(0, PACKAGE_FILTER_PREVIEW_LIMIT).map((p) => (
              <li
                key={p}
                className="filters-panel__row-label filters-panel__row-label--mono"
                data-testid={`filters-package-bulk-match-${p}`}
              >
                {p}
              </li>
            ))}
            {bulkMatches.length > PACKAGE_FILTER_PREVIEW_LIMIT ? (
              <li className="filters-panel__hint">
                …еще {String(bulkMatches.length - PACKAGE_FILTER_PREVIEW_LIMIT)}
              </li>
            ) : null}
          </ul>
        ) : null}
        <div className="filters-panel__bulk-actions">
          <button
            type="button"
            className="filters-panel__reset"
            onClick={handleBulkHide}
            disabled={bulkMatches.length === 0}
            data-testid="filters-package-bulk-hide"
          >
            Скрыть найденные
          </button>
          <button
            type="button"
            className="filters-panel__reset"
            onClick={handleBulkShow}
            disabled={bulkMatches.length === 0}
            data-testid="filters-package-bulk-show"
          >
            Показать найденные
          </button>
          {onCreateGroupFromFilter !== undefined ? (
            <button
              type="button"
              className="filters-panel__reset"
              onClick={handleCreateGroupFromFilter}
              disabled={bulkMatches.length === 0}
              data-testid="filters-package-bulk-group"
            >
              Создать группу из фильтра
            </button>
          ) : null}
        </div>
      </div>

      <details className="filters-panel__group" data-testid="filters-packages">
        <summary className="filters-panel__legend">
          Packages
          <span className="filters-panel__row-count">
            {value.packages.mode === 'all'
              ? `all (${String(packages.length)})`
              : `${String(value.packages.selected.length)}/${String(packages.length)}`}
          </span>
        </summary>
        {packages.length === 0 ? (
          <p className="filters-panel__hint">No packages in this graph.</p>
        ) : (
          <>
            {packages.length > PACKAGE_SEARCH_THRESHOLD ? (
              <input
                type="search"
                className="filters-panel__pkg-search"
                placeholder="Search packages"
                value={packageQuery}
                onChange={(evt) => {
                  setPackageQuery(evt.target.value);
                }}
                aria-label="Search packages"
                data-testid="filters-package-search"
              />
            ) : null}
            <button
              type="button"
              className="filters-panel__reset filters-panel__reset--inline"
              onClick={handleResetPackages}
              data-testid="filters-packages-reset"
            >
              show all
            </button>
            <ul
              className="filters-panel__pkg-list"
              data-testid="filters-package-list"
            >
              {filteredLocalPackages.map((pkg) => renderPackageRow(pkg))}
              {filteredLocalPackages.length === 0
              && filteredExternalPackages.length === 0 ? (
                <li className="filters-panel__hint">No packages match.</li>
              ) : null}
            </ul>
            {externalPackages.length > 0 ? (
              <details
                className="filters-panel__group filters-panel__group--nested"
                data-testid="filters-packages-external"
              >
                <summary className="filters-panel__legend">
                  External
                  <span className="filters-panel__row-count">
                    {String(externalPackages.length)}
                  </span>
                </summary>
                <p className="filters-panel__hint">
                  Stdlib and third-party deps loaded transitively.
                </p>
                <ul
                  className="filters-panel__pkg-list"
                  data-testid="filters-package-list-external"
                >
                  {filteredExternalPackages.map((pkg) => renderPackageRow(pkg))}
                  {filteredExternalPackages.length === 0 ? (
                    <li className="filters-panel__hint">No external packages match.</li>
                  ) : null}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </details>

      <div className="filters-panel__group" data-testid="filters-find-group">
        <label className="filters-panel__legend" htmlFor="filters-find-input">
          Find
        </label>
        <input
          id="filters-find-input"
          ref={findInputRef}
          type="search"
          role="searchbox"
          className="filters-panel__find"
          placeholder="Highlight nodes by name"
          value={findDraft}
          onChange={handleFindChange}
          onKeyDown={handleFindKeyDown}
          aria-label="Find nodes by name"
          data-testid="filters-find"
        />
        <p className="filters-panel__hint">
          Press <kbd>/</kbd> to focus, <kbd>Esc</kbd> to clear.
        </p>
      </div>
    </section>
  );
}
