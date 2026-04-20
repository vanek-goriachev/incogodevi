/**
 * Component tests for the top-bar dead-mode segmented control.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type JSX } from 'react';

import { DeadModeSwitcher } from '../pages/Main/DeadModeSwitcher';
import {
  DEAD_MODE_ORDER,
  DEFAULT_DEAD_MODE,
  type DeadMode,
} from '../pages/Main/useDeadMode';

interface HarnessProps {
  initial?: DeadMode;
  onChangeSpy?: (next: DeadMode) => void;
}

function Harness({ initial = DEFAULT_DEAD_MODE, onChangeSpy }: HarnessProps): JSX.Element {
  const [mode, setMode] = useState<DeadMode>(initial);
  return (
    <DeadModeSwitcher
      value={mode}
      onChange={(next) => {
        setMode(next);
        onChangeSpy?.(next);
      }}
    />
  );
}

describe('<DeadModeSwitcher />', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all three options as radios', () => {
    render(<Harness />);
    const group = screen.getByTestId('dead-mode-switcher');
    expect(group).toHaveAttribute('role', 'radiogroup');
    for (const m of DEAD_MODE_ORDER) {
      expect(screen.getByTestId(`dead-mode-option-${m}`)).toBeInTheDocument();
    }
  });

  it('marks the active option with aria-checked', () => {
    render(<Harness initial="dead-only" />);
    const active = screen.getByTestId('dead-mode-option-dead-only');
    expect(active).toHaveAttribute('aria-checked', 'true');
    expect(active.className).toContain('dead-mode-switcher__option--active');
  });

  it('reports onChange when a non-active option is clicked', async () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    await userEvent.click(screen.getByTestId('dead-mode-option-live-only'));
    expect(spy).toHaveBeenCalledWith('live-only');
  });

  it('does not fire onChange when clicking the already-active option', async () => {
    const spy = vi.fn();
    render(<Harness initial="live-only" onChangeSpy={spy} />);
    await userEvent.click(screen.getByTestId('dead-mode-option-live-only'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('cycles through modes when the d hotkey is pressed', () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    fireEvent.keyDown(window, { key: 'd' });
    expect(spy).toHaveBeenLastCalledWith('dead-only');
    fireEvent.keyDown(window, { key: 'd' });
    expect(spy).toHaveBeenLastCalledWith('live-only');
    fireEvent.keyDown(window, { key: 'd' });
    expect(spy).toHaveBeenLastCalledWith('live-dead');
  });

  it('ignores the d hotkey when modifier keys are held', () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    fireEvent.keyDown(window, { key: 'd', altKey: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores the d hotkey while typing into a text input', () => {
    const spy = vi.fn();
    render(
      <div>
        <input type="text" data-testid="text-input" />
        <Harness onChangeSpy={spy} />
      </div>,
    );
    const input = screen.getByTestId('text-input') as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: 'd' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('reacts to the uppercase D as well', () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    fireEvent.keyDown(window, { key: 'D' });
    expect(spy).toHaveBeenCalledWith('dead-only');
  });
});
