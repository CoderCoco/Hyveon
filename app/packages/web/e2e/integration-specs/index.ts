/**
 * Re-exports for integration specs. Import `test` and `expect` from here
 * rather than from `@playwright/test` directly — `test` includes the
 * `serverMocks` and `ipc` fixtures that every integration spec needs.
 * `serverMocks` pushes queued AWS SDK responses straight into the in-process
 * MockStore; `ipc` dispatches directly to `AppModule` controller methods.
 * Neither fixture spins up an HTTP server or a BrowserWindow.
 */
export { test, type MockResponse, ServerMocks } from '../fixtures/server-mocks.js';
export type { IpcHarness } from '../fixtures/ipc-harness.js';
export { expect } from '@playwright/test';
