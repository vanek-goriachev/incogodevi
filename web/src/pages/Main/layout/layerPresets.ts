/**
 * Encode / decode helpers for the Layer Editor preset blob (this PR —
 * feat/overlap-presets-package-filter).
 *
 * The user wants to copy-paste a portable representation of their layer
 * arrangement across browser tabs / users. We pick a tiny self-describing
 * envelope: the literal prefix `goviz1:` followed by base64-encoded JSON of
 * the `LayerEditorState` (the same shape `useLayerEditorState` already
 * persists in localStorage). The prefix doubles as a magic number for the
 * Import modal so accidentally pasting a different blob is rejected early.
 *
 * Lenient validation reuses `migrateLayerEditorState` so the same drop-bad-
 * lanes-keep-the-rest behaviour applies to imported state — i.e. a state
 * from a SLIGHTLY-newer build that adds a new lane kind still loads, only
 * the unknown lanes are silently dropped.
 *
 * The module is pure: no React, no DOM, no localStorage. Callers compose it
 * into hooks/components. Round-trip + tampered-payload + version-mismatch
 * are covered by `web/src/__tests__/layerPresets.test.ts`.
 */

import {
  migrateLayerEditorState,
  type LayerEditorState,
} from './laneMapping';

/** Envelope prefix used for both encode and decode. */
export const PRESET_PREFIX = 'goviz1:';

/** Result of `decodePreset`. Discriminated union so callers handle the error
 *  path explicitly without exception throwing. */
export type DecodePresetResult =
  | { ok: true; state: LayerEditorState }
  | { ok: false; error: string };

/** Encode a `LayerEditorState` into a portable `goviz1:<base64>` string. */
export function encodePreset(state: LayerEditorState): string {
  const json = JSON.stringify(state);
  return `${PRESET_PREFIX}${base64Encode(json)}`;
}

/**
 * Decode a `goviz1:<base64>` string back into a `LayerEditorState`.
 *
 *   - Returns `{ok: false}` for any payload that isn't recognisable —
 *     wrong magic prefix, malformed base64, non-JSON content, or content
 *     that `migrateLayerEditorState` cannot heal.
 *   - The current schema version is `LAYER_EDITOR_STATE_VERSION = 1`. A
 *     future bump can either return `{ok: false}` here (hard break) or
 *     keep accepting older payloads via a migration in `laneMapping.ts`.
 *     We choose the lenient path: any version that survives migration
 *     resolves to a healthy state.
 */
export function decodePreset(input: unknown): DecodePresetResult {
  if (typeof input !== 'string' || input === '') {
    return { ok: false, error: 'Пустая строка' };
  }
  const trimmed = input.trim();
  if (!trimmed.startsWith(PRESET_PREFIX)) {
    return { ok: false, error: `Префикс должен быть "${PRESET_PREFIX}"` };
  }
  const payload = trimmed.slice(PRESET_PREFIX.length);
  if (payload === '') {
    return { ok: false, error: 'Пустая полезная нагрузка' };
  }
  let decoded: string;
  try {
    decoded = base64Decode(payload);
  } catch {
    return { ok: false, error: 'Неверная base64-строка' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, error: 'Некорректный JSON' };
  }
  const migrated = migrateLayerEditorState(parsed);
  if (migrated === null) {
    return { ok: false, error: 'Состояние не распознано' };
  }
  return { ok: true, state: migrated };
}

/** Base64-encode a UTF-8 string. Uses `btoa` on a UTF-8 byte stream so non-
 *  ASCII payloads (Russian lane names) round-trip safely. The browser-only
 *  primitives are good enough for our targets (Chrome/Firefox + jsdom in
 *  tests); we don't carry a Node-specific code path. */
function base64Encode(value: string): string {
  // Encode UTF-8 → percent-escape → unescape to byte string → btoa.
  // `unescape` is deprecated but the only built-in that maps a percent-
  // escaped string to a byte string, which is what `btoa` expects.
  return globalThis.btoa(unescape(encodeURIComponent(value)));
}

function base64Decode(value: string): string {
  return decodeURIComponent(escape(globalThis.atob(value)));
}
