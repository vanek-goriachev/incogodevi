import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadFixture } from '../helpers/upload';
import { waitForAnalysisDone, waitForGraphReady } from '../helpers/sse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.resolve(__dirname, '..', '..', 'test-evidence', 'T26', 'screenshots');

/**
 * J3 — reload restoration.
 *
 * The Cytoscape positions are persisted in localStorage under
 * `go-viz:<id>:positions` (see web/src/storage/keys.ts). After a full reload
 * the SPA must fetch the cached graph and apply the same positions, so node
 * coordinates round-trip without observable jumps.
 */
test.describe('J3 — reload restores graph and positions', () => {
  test('positions in localStorage survive a full reload', async ({ page }, testInfo) => {
    await uploadFixture(page, 'simple');
    await waitForAnalysisDone(page);
    await waitForGraphReady(page);

    // Positions are persisted on `layoutstop` and the write is debounced by
    // 500 ms (`usePositionsStorage`). Wait until the key actually appears
    // before we sample so the assertion below is meaningful. The wait also
    // gives Cytoscape time to flush the post-layout positions snapshot.
    await page.waitForFunction(
      () => {
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const k = window.localStorage.key(i);
          if (k !== null && k.startsWith('go-viz:') && k.endsWith(':positions')) {
            return true;
          }
        }
        return false;
      },
      undefined,
      { timeout: 30_000 },
    );

    // Snapshot a few node positions and the project id from localStorage.
    const before = await page.evaluate(() => {
      type CyApi = {
        nodes: () => {
          length: number;
          map: <T>(fn: (n: { id: () => string; position: () => { x: number; y: number } }) => T) => T[];
        };
      };
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      if (cy === undefined) {
        return null;
      }
      const positions = cy
        .nodes()
        .map((n) => ({ id: n.id(), x: n.position().x, y: n.position().y }))
        .slice(0, 5);
      const keys: Record<string, string> = {};
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (k !== null && k.startsWith('go-viz:')) {
          keys[k] = window.localStorage.getItem(k) ?? '';
        }
      }
      return { positions, keys };
    });
    expect(before).not.toBeNull();
    const baseline = before as NonNullable<typeof before>;
    expect(baseline.positions.length).toBeGreaterThan(0);

    // localStorage must contain at least one positions entry; otherwise the
    // reload assertion is meaningless.
    const positionKey = Object.keys(baseline.keys).find((k) => k.endsWith(':positions'));
    expect(positionKey).toBeDefined();

    await page.reload();
    await page.waitForSelector('[data-testid="screen-main"]', { timeout: 30_000 });
    await waitForGraphReady(page);

    const after = await page.evaluate(() => {
      type CyApi = {
        nodes: () => {
          map: <T>(fn: (n: { id: () => string; position: () => { x: number; y: number } }) => T) => T[];
        };
        $id: (id: string) => { length: number; position: () => { x: number; y: number } };
      };
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      if (cy === undefined) {
        return null;
      }
      const positions = cy
        .nodes()
        .map((n) => ({ id: n.id(), x: n.position().x, y: n.position().y }));
      return { positions };
    });
    expect(after).not.toBeNull();

    // For every node we sampled before reload, look it up in the new graph
    // and assert positions match within 1px (Cytoscape rounds when reading
    // back from a `preset` layout).
    const restored = after as NonNullable<typeof after>;
    const lookup = new Map(restored.positions.map((p) => [p.id, p] as const));
    for (const sample of baseline.positions) {
      const got = lookup.get(sample.id);
      expect(got, `node ${sample.id} missing after reload`).toBeDefined();
      expect(Math.abs((got?.x ?? 0) - sample.x)).toBeLessThanOrEqual(1);
      expect(Math.abs((got?.y ?? 0) - sample.y)).toBeLessThanOrEqual(1);
    }

    const screenshotPath = path.join(
      evidenceDir,
      `j3-positions-restored-${testInfo.project.name}.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
  });
});
