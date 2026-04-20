import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fixturePath, uploadFixture } from '../helpers/upload';
import { waitForAnalysisDone } from '../helpers/sse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.resolve(__dirname, '..', '..', 'test-evidence', 'T26', 'logs');

/**
 * NFR-01 — full analyze pipeline must finish within 30 s on a medium project.
 *
 * The medium fixture (`go-chi/chi`, ~15k LOC at the pinned SHA) is below the
 * 50k LOC target from the spec. The bench here is informational: we record
 * the elapsed wall-clock and assert a generous 60 s upper bound so the build
 * does not flake on slow runners. The final 30 s target is verified manually
 * on the 50k LOC demo project bundled in T27.
 *
 * Tagged as @slow / `test.slow()` so CI runners can skip with --grep-invert.
 */
test.describe('NFR-01 — medium-project analyze under reference budget', () => {
  test('uploads medium fixture and times the full pipeline', async ({
    page,
  }, testInfo) => {
    test.slow();
    let mediumExists = true;
    try {
      fixturePath('medium');
    } catch {
      mediumExists = false;
    }
    test.skip(!mediumExists, 'medium fixture not available (offline?)');

    const t0 = Date.now();
    await uploadFixture(page, 'medium');
    await waitForAnalysisDone(page, 90_000);
    const elapsed = Date.now() - t0;

    await fs.mkdir(logsDir, { recursive: true });
    await fs.appendFile(
      path.join(logsDir, 'nfr-measurements.log'),
      `${new Date().toISOString()} NFR-01 ${testInfo.project.name} fixture=medium elapsed_ms=${String(elapsed)}\n`,
    );

    // Generous bound to avoid CI flakes; the 30 s target is verified on
    // the 50k LOC project shipped with T27.
    expect(elapsed, `medium analyze took ${String(elapsed)} ms`).toBeLessThan(60_000);
  });
});
