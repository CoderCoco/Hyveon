import { test, expect, stubApis } from '../fixtures/index.js';

test.describe('settings', () => {
  test('should show a success toast after saving watchdog settings', async ({
    settings,
    layout,
  }) => {
    await stubApis(settings.page, {});
    await settings.goto();

    await expect(settings.saveWatchdogButton()).toBeVisible();
    await settings.saveWatchdogButton().click();

    await expect(layout.toastMessage('Watchdog settings saved')).toBeVisible();
  });
});
