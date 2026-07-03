import { GamesController } from '@hyveon/desktop-main/dist/controllers/games.controller.js';
import { test, expect } from './index.js';

const TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/abc12345';

/**
 * Verifies that `GamesController.listStatus` picks up AWS state changes on
 * the next call without any caching getting in the way — the in-process
 * analogue of the dashboard's poller re-hitting `/api/status` on an interval.
 */
test.describe('Status polling', () => {
  test('should reflect a game transition from STOPPED to RUNNING on the next status call after mock state changes', async ({
    ipc,
    serverMocks,
  }) => {
    // Initial call — default mock behaviour (no tasks queued → stopped)
    const initial = await ipc.dispatch(GamesController, 'listStatus');
    initial.forEach((s) => expect(s.state).toBe('stopped'));

    // Push 2 RUNNING responses — one per game in the next listStatus call
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

    const next = await ipc.dispatch(GamesController, 'listStatus');
    next.forEach((s) => expect(s.state).toBe('running'));
  });
});
