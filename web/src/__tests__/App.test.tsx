import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from '../app/App';

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('App', () => {
  it('renders the landing screen by default', () => {
    render(<App />);
    expect(screen.getByTestId('screen-landing')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('app-shell-top-bar')).getByRole('heading', { level: 1 }),
    ).toHaveTextContent('Go Dependencies Visualizer');
  });

  it('switches to the analyzing screen via the top-bar Analyzing button', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Analyzing' }));
    expect(screen.getByTestId('screen-analyzing')).toBeInTheDocument();
  });

  it('renders the 3-column main layout when navigating to main', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Main' }));
    expect(screen.getByTestId('layout-left-rail')).toBeInTheDocument();
    expect(screen.getByTestId('layout-main')).toBeInTheDocument();
    expect(screen.getByTestId('layout-right-rail')).toBeInTheDocument();
  });
});
