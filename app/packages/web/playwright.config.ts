import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Absolute path to the repo root (three directories above this config). */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Absolute path to the electron-vite main output entry point. */
export const electronMain = join(repoRoot, 'out', 'main', 'index.js');

/** Environment variables injected into every Electron launch during e2e tests. */
export const electronEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HYVEON_TEST_MODE: '1',
};

/**
 * Two e2e projects run side by side during the Electron pivot (Epic F #140):
 *
 *  - `chromium` runs the existing stub-based specs against `vite preview`. They
 *    stub `/api/*` over HTTP via `page.route()` and navigate to `baseURL`, so
 *    they cannot run under Electron until the IPC mock surface (F.7/#198) lands.
 *    Each existing spec migrates to Electron under its own issue (F.2–F.6).
 *  - `electron` runs the new `_electron.launch()` smoke spec against the
 *    packaged main bundle. Each spec manages its own ElectronApplication.
 *
 * `electron-smoke.spec.ts` is matched only by the `electron` project and
 * ignored by `chromium`; every other spec is the reverse.
 */
const ELECTRON_SPEC = '**/electron-smoke.spec.ts';

export default defineConfig({
  testDir: './e2e/specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    // Video requires ffmpeg which hangs on install in CI; traces are sufficient
    video: process.env.CI ? 'off' : 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: ELECTRON_SPEC,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:4173',
        // In CI use the pre-installed system Chrome to avoid downloading Chromium
        ...(process.env.CI ? { channel: 'chrome' } : {}),
      },
    },
    {
      name: 'electron',
      testMatch: ELECTRON_SPEC,
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
