import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom 29 + vitest 4 expose `window.localStorage` as a host object whose
// prototype lacks `getItem`/`setItem`/`removeItem`/`clear`/`key`. Install a
// minimal in-memory replacement so component code that uses the standard
// Storage API works in tests. The same shim is also applied to sessionStorage
// so future tests do not trip over the same bug.
function installStorageShim(target: 'localStorage' | 'sessionStorage'): void {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    key(index: number) {
      const keys = Array.from(store.keys());
      return index < keys.length ? (keys[index] as string) : null;
    },
  };
  Object.defineProperty(window, target, {
    configurable: true,
    writable: true,
    value: shim,
  });
}

beforeEach(() => {
  installStorageShim('localStorage');
  installStorageShim('sessionStorage');
});

afterEach(() => {
  cleanup();
});
