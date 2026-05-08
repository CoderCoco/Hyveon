import { test, expect } from './index.js';

/**
 * ECS task ARN used as the mock "running task" across start/stop tests.
 * The value itself doesn't matter — just needs to be a non-empty string.
 */
const TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/abc12345';

test.describe('Start / Stop game server (browser)', () => {
  /**
   * Golden path: the dashboard loads, polls the real Nest server, and renders
   * both games from the tfstate fixture as STOPPED (default mock behaviour —
   * empty ListTasks queue → taskArns [] → stopped).
   */
  test('should display game cards from tfstate and show STOPPED status on initial load', async ({
    dashboard,
    serverMocks: _,
  }) => {
    void _;
    await dashboard.goto();
    await expect(dashboard.gameCardHeading('minecraft')).toBeVisible();
    await expect(dashboard.gameCardHeading('valheim')).toBeVisible();
    // At least one STOPPED badge must be visible (both games are stopped)
    await expect(dashboard.statusBadge('STOPPED').first()).toBeVisible();
  });

  /**
   * Seeds one game as RUNNING (one ListTasks response consumed by whichever
   * game's status call executes first), then verifies that exactly one Stop
   * button is rendered and that clicking it opens the confirm dialog.
   *
   * Two games call ListTasksCommand concurrently; the first dequeues the
   * RUNNING ARN and the second falls through to the default (no task → stopped).
   * The result is always one RUNNING + one STOPPED card, with exactly one Stop
   * button visible.
   */
  test('should show confirm dialog when Stop is clicked on a running game', async ({
    dashboard,
    serverMocks,
  }) => {
    await serverMocks.pushListTasks({
      type: 'success',
      data: { taskArns: [TASK_ARN] },
    });
    await serverMocks.pushDescribeTasks({
      type: 'success',
      data: { tasks: [{ taskArn: TASK_ARN, lastStatus: 'RUNNING' }] },
    });

    await dashboard.goto();

    // One game is running — its Stop button is the only one on the page
    await expect(dashboard.stopButton()).toBeVisible();
    await dashboard.stopButton().click();

    // Confirmation dialog must appear with the game name in the heading.
    // Radix AlertDialog renders with role="alertdialog", not "dialog".
    await expect(dashboard.page.getByRole('alertdialog')).toBeVisible();
    await expect(dashboard.page.getByRole('heading', { name: /Stop .+\?/ })).toBeVisible();
  });
});
