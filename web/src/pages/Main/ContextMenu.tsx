/**
 * Right-click context menu rendered above the Cytoscape canvas
 * (design.md §4 Interaction table).
 *
 * The menu lives outside the Cytoscape stylesheet — Cytoscape only fires the
 * `cxttap` event with the rendered position; the rest is plain DOM inside a
 * portal-less absolutely-positioned `<ul>`. Keeping it in regular React lets
 * tests interact with menu items via Testing Library without reaching into
 * the Cytoscape internals.
 *
 * Items shown:
 *
 *   - Info               — focuses the right-rail Info panel on the node;
 *   - Add as entry       — passes the FQN to the entry-points panel;
 *   - Hide / Show subtree — toggles `useCollapse` for the node;
 *   - Copy path          — copies `<file>:<line>` to the clipboard.
 *
 * The "Add as entry" item disables itself for non-func/non-method nodes
 * because the backend cannot resolve them as entry points.
 */

import type { Core, EventObject, NodeSingular } from 'cytoscape';
import { useCallback, useEffect, useState, type JSX } from 'react';

import type { Node } from '../../api/types';
import { nodeToFqn } from './panels/fqn';
import './ContextMenu.css';

/** Position + payload describing the open menu. `null` means closed. */
interface MenuState {
  node: Node;
  /** Rendered (canvas-local) x in pixels. */
  x: number;
  /** Rendered y in pixels. */
  y: number;
  /** Whether the node is currently in the collapsed set. */
  isCollapsed: boolean;
}

export interface ContextMenuProps {
  /** Live Cytoscape instance — `null` while the canvas is mounting. */
  cy: Core | null;
  /** Set of currently collapsed node ids (from `useCollapse`). */
  collapsedIds: ReadonlySet<string>;
  /** Triggered when the user picks "Info" — typically `setSelectedNodeId`. */
  onShowInfo?: (nodeId: string) => void;
  /** Triggered when the user picks "Add as entry". */
  onAddEntry?: (fqn: string) => void;
  /** Triggered when the user picks "Hide subtree". */
  onCollapse?: (nodeId: string) => void;
  /** Triggered when the user picks "Show subtree" on a collapsed root. */
  onExpand?: (nodeId: string) => void;
  /** Triggered when the user picks "Copy path". */
  onCopyPath?: (text: string, success: boolean) => void;
}

export function ContextMenu({
  cy,
  collapsedIds,
  onShowInfo,
  onAddEntry,
  onCollapse,
  onExpand,
  onCopyPath,
}: ContextMenuProps): JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Wire `cxttap` (right-click) on Cytoscape nodes to open the menu, and
  // close it whenever the user taps the empty canvas or scrolls / zooms.
  //
  // Layout passes (cose / preset / etc.) can fire `pan` and `zoom` on every
  // tick, which would close the menu before the user can act. We listen for
  // user-driven events on the canvas DOM (`mousedown`, `wheel`) instead —
  // both signal a deliberate viewport change and never fire from layout.
  useEffect(() => {
    if (cy === null) {
      return undefined;
    }
    const handleNodeRightClick = (evt: EventObject): void => {
      const node = evt.target as NodeSingular;
      const data = node.data() as Node;
      const renderedPos = node.renderedPosition();
      // Suppress the browser's native context menu over the canvas — Cytoscape
      // already fires `cxttap`, and the default menu would compete with ours.
      const orig = evt.originalEvent as MouseEvent | undefined;
      if (orig !== undefined && typeof orig.preventDefault === 'function') {
        orig.preventDefault();
      }
      setMenu({
        node: data,
        x: renderedPos.x,
        y: renderedPos.y,
        isCollapsed: collapsedIds.has(data.id),
      });
    };
    const handleBackgroundTap = (evt: EventObject): void => {
      if (evt.target !== cy) {
        return;
      }
      setMenu(null);
    };

    cy.on('cxttap', 'node', handleNodeRightClick);
    cy.on('tap', handleBackgroundTap);

    const container: HTMLElement | null = cy.container();
    const handleUserViewport = (evt: Event): void => {
      // mousedown anywhere inside the menu is a click on a menu item — the
      // dedicated handlers will close the menu themselves.
      const target = evt.target as Node | null;
      if (target !== null && target instanceof Element) {
        if (target.closest('[data-testid="context-menu"]') !== null) {
          return;
        }
      }
      setMenu(null);
    };
    if (container !== null) {
      container.addEventListener('mousedown', handleUserViewport);
      container.addEventListener('wheel', handleUserViewport, { passive: true });
    }

    return () => {
      cy.off('cxttap', 'node', handleNodeRightClick);
      cy.off('tap', handleBackgroundTap);
      if (container !== null) {
        container.removeEventListener('mousedown', handleUserViewport);
        container.removeEventListener('wheel', handleUserViewport);
      }
    };
  }, [cy, collapsedIds]);

  // Esc dismisses the menu — global handler to catch keystrokes regardless
  // of which DOM element holds focus.
  useEffect(() => {
    if (menu === null) {
      return undefined;
    }
    function onKey(evt: KeyboardEvent): void {
      if (evt.key === 'Escape') {
        evt.preventDefault();
        setMenu(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const close = useCallback(() => {
    setMenu(null);
  }, []);

  const handleInfo = useCallback(() => {
    if (menu === null) {
      return;
    }
    onShowInfo?.(menu.node.id);
    close();
  }, [menu, onShowInfo, close]);

  const handleAddEntry = useCallback(() => {
    if (menu === null) {
      return;
    }
    const fqn = nodeToFqn(menu.node);
    if (fqn === null) {
      return;
    }
    onAddEntry?.(fqn);
    close();
  }, [menu, onAddEntry, close]);

  const handleCollapse = useCallback(() => {
    if (menu === null) {
      return;
    }
    if (menu.isCollapsed) {
      onExpand?.(menu.node.id);
    } else {
      onCollapse?.(menu.node.id);
    }
    close();
  }, [menu, onCollapse, onExpand, close]);

  const handleCopyPath = useCallback(() => {
    if (menu === null) {
      return;
    }
    if (menu.node.file === '') {
      onCopyPath?.('', false);
      close();
      return;
    }
    const text = `${menu.node.file}:${String(menu.node.line)}`;
    void writeClipboard(text).then((ok) => {
      onCopyPath?.(text, ok);
      close();
    });
  }, [menu, onCopyPath, close]);

  if (menu === null) {
    return null;
  }

  const fqn = nodeToFqn(menu.node);
  const collapseLabel = menu.isCollapsed ? 'Show subtree' : 'Hide subtree';
  const collapseTestId = menu.isCollapsed ? 'context-menu-expand' : 'context-menu-collapse';

  return (
    <ul
      className="context-menu"
      role="menu"
      aria-label="Node actions"
      data-testid="context-menu"
      style={{
        transform: `translate(${String(menu.x)}px, ${String(menu.y)}px)`,
      }}
    >
      <li role="none">
        <button
          type="button"
          role="menuitem"
          className="context-menu__item"
          onClick={handleInfo}
          data-testid="context-menu-info"
        >
          Info
        </button>
      </li>
      <li role="none">
        <button
          type="button"
          role="menuitem"
          className="context-menu__item"
          onClick={handleAddEntry}
          disabled={fqn === null || menu.node.is_entry}
          data-testid="context-menu-add-entry"
        >
          Add as entry
        </button>
      </li>
      <li role="none">
        <button
          type="button"
          role="menuitem"
          className="context-menu__item"
          onClick={handleCollapse}
          data-testid={collapseTestId}
        >
          {collapseLabel}
        </button>
      </li>
      <li role="none">
        <button
          type="button"
          role="menuitem"
          className="context-menu__item"
          onClick={handleCopyPath}
          disabled={menu.node.file === ''}
          data-testid="context-menu-copy-path"
        >
          Copy path
        </button>
      </li>
    </ul>
  );
}

/** Same shim as `InfoPanel` — kept private here to avoid cross-module coupling. */
async function writeClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through
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
