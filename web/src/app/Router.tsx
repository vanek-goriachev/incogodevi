/**
 * State-based router for the SPA.
 *
 * MVP scope (T17): four named screens, no URL deep-linking. We deliberately
 * avoid pulling in `react-router` to keep the shell bundle small (task T17
 * AC: ≤ 200 KB gzip). Navigation is exposed through React Context so any
 * component can call `navigate('main')`.
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

export interface RouterApi {
  route: Route;
  navigate: (next: Route) => void;
}

const RouterContext = createContext<RouterApi | null>(null);

export interface RouterProps {
  children: ReactNode;
  /** Initial screen on mount. Defaults to `'landing'`. */
  initialRoute?: Route;
}

export function Router({ children, initialRoute = 'landing' }: RouterProps): JSX.Element {
  const [route, setRoute] = useState<Route>(initialRoute);
  const navigate = useCallback((next: Route) => {
    setRoute(next);
  }, []);
  const value = useMemo<RouterApi>(() => ({ route, navigate }), [route, navigate]);
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
