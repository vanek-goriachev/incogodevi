/**
 * R9 verification spec — confirms the remaining R9 change after super-groups
 * were reverted:
 *
 *   Issue 1 — "Hide external packages" toggles ON by default. On real Go
 *             projects (Xray-core has 521 external nodes vs 172 local) the
 *             previous default left the canvas dominated by stdlib +
 *             third-party imports, so the user's own structure was invisible.
 *             Also covers the topology-bridge race fix in `MainView`: the
 *             filter hook must re-apply once the graph topology lands, not
 *             just when the spec itself changes. If externals stay visible
 *             after the first paint the race bridge has regressed.
 *
 * (Issue 2 — `internal/<subdir>` super-groups — was reverted because empty
 * dashed boxes were rendering next to overlapping package hairballs.)
 *
 * Screenshots are written to /tmp/r9-screenshots so the human reviewer can
 * audit the fix without re-running the suite.
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uploadFixture } from '../helpers/upload';
import { waitForAnalysisDone, waitForGraphReady } from '../helpers/sse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const screenshotDir = '/tmp/r9-screenshots';
fs.mkdirSync(screenshotDir, { recursive: true });

async function shot(page: Page, label: string): Promise<void> {
  await page.screenshot({
    path: path.join(screenshotDir, `${label}.png`),
    fullPage: true,
  });
}

async function uploadXray(page: Page): Promise<void> {
  const xrayPath = path.join(repoRoot, 'demo', 'Xray-core-main.zip');
  if (!fs.existsSync(xrayPath)) {
    throw new Error(`Xray-core fixture not found at ${xrayPath}`);
  }
  await page.goto('/');
  await page.waitForSelector('[data-testid="screen-landing"]', { timeout: 30_000 });
  // Make sure no stale per-project filter spec from a previous run forces
  // hideExternal back to false — the new default only takes effect when no
  // value is persisted under the project key.
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.locator('[data-testid="landing-file-input"]').setInputFiles(xrayPath);
  await page.waitForSelector('[data-testid="screen-analyzing"]', { timeout: 30_000 });
}

test.describe('R9 fixes verification', () => {
  test.setTimeout(600_000);

  test('Issue 1 on Xray-core', async ({ page }, testInfo) => {
    page.on('console', (msg) => {
      console.log(`[browser:${msg.type()}] ${msg.text()}`);
    });

    await uploadXray(page);
    await waitForAnalysisDone(page, 300_000);
    await waitForGraphReady(page, 60_000);
    await expect(page.locator('[data-testid="screen-main"]')).toBeVisible();

    // ---- Issue 1: "Hide external packages" checked by default ----
    // The toggle is rendered via a label whose checkbox carries the
    // `aria-label="Hide external packages"`. Asserting via the input element
    // gives us the actual `checked` state regardless of CSS styling.
    const hideExternalCheckbox = page.locator('[data-testid="filters-hide-external"] input[type="checkbox"]');
    await expect(hideExternalCheckbox).toBeChecked();
    const hideExternalState = await hideExternalCheckbox.evaluate(
      (el) => (el as HTMLInputElement).checked,
    );
    console.log(`[R9 Issue 1] hideExternal default checked = ${String(hideExternalState)}`);
    expect(hideExternalState).toBe(true);

    // Topology-bridge race fix: external nodes should be marked .hidden on
    // the live cy core after the first paint, not merely after a user toggle.
    const externalVisibility = await page.evaluate(() => {
      type CyNode = { data: (k: string) => unknown; hasClass: (c: string) => boolean; visible: () => boolean };
      type CyApi = { nodes: () => { length: number; toArray: () => CyNode[] } };
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      if (cy === undefined) {
        return { external: 0, externalHidden: 0, externalVisible: 0 };
      }
      const arr = cy.nodes().toArray();
      let external = 0;
      let externalHidden = 0;
      let externalVisible = 0;
      for (const n of arr) {
        if (n.data('external') === true) {
          external += 1;
          if (n.hasClass('hidden')) {
            externalHidden += 1;
          }
          if (n.visible()) {
            externalVisible += 1;
          }
        }
      }
      return { external, externalHidden, externalVisible };
    });
    console.log(`[R9 Issue 1] external visibility on first paint: ${JSON.stringify(externalVisibility)}`);
    expect(externalVisibility.external).toBeGreaterThan(0);
    // Every external node should carry the .hidden class.
    expect(externalVisibility.externalHidden).toBe(externalVisibility.external);
    // And nothing external should be visible to Cytoscape.
    expect(externalVisibility.externalVisible).toBe(0);

    await shot(page, 'r9-xray-externals-hidden');

    console.log(`[R9] Xray run done project=${testInfo.project.name}`);
  });

  test('hideExternal default on the simple fixture', async ({ page }, testInfo) => {
    page.on('console', (msg) => {
      console.log(`[browser:${msg.type()}] ${msg.text()}`);
    });

    // Clear localStorage so a previous run cannot pin hideExternal=false.
    await page.goto('/');
    await page.evaluate(() => {
      window.localStorage.clear();
    });

    await uploadFixture(page, 'simple');
    await waitForAnalysisDone(page, 60_000);
    await waitForGraphReady(page, 30_000);

    // Issue 1 still applies: the toggle is checked even on a tiny fixture.
    const hideExternalCheckbox = page.locator('[data-testid="filters-hide-external"] input[type="checkbox"]');
    await expect(hideExternalCheckbox).toBeChecked();

    await shot(page, 'r9-simple');
    console.log(`[R9] simple run done project=${testInfo.project.name}`);
  });
});
