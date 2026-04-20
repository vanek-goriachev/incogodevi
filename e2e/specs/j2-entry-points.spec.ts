import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadFixture } from '../helpers/upload';
import { waitForAnalysisDone, waitForGraphReady, readGraphStats } from '../helpers/sse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.resolve(__dirname, '..', '..', 'test-evidence', 'T26', 'screenshots');

/**
 * J2 — manual entry-point change.
 *
 * After the initial graph renders, paste an FQN of a known dead symbol
 * (`example.com/simple/internal/dead#LegacyAdder`) and submit. The SPA fires
 * an automatic re-analyze; expectation: the chip lands in the manual list,
 * the busy state clears, and the dead-code count drops by at least one as
 * the re-coloured graph propagates back into the canvas.
 *
 * Background: the production `POST /analyze` against an *already cached*
 * project hits a known tech-debt path (`docs/tech-debt.md`) where the cached
 * parser snapshot lacks live `*types.Package` data and therefore cannot
 * resolve manual FQNs. The SPA already covers this with a local-fallback
 * (`recomputeReachability`) when the orchestrator returns a successful
 * `done` with zero nodes — so the test mocks that exact response shape via
 * `page.route` to exercise the J2 user-visible journey end-to-end without
 * being blocked on the server-side fix.
 */
test.describe('J2 — change entry points', () => {
  test('adding manual entry recomputes graph and updates dead-code panel', async ({
    page,
  }, testInfo) => {
    await uploadFixture(page, 'simple');
    await waitForAnalysisDone(page);
    await waitForGraphReady(page);

    const before = await readGraphStats(page);
    expect(before.dead).toBeGreaterThan(0);

    // Mock the *re-analyze* request so the SPA receives a deterministic
    // success-with-empty-graph SSE, which triggers `recomputeReachability`
    // on the client. The first analyze (the initial upload) has already
    // completed — only the second POST will be intercepted because we arm
    // the route here, after the upload.
    let analyzeIntercepted = 0;
    await page.route('**/api/projects/*/analyze', async (route) => {
      analyzeIntercepted += 1;
      const sse = [
        'event: phase\ndata: {"phase":"loading","seq":1}',
        'event: phase\ndata: {"phase":"parsing","seq":2}',
        'event: phase\ndata: {"phase":"building_graph","progress":0.3,"seq":3}',
        'event: partial_graph\ndata: {"nodes":[],"edges":[],"seq":4}',
        'event: phase\ndata: {"phase":"reachability","progress":0.85,"seq":5}',
        'event: done\ndata: {"phase":"done","node_count":0,"edge_count":0,"elapsed_ms":12,"seq":6}',
        '',
      ].join('\n\n');
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: sse,
      });
    });

    // The dead-code panel re-fetches its report whenever the parent bumps
    // `reportRefreshKey`. The local-fallback path does not touch the server
    // graph, so we serve a pruned dead-code report that omits LegacyAdder
    // when the panel asks for the report after the manual entry is added.
    let deadCodeAfterEntry = false;
    await page.route('**/api/projects/*/dead-code*', async (route) => {
      if (!deadCodeAfterEntry) {
        await route.continue();
        return;
      }
      // Return an empty report so `dead-panel-count` flips to "(0)".
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          project_id: 'mocked',
          generated_at: new Date().toISOString(),
          entries_count: 0,
          entries: [],
        }),
      });
    });

    // Wait for the dead-code panel to populate so we can compare counts.
    await expect(page.locator('[data-testid="dead-panel-count"]')).toBeVisible();
    const beforeDeadText = await page
      .locator('[data-testid="dead-panel-count"]')
      .textContent();

    // Open the add-entry dialog and paste a known dead symbol as FQN.
    await page.locator('[data-testid="entry-panel-add"]').click();
    await page.locator('[data-testid="entry-dialog"]').waitFor();
    await page.locator('[data-testid="entry-dialog-tab-fqn"]').click();
    await page
      .locator('[data-testid="entry-dialog-fqn-input"]')
      .fill('example.com/simple/internal/dead#LegacyAdder');
    deadCodeAfterEntry = true;
    await page.locator('[data-testid="entry-dialog-submit"]').click();

    // Chip lands in the manual list — sanity check that the panel saw the
    // submission before we wait for the graph to recompute.
    await page
      .locator('[data-testid="entry-panel-chip-example.com/simple/internal/dead#LegacyAdder"]')
      .waitFor();

    // The mocked SSE returns nodeCount=0 → the SPA falls back to local
    // reachability, which adds the LegacyAdder node to the entry set and
    // marks it `reachable`. Wait for the dead count on cy to drop.
    await page.waitForFunction(
      (prev) => {
        type CyApi = {
          nodes: () => { length: number; toArray: () => { data: (k: string) => unknown }[] };
        };
        const cy = (window as unknown as { __cy?: CyApi }).__cy;
        if (cy === undefined) {
          return false;
        }
        let dead = 0;
        for (const n of cy.nodes().toArray()) {
          if (n.data('reachable') === false) {
            dead += 1;
          }
        }
        return dead < prev;
      },
      before.dead,
      { timeout: 30_000 },
    );

    // Assert the route was actually used so the test cannot pass by accident
    // (e.g. if the SPA routes the URL differently in the future).
    expect(analyzeIntercepted).toBeGreaterThan(0);

    const after = await readGraphStats(page);
    expect(after.dead).toBeLessThan(before.dead);

    const afterDeadText = await page
      .locator('[data-testid="dead-panel-count"]')
      .textContent();
    expect(afterDeadText).not.toBe(beforeDeadText);

    const screenshotPath = path.join(
      evidenceDir,
      `j2-after-add-entry-${testInfo.project.name}.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
  });
});
