import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * Resolve a fixture archive path. The build-fixtures.sh script must have been
 * run beforehand (this is part of `globalSetup`).
 */
export function fixturePath(name: 'simple' | 'medium'): string {
  const p = path.join(repoRoot, 'e2e', 'fixtures', '.cache', `${name}.zip`);
  if (!fs.existsSync(p)) {
    throw new Error(
      `fixture '${name}.zip' is missing — did global setup run? expected at ${p}`,
    );
  }
  return p;
}

/**
 * Open the landing page and upload the given fixture archive via the hidden
 * file input. Resolves once the SPA navigates to the analyzing screen.
 */
export async function uploadFixture(page: Page, fixture: 'simple' | 'medium'): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('[data-testid="screen-landing"]', { timeout: 30_000 });
  const input = page.locator('[data-testid="landing-file-input"]');
  await input.setInputFiles(fixturePath(fixture));
  await page.waitForSelector('[data-testid="screen-analyzing"]', { timeout: 30_000 });
}
