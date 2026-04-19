/**
 * Accessible toast notification system.
 *
 * - Four levels: info / success / warning / error.
 * - Auto-dismiss after 5 s, click to dismiss earlier.
 * - Stack at top-right; container is `role="status" aria-live="polite"` so
 *   screen readers announce new entries without interrupting the user.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  message: string;
  level: ToastLevel;
}

export interface ToastApi {
  showToast: (message: string, level?: ToastLevel) => string;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_TIMEOUT_MS = 5000;

export interface ToastProviderProps {
  children: ReactNode;
  /** Override auto-dismiss delay (mostly used by tests). */
  autoDismissMs?: number;
}

export function ToastProvider({
  children,
  autoDismissMs = DEFAULT_TIMEOUT_MS,
}: ToastProviderProps): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Snapshot the current timers map so the cleanup callback does not depend
  // on a possibly-mutated `.current` after the provider unmounts.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((handle) => {
        clearTimeout(handle);
      });
      timers.clear();
    };
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (message: string, level: ToastLevel = 'info'): string => {
      const id = generateId();
      setToasts((prev) => [...prev, { id, message, level }]);
      const timer = setTimeout(() => {
        dismissToast(id);
      }, autoDismissMs);
      timersRef.current.set(id, timer);
      return id;
    },
    [autoDismissMs, dismissToast],
  );

  const api = useMemo<ToastApi>(
    () => ({ showToast, dismissToast }),
    [showToast, dismissToast],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

interface ViewportProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

function ToastViewport({ toasts, onDismiss }: ViewportProps): JSX.Element {
  return (
    <div
      className="toast-viewport"
      role="status"
      aria-live="polite"
      aria-atomic="false"
      data-testid="toast-viewport"
    >
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`toast toast--${toast.level}`}
          onClick={() => {
            onDismiss(toast.id);
          }}
          data-testid={`toast-${toast.level}`}
        >
          <span className="toast__level" aria-hidden="true">
            {iconFor(toast.level)}
          </span>
          <span className="toast__message">{toast.message}</span>
          <span className="visually-hidden"> (click to dismiss)</span>
        </button>
      ))}
    </div>
  );
}

function iconFor(level: ToastLevel): string {
  switch (level) {
    case 'info':
      return 'i';
    case 'success':
      return 'OK';
    case 'warning':
      return '!';
    case 'error':
      return 'X';
  }
}

let counter = 0;
function generateId(): string {
  counter += 1;
  return `toast-${String(Date.now())}-${String(counter)}`;
}

/** Read the toast API. Throws outside of `<ToastProvider>`. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return ctx;
}
