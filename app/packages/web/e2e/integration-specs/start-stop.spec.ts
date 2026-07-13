import { GamesController } from '@hyveon/desktop-main/dist/controllers/games.controller.js';
import { test, expect } from './index.js';

/**
 * ECS task ARN used as the mock "running task" across start/stop tests.
 * The value itself doesn't matter — just needs to be a non-empty string.
 */
const TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/abc12345';

test.describe('Start / Stop game server', () => {
  /**
   * Golden path: `GamesController.listGames` returns both games from the
   * tfstate fixture, and `listStatus` reports them as STOPPED — default mock
   * behaviour (empty ListTasks queue → taskArns [] → stopped).
   */
  test('should list games from tfstate and report STOPPED status on initial load', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    const { games } = await ipc.dispatch(GamesController, 'listGames');
    // No terraform.tfvars is present in the test environment, so every game
    // in the merged list is deployed-only (declared: false, deployed: true).
    expect(games.map((g) => g.name).sort()).toEqual(['minecraft', 'valheim']);
    games.forEach((g) => {
      expect(g.declared).toBe(false);
      expect(g.deployed).toBe(true);
    });

    const statuses = await ipc.dispatch(GamesController, 'listStatus');
    expect(statuses.map((s) => s.game).sort()).toEqual(['minecraft', 'valheim']);
    statuses.forEach((s) => expect(s.state).toBe('stopped'));
  });

  /**
   * Seeds a running task for one game (one ListTasks/DescribeTasks pair
   * consumed by `getStatus`), verifies the status flips to RUNNING, then
   * seeds a second pair for `stop()`'s own `findRunningTask` lookup and
   * verifies the stop call succeeds.
   */
  test('should stop a running game once ECS reports it as RUNNING', async ({
    ipc,
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

    const status = await ipc.dispatch(GamesController, 'getStatus', 'minecraft');
    expect(status.state).toBe('running');

    // stop() re-queries ECS for the running task via its own findRunningTask
    // call — seed the same lookup pair again.
    await serverMocks.pushListTasks({
      type: 'success',
      data: { taskArns: [TASK_ARN] },
    });
    await serverMocks.pushDescribeTasks({
      type: 'success',
      data: { tasks: [{ taskArn: TASK_ARN, lastStatus: 'RUNNING' }] },
    });

    const result = await ipc.dispatch(GamesController, 'stop', 'minecraft');
    expect(result).toMatchObject({ success: true });
  });
});
