import {
  test,
  expect,
  stubApis,
  STOPPED_GAME,
  RUNNING_GAME,
  MULTI_GAME_STATUSES,
} from '../fixtures/index.js';


test.describe('dashboard', () => {
  test('should render a game card for a stopped game', async ({ dashboard }) => {
    await stubApis(dashboard.page, { statuses: [STOPPED_GAME] });
    await dashboard.goto();

    await expect(dashboard.gameCardHeading('minecraft')).toBeVisible();
    await expect(dashboard.statusBadge('STOPPED')).toBeVisible();
  });

  test('should render a game card for a running game with IP', async ({ dashboard }) => {
    await stubApis(dashboard.page, { statuses: [RUNNING_GAME] });
    await dashboard.goto();

    await expect(dashboard.statusBadge('RUNNING')).toBeVisible();
    await expect(dashboard.page.getByText('minecraft.example.com')).toBeVisible();
  });

  test('should render multiple game cards', async ({ dashboard }) => {
    await stubApis(dashboard.page, { statuses: MULTI_GAME_STATUSES });
    await dashboard.goto();

    await expect(dashboard.gameCardHeading('minecraft')).toBeVisible();
    await expect(dashboard.gameCardHeading('valheim')).toBeVisible();
  });

  test('should show empty-state message when no games are configured', async ({ dashboard }) => {
    await stubApis(dashboard.page, { statuses: [] });
    await dashboard.goto();

    await expect(dashboard.emptyConfiguredMessage()).toBeVisible();
  });

  test('should fire POST /api/start/:game when Start is clicked', async ({ dashboard }) => {
    await stubApis(dashboard.page, { statuses: [STOPPED_GAME] });

    let startCalled = false;
    await dashboard.page.route('**/api/start/minecraft', (route) => {
      startCalled = true;
      return route.fulfill({ json: { success: true, message: 'Started' } });
    });

    await dashboard.goto();
    await dashboard.startButton().click();

    await expect.poll(() => startCalled).toBe(true);
  });

  test('should show only Stop as the primary action for a running game', async ({ dashboard }) => {
    await stubApis(dashboard.page, { statuses: [RUNNING_GAME] });
    await dashboard.goto();

    // The redesigned card swaps the primary CTA based on state instead of
    // disabling the inactive button — Start should not exist while running.
    await expect(dashboard.stopButton()).toBeEnabled();
    await expect(dashboard.startButton()).toHaveCount(0);
  });

  test('should filter game cards by name in real time', async ({ dashboard }) => {
    await stubApis(dashboard.page, { statuses: MULTI_GAME_STATUSES });
    await dashboard.goto();

    await expect(dashboard.gameCardHeading('minecraft')).toBeVisible();
    await expect(dashboard.gameCardHeading('valheim')).toBeVisible();

    await dashboard.filter('valheim');

    await expect(dashboard.gameCardHeading('minecraft')).toHaveCount(0);
    await expect(dashboard.gameCardHeading('valheim')).toBeVisible();
  });

  test('should show empty-state message when search has no matches', async ({ dashboard }) => {
    await stubApis(dashboard.page, { statuses: MULTI_GAME_STATUSES });
    await dashboard.goto();

    await dashboard.filter('nonexistent');
    await expect(dashboard.emptySearchMessage()).toBeVisible();
  });

  test('should render the KPI strip with the four ops tiles', async ({ dashboard }) => {
    await stubApis(dashboard.page, { statuses: MULTI_GAME_STATUSES });
    await dashboard.goto();

    await expect(dashboard.kpiTileLabel('Servers running')).toBeVisible();
    await expect(dashboard.kpiTileLabel('Spend today')).toBeVisible();
    await expect(dashboard.kpiTileLabel('Forecast MTD')).toBeVisible();
    await expect(dashboard.kpiTileLabel('Active alerts')).toBeVisible();
    // 1 of 2 games are running in MULTI_GAME_STATUSES (valheim).
    await expect(dashboard.serversRunningValue('1/2')).toBeVisible();
  });

  test('should navigate to the Logs page via sidebar', async ({ dashboard, layout }) => {
    await stubApis(dashboard.page, { statuses: [] });
    await dashboard.goto();

    await layout.navigateTo('Logs', '/logs');
    // The /logs route is no longer a placeholder — verify the redesigned
    // page actually renders so a regression to the placeholder breaks here.
    await expect(dashboard.page.getByRole('heading', { name: 'Server Logs' })).toBeVisible();
  });

  test('should navigate to the Discord page via sidebar', async ({ dashboard, layout }) => {
    await stubApis(dashboard.page, { statuses: [] });
    await dashboard.goto();

    await layout.navigateTo('Discord', '/discord');
  });

  test('should navigate to the Settings page via sidebar', async ({ dashboard, layout }) => {
    await stubApis(dashboard.page, { statuses: [] });
    await dashboard.goto();

    await layout.navigateTo('Settings', '/settings');
  });

  test('should show a success toast after starting a game', async ({ dashboard, layout }) => {
    await stubApis(dashboard.page, { statuses: [STOPPED_GAME] });
    await dashboard.goto();

    await dashboard.startButton().click();

    await expect(layout.toastMessage('minecraft is starting')).toBeVisible();
  });

  test('should show a stop toast with an Undo button after stopping a game', async ({ dashboard, layout }) => {
    await stubApis(dashboard.page, { statuses: [RUNNING_GAME] });
    await dashboard.goto();

    await dashboard.stopButton().click();

    // ConfirmDialog appears — confirm the stop.
    await dashboard.page.getByRole('button', { name: /stop server/i }).click();

    await expect(layout.toastMessage('minecraft stopped')).toBeVisible();
    await expect(layout.toastUndoButton()).toBeVisible();
  });
});
