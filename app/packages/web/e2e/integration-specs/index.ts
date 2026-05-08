/**
 * Re-exports for integration specs. Import `test` and `expect` from here
 * rather than from `@playwright/test` directly — `test` includes the
 * `serverMocks`, `authedPage`, and `dashboard` fixtures that every integration
 * spec needs.
 */
export { test, type MockResponse, ServerMocks } from '../fixtures/server-mocks.js';
export { expect } from '@playwright/test';
