/**
 * Right-rail "Info" panel (design.md §3.3, FR-17, FR-25).
 *
 * Renders the metadata of the currently selected node and exposes two
 * actions:
 *
 *   - "Add as entry point" — only shown for funcs/methods because the
 *     backend's entry-point resolver only understands those (see
 *     `server/internal/entry`).
 *   - "Copy path" — copies `<file>:<line>` to the clipboard so the user can
 *     paste it into their editor's go-to-line prompt. Falls back to a
 *     toast-only feedback when the Clipboard API is unavailable (older
 *     Safari, http origin, jsdom).
 *
 * The panel is purely presentational — every piece of state flows in via
 * props. That keeps it trivial to mount in tests and lets `MainView` own
 * both the `selectedNode` and the entry-points list.
 */

import { useCallback, type JSX } from 'react';

import type { Graph, Node } from '../../../api/types';
import { nodeToFqn } from './fqn';
import './InfoPanel.css';

/**
 * Friendly per-kind labels used in the panel header. Kept separate from the
 * filters-panel labels because they are nouns here (singular) instead of
 * column headings.
 */
const KIND_LABELS: Readonly<Record<Node['kind'], string>> = {
  package: 'package',
  struct: 'struct',
  interface: 'interface',
  func: 'function',
  method: 'method',
  field: 'field',
  var: 'var',
  const: 'const',
};

export interface InfoPanelProps {
  /** Currently selected node, or `null` for the empty state. */
  selectedNode: Node | null;
  /**
   * Live graph snapshot, used by `nodeToFqn` to recover the receiver for
   * method nodes (the server's `Node.name` is the bare method name). Optional
   * so trivial render paths (non-method selections) keep working when the
   * caller does not have a graph handy.
   */
  graph?: Graph | null;
  /**
   * Invoked when the user clicks "Add as entry point". Receives the FQN
   * derived from the node. Parent decides whether to push it into the
   * entry-points list and trigger a re-analyze.
   */
  onAddEntry?: (fqn: string) => void;
  /**
   * Invoked after a copy attempt. Reports whether the clipboard write
   * actually succeeded so the parent can show a contextual toast.
   */
  onCopy?: (text: string, success: boolean) => void;
}

export function InfoPanel({ selectedNode, graph, onAddEntry, onCopy }: InfoPanelProps): JSX.Element {
  const fqn = selectedNode !== null ? nodeToFqn(selectedNode, graph) : null;

  const handleAddEntry = useCallback(() => {
    if (selectedNode === null || fqn === null || onAddEntry === undefined) {
      return;
    }
    onAddEntry(fqn);
  }, [selectedNode, fqn, onAddEntry]);

  const handleCopyPath = useCallback(() => {
    if (selectedNode === null) {
      return;
    }
    const text = formatFileLine(selectedNode);
    if (text === '') {
      onCopy?.('', false);
      return;
    }
    void writeClipboard(text).then((ok) => {
      onCopy?.(text, ok);
    });
  }, [selectedNode, onCopy]);

  if (selectedNode === null) {
    return (
      <section
        className="info-panel"
        aria-label="Node information"
        data-testid="info-panel"
      >
        <header className="info-panel__head">
          <h3 className="info-panel__title">Info</h3>
        </header>
        <p className="info-panel__empty" data-testid="info-panel-empty">
          Select a node to see details.
        </p>
      </section>
    );
  }

  const kindLabel = KIND_LABELS[selectedNode.kind];
  const exportedLabel = selectedNode.exported ? 'exported' : 'unexported';
  const reachableLabel = selectedNode.reachable ? 'reachable' : 'dead';
  const fileLine = formatFileLine(selectedNode);

  return (
    <section
      className="info-panel"
      aria-label="Node information"
      data-testid="info-panel"
    >
      <header className="info-panel__head">
        <h3 className="info-panel__title">Info</h3>
        <span
          className={`info-panel__badge info-panel__badge--${reachableLabel}`}
          data-testid="info-panel-reachable"
        >
          {reachableLabel}
        </span>
      </header>

      <dl className="info-panel__meta" data-testid="info-panel-meta">
        <div className="info-panel__row">
          <dt>kind</dt>
          <dd data-testid="info-panel-kind">{kindLabel}</dd>
        </div>
        <div className="info-panel__row">
          <dt>name</dt>
          <dd className="info-panel__mono" data-testid="info-panel-name">
            {selectedNode.name}
          </dd>
        </div>
        <div className="info-panel__row">
          <dt>package</dt>
          <dd className="info-panel__mono" data-testid="info-panel-package">
            {selectedNode.package !== '' ? selectedNode.package : '\u2014'}
          </dd>
        </div>
        <div className="info-panel__row">
          <dt>file</dt>
          <dd className="info-panel__mono" data-testid="info-panel-file">
            {fileLine !== '' ? fileLine : '\u2014'}
          </dd>
        </div>
        <div className="info-panel__row">
          <dt>visibility</dt>
          <dd data-testid="info-panel-exported">{exportedLabel}</dd>
        </div>
        {selectedNode.is_entry ? (
          <div className="info-panel__row">
            <dt>flag</dt>
            <dd data-testid="info-panel-entry">entry point</dd>
          </div>
        ) : null}
        {selectedNode.doc !== undefined && selectedNode.doc !== '' ? (
          <div className="info-panel__row info-panel__row--doc">
            <dt>doc</dt>
            <dd className="info-panel__doc" data-testid="info-panel-doc">
              {selectedNode.doc}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="info-panel__actions">
        <button
          type="button"
          className="info-panel__action info-panel__action--primary"
          onClick={handleAddEntry}
          disabled={fqn === null || selectedNode.is_entry}
          data-testid="info-panel-add-entry"
          aria-label={fqn !== null ? `Add ${fqn} as entry point` : 'Add as entry point'}
        >
          + Add as entry point
        </button>
        <button
          type="button"
          className="info-panel__action"
          onClick={handleCopyPath}
          disabled={fileLine === ''}
          data-testid="info-panel-copy-path"
          aria-label="Copy file and line"
        >
          Copy path
        </button>
      </div>

      {fqn === null ? (
        <p className="info-panel__hint" data-testid="info-panel-non-entry-hint">
          Only functions and methods can be entry points.
        </p>
      ) : null}
    </section>
  );
}

/** Compose `file:line`, returning `''` when the file slot is empty. */
function formatFileLine(node: Node): string {
  if (node.file === '') {
    return '';
  }
  return `${node.file}:${String(node.line)}`;
}

/**
 * Best-effort clipboard write that resolves to `false` on failure instead of
 * rejecting. The DOM `navigator.clipboard` API requires a secure context;
 * older browsers and jsdom do not expose it, so the wrapper falls back to a
 * hidden `<textarea>` + `document.execCommand('copy')` before giving up.
 */
async function writeClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the textarea fallback below
    }
  }
  if (typeof document === 'undefined') {
    return false;
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = typeof document.execCommand === 'function'
      ? document.execCommand('copy')
      : false;
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
