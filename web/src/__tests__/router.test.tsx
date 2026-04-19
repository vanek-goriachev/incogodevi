import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';

import { RouteSwitch, Router, useRouter } from '../app/Router';

function Nav(): JSX.Element {
  const { route, navigate } = useRouter();
  return (
    <div>
      <span data-testid="current">{route}</span>
      <button type="button" onClick={() => navigate('analyzing')}>
        analyzing
      </button>
      <button type="button" onClick={() => navigate('main')}>
        main
      </button>
      <button type="button" onClick={() => navigate('error')}>
        error
      </button>
    </div>
  );
}

describe('Router', () => {
  it('starts on the initial route and renders the matching screen', () => {
    render(
      <Router initialRoute="landing">
        <Nav />
        <RouteSwitch
          routes={{
            landing: <div data-testid="landing-screen">landing</div>,
            analyzing: <div data-testid="analyzing-screen">analyzing</div>,
            main: <div data-testid="main-screen">main</div>,
          }}
        />
      </Router>,
    );
    expect(screen.getByTestId('current')).toHaveTextContent('landing');
    expect(screen.getByTestId('landing-screen')).toBeInTheDocument();
  });

  it('switches the rendered screen when navigate is called', async () => {
    const user = userEvent.setup();
    render(
      <Router initialRoute="landing">
        <Nav />
        <RouteSwitch
          routes={{
            landing: <div data-testid="landing-screen">landing</div>,
            analyzing: <div data-testid="analyzing-screen">analyzing</div>,
            main: <div data-testid="main-screen">main</div>,
          }}
        />
      </Router>,
    );
    await user.click(screen.getByRole('button', { name: 'analyzing' }));
    expect(screen.getByTestId('current')).toHaveTextContent('analyzing');
    expect(screen.getByTestId('analyzing-screen')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'main' }));
    expect(screen.getByTestId('main-screen')).toBeInTheDocument();
  });

  it('renders fallback when no route element is registered', async () => {
    const user = userEvent.setup();
    render(
      <Router initialRoute="landing">
        <Nav />
        <RouteSwitch
          routes={{ landing: <div data-testid="landing-screen">landing</div> }}
          fallback={<div data-testid="fallback">fallback</div>}
        />
      </Router>,
    );
    await user.click(screen.getByRole('button', { name: 'error' }));
    expect(screen.getByTestId('fallback')).toBeInTheDocument();
  });
});
