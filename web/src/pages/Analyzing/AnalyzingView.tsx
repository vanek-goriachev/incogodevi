/**
 * Analyzing screen — drives the SSE stream from `useAnalysis`, renders the
 * phase badge row, an overall progress bar, surfaces warnings as toasts and
 * navigates to the Main view when the run reports `done`.
 *
 * Layout follows `docs/design.md` §3.2: header line, phase badges, faint
 * progress bar, optional Cancel button (after 3 s in the current phase), and
 * a fallback panel for the failed / cancelled outcomes.
 */

import { useEffect, useRef, useState, type JSX } from 'react';

import type { ApiClient } from '../../api/client';
import { useRouter } from '../../app/Router';
import { useToast } from '../../app/Toasts';
import { ANALYSIS_ERROR_MESSAGES, ANALYZING_STRINGS } from '../../i18n/en';
import { CancelButton } from './CancelButton';
import { PhaseBadges } from './PhaseBadges';
import { useAnalysis, type AnalysisWarning } from './useAnalysis';

export interface AnalyzingViewProps {
  apiClient: ApiClient;
  /** Override the cancel-button delay (tests pass `0`). */
  cancelDelayMs?: number;
  /** Override the partial-graph throttle (tests pass `0`). */
  partialThrottleMs?: number;
}

export function AnalyzingView({
  apiClient,
  cancelDelayMs,
  partialThrottleMs,
}: AnalyzingViewProps): JSX.Element {
  const { state: routeState, navigate } = useRouter();
  const projectId = routeState.projectId;
  const projectName = routeState.projectName ?? '';
  const reducedMotion = usePrefersReducedMotion();
  const { showToast } = useToast();

  const onComplete = (): void => {
    if (projectId === undefined) {
      return;
    }
    navigate(
      'main',
      projectName !== '' ? { projectId, projectName } : { projectId },
    );
  };
  const analysis = useAnalysis(
    partialThrottleMs === undefined
      ? { apiClient, projectId, onComplete }
      : { apiClient, projectId, partialThrottleMs, onComplete },
  );

  // Surface each warning as a single amber toast (design.md §3.2). We track
  // the last seen seq so React StrictMode's double-invoke does not duplicate
  // toasts and so the loop is O(new warnings) rather than O(all).
  const lastWarningSeqRef = useRef(-1);
  useEffect(() => {
    for (const w of analysis.state.warnings) {
      if (w.seq <= lastWarningSeqRef.current) {
        continue;
      }
      lastWarningSeqRef.current = w.seq;
      showToast(formatWarning(w), 'warning');
    }
  }, [analysis.state.warnings, showToast]);

  // Reset the warning-seq watermark on every fresh run so retry surfaces the
  // new analysis's warnings.
  useEffect(() => {
    lastWarningSeqRef.current = -1;
  }, [analysis.state.runId]);

  if (projectId === undefined || projectId === '') {
    return <NoProjectFallback onBack={() => { navigate('landing'); }} />;
  }

  if (analysis.state.status === 'failed') {
    return (
      <FailureFallback
        projectName={projectName}
        code={analysis.state.error?.code ?? 'internal'}
        message={analysis.state.error?.message ?? 'analysis failed'}
        onRetry={analysis.retry}
        onBack={() => { navigate('landing'); }}
      />
    );
  }

  if (analysis.state.status === 'cancelled') {
    return (
      <CancelledFallback
        projectName={projectName}
        onRetry={analysis.retry}
        onBack={() => { navigate('landing'); }}
      />
    );
  }

  const progressPercent = Math.round(analysis.state.progress * 100);

  return (
    <section
      className="screen screen--analyzing analyzing"
      data-testid="screen-analyzing"
      data-status={analysis.state.status}
    >
      <header className="analyzing__header">
        <h2 className="analyzing__heading" data-testid="analyzing-project-name">
          {projectName !== '' ? projectName : ANALYZING_STRINGS.heading}
        </h2>
        <small
          className="analyzing__sub"
          data-testid="analyzing-graph-size"
        >
          {analysis.state.graphSize.nodes} nodes · {analysis.state.graphSize.edges} edges
        </small>
      </header>
      <PhaseBadges
        phase={analysis.state.phase}
        progress={analysis.state.progress}
        reducedMotion={reducedMotion}
      />
      <div
        className="analyzing__progress"
        role="progressbar"
        aria-label={ANALYZING_STRINGS.progressLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent}
        data-testid="analyzing-progress"
      >
        <div
          className="analyzing__progress-bar"
          style={{ width: `${String(progressPercent)}%` }}
        />
      </div>
      {analysis.state.message !== null ? (
        <p className="analyzing__message" data-testid="analyzing-message">
          {analysis.state.message}
        </p>
      ) : null}
      <footer className="analyzing__footer">
        {cancelDelayMs === undefined ? (
          <CancelButton
            phase={analysis.state.phase}
            runId={analysis.state.runId}
            onCancel={analysis.cancel}
          />
        ) : (
          <CancelButton
            phase={analysis.state.phase}
            runId={analysis.state.runId}
            onCancel={analysis.cancel}
            delayMs={cancelDelayMs}
          />
        )}
        <small className="analyzing__hint" data-testid="analyzing-cancel-hint">
          {ANALYZING_STRINGS.cancelHint}
        </small>
      </footer>
    </section>
  );
}

interface NoProjectProps {
  onBack: () => void;
}

function NoProjectFallback({ onBack }: NoProjectProps): JSX.Element {
  return (
    <section className="screen screen--analyzing" data-testid="screen-analyzing">
      <h2>{ANALYZING_STRINGS.heading}</h2>
      <p data-testid="analyzing-empty">{ANALYZING_STRINGS.noProject}</p>
      <div className="screen__actions">
        <button type="button" onClick={onBack}>
          {ANALYZING_STRINGS.backToLanding}
        </button>
      </div>
    </section>
  );
}

interface FailureFallbackProps {
  projectName: string;
  code: string;
  message: string;
  onRetry: () => void;
  onBack: () => void;
}

function FailureFallback({
  projectName,
  code,
  message,
  onRetry,
  onBack,
}: FailureFallbackProps): JSX.Element {
  const friendly = ANALYSIS_ERROR_MESSAGES[code] ?? message;
  return (
    <section
      className="screen screen--analyzing analyzing analyzing--failed"
      data-testid="screen-analyzing"
      data-status="failed"
      role="alert"
    >
      <h2 className="analyzing__heading">{ANALYZING_STRINGS.failed}</h2>
      {projectName !== '' ? (
        <p className="analyzing__sub">{projectName}</p>
      ) : null}
      <p
        className="analyzing__error"
        data-testid="analyzing-error"
        data-error-code={code}
      >
        {friendly}
      </p>
      <div className="screen__actions">
        <button
          type="button"
          onClick={onRetry}
          data-testid="analyzing-retry"
        >
          {ANALYZING_STRINGS.retry}
        </button>
        <button
          type="button"
          onClick={onBack}
          data-testid="analyzing-back"
        >
          {ANALYZING_STRINGS.backToLanding}
        </button>
      </div>
    </section>
  );
}

interface CancelledFallbackProps {
  projectName: string;
  onRetry: () => void;
  onBack: () => void;
}

function CancelledFallback({
  projectName,
  onRetry,
  onBack,
}: CancelledFallbackProps): JSX.Element {
  return (
    <section
      className="screen screen--analyzing analyzing analyzing--cancelled"
      data-testid="screen-analyzing"
      data-status="cancelled"
      role="status"
    >
      <h2 className="analyzing__heading">{ANALYZING_STRINGS.cancelled}</h2>
      {projectName !== '' ? (
        <p className="analyzing__sub">{projectName}</p>
      ) : null}
      <div className="screen__actions">
        <button
          type="button"
          onClick={onRetry}
          data-testid="analyzing-retry"
        >
          {ANALYZING_STRINGS.retry}
        </button>
        <button type="button" onClick={onBack} data-testid="analyzing-back">
          {ANALYZING_STRINGS.backToLanding}
        </button>
      </div>
    </section>
  );
}

function formatWarning(w: AnalysisWarning): string {
  return ANALYZING_STRINGS.warningToast(w.code, w.message);
}

/**
 * `prefers-reduced-motion` predicate as a hook. Returns `false` in
 * environments without `matchMedia` (notably jsdom), which keeps tests
 * deterministic without explicit setup.
 */
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
