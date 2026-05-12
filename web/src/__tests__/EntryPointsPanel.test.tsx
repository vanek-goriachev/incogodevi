/**
 * Component tests for the left-rail Entry-points panel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type JSX } from 'react';

import type { EntryPointSpec, Graph } from '../api/types';
import { EntryPointsPanel } from '../pages/Main/panels/EntryPointsPanel';

function defaultSpec(): EntryPointSpec {
  return {
    mode: 'auto',
    auto_kinds: ['main'],
    manual: [],
    interface_impl: [],
  };
}

function makeGraph(): Graph {
  return {
    project_id: 'p',
    generated_at: '2026-04-19T00:00:00Z',
    aggregation: 'none',
    stats: { node_count: 0, edge_count: 0, by_kind: {}, dead_count: 0 },
    nodes: [
      {
        id: 'fn:main',
        name: 'main',
        kind: 'func',
        package: 'cmd/app',
        file: 'cmd/app/main.go',
        line: 1,
        exported: false,
        reachable: true,
        is_entry: true,
      },
      {
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
      {
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
    ],
    edges: [],
    warnings: [],
  };
}

interface HarnessProps {
  initial?: EntryPointSpec;
  onChangeSpy?: (next: EntryPointSpec) => void;
  onDuplicate?: (fqn: string) => void;
  serverError?: { code: string; message: string } | null;
}

function Harness({
  initial,
  onChangeSpy,
  onDuplicate,
  serverError,
}: HarnessProps): JSX.Element {
  const [spec, setSpec] = useState<EntryPointSpec>(initial ?? defaultSpec());
  // Build the props conditionally so `exactOptionalPropertyTypes` is happy —
  // never pass `undefined` for optional callback props.
  const props: Parameters<typeof EntryPointsPanel>[0] = {
    graph: makeGraph(),
    value: spec,
    onChange: (next) => {
      setSpec(next);
      onChangeSpy?.(next);
    },
    lastError: serverError ?? null,
  };
  if (onDuplicate !== undefined) {
    props.onDuplicate = onDuplicate;
  }
  return <EntryPointsPanel {...props} />;
}

describe('<EntryPointsPanel />', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the auto-main toggle checked by default', () => {
    render(<Harness />);
    const cb = screen.getByTestId('entry-panel-auto-main') as HTMLInputElement;
    expect(cb.checked).toBe(true);
    expect(screen.getByTestId('entry-panel-manual-empty')).toBeInTheDocument();
  });

  it('switches the spec to manual when auto-main is toggled off', async () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    await userEvent.click(screen.getByTestId('entry-panel-auto-main'));
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as EntryPointSpec;
    expect(last.mode).toBe('manual');
    expect(last.auto_kinds).toEqual([]);
  });

  it('opens the dialog and adds a node picked from the graph', async () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    const item = screen.getByTestId(
      'entry-dialog-pick-github.com/acme/api#Handler',
    );
    await userEvent.click(item);
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as EntryPointSpec;
    expect(last.manual).toContain('github.com/acme/api#Handler');
    expect(last.mode).toBe('mixed');
  });

  it('rejects malformed FQNs in the paste tab', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    await userEvent.click(screen.getByTestId('entry-dialog-tab-fqn'));
    const input = screen.getByTestId('entry-dialog-fqn-input') as HTMLInputElement;
    await userEvent.type(input, 'not-an-fqn');
    expect(screen.getByTestId('entry-dialog-syntax-error')).toBeInTheDocument();
    const submit = screen.getByTestId('entry-dialog-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('accepts a valid FQN and closes the dialog', async () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    await userEvent.click(screen.getByTestId('entry-dialog-tab-fqn'));
    const input = screen.getByTestId('entry-dialog-fqn-input') as HTMLInputElement;
    await userEvent.type(input, 'github.com/acme/api#Server.ServeHTTP');
    await userEvent.click(screen.getByTestId('entry-dialog-submit'));
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as EntryPointSpec;
    expect(last.manual).toContain('github.com/acme/api#Server.ServeHTTP');
    expect(screen.queryByTestId('entry-dialog')).toBeNull();
  });

  it('removes a manual entry through the chip remove button', async () => {
    const spy = vi.fn();
    render(
      <Harness
        initial={{
          mode: 'mixed',
          auto_kinds: ['main'],
          manual: ['github.com/acme/api#Handler'],
          interface_impl: [],
        }}
        onChangeSpy={spy}
      />,
    );
    await userEvent.click(
      screen.getByTestId('entry-panel-remove-github.com/acme/api#Handler'),
    );
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as EntryPointSpec;
    expect(last.manual).toEqual([]);
    expect(last.mode).toBe('auto');
  });

  it('reports a duplicate add attempt without mutating the spec', async () => {
    const spy = vi.fn();
    const onDuplicate = vi.fn();
    render(
      <Harness
        initial={{
          mode: 'mixed',
          auto_kinds: ['main'],
          manual: ['github.com/acme/api#Handler'],
          interface_impl: [],
        }}
        onChangeSpy={spy}
        onDuplicate={onDuplicate}
      />,
    );
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    await userEvent.click(screen.getByTestId('entry-dialog-tab-fqn'));
    const input = screen.getByTestId('entry-dialog-fqn-input') as HTMLInputElement;
    await userEvent.type(input, 'github.com/acme/api#Handler');
    expect(screen.getByTestId('entry-dialog-duplicate-error')).toBeInTheDocument();
    const submit = screen.getByTestId('entry-dialog-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('renders the server invalid_entry_point error inside the dialog', async () => {
    render(
      <Harness
        serverError={{ code: 'invalid_entry_point', message: 'pkg#Foo not found' }}
      />,
    );
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    expect(screen.getByTestId('entry-dialog-server-error')).toHaveTextContent(
      'pkg#Foo not found',
    );
  });

  it('closes the dialog on Escape', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    expect(screen.getByTestId('entry-dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('entry-dialog')).toBeNull();
  });

  it('keeps the dialog open and the FQN input focused when mouseup escapes the input onto the backdrop', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    await userEvent.click(screen.getByTestId('entry-dialog-tab-fqn'));
    const input = screen.getByTestId('entry-dialog-fqn-input') as HTMLInputElement;
    const backdrop = screen.getByTestId('entry-dialog-backdrop');
    // Real-world repro: user drag-selects text inside the input. The pointerdown
    // lands on the input; the pointerup escapes onto the padded backdrop and
    // React fires a synthetic click on the backdrop (target=backdrop). Before
    // the fix that click dismissed the dialog and discarded the typed value.
    fireEvent.mouseDown(input);
    fireEvent.click(backdrop, { target: backdrop });
    expect(screen.getByTestId('entry-dialog')).toBeInTheDocument();
    input.focus();
    await userEvent.type(input, 'github.com/acme/api#Server.Run');
    expect(input.value).toBe('github.com/acme/api#Server.Run');
    expect(document.activeElement).toBe(input);
  });

  it('still dismisses when both mousedown and click land on the backdrop', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    const backdrop = screen.getByTestId('entry-dialog-backdrop');
    fireEvent.mouseDown(backdrop, { target: backdrop });
    fireEvent.click(backdrop, { target: backdrop });
    expect(screen.queryByTestId('entry-dialog')).toBeNull();
  });
});
