/**
 * Main screen — three-column layout from `docs/design.md` §3.3.
 *
 * Left rail: entry-points panel (T22) on top, filters panel (T21) below.
 * Centre:    Cytoscape canvas with the right-click context menu.
 * Right rail: Info panel (T22) + Dead-code panel (T23).
 * Top bar:   project headline, dead-mode segmented control (T23), refresh.
 *
 * The view owns:
 *
 *   - the selected node id, mirrored into Cytoscape and the Info panel;
 *   - the persisted entry-point spec, fed to `useReanalyze` so a manual
 *     change re-runs `POST /analyze` (J2);
 *   - the collapsed-set state via `useCollapse`, which drives the
 *     hide-subtree affordance from both the right-click menu and (in a
 *     future iteration) keyboard shortcuts.
 *
 * Re-analyze flow keeps the user on the page: a mini-overlay shows
 * "re-analyzing…" on top of the existing graph while the SSE stream runs;
 * once `done` arrives, `useGraphData.refresh()` pulls the new graph. If the
 * server replies with an empty graph (cached-re-analyze tech-debt symptom,
 * `docs/tech-debt.md`), the view falls back to a local reachability re-tag
 * so the user still sees the new highlights.
 */

import type { Core } from 'cytoscape';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';

import type { ApiClient } from '../../api/client';
import { Layout } from '../../app/Layout';
import { useRouter } from '../../app/Router';
import { useToast } from '../../app/Toasts';
import { useTheme } from '../../app/theme';
import { ANALYSIS_ERROR_MESSAGES } from '../../i18n/en';
import {
  DEFAULT_ENTRY_POINT_SPEC,
  DEFAULT_FILTERS,
} from '../../storage/analysisSpec';
import { projectKey } from '../../storage/keys';
import { useLocalStorage } from '../../storage/useLocalStorage';
import { ContextMenu } from './ContextMenu';
import { DeadModeSwitcher } from './DeadModeSwitcher';
import { GraphCanvas } from './GraphCanvas';
import { readThemeTokens, type ThemeTokens } from './graph-styles';
import { recomputeReachability } from './localReachability';
import { DeadCodePanel } from './panels/DeadCodePanel';
import { EntryPointsPanel } from './panels/EntryPointsPanel';
import { ExportPanel } from './panels/ExportPanel';
import { FiltersPanel } from './panels/FiltersPanel';
import {
  defaultFilterSpec,
  normalizeFilterSpec,
  type FilterSpec,
} from './panels/filterSpec';
import { InfoPanel } from './panels/InfoPanel';
import { LegendPanel } from './panels/LegendPanel';
import { useAggregateExpand } from './useAggregateExpand';
import { useCollapse } from './useCollapse';
import { useDeadMode } from './useDeadMode';
import { applyFilters, useFilters } from './useFilters';
import { useGraphData } from './useGraphData';
import { usePositionsStorage } from './usePositionsStorage';
import { useReanalyze } from './useReanalyze';
import type { EntryPointSpec, Graph, Node } from '../../api/types';

export interface MainViewProps {
  apiClient: ApiClient;
}

export function MainView({ apiClient }: MainViewProps): JSX.Element {
  const { state: routeState, navigate } = useRouter();
  const { resolved: resolvedTheme } = useTheme();
  const { showToast } = useToast();
  const projectId = routeState.projectId;
  const projectName = routeState.projectName ?? '';

  const reducedMotion = usePrefersReducedMotion();
  const themeTokens = useThemeTokens(resolvedTheme);
  const { state, refresh } = useGraphData({ apiClient, projectId });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [cy, setCy] = useState<Core | null>(null);

  // Per-project filter spec persisted to `go-viz:<id>:filters` (design.md §8).
  const filtersStorageKey = projectKey(projectId ?? '__none__', 'filters');
  const [storedFilters, setStoredFilters] = useLocalStorage<FilterSpec>(
    filtersStorageKey,
    defaultFilterSpec(),
  );
  const filterSpec = useMemo(() => normalizeFilterSpec(storedFilters), [storedFilters]);
  const handleFilterChange = useCallback(
    (next: FilterSpec) => {
      setStoredFilters(next);
    },
    [setStoredFilters],
  );

  useFilters(cy, filterSpec);

  // Per-project entry-point spec persisted to `go-viz:<id>:entry-points`.
  const entryStorageKey = projectKey(projectId ?? '__none__', 'entry-points');
  const [storedEntrySpec, setStoredEntrySpec] = useLocalStorage<EntryPointSpec>(
    entryStorageKey,
    DEFAULT_ENTRY_POINT_SPEC,
  );
  const entrySpec = useMemo(() => normalizeEntrySpec(storedEntrySpec), [storedEntrySpec]);

  // Local reachability override — populated when the cached-re-analyze bug
  // triggers and we need to recompute highlights client-side. Reset on
  // every successful server graph or on project switch.
  const [localGraph, setLocalGraph] = useState<Graph | null>(null);
  useEffect(() => {
    setLocalGraph(null);
  }, [projectId]);
  useEffect(() => {
    if (state.status === 'ready') {
      setLocalGraph(null);
    }
  }, [state.status, state.graph]);

  const handleReanalyzeDone = useCallback(
    (summary: { nodeCount: number; edgeCount: number }) => {
      // Fall back to local reachability if the server returned a degenerate
      // graph (`docs/tech-debt.md`) so the user still sees their change.
      if (summary.nodeCount === 0 && state.graph !== null && state.graph.nodes.length > 0) {
        const recomputed = recomputeReachability(state.graph, entrySpec);
        setLocalGraph(recomputed);
        showToast(
          'Server returned an empty re-analyze; using local reachability fallback.',
          'warning',
        );
        return;
      }
      refresh();
    },
    [state.graph, entrySpec, refresh, showToast],
  );

  const reanalyze = useReanalyze({
    apiClient,
    projectId,
    filters: DEFAULT_FILTERS,
    spec: entrySpec,
    enabled: state.status === 'ready',
    onDone: handleReanalyzeDone,
  });

  const handleEntrySpecChange = useCallback(
    (next: EntryPointSpec) => {
      setStoredEntrySpec(next);
      reanalyze.clearError();
    },
    [setStoredEntrySpec, reanalyze],
  );

  const handleEntryDuplicate = useCallback(
    (fqn: string) => {
      showToast(`Entry point ${fqn} is already in the list.`, 'warning');
    },
    [showToast],
  );

  // Surface entry-pin overflow as a non-blocking warning. The pin layer in
  // GraphCanvas already bails when entry-points exceed ENTRY_PIN_LIMIT to
  // keep the layout legible; emitting a toast here turns what used to be a
  // silent visual failure into an explicit message the user can act on.
  const handlePinOverflow = useCallback(
    (entryCount: number, limit: number) => {
      showToast(
        `Showing reachability for ${String(entryCount)} entry points; only the first ${String(limit)} are pinned visually.`,
        'warning',
      );
    },
    [showToast],
  );

  // Apply the entry-point spec to the graph: prefer the local override when
  // it exists, otherwise return the unmodified server graph.
  const effectiveGraph = useMemo<Graph | null>(() => {
    if (localGraph !== null) {
      return localGraph;
    }
    return state.graph;
  }, [localGraph, state.graph]);

  const collapse = useCollapse(cy, projectId);
  const deadMode = useDeadMode(projectId, cy);

  // Top-bar "relayout" gesture (Bug 4): drop the persisted position map for
  // the current project and bump a counter so `GraphCanvas` re-runs its
  // initial layout from scratch. Useful after a few package expansions or
  // manual drags have left the canvas messy.
  const positionsStore = usePositionsStorage(projectId);
  const [layoutTrigger, setLayoutTrigger] = useState<number>(0);
  const handleRelayout = useCallback(() => {
    positionsStore.clear();
    setLayoutTrigger((n) => n + 1);
  }, [positionsStore]);

  const handleExpandError = useCallback(
    (message: string) => {
      showToast(message, 'error');
    },
    [showToast],
  );
  const handleExpandInfo = useCallback(
    (message: string) => {
      showToast(message, 'info');
    },
    [showToast],
  );
  const aggregateExpand = useAggregateExpand({
    apiClient,
    projectId,
    cy,
    aggregation: effectiveGraph?.aggregation,
    reducedMotion,
    onError: handleExpandError,
    onInfo: handleExpandInfo,
    onRequestRelayout: handleRelayout,
  });

  // Top-bar "Collapse all" gesture (R4-10). Iterates the live expanded set
  // and collapses each in order. Each collapsePackage call mutates the live
  // set asynchronously through React state, but the snapshot here is good
  // enough since we never re-add packages mid-iteration.
  const handleCollapseAll = useCallback(() => {
    const snapshot = Array.from(aggregateExpand.expandedPackages);
    if (snapshot.length === 0) {
      return;
    }
    for (const pkg of snapshot) {
      aggregateExpand.collapsePackage(pkg);
    }
    // After clearing all expanded children, drop any leftover member positions
    // and re-flow the canvas so the now-aggregated view looks tidy again.
    handleRelayout();
  }, [aggregateExpand, handleRelayout]);

  const handleExportError = useCallback(
    (message: string) => {
      showToast(message, 'error');
    },
    [showToast],
  );

  // Bumped after every successful graph refresh / re-analyze so the
  // DeadCodePanel knows to re-fetch its report. The graph snapshot itself
  // is not a stable identity (object reference changes per render even
  // when nothing semantically changed), so we derive a counter from the
  // ready transitions.
  const [reportRefreshKey, setReportRefreshKey] = useState<number>(0);
  const lastReadyAtRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.status !== 'ready') {
      return;
    }
    const stamp = state.graph.generated_at;
    if (lastReadyAtRef.current === stamp) {
      return;
    }
    lastReadyAtRef.current = stamp;
    setReportRefreshKey((n) => n + 1);
  }, [state]);

  // Re-apply the dead-mode classes whenever the graph data changes so newly
  // added nodes (e.g. after a partial_graph SSE chunk) inherit the current
  // visibility rules. The hook itself already applies on mount and on mode
  // change; this effect bridges the third dimension — graph topology.
  useEffect(() => {
    deadMode.refresh();
  }, [deadMode, state]);

  // R9 fix: `useFilters` re-runs on [cy, filterSpec], but the initial paint
  // order on a fresh project is: cy mounts empty → useFilters runs on 0
  // nodes (no-op) → GraphCanvas's graph effect populates cy via syncElements
  // → externals are now in cy but the filter hook has no trigger to
  // re-evaluate, so `hideExternal` never takes effect on first paint.
  // Bridging the topology dimension here mirrors the deadMode.refresh() fix
  // above and makes sure every SSE chunk gets re-filtered.
  useEffect(() => {
    if (cy === null) {
      return;
    }
    applyFilters(cy, filterSpec);
  }, [cy, filterSpec, state]);

  // Reset selection on project change so the right-rail does not dangle on
  // a stale id.
  useEffect(() => {
    setSelectedNodeId(null);
  }, [projectId]);

  // Surface fetch failures as a single toast so the user is not left
  // staring at an empty canvas.
  const lastErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.status !== 'error') {
      lastErrorRef.current = null;
      return;
    }
    const code = state.error.code;
    if (lastErrorRef.current === code) {
      return;
    }
    lastErrorRef.current = code;
    const message =
      ANALYSIS_ERROR_MESSAGES[code] ?? state.error.message ?? 'failed to load graph';
    showToast(message, 'error');
  }, [state, showToast]);

  // Surface re-analyze failures (other than `invalid_entry_point`, which the
  // dialog handles inline) as a non-blocking toast.
  useEffect(() => {
    const err = reanalyze.lastError;
    if (err === null) {
      return;
    }
    if (err.code === 'invalid_entry_point') {
      return;
    }
    const message = ANALYSIS_ERROR_MESSAGES[err.code] ?? err.message ?? 'analysis failed';
    showToast(`Re-analyze failed: ${message}`, 'error');
  }, [reanalyze.lastError, showToast]);

  const handleSelectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id);
  }, []);

  const handleCyReady = useCallback((next: Core | null) => {
    setCy(next);
    // E2E hook: expose the live Cytoscape instance on `window.__cy` so the
    // Playwright suite can read graph stats (node/edge counts, reachability)
    // without depending on internal React state. The hook is a no-op when the
    // app is rendered outside a browser context (SSR, vitest+jsdom). It is
    // intentionally always on — no production secret leaks through it and the
    // Cytoscape API surface is already public via DOM events.
    if (typeof window !== 'undefined') {
      (window as unknown as { __cy: Core | null }).__cy = next;
    }
  }, []);

  const handleAddEntryFromInfo = useCallback(
    (fqn: string) => {
      if (entrySpec.manual.includes(fqn)) {
        handleEntryDuplicate(fqn);
        return;
      }
      const next: EntryPointSpec = {
        ...entrySpec,
        manual: [...entrySpec.manual, fqn],
        mode: entrySpec.mode === 'manual' ? 'manual' : 'mixed',
      };
      handleEntrySpecChange(next);
      showToast(`Added entry point ${fqn}.`, 'success');
    },
    [entrySpec, handleEntrySpecChange, handleEntryDuplicate, showToast],
  );

  const handleCopyResult = useCallback(
    (text: string, success: boolean) => {
      if (text === '') {
        showToast('No file/line to copy.', 'warning');
        return;
      }
      if (success) {
        showToast(`Copied ${text}.`, 'success');
      } else {
        showToast('Could not copy to clipboard.', 'error');
      }
    },
    [showToast],
  );

  const stats = effectiveGraph?.stats;
  const headline = useMemo(() => {
    if (stats === undefined) {
      return projectName !== '' ? projectName : 'Project';
    }
    const dead = stats.dead_count;
    return `${projectName !== '' ? projectName : 'Project'} \u00b7 ${String(stats.node_count)} nodes \u00b7 ${String(dead)} dead`;
  }, [projectName, stats]);

  const selectedNode = useMemo<Node | null>(() => {
    if (selectedNodeId === null || effectiveGraph === null) {
      return null;
    }
    return effectiveGraph.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [effectiveGraph, selectedNodeId]);

  const isReanalyzing = reanalyze.status === 'running';

  if (projectId === undefined || projectId === '') {
    return (
      <section className="screen screen--main" data-testid="screen-main">
        <Layout topBar={<strong>No project</strong>}>
          <div className="main-view main-view--empty" data-testid="main-empty">
            <p>No project selected. Return to the landing page to upload one.</p>
            <button type="button" onClick={() => { navigate('landing'); }}>
              Back to landing
            </button>
          </div>
        </Layout>
      </section>
    );
  }

  return (
    <section className="screen screen--main main-view" data-testid="screen-main">
      <Layout
        topBar={
          <div className="main-view__top-bar">
            <strong data-testid="main-project-name">{headline}</strong>
            <DeadModeSwitcher value={deadMode.mode} onChange={deadMode.setMode} />
            <button
              type="button"
              className="main-view__refresh"
              onClick={refresh}
              data-testid="main-refresh"
              aria-label="Refresh graph"
            >
              {'\u21bb refresh'}
            </button>
            <button
              type="button"
              className="main-view__refresh"
              onClick={handleRelayout}
              data-testid="main-relayout"
              aria-label="Re-run layout from scratch"
              title="Discard current positions and re-run the layout"
            >
              {'\u21bb relayout'}
            </button>
            <button
              type="button"
              className="main-view__refresh"
              onClick={handleCollapseAll}
              data-testid="main-collapse-all"
              aria-label="Collapse every expanded package back to its aggregated node"
              title="Collapse every expanded package"
              disabled={aggregateExpand.expandedPackages.size === 0}
            >
              {'\u2922 collapse all'}
            </button>
          </div>
        }
        leftRail={
          <div className="main-view__rail" data-testid="main-left-rail">
            <EntryPointsPanel
              graph={effectiveGraph}
              value={entrySpec}
              onChange={handleEntrySpecChange}
              onDuplicate={handleEntryDuplicate}
              lastError={reanalyze.lastError}
              busy={isReanalyzing}
              apiClient={apiClient}
              projectId={projectId}
            />
            <FiltersPanel
              graph={effectiveGraph}
              value={filterSpec}
              onChange={handleFilterChange}
              cy={cy}
            />
          </div>
        }
        rightRail={
          <div className="main-view__rail" data-testid="main-right-rail">
            <InfoPanel
              selectedNode={selectedNode}
              graph={effectiveGraph}
              onAddEntry={handleAddEntryFromInfo}
              onCopy={handleCopyResult}
            />
            {collapse.collapsedIds.size > 0 ? (
              <button
                type="button"
                className="main-view__expand-all"
                onClick={collapse.expandAll}
                data-testid="main-expand-all"
              >
                Expand all ({String(collapse.collapsedIds.size)} collapsed)
              </button>
            ) : null}
            <DeadCodePanel
              apiClient={apiClient}
              projectId={projectId}
              projectName={projectName}
              refreshKey={reportRefreshKey}
              cy={cy}
              graph={effectiveGraph}
              onSelectNode={handleSelectNode}
            />
            <ExportPanel
              cy={cy}
              projectName={projectName}
              backgroundColor={themeTokens.bg}
              onError={handleExportError}
            />
            <LegendPanel />
          </div>
        }
      >
        <GraphCanvas
          graph={effectiveGraph}
          theme={themeTokens}
          projectId={projectId}
          reducedMotion={reducedMotion}
          loading={state.status === 'loading' || isReanalyzing}
          onSelectNode={handleSelectNode}
          selectedNodeId={selectedNodeId}
          onCyReady={handleCyReady}
          layoutTrigger={layoutTrigger}
          onPinOverflow={handlePinOverflow}
        />
        <ContextMenu
          cy={cy}
          collapsedIds={collapse.collapsedIds}
          expandedPackages={aggregateExpand.expandedPackages}
          onShowInfo={handleSelectNode}
          onAddEntry={handleAddEntryFromInfo}
          onCollapse={collapse.collapse}
          onExpand={collapse.expand}
          onCollapsePackage={aggregateExpand.collapsePackage}
          onCopyPath={handleCopyResult}
          graph={effectiveGraph}
        />
        {isReanalyzing ? (
          <div className="main-view__reanalyze" data-testid="main-reanalyze-overlay">
            re-analyzing
            {reanalyze.phase !== null ? `\u2026 ${reanalyze.phase}` : '\u2026'}
          </div>
        ) : null}
      </Layout>
    </section>
  );
}

/**
 * Read the live CSS theme tokens. Re-runs whenever `<html data-theme>`
 * changes so the Cytoscape stylesheet reacts to dark/light toggles within
 * the same render cycle (NFR-03 ≤ 100 ms response budget).
 */
function useThemeTokens(resolvedTheme: 'light' | 'dark'): ThemeTokens {
  const [tokens, setTokens] = useState<ThemeTokens>(() => readThemeTokens());
  useEffect(() => {
    setTokens(readThemeTokens());
  }, [resolvedTheme]);
  useEffect(() => {
    const root = document.documentElement;
    if (typeof MutationObserver === 'undefined') {
      return undefined;
    }
    const observer = new MutationObserver(() => {
      setTokens(readThemeTokens());
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      observer.disconnect();
    };
  }, []);
  return tokens;
}

/** Mirror of `prefers-reduced-motion` for the canvas. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    function onChange(evt: MediaQueryListEvent): void {
      setReduced(evt.matches);
    }
    mq.addEventListener('change', onChange);
    return () => {
      mq.removeEventListener('change', onChange);
    };
  }, []);
  return reduced;
}

/**
 * Hardening read for the persisted entry-point spec. Mirrors the shape of
 * `EntryPointSpec` and falls back to defaults when fields are missing or
 * malformed so a corrupted localStorage value never crashes the panel.
 */
function normalizeEntrySpec(input: unknown): EntryPointSpec {
  const base: EntryPointSpec = {
    mode: DEFAULT_ENTRY_POINT_SPEC.mode,
    auto_kinds: [...DEFAULT_ENTRY_POINT_SPEC.auto_kinds],
    manual: [...DEFAULT_ENTRY_POINT_SPEC.manual],
    interface_impl: [...DEFAULT_ENTRY_POINT_SPEC.interface_impl],
  };
  if (input === null || typeof input !== 'object') {
    return base;
  }
  const obj = input as Partial<EntryPointSpec> & Record<string, unknown>;
  if (obj.mode === 'auto' || obj.mode === 'manual' || obj.mode === 'mixed') {
    base.mode = obj.mode;
  }
  if (Array.isArray(obj.auto_kinds)) {
    base.auto_kinds = obj.auto_kinds.filter((v): v is string => typeof v === 'string');
  }
  if (Array.isArray(obj.manual)) {
    base.manual = obj.manual.filter((v): v is string => typeof v === 'string');
  }
  if (Array.isArray(obj.interface_impl)) {
    base.interface_impl = obj.interface_impl.filter((v): v is string => typeof v === 'string');
  }
  return base;
}
