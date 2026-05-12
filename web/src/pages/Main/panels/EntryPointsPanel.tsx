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

import { ALL_NODE_KINDS, type EntryPointSpec, type Graph, type Node } from '../../../api/types';
import { isValidFqn, nodeToFqn } from './fqn';
import './EntryPointsPanel.css';

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
}

/** Tabs inside the dialog: pick from the graph or paste a raw FQN. */
type DialogMode = 'pick' | 'fqn';

function AddEntryDialog({
  graph,
  existing,
  onSubmit,
  onCancel,
  serverError,
}: AddEntryDialogProps): JSX.Element {
  const [mode, setMode] = useState<DialogMode>('pick');
  const [query, setQuery] = useState<string>('');
  const [fqn, setFqn] = useState<string>('');
  const inputRef = useRef<HTMLInputElement | null>(null);

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

  const candidates = useMemo<Node[]>(() => {
    if (graph === null) {
      return [];
    }
    return graph.nodes.filter(
      (n) =>
        (n.kind === 'func' || n.kind === 'method') &&
        n.package !== '' &&
        n.name !== '',
    );
  }, [graph]);

  const filtered = useMemo<Node[]>(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') {
      return candidates.slice(0, 50);
    }
    const out: Node[] = [];
    for (const node of candidates) {
      if (out.length >= 50) {
        break;
      }
      const haystack = `${node.package}.${node.name}`.toLowerCase();
      if (haystack.includes(needle)) {
        out.push(node);
      }
    }
    return out;
  }, [candidates, query]);

  const fqnDraftValid = isValidFqn(fqn);
  const fqnIsDuplicate = fqnDraftValid && existing.includes(fqn);

  const handlePickSubmit = useCallback(
    (node: Node) => {
      const candidate = nodeToFqn(node, graph);
      if (candidate === null) {
        return;
      }
      onSubmit(candidate);
    },
    [graph, onSubmit],
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

  return (
    <div
      className="entry-dialog__backdrop"
      role="presentation"
      onClick={(evt) => {
        if (evt.target === evt.currentTarget) {
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
              type="search"
              className="entry-dialog__search"
              placeholder="Search functions / methods"
              value={query}
              onChange={(evt) => {
                setQuery(evt.target.value);
              }}
              aria-label="Search entry candidates"
              data-testid="entry-dialog-search"
            />
            <ul className="entry-dialog__list" data-testid="entry-dialog-list">
              {filtered.length === 0 ? (
                <li className="entry-dialog__hint">No matching nodes.</li>
              ) : (
                filtered.map((node) => {
                  const candidate = nodeToFqn(node, graph);
                  if (candidate === null) {
                    return null;
                  }
                  const isExisting = existing.includes(candidate);
                  return (
                    <li key={node.id} className="entry-dialog__list-item">
                      <button
                        type="button"
                        className="entry-dialog__pick"
                        onClick={() => {
                          handlePickSubmit(node);
                        }}
                        disabled={isExisting}
                        data-testid={`entry-dialog-pick-${candidate}`}
                        title={candidate}
                      >
                        <span className="entry-dialog__pick-name">{node.name}</span>
                        <span className="entry-dialog__pick-pkg">{node.package}</span>
                        {isExisting ? (
                          <span className="entry-dialog__pick-tag">added</span>
                        ) : null}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
            {graph === null ? (
              <p className="entry-dialog__hint">Graph not loaded yet.</p>
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
