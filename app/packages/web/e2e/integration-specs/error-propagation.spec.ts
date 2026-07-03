import { GamesController } from '@hyveon/desktop-main/dist/controllers/games.controller.js';
import { test, expect } from './index.js';

/**
 * Verifies that AWS SDK errors surfaced by the mock store propagate through
 * `GamesController.start` as a structured `{ success: false, message }` result
 * rather than throwing or crashing the process.
 *
 * The mock interceptor in `test-mocks/ecs-mock.ts` throws an Error with the
 * `name` field set to the `code` value, mirroring the real AWS SDK exception
 * shape. `EcsService.start()`'s catch block converts that to the message
 * string via `String(err)` → `"<name>: <message>"`.
 *
 * `GamesController.start` is the IPC handler backing the Electron `games.start`
 * channel; the HTTP shim (`GamesHttpController`) delegates to the same
 * `EcsService`, so this spec exercises the real error-propagation path.
 */
test.describe('Error propagation', () => {
  test('should surface RunTask AccessDeniedException as a failed start response', async ({
    ipc,
    serverMocks,
  }) => {
    await serverMocks.pushRunTask({
      type: 'error',
      code: 'AccessDeniedException',
      message: 'User is not authorized to perform ecs:RunTask',
    });

    // findRunningTask() uses the default empty-queue ListTasks response (no
    // existing task), so start() proceeds to RunTask where the error fires.
    const result = await ipc.dispatch(GamesController, 'start', 'minecraft');

    expect(result.success).toBe(false);
    expect(result.message).toContain('AccessDeniedException');
  });
});
