import { test, expect } from './index.js';

const BASE = 'http://localhost:3002';
const HEADERS = { Authorization: 'Bearer test-token' };

/**
 * Verifies that AWS SDK errors surfaced by the mock store propagate through
 * the Nest server as structured `{ success: false, message }` responses rather
 * than crashing the server or returning an HTTP error status.
 *
 * The mock interceptor in `test-main.ts` throws an Error with the `name` field
 * set to the `code` value, mirroring the real AWS SDK exception shape. Nest's
 * `EcsService.start()` catch block converts that to the message string via
 * `String(err)` → `"<name>: <message>"`.
 */
test.describe('Error propagation', () => {
  test('should surface RunTask AccessDeniedException as a failed start response', async ({
    request,
    serverMocks,
  }) => {
    await serverMocks.pushRunTask({
      type: 'error',
      code: 'AccessDeniedException',
      message: 'User is not authorized to perform ecs:RunTask',
    });

    // findRunningTask() uses the default empty-queue ListTasks response (no
    // existing task), so start() proceeds to RunTask where the error fires.
    const resp = await request.post(`${BASE}/api/start/minecraft`, { headers: HEADERS });

    // Nest POST routes return 201 by default — the error is encoded in the body.
    expect(resp.status()).toBe(201);
    const body = await resp.json() as { success: boolean; message: string };
    expect(body.success).toBe(false);
    expect(body.message).toContain('AccessDeniedException');
  });
});
