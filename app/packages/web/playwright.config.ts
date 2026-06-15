import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Absolute path to the repo root (three directories above this config). */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Absolute path to the electron-vite main output entry point. */
export const electronMain = join(repoRoot, 'out', 'main', 'index.js');

/** Environment variables injected into every Electron launch during e2e tests. */
export const electronEnv: Record<string, string> = {
  ...process.env as Record<string, string>,
  HYVEON_TEST_MODE: '1',
};

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
      name: 'electron',
    },
  ],
  globalSetup: './e2e/electron-global-setup.ts',
});
