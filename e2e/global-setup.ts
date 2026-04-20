import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/**
 * Global setup runs once per `playwright test` invocation.
 *
 * Responsibilities:
 *   1. Make sure fixture archives exist in `e2e/fixtures/.cache/`. The
 *      build-fixtures.sh script is idempotent — when archives are already
 *      present it is a no-op (~50ms).
 *   2. Create the test-evidence/T26 tree so specs can write screenshots and
 *      downloads without dirtying the repo with empty directories.
 *   3. Sanity-check the backend on baseURL (best-effort; specs themselves
 *      will fail clearly if the backend is unreachable).
 */
export default async function globalSetup(): Promise<void> {
  const script = path.join(repoRoot, 'scripts', 'build-fixtures.sh');
  if (!fs.existsSync(script)) {
    throw new Error(`build-fixtures.sh not found at ${script}`);
  }
  const result = spawnSync('bash', [script], {
    stdio: 'inherit',
    cwd: repoRoot,
  });
  if (result.status !== 0) {
    throw new Error(`build-fixtures.sh failed with exit code ${String(result.status)}`);
  }

  const evidenceDir = path.join(repoRoot, 'test-evidence', 'T26');
  for (const sub of ['screenshots', 'downloads', 'logs']) {
    fs.mkdirSync(path.join(evidenceDir, sub), { recursive: true });
  }

  const baseURL = process.env.BASE_URL ?? 'http://localhost:8080';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 3000);
    const res = await fetch(`${baseURL}/api/healthz`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[e2e] healthz returned ${String(res.status)} from ${baseURL}`);
    } else {
      console.log(`[e2e] backend reachable at ${baseURL}`);
    }
  } catch (err) {
    console.warn(
      `[e2e] WARN backend not reachable at ${baseURL}: ${String((err as Error).message)}`,
    );
    console.warn('[e2e] start the server first (docker run -p 8080:8080 go-viz:dev)');
  }
}
