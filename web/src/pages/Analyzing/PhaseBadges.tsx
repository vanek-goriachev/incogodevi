/**
 * Phase badge row for the Analyzing screen (design.md §3.2 wireframe).
 *
 * Renders one badge per phase in `ANALYSIS_PHASES`. The badge for the
 * currently-running phase shows a bullet plus the integer percent from
 * `progress`; finished phases get a check; pending phases stay muted.
 *
 * `data-state` is exposed on each badge so end-to-end tests can assert the
 * full row state without depending on glyphs that may change with the design.
 */

import type { JSX } from 'react';

import type { AnalysisPhase } from '../../api/types';
import { ANALYZING_STRINGS } from '../../i18n/en';
import { ANALYSIS_PHASES } from './useAnalysis';

export interface PhaseBadgesProps {
  /** Current phase from the latest `phase` event (or `failed`). */
  phase: AnalysisPhase;
  /** 0..1 progress fraction shown next to the active badge. */
  progress: number;
  /** Disables transitions when `prefers-reduced-motion` is set. */
  reducedMotion?: boolean;
}

type BadgeState = 'done' | 'current' | 'pending';

export function PhaseBadges({
  phase,
  progress,
  reducedMotion = false,
}: PhaseBadgesProps): JSX.Element {
  const currentIndex = phaseIndex(phase);
  const className = [
    'analyzing__phases',
    reducedMotion ? 'analyzing__phases--reduced-motion' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <ol
      className={className}
      data-testid="analyzing-phases"
      aria-label="Analysis phases"
    >
      {ANALYSIS_PHASES.map((p, idx) => {
        const state = computeState(idx, currentIndex, phase);
        return (
          <li
            key={p}
            className={`analyzing__phase analyzing__phase--${state}`}
            data-testid={`analyzing-phase-${p}`}
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="analyzing__phase-glyph" aria-hidden="true">
              {glyphFor(state)}
            </span>
            <span className="analyzing__phase-label">{labelFor(p)}</span>
            {state === 'current' && p !== 'done' ? (
              <span
                className="analyzing__phase-progress"
                data-testid={`analyzing-progress-${p}`}
              >
                {Math.round(clamp01(progress) * 100)}%
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function computeState(
  index: number,
  currentIndex: number,
  phase: AnalysisPhase,
): BadgeState {
  if (phase === 'failed') {
    // Mark every phase as pending — the fallback UI takes over the headline.
    return index < currentIndex ? 'done' : 'pending';
  }
  if (index < currentIndex) {
    return 'done';
  }
  if (index === currentIndex) {
    return 'current';
  }
  return 'pending';
}

function phaseIndex(phase: AnalysisPhase): number {
  if (phase === 'failed') {
    return -1;
  }
  const idx = ANALYSIS_PHASES.indexOf(phase);
  return idx >= 0 ? idx : 0;
}

function labelFor(phase: AnalysisPhase): string {
  return ANALYZING_STRINGS.phaseLabels[phase];
}

function glyphFor(state: BadgeState): string {
  switch (state) {
    case 'done':
      return 'OK';
    case 'current':
      return '*';
    case 'pending':
      return '-';
  }
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
