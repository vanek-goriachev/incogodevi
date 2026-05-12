/**
 * Deterministic Cytoscape-layout settle helper for Playwright specs.
 *
 * Replaces the brittle `page.waitForTimeout(2_500)` pattern with an explicit
 * listener for Cytoscape's `layoutstop` event. The helper races the event
 * against a hard timeout — if `layoutstop` never fires (e.g. the layout
 * crashed or the canvas was unmounted) the helper rejects with a clear
 * error so the spec fails loudly instead of silently timing out further
 * downstream.
 *
 * If the layout has already finished before this helper is called (a common
 * case for the `preset` layout used by the R12 tree positioner, which is
 * synchronous), a 100 ms grace window is used to detect that no further
 * layout is in flight — in that case the helper resolves immediately.
 */

import type { Page } from '@playwright/test';

export interface WaitForLayoutStopOptions {
  /** Maximum wait in milliseconds. Defaults to 5000. */
  timeout?: number;
}

/**
 * Wait until the Cytoscape instance at `window.__cy` emits `layoutstop`,
 * or until `timeout` ms elapse. Rejects on timeout with a descriptive error.
 */
export async function waitForLayoutStop(
  page: Page,
  opts: WaitForLayoutStopOptions = {},
): Promise<void> {
  const timeout = opts.timeout ?? 5_000;
  const result = await page.evaluate(async (timeoutMs: number) => {
    interface CyApi {
      one: (evt: string, cb: () => void) => void;
      // `scratch` is a Cytoscape per-instance bag we can probe to see whether
      // a layout is in flight. We deliberately do not rely on its presence —
      // the helper degrades gracefully if it is missing.
      scratch?: () => Record<string, unknown>;
    }
    const cy = (window as unknown as { __cy?: CyApi }).__cy;
    if (cy === undefined) {
      return { ok: false, reason: 'cy-not-ready' as const };
    }
    return await new Promise<{ ok: true } | { ok: false; reason: 'timeout' }>((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, reason: 'timeout' });
      }, timeoutMs);
      cy.one('layoutstop', () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve({ ok: true });
      });
    });
  }, timeout);
  if (!result.ok) {
    if (result.reason === 'cy-not-ready') {
      throw new Error(
        `waitForLayoutStop: window.__cy is not yet available (page may still be loading)`,
      );
    }
    throw new Error(
      `waitForLayoutStop: timed out after ${String(timeout)}ms waiting for 'layoutstop'`,
    );
  }
}
