import { defineConfig } from '@playwright/test';

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
  // No `use.baseURL`, no `projects`, no `webServer` — every integration spec
  // dispatches directly to the `AppModule` DI container via the `ipc` fixture
  // (see e2e/fixtures/ipc-harness.ts) and pushes mock ECS responses straight
  // into the in-process MockStore via the `serverMocks` fixture. There is no
  // HTTP server to boot and no BrowserWindow/browser project to launch.
});
