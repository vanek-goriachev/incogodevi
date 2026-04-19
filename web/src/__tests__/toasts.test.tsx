import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { JSX } from 'react';

import { ToastProvider, useToast } from '../app/Toasts';

function ToastProbe(): JSX.Element {
  const { showToast } = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        showToast('hello world', 'success');
      }}
    >
      fire
    </button>
  );
}

describe('ToastProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('renders a toast on showToast and exposes role=status viewport', () => {
    render(
      <ToastProvider autoDismissMs={5000}>
        <ToastProbe />
      </ToastProvider>,
    );
    const viewport = screen.getByTestId('toast-viewport');
    expect(viewport).toHaveAttribute('role', 'status');
    expect(viewport).toHaveAttribute('aria-live', 'polite');

    fireEvent.click(screen.getByRole('button', { name: 'fire' }));
    expect(screen.getByTestId('toast-success')).toHaveTextContent('hello world');
  });

  it('auto-dismisses after the configured timeout', () => {
    render(
      <ToastProvider autoDismissMs={5000}>
        <ToastProbe />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'fire' }));
    expect(screen.getByTestId('toast-success')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByTestId('toast-success')).toBeNull();
  });

  it('dismisses on click before the timeout fires', () => {
    render(
      <ToastProvider autoDismissMs={5000}>
        <ToastProbe />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'fire' }));
    const toast = screen.getByTestId('toast-success');
    fireEvent.click(toast);
    expect(screen.queryByTestId('toast-success')).toBeNull();
  });
});
