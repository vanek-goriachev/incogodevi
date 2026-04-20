/**
 * `useGraphData` — fetches the latest graph snapshot from
 * `GET /api/projects/{id}/graph` and exposes it as a typed reducer state.
 *
 * Uses `aggregate=auto` (api-contract §3): the backend collapses graphs
 * larger than 1000 nodes to per-package aggregation. The frontend simply
 * renders whatever the server returns; expand-on-demand for aggregated
 * package nodes is implemented in T24.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { ApiError, type ApiClient } from '../../api/client';
import type { Graph, Warning } from '../../api/types';

/** Discriminated union describing the loader lifecycle. */
export type GraphDataState =
  | { status: 'idle'; graph: null; warnings: Warning[]; error: null }
  | { status: 'loading'; graph: Graph | null; warnings: Warning[]; error: null }
  | { status: 'ready'; graph: Graph; warnings: Warning[]; error: null }
  | { status: 'error'; graph: Graph | null; warnings: Warning[]; error: ApiError };

interface UseGraphDataOptions {
  apiClient: ApiClient;
  projectId: string | undefined;
}

/** Public API of `useGraphData`. */
export interface UseGraphDataApi {
  state: GraphDataState;
  /** Trigger a refetch from the backend. */
  refresh: () => void;
}

type Action =
  | { type: 'start' }
  | { type: 'success'; graph: Graph }
  | { type: 'failure'; error: ApiError };

function reducer(state: GraphDataState, action: Action): GraphDataState {
  switch (action.type) {
    case 'start':
      return {
        status: 'loading',
        graph: state.graph,
        warnings: state.warnings,
        error: null,
      };
    case 'success':
      return {
        status: 'ready',
        graph: action.graph,
        warnings: action.graph.warnings,
        error: null,
      };
    case 'failure':
      return {
        status: 'error',
        graph: state.graph,
        warnings: state.warnings,
        error: action.error,
      };
  }
}

const INITIAL: GraphDataState = {
  status: 'idle',
  graph: null,
  warnings: [],
  error: null,
};

/**
 * Fetch the project's graph snapshot. The first call fires automatically
 * on mount; later calls happen via `refresh()`.
 */
export function useGraphData({ apiClient, projectId }: UseGraphDataOptions): UseGraphDataApi {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  // `tick` is bumped by `refresh()` to force the loading effect to re-run.
  const [tick, bumpTick] = useReducer((n: number) => n + 1, 0);

  // Keep a ref of the latest controller so an in-flight request is aborted
  // when `projectId` changes or the component unmounts.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (projectId === undefined || projectId === '') {
      return undefined;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    let cancelled = false;
    dispatch({ type: 'start' });
    apiClient
      .getGraph(projectId, { aggregate: 'auto' })
      .then((graph) => {
        if (cancelled || controller.signal.aborted) {
          return;
        }
        dispatch({ type: 'success', graph });
      })
      .catch((err: unknown) => {
        if (cancelled || controller.signal.aborted) {
          return;
        }
        const apiErr = err instanceof ApiError
          ? err
          : new ApiError(0, {
              code: 'network_error',
              message: err instanceof Error ? err.message : 'graph fetch failed',
            });
        dispatch({ type: 'failure', error: apiErr });
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    };
  }, [apiClient, projectId, tick]);

  const refresh = useCallback((): void => {
    bumpTick();
  }, []);

  return { state, refresh };
}
