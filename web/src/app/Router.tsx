/**
 * State-based router for the SPA.
 *
 * MVP scope (T17): four named screens, no URL deep-linking. We deliberately
 * avoid pulling in `react-router` to keep the shell bundle small (task T17
 * AC: ≤ 200 KB gzip). Navigation is exposed through React Context so any
 * component can call `navigate('main')`.
 *
 * Optional per-navigation state (T18) carries the current `projectId` so that
 * the Analyzing and Main screens know which project the user just opened. The
 * value is held in memory only (no URL); reload returns the user to Landing.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';

export type Route = 'landing' | 'analyzing' | 'main' | 'error';

export const ROUTES: readonly Route[] = ['landing', 'analyzing', 'main', 'error'];

/** Per-navigation state attached by the caller of `navigate`. */
export interface RouteState {
  projectId?: string;
  projectName?: string;
}

export interface RouterApi {
  route: Route;
  state: RouteState;
  navigate: (next: Route, state?: RouteState) => void;
}

const RouterContext = createContext<RouterApi | null>(null);

export interface RouterProps {
  children: ReactNode;
  /** Initial screen on mount. Defaults to `'landing'`. */
  initialRoute?: Route;
  /** Initial route state, useful for tests and deep links from outside. */
  initialState?: RouteState;
}

export function Router({
  children,
  initialRoute = 'landing',
  initialState = {},
}: RouterProps): JSX.Element {
  const [route, setRoute] = useState<Route>(initialRoute);
  const [state, setState] = useState<RouteState>(initialState);
  const navigate = useCallback((next: Route, nextState: RouteState = {}) => {
    setRoute(next);
    setState(nextState);
  }, []);
  const value = useMemo<RouterApi>(
    () => ({ route, state, navigate }),
    [route, state, navigate],
  );
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

/** Read the current route and the `navigate` function. */
export function useRouter(): RouterApi {
  const ctx = useContext(RouterContext);
  if (ctx === null) {
    throw new Error('useRouter must be used inside <Router>');
  }
  return ctx;
}

export interface RouteSwitchProps {
  /** Map of route → element to render. Missing routes render `fallback`. */
  routes: Partial<Record<Route, ReactNode>>;
  fallback?: ReactNode;
}

/** Render the element matching the current route, or `fallback`. */
export function RouteSwitch({ routes, fallback = null }: RouteSwitchProps): ReactNode {
  const { route } = useRouter();
  return routes[route] ?? fallback;
}
