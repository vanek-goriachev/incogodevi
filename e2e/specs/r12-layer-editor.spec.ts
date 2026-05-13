/**
 * R12 Layer Editor verification spec.
 *
 * Drives Playwright through the new editor strip end-to-end:
 *   1. Upload a fixture and wait for the graph.
 *   2. Add a folder group whose prefix matches at least one package.
 *   3. Drag the folder lane chip to the leftmost slot.
 *   4. Assert at least one package node now has x === leftmost slot's x.
 *   5. Add two overlapping prefixes (`databases/` and `databases/postgres`)
 *      against synthetic nodes injected via the live cy core, then assert
 *      the longest-prefix-first rule decided which lane the deeper package
 *      landed in.
 *
 * Screenshots: /tmp/r12-screenshots.
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { uploadFixture } from '../helpers/upload';
import { waitForAnalysisDone, waitForGraphReady } from '../helpers/sse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotDir = '/tmp/r12-screenshots';
fs.mkdirSync(screenshotDir, { recursive: true });

async function shot(page: Page, label: string): Promise<void> {
  await page.screenshot({
    path: path.join(screenshotDir, `${label}.png`),
    fullPage: true,
  });
}

/**
 * Read all top-level (non-compound-child) node positions out of cy.
 */
async function readPositions(
  page: Page,
): Promise<Array<{ id: string; pkg: string; x: number; y: number }>> {
  return await page.evaluate(() => {
    type CyNode = {
      id: () => string;
      data: (k: string) => unknown;
      position: () => { x: number; y: number };
      isChild: () => boolean;
      parent: () => { length: number };
    };
    type CyApi = { nodes: () => { toArray: () => CyNode[] } };
    const cy = (window as unknown as { __cy?: CyApi }).__cy;
    if (cy === undefined) return [];
    return cy
      .nodes()
      .toArray()
      .filter((n) => !(n.isChild() && n.parent().length > 0))
      .map((n) => ({
        id: n.id(),
        pkg: String(n.data('package') ?? ''),
        x: n.position().x,
        y: n.position().y,
      }));
  });
}

/**
 * Simulate a native HTML5 drag-and-drop between two locators by directly
 * dispatching DOM events. Playwright's built-in `dragTo` works on most pages
 * but does not always populate `dataTransfer` for synthetic drag chips, so we
 * do the bookkeeping manually here. The chip's `onDragStart` reads the
 * laneKey from `dataTransfer.setData`, and the slot's `onDrop` reads it back.
 */
async function dragChipToSlot(page: Page, chipKey: string, slotIndex: number): Promise<void> {
  await page.evaluate(
    ({ chipKey, slotIndex }: { chipKey: string; slotIndex: number }) => {
      const chip = document.querySelector(`[data-testid="layer-editor-chip-${chipKey}"]`);
      const slot = document.querySelector(`[data-testid="layer-editor-slot-${String(slotIndex)}"]`);
      if (chip === null || slot === null) throw new Error('drag targets missing');
      const dt = new DataTransfer();
      const dragStart = new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      chip.dispatchEvent(dragStart);
      const dragOver = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      slot.dispatchEvent(dragOver);
      const drop = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientY: 0,
      });
      slot.dispatchEvent(drop);
      const dragEnd = new DragEvent('dragend', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      chip.dispatchEvent(dragEnd);
    },
    { chipKey, slotIndex },
  );
}

test.describe('R12 Layer Editor', () => {
  test.setTimeout(180_000);

  test('add folder group, drag to leftmost slot, assert package x matches', async ({ page }) => {
    page.on('console', (msg) => {
      console.log(`[browser:${msg.type()}] ${msg.text()}`);
    });

    await page.goto('/');
    await page.evaluate(() => {
      window.localStorage.clear();
    });
    await uploadFixture(page, 'simple');
    await waitForAnalysisDone(page);
    await waitForGraphReady(page);
    await expect(page.locator('[data-testid="screen-main"]')).toBeVisible();
    await expect(page.locator('[data-testid="layer-editor-bar"]')).toBeVisible();

    // Discover an existing package path to target. The simple fixture uses
    // `internal/util` and `internal/dead` — pick any whose prefix has
    // segments to play nice with the prefix matcher.
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
    const segments = samplePkg.split('/');
    expect(segments.length).toBeGreaterThanOrEqual(1);
    // Use a strict prefix that is guaranteed to match.
    const prefix = segments.slice(0, Math.min(2, segments.length)).join('/');

    // ---- step 1: add a folder group via the inline form ----
    await page.click('[data-testid="layer-editor-add"]');
    await page.fill('[data-testid="layer-editor-name"]', 'MyGroup');
    await page.fill('[data-testid="layer-editor-prefix"]', prefix);
    await page.click('[data-testid="layer-editor-add-confirm"]');

    // The new chip should appear (it lands in the unassigned tray first).
    const folderChipLocator = page.locator('[data-testid^="layer-editor-chip-folder:"]').first();
    await expect(folderChipLocator).toBeVisible();
    const chipKey = (await folderChipLocator.getAttribute('data-testid'))?.replace(
      'layer-editor-chip-',
      '',
    ) ?? '';
    expect(chipKey).toContain('folder:');

    // ---- step 2: drag chip to leftmost slot (index 0) ----
    await dragChipToSlot(page, chipKey, 0);

    // Wait one tick for React to re-render and the canvas to re-flow.
    await page.waitForTimeout(150);

    await shot(page, 'r12-after-drag');

    // The chip should now live inside slot 0.
    const slot0 = page.locator('[data-testid="layer-editor-slot-0"]');
    await expect(
      slot0.locator(`[data-testid="layer-editor-chip-${chipKey}"]`),
    ).toBeVisible();

    // ---- step 3: assert at least one matching package landed at slot 0's x ----
    const positions = await readPositions(page);
    const matching = positions.filter(
      (p) => p.pkg === prefix || p.pkg.startsWith(prefix + '/'),
    );
    expect(matching.length).toBeGreaterThan(0);
    const xs = new Set(matching.map((p) => p.x));
    // All matching packages must share a single x value (the slot's column).
    expect(xs.size).toBe(1);
    const slotX = matching[0]?.x ?? -1;

    // Confirm slot 0's x is at the LEFT — i.e. no other top-level node has
    // a smaller x value.
    const minX = Math.min(...positions.map((p) => p.x));
    expect(slotX).toBeLessThanOrEqual(minX + 1);

    console.log(`[R12] slot0 x = ${String(slotX)}, matching pkgs = ${String(matching.length)}`);
  });

  test('longest-prefix-first: nested folder claims deeper packages', async ({ page }) => {
    page.on('console', (msg) => {
      console.log(`[browser:${msg.type()}] ${msg.text()}`);
    });

    await page.goto('/');
    await page.evaluate(() => {
      window.localStorage.clear();
    });
    await uploadFixture(page, 'simple');
    await waitForAnalysisDone(page);
    await waitForGraphReady(page);

    // The simple fixture does not include `databases/...` packages. Inject
    // two synthetic top-level nodes onto the cy core so we can exercise the
    // longest-prefix-first rule deterministically.
    await page.evaluate(() => {
      type CyApi = {
        add: (def: unknown) => void;
        $id: (id: string) => { nonempty: () => boolean };
      };
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      if (cy === undefined) return;
      if (!cy.$id('db_root').nonempty()) {
        cy.add({
          group: 'nodes',
          data: {
            id: 'db_root',
            name: 'databases',
            kind: 'package',
            package: 'databases',
            file: '',
            line: 0,
            exported: true,
            reachable: true,
            is_entry: false,
          },
        });
      }
      if (!cy.$id('db_pg').nonempty()) {
        cy.add({
          group: 'nodes',
          data: {
            id: 'db_pg',
            name: 'postgres',
            kind: 'package',
            package: 'databases/postgres/conn',
            file: '',
            line: 0,
            exported: true,
            reachable: true,
            is_entry: false,
          },
        });
      }
    });

    // Now declare both folder groups via the UI. The first group lands in
    // "unassigned"; drag both to slot 0 + slot 1 so they actually take
    // effect on the layout.
    await page.click('[data-testid="layer-editor-add"]');
    await page.fill('[data-testid="layer-editor-name"]', 'DBs');
    await page.fill('[data-testid="layer-editor-prefix"]', 'databases');
    await page.click('[data-testid="layer-editor-add-confirm"]');

    await page.click('[data-testid="layer-editor-add"]');
    await page.fill('[data-testid="layer-editor-name"]', 'PG');
    await page.fill('[data-testid="layer-editor-prefix"]', 'databases/postgres');
    await page.click('[data-testid="layer-editor-add-confirm"]');

    // Drag DBs to slot 0; drag PG to slot 1 — distinct slots so x differs.
    const folderChips = page.locator('[data-testid^="layer-editor-chip-folder:"]');
    await expect(folderChips).toHaveCount(2);
    const keys = await folderChips.evaluateAll((els) =>
      els.map((e) => (e.getAttribute('data-testid') ?? '').replace('layer-editor-chip-', '')),
    );
    expect(keys.length).toBe(2);
    // Which is which? The label is the chip text.
    const dbsKey = await folderChips
      .filter({ hasText: 'DBs' })
      .first()
      .getAttribute('data-testid');
    const pgKey = await folderChips
      .filter({ hasText: 'PG' })
      .first()
      .getAttribute('data-testid');
    expect(dbsKey).not.toBeNull();
    expect(pgKey).not.toBeNull();
    const dbsId = (dbsKey ?? '').replace('layer-editor-chip-', '');
    const pgId = (pgKey ?? '').replace('layer-editor-chip-', '');
    await dragChipToSlot(page, dbsId, 0);
    await dragChipToSlot(page, pgId, 1);

    // Trigger a relayout to recompute positions against the new state.
    await page.click('[data-testid="main-relayout"]');
    await page.waitForTimeout(200);

    await shot(page, 'r12-longest-prefix');

    const positions = await readPositions(page);
    const pg = positions.find((p) => p.pkg === 'databases/postgres/conn');
    const dbRoot = positions.find((p) => p.pkg === 'databases');
    expect(pg).toBeDefined();
    expect(dbRoot).toBeDefined();
    // PG (slot 1) must have a strictly greater x than DBs (slot 0).
    expect(pg!.x).toBeGreaterThan(dbRoot!.x);
    console.log(`[R12] dbRoot.x=${String(dbRoot!.x)} pg.x=${String(pg!.x)}`);
  });
});
