/**
 * `useReanalyze` — re-runs `POST /api/projects/{id}/analyze` whenever the
 * user changes the entry-point spec, then refreshes the cached graph.
 *
 * The hook is built around the J2 user journey from `docs/design.md` §2:
 * the user adds a manual entry point, the SSE stream reaches `done` quickly
 * (parsed.gob is cached, so only reachability runs), and the right-rail
 * graph re-colours without leaving the Main view.
 *
 * Behaviour:
 *
 *   - Compares the latest spec against the previous successful run via a
 *     stable JSON snapshot so unrelated re-renders never trigger a reload.
 *   - Aborts any in-flight stream before issuing a new one (single-flight
 *     parity with the backend's ADR-10).
 *   - Surfaces three pieces of state (`status`, `phase`, `lastError`) so the
 *     panel can show a mini-overlay and route `invalid_entry_point` errors
 *     back into the entry-points dialog (FR-25, NFR-09).
 *   - On `done` it asks the parent to refresh the graph snapshot through
 *     the supplied callback. The empty-graph workaround for the cached-
 *     re-analyze tech-debt issue (`docs/tech-debt.md`) lives at the call
 *     site — this hook reports the new node count so the parent can decide
 *     whether to fall back to a local highlight.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../../api/client';
import type { ApiError } from '../../api/client';
import type { AnalysisPhase, EntryPointSpec, Filters } from '../../api/types';

export type ReanalyzeStatus = 'idle' | 'running' | 'done' | 'failed';

export interface ReanalyzeError {
  code: string;
  message: string;
}

export interface UseReanalyzeOptions {
  apiClient: ApiClient;
  projectId: string | undefined;
  /** Filters payload for the POST body — typically the persisted server-side filters. */
  filters: Filters;
  /** Latest entry-point spec the user has settled on. */
  spec: EntryPointSpec;
  /**
   * Whether the hook should fire at all. Disabled on first mount until the
   * initial graph fetch completes so we do not race the user's very first
   * page load.
   */
  enabled: boolean;
  /**
   * Invoked once the SSE stream emits `done` (success). The parent uses this
   * to refetch the graph through `useGraphData.refresh()`.
   *
   * Receives `{ nodeCount, edgeCount }` taken from the `done` event so the
   * caller can detect the cached-re-analyze empty-graph tech-debt symptom
   * (`docs/tech-debt.md`) and apply the local-highlight fallback.
   */
  onDone?: (summary: { nodeCount: number; edgeCount: number }) => void;
  /** Override the spec snapshot comparator — used by tests. */
  specEqualsOverride?: (a: EntryPointSpec, b: EntryPointSpec) => boolean;
}

export interface UseReanalyzeApi {
  status: ReanalyzeStatus;
  /** Latest phase reported by the SSE stream. */
  phase: AnalysisPhase | null;
  /** Last error, kept until cleared or until the next successful run. */
  lastError: ReanalyzeError | null;
  /** Clear the recorded error — used after the user dismisses the dialog. */
  clearError: () => void;
}

function defaultSpecEquals(a: EntryPointSpec, b: EntryPointSpec): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function canonicalize(spec: EntryPointSpec): EntryPointSpec {
  return {
    mode: spec.mode,
    auto_kinds: [...spec.auto_kinds].sort(),
    manual: [...spec.manual].sort(),
    interface_impl: [...spec.interface_impl].sort(),
  };
}

export function useReanalyze(opts: UseReanalyzeOptions): UseReanalyzeApi {
  const {
    apiClient,
    projectId,
    filters,
    spec,
    enabled,
    onDone,
    specEqualsOverride,
  } = opts;
  const equals = specEqualsOverride ?? defaultSpecEquals;

  const [status, setStatus] = useState<ReanalyzeStatus>('idle');
  const [phase, setPhase] = useState<AnalysisPhase | null>(null);
  const [lastError, setLastError] = useState<ReanalyzeError | null>(null);

  const lastSpecRef = useRef<EntryPointSpec | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const clearError = useCallback(() => {
    setLastError(null);
  }, []);

  useEffect(() => {
    if (!enabled || projectId === undefined || projectId === '') {
      return undefined;
    }
    if (lastSpecRef.current !== null && equals(lastSpecRef.current, spec)) {
      return undefined;
    }
    // The first effect run baselines the spec — we only want to fire on
    // *changes* the user makes, not on initial mount where `useGraphData`
    // already loaded the cached graph that matches the stored spec.
    if (lastSpecRef.current === null) {
      lastSpecRef.current = spec;
      return undefined;
    }
    lastSpecRef.current = spec;

    controllerRef.current?.abort();
    setStatus('running');
    setPhase(null);
    setLastError(null);

    let succeeded = false;
    const controller = apiClient.analyzeProject(
      projectId,
      { entry_points: spec, filters },
      (event) => {
        switch (event.type) {
          case 'phase':
            setPhase(event.payload.phase);
            return;
          case 'partial_graph':
            return;
          case 'warning':
            return;
          case 'done': {
            if (event.payload.phase === 'failed') {
              const err = event.payload.error;
              setStatus('failed');
              setLastError({
                code: err?.code ?? 'internal',
                message: err?.message ?? 'analysis failed',
              });
              return;
            }
            succeeded = true;
            setStatus('done');
            setPhase('done');
            onDoneRef.current?.({
              nodeCount: event.payload.node_count ?? 0,
              edgeCount: event.payload.edge_count ?? 0,
            });
            return;
          }
          case 'unknown':
            return;
        }
      },
      (err: ApiError) => {
        setStatus('failed');
        setLastError({ code: err.code, message: err.message });
      },
    );
    controllerRef.current = controller;

    return () => {
      // Effects re-run on every spec change; abort the in-flight stream so
      // the new one starts cleanly. The boolean guard prevents a no-op
      // success effect from being treated as a teardown.
      if (!succeeded) {
        controller.abort();
      }
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [apiClient, projectId, filters, spec, enabled, equals]);

  // Final teardown on unmount — abort any stray controller.
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  return { status, phase, lastError, clearError };
}
