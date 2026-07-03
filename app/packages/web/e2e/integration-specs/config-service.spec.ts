import { EnvController } from '@hyveon/desktop-main/dist/controllers/env.controller.js';
import { GamesController } from '@hyveon/desktop-main/dist/controllers/games.controller.js';
import { test, expect } from './index.js';

/**
 * Verifies that ConfigService correctly reads from the synthetic tfstate fixture
 * (`e2e/fixtures/tfstate.fixture.json`) injected via `TF_STATE_PATH` when the
 * `ipc` harness boots. Dispatches straight to the IPC controllers — no HTTP
 * server and no BrowserWindow involved.
 */
test.describe('ConfigService — tfstate fixture', () => {
  test('should return aws_region and domain from tfstate fixture', async ({ ipc, serverMocks: _reset }) => {
    const body = await ipc.dispatch(EnvController, 'getEnv');
    expect(body.region).toBe('us-east-1');
    expect(body.domain).toBe('test.example.com');
    // 'PROD' is derived when domain_name is non-empty
    expect(body.environment).toBe('PROD');
  });

  test('should return game names from tfstate fixture', async ({ ipc, serverMocks: _reset }) => {
    const body = await ipc.dispatch(GamesController, 'listGames');
    expect(body.games).toEqual(['minecraft', 'valheim']);
  });

  test('should return status entries for all games in tfstate fixture', async ({ ipc, serverMocks: _reset }) => {
    const statuses = await ipc.dispatch(GamesController, 'listStatus');
    // Default mock state — no queued ListTasks responses → empty taskArns → stopped
    expect(statuses.map((s) => s.game).sort()).toEqual(['minecraft', 'valheim']);
    statuses.forEach((s) => expect(s.state).toBe('stopped'));
  });
});
