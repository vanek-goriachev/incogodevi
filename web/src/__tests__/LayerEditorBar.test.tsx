/**
 * React-Testing-Library tests for `<LayerEditorBar />` (R12).
 *
 * Verifies the editor's three core gestures:
 *   - dragging a chip from one slot to another moves it,
 *   - adding a folder group via the inline form adds a chip,
 *   - reset button restores defaults.
 *
 * Drag-and-drop is simulated through fireEvent.dragStart / drop with a fake
 * DataTransfer because jsdom does not implement the native one.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { useState } from 'react';

import { LayerEditorBar } from '../pages/Main/panels/LayerEditorBar';
import {
  defaultLayerEditorState,
  laneKeyOf,
  type LayerEditorState,
} from '../pages/Main/layout/laneMapping';
import { encodePreset } from '../pages/Main/layout/layerPresets';
import type { NamedPreset } from '../pages/Main/useLayerEditorState';

function makeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  const dt = {
    setData: (k: string, v: string) => store.set(k, v),
    getData: (k: string) => store.get(k) ?? '',
    dropEffect: 'move' as const,
    effectAllowed: 'move' as const,
    types: [] as string[],
    files: [],
    items: [],
    clearData: () => store.clear(),
    setDragImage: () => {},
  };
  return dt as unknown as DataTransfer;
}

interface HarnessProps {
  initial?: LayerEditorState;
  onMove?: (laneKey: string, to: number, stack: number) => void;
  onAdd?: (name: string, prefix: string) => void;
  onReset?: () => void;
}

function Harness({ initial, onMove, onAdd, onReset }: HarnessProps): JSX.Element {
  const [state, setState] = useState<LayerEditorState>(
    initial ?? defaultLayerEditorState([0, 1, 2]),
  );
  const [presets, setPresets] = useState<NamedPreset[]>([]);
  return (
    <LayerEditorBar
      state={state}
      countsByLaneKey={new Map([
        ['bfs:0', 3],
        ['bfs:1', 5],
        ['bfs:2', 2],
      ])}
      nodeIdsByLaneKey={new Map()}
      onAddGroup={(name, prefix) => {
        onAdd?.(name, prefix);
        setState((prev) => ({
          ...prev,
          groups: [...prev.groups, { id: 'gx', name, prefix }],
          unassigned: [...prev.unassigned, { kind: 'folder', id: 'gx', name, prefix }],
        }));
      }}
      onRemoveGroup={() => {}}
      onMoveLane={(laneKey, toSlot, toStack) => {
        onMove?.(laneKey, toSlot, toStack);
        setState((prev) => {
          let found: typeof prev.slots[number]['lanes'][number] | null = null;
          const slots = prev.slots.map((s) => {
            const lanes: typeof s.lanes = [];
            for (const l of s.lanes) {
              if (laneKeyOf(l) === laneKey && found === null) {
                found = l;
                continue;
              }
              lanes.push(l);
            }
            return { lanes };
          });
          if (found === null) return prev;
          while (slots.length <= toSlot) slots.push({ lanes: [] });
          const target = slots[toSlot]!;
          const lanes = target.lanes.slice();
          lanes.splice(Math.min(toStack, lanes.length), 0, found);
          slots[toSlot] = { lanes };
          while (slots.length > 0 && (slots[slots.length - 1]?.lanes.length ?? 0) === 0) {
            slots.pop();
          }
          return { ...prev, slots };
        });
      }}
      onReset={() => {
        onReset?.();
        setState(defaultLayerEditorState([0, 1, 2]));
      }}
      onReplaceState={(next) => {
        setState(next);
      }}
      presets={presets}
      onSavePreset={(name) => {
        const id = `p_${String(presets.length + 1)}`;
        setPresets((prev) => [...prev, { id, name, state }]);
        return id;
      }}
      onLoadPreset={(id) => {
        const found = presets.find((p) => p.id === id);
        if (found !== undefined) setState(found.state);
      }}
      onDeletePreset={(id) => {
        setPresets((prev) => prev.filter((p) => p.id !== id));
      }}
    />
  );
}

describe('<LayerEditorBar />', () => {
  it('moves a chip between slots via native drag-and-drop', () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    // Initially, BFS lanes 0/1/2 are each in their own slot.
    const chip0 = screen.getByTestId('layer-editor-chip-bfs:0');
    // Move BFS 0 to slot 2 (where BFS 2 currently sits).
    const slot2 = screen.getByTestId('layer-editor-slot-2');
    const dt = makeDataTransfer();
    fireEvent.dragStart(chip0, { dataTransfer: dt });
    fireEvent.dragOver(slot2, { dataTransfer: dt });
    fireEvent.drop(slot2, { dataTransfer: dt, clientY: 0 });
    expect(onMove).toHaveBeenCalledWith('bfs:0', 2, expect.any(Number));
  });

  it('adds a new folder group from the inline form', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<Harness onAdd={onAdd} />);
    await user.click(screen.getByTestId('layer-editor-add'));
    await user.type(screen.getByTestId('layer-editor-name'), 'DBs');
    await user.type(screen.getByTestId('layer-editor-prefix'), 'databases');
    await user.click(screen.getByTestId('layer-editor-add-confirm'));
    expect(onAdd).toHaveBeenCalledWith('DBs', 'databases');
    // The new folder chip should now appear in the unassigned tray.
    expect(screen.getByTestId('layer-editor-chip-folder:gx')).toBeInTheDocument();
  });

  it('reset button restores default state', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    // Start with a non-default state — only 1 slot.
    const initial: LayerEditorState = {
      version: 1,
      groups: [],
      slots: [{ lanes: [{ kind: 'bfs', depth: 5 }] }],
      unassigned: [],
    };
    render(<Harness initial={initial} onReset={onReset} />);
    expect(screen.queryByTestId('layer-editor-chip-bfs:0')).toBeNull();
    await user.click(screen.getByTestId('layer-editor-reset'));
    expect(onReset).toHaveBeenCalled();
    expect(screen.getByTestId('layer-editor-chip-bfs:0')).toBeInTheDocument();
  });

  it('save-as adds a preset to the dropdown; delete removes it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const select = screen.getByTestId('layer-editor-preset-select') as HTMLSelectElement;
    // Initially only the "(нет)" placeholder option.
    expect(select.options.length).toBe(1);
    await user.click(screen.getByTestId('layer-editor-save-as'));
    await user.type(
      screen.getByTestId('layer-editor-save-as-input'),
      'Архитектура',
    );
    await user.click(screen.getByTestId('layer-editor-save-as-confirm'));
    expect(select.options.length).toBe(2);
    expect(select.value).not.toBe('');
    // Now delete: button enables only when a preset is selected.
    await user.click(screen.getByTestId('layer-editor-delete-preset'));
    expect(select.options.length).toBe(1);
  });

  it('export modal shows a goviz1: prefix string', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('layer-editor-export'));
    const textarea = screen.getByTestId('layer-editor-export-text') as HTMLTextAreaElement;
    expect(textarea.value.startsWith('goviz1:')).toBe(true);
  });

  it('import modal accepts a round-tripped string and rejects garbage', async () => {
    const user = userEvent.setup();
    const state: LayerEditorState = {
      version: 1,
      groups: [{ id: 'g', name: 'DB', prefix: 'db' }],
      slots: [{ lanes: [{ kind: 'folder', id: 'g', name: 'DB', prefix: 'db' }] }],
      unassigned: [],
    };
    const encoded = encodePreset(state);
    render(<Harness />);
    // 1. Import garbage → error surfaces in the modal.
    await user.click(screen.getByTestId('layer-editor-import'));
    await user.type(
      screen.getByTestId('layer-editor-import-text'),
      'not-a-preset',
    );
    await user.click(screen.getByTestId('layer-editor-import-submit'));
    expect(screen.getByTestId('layer-editor-import-error')).toBeInTheDocument();
    // 2. Replace with a valid encoded preset → modal closes.
    const ta = screen.getByTestId('layer-editor-import-text') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: encoded } });
    await user.click(screen.getByTestId('layer-editor-import-submit'));
    expect(screen.queryByTestId('layer-editor-import-error')).toBeNull();
  });
});
