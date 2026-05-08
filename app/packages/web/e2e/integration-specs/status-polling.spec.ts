import { test, expect } from './index.js';

const TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/abc12345';

/**
 * Verifies that the dashboard's status poller picks up AWS state changes
 * without a page reload. The integration build sets VITE_STATUS_POLL_MS=3000
 * so the test can push new mock responses after the initial load and observe
 * the badge transition within a generous timeout.
 */
test.describe('Status polling', () => {
  test('should update game badge from STOPPED to RUNNING after mock state changes', async ({
    dashboard,
    serverMocks,
  }) => {
    // Navigate — initial poll fires immediately on mount (default: no tasks → stopped)
    await dashboard.goto();
    await expect(dashboard.statusBadge('STOPPED').first()).toBeVisible();

    // Push 2 RUNNING responses — one per game in the next concurrent poll
    for (let i = 0; i < 2; i++) {
      await serverMocks.pushListTasks({
        type: 'success',
        data: { taskArns: [TASK_ARN] },
      });
      await serverMocks.pushDescribeTasks({
        type: 'success',
        data: { tasks: [{ taskArn: TASK_ARN, lastStatus: 'RUNNING' }] },
      });
    }

    // The next poll (≤3 s) consumes the RUNNING responses and updates the badges
    await expect(dashboard.statusBadge('RUNNING').first()).toBeVisible({ timeout: 10_000 });
  });
});
