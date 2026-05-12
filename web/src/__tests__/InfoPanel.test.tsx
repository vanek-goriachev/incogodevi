/**
 * Component tests for the right-rail Info panel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Edge, Graph, Node } from '../api/types';
import { InfoPanel } from '../pages/Main/panels/InfoPanel';

function makeNode(overrides: Partial<Node> = {}): Node {
  // The server emits `Node.name = methodName` (no receiver). InfoPanel must
  // recover the receiver via the graph's contains-edge — see fqn.ts.
  return {
    id: 'method-id',
    name: 'ServeHTTP',
    kind: 'method',
    package: 'github.com/acme/api',
    file: 'api/handler.go',
    line: 12,
    exported: true,
    reachable: true,
    is_entry: false,
    ...overrides,
  };
}

function makeGraphWithReceiver(method: Node, receiverName = 'Handler'): Graph {
  const parent: Node = {
    id: 'struct-id',
    name: receiverName,
    kind: 'struct',
    package: method.package,
    file: method.file,
    line: 1,
    exported: true,
    reachable: true,
    is_entry: false,
  };
  const edge: Edge = {
    id: 'contains-edge',
    source: parent.id,
    target: method.id,
    kind: 'contains',
    weight: 1,
  };
  return {
    project_id: 'test',
    generated_at: '2025-01-01T00:00:00Z',
    aggregation: 'none',
    stats: { node_count: 2, edge_count: 1, by_kind: {}, dead_count: 0 },
    nodes: [parent, method],
    edges: [edge],
    warnings: [],
  };
}

describe('<InfoPanel />', () => {
  let writeText: ReturnType<typeof vi.fn>;
  let originalClipboard: PropertyDescriptor | undefined;

  beforeEach(() => {
    writeText = vi.fn(async () => {});
    originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    if (originalClipboard !== undefined) {
      Object.defineProperty(window.navigator, 'clipboard', originalClipboard);
    } else {
      delete (window.navigator as { clipboard?: unknown }).clipboard;
    }
    vi.restoreAllMocks();
  });

  it('shows the empty hint when no node is selected', () => {
    render(<InfoPanel selectedNode={null} />);
    expect(screen.getByTestId('info-panel-empty')).toBeInTheDocument();
  });

  it('renders metadata for the selected node', () => {
    render(<InfoPanel selectedNode={makeNode()} />);
    expect(screen.getByTestId('info-panel-kind')).toHaveTextContent('method');
    // `Node.name` is the bare method name on the wire; the receiver is
    // recovered only when the parent passes the graph (see add-entry test).
    expect(screen.getByTestId('info-panel-name')).toHaveTextContent('ServeHTTP');
    expect(screen.getByTestId('info-panel-package')).toHaveTextContent(
      'github.com/acme/api',
    );
    expect(screen.getByTestId('info-panel-file')).toHaveTextContent(
      'api/handler.go:12',
    );
    expect(screen.getByTestId('info-panel-reachable')).toHaveTextContent('reachable');
    expect(screen.getByTestId('info-panel-exported')).toHaveTextContent('exported');
  });

  it('marks an unreachable node as dead', () => {
    render(<InfoPanel selectedNode={makeNode({ reachable: false })} />);
    expect(screen.getByTestId('info-panel-reachable')).toHaveTextContent('dead');
  });

  it('shows the doc string when present', () => {
    render(
      <InfoPanel
        selectedNode={makeNode({ doc: 'Handler implements http.Handler' })}
      />,
    );
    expect(screen.getByTestId('info-panel-doc')).toHaveTextContent(
      'Handler implements http.Handler',
    );
  });

  it('invokes onAddEntry with the FQN when the button is clicked', async () => {
    const onAddEntry = vi.fn();
    const method = makeNode();
    render(
      <InfoPanel
        selectedNode={method}
        graph={makeGraphWithReceiver(method)}
        onAddEntry={onAddEntry}
      />,
    );
    await userEvent.click(screen.getByTestId('info-panel-add-entry'));
    expect(onAddEntry).toHaveBeenCalledWith('github.com/acme/api#Handler.ServeHTTP');
  });

  it('disables the entry button for non-callable kinds', () => {
    render(<InfoPanel selectedNode={makeNode({ kind: 'struct' })} />);
    const btn = screen.getByTestId('info-panel-add-entry') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByTestId('info-panel-non-entry-hint')).toBeInTheDocument();
  });

  it('disables the entry button when the node is already an entry', () => {
    render(<InfoPanel selectedNode={makeNode({ is_entry: true })} />);
    const btn = screen.getByTestId('info-panel-add-entry') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('copies file:line to the clipboard via the Copy path button', async () => {
    const onCopy = vi.fn();
    render(<InfoPanel selectedNode={makeNode()} onCopy={onCopy} />);
    await userEvent.click(screen.getByTestId('info-panel-copy-path'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('api/handler.go:12');
    });
    await waitFor(() => {
      expect(onCopy).toHaveBeenCalledWith('api/handler.go:12', true);
    });
  });

  it('disables the copy button when the file is empty', () => {
    render(<InfoPanel selectedNode={makeNode({ file: '' })} />);
    const btn = screen.getByTestId('info-panel-copy-path') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
