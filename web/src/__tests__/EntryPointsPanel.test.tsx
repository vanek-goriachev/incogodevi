/**
 * Component tests for the left-rail Entry-points panel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type JSX } from 'react';

import type { EntryPointSpec, Graph, SymbolEntry } from '../api/types';
import { EntryPointsPanel, type EntrySymbolSource } from '../pages/Main/panels/EntryPointsPanel';

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
    // Picker now requires typing before candidates appear (autocomplete UX).
    const input = screen.getByTestId('entry-dialog-search') as HTMLInputElement;
    await userEvent.type(input, 'Handler');
    const item = await screen.findByTestId(
      'entry-dialog-pick-github.com/acme/api#Handler',
    );
    fireEvent.mouseDown(item);
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

/* ---------- Combobox / autocomplete picker tests (PR fixing the typo bug) ---------- */

function symbolFixture(): SymbolEntry[] {
  return [
    // Same-named method `Run` on two different receivers — disambiguation
    // depends on the per-row package label being rendered.
    {
      id: 'm:server-run',
      name: 'Server.Run',
      fqn: 'github.com/acme/internal/server#Server.Run',
      kind: 'method',
      package: 'github.com/acme/internal/server',
    },
    {
      id: 'm:worker-run',
      name: 'Worker.Run',
      fqn: 'github.com/acme/internal/worker#Worker.Run',
      kind: 'method',
      package: 'github.com/acme/internal/worker',
    },
    // Free function — must appear with a name prefix-match against "run".
    {
      id: 'f:runonce',
      name: 'runOnce',
      fqn: 'github.com/acme/cmd/agent#runOnce',
      kind: 'func',
      package: 'github.com/acme/cmd/agent',
    },
    // Symbol inside a currently-collapsed package — the picker must still
    // surface it (this is the whole point of the symbols endpoint).
    {
      id: 's:hiddensvc',
      name: 'HiddenService',
      fqn: 'github.com/acme/internal/collapsed#HiddenService',
      kind: 'struct',
      package: 'github.com/acme/internal/collapsed',
    },
  ];
}

function makePickerSource(symbols: SymbolEntry[]): EntrySymbolSource & {
  calls: number;
} {
  const fake = {
    calls: 0,
    listSymbols(_projectId: string): Promise<SymbolEntry[]> {
      this.calls += 1;
      return Promise.resolve(symbols);
    },
  };
  return fake;
}

function renderPickerHarness(opts: {
  initialManual?: string[];
  symbols?: SymbolEntry[];
  onChangeSpy?: (next: EntryPointSpec) => void;
}): EntrySymbolSource & { calls: number } {
  const symbols = opts.symbols ?? symbolFixture();
  const source = makePickerSource(symbols);

  function PickerHarness(): JSX.Element {
    const [spec, setSpec] = useState<EntryPointSpec>({
      mode: 'auto',
      auto_kinds: ['main'],
      manual: opts.initialManual ?? [],
      interface_impl: [],
    });
    return (
      <EntryPointsPanel
        graph={null}
        value={spec}
        onChange={(next) => {
          setSpec(next);
          opts.onChangeSpy?.(next);
        }}
        apiClient={source}
        projectId="proj-1"
      />
    );
  }

  render(<PickerHarness />);
  return source;
}

describe('<EntryPointsPanel /> picker combobox', () => {
  it('shows the empty-state hint when the dialog opens with no query', async () => {
    renderPickerHarness({});
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    // Wait for the symbols-load effect to settle so the empty-input branch
    // renders the listbox in its loaded form.
    await waitFor(() => {
      expect(screen.getByTestId('entry-dialog-search')).toBeInTheDocument();
    });
    // With empty query, the listbox shows the prompt placeholder hint.
    expect(screen.getByTestId('entry-dialog-no-match')).toHaveTextContent(
      'Начните вводить',
    );
  });

  it('ranks substring and prefix matches case-insensitively', async () => {
    renderPickerHarness({});
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    const input = screen.getByTestId('entry-dialog-search') as HTMLInputElement;
    await userEvent.type(input, 'run');
    // All three Run-related rows are surfaced; the receiver-aware name is
    // shown (`Server.Run`, `Worker.Run`) so methods are distinguishable.
    await waitFor(() => {
      expect(
        screen.getByTestId(
          'entry-dialog-pick-github.com/acme/internal/server#Server.Run',
        ),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId(
        'entry-dialog-pick-github.com/acme/internal/worker#Worker.Run',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('entry-dialog-pick-github.com/acme/cmd/agent#runOnce'),
    ).toBeInTheDocument();
    // No spurious matches — the unrelated struct must not appear.
    expect(
      screen.queryByTestId(
        'entry-dialog-pick-github.com/acme/internal/collapsed#HiddenService',
      ),
    ).toBeNull();
  });

  it('commits the canonical FQN when the user picks via mouse', async () => {
    const spy = vi.fn();
    renderPickerHarness({ onChangeSpy: spy });
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    const input = screen.getByTestId('entry-dialog-search') as HTMLInputElement;
    await userEvent.type(input, 'Worker.Run');
    const option = await screen.findByTestId(
      'entry-dialog-pick-github.com/acme/internal/worker#Worker.Run',
    );
    // mousedown commit path — also covers the popover-stability concern by
    // never letting the click bubble to the backdrop.
    fireEvent.mouseDown(option);
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as EntryPointSpec;
    expect(last.manual).toContain(
      'github.com/acme/internal/worker#Worker.Run',
    );
  });

  it('moves the highlight with ArrowDown and commits via Enter', async () => {
    const spy = vi.fn();
    renderPickerHarness({ onChangeSpy: spy });
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    const input = screen.getByTestId('entry-dialog-search') as HTMLInputElement;
    await userEvent.type(input, 'run');
    // Wait until the ranked list is populated.
    await screen.findByTestId(
      'entry-dialog-pick-github.com/acme/internal/server#Server.Run',
    );
    // The first ranked candidate is at index 0; ArrowDown moves to index 1.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as EntryPointSpec;
    expect(last.manual.length).toBe(1);
    // The committed value is a canonical loader FQN — the regex test below
    // is a structural guard that we never emit a bare method name.
    expect(last.manual[0]).toMatch(/#[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/);
  });

  it('closes the dialog without committing on Escape', async () => {
    const spy = vi.fn();
    renderPickerHarness({ onChangeSpy: spy });
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    const input = screen.getByTestId('entry-dialog-search') as HTMLInputElement;
    await userEvent.type(input, 'run');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('entry-dialog')).toBeNull();
    // No onChange invocation for an Escape close.
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows "Ничего не найдено" when the query matches nothing', async () => {
    renderPickerHarness({});
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    const input = screen.getByTestId('entry-dialog-search') as HTMLInputElement;
    await userEvent.type(input, 'zzzz-impossible-zzzz');
    await waitFor(() => {
      expect(screen.getByTestId('entry-dialog-no-match')).toHaveTextContent(
        'Ничего не найдено',
      );
    });
  });

  it('surfaces symbols inside currently-collapsed packages', async () => {
    renderPickerHarness({});
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    const input = screen.getByTestId('entry-dialog-search') as HTMLInputElement;
    // Type a substring that only the collapsed-package symbol matches.
    await userEvent.type(input, 'Hidden');
    await waitFor(() => {
      expect(
        screen.getByTestId(
          'entry-dialog-pick-github.com/acme/internal/collapsed#HiddenService',
        ),
      ).toBeInTheDocument();
    });
  });

  it('clicking a dropdown option keeps the surrounding popover open until commit', async () => {
    // Regression guard for PR #49's popover-dismissal fix: the dropdown
    // option uses mousedown semantics so the backdrop never sees a stray
    // click between item-pointerdown and the onSubmit close.
    const spy = vi.fn();
    renderPickerHarness({ onChangeSpy: spy });
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    const input = screen.getByTestId('entry-dialog-search') as HTMLInputElement;
    await userEvent.type(input, 'Server.Run');
    const option = await screen.findByTestId(
      'entry-dialog-pick-github.com/acme/internal/server#Server.Run',
    );
    // The dialog is still mounted at this point.
    expect(screen.getByTestId('entry-dialog')).toBeInTheDocument();
    fireEvent.mouseDown(option);
    // After commit the parent closes the dialog as part of onChange — the
    // important assertion is that we got a SINGLE commit, not a dismissal.
    expect(spy).toHaveBeenCalledTimes(1);
    const last = spy.mock.calls[0]?.[0] as EntryPointSpec;
    expect(last.manual).toContain(
      'github.com/acme/internal/server#Server.Run',
    );
  });

  it('does not impose its own cap on the entry list — pin overflow stays with GraphCanvas', async () => {
    // The picker exposes at most DEFAULT_PICKER_LIMIT (10) DROPDOWN rows,
    // but adding a 13th manual entry must still succeed at the spec level —
    // GraphCanvas's onPinOverflow toast is the only gate (ENTRY_PIN_LIMIT).
    const spy = vi.fn();
    const initialManual = Array.from({ length: 12 }, (_, i) => `pkg/p${String(i)}#Fn`);
    const extraSymbol: SymbolEntry = {
      id: 'extra',
      name: 'ExtraEntry',
      fqn: 'pkg/extra#ExtraEntry',
      kind: 'func',
      package: 'pkg/extra',
    };
    renderPickerHarness({
      initialManual,
      symbols: [extraSymbol],
      onChangeSpy: spy,
    });
    await userEvent.click(screen.getByTestId('entry-panel-add'));
    const input = screen.getByTestId('entry-dialog-search') as HTMLInputElement;
    await userEvent.type(input, 'Extra');
    const opt = await screen.findByTestId('entry-dialog-pick-pkg/extra#ExtraEntry');
    fireEvent.mouseDown(opt);
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as EntryPointSpec;
    expect(last.manual.length).toBe(13);
    expect(last.manual).toContain('pkg/extra#ExtraEntry');
  });
});
