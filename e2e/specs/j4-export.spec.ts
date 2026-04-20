import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { uploadFixture } from '../helpers/upload';
import { waitForAnalysisDone, waitForGraphReady } from '../helpers/sse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const downloadsDir = path.resolve(__dirname, '..', '..', 'test-evidence', 'T26', 'downloads');

/**
 * J4 — export dead-code report (TXT + JSON).
 *
 * The dead-code panel offers two buttons that trigger browser downloads.
 * The spec captures each download via Playwright's download API, copies the
 * file into test-evidence/T26/downloads/ and asserts the payload contains
 * the known dead symbols from the synthetic fixture.
 */
test.describe('J4 — export dead-code report', () => {
  test('downloads TXT and JSON containing the known dead symbols', async ({
    page,
  }, testInfo) => {
    await uploadFixture(page, 'simple');
    await waitForAnalysisDone(page);
    await waitForGraphReady(page);

    await expect(page.locator('[data-testid="dead-panel-export-txt"]')).toBeEnabled();
    await expect(page.locator('[data-testid="dead-panel-export-json"]')).toBeEnabled();

    // TXT export
    const [txtDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-testid="dead-panel-export-txt"]').click(),
    ]);
    const txtName = `j4-${testInfo.project.name}-${txtDownload.suggestedFilename()}`;
    const txtPath = path.join(downloadsDir, txtName);
    await txtDownload.saveAs(txtPath);
    const txtBody = await fs.readFile(txtPath, 'utf8');
    expect(txtBody.length).toBeGreaterThan(0);
    expect(txtBody).toContain('LegacyAdder');

    // JSON export
    const [jsonDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-testid="dead-panel-export-json"]').click(),
    ]);
    const jsonName = `j4-${testInfo.project.name}-${jsonDownload.suggestedFilename()}`;
    const jsonPath = path.join(downloadsDir, jsonName);
    await jsonDownload.saveAs(jsonPath);
    const raw = await fs.readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      entries_count: number;
      entries: { fqn: string }[];
    };
    expect(parsed.entries_count).toBeGreaterThan(0);
    const fqns = parsed.entries.map((e) => e.fqn);
    expect(fqns.some((fqn) => fqn.includes('LegacyAdder'))).toBe(true);
  });
});
