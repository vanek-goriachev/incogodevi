import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadFixture } from '../helpers/upload';
import { readGraphStats, waitForAnalysisDone, waitForGraphReady } from '../helpers/sse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.resolve(__dirname, '..', '..', 'test-evidence', 'T26', 'screenshots');

/**
 * J1 — first upload (happy path).
 *
 * Steps mirror docs/design.md §2 J1: open landing, drop a ZIP, watch the
 * Analyzing screen run through phases, end up on the Main view with a graph
 * containing both reachable and dead nodes.
 */
test.describe('J1 — first upload happy path', () => {
  test('uploads simple fixture, reaches done, renders graph with dead-code', async ({
    page,
  }, testInfo) => {
    page.on('console', (msg) => {
      console.log(`[browser:${msg.type()}] ${msg.text()}`);
    });
    await uploadFixture(page, 'simple');
    console.log('upload posted, waiting for analyzing screen');
    await page.waitForSelector('[data-testid="screen-analyzing"]', { timeout: 30_000 });
    await waitForAnalysisDone(page);
    console.log('analysis done, waiting for graph ready');
    await waitForGraphReady(page);
    console.log('graph ready');

    await expect(page.locator('[data-testid="screen-main"]')).toBeVisible();
    await expect(page.locator('[data-testid="graph-canvas"]')).toBeVisible();

    const stats = await readGraphStats(page);
    console.log(`stats: ${JSON.stringify(stats)}`);
    expect(stats.nodes).toBeGreaterThan(0);
    expect(stats.reachable).toBeGreaterThan(0);
    expect(stats.dead).toBeGreaterThan(0);

    const screenshotPath = path.join(
      evidenceDir,
      `j1-final-${testInfo.project.name}.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
  });
});
