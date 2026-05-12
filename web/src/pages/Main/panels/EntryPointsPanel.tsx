/**
 * Left-rail "Entry points" panel (design.md §3.3, FR-07, FR-25, FR-26).
 *
 * Owns the manual entry list rendered above the filters panel. Behaviour:
 *
 *   - "all main" checkbox toggles the auto-mode that picks every `func main`.
 *     When auto is on the manual list still applies on top of it (mixed mode
 *     in `EntryPointSpec`); when off, only manual entries are used.
 *   - Each manual entry shows as a chip with a "remove" button that fires
 *     a removal callback.
 *   - "+ Add entry point" opens a modal dialog where the user can either
 *     pick an existing func/method node from the live graph (with a search
 *     input) or paste a raw FQN (`pkg#Type.Method`).
 *   - Persistence is owned by `MainView` through the `value`/`onChange`
 *     props, mirroring the `FiltersPanel` pattern.
 *
 * Validation of FQNs lives in `./fqn.ts`. The dialog accepts only locally
 * valid input — the `invalid_entry_point` error from `POST /analyze` is
 * surfaced through the optional `lastError` prop so the parent can route
 * server-side rejections back into the dialog without double-handling them.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';

import { ALL_NODE_KINDS, type EntryPointSpec, type Graph, type SymbolEntry } from '../../../api/types';
import type { ApiClient } from '../../../api/client';
import { isValidFqn, nodeToFqn } from './fqn';
import { DEFAULT_PICKER_LIMIT, rankSymbols } from './symbolRanker';
import './EntryPointsPanel.css';

/**
 * Minimal contract the picker needs from the API client. Mirrors the
 * `listSymbols` signature in `api/client.ts` but is kept narrow so tests can
 * pass a hand-rolled fake without instantiating the full `ApiClient`.
 */
export interface EntrySymbolSource {
  listSymbols(projectId: string): Promise<SymbolEntry[]>;
}

export interface EntryPointsPanelProps {
  /** Latest graph snapshot — used to populate the picker. */
  graph: Graph | null;
  /** Currently active entry-point spec (typically loaded from localStorage). */
  value: EntryPointSpec;
  /**
   * Notify the parent of any user-initiated change. Parent is responsible
   * for persisting and triggering a re-analyze.
   */
  onChange: (next: EntryPointSpec) => void;
  /**
   * Optional server-side error from the last `POST /analyze`. Surfaces inside
   * the dialog so the user can correct an invalid FQN without leaving it.
   */
  lastError?: { code: string; message: string } | null;
  /**
   * Optional notification fired when the user attempts to add a duplicate
   * FQN. The parent typically routes this through the global toast queue
   * (NFR-09) while keeping the panel state untouched.
   */
  onDuplicate?: (fqn: string) => void;
  /**
   * Optional flag that disables the controls — mainly used while a re-analyze
   * is in flight so users do not stack changes faster than the orchestrator
   * can serialize them.
   */
  busy?: boolean;
  /**
   * Source of the flat-symbol catalogue used by the picker combobox.
   * `MainView` wires the real `ApiClient`; tests inject a fake. When
   * undefined the picker falls back to the graph-derived candidate set
   * (legacy behaviour) — that path is exercised by existing fixtures whose
   * graph already contains every func/method node.
   */
  apiClient?: ApiClient | EntrySymbolSource;
  /** Project id used when fetching the symbol catalogue. */
  projectId?: string;
}

/** Spec defaults — mirror `storage/analysisSpec.ts`. */
function defaultSpec(): EntryPointSpec {
  return {
    mode: 'auto',
    auto_kinds: ['main'],
    manual: [],
    interface_impl: [],
  };
}

/** Toggle the auto-main checkbox without touching the manual list. */
function withAutoEnabled(spec: EntryPointSpec, on: boolean): EntryPointSpec {
  if (on) {
    if (spec.manual.length > 0) {
      return { ...spec, mode: 'mixed', auto_kinds: ensureMainKind(spec.auto_kinds) };
    }
    return { ...spec, mode: 'auto', auto_kinds: ensureMainKind(spec.auto_kinds) };
  }
  if (spec.manual.length > 0) {
    return { ...spec, mode: 'manual', auto_kinds: [] };
  }
  // Edge case: turn off auto with no manual entries. Keep the spec valid by
  // staying in `manual` mode with an empty list — the backend will then
  // legitimately produce an empty entry-point set; the parent shows a hint.
  return { ...spec, mode: 'manual', auto_kinds: [] };
}

function ensureMainKind(kinds: string[]): string[] {
  if (kinds.includes('main')) {
    return kinds;
  }
  return [...kinds, 'main'];
}

/** Append a manual FQN, switching modes accordingly. */
function withManualAdded(spec: EntryPointSpec, fqn: string): EntryPointSpec {
  if (spec.manual.includes(fqn)) {
    return spec;
  }
  const manual = [...spec.manual, fqn];
  let mode: EntryPointSpec['mode'];
  if (spec.mode === 'auto') {
    mode = 'mixed';
  } else if (spec.mode === 'manual') {
    mode = 'manual';
  } else {
    mode = 'mixed';
  }
  return { ...spec, mode, manual };
}

/** Remove a manual FQN, switching back to auto-only when the list empties. */
function withManualRemoved(spec: EntryPointSpec, fqn: string): EntryPointSpec {
  const manual = spec.manual.filter((m) => m !== fqn);
  let mode = spec.mode;
  if (manual.length === 0) {
    mode = spec.auto_kinds.length > 0 ? 'auto' : 'manual';
  } else if (spec.mode === 'mixed' && spec.auto_kinds.length === 0) {
    mode = 'manual';
  }
  return { ...spec, manual, mode };
}

/** Auto-mode predicate (auto or mixed). */
function isAutoOn(spec: EntryPointSpec): boolean {
  return (spec.mode === 'auto' || spec.mode === 'mixed') && spec.auto_kinds.length > 0;
}

export function EntryPointsPanel({
  graph,
  value,
  onChange,
  lastError = null,
  onDuplicate,
  busy = false,
  apiClient,
  projectId,
}: EntryPointsPanelProps): JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const auto = isAutoOn(value);

  const handleToggleAuto = useCallback(
    (on: boolean): void => {
      if (busy) {
        return;
      }
      onChange(withAutoEnabled(value, on));
    },
    [busy, value, onChange],
  );

  const handleRemove = useCallback(
    (fqn: string): void => {
      if (busy) {
        return;
      }
      onChange(withManualRemoved(value, fqn));
    },
    [busy, value, onChange],
  );

  const handleAddDialogSubmit = useCallback(
    (fqn: string): void => {
      if (value.manual.includes(fqn)) {
        onDuplicate?.(fqn);
        return;
      }
      onChange(withManualAdded(value, fqn));
      setDialogOpen(false);
    },
    [value, onChange, onDuplicate],
  );

  const openDialog = useCallback(() => {
    setDialogOpen(true);
  }, []);
  const closeDialog = useCallback(() => {
    setDialogOpen(false);
  }, []);

  const manualCount = value.manual.length;
  const summary = auto
    ? `auto · ${String(manualCount)} manual`
    : `${String(manualCount)} manual only`;

  return (
    <section
      className="entry-panel"
      aria-label="Entry points"
      data-testid="entry-panel"
    >
      <header className="entry-panel__head">
        <h3 className="entry-panel__title">Entry points</h3>
        <span className="entry-panel__summary" data-testid="entry-panel-summary">
          {summary}
        </span>
      </header>

      <label className="entry-panel__row entry-panel__row--toggle">
        <input
          type="checkbox"
          checked={auto}
          onChange={(evt) => {
            handleToggleAuto(evt.target.checked);
          }}
          disabled={busy}
          data-testid="entry-panel-auto-main"
          aria-label="Use every func main as an entry point"
        />
        <span className="entry-panel__row-label">all <code>func main</code></span>
      </label>

      <ul className="entry-panel__manual" data-testid="entry-panel-manual-list">
        {value.manual.length === 0 ? (
          <li className="entry-panel__hint" data-testid="entry-panel-manual-empty">
            No manual entry points.
          </li>
        ) : (
          value.manual.map((fqn) => (
            <li key={fqn} className="entry-panel__chip" data-testid={`entry-panel-chip-${fqn}`}>
              <span className="entry-panel__chip-label" title={fqn}>{fqn}</span>
              <button
                type="button"
                className="entry-panel__chip-remove"
                onClick={() => {
                  handleRemove(fqn);
                }}
                disabled={busy}
                data-testid={`entry-panel-remove-${fqn}`}
                aria-label={`Remove ${fqn}`}
              >
                {'\u00d7'}
              </button>
            </li>
          ))
        )}
      </ul>

      <button
        type="button"
        className="entry-panel__add"
        onClick={openDialog}
        disabled={busy}
        data-testid="entry-panel-add"
      >
        + Add entry point
      </button>

      {!auto && manualCount === 0 ? (
        <p className="entry-panel__warn" data-testid="entry-panel-warn-empty">
          No entry points selected — every node will be reported as dead.
        </p>
      ) : null}

      {dialogOpen ? (
        <AddEntryDialog
          graph={graph}
          existing={value.manual}
          onSubmit={handleAddDialogSubmit}
          onCancel={closeDialog}
          serverError={lastError}
          apiClient={apiClient}
          projectId={projectId}
        />
      ) : null}
    </section>
  );
}

/** Re-export the spec defaults so consumers (`MainView`) need only one import. */
export const DEFAULT_ENTRY_SPEC: EntryPointSpec = defaultSpec();

/** ---------- Add-entry dialog ---------- */

interface AddEntryDialogProps {
  graph: Graph | null;
  existing: string[];
  onSubmit: (fqn: string) => void;
  onCancel: () => void;
  serverError: { code: string; message: string } | null;
  apiClient: ApiClient | EntrySymbolSource | undefined;
  projectId: string | undefined;
}

/** Tabs inside the dialog: pick (combobox autocomplete) or paste a raw FQN. */
type DialogMode = 'pick' | 'fqn';

/**
 * Last segment of a Go import path — used as a compact, recognisable label
 * next to the picker entries so methods that share a name across packages
 * are still distinguishable in the dropdown (e.g. `Server.Run · server`,
 * `Worker.Run · worker`). Falls back to the full path when no slash exists.
 */
function shortPackageLabel(pkg: string): string {
  if (pkg === '') {
    return '';
  }
  const slash = pkg.lastIndexOf('/');
  if (slash < 0 || slash === pkg.length - 1) {
    return pkg;
  }
  return pkg.slice(slash + 1);
}

/**
 * Build a fallback symbol list from a graph snapshot. Used in two cases:
 *
 *   1. No `apiClient` is wired (tests / Storybook stories).
 *   2. The `listSymbols` request has not resolved yet.
 *
 * The fallback intentionally mirrors the canonical FQN form
 * (`pkg#Name` / `pkg#Type.Method`) so a user typing during the network
 * round-trip still sees usable candidates and the eventual selection
 * matches the loader's accepted form.
 */
function graphToSymbols(graph: Graph | null): SymbolEntry[] {
  if (graph === null) {
    return [];
  }
  const out: SymbolEntry[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'func' && node.kind !== 'method') {
      continue;
    }
    if (node.package === '' || node.name === '') {
      continue;
    }
    const fqn = nodeToFqn(node, graph);
    if (fqn === null) {
      continue;
    }
    const hashAt = fqn.indexOf('#');
    const label = hashAt >= 0 ? fqn.slice(hashAt + 1) : node.name;
    out.push({
      id: node.id,
      name: label,
      fqn,
      kind: node.kind,
      package: node.package,
    });
  }
  return out;
}

function AddEntryDialog({
  graph,
  existing,
  onSubmit,
  onCancel,
  serverError,
  apiClient,
  projectId,
}: AddEntryDialogProps): JSX.Element {
  const [mode, setMode] = useState<DialogMode>('pick');
  const [query, setQuery] = useState<string>('');
  const [fqn, setFqn] = useState<string>('');
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [symbols, setSymbols] = useState<SymbolEntry[]>(() => graphToSymbols(graph));
  const [symbolsLoaded, setSymbolsLoaded] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxRef = useRef<HTMLUListElement | null>(null);
  // Track where the current pointer gesture began so backdrop-click dismissal
  // ignores drags that started on the dialog content (e.g. text drag-select
  // inside the FQN input that releases on the padded backdrop area). Without
  // this guard the dialog would dismiss mid-typing — see PR fixing Bug B.
  const downOnBackdropRef = useRef<boolean>(false);

  // Focus the search input on mount for keyboard-first interaction.
  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  // Esc closes the dialog without committing changes.
  useEffect(() => {
    function onKey(evt: KeyboardEvent): void {
      if (evt.key === 'Escape') {
        evt.preventDefault();
        onCancel();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  // Fetch the flat symbol catalogue on mount when the API client is wired.
  // The list includes symbols inside currently-collapsed packages, so the
  // user can pin entries without expanding anything first. Falls back to a
  // graph-derived list when the request fails or no client was supplied.
  useEffect(() => {
    if (apiClient === undefined || projectId === undefined || projectId === '') {
      // No symbol endpoint available — stay on the graph-derived fallback.
      setSymbolsLoaded(true);
      return;
    }
    let cancelled = false;
    apiClient
      .listSymbols(projectId)
      .then((rows) => {
        if (cancelled) {
          return;
        }
        if (rows.length > 0) {
          setSymbols(rows);
        }
        setSymbolsLoaded(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        // Network failed — keep the graph-derived fallback so the picker
        // remains usable for symbols already on the canvas.
        setSymbolsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, projectId]);

  const ranked = useMemo<SymbolEntry[]>(() => {
    // Empty input shows the prompt hint instead of dumping the first N
    // arbitrary entries: keyboard-only users avoid the surprise of an
    // already-highlighted random row, and the dropdown stays compact until
    // the user actually starts typing.
    if (query.trim() === '') {
      return [];
    }
    return rankSymbols(symbols, query, DEFAULT_PICKER_LIMIT);
  }, [symbols, query]);

  // Reset the keyboard highlight whenever the candidate set changes shape,
  // so a freshly-narrowed dropdown does not point at a stale row.
  useEffect(() => {
    setActiveIndex(0);
  }, [ranked.length, query]);

  const fqnDraftValid = isValidFqn(fqn);
  const fqnIsDuplicate = fqnDraftValid && existing.includes(fqn);

  const handlePickSymbol = useCallback(
    (symbol: SymbolEntry) => {
      onSubmit(symbol.fqn);
    },
    [onSubmit],
  );

  const handleFqnSubmit = useCallback(
    (evt: React.FormEvent<HTMLFormElement>) => {
      evt.preventDefault();
      if (!fqnDraftValid || fqnIsDuplicate) {
        return;
      }
      onSubmit(fqn);
    },
    [fqn, fqnDraftValid, fqnIsDuplicate, onSubmit],
  );

  const optionId = useCallback(
    (index: number): string => `entry-dialog-option-${String(index)}`,
    [],
  );

  const commitActive = useCallback((): boolean => {
    if (ranked.length === 0) {
      return false;
    }
    const target = ranked[Math.min(activeIndex, ranked.length - 1)];
    if (target === undefined) {
      return false;
    }
    if (existing.includes(target.fqn)) {
      return false;
    }
    handlePickSymbol(target);
    return true;
  }, [ranked, activeIndex, existing, handlePickSymbol]);

  const handleSearchKeyDown = useCallback(
    (evt: React.KeyboardEvent<HTMLInputElement>) => {
      if (ranked.length === 0) {
        return;
      }
      switch (evt.key) {
        case 'ArrowDown':
          evt.preventDefault();
          setActiveIndex((idx) => (idx + 1) % ranked.length);
          return;
        case 'ArrowUp':
          evt.preventDefault();
          setActiveIndex((idx) => (idx - 1 + ranked.length) % ranked.length);
          return;
        case 'Home':
          evt.preventDefault();
          setActiveIndex(0);
          return;
        case 'End':
          evt.preventDefault();
          setActiveIndex(ranked.length - 1);
          return;
        case 'Enter':
          evt.preventDefault();
          commitActive();
          return;
        case 'Tab':
          // Tab commits the highlight then falls through to natural focus
          // movement so the user lands on the next focusable control.
          if (commitActive()) {
            // commit closes the dialog via onSubmit; no need to preventDefault.
          }
          return;
        default:
          return;
      }
    },
    [ranked, commitActive],
  );

  // Keep the highlighted option scrolled into view on keyboard navigation.
  useEffect(() => {
    const list = listboxRef.current;
    if (list === null) {
      return;
    }
    const el = list.querySelector<HTMLElement>(
      `#${optionId(activeIndex).replace(/[#.]/g, '\\$&')}`,
    );
    if (el !== null && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, optionId]);

  return (
    <div
      className="entry-dialog__backdrop"
      role="presentation"
      onMouseDown={(evt) => {
        // Record whether the gesture starts on the backdrop itself. Anything
        // that started inside the dialog (input drag-selects, slow clicks)
        // sets this to `false` via the dialog's own onMouseDown below.
        downOnBackdropRef.current = evt.target === evt.currentTarget;
      }}
      onClick={(evt) => {
        const startedOnBackdrop = downOnBackdropRef.current;
        downOnBackdropRef.current = false;
        if (startedOnBackdrop && evt.target === evt.currentTarget) {
          onCancel();
        }
      }}
      data-testid="entry-dialog-backdrop"
    >
      <div
        className="entry-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="entry-dialog-title"
        data-testid="entry-dialog"
        onMouseDown={() => {
          // Any pointerdown that lands inside the dialog must NOT be classified
          // as a backdrop click — even when the eventual mouseup escapes the
          // dialog bounds (text drag-select releasing on the padded backdrop).
          downOnBackdropRef.current = false;
        }}
      >
        <header className="entry-dialog__head">
          <h4 id="entry-dialog-title" className="entry-dialog__title">
            Add entry point
          </h4>
          <button
            type="button"
            className="entry-dialog__close"
            onClick={onCancel}
            aria-label="Close dialog"
            data-testid="entry-dialog-close"
          >
            {'\u00d7'}
          </button>
        </header>

        <div className="entry-dialog__tabs" role="tablist" aria-label="Entry source">
          {(['pick', 'fqn'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={`entry-dialog__tab${mode === m ? ' entry-dialog__tab--active' : ''}`}
              onClick={() => {
                setMode(m);
              }}
              data-testid={`entry-dialog-tab-${m}`}
            >
              {m === 'pick' ? 'Pick from graph' : 'Paste FQN'}
            </button>
          ))}
        </div>

        {mode === 'pick' ? (
          <div className="entry-dialog__body" data-testid="entry-dialog-pick-body">
            <input
              ref={inputRef}
              type="text"
              className="entry-dialog__search"
              placeholder="Начните вводить имя функции или структуры…"
              value={query}
              onChange={(evt) => {
                setQuery(evt.target.value);
              }}
              onKeyDown={handleSearchKeyDown}
              role="combobox"
              aria-expanded={ranked.length > 0}
              aria-controls="entry-dialog-listbox"
              aria-autocomplete="list"
              aria-activedescendant={
                ranked.length > 0 ? optionId(activeIndex) : undefined
              }
              autoComplete="off"
              spellCheck={false}
              aria-label="Поиск точки входа"
              data-testid="entry-dialog-search"
            />
            <ul
              id="entry-dialog-listbox"
              ref={listboxRef}
              className="entry-dialog__list"
              role="listbox"
              aria-label="Кандидаты точек входа"
              data-testid="entry-dialog-list"
            >
              {ranked.length === 0 ? (
                <li
                  className="entry-dialog__hint"
                  data-testid="entry-dialog-no-match"
                  role="presentation"
                >
                  {query.trim() === ''
                    ? 'Начните вводить имя функции или структуры…'
                    : 'Ничего не найдено'}
                </li>
              ) : (
                ranked.map((symbol, idx) => {
                  const isExisting = existing.includes(symbol.fqn);
                  const isActive = idx === activeIndex;
                  const pkgLabel = shortPackageLabel(symbol.package);
                  const className = `entry-dialog__pick${
                    isActive ? ' entry-dialog__pick--active' : ''
                  }`;
                  return (
                    <li
                      key={symbol.fqn}
                      className="entry-dialog__list-item"
                      role="presentation"
                    >
                      <button
                        type="button"
                        id={optionId(idx)}
                        className={className}
                        role="option"
                        aria-selected={isActive}
                        // Use onMouseDown rather than onClick so the click
                        // commit happens before the input loses focus and
                        // before the backdrop click-handler can run — this
                        // is what keeps the surrounding popover open when
                        // a dropdown item is clicked.
                        onMouseDown={(evt) => {
                          evt.preventDefault();
                          if (isExisting) {
                            return;
                          }
                          handlePickSymbol(symbol);
                        }}
                        onMouseEnter={() => {
                          setActiveIndex(idx);
                        }}
                        disabled={isExisting}
                        data-testid={`entry-dialog-pick-${symbol.fqn}`}
                        title={symbol.fqn}
                      >
                        <span className="entry-dialog__pick-name">
                          {symbol.name}
                          {pkgLabel !== '' ? (
                            <span style={{ color: 'var(--color-fg-muted)' }}>
                              {' · '}{pkgLabel}
                            </span>
                          ) : null}
                        </span>
                        <span className="entry-dialog__pick-pkg">{symbol.package}</span>
                        {isExisting ? (
                          <span className="entry-dialog__pick-tag">added</span>
                        ) : null}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
            {!symbolsLoaded && symbols.length === 0 ? (
              <p className="entry-dialog__hint">Загрузка символов…</p>
            ) : null}
          </div>
        ) : (
          <form
            className="entry-dialog__body"
            onSubmit={handleFqnSubmit}
            data-testid="entry-dialog-fqn-body"
          >
            <label className="entry-dialog__label" htmlFor="entry-dialog-fqn-input">
              Fully-qualified name
            </label>
            <input
              ref={inputRef}
              id="entry-dialog-fqn-input"
              type="text"
              className="entry-dialog__input"
              placeholder="github.com/acme/api#Handler.ServeHTTP"
              value={fqn}
              onChange={(evt) => {
                setFqn(evt.target.value);
              }}
              aria-invalid={fqn !== '' && !fqnDraftValid}
              data-testid="entry-dialog-fqn-input"
            />
            <p className="entry-dialog__hint">
              Format: <code>package/path#Func</code> or <code>package/path#Type.Method</code>.
              {' '}{ALL_NODE_KINDS.length > 0 ? '' : ''}
            </p>
            {fqn !== '' && !fqnDraftValid ? (
              <p className="entry-dialog__error" data-testid="entry-dialog-syntax-error">
                Invalid FQN format.
              </p>
            ) : null}
            {fqnIsDuplicate ? (
              <p className="entry-dialog__error" data-testid="entry-dialog-duplicate-error">
                Already added.
              </p>
            ) : null}
            <button
              type="submit"
              className="entry-dialog__submit"
              disabled={!fqnDraftValid || fqnIsDuplicate}
              data-testid="entry-dialog-submit"
            >
              Add
            </button>
          </form>
        )}

        {serverError !== null && serverError.code === 'invalid_entry_point' ? (
          <p
            className="entry-dialog__error entry-dialog__error--server"
            data-testid="entry-dialog-server-error"
          >
            Server rejected entry point: {serverError.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
