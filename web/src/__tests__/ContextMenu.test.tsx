/**
 * Component tests for the right-click context menu.
 *
 * The menu wires into Cytoscape via the `cxttap` event. We spin up a real
 * headless Cytoscape instance (the same null-renderer trick used by the
 * GraphCanvas tests) and emit the event programmatically — that exercises
 * the full event-binding code path without ever touching a 2D context.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import cytoscape, { type Core } from 'cytoscape';

import { ContextMenu } from '../pages/Main/ContextMenu';

function buildCy(): Core {
  return cytoscape({
    elements: [
      {
        group: 'nodes',
        data: {
          id: 'fn:Handler',
          name: 'Handler',
          kind: 'func',
          package: 'github.com/acme/api',
          file: 'api/handler.go',
          line: 12,
          exported: true,
          reachable: true,
          is_entry: false,
        },
      },
      {
        group: 'nodes',
        data: {
          id: 'st:Server',
          name: 'Server',
          kind: 'struct',
          package: 'github.com/acme/api',
          file: 'api/server.go',
          line: 3,
          exported: true,
          reachable: true,
          is_entry: false,
        },
      },
      {
        group: 'nodes',
        data: {
          id: 'fn:Entry',
          name: 'Entry',
          kind: 'func',
          package: 'cmd/app',
          file: 'cmd/app/main.go',
          line: 1,
          exported: false,
          reachable: true,
          is_entry: true,
        },
      },
    ],
    headless: true,
    styleEnabled: false,
  });
}

function emitRightClick(cy: Core, nodeId: string): void {
  // Cytoscape's headless mode does not synthesise rendered positions for
  // events, so we trigger the event directly on the node — the ContextMenu
  // listener does not depend on the actual screen coordinates being meaningful
  // (jsdom does not lay anything out anyway).
  act(() => {
    cy.$id(nodeId).emit('cxttap');
  });
}

describe('<ContextMenu />', () => {
  let cy: Core;
  let originalClipboard: PropertyDescriptor | undefined;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cy = buildCy();
    writeText = vi.fn(async () => {});
    originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    cy.destroy();
    if (originalClipboard !== undefined) {
      Object.defineProperty(window.navigator, 'clipboard', originalClipboard);
    } else {
      delete (window.navigator as { clipboard?: unknown }).clipboard;
    }
    vi.restoreAllMocks();
  });

  it('does not render anything until a node is right-clicked', () => {
    render(<ContextMenu cy={cy} collapsedIds={new Set()} />);
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('opens the menu on a node cxttap event', () => {
    render(<ContextMenu cy={cy} collapsedIds={new Set()} />);
    emitRightClick(cy, 'fn:Handler');
    expect(screen.getByTestId('context-menu')).toBeInTheDocument();
    expect(screen.getByTestId('context-menu-info')).toBeInTheDocument();
    expect(screen.getByTestId('context-menu-add-entry')).toBeInTheDocument();
    expect(screen.getByTestId('context-menu-collapse')).toBeInTheDocument();
    expect(screen.getByTestId('context-menu-copy-path')).toBeInTheDocument();
  });

  it('invokes onShowInfo and closes the menu on the Info item', async () => {
    const onShowInfo = vi.fn();
    render(
      <ContextMenu cy={cy} collapsedIds={new Set()} onShowInfo={onShowInfo} />,
    );
    emitRightClick(cy, 'fn:Handler');
    await userEvent.click(screen.getByTestId('context-menu-info'));
    expect(onShowInfo).toHaveBeenCalledWith('fn:Handler');
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('invokes onAddEntry with a derived FQN and closes the menu', async () => {
    const onAddEntry = vi.fn();
    render(
      <ContextMenu cy={cy} collapsedIds={new Set()} onAddEntry={onAddEntry} />,
    );
    emitRightClick(cy, 'fn:Handler');
    await userEvent.click(screen.getByTestId('context-menu-add-entry'));
    expect(onAddEntry).toHaveBeenCalledWith('github.com/acme/api#Handler');
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('disables Add as entry for non-callable kinds', () => {
    render(<ContextMenu cy={cy} collapsedIds={new Set()} />);
    emitRightClick(cy, 'st:Server');
    const btn = screen.getByTestId('context-menu-add-entry') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('disables Add as entry when the node is already an entry point', () => {
    render(<ContextMenu cy={cy} collapsedIds={new Set()} />);
    emitRightClick(cy, 'fn:Entry');
    const btn = screen.getByTestId('context-menu-add-entry') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('calls onCollapse with the node id when the subtree item fires', async () => {
    const onCollapse = vi.fn();
    render(
      <ContextMenu cy={cy} collapsedIds={new Set()} onCollapse={onCollapse} />,
    );
    emitRightClick(cy, 'fn:Handler');
    await userEvent.click(screen.getByTestId('context-menu-collapse'));
    expect(onCollapse).toHaveBeenCalledWith('fn:Handler');
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('shows Show subtree (and calls onExpand) for an already-collapsed node', async () => {
    const onExpand = vi.fn();
    render(
      <ContextMenu
        cy={cy}
        collapsedIds={new Set(['fn:Handler'])}
        onExpand={onExpand}
      />,
    );
    emitRightClick(cy, 'fn:Handler');
    expect(screen.queryByTestId('context-menu-collapse')).toBeNull();
    await userEvent.click(screen.getByTestId('context-menu-expand'));
    expect(onExpand).toHaveBeenCalledWith('fn:Handler');
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('copies file:line to the clipboard via the Copy path item', async () => {
    const onCopyPath = vi.fn();
    render(
      <ContextMenu cy={cy} collapsedIds={new Set()} onCopyPath={onCopyPath} />,
    );
    emitRightClick(cy, 'fn:Handler');
    await userEvent.click(screen.getByTestId('context-menu-copy-path'));
    // The clipboard write is awaited inside the handler — flushing
    // microtasks via a tiny timeout is enough to let the .then callback run.
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalledWith('api/handler.go:12');
    expect(onCopyPath).toHaveBeenCalledWith('api/handler.go:12', true);
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('closes the menu on Escape', () => {
    render(<ContextMenu cy={cy} collapsedIds={new Set()} />);
    emitRightClick(cy, 'fn:Handler');
    expect(screen.getByTestId('context-menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('closes the menu when the canvas background is tapped', () => {
    render(<ContextMenu cy={cy} collapsedIds={new Set()} />);
    emitRightClick(cy, 'fn:Handler');
    expect(screen.getByTestId('context-menu')).toBeInTheDocument();
    act(() => {
      cy.emit('tap');
    });
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('closes the menu when the user mouse-downs on the canvas container', () => {
    // Mount a real container into jsdom so cy.container() returns it. The
    // menu listens to `mousedown` on the container to detect user-driven
    // viewport changes; firing `mousedown` outside the menu element should
    // close the menu without closing it for in-menu clicks.
    const host = document.createElement('div');
    document.body.appendChild(host);
    cy.destroy();
    cy = cytoscape({
      elements: [
        { group: 'nodes', data: { id: 'fn:Handler', name: 'Handler', kind: 'func', package: 'p', file: 'f.go', line: 1, exported: true, reachable: true, is_entry: false } },
      ],
      headless: true,
      styleEnabled: false,
      container: host,
    });
    render(<ContextMenu cy={cy} collapsedIds={new Set()} />);
    emitRightClick(cy, 'fn:Handler');
    expect(screen.getByTestId('context-menu')).toBeInTheDocument();
    act(() => {
      host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(screen.queryByTestId('context-menu')).toBeNull();
    document.body.removeChild(host);
  });

  it('renders nothing while cy is null', () => {
    const { container } = render(
      <ContextMenu cy={null} collapsedIds={new Set()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
