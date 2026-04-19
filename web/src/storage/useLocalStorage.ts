/**
 * React hooks for typed localStorage access with multi-tab synchronization.
 *
 * `useLocalStorage` is the general-purpose hook for small JSON values.
 * `usePositionsStorage` is a thin wrapper that debounces writes to 500 ms
 * because `positions` is updated on every Cytoscape drag event (design.md §8).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type Setter<T> = (next: T | ((prev: T) => T)) => void;

/**
 * Read/write a JSON-serializable value at `key`. Reacts to `storage` events
 * from other tabs/windows (StorageEvent), so the displayed state stays in sync.
 */
export function useLocalStorage<T>(key: string, initial: T): [T, Setter<T>] {
  const [value, setValue] = useState<T>(() => readJson<T>(key, initial));

  // Track the latest key so the storage listener compares against current.
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    setValue(readJson<T>(key, initial));
    // `initial` intentionally omitted: re-running on each `initial` reference
    // change would clobber user edits. Reset only on key change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    function onStorage(evt: StorageEvent): void {
      // `storageArea` is supplied by the browser for cross-tab events. In
      // tests we synthesise a `StorageEvent` that may omit it; fall through
      // to the key check rather than dropping such events.
      if (evt.storageArea !== null && evt.storageArea !== window.localStorage) {
        return;
      }
      if (evt.key !== keyRef.current) {
        return;
      }
      if (evt.newValue === null) {
        setValue(initial);
        return;
      }
      try {
        setValue(JSON.parse(evt.newValue) as T);
      } catch {
        // Ignore malformed values from other tabs — they were not written by us.
      }
    }
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
    // `initial` intentionally omitted (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set: Setter<T> = useCallback(
    (next) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        try {
          window.localStorage.setItem(keyRef.current, JSON.stringify(resolved));
        } catch {
          // Quota exceeded or storage disabled — keep state in memory only.
        }
        return resolved;
      });
    },
    [],
  );

  return [value, set];
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Debounced writer for high-frequency updates (e.g. node positions). */
export function useDebouncedLocalStorage<T>(
  key: string,
  initial: T,
  delayMs = 500,
): [T, Setter<T>] {
  const [value, setValue] = useState<T>(() => readJson<T>(key, initial));
  const pendingRef = useRef<T | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        if (pendingRef.current !== null) {
          try {
            window.localStorage.setItem(keyRef.current, JSON.stringify(pendingRef.current));
          } catch {
            // ignore — best-effort flush
          }
        }
      }
    };
  }, []);

  const set: Setter<T> = useCallback(
    (next) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        pendingRef.current = resolved;
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => {
          try {
            window.localStorage.setItem(keyRef.current, JSON.stringify(resolved));
          } catch {
            // ignore — see useLocalStorage
          }
          timerRef.current = null;
          pendingRef.current = null;
        }, delayMs);
        return resolved;
      });
    },
    [delayMs],
  );

  return [value, set];
}
