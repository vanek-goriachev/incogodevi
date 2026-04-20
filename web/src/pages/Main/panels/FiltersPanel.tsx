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
}

/**
 * Returns the deduplicated, alphabetically sorted package list extracted from
 * the graph's nodes. Stable order keeps the `<details>` body diff-friendly
 * for React reconciliation.
 */
function derivePackages(graph: Graph | null): string[] {
  if (graph === null) {
    return [];
  }
  const set = new Set<string>();
  for (const n of graph.nodes) {
    if (n.package !== '') {
      set.add(n.package);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Returns the count of nodes per kind so the panel can disable kinds that the
 * current graph does not contain (FiltersPanel UX requirement: "Empty: if in
 * graph there is no kind X — checkbox disabled").
 */
function countPerKind(graph: Graph | null): Record<NodeKind, number> {
  const counts = {} as Record<NodeKind, number>;
  for (const k of ALL_NODE_KINDS) {
    counts[k] = 0;
  }
  if (graph === null) {
    return counts;
  }
  for (const n of graph.nodes) {
    if (counts[n.kind] !== undefined) {
      counts[n.kind] += 1;
    }
  }
  return counts;
}

/**
 * Filters panel. Keeps a small amount of internal state for the (debounced)
 * `find` input and the package-search filter; persistent filter state lives in
 * `value` and is updated through `onChange`.
 */
export function FiltersPanel({ graph, value, onChange }: FiltersPanelProps): JSX.Element {
  const packages = useMemo(() => derivePackages(graph), [graph]);
  const kindCounts = useMemo(() => countPerKind(graph), [graph]);
  const [findDraft, setFindDraft] = useState<string>(value.find);
  const [packageQuery, setPackageQuery] = useState<string>('');
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

  const filteredPackages = useMemo(() => {
    if (packageQuery === '') {
      return packages;
    }
    const needle = packageQuery.toLowerCase();
    return packages.filter((p) => p.toLowerCase().includes(needle));
  }, [packages, packageQuery]);

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
            <ul className="filters-panel__pkg-list" data-testid="filters-package-list">
              {filteredPackages.map((pkg) => {
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
              })}
              {filteredPackages.length === 0 ? (
                <li className="filters-panel__hint">No packages match.</li>
              ) : null}
            </ul>
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
