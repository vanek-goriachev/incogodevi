import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type JSX } from 'react';

import { ErrorBoundary } from '../app/ErrorBoundary';

function Boom({ shouldThrow }: { shouldThrow: boolean }): JSX.Element {
  if (shouldThrow) {
    throw new Error('boom');
  }
  return <span data-testid="ok">ok</span>;
}

function Harness(): JSX.Element {
  const [fail, setFail] = useState(true);
  return (
    <ErrorBoundary>
      <button
        type="button"
        onClick={() => {
          setFail(false);
        }}
      >
        fix
      </button>
      <Boom shouldThrow={fail} />
    </ErrorBoundary>
  );
}

describe('ErrorBoundary', () => {
  it('renders the fallback when a child throws', () => {
    const onError = vi.fn();
    // React 19 still logs to console.error on render-time exceptions even
    // when caught — silence to keep test output readable.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary onError={onError}>
        <Boom shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();
    expect(screen.getByTestId('error-boundary-message')).toHaveTextContent('boom');
    expect(onError).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('ok')).toBeInTheDocument();
  });

  it('clears the error when the user clicks Retry', async () => {
    const user = userEvent.setup();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function ResettableHarness(): JSX.Element {
      const [fail, setFail] = useState(true);
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              setFail(false);
            }}
          >
            fix
          </button>
          <ErrorBoundary>
            <Boom shouldThrow={fail} />
          </ErrorBoundary>
        </div>
      );
    }
    render(<ResettableHarness />);
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'fix' }));
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByTestId('ok')).toBeInTheDocument();
    consoleSpy.mockRestore();
  });

  it('invokes onReset when the user clicks Back to landing', async () => {
    const user = userEvent.setup();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReset = vi.fn();
    render(
      <ErrorBoundary onReset={onReset}>
        <Boom shouldThrow={true} />
      </ErrorBoundary>,
    );
    await user.click(screen.getByRole('button', { name: 'Back to landing' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
    // Suppress unused-variable warning if Harness is not used elsewhere.
    void Harness;
  });
});
