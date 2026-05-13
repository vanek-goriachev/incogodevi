/**
 * Round-trip + tampered-payload tests for the layer-preset encode/decode
 * helpers (feat/overlap-presets-package-filter).
 */

import { describe, expect, it } from 'vitest';

import {
  defaultLayerEditorState,
  type LayerEditorState,
} from '../pages/Main/layout/laneMapping';
import {
  PRESET_PREFIX,
  decodePreset,
  encodePreset,
} from '../pages/Main/layout/layerPresets';

describe('encodePreset / decodePreset', () => {
  it('round-trips a non-trivial layer editor state', () => {
    const state: LayerEditorState = {
      version: 1,
      groups: [
        { id: 'g1', name: 'DBs', prefix: 'databases' },
        { id: 'g2', name: 'Моки', prefix: 'internal/mocks' },
      ],
      slots: [
        { lanes: [{ kind: 'bfs', depth: 0 }] },
        {
          lanes: [
            { kind: 'bfs', depth: 1 },
            { kind: 'folder', id: 'g2', name: 'Моки', prefix: 'internal/mocks' },
          ],
        },
        { lanes: [{ kind: 'folder', id: 'g1', name: 'DBs', prefix: 'databases' }] },
      ],
      unassigned: [],
    };
    const encoded = encodePreset(state);
    expect(encoded.startsWith(PRESET_PREFIX)).toBe(true);
    const decoded = decodePreset(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.state.groups).toEqual(state.groups);
      expect(decoded.state.slots).toEqual(state.slots);
      expect(decoded.state.unassigned).toEqual(state.unassigned);
    }
  });

  it('rejects an empty string', () => {
    const r = decodePreset('');
    expect(r.ok).toBe(false);
  });

  it('rejects a payload without the goviz1: prefix', () => {
    const r = decodePreset('SGVsbG8gV29ybGQ=');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/префикс/i);
  });

  it('rejects a tampered base64 payload', () => {
    const r = decodePreset(`${PRESET_PREFIX} !!!notbase64!!!`);
    expect(r.ok).toBe(false);
  });

  it('rejects garbage JSON inside the envelope', () => {
    const garbageBase64 = globalThis.btoa('{not valid');
    const r = decodePreset(`${PRESET_PREFIX}${garbageBase64}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/i);
  });

  it('accepts a payload with a future-version number (lenient validation)', () => {
    const state = {
      version: 99,
      groups: [],
      slots: [{ lanes: [{ kind: 'bfs', depth: 0 }] }],
      unassigned: [],
    };
    const encoded = encodePreset(state as unknown as LayerEditorState);
    const r = decodePreset(encoded);
    expect(r.ok).toBe(true);
  });

  it('rejects a payload with a missing slots array', () => {
    const encodedJson = globalThis.btoa(JSON.stringify({ version: 1 }));
    const r = decodePreset(`${PRESET_PREFIX}${encodedJson}`);
    expect(r.ok).toBe(false);
  });

  it('stays under a 32 KB envelope on a 50-lane state', () => {
    // Synthesise a fairly large state — 50 folder lanes parked in `unassigned`.
    const state = defaultLayerEditorState([0, 1, 2, 3]);
    for (let i = 0; i < 50; i += 1) {
      state.groups.push({
        id: `g_${String(i)}`,
        name: `Группа ${String(i)}`,
        prefix: `pkg/sub_${String(i)}/leaf`,
      });
      state.unassigned.push({
        kind: 'folder',
        id: `g_${String(i)}`,
        name: `Группа ${String(i)}`,
        prefix: `pkg/sub_${String(i)}/leaf`,
      });
    }
    const encoded = encodePreset(state);
    expect(encoded.length).toBeLessThan(32 * 1024);
  });
});
