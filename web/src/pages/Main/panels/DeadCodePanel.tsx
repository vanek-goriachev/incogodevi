/**
 * Right-rail "Dead code" panel (design.md §3.3, §7; FR-20, FR-23, FR-24).
 *
 * Loads the dead-code report once via `apiClient.getDeadCode(id, 'json')`
 * and re-loads it whenever `refreshKey` increases (typically after a
 * re-analyze finishes). Renders one row per entry in the format
 * `kind pkg.Name — file:line` (FR-20) and exposes two download buttons
 * that hit the same endpoint with `?format={txt|json}&download=1`.
 *
 * Clicking a row re-centres the Cytoscape viewport on the matching node so
 * the user can locate it on the canvas without a second tool. Selection of
 * the node is delegated to the parent through `onSelectNode` so the right-
 * rail Info panel stays in sync.
 */

import { useCallback, useEffect, useMemo, useState, type JSX, type KeyboardEvent } from 'react';
import type { Core } from 'cytoscape';

import type { ApiClient } from '../../../api/client';
import { ApiError } from '../../../api/client';
import type { DeadCodeEntry, DeadCodeReport, Graph } from '../../../api/types';
import './DeadCodePanel.css';

/** Friendly per-kind label used in front of the FQN. */
const KIND_LABELS: Readonly<Record<DeadCodeEntry['kind'], string>> = {
  package: 'pkg',
  struct: 'struct',
  interface: 'iface',
  func: 'func',
  method: 'method',
  field: 'field',
  var: 'var',
  const: 'const',
};

/** Status of the underlying report fetch. */
type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; report: DeadCodeReport }
  | { kind: 'error'; message: string; retryable: boolean };

export interface DeadCodePanelProps {
  apiClient: ApiClient;
  /** Current project id. The panel renders an empty placeholder when undefined. */
  projectId: string | undefined;
  /** Project display name; used to compose the download filename. */
  projectName: string;
  /**
   * Bumped by the parent every time the underlying graph is re-analysed so
   * the panel knows to invalidate its cached report. The value itself is
   * opaque — only changes matter.
   */
  refreshKey: number;
  /**
   * Live Cytoscape core. Used to centre the viewport when a row is clicked
   * and to flag whether `onSelectNode` is wired up. May be `null` during
   * the brief moment between Main mount and Cytoscape init.
   */
  cy: Core | null;
  /**
   * Latest graph snapshot — used to translate a `DeadCodeEntry` (which
   * carries the human-readable FQN) back into the hashed `Node.id` that
   * Cytoscape stores. The dead-code report and the graph share the
   * (package, kind, file, line) tuple, which is unique per declaration.
   */
  graph: Graph | null;
  /** Forwarded to MainView so the right-rail Info panel stays in sync. */
  onSelectNode?: (id: string) => void;
}

export function DeadCodePanel({
  apiClient,
  projectId,
  projectName,
  refreshKey,
  cy,
  graph,
  onSelectNode,
}: DeadCodePanelProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  // `attempt` is bumped by the user pressing "Retry" so the fetch effect re-runs
  // even when the underlying inputs (id, refreshKey) have not changed.
  const [attempt, setAttempt] = useState<number>(0);

  useEffect(() => {
    if (projectId === undefined || projectId === '') {
      setState({ kind: 'idle' });
      return undefined;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    apiClient
      .getDeadCode(projectId, 'json')
      .then((report) => {
        if (cancelled) {
          return;
        }
        setState({ kind: 'ready', report });
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setState(buildErrorState(err));
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, projectId, refreshKey, attempt]);

  const triggerDownload = useCallback(
    (format: 'txt' | 'json') => {
      if (projectId === undefined || projectId === '') {
        return;
      }
      void downloadReport(apiClient, projectId, projectName, format);
    },
    [apiClient, projectId, projectName],
  );

  // Build a (package|file|line) -> node.id lookup so a row click can
  // translate the human-readable FQN back to Cytoscape's hashed identifier.
  const nodeIdByEntry = useMemo<Map<string, string>>(() => {
    const out = new Map<string, string>();
    if (graph === null) {
      return out;
    }
    for (const node of graph.nodes) {
      out.set(entryKey(node.package, node.file, node.line), node.id);
    }
    return out;
  }, [graph]);

  const handleRowActivate = useCallback(
    (entry: DeadCodeEntry) => {
      if (cy === null) {
        return;
      }
      const nodeId = nodeIdByEntry.get(entryKey(entry.package, entry.file, entry.line));
      if (nodeId === undefined) {
        return;
      }
      const target = cy.$id(nodeId);
      if (target.empty()) {
        return;
      }
      cy.center(target);
      if (onSelectNode !== undefined) {
        onSelectNode(nodeId);
      }
    },
    [cy, nodeIdByEntry, onSelectNode],
  );

  const headerCount = useMemo<number | null>(() => {
    if (state.kind !== 'ready') {
      return null;
    }
    return state.report.entries_count;
  }, [state]);

  return (
    <section
      className="dead-panel"
      aria-label="Dead-code report"
      data-testid="dead-panel"
    >
      <header className="dead-panel__head">
        <h3 className="dead-panel__title">
          Dead code
          {headerCount !== null ? (
            <span className="dead-panel__count" data-testid="dead-panel-count">
              {' '}
              ({String(headerCount)})
            </span>
          ) : null}
        </h3>
        <div className="dead-panel__actions">
          <button
            type="button"
            className="dead-panel__action"
            onClick={() => { triggerDownload('txt'); }}
            disabled={state.kind !== 'ready' || projectId === undefined}
            data-testid="dead-panel-export-txt"
            aria-label="Export dead-code report as TXT"
          >
            TXT
          </button>
          <button
            type="button"
            className="dead-panel__action"
            onClick={() => { triggerDownload('json'); }}
            disabled={state.kind !== 'ready' || projectId === undefined}
            data-testid="dead-panel-export-json"
            aria-label="Export dead-code report as JSON"
          >
            JSON
          </button>
        </div>
      </header>

      {state.kind === 'idle' ? (
        <p className="dead-panel__hint" data-testid="dead-panel-idle">
          Awaiting the first analysis.
        </p>
      ) : null}

      {state.kind === 'loading' ? (
        <ul className="dead-panel__skeleton" data-testid="dead-panel-loading" aria-hidden>
          <li />
          <li />
          <li />
        </ul>
      ) : null}

      {state.kind === 'error' ? (
        <div className="dead-panel__error" data-testid="dead-panel-error" role="alert">
          <p className="dead-panel__error-text">Could not load dead-code report.</p>
          <p className="dead-panel__error-detail">{state.message}</p>
          {state.retryable ? (
            <button
              type="button"
              className="dead-panel__retry"
              onClick={() => { setAttempt((n) => n + 1); }}
              data-testid="dead-panel-retry"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {state.kind === 'ready' && state.report.entries_count === 0 ? (
        <p className="dead-panel__empty" data-testid="dead-panel-empty">
          No dead code detected 🎉
        </p>
      ) : null}

      {state.kind === 'ready' && state.report.entries_count > 0 ? (
        <ul className="dead-panel__list" data-testid="dead-panel-list">
          {state.report.entries.map((entry) => (
            <DeadCodeRow
              key={entry.fqn}
              entry={entry}
              onActivate={handleRowActivate}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

interface DeadCodeRowProps {
  entry: DeadCodeEntry;
  onActivate: (entry: DeadCodeEntry) => void;
}

/**
 * Single row in the dead-code list. Acts as a button (Enter / Space activate)
 * but stays semantically an `<li>` so the surrounding list announces a count
 * to screen readers.
 */
function DeadCodeRow({ entry, onActivate }: DeadCodeRowProps): JSX.Element {
  const handleKeyDown = useCallback(
    (evt: KeyboardEvent<HTMLLIElement>) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        onActivate(entry);
      }
    },
    [entry, onActivate],
  );

  const fileLine = entry.file !== '' ? `${entry.file}:${String(entry.line)}` : '';
  return (
    <li
      className="dead-panel__row"
      role="button"
      tabIndex={0}
      onClick={() => { onActivate(entry); }}
      onKeyDown={handleKeyDown}
      data-testid={`dead-panel-row-${entry.fqn}`}
      title={`${KIND_LABELS[entry.kind]} ${entry.fqn} — ${fileLine}`}
    >
      <span className="dead-panel__kind">{KIND_LABELS[entry.kind]}</span>
      <span className="dead-panel__fqn">{entry.fqn}</span>
      {fileLine !== '' ? (
        <span className="dead-panel__file"> — {fileLine}</span>
      ) : null}
    </li>
  );
}

/**
 * Compose the lookup key shared by `Node` and `DeadCodeEntry`. The triple
 * (package, file, line) is unique per source declaration in Go — even
 * generics share the receiver position — so it lets the panel resolve a
 * row to a Cytoscape node id without depending on the hashed FQN.
 */
function entryKey(pkg: string, file: string, line: number): string {
  return `${pkg}\u0000${file}\u0000${String(line)}`;
}

function buildErrorState(err: unknown): LoadState {
  if (err instanceof ApiError) {
    return {
      kind: 'error',
      message: err.message,
      retryable: err.code !== 'no_graph_yet',
    };
  }
  if (err instanceof Error) {
    return { kind: 'error', message: err.message, retryable: true };
  }
  return { kind: 'error', message: 'Unknown failure.', retryable: true };
}

/**
 * Stream the report through the browser download path. Uses `fetch` +
 * `Blob` rather than a same-origin `<a download href>` so we can observe
 * the response status and surface a toast-friendly error if the server
 * rejects the request — relying on a synthetic anchor swallows non-2xx.
 */
async function downloadReport(
  apiClient: ApiClient,
  projectId: string,
  projectName: string,
  format: 'txt' | 'json',
): Promise<void> {
  const data: string =
    format === 'txt'
      ? await apiClient.getDeadCode(projectId, 'txt')
      : JSON.stringify(await apiClient.getDeadCode(projectId, 'json'), null, 2);

  const mime =
    format === 'txt' ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8';
  const blob = new Blob([data], { type: mime });
  const objectUrl = URL.createObjectURL(blob);
  const filename = downloadFilename(projectName, format);

  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    document.body.removeChild(link);
    // The browser keeps the blob alive while the download is in flight; an
    // immediate revoke on Safari can race the click handler. A 60 s grace
    // window matches what the major file-saver libraries do.
    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 60_000);
  }
}

/**
 * Compose `<sanitized-name>-dead-code-<timestamp>.<ext>`. The server uses a
 * shorter form when `?download=1` is requested; the client adds the
 * timestamp because we generate the file locally and want each download to
 * be uniquely named in the user's downloads folder (FR-23/24 acceptance).
 */
function downloadFilename(projectName: string, format: 'txt' | 'json'): string {
  const safe = sanitizeFilename(projectName) || 'project';
  const stamp = formatTimestamp(new Date());
  return `${safe}-dead-code-${stamp}.${format}`;
}

function sanitizeFilename(name: string): string {
  let out = '';
  for (const ch of name) {
    if (/[a-zA-Z0-9._-]/.test(ch)) {
      out += ch;
    } else {
      out += '_';
    }
  }
  return out.replace(/^[._-]+|[._-]+$/g, '');
}

function formatTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${String(d.getFullYear())}` +
    `${pad(d.getMonth() + 1)}` +
    `${pad(d.getDate())}` +
    `-${pad(d.getHours())}` +
    `${pad(d.getMinutes())}` +
    `${pad(d.getSeconds())}`
  );
}
