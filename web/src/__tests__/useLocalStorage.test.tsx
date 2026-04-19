import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';

import {
  useDebouncedLocalStorage,
  useLocalStorage,
} from '../storage/useLocalStorage';
import { projectKey } from '../storage/keys';

interface Item {
  count: number;
}

function Probe({ storageKey }: { storageKey: string }): JSX.Element {
  const [item, setItem] = useLocalStorage<Item>(storageKey, { count: 0 });
  return (
    <div>
      <span data-testid="value">{String(item.count)}</span>
      <button
        type="button"
        onClick={() => {
          setItem((prev) => ({ count: prev.count + 1 }));
        }}
      >
        inc
      </button>
    </div>
  );
}

function DebouncedProbe(): JSX.Element {
  const key = projectKey('pid', 'positions');
  const [item, setItem] = useDebouncedLocalStorage<{ x: number }>(key, { x: 0 }, 500);
  return (
    <div>
      <span data-testid="dvalue">{String(item.x)}</span>
      <button
        type="button"
        onClick={() => {
          setItem({ x: 7 });
        }}
      >
        set
      </button>
    </div>
  );
}

describe('useLocalStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns the initial value when storage is empty', () => {
    render(<Probe storageKey="go-viz:test:value" />);
    expect(screen.getByTestId('value')).toHaveTextContent('0');
  });

  it('round-trips writes through localStorage', async () => {
    const user = userEvent.setup();
    render(<Probe storageKey="go-viz:test:value" />);
    await user.click(screen.getByRole('button', { name: 'inc' }));
    expect(screen.getByTestId('value')).toHaveTextContent('1');
    expect(window.localStorage.getItem('go-viz:test:value')).toBe(
      JSON.stringify({ count: 1 }),
    );
  });

  it('hydrates from a pre-existing localStorage value', () => {
    window.localStorage.setItem('go-viz:test:value', JSON.stringify({ count: 42 }));
    render(<Probe storageKey="go-viz:test:value" />);
    expect(screen.getByTestId('value')).toHaveTextContent('42');
  });

  it('updates when another tab writes to the same key', () => {
    render(<Probe storageKey="go-viz:test:value" />);
    act(() => {
      window.localStorage.setItem('go-viz:test:value', JSON.stringify({ count: 11 }));
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'go-viz:test:value',
          newValue: JSON.stringify({ count: 11 }),
        }),
      );
    });
    expect(screen.getByTestId('value')).toHaveTextContent('11');
  });

  it('falls back to initial when malformed JSON is in storage', () => {
    window.localStorage.setItem('go-viz:test:value', 'not json');
    render(<Probe storageKey="go-viz:test:value" />);
    expect(screen.getByTestId('value')).toHaveTextContent('0');
  });
});

describe('useDebouncedLocalStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it('updates the in-memory value immediately but defers the write', () => {
    render(<DebouncedProbe />);
    fireEvent.click(screen.getByRole('button', { name: 'set' }));
    expect(screen.getByTestId('dvalue')).toHaveTextContent('7');
    expect(window.localStorage.getItem(projectKey('pid', 'positions'))).toBeNull();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(window.localStorage.getItem(projectKey('pid', 'positions'))).toBe(
      JSON.stringify({ x: 7 }),
    );
  });
});
