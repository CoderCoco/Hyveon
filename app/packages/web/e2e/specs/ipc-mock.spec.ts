import { test, expect, _electron } from '../fixtures/index.js';
import { electronMain, electronEnv } from '../../playwright.config.js';
import type { GameStatus } from '../fixtures/index.js';

/**
 * Proves the IPC mock seam end-to-end inside the Electron shell.
 *
 * The preload script exposes `window.gsd.__test.mock(channel, handler)` when
 * `HYVEON_TEST_MODE=1`. These specs verify that a mock registered via that
 * surface overrides the real IPC invoke path, so Playwright e2e tests can
 * control the main-process responses without modifying the main bundle.
 *
 * Each test manages its own ElectronApplication lifecycle so the spec is
 * self-contained and runnable independently of the global setup.
 */
test.describe('IPC mock seam', () => {
  test('should expose window.gsd.__test in test mode', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const hasTestSurface = await win.evaluate(
        () => typeof (window as Record<string, unknown>)['gsd'] === 'object'
          && typeof ((window as Record<string, unknown>)['gsd'] as Record<string, unknown>)['__test'] === 'object',
      );
      expect(hasTestSurface).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('should return the mocked response instead of the real IPC response', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();

      /** Canned status array returned by the mock — distinct from any real ECS response. */
      const mockedStatuses: GameStatus[] = [
        { game: 'minecraft', state: 'running', publicIp: '1.2.3.4' },
      ];

      // Register a mock for the `games.status` channel via the test seam.
      await win.evaluate((statuses) => {
        const gsd = (window as Record<string, unknown>)['gsd'] as {
          __test: { mock: (channel: string, handler: unknown) => void };
        };
        gsd.__test.mock('games.status', () => Promise.resolve(statuses));
      }, mockedStatuses);

      // Call `window.gsd.games.status()` through the normal GsdApi surface and
      // confirm the mock value comes back — not a live ECS call.
      const result = await win.evaluate(async () => {
        const gsd = (window as Record<string, unknown>)['gsd'] as {
          games: { status: () => Promise<unknown> };
        };
        return gsd.games.status();
      });

      expect(result).toEqual(mockedStatuses);
    } finally {
      await app.close();
    }
  });

  test('should allow the mock to be overridden by a second registration on the same channel', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();

      const firstStatuses: GameStatus[] = [{ game: 'valheim', state: 'stopped' }];
      const secondStatuses: GameStatus[] = [{ game: 'valheim', state: 'running', publicIp: '9.8.7.6' }];

      // Register the first mock, then override with a second.
      await win.evaluate(
        ({ first, second }) => {
          const gsd = (window as Record<string, unknown>)['gsd'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          gsd.__test.mock('games.status', () => Promise.resolve(first));
          gsd.__test.mock('games.status', () => Promise.resolve(second));
        },
        { first: firstStatuses, second: secondStatuses },
      );

      const result = await win.evaluate(async () => {
        const gsd = (window as Record<string, unknown>)['gsd'] as {
          games: { status: () => Promise<unknown> };
        };
        return gsd.games.status();
      });

      // Only the second (most-recently registered) mock should be active.
      expect(result).toEqual(secondStatuses);
    } finally {
      await app.close();
    }
  });
});
