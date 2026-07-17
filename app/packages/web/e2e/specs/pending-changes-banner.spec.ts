import { test, expect, stubApis, STOPPED_GAME } from '../fixtures/index.js';

/**
 * `PendingChangesBanner` spec (issue #101) — plain browser-stub spec
 * (`chromium` project), same pattern as `settings.spec.ts` and
 * `games.spec.ts`. `/api/drift` (the `drift.get` IPC channel) is stubbed over
 * HTTP via `stubApis`'s `drift` option; the banner fetches it once on mount,
 * so seeding the stub before `dashboard.goto()` is enough — there's no need
 * to force a remount the way the (now-removed) Electron variant did.
 */
test.describe('pending changes banner', () => {
  test('should show the banner with a pending-changes count when drift is detected', async ({ dashboard }) => {
    await stubApis(dashboard.page, {
      statuses: [STOPPED_GAME],
      drift: { entries: [{ game: 'minecraft', kind: 'pending_create' }] },
    });
    await dashboard.goto();

    await expect(dashboard.pendingChangesBanner()).toBeVisible();
    await expect(dashboard.pendingChangesBanner()).toContainText('1 change pending');
  });

  test('should stay hidden when the drift report has no entries', async ({ dashboard }) => {
    await stubApis(dashboard.page, {
      statuses: [STOPPED_GAME],
      drift: { entries: [] },
    });
    await dashboard.goto();

    await expect(dashboard.pendingChangesBanner()).toHaveCount(0);
  });

  test('should navigate to the games page when "View pending" is clicked', async ({ dashboard }) => {
    await stubApis(dashboard.page, {
      statuses: [STOPPED_GAME],
      drift: { entries: [{ game: 'minecraft', kind: 'pending_create' }] },
    });
    await dashboard.goto();

    await dashboard.viewPendingLink().click();

    await dashboard.page.waitForURL((url) => url.pathname === '/games');
  });

  test('should dismiss the banner when the dismiss button is clicked', async ({ dashboard }) => {
    await stubApis(dashboard.page, {
      statuses: [STOPPED_GAME],
      drift: { entries: [{ game: 'minecraft', kind: 'pending_create' }] },
    });
    await dashboard.goto();

    await expect(dashboard.pendingChangesBanner()).toBeVisible();

    await dashboard.dismissBannerButton().click();

    await expect(dashboard.pendingChangesBanner()).toHaveCount(0);
  });
});
