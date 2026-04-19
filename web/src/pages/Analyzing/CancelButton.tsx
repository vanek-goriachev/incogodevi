/**
 * `CancelButton` — appears 3 s after the active phase last changed.
 *
 * design.md §3.2 explains the rationale: typical analyses finish in well
 * under 3 s, so always-visible Cancel is jittery noise. The button stays
 * hidden until the user has been waiting on the same phase long enough to
 * actually want it. The timer is reset on every new phase event so each
 * step gets its own grace window.
 *
 * Implementation note: tests can pass `delayMs={0}` to make the button
 * visible immediately, sidestepping fake timers.
 */

import { useEffect, useState, type JSX } from 'react';

import type { AnalysisPhase } from '../../api/types';
import { ANALYZING_STRINGS } from '../../i18n/en';

export interface CancelButtonProps {
  phase: AnalysisPhase;
  /** Run id from the analysis state — restart resets the visibility timer. */
  runId: number;
  onCancel: () => void;
  /** Override the default 3000 ms grace window (used by tests). */
  delayMs?: number;
}

const DEFAULT_DELAY_MS = 3000;

export function CancelButton({
  phase,
  runId,
  onCancel,
  delayMs = DEFAULT_DELAY_MS,
}: CancelButtonProps): JSX.Element | null {
  const [visible, setVisible] = useState(delayMs <= 0);

  // Reset on every phase change AND on every run restart, even if the new
  // phase happens to be the same name as before.
  useEffect(() => {
    if (delayMs <= 0) {
      setVisible(true);
      return undefined;
    }
    setVisible(false);
    const timer = setTimeout(() => {
      setVisible(true);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [phase, runId, delayMs]);

  if (!visible) {
    return null;
  }
  return (
    <button
      type="button"
      className="analyzing__cancel"
      data-testid="analyzing-cancel"
      onClick={onCancel}
    >
      {ANALYZING_STRINGS.cancel}
    </button>
  );
}
