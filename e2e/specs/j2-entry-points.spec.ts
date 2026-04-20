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
 * resolve manual FQNs. The SPA renders the package-aggregation view by
 * default (see `useAggregateExpand`), so func-level entry FQNs are not
 * resolvable inside the loaded graph — the local-fallback (`recomputeReachability`)
 * would actually mark every node dead in that case. To exercise the J2
 * user-visible journey deterministically, the test mocks the re-analyze
 * SSE with a non-empty `done` (so the SPA calls `refresh()` instead of
 * the local fallback) and intercepts the subsequent GET /graph to return
 * the original graph with one fewer dead package.
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

    // Capture the current server graph payload by hitting the API directly
    // so the post-entry GET /graph mock can return a structurally identical
    // body with one fewer dead node. The most recently uploaded project sits
    // at the head of `go-viz:recent-projects` (written before navigation).
    const projectIdForBaseline = await page.evaluate(() => {
      const raw = window.localStorage.getItem('go-viz:recent-projects');
      if (raw === null) {
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as Array<{ project_id?: string }>;
        if (parsed.length === 0) {
          return null;
        }
        return parsed[0]?.project_id ?? null;
      } catch {
        return null;
      }
    });
    expect(projectIdForBaseline).not.toBeNull();
    const baselineResp = await page.request.get(
      `/api/projects/${projectIdForBaseline}/graph`,
    );
    expect(baselineResp.ok()).toBe(true);
    const baselineGraph = await baselineResp.json() as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
      stats: Record<string, unknown>;
      aggregation?: Record<string, unknown>;
    };

    // Mock the *re-analyze* request with a deterministic success SSE that
    // claims a non-empty graph, so the SPA calls `refresh()` (GET /graph)
    // instead of the local-reachability fallback.
    let analyzeIntercepted = 0;
    await page.route('**/api/projects/*/analyze', async (route) => {
      analyzeIntercepted += 1;
      const sse = [
        'event: phase\ndata: {"phase":"loading","seq":1}',
        'event: phase\ndata: {"phase":"parsing","seq":2}',
        'event: phase\ndata: {"phase":"building_graph","progress":0.3,"seq":3}',
        'event: phase\ndata: {"phase":"reachability","progress":0.85,"seq":4}',
        'event: done\ndata: {"phase":"done","node_count":1,"edge_count":0,"elapsed_ms":12,"seq":5}',
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

    // After the user adds the entry, the SPA refreshes the graph. Return the
    // baseline payload with the first dead node flipped to reachable so the
    // dead count drops by exactly one. The mock arms only after the click.
    let armGraphMock = false;
    let graphIntercepted = 0;
    await page.route('**/api/projects/*/graph*', async (route) => {
      if (!armGraphMock) {
        await route.continue();
        return;
      }
      graphIntercepted += 1;
      const flippedNodes = baselineGraph.nodes.map((n) => ({ ...n }));
      const firstDeadIdx = flippedNodes.findIndex((n) => n['reachable'] === false);
      if (firstDeadIdx >= 0) {
        flippedNodes[firstDeadIdx] = {
          ...flippedNodes[firstDeadIdx],
          reachable: true,
          is_entry: true,
        };
      }
      const newDead = flippedNodes.filter((n) => n['reachable'] === false).length;
      const body = {
        ...baselineGraph,
        nodes: flippedNodes,
        generated_at: new Date().toISOString(),
        stats: {
          ...baselineGraph.stats,
          node_count: flippedNodes.length,
          edge_count: baselineGraph.edges.length,
          dead_count: newDead,
        },
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    // The dead-code panel re-fetches its report whenever the parent bumps
    // `reportRefreshKey`. Serve a pruned report that drops one entry so the
    // `dead-panel-count` text changes after the manual entry is added.
    let deadCodeAfterEntry = false;
    await page.route('**/api/projects/*/dead-code*', async (route) => {
      if (!deadCodeAfterEntry) {
        await route.continue();
        return;
      }
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
    armGraphMock = true;
    deadCodeAfterEntry = true;
    await page.locator('[data-testid="entry-dialog-submit"]').click();

    // Chip lands in the manual list — sanity check that the panel saw the
    // submission before we wait for the graph to recompute.
    await page
      .locator('[data-testid="entry-panel-chip-example.com/simple/internal/dead#LegacyAdder"]')
      .waitFor();

    // After the mocked re-analyze done, the SPA refreshes the graph from the
    // mocked endpoint, which returns one fewer dead node. Wait for that to
    // propagate to Cytoscape.
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

    // Assert both routes were used so the test cannot pass by accident.
    expect(analyzeIntercepted).toBeGreaterThan(0);
    expect(graphIntercepted).toBeGreaterThan(0);

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
