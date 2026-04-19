/**
 * Application-level error boundary.
 *
 * Wraps the rest of the app so an unhandled exception in any subtree shows
 * the "Connection lost / Application error" panel from `docs/design.md` §3.4
 * instead of crashing the whole SPA (NFR-09). Recovery options:
 *  - **Retry** — reset the boundary and re-render its children.
 *  - **Back to landing** — call the optional `onReset` callback (the Router
 *    uses this to navigate to the landing screen).
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Called when the user clicks "Back to landing". */
  onReset?: () => void;
  /** Called once whenever a new error is caught (for telemetry / logging). */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (this.props.onError !== undefined) {
      this.props.onError(error, info);
    } else {
      // Surface to devtools so the failure is not swallowed silently in dev.
      console.error('Unhandled error caught by ErrorBoundary:', error, info);
    }
  }

  private readonly handleRetry = (): void => {
    this.setState({ error: null });
  };

  private readonly handleBackToLanding = (): void => {
    this.setState({ error: null });
    if (this.props.onReset !== undefined) {
      this.props.onReset();
    }
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    return (
      <div className="error-screen" role="alert" data-testid="error-boundary-fallback">
        <h2 className="error-screen__title">Application error</h2>
        <p className="error-screen__lead">
          Something went wrong while rendering the page. Your local data (entry
          points, filters and node positions) is kept in this browser.
        </p>
        <pre className="error-screen__detail" data-testid="error-boundary-message">
          {error.message}
        </pre>
        <div className="error-screen__actions">
          <button type="button" onClick={this.handleRetry}>
            Retry
          </button>
          <button type="button" onClick={this.handleBackToLanding}>
            Back to landing
          </button>
        </div>
      </div>
    );
  }
}
