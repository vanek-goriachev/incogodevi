import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the application title', () => {
    render(<App />);
    expect(
      screen.getByRole('heading', { level: 1, name: /Go Dependencies Visualizer/i }),
    ).toBeInTheDocument();
  });

  it('exposes the check API button as the first focusable control', async () => {
    const user = userEvent.setup();
    render(<App />);
    const button = screen.getByRole('button', { name: /check API/i });
    expect(button).toBeInTheDocument();
    await user.tab();
    expect(button).toHaveFocus();
  });

  it('renders OK status when the health endpoint responds successfully', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(
      new Response('ok', { status: 200, statusText: 'OK' }),
    );

    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /check API/i }));

    await waitFor(() => {
      expect(screen.getByTestId('health-status')).toHaveTextContent(/OK: ok/);
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/healthz', expect.any(Object));
  });
});
