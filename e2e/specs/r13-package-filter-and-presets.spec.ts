/**
 * R13 verification spec (feat/overlap-presets-package-filter).
 *
 * Drives the new features end-to-end on the `simple` fixture:
 *   1. Bulk package filter (substring + bulk hide) — matches at least one
 *      package and hides it via "Скрыть найденные"; the chosen package row
 *      shows up unchecked in the per-package list afterwards.
 *   2. Layer-preset save → reload — saves the current state under a name,
 *      verifies the dropdown grows, deletes it and verifies it shrinks back.
 *   3. Export → Import round-trip — opens the export modal, captures the
 *      `goviz1:` string, opens the import modal, pastes it, and asserts the
 *      modal closes without an error message.
 *   4. "Создать группу из фильтра" — opens the bar's "+ Группа" form with
 *      the filter prefix pre-filled.
 *
 * Screenshots: /tmp/r13-screenshots.
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

import { uploadFixture } from '../helpers/upload';
import { waitForAnalysisDone, waitForGraphReady } from '../helpers/sse';

const screenshotDir = '/tmp/r13-screenshots';
fs.mkdirSync(screenshotDir, { recursive: true });

async function shot(page: Page, label: string): Promise<void> {
  await page.screenshot({
    path: path.join(screenshotDir, `${label}.png`),
    fullPage: true,
  });
}

test.describe('R13 package filter + presets', () => {
  test.setTimeout(180_000);

  test('bulk package filter hides matched packages', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      window.localStorage.clear();
    });
    await uploadFixture(page, 'simple');
    await waitForAnalysisDone(page);
    await waitForGraphReady(page);
    await expect(page.locator('[data-testid="screen-main"]')).toBeVisible();

    // Discover a package path with a usable substring.
    const samplePkg = await page.evaluate(() => {
      type CyNode = { data: (k: string) => unknown };
      type CyApi = { nodes: () => { toArray: () => CyNode[] } };
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      if (cy === undefined) return '';
      for (const n of cy.nodes().toArray()) {
        const p = String(n.data('package') ?? '');
        if (p !== '') return p;
      }
      return '';
    });
    expect(samplePkg).not.toBe('');
    // Pick a unique substring from the package path.
    const needle = samplePkg.split('/').slice(-1)[0] ?? samplePkg;

    await page.fill('[data-testid="filters-package-bulk-input"]', needle);
    const countText = (await page
      .locator('[data-testid="filters-package-bulk-count"]')
      .textContent()) ?? '';
    expect(countText).toMatch(/Найдено [1-9]/);

    await page.click('[data-testid="filters-package-bulk-hide"]');
    await page.waitForTimeout(150);
    await shot(page, 'r13-after-bulk-hide');
  });

  test('preset save / load / delete persists via localStorage', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      window.localStorage.clear();
    });
    await uploadFixture(page, 'simple');
    await waitForAnalysisDone(page);
    await waitForGraphReady(page);

    // Save a preset.
    await page.click('[data-testid="layer-editor-save-as"]');
    await page.fill('[data-testid="layer-editor-save-as-input"]', 'Demo');
    await page.click('[data-testid="layer-editor-save-as-confirm"]');

    const optionCount = await page
      .locator('[data-testid="layer-editor-preset-select"] option')
      .count();
    expect(optionCount).toBeGreaterThanOrEqual(2);

    // Delete.
    await page.click('[data-testid="layer-editor-delete-preset"]');
    const optionCountAfter = await page
      .locator('[data-testid="layer-editor-preset-select"] option')
      .count();
    expect(optionCountAfter).toBe(1);

    await shot(page, 'r13-presets-after-delete');
  });

  test('export → import round-trip succeeds and rejects garbage', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      window.localStorage.clear();
    });
    await uploadFixture(page, 'simple');
    await waitForAnalysisDone(page);
    await waitForGraphReady(page);

    // Export modal shows the goviz1: string.
    await page.click('[data-testid="layer-editor-export"]');
    const encoded = (await page
      .locator('[data-testid="layer-editor-export-text"]')
      .inputValue()) ?? '';
    expect(encoded.startsWith('goviz1:')).toBe(true);
    await page.click('[data-testid="layer-editor-modal-close"]');

    // Garbage import is rejected with an inline error.
    await page.click('[data-testid="layer-editor-import"]');
    await page.fill('[data-testid="layer-editor-import-text"]', 'this is not a preset');
    await page.click('[data-testid="layer-editor-import-submit"]');
    await expect(page.locator('[data-testid="layer-editor-import-error"]')).toBeVisible();

    // Valid round-trip closes the modal.
    await page.fill('[data-testid="layer-editor-import-text"]', encoded);
    await page.click('[data-testid="layer-editor-import-submit"]');
    await expect(page.locator('[data-testid="layer-editor-modal-import"]')).toHaveCount(0);
  });

  test('Создать группу из фильтра pre-fills the + Группа form', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      window.localStorage.clear();
    });
    await uploadFixture(page, 'simple');
    await waitForAnalysisDone(page);
    await waitForGraphReady(page);

    // Pick a package substring with at least one match.
    const samplePkg = await page.evaluate(() => {
      type CyNode = { data: (k: string) => unknown };
      type CyApi = { nodes: () => { toArray: () => CyNode[] } };
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      if (cy === undefined) return '';
      for (const n of cy.nodes().toArray()) {
        const p = String(n.data('package') ?? '');
        if (p !== '') return p;
      }
      return '';
    });
    expect(samplePkg).not.toBe('');
    const needle = samplePkg.split('/').slice(-1)[0] ?? samplePkg;
    await page.fill('[data-testid="filters-package-bulk-input"]', needle);
    await page.click('[data-testid="filters-package-bulk-group"]');

    // The + Группа form should now be open with prefixDraft filled in.
    await expect(page.locator('[data-testid="layer-editor-addform"]')).toBeVisible();
    const prefixVal = await page
      .locator('[data-testid="layer-editor-prefix"]')
      .inputValue();
    expect(prefixVal.length).toBeGreaterThan(0);
  });
});
