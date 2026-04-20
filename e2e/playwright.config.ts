import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const baseURL = process.env.BASE_URL ?? 'http://localhost:8080';
const repoRoot = path.resolve(__dirname, '..');

/**
 * Playwright configuration for the Go Dependencies Visualizer E2E suite.
 *
 * Two run modes are supported via the BASE_URL env var:
 *   - Docker: BASE_URL=http://localhost:8080 (default)
 *   - Vite dev: BASE_URL=http://localhost:5173
 *
 * Browsers cover NFR-06 minimum matrix: Chromium (primary, used for NFR
 * measurements) and WebKit (Safari engine).
 */
export default defineConfig({
  testDir: './specs',
  outputDir: path.join(repoRoot, 'test-evidence', 'T26', 'playwright-output'),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.PW_JSON_ONLY === '1'
    ? [
        [
          'json',
          {
            outputFile: path.join(repoRoot, 'test-evidence', 'T26', 'results.json'),
          },
        ],
      ]
    : [
        ['list'],
        [
          'html',
          {
            outputFolder: path.join(repoRoot, 'test-evidence', 'T26', 'html-report'),
            open: 'never',
          },
        ],
        [
          'json',
          {
            outputFile: path.join(repoRoot, 'test-evidence', 'T26', 'results.json'),
          },
        ],
      ],
  globalSetup: './global-setup.ts',
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
