/**
 * Theme provider — applies `data-theme` to `<html>` and respects system
 * preferences (`prefers-color-scheme`, `prefers-reduced-motion`).
 *
 * Schema in `docs/design.md` §5.5 / §8: `light | dark | auto`. Persisted in
 * `localStorage` as `go-viz:theme`. Initial paint synchronously reads the
 * stored value to avoid a flash of the wrong theme.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';

import { THEME_KEY } from '../storage/keys';

export type ThemeChoice = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  /** User's preference (may be `'auto'`). */
  theme: ThemeChoice;
  /** Concrete theme actually applied right now. */
  resolved: ResolvedTheme;
  setTheme: (next: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const VALID_CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'auto'];

function readStoredChoice(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    if (raw === null) {
      return 'auto';
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'string' && VALID_CHOICES.includes(parsed as ThemeChoice)) {
      return parsed as ThemeChoice;
    }
    return 'auto';
  } catch {
    return 'auto';
  }
}

function systemPrefersDark(): boolean {
  if (typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function systemPrefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === 'auto') {
    return prefersDark ? 'dark' : 'light';
  }
  return choice;
}

export interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps): JSX.Element {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStoredChoice());
  const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());
  const [reducedMotion, setReducedMotion] = useState<boolean>(() =>
    systemPrefersReducedMotion(),
  );

  // Subscribe to system preference changes so `auto` follows the OS setting.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onDark = (evt: MediaQueryListEvent): void => {
      setPrefersDark(evt.matches);
    };
    const onMotion = (evt: MediaQueryListEvent): void => {
      setReducedMotion(evt.matches);
    };
    dark.addEventListener('change', onDark);
    motion.addEventListener('change', onMotion);
    return () => {
      dark.removeEventListener('change', onDark);
      motion.removeEventListener('change', onMotion);
    };
  }, []);

  const resolved = resolveTheme(choice, prefersDark);

  // Apply attributes to <html> so CSS variables in tokens.css can switch.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.setAttribute('data-theme-choice', choice);
    root.toggleAttribute('data-reduced-motion', reducedMotion);
  }, [resolved, choice, reducedMotion]);

  const setTheme = useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      window.localStorage.setItem(THEME_KEY, JSON.stringify(next));
    } catch {
      // Storage disabled — keep choice in memory only.
    }
  }, []);

  // Cross-tab sync: another tab changed the theme → mirror it.
  useEffect(() => {
    function onStorage(evt: StorageEvent): void {
      if (evt.key !== THEME_KEY) {
        return;
      }
      if (evt.storageArea !== null && evt.storageArea !== window.localStorage) {
        return;
      }
      setChoice(readStoredChoice());
    }
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme: choice, resolved, setTheme }),
    [choice, resolved, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Read theme state inside the provider tree. Throws when used outside. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}
