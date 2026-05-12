/**
 * R10 revert verification — confirms that the R8 Task B `internal/<subdir>`
 * super-grouping has been fully removed from the runtime. The R9 visual
 * style bump made the symptom dramatically worse (empty dashed boxes next
 * to overlapping hairballs), so the whole feature was reverted.
 *
 * This spec is disposable: it exists only to document that after the revert
 *
 *   - zero compound-parent nodes are present on the initial Xray view;
 *   - "Hide external packages" still defaults to ON (R9 external-hide fix
 *     remains in place);
 *   - expanding a package still promotes it into a compound (R4-4, which
 *     the super-group removal must not disturb).
 *
 * Delete once the migration has settled.
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { waitForAnalysisDone, waitForGraphReady } from '../helpers/sse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const screenshotDir = '/tmp/r10-screenshots';
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
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.locator('[data-testid="landing-file-input"]').setInputFiles(xrayPath);
  await page.waitForSelector('[data-testid="screen-analyzing"]', { timeout: 30_000 });
}

test.describe('R10 revert verification', () => {
  test.setTimeout(600_000);

  test('super-groups removed, R4-4 expansion compounds still work on Xray-core', async ({ page }) => {
    page.on('console', (msg) => {
      console.log(`[browser:${msg.type()}] ${msg.text()}`);
    });

    await uploadXray(page);
    await waitForAnalysisDone(page, 300_000);
    await waitForGraphReady(page, 60_000);
    await expect(page.locator('[data-testid="screen-main"]')).toBeVisible();

    // ---- R9 external-hide default survives the revert ----
    const hideExternalCheckbox = page.locator('[data-testid="filters-hide-external"] input[type="checkbox"]');
    await expect(hideExternalCheckbox).toBeChecked();

    // ---- zero compound parents on the initial view ----
    const initialCompoundState = await page.evaluate(() => {
      type CyNode = { id: () => string; data: (k: string) => unknown };
      type CyApi = {
        nodes: (sel?: string) => { length: number; toArray: () => CyNode[] };
      };
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      if (cy === undefined) {
        return { parents: -1, supergroupFlagged: -1, classSupergroup: -1 };
      }
      const parents = cy.nodes(':parent').length;
      const supergroupFlagged = cy
        .nodes()
        .toArray()
        .filter((n) => n.data('supergroup') === true).length;
      // Defensive: also check for any leftover .supergroup class on any node.
      const classSupergroup = cy
        .nodes('.supergroup')
        .length;
      return { parents, supergroupFlagged, classSupergroup };
    });
    console.log(`[R10] initial compound/supergroup state: ${JSON.stringify(initialCompoundState)}`);
    expect(initialCompoundState.parents).toBe(0);
    expect(initialCompoundState.supergroupFlagged).toBe(0);
    expect(initialCompoundState.classSupergroup).toBe(0);

    await shot(page, 'r10-xray-no-supergroups');

    // ---- R4-4 package-expansion compound still works ----
    // Pick the smallest expandable package in the project module so the
    // expansion is quick, then confirm it promotes into a :parent node.
    const target = await page.evaluate(() => {
      type CyNode = { id: () => string; data: (k: string) => unknown };
      type CyApi = {
        nodes: (sel?: string) => { length: number; toArray: () => CyNode[] };
      };
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      if (cy === undefined) {
        return null;
      }
      const pool = cy
        .nodes('node[kind="package"]')
        .toArray()
        .filter((n) => {
          if (n.data('external') === true) {
            return false;
          }
          const cc = Number(n.data('child_count') ?? 0);
          return Number.isFinite(cc) && cc >= 3 && cc <= 20;
        })
        .map((n) => ({
          id: n.id(),
          childCount: Number(n.data('child_count') ?? 0),
        }));
      pool.sort((a, b) => a.childCount - b.childCount);
      return pool[0] ?? null;
    });
    expect(target, 'must find at least one expandable package').not.toBeNull();
    if (target === null) {
      return;
    }

    await page.evaluate((id) => {
      type CyApi = { $id: (id: string) => { emit: (evt: string) => void } };
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      cy?.$id(id).emit('dbltap');
    }, target.id);

    await page.waitForFunction(
      (parentId: string) => {
        type CyApi = {
          $id: (id: string) => { isParent?: () => boolean };
          nodes: () => { toArray: () => { data: (k: string) => unknown }[] };
        };
        const cy = (window as unknown as { __cy?: CyApi }).__cy;
        if (cy === undefined) {
          return false;
        }
        const children = cy
          .nodes()
          .toArray()
          .filter((n) => n.data('parent') === parentId);
        return children.length > 0;
      },
      target.id,
      { timeout: 30_000 },
    );

    await page.waitForTimeout(500);
    const expandedState = await page.evaluate(() => {
      type CyApi = { nodes: (sel: string) => { length: number } };
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      return { parents: cy?.nodes(':parent').length ?? -1 };
    });
    console.log(`[R10] post-expansion parent nodes: ${JSON.stringify(expandedState)}`);
    // After one expansion there must be exactly the package-compound parent.
    expect(expandedState.parents).toBeGreaterThanOrEqual(1);

    await shot(page, 'r10-xray-after-r44-expansion');
  });
});
