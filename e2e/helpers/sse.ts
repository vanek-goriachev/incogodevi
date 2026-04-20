import type { Page } from '@playwright/test';

/**
 * Wait until the SPA leaves the Analyzing screen and lands on the Main view.
 * The Main view rendering (after `done`) is the user-visible signal that the
 * SSE stream completed and the graph payload was applied.
 */
export async function waitForAnalysisDone(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.waitForSelector('[data-testid="screen-main"]', { timeout: timeoutMs });
}

/**
 * Wait until the Cytoscape canvas reports at least one rendered node. The SPA
 * exposes the live graph instance on `window.__cy` for testing.
 */
export async function waitForGraphReady(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const cy = (window as unknown as { __cy?: { nodes: () => { length: number } } }).__cy;
      return cy !== undefined && cy.nodes().length > 0;
    },
    null,
    { timeout: timeoutMs },
  );
}

/**
 * Snapshot the basic state of the current Cytoscape graph for assertions.
 */
export async function readGraphStats(
  page: Page,
): Promise<{ nodes: number; edges: number; reachable: number; dead: number }> {
  return await page.evaluate(() => {
    type CyNode = { data: (k: string) => unknown };
    type CyApi = {
      nodes: () => { length: number; toArray: () => CyNode[] };
      edges: () => { length: number };
    };
    const cy = (window as unknown as { __cy?: CyApi }).__cy;
    if (cy === undefined) {
      return { nodes: 0, edges: 0, reachable: 0, dead: 0 };
    }
    const arr = cy.nodes().toArray();
    let reachable = 0;
    let dead = 0;
    for (const n of arr) {
      const r = n.data('reachable');
      if (r === true) {
        reachable += 1;
      } else if (r === false) {
        dead += 1;
      }
    }
    return {
      nodes: cy.nodes().length,
      edges: cy.edges().length,
      reachable,
      dead,
    };
  });
}
