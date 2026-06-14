import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const fixtureDir = fileURLToPath(new URL('e2e/fixtures', import.meta.url));
const tfstatePath = join(fixtureDir, 'tfstate.fixture.json');
const serverDist = fileURLToPath(new URL('../../packages/desktop-main/dist', import.meta.url));

export default defineConfig({
  testDir: './e2e/integration-specs',
  /** Serial execution prevents mock-state races between specs. */
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4174',
    trace: 'retain-on-failure',
    // Video requires ffmpeg which hangs on install in CI; traces are sufficient
    video: process.env.CI ? 'off' : 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // In CI use the pre-installed system Chrome to avoid downloading Chromium
        ...(process.env.CI ? { channel: 'chrome' } : {}),
      },
    },
  ],
  webServer: [
    {
      command: `node ${join(serverDist, 'test-main.js')}`,
      url: 'http://localhost:3002/api/env?token=test-token',
      // ESM module loading from Windows/DrvFs in WSL2 is slow — allow up to 2 min.
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: '3002',
        NODE_ENV: 'test',
        TF_STATE_PATH: tfstatePath,
      },
    },
    {
      command: 'npx vite build --config vite.integration.config.ts && npx vite preview --config vite.integration.config.ts',
      url: 'http://localhost:4174',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
