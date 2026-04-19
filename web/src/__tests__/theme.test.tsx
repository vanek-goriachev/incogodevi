import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';

import { ThemeProvider, useTheme } from '../app/theme';
import { THEME_KEY } from '../storage/keys';

interface MediaState {
  prefersDark: boolean;
  reducedMotion: boolean;
}

function installMatchMedia(state: MediaState): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      const matches =
        query.includes('prefers-color-scheme: dark')
          ? state.prefersDark
          : query.includes('prefers-reduced-motion: reduce')
            ? state.reducedMotion
            : false;
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    },
  });
}

function ThemeProbe(): JSX.Element {
  const { theme, resolved, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="probe-theme">{theme}</span>
      <span data-testid="probe-resolved">{resolved}</span>
      <button type="button" onClick={() => setTheme('dark')}>
        dark
      </button>
      <button type="button" onClick={() => setTheme('light')}>
        light
      </button>
      <button type="button" onClick={() => setTheme('auto')}>
        auto
      </button>
    </div>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-choice');
    document.documentElement.removeAttribute('data-reduced-motion');
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('resolves auto to dark when prefers-color-scheme is dark', () => {
    installMatchMedia({ prefersDark: true, reducedMotion: false });
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('probe-theme')).toHaveTextContent('auto');
    expect(screen.getByTestId('probe-resolved')).toHaveTextContent('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('resolves auto to light when prefers-color-scheme is light', () => {
    installMatchMedia({ prefersDark: false, reducedMotion: false });
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('probe-resolved')).toHaveTextContent('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('persists explicit override and applies it', async () => {
    installMatchMedia({ prefersDark: false, reducedMotion: false });
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'dark' }));
    expect(screen.getByTestId('probe-resolved')).toHaveTextContent('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('"dark"');
  });

  it('reads stored theme on mount', () => {
    window.localStorage.setItem(THEME_KEY, '"dark"');
    installMatchMedia({ prefersDark: false, reducedMotion: false });
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('probe-theme')).toHaveTextContent('dark');
    expect(screen.getByTestId('probe-resolved')).toHaveTextContent('dark');
  });

  it('marks <html> with data-reduced-motion when the user prefers reduced motion', () => {
    installMatchMedia({ prefersDark: false, reducedMotion: true });
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(true);
  });

  it('updates when another tab writes a new theme', () => {
    installMatchMedia({ prefersDark: false, reducedMotion: false });
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    act(() => {
      window.localStorage.setItem(THEME_KEY, '"dark"');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: THEME_KEY,
          newValue: '"dark"',
        }),
      );
    });
    expect(screen.getByTestId('probe-resolved')).toHaveTextContent('dark');
  });
});
