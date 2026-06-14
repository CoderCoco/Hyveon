import { test, expect, stubApis } from '../fixtures/index.js';

/**
 * Auth-gate specs.
 *
 * The 401 → token-modal → inline-retry flow these specs used to cover was
 * removed in #159: the renderer now talks to the main process over `window.gsd`
 * IPC, which has no bearer auth and no 401 response, so `setUnauthorizedHandler`
 * never fires and the modal can no longer open. The `ApiTokenModal` component
 * and the remaining token-storage helpers are deleted in #162; this spec file
 * goes with them. Until then the only behaviour still worth pinning is that a
 * stored token lets the dashboard mount without the (now unreachable) modal.
 */

test.describe('auth gate', () => {
  test('should load dashboard when a token is already stored', async ({ page, authGate, layout }) => {
    await page.addInitScript(() => {
      localStorage.setItem('apiToken', 'test-token');
    });
    await stubApis(page, { statuses: [] });
    await page.goto('/');
    // Dashboard shell mounts, modal does not.
    await expect(layout.brandHeading()).toBeVisible();
    await expect(authGate.modalHeading()).not.toBeVisible();
  });
});
