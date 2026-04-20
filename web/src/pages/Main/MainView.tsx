/**
 * Main screen — three-column layout from `docs/design.md` §3.3 with the
 * Cytoscape canvas in the middle and placeholder rails on either side.
 *
 * Side rails are intentionally minimal in T20: T21 fills the left rail with
 * the filters panel, T22 adds the entry-points + info panels, T23 adds the
 * dead-code report, T24 adds export actions.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import type { ApiClient } from '../../api/client';
import { Layout } from '../../app/Layout';
import { useRouter } from '../../app/Router';
import { useToast } from '../../app/Toasts';
import { useTheme } from '../../app/theme';
import { ANALYSIS_ERROR_MESSAGES } from '../../i18n/en';
import { GraphCanvas } from './GraphCanvas';
import { readThemeTokens, type ThemeTokens } from './graph-styles';
import { useGraphData } from './useGraphData';

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

  // Reset selection on project change so the right-rail placeholder does not
  // dangle on a stale id.
  useEffect(() => {
    setSelectedNodeId(null);
  }, [projectId]);

  // Surface the load failure as a single toast so the user is not left
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

  const handleSelectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id);
  }, []);

  const stats = state.graph?.stats;
  const headline = useMemo(() => {
    if (stats === undefined) {
      return projectName !== '' ? projectName : 'Project';
    }
    const dead = stats.dead_count ?? 0;
    return `${projectName !== '' ? projectName : 'Project'} \u00b7 ${String(stats.node_count)} nodes \u00b7 ${String(dead)} dead`;
  }, [projectName, stats]);

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
            <button
              type="button"
              className="main-view__refresh"
              onClick={refresh}
              data-testid="main-refresh"
              aria-label="Refresh graph"
            >
              {'\u21bb refresh'}
            </button>
          </div>
        }
        leftRail={
          <div className="main-view__rail" data-testid="main-left-rail">
            <h3 className="main-view__rail-title">Entry points</h3>
            <p className="main-view__rail-hint">Configured in T21\u2013T22.</p>
            <h3 className="main-view__rail-title">Filters</h3>
            <p className="main-view__rail-hint">Filter panel arrives in T21.</p>
          </div>
        }
        rightRail={
          <div className="main-view__rail" data-testid="main-right-rail">
            <h3 className="main-view__rail-title">Info</h3>
            <p className="main-view__rail-hint" data-testid="main-info-placeholder">
              {selectedNodeId !== null && selectedNodeId !== ''
                ? `Selected node: ${selectedNodeId}`
                : 'Select a node to see details.'}
            </p>
            <h3 className="main-view__rail-title">Dead code</h3>
            <p className="main-view__rail-hint">Report tab arrives in T23.</p>
          </div>
        }
      >
        <GraphCanvas
          graph={state.graph}
          theme={themeTokens}
          projectId={projectId}
          reducedMotion={reducedMotion}
          loading={state.status === 'loading'}
          onSelectNode={handleSelectNode}
          selectedNodeId={selectedNodeId}
        />
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
  // Watch the `data-theme` attribute too so external changes (cross-tab,
  // OS preference flip) propagate without depending on context updates.
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
