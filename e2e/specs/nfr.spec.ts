import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { uploadFixture } from '../helpers/upload';
import { waitForAnalysisDone, waitForGraphReady } from '../helpers/sse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.resolve(__dirname, '..', '..', 'test-evidence', 'T26');
const logsDir = path.join(evidenceDir, 'logs');

async function appendLog(line: string): Promise<void> {
  await fs.mkdir(logsDir, { recursive: true });
  await fs.appendFile(path.join(logsDir, 'nfr-measurements.log'), `${line}\n`);
}

/**
 * NFR-02 — first paint of the graph after the SSE done event must complete in
 * ≤ 5000 ms. We measure from the moment the Main view mounts (by the
 * `screen-main` testid appearing) to the moment the Cytoscape canvas reports
 * its first non-zero node count.
 */
test.describe('NFR-02 — first render under 5s', () => {
  test('chromium and webkit both render the simple fixture in <= 5000 ms', async ({
    page,
  }, testInfo) => {
    await uploadFixture(page, 'simple');
    await page.waitForSelector('[data-testid="screen-main"]', { timeout: 60_000 });
    const t0 = await page.evaluate(() => performance.now());
    await waitForGraphReady(page, 30_000);
    const t1 = await page.evaluate(() => performance.now());
    const elapsed = Math.round(t1 - t0);
    await appendLog(
      `${new Date().toISOString()} NFR-02 ${testInfo.project.name} elapsed_ms=${String(elapsed)}`,
    );
    expect(elapsed, `first render took ${String(elapsed)} ms`).toBeLessThanOrEqual(5000);
  });
});

/**
 * NFR-03 — a filter toggle (`include kinds` checkbox) must update the graph
 * in less than 100 ms. We measure from `performance.now()` immediately before
 * the click to the next animation frame after the React update flushes.
 *
 * Cytoscape applies element show/hide synchronously inside React's commit
 * phase, so requestAnimationFrame is the right hook for first paint.
 */
test.describe('NFR-03 — filter toggle under 100 ms', () => {
  test('toggling a kind filter updates the graph in <= 100 ms', async ({
    page,
  }, testInfo) => {
    await uploadFixture(page, 'simple');
    await waitForAnalysisDone(page);
    await waitForGraphReady(page);

    // Pick a kind that has at least one node so the toggle has visible effect.
    const targetKind = await page.evaluate(() => {
      type CyApi = { nodes: () => { toArray: () => { data: (k: string) => unknown }[] } };
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      if (cy === undefined) {
        return null;
      }
      const kinds = new Set<string>();
      for (const n of cy.nodes().toArray()) {
        const k = n.data('kind');
        if (typeof k === 'string') {
          kinds.add(k);
        }
      }
      // Prefer 'method' or 'func' which simple-fixture is sure to have.
      for (const candidate of ['func', 'method', 'package']) {
        if (kinds.has(candidate)) {
          return candidate;
        }
      }
      return Array.from(kinds)[0] ?? null;
    });
    expect(targetKind).not.toBeNull();

    const checkbox = page
      .locator(`[data-testid="filters-kind-${targetKind ?? ''}"] input[type="checkbox"]`)
      .first();
    await expect(checkbox).toBeChecked();

    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const elapsed = await page.evaluate(async () => {
        const start = performance.now();
        return new Promise<number>((resolve) => {
          requestAnimationFrame(() => {
            resolve(performance.now() - start);
          });
        });
      });
      // Warm-up: kick a click to mutate state and measure RAF latency
      // including the React re-render.
      const before = performance.now();
      await checkbox.click({ force: true });
      const after = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const t = performance.now();
            requestAnimationFrame(() => {
              resolve(performance.now() - t);
            });
          }),
      );
      const total = Math.round((performance.now() - before) + after + elapsed);
      samples.push(total);
    }

    const median = samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    const max = Math.max(...samples);
    await appendLog(
      `${new Date().toISOString()} NFR-03 ${testInfo.project.name} samples_ms=[${samples.join(',')}] median_ms=${String(median)} max_ms=${String(max)}`,
    );
    expect(median, `median toggle took ${String(median)} ms`).toBeLessThan(100);
  });
});

/**
 * NFR-09 — UI survives a server-side error and recovers via Retry without a
 * full reload.
 *
 * Strategy: route all `/api/projects/*` GET requests for the dead-code report
 * to fail with HTTP 500 once. The DeadCodePanel must show the error fallback
 * with a working "Retry" button. After the route handler is updated to allow
 * the next request through, the Retry button restores the panel to its ready
 * state without reloading the page.
 */
test.describe('NFR-09 — UI survives a 500 on dead-code fetch', () => {
  test('error boundary in DeadCodePanel surfaces and Retry recovers', async ({
    page,
  }, testInfo) => {
    // Arm the route handler before the upload so the *first* dead-code fetch
    // already fails. After the panel surfaces the error fallback we disarm
    // the handler and click Retry — the panel must recover in place without
    // a full reload.
    let injectFailures = true;
    await page.route('**/api/projects/*/dead-code*', async (route) => {
      if (injectFailures) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'internal', message: 'forced failure for NFR-09 test' },
          }),
        });
        return;
      }
      await route.continue();
    });

    await uploadFixture(page, 'simple');
    await waitForAnalysisDone(page);
    await waitForGraphReady(page);

    // The panel must show the error fallback, but the rest of the page must
    // still be alive (graph + entry-points panel still rendered).
    await expect(page.locator('[data-testid="dead-panel-error"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="dead-panel-retry"]')).toBeVisible();
    await expect(page.locator('[data-testid="entry-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="graph-canvas"]')).toBeVisible();

    // Disarm the failure injection and click Retry — the panel must recover
    // without a full reload (no `page.reload()` in this test).
    injectFailures = false;
    await page.locator('[data-testid="dead-panel-retry"]').click();
    await expect(page.locator('[data-testid="dead-panel-list"]')).toBeVisible({
      timeout: 15_000,
    });

    await appendLog(
      `${new Date().toISOString()} NFR-09 ${testInfo.project.name} recovered=true`,
    );
  });
});
