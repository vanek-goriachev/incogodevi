/**
 * Top-bar segmented control for the dead-code display mode (design.md §5.3).
 *
 * Renders three radio-like buttons — `Live only`, `Live + dead`, `Dead only`
 * — and lets the user cycle them with the `d` hotkey. The actual class
 * toggling on Cytoscape is performed by `useDeadMode`; this component is
 * purely presentational and reports `onChange` upwards.
 */

import { useEffect, type JSX } from 'react';

import {
  DEAD_MODE_ORDER,
  type DeadMode,
} from './useDeadMode';

/** Human label for each mode. */
const LABELS: Readonly<Record<DeadMode, string>> = {
  'live-only': 'Live only',
  'live-dead': 'Live + dead',
  'dead-only': 'Dead only',
};

/** Long description used as the button title attribute. */
const HINTS: Readonly<Record<DeadMode, string>> = {
  'live-only': 'Hide unreachable nodes (architecture demo)',
  'live-dead': 'Show everything; dead nodes faded (default)',
  'dead-only': 'Hide reachable nodes (audit dead code)',
};

export interface DeadModeSwitcherProps {
  /** Currently active mode (controlled). */
  value: DeadMode;
  /** Invoked when the user picks a new mode (button click or `d` hotkey). */
  onChange: (next: DeadMode) => void;
  /**
   * Element id surfaced to screen readers; defaults to a stable string but
   * can be overridden if the same component appears twice on the page.
   */
  id?: string;
}

/**
 * The hotkey is wired at the document level so the user can press `d` even
 * while the Cytoscape canvas (which steals keyboard focus) is the active
 * element. Standard text inputs short-circuit the handler so typing the
 * letter into a search field does not accidentally cycle modes.
 */
export function DeadModeSwitcher({
  value,
  onChange,
  id = 'dead-mode-switcher',
}: DeadModeSwitcherProps): JSX.Element {
  useEffect(() => {
    function handleKey(evt: KeyboardEvent): void {
      if (evt.key !== 'd' && evt.key !== 'D') {
        return;
      }
      if (evt.ctrlKey || evt.metaKey || evt.altKey) {
        return;
      }
      const target = evt.target;
      if (target instanceof HTMLElement && isTypingInto(target)) {
        return;
      }
      evt.preventDefault();
      const idx = DEAD_MODE_ORDER.indexOf(value);
      const next = DEAD_MODE_ORDER[(idx + 1) % DEAD_MODE_ORDER.length] ?? value;
      onChange(next);
    }
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [value, onChange]);

  return (
    <div
      className="dead-mode-switcher"
      role="radiogroup"
      aria-label="Dead-code display mode"
      data-testid="dead-mode-switcher"
      id={id}
    >
      {DEAD_MODE_ORDER.map((m) => {
        const active = m === value;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={LABELS[m]}
            title={HINTS[m]}
            className={
              active
                ? 'dead-mode-switcher__option dead-mode-switcher__option--active'
                : 'dead-mode-switcher__option'
            }
            data-testid={`dead-mode-option-${m}`}
            onClick={() => {
              if (!active) {
                onChange(m);
              }
            }}
          >
            {LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}

/** True when the target element is a text input that should consume `d`. */
function isTypingInto(target: HTMLElement): boolean {
  const tag = target.tagName;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    // Checkboxes / radios / buttons should not block the hotkey.
    if (type === 'checkbox' || type === 'radio' || type === 'button') {
      return false;
    }
    return true;
  }
  if (tag === 'TEXTAREA') {
    return true;
  }
  return target.isContentEditable;
}
