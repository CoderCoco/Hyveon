import { test, expect, _electron } from '../fixtures/index.js';
import { electronMain, electronEnv } from '../../playwright.config.js';

/**
 * Regression spec for #277: unmocked renderer→main IPC round-trip.
 *
 * `ElectronIPCTransport.listen()` only wires NestJS `@MessagePattern` handlers
 * onto its own internal dispatcher — it never calls `ipcMain.handle` itself.
 * Before the fix, every channel other than the self-bridged `logs.stream`
 * hung forever when invoked from the renderer because `ipcRenderer.invoke`
 * has no matching `ipcMain.handle` registration, and the preload's invoke
 * wrapper rejects with "No handler registered for '<channel>'" once its
 * timeout elapses.
 *
 * This spec deliberately does NOT register a `window.gsd.__test.mock()`
 * override for `env.get` — it exercises the real IPC path end-to-end against
 * the actual `EnvController` running in the main process, proving
 * `registerIpcMainBridges` keeps the renderer and main process wired
 * together.
 */
test.describe('electron IPC round-trip (unmocked)', () => {
  test('should resolve window.gsd.env.get() against the real main process instead of rejecting', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();

      const result = await win.evaluate(async () => {
        const gsd = (window as Record<string, unknown>)['gsd'] as {
          env: { get: () => Promise<{ region: string; domain: string; environment: string }> };
        };
        return gsd.env.get();
      });

      expect(result).toMatchObject({
        region: expect.any(String),
        domain: expect.any(String),
        environment: expect.any(String),
      });
    } finally {
      await app.close();
    }
  });
});
