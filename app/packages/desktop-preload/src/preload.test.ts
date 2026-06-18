/**
 * Unit tests for the preload dispatcher (`preload.ts`).
 *
 * Covers three guarantees:
 *
 * 1. **Mock-override** — when a per-channel mock is registered via the
 *    `registerMock` function exposed on `gsdBridge.__test.mock`, `invoke`
 *    calls the mock instead of `ipcRenderer.invoke`.
 * 2. **Real-IPC fallthrough** — when no mock is registered, `invoke` forwards
 *    the call to `ipcRenderer.invoke` unchanged.
 * 3. **Test-mode gating** — `gsdBridge.__test` is present only when
 *    `HYVEON_TEST_MODE=1`; it is absent (or the bridge lacks the key) in
 *    production mode.
 *
 * Because the preload module runs all its logic at import time (calling
 * `contextBridge.exposeInMainWorld` as a side-effect), each group of tests
 * that needs a different `HYVEON_TEST_MODE` value resets the module registry
 * and re-imports the module with the appropriate env value set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Electron mock — must be declared before any dynamic import of preload.ts
// ---------------------------------------------------------------------------

/**
 * Captured arguments from `contextBridge.exposeInMainWorld` calls, keyed by
 * the world name.  The preload module always calls it with `'gsd'`.
 */
const exposed: Record<string, unknown> = {};

/**
 * Fake `ipcRenderer.invoke` spy — records calls and returns a controllable
 * resolved value so we can verify fallthrough behaviour.
 */
const ipcInvoke = vi.fn();

/**
 * Fake `ipcRenderer.send` spy (used by `streamLogs`; not exercised here but
 * must exist so the import doesn't throw).
 */
const ipcSend = vi.fn();

/** Fake `ipcRenderer.on` / `once` / `removeListener` — not exercised here. */
const ipcOn = vi.fn();
const ipcOnce = vi.fn();
const ipcRemoveListener = vi.fn();

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      exposed[name] = api;
    },
  },
  ipcRenderer: {
    invoke: ipcInvoke,
    send: ipcSend,
    on: ipcOn,
    once: ipcOnce,
    removeListener: ipcRemoveListener,
  },
  IpcRendererEvent: {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resets module caches and re-imports `preload.ts` with the given
 * `HYVEON_TEST_MODE` value, then returns the bridge object that was passed to
 * `contextBridge.exposeInMainWorld('gsd', ...)`.
 *
 * The dynamic import forces the module's top-level side-effects (the
 * `contextBridge.exposeInMainWorld` call and the `isTestMode` check) to run
 * again with the current env value.
 */
async function loadPreloadBridge(testMode: '0' | '1'): Promise<Record<string, unknown>> {
  vi.resetModules();
  process.env['HYVEON_TEST_MODE'] = testMode;
  await import('./preload.js');
  return exposed['gsd'] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('preload dispatcher', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['HYVEON_TEST_MODE'];
  });

  // -------------------------------------------------------------------------
  // Real-IPC fallthrough
  // -------------------------------------------------------------------------

  describe('real-IPC fallthrough', () => {
    let bridge: Record<string, unknown>;

    beforeEach(async () => {
      ipcInvoke.mockResolvedValue({ games: ['minecraft'] });
      bridge = await loadPreloadBridge('0');
    });

    it('should forward games.list to ipcRenderer.invoke when no mock is registered', async () => {
      const games = bridge['games'] as { list: () => Promise<unknown> };
      const result = await games.list();

      expect(ipcInvoke).toHaveBeenCalledOnce();
      expect(ipcInvoke).toHaveBeenCalledWith('games.list');
      expect(result).toEqual({ games: ['minecraft'] });
    });

    it('should forward games.start with the game argument to ipcRenderer.invoke', async () => {
      ipcInvoke.mockResolvedValue({ success: true, message: 'started' });
      const games = bridge['games'] as { start: (game: string) => Promise<unknown> };
      const result = await games.start('valheim');

      expect(ipcInvoke).toHaveBeenCalledWith('games.start', 'valheim');
      expect(result).toEqual({ success: true, message: 'started' });
    });

    it('should forward env.get to ipcRenderer.invoke', async () => {
      ipcInvoke.mockResolvedValue({ region: 'us-east-1', domain: 'example.com', environment: 'dev' });
      const env = bridge['env'] as { get: () => Promise<unknown> };
      await env.get();

      expect(ipcInvoke).toHaveBeenCalledWith('env.get');
    });
  });

  // -------------------------------------------------------------------------
  // Mock-override
  // -------------------------------------------------------------------------

  describe('mock-override', () => {
    let bridge: Record<string, unknown>;

    beforeEach(async () => {
      bridge = await loadPreloadBridge('1');
    });

    it('should call the registered mock instead of ipcRenderer.invoke when a mock covers the channel', async () => {
      const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
      const mockHandler = vi.fn().mockResolvedValue({ games: ['factorio'] });
      testApi.mock('games.list', mockHandler);

      const games = bridge['games'] as { list: () => Promise<unknown> };
      const result = await games.list();

      expect(mockHandler).toHaveBeenCalledOnce();
      expect(ipcInvoke).not.toHaveBeenCalled();
      expect(result).toEqual({ games: ['factorio'] });
    });

    it('should pass call arguments through to the registered mock handler', async () => {
      const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
      const mockHandler = vi.fn().mockResolvedValue({ success: true, message: 'mock-stop' });
      testApi.mock('games.stop', mockHandler);

      const games = bridge['games'] as { stop: (game: string) => Promise<unknown> };
      await games.stop('terraria');

      expect(mockHandler).toHaveBeenCalledWith('terraria');
    });

    it('should wrap a plain non-function value registered as a mock so callers receive a resolved Promise', async () => {
      const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
      // Register a plain object — not a function — as the mock return value.
      testApi.mock('env.get', { region: 'eu-west-1', domain: 'game.io', environment: 'prod' });

      const env = bridge['env'] as { get: () => Promise<unknown> };
      const result = await env.get();

      expect(ipcInvoke).not.toHaveBeenCalled();
      expect(result).toEqual({ region: 'eu-west-1', domain: 'game.io', environment: 'prod' });
    });

    it('should fall through to ipcRenderer.invoke for channels that have no mock registered', async () => {
      const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
      // Only mock games.list — env.get should still fall through.
      testApi.mock('games.list', vi.fn().mockResolvedValue({ games: [] }));

      ipcInvoke.mockResolvedValue({ region: 'ap-east-1', domain: 'srv.dev', environment: 'dev' });
      const env = bridge['env'] as { get: () => Promise<unknown> };
      await env.get();

      expect(ipcInvoke).toHaveBeenCalledWith('env.get');
    });

    it('should use a later mock when the same channel is registered twice', async () => {
      const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
      const first = vi.fn().mockResolvedValue({ games: ['first'] });
      const second = vi.fn().mockResolvedValue({ games: ['second'] });

      testApi.mock('games.list', first);
      testApi.mock('games.list', second);

      const games = bridge['games'] as { list: () => Promise<unknown> };
      const result = await games.list();

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
      expect(result).toEqual({ games: ['second'] });
    });
  });

  // -------------------------------------------------------------------------
  // Test-mode gating
  // -------------------------------------------------------------------------

  describe('test-mode gating', () => {
    it('should expose __test on the bridge when HYVEON_TEST_MODE is "1"', async () => {
      const bridge = await loadPreloadBridge('1');
      expect(bridge['__test']).toBeDefined();
    });

    it('should include a mock function on __test when HYVEON_TEST_MODE is "1"', async () => {
      const bridge = await loadPreloadBridge('1');
      const testApi = bridge['__test'] as { mock: unknown };
      expect(typeof testApi.mock).toBe('function');
    });

    it('should not expose __test on the bridge when HYVEON_TEST_MODE is "0"', async () => {
      const bridge = await loadPreloadBridge('0');
      expect(bridge['__test']).toBeUndefined();
    });

    it('should still expose all real API namespaces when HYVEON_TEST_MODE is "0"', async () => {
      const bridge = await loadPreloadBridge('0');
      expect(bridge['games']).toBeDefined();
      expect(bridge['env']).toBeDefined();
      expect(bridge['costs']).toBeDefined();
      expect(bridge['discord']).toBeDefined();
    });

    it('should still expose all real API namespaces when HYVEON_TEST_MODE is "1"', async () => {
      const bridge = await loadPreloadBridge('1');
      expect(bridge['games']).toBeDefined();
      expect(bridge['env']).toBeDefined();
      expect(bridge['costs']).toBeDefined();
      expect(bridge['discord']).toBeDefined();
    });
  });
});
