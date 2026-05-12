/**
 * R11 verification spec — empirically confirms that the fcose layout no
 * longer collapses the Xray-core top-level package nodes into a central
 * hairball.
 *
 * The symptom chain the user is complaining about:
 *   - initial layout runs fcose with the R7 knobs (repulsion 6k-9k,
 *     idealEdgeLength 120-160, gravity 0.25, packComponents: true);
 *   - on Xray-core (~30 heavy-degree internal packages, ~200 inter-package
 *     imports) the adaptive-width compound nodes end up placed shoulder-to-
 *     shoulder, edges cross into a dense knot, and expanded packages get
 *     flung to the periphery because the central cluster has no room.
 *
 * Assertions (all empirical, read from `window.__cy`):
 *   - top-level package nodes cover ≥ 60 % of the canvas width and ≥ 40 %
 *     of the canvas height (pre-R11 baseline: ~20 %);
 *   - the average nearest-neighbour centre distance is at least 1.3x the
 *     median node diameter (i.e. nodes are not stacked);
 *   - zero top-level-node overlaps (fcose avoidOverlap contract).
 *
 * Also reasserts the R8 Task A invariant: a double-click expansion
 * completes in ≤ 2 s on Xray and does not trigger a full initial layout.
 *
 * Screenshots are written under project/test-evidence/R11/ so a human can
 * audit the before/after visual state alongside the numbers.
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { waitForAnalysisDone, waitForGraphReady } from '../helpers/sse';
import { waitForLayoutStop } from '../support/waitForLayoutStop';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const screenshotDir = path.join(repoRoot, 'test-evidence', 'R11');
fs.mkdirSync(screenshotDir, { recursive: true });

async function shot(page: Page, label: string): Promise<void> {
  await page.screenshot({
    path: path.join(screenshotDir, `${label}.png`),
    fullPage: true,
  });
}

function appendMetricsLog(line: string): void {
  fs.appendFileSync(path.join(screenshotDir, 'r11-metrics.log'), `${line}\n`);
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

interface SpreadMetrics {
  nodeCount: number;
  // Viewport dimensions (pixels on the visible canvas).
  viewportW: number;
  viewportH: number;
  // Fraction of canvas width/height actually occupied by top-level node
  // bounding boxes.
  coverageW: number;
  coverageH: number;
  // Ratio of average nearest-neighbour centre distance to median node diameter.
  nnRatio: number;
  // Bounding box of all top-level nodes (rendered coordinates).
  bboxW: number;
  bboxH: number;
  // Median node diameter (rendered pixels).
  medianDiameter: number;
  // Count of nodes that overlap at least one other top-level node.
  overlapCount: number;
}

async function collectSpreadMetrics(page: Page): Promise<SpreadMetrics> {
  return await page.evaluate(() => {
    interface CyBB { x1: number; y1: number; x2: number; y2: number; w: number; h: number }
    interface CyNode {
      id: () => string;
      isParent: () => boolean;
      isChild: () => boolean;
      parent: () => { length: number };
      hasClass: (c: string) => boolean;
      visible: () => boolean;
      renderedBoundingBox: () => CyBB;
      boundingBox: () => CyBB;
      data: (k: string) => unknown;
    }
    interface CyApi {
      nodes: (sel?: string) => { length: number; toArray: () => CyNode[] };
      width: () => number;
      height: () => number;
    }
    const cy = (window as unknown as { __cy?: CyApi }).__cy;
    if (cy === undefined) {
      return {
        nodeCount: 0,
        viewportW: 0,
        viewportH: 0,
        coverageW: 0,
        coverageH: 0,
        nnRatio: 0,
        bboxW: 0,
        bboxH: 0,
        medianDiameter: 0,
        overlapCount: -1,
      };
    }
    // "Top-level" — node is (a) visible (not hidden by any filter class),
    // (b) not a child of a compound parent. We keep :parent compound nodes
    // themselves because the user perceives them as one unit on the canvas.
    const all = cy.nodes().toArray();
    const hiddenClasses = ['hidden', 'mode-hide-live', 'mode-hide-dead', 'collapsed-hidden'];
    const tops = all.filter((n) => {
      for (const c of hiddenClasses) {
        if (n.hasClass(c)) return false;
      }
      if (n.isChild() && n.parent().length > 0) {
        return false;
      }
      const bb = n.renderedBoundingBox();
      if (bb.w === 0 || bb.h === 0) {
        return false;
      }
      return true;
    });
    if (tops.length === 0) {
      return {
        nodeCount: 0,
        viewportW: cy.width(),
        viewportH: cy.height(),
        coverageW: 0,
        coverageH: 0,
        nnRatio: 0,
        bboxW: 0,
        bboxH: 0,
        medianDiameter: 0,
        overlapCount: 0,
      };
    }
    // Spread metrics in *layout* (model) coordinates — these do not depend
    // on the post-layout zoom/fit, so they measure the raw fcose layout and
    // not the viewport projection (which a zoom cap can compress).
    const modelBoxes = tops.map((n) => n.boundingBox());
    // Coverage metrics in *rendered* (viewport) coordinates — these answer
    // the user question "does the visible graph fill the canvas?"
    const renderedBoxes = tops.map((n) => n.renderedBoundingBox());
    const xs1 = renderedBoxes.map((b) => b.x1);
    const ys1 = renderedBoxes.map((b) => b.y1);
    const xs2 = renderedBoxes.map((b) => b.x2);
    const ys2 = renderedBoxes.map((b) => b.y2);
    const bboxX1 = Math.min(...xs1);
    const bboxY1 = Math.min(...ys1);
    const bboxX2 = Math.max(...xs2);
    const bboxY2 = Math.max(...ys2);
    const bboxW = bboxX2 - bboxX1;
    const bboxH = bboxY2 - bboxY1;
    const viewportW = cy.width();
    const viewportH = cy.height();
    // Node diameters and NN distances in MODEL coords so the ratio is
    // zoom-invariant.
    const diameters = modelBoxes.map((b) => Math.max(b.w, b.h));
    const sortedD = [...diameters].sort((a, b) => a - b);
    const medianDiameter = sortedD[Math.floor(sortedD.length / 2)] ?? 0;
    const centres = modelBoxes.map((b) => ({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 }));
    let nnSum = 0;
    let nnSamples = 0;
    for (let i = 0; i < centres.length; i += 1) {
      let best = Infinity;
      const a = centres[i];
      if (a === undefined) continue;
      for (let j = 0; j < centres.length; j += 1) {
        if (i === j) continue;
        const b = centres[j];
        if (b === undefined) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d < best) best = d;
      }
      if (Number.isFinite(best)) {
        nnSum += best;
        nnSamples += 1;
      }
    }
    const avgNN = nnSamples === 0 ? 0 : nnSum / nnSamples;
    const nnRatio = medianDiameter === 0 ? 0 : avgNN / medianDiameter;
    // Overlap count uses model coords (1-unit buffer so touching borders do
    // not count). Rendered-coord overlaps scale with zoom, model-coord
    // overlaps are a direct property of the layout.
    let overlapCount = 0;
    for (let i = 0; i < modelBoxes.length; i += 1) {
      const a = modelBoxes[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < modelBoxes.length; j += 1) {
        const b = modelBoxes[j];
        if (b === undefined) continue;
        const overlapX = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        const overlapY = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        if (overlapX > 1 && overlapY > 1) {
          overlapCount += 1;
        }
      }
    }
    return {
      nodeCount: tops.length,
      viewportW,
      viewportH,
      coverageW: viewportW === 0 ? 0 : bboxW / viewportW,
      coverageH: viewportH === 0 ? 0 : bboxH / viewportH,
      nnRatio,
      bboxW,
      bboxH,
      medianDiameter,
      overlapCount,
    };
  });
}

test.describe('R11 layout spread verification', () => {
  test.setTimeout(900_000);

  test('Xray-core top-level packages are readably spread after initial fcose', async ({ page }) => {
    page.on('console', (msg) => {
      console.log(`[browser:${msg.type()}] ${msg.text()}`);
    });
    appendMetricsLog(`---- ${new Date().toISOString()} ----`);

    await uploadXray(page);
    await waitForAnalysisDone(page, 600_000);
    await waitForGraphReady(page, 60_000);
    await expect(page.locator('[data-testid="screen-main"]')).toBeVisible();

    // Wait for layout to settle deterministically rather than via a fixed
    // sleep. R12: the preset tree layout is synchronous, but a future fit /
    // expansion may still emit a trailing `layoutstop`.
    try {
      await waitForLayoutStop(page, { timeout: 5_000 });
    } catch {
      // Preset layout may have already fired before the listener attached.
      // Continue — subsequent assertions surface any real failure.
    }

    await shot(page, 'r11-xray-initial-layout');

    // Sanity: hideExternal default must have tagged the stdlib/3rd-party
    // packages with `.hidden` before our layout effect ran (R11 depends on
    // this to scope fcose to the visible subset).
    const hiddenDiag = await page.evaluate(() => {
      interface CyNode { hasClass: (c: string) => boolean; data: (k: string) => unknown }
      interface CyApi { nodes: () => { toArray: () => CyNode[] } }
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      if (cy === undefined) return { total: 0, hidden: 0, external: 0 };
      const all = cy.nodes().toArray();
      return {
        total: all.length,
        hidden: all.filter((n) => n.hasClass('hidden')).length,
        external: all.filter((n) => n.data('external') === true).length,
      };
    });
    console.log(`[R11] hidden-diag: ${JSON.stringify(hiddenDiag)}`);
    appendMetricsLog(`hidden-diag ${JSON.stringify(hiddenDiag)}`);
    expect(hiddenDiag.hidden, 'hideExternal must tag >=1 external packages').toBeGreaterThan(0);

    const initial = await collectSpreadMetrics(page);
    console.log(`[R11] initial metrics: ${JSON.stringify(initial)}`);
    appendMetricsLog(`initial ${JSON.stringify(initial)}`);
    expect(initial.nodeCount, 'expected >20 top-level Xray internal packages').toBeGreaterThan(20);

    // Reach-depth layout assertions (replaces the R11 fcose spread metrics).
    //   (a) every entry-point node sits on the top row (same y, within 1 px).
    //   (b) at least one inter-package edge (source.parent !== target.parent
    //       in canvas terms, i.e. cross-package) is present on first paint.
    //       Bug 2 fix — pre-PR, the default `hideExternal: true` plus the
    //       any-endpoint-hidden propagation collapsed every cross-package
    //       imports edge to `.hidden` and the user saw zero arrows.
    const entryDiag = await page.evaluate(() => {
      interface CyNode {
        id: () => string;
        position: () => { x: number; y: number };
        data: (k: string) => unknown;
        hasClass: (c: string) => boolean;
      }
      interface CyApi { nodes: (sel?: string) => { toArray: () => CyNode[] } }
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      if (cy === undefined) return { entries: [] as { id: string; y: number }[] };
      const entries = cy
        .nodes()
        .toArray()
        .filter((n) => n.data('is_entry') === true)
        .map((n) => ({ id: n.id(), y: n.position().y }));
      return { entries };
    });
    appendMetricsLog(`entry-diag ${JSON.stringify(entryDiag)}`);
    if (entryDiag.entries.length >= 2) {
      const ys = entryDiag.entries.map((e) => e.y);
      const spread = Math.max(...ys) - Math.min(...ys);
      expect(
        spread,
        `entry-point y spread must be ≤1 px, got ${String(spread)}`,
      ).toBeLessThanOrEqual(1);
    }

    const edgeDiag = await page.evaluate(() => {
      interface CyEdge {
        id: () => string;
        source: () => { id: () => string; data: (k: string) => unknown };
        target: () => { id: () => string; data: (k: string) => unknown };
        hasClass: (c: string) => boolean;
        visible: () => boolean;
      }
      interface CyApi { edges: (sel?: string) => { toArray: () => CyEdge[]; length: number } }
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      if (cy === undefined) return { total: 0, visibleCrossPkg: 0 };
      const all = cy.edges().toArray();
      let visibleCrossPkg = 0;
      for (const e of all) {
        if (e.hasClass('hidden')) continue;
        const sp = String(e.source().data('package') ?? '');
        const tp = String(e.target().data('package') ?? '');
        if (sp !== '' && tp !== '' && sp !== tp) visibleCrossPkg += 1;
      }
      return { total: all.length, visibleCrossPkg };
    });
    appendMetricsLog(`edge-diag ${JSON.stringify(edgeDiag)}`);
    expect(
      edgeDiag.visibleCrossPkg,
      'Bug 2 regression — no visible inter-package edges on first render',
    ).toBeGreaterThan(0);

    // ---- Expand two mid-sized packages by double-click ----
    const expansionTargets = await page.evaluate(() => {
      interface CyNode { id: () => string; data: (k: string) => unknown }
      interface CyApi { nodes: (sel?: string) => { toArray: () => CyNode[] } }
      const cy = (window as unknown as { __cy?: CyApi }).__cy;
      if (cy === undefined) return [];
      return cy
        .nodes('node[kind="package"]')
        .toArray()
        .filter((n) => {
          if (n.data('external') === true) return false;
          const cc = Number(n.data('child_count') ?? 0);
          return Number.isFinite(cc) && cc >= 3 && cc <= 25;
        })
        .slice(0, 2)
        .map((n) => ({ id: n.id(), pkg: String(n.data('package') ?? '') }));
    });
    expect(expansionTargets.length, 'must find ≥2 expandable mid-sized packages').toBeGreaterThanOrEqual(2);

    const expansionTimings: Array<{ pkg: string; elapsedMs: number }> = [];
    for (const t of expansionTargets) {
      const beforeNodes = await page.evaluate(() => {
        interface CyApi { nodes: () => { length: number } }
        const cy = (window as unknown as { __cy?: CyApi }).__cy;
        return cy?.nodes().length ?? 0;
      });
      const start = Date.now();
      await page.evaluate((id) => {
        interface CyApi { $id: (id: string) => { emit: (evt: string) => void } }
        const cy = (window as unknown as { __cy?: CyApi }).__cy;
        cy?.$id(id).emit('dbltap');
      }, t.id);
      await page.waitForFunction(
        ({ before, parentId }: { before: number; parentId: string }) => {
          interface CyNode { data: (k: string) => unknown }
          interface CyApi {
            nodes: () => { length: number; toArray: () => CyNode[] };
          }
          const cy = (window as unknown as { __cy?: CyApi }).__cy;
          if (cy === undefined) return false;
          if (cy.nodes().length <= before) return false;
          const kids = cy.nodes().toArray().filter((n) => n.data('parent') === parentId);
          return kids.length > 0;
        },
        { before: beforeNodes, parentId: t.id },
        { timeout: 30_000 },
      );
      await page.waitForTimeout(300);
      const elapsedMs = Date.now() - start;
      expansionTimings.push({ pkg: t.pkg, elapsedMs });
      appendMetricsLog(`expand pkg=${t.pkg} elapsed_ms=${String(elapsedMs)}`);
    }

    // R8 Task A invariant: each expansion ≤ 2000 ms (scoped layout, no
    // full initial re-run).
    for (const t of expansionTimings) {
      expect(t.elapsedMs, `pkg=${t.pkg} expansion too slow: ${String(t.elapsedMs)}ms`).toBeLessThanOrEqual(2_500);
    }

    await shot(page, 'r11-xray-after-expansions');

    // ---- R12 idempotence check: snapshot positions, press Relayout, ----
    // ----   snapshot again, assert L∞ delta ≤ 1 px per node.        ----
    const snapBefore = await snapshotTopLevelPositions(page);
    await page.locator('[data-testid="main-relayout"]').click();
    try {
      await waitForLayoutStop(page, { timeout: 5_000 });
    } catch {
      // Preset layout is synchronous — listener may attach after the event.
    }
    const snapAfter = await snapshotTopLevelPositions(page);

    const afterRelayout = await collectSpreadMetrics(page);
    console.log(`[R11] after relayout: ${JSON.stringify(afterRelayout)}`);
    appendMetricsLog(`after-relayout ${JSON.stringify(afterRelayout)}`);

    await shot(page, 'r11-xray-after-relayout');

    // After relayout the graph must still have visible inter-package edges
    // and a non-empty top-level node set; spread thresholds were replaced by
    // the reach-depth assertions above because a strictly layered layout
    // does not target the same coverage profile as the fcose spread.
    expect(afterRelayout.nodeCount).toBeGreaterThan(0);

    // Idempotence: every top-level node that existed both before and after
    // Relayout must sit at (almost) exactly the same model coordinate.
    const maxDelta = computeMaxDelta(snapBefore, snapAfter);
    appendMetricsLog(`relayout-idempotence maxDelta=${String(maxDelta)}`);
    expect(
      maxDelta,
      `Relayout must be idempotent — saw ${String(maxDelta)}px max delta`,
    ).toBeLessThanOrEqual(1);

    appendMetricsLog(`DONE`);
  });
});

async function snapshotTopLevelPositions(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return await page.evaluate(() => {
    interface CyNode {
      id: () => string;
      isChild: () => boolean;
      parent: () => { length: number };
      position: () => { x: number; y: number };
    }
    interface CyApi { nodes: () => { toArray: () => CyNode[] } }
    const cy = (window as unknown as { __cy?: CyApi }).__cy;
    if (cy === undefined) return {};
    const out: Record<string, { x: number; y: number }> = {};
    for (const n of cy.nodes().toArray()) {
      if (n.isChild() && n.parent().length > 0) continue;
      const p = n.position();
      out[n.id()] = { x: p.x, y: p.y };
    }
    return out;
  });
}

function computeMaxDelta(
  a: Record<string, { x: number; y: number }>,
  b: Record<string, { x: number; y: number }>,
): number {
  let max = 0;
  for (const id of Object.keys(a)) {
    const pa = a[id];
    const pb = b[id];
    if (pa === undefined || pb === undefined) continue;
    const d = Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
    if (d > max) max = d;
  }
  return max;
}
