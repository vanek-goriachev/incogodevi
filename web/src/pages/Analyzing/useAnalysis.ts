/**
 * `useAnalysis` — wires `ApiClient.analyzeProject` into a React state machine.
 *
 * The hook owns:
 *   - lifecycle: opens the SSE stream on mount, aborts it on cleanup;
 *   - phase + progress reducer driven by `phase` events;
 *   - accumulated graph (Map<id, Node> / Map<id, Edge>) updated by
 *     `partial_graph` events — node/edge totals are flushed to React state
 *     on a short throttle so bursty streams do not thrash the tree;
 *   - warning queue + a `done` outcome (success or failure) for the UI.
 *
 * The accumulated graph stays in a ref. T20 (Cytoscape integration) re-fetches
 * the final graph through `GET /graph` after the navigation, but exposing the
 * partial result here keeps the door open for a "first paint while exporting"
 * optimization without touching this module again.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { ApiError, type ApiClient } from '../../api/client';
import type {
  AnalysisPhase,
  DoneEvent,
  Edge,
  Node,
  PartialGraphEvent,
  PhaseEvent,
} from '../../api/types';
import { readEntryPointSpec, readFilters } from '../../storage/analysisSpec';

/** Ordered list of phases shown in the badge row (design.md §3.2). */
export const ANALYSIS_PHASES: readonly AnalysisPhase[] = [
  'loading',
  'parsing',
  'building_graph',
  'reachability',
  'exporting',
  'done',
];

export type AnalysisStatus = 'idle' | 'streaming' | 'done' | 'failed' | 'cancelled';

export interface AnalysisWarning {
  /** Monotonic sequence per connection — used as a React key. */
  seq: number;
  code: string;
  message: string;
}

export interface AnalysisError {
  code: string;
  message: string;
}

export interface AccumulatedGraph {
  nodes: Map<string, Node>;
  edges: Map<string, Edge>;
}

export interface AnalysisState {
  status: AnalysisStatus;
  phase: AnalysisPhase;
  /** 0..1 fraction supplied by the latest `phase` event (0 if missing). */
  progress: number;
  /** Optional message piggy-backed by the orchestrator on `phase` events. */
  message: string | null;
  /** Cumulative node/edge counts from `partial_graph` events. */
  graphSize: { nodes: number; edges: number };
  /** Warnings accumulated since the connection opened. */
  warnings: AnalysisWarning[];
  /** Set on `done.failed` or on a pre-stream HTTP error. */
  error: AnalysisError | null;
  /** Run id incremented on every (re)start so consumers can `key=` off it. */
  runId: number;
}

interface AnalysisAction {
  readonly type:
    | 'reset'
    | 'phase'
    | 'partial'
    | 'warning'
    | 'done'
    | 'failed'
    | 'cancelled';
  readonly payload?: unknown;
}

const INITIAL_STATE: AnalysisState = {
  status: 'idle',
  phase: 'loading',
  progress: 0,
  message: null,
  graphSize: { nodes: 0, edges: 0 },
  warnings: [],
  error: null,
  runId: 0,
};

function reducer(state: AnalysisState, action: AnalysisAction): AnalysisState {
  switch (action.type) {
    case 'reset':
      return {
        ...INITIAL_STATE,
        runId: state.runId + 1,
        status: 'streaming',
      };
    case 'phase': {
      const evt = action.payload as PhaseEvent;
      return {
        ...state,
        phase: evt.phase,
        progress:
          typeof evt.progress === 'number' ? clamp01(evt.progress) : state.progress,
        message: typeof evt.message === 'string' ? evt.message : null,
      };
    }
    case 'partial': {
      const sizes = action.payload as { nodes: number; edges: number };
      return { ...state, graphSize: sizes };
    }
    case 'warning': {
      const warn = action.payload as AnalysisWarning;
      // Cap the visible queue so long runs do not blow up the React tree.
      const next = [...state.warnings, warn];
      if (next.length > 50) {
        next.splice(0, next.length - 50);
      }
      return { ...state, warnings: next };
    }
    case 'done': {
      const evt = action.payload as DoneEvent;
      return {
        ...state,
        status: 'done',
        phase: 'done',
        progress: 1,
        graphSize: {
          nodes: evt.node_count ?? state.graphSize.nodes,
          edges: evt.edge_count ?? state.graphSize.edges,
        },
      };
    }
    case 'failed': {
      const err = action.payload as AnalysisError;
      return {
        ...state,
        status: 'failed',
        phase: 'failed',
        error: err,
      };
    }
    case 'cancelled':
      return { ...state, status: 'cancelled' };
  }
}

export interface UseAnalysisOptions {
  apiClient: ApiClient;
  /** `undefined` when no project has been selected — the hook becomes a no-op. */
  projectId: string | undefined;
  /** Override partial-graph throttle in ms; tests pass `0` for determinism. */
  partialThrottleMs?: number;
  /** Invoked exactly once when the run reaches `phase: "done"` successfully. */
  onComplete?: (graph: AccumulatedGraph) => void;
}

export interface UseAnalysisApi {
  state: AnalysisState;
  /** Aborts the in-flight stream; the reducer flips status to "cancelled". */
  cancel: () => void;
  /** Tear down + restart the stream from scratch. */
  retry: () => void;
  /** Read-only snapshot of the accumulated graph for downstream consumers. */
  graph: AccumulatedGraph;
}

/** Default flush cadence — ~1 frame at 60 Hz. Coalesces bursty chunks. */
const DEFAULT_PARTIAL_THROTTLE_MS = 16;

export function useAnalysis(opts: UseAnalysisOptions): UseAnalysisApi {
  const {
    apiClient,
    projectId,
    partialThrottleMs = DEFAULT_PARTIAL_THROTTLE_MS,
    onComplete,
  } = opts;
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  const controllerRef = useRef<AbortController | null>(null);
  const graphRef = useRef<AccumulatedGraph>({ nodes: new Map(), edges: new Map() });
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFlushRef = useRef(false);
  const onCompleteRef = useRef<typeof onComplete>(onComplete);
  onCompleteRef.current = onComplete;

  const flushSizes = useCallback(() => {
    pendingFlushRef.current = false;
    flushTimerRef.current = null;
    dispatch({
      type: 'partial',
      payload: {
        nodes: graphRef.current.nodes.size,
        edges: graphRef.current.edges.size,
      },
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (partialThrottleMs <= 0) {
      flushSizes();
      return;
    }
    if (pendingFlushRef.current) {
      return;
    }
    pendingFlushRef.current = true;
    flushTimerRef.current = setTimeout(flushSizes, partialThrottleMs);
  }, [flushSizes, partialThrottleMs]);

  const handlePartial = useCallback(
    (evt: PartialGraphEvent) => {
      const { nodes, edges } = graphRef.current;
      for (const node of evt.nodes) {
        nodes.set(node.id, node);
      }
      for (const edge of evt.edges) {
        edges.set(edge.id, edge);
      }
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const teardown = useCallback(() => {
    if (controllerRef.current !== null) {
      controllerRef.current.abort();
      controllerRef.current = null;
    }
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    pendingFlushRef.current = false;
  }, []);

  const start = useCallback(() => {
    if (projectId === undefined || projectId === '') {
      return;
    }
    teardown();
    graphRef.current = { nodes: new Map(), edges: new Map() };
    dispatch({ type: 'reset' });

    const spec = readEntryPointSpec(projectId);
    const filters = readFilters(projectId);

    const controller = apiClient.analyzeProject(
      projectId,
      { entry_points: spec, filters },
      (event) => {
        switch (event.type) {
          case 'phase':
            dispatch({ type: 'phase', payload: event.payload });
            return;
          case 'partial_graph':
            handlePartial(event.payload);
            return;
          case 'warning': {
            const w = event.payload;
            dispatch({
              type: 'warning',
              payload: {
                seq: w.seq,
                code: w.code,
                message: w.message,
              } satisfies AnalysisWarning,
            });
            return;
          }
          case 'done': {
            // Flush any pending size update before the success/fail branch
            // overrides graphSize with the server totals.
            if (pendingFlushRef.current) {
              if (flushTimerRef.current !== null) {
                clearTimeout(flushTimerRef.current);
              }
              flushSizes();
            }
            if (event.payload.phase === 'failed') {
              const err = event.payload.error;
              dispatch({
                type: 'failed',
                payload: {
                  code: err?.code ?? 'internal',
                  message: err?.message ?? 'analysis failed',
                },
              });
              return;
            }
            dispatch({ type: 'done', payload: event.payload });
            // Fire onComplete after dispatch so consumers see the final state.
            queueMicrotask(() => {
              onCompleteRef.current?.(graphRef.current);
            });
            return;
          }
          case 'unknown':
            // Forward-compat: ignore unknown event names per api-contract §9.
            return;
        }
      },
      (err) => {
        dispatch({
          type: 'failed',
          payload: { code: err.code, message: err.message },
        });
      },
    );
    controllerRef.current = controller;
  }, [apiClient, flushSizes, handlePartial, projectId, teardown]);

  const cancel = useCallback(() => {
    teardown();
    dispatch({ type: 'cancelled' });
  }, [teardown]);

  const retry = useCallback(() => {
    start();
  }, [start]);

  // Open the stream on mount / project change, tear it down on unmount.
  useEffect(() => {
    start();
    return () => {
      teardown();
    };
    // We intentionally rerun on projectId change only. `start`/`teardown` are
    // memoized over the same deps so adding them here would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const api = useMemo<UseAnalysisApi>(
    () => ({
      state,
      cancel,
      retry,
      graph: graphRef.current,
    }),
    [state, cancel, retry],
  );

  return api;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

export { ApiError };
