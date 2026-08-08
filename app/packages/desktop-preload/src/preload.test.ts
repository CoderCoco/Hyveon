/**
 * Unit tests for the preload dispatcher (`preload.ts`).
 *
 * Covers three guarantees:
 *
 * 1. **Mock-override** — when a per-channel mock is registered via the
 *    `registerMock` function exposed on `hyveonBridge.__test.mock`, `invoke`
 *    calls the mock instead of `ipcRenderer.invoke`.
 * 2. **Real-IPC fallthrough** — when no mock is registered, `invoke` forwards
 *    the call to `ipcRenderer.invoke` unchanged.
 * 3. **Test-mode gating** — `hyveonBridge.__test` is present only when
 *    `HYVEON_TEST_MODE=1`; it is absent (or the bridge lacks the key) in
 *    production mode.
 *
 * Because the preload module runs all its logic at import time (calling
 * `contextBridge.exposeInMainWorld` as a side-effect), each group of tests
 * that needs a different `HYVEON_TEST_MODE` value resets the module registry
 * and re-imports the module with the appropriate env value set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HyveonStreamHandle } from './hyveon-api.js';

// ---------------------------------------------------------------------------
// Electron mock — must be declared before any dynamic import of preload.ts
// ---------------------------------------------------------------------------

/**
 * Captured arguments from `contextBridge.exposeInMainWorld` calls, keyed by
 * the world name.  The preload module always calls it with `'hyveon'`.
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
 * `contextBridge.exposeInMainWorld('hyveon', ...)`.
 *
 * The dynamic import forces the module's top-level side-effects (the
 * `contextBridge.exposeInMainWorld` call and the `isTestMode` check) to run
 * again with the current env value.
 *
 * Pass `undefined` to simulate the production case where `HYVEON_TEST_MODE` is
 * never set in the environment.
 */
async function loadPreloadBridge(testMode: '0' | '1' | undefined): Promise<Record<string, unknown>> {
  vi.resetModules();
  if (testMode === undefined) {
    delete process.env['HYVEON_TEST_MODE'];
  } else {
    process.env['HYVEON_TEST_MODE'] = testMode;
  }
  await import('./preload.js');
  return exposed['hyveon'] as Record<string, unknown>;
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

    it('should forward drift.get to ipcRenderer.invoke when no mock is registered', async () => {
      ipcInvoke.mockResolvedValue({ entries: [{ game: 'minecraft', kind: 'pending_create' }] });
      const drift = bridge['drift'] as { get: () => Promise<unknown> };
      const result = await drift.get();

      expect(ipcInvoke).toHaveBeenCalledWith('drift.get');
      expect(result).toEqual({ entries: [{ game: 'minecraft', kind: 'pending_create' }] });
    });

    it('should forward audit.list with the opts argument to ipcRenderer.invoke', async () => {
      const page = { entries: [{ sk: '2026-07-17T00:00:00.000Z#01J', timestamp: '2026-07-17T00:00:00.000Z', actor: 'user@example.com', action: 'add', game: 'minecraft', before: null, after: {} }] };
      ipcInvoke.mockResolvedValue(page);
      const audit = bridge['audit'] as { list: (opts?: { limit?: number; before?: string }) => Promise<unknown> };
      const opts = { limit: 20, before: 'cursor-value' };
      const result = await audit.list(opts);

      expect(ipcInvoke).toHaveBeenCalledWith('audit.list', opts);
      expect(result).toEqual(page);
    });

    it('should forward audit.list with no arguments when opts is omitted', async () => {
      ipcInvoke.mockResolvedValue({ entries: [] });
      const audit = bridge['audit'] as { list: (opts?: { limit?: number; before?: string }) => Promise<unknown> };
      await audit.list();

      expect(ipcInvoke).toHaveBeenCalledWith('audit.list', undefined);
    });

    it('should forward games.create with a single payload object to ipcRenderer.invoke', async () => {
      const writeResult = { ok: true, games: [] };
      ipcInvoke.mockResolvedValue(writeResult);
      const games = bridge['games'] as { create: (payload: unknown) => Promise<unknown> };
      const payload = { name: 'minecraft', config: { image: 'itzg/minecraft-server', cpu: 512, memory: 1024, ports: [], volumes: [] } };
      const result = await games.create(payload);

      expect(ipcInvoke).toHaveBeenCalledWith('games.create', payload);
      expect(result).toEqual(writeResult);
    });

    it('should forward games.update with a single payload object to ipcRenderer.invoke', async () => {
      const writeResult = { ok: true, games: [] };
      ipcInvoke.mockResolvedValue(writeResult);
      const games = bridge['games'] as { update: (payload: unknown) => Promise<unknown> };
      const payload = { name: 'minecraft', config: { image: 'itzg/minecraft-server', cpu: 512, memory: 1024, ports: [], volumes: [] } };
      const result = await games.update(payload);

      expect(ipcInvoke).toHaveBeenCalledWith('games.update', payload);
      expect(result).toEqual(writeResult);
    });

    it('should forward games.delete with a single payload object to ipcRenderer.invoke', async () => {
      const writeResult = { ok: true, games: [] };
      ipcInvoke.mockResolvedValue(writeResult);
      const games = bridge['games'] as { delete: (payload: unknown) => Promise<unknown> };
      const payload = { name: 'minecraft' };
      const result = await games.delete(payload);

      expect(ipcInvoke).toHaveBeenCalledWith('games.delete', payload);
      expect(result).toEqual(writeResult);
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

    it('should propagate a rejection from a mock handler without swallowing it', async () => {
      const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
      testApi.mock('games.list', vi.fn().mockRejectedValue(new Error('mock-error')));

      const games = bridge['games'] as { list: () => Promise<unknown> };

      await expect(games.list()).rejects.toThrow('mock-error');
      expect(ipcInvoke).not.toHaveBeenCalled();
    });

    it('should call the registered games.create mock with the single payload object instead of ipcRenderer.invoke', async () => {
      const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
      const mockHandler = vi.fn().mockResolvedValue({ ok: true, games: [] });
      testApi.mock('games.create', mockHandler);

      const games = bridge['games'] as { create: (payload: unknown) => Promise<unknown> };
      const payload = { name: 'valheim', config: { image: 'lloesche/valheim-server', cpu: 1024, memory: 2048, ports: [], volumes: [] } };
      const result = await games.create(payload);

      expect(mockHandler).toHaveBeenCalledWith(payload);
      expect(ipcInvoke).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, games: [] });
    });

    it('should call the registered games.update mock with the single payload object instead of ipcRenderer.invoke', async () => {
      const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
      const mockHandler = vi.fn().mockResolvedValue({ ok: true, games: [] });
      testApi.mock('games.update', mockHandler);

      const games = bridge['games'] as { update: (payload: unknown) => Promise<unknown> };
      const payload = { name: 'valheim', config: { image: 'lloesche/valheim-server', cpu: 1024, memory: 2048, ports: [], volumes: [] } };
      const result = await games.update(payload);

      expect(mockHandler).toHaveBeenCalledWith(payload);
      expect(ipcInvoke).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, games: [] });
    });

    it('should call the registered games.delete mock with the single payload object instead of ipcRenderer.invoke', async () => {
      const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
      const mockHandler = vi.fn().mockResolvedValue({ ok: true, games: [] });
      testApi.mock('games.delete', mockHandler);

      const games = bridge['games'] as { delete: (payload: unknown) => Promise<unknown> };
      const payload = { name: 'valheim' };
      const result = await games.delete(payload);

      expect(mockHandler).toHaveBeenCalledWith(payload);
      expect(ipcInvoke).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, games: [] });
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

    it('should not expose __test on the bridge when HYVEON_TEST_MODE is absent (production default)', async () => {
      const bridge = await loadPreloadBridge(undefined);
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

    it('should flush the mock registry when clearMocks is called so ipcRenderer.invoke is used for the channel again', async () => {
      const bridge = await loadPreloadBridge('1');
      const testApi = bridge['__test'] as {
        mock: (channel: string, handler: unknown) => void;
        clearMocks: () => void;
      };
      // Register a mock so the channel is covered.
      testApi.mock('games.list', vi.fn().mockResolvedValue({ games: ['mock-game'] }));

      // Clear all mocks — the channel should now fall through to ipcRenderer.invoke.
      testApi.clearMocks();

      ipcInvoke.mockResolvedValue({ games: ['real-game'] });
      const games = bridge['games'] as { list: () => Promise<unknown> };
      await games.list();

      expect(ipcInvoke).toHaveBeenCalledWith('games.list');
    });

    it('should flush the mock registry when reset is called so ipcRenderer.invoke is used for the channel again', async () => {
      const bridge = await loadPreloadBridge('1');
      const testApi = bridge['__test'] as {
        mock: (channel: string, handler: unknown) => void;
        reset: () => void;
      };
      // Register a mock so the channel is covered.
      testApi.mock(
        'env.get',
        vi.fn().mockResolvedValue({ region: 'us-east-1', domain: 'example.com', environment: 'dev' }),
      );

      // Reset all mocks — the channel should now fall through to ipcRenderer.invoke.
      testApi.reset();

      ipcInvoke.mockResolvedValue({ region: 'eu-west-1', domain: 'game.io', environment: 'prod' });
      const env = bridge['env'] as { get: () => Promise<unknown> };
      await env.get();

      expect(ipcInvoke).toHaveBeenCalledWith('env.get');
    });
  });

  // -------------------------------------------------------------------------
  // streamLogs
  // -------------------------------------------------------------------------

  describe('streamLogs', () => {
    /**
     * Helper to collect all chunks from a `logs.stream` {@link HyveonStreamHandle}
     * into an array. Works with a plain `for await` loop because the handle
     * exposes an own `[Symbol.asyncIterator]` returning itself — the
     * contextBridge-safe shape described in `hyveon-api.ts`.
     */
    async function collectChunks(handle: HyveonStreamHandle<string>): Promise<string[]> {
      const chunks: string[] = [];
      for await (const chunk of handle) {
        chunks.push(chunk);
      }
      return chunks;
    }

    // -----------------------------------------------------------------------
    // Mocked-delegation branch
    // -----------------------------------------------------------------------

    describe('mocked-delegation branch', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should delegate to the registered mock iterable instead of ipcRenderer when logs.stream is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* fakeStream() {
          yield 'chunk-a';
          yield 'chunk-b';
        }

        const mockHandler = vi.fn().mockReturnValue(fakeStream());
        testApi.mock('logs.stream', mockHandler);

        const logs = bridge['logs'] as { stream: (game: string) => HyveonStreamHandle<string> };
        const chunks = await collectChunks(logs.stream('valheim'));

        expect(mockHandler).toHaveBeenCalledOnce();
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(ipcSend).not.toHaveBeenCalled();
        expect(chunks).toEqual(['chunk-a', 'chunk-b']);
      });

      it('should forward the game argument and an internally-minted AbortSignal to the mock handler', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* emptyStream() {}
        const mockHandler = vi.fn().mockReturnValue(emptyStream());
        testApi.mock('logs.stream', mockHandler);

        const logs = bridge['logs'] as { stream: (game: string) => HyveonStreamHandle<string> };
        await collectChunks(logs.stream('minecraft'));

        // The renderer-facing `stream(game)` no longer accepts a caller-supplied
        // `AbortSignal` — a raw `AbortSignal` doesn't survive the contextBridge
        // clone either (see the `HyveonStreamHandle` doc comment in
        // `hyveon-api.ts`). `openLogsStream` mints its own `AbortController`
        // internally and forwards *that* signal to `streamLogs`, which is what
        // the mock receives here.
        expect(mockHandler).toHaveBeenCalledWith('minecraft', expect.any(AbortSignal));
      });

      it("should abort the mock's forwarded AbortSignal only once the returned handle is cancelled", async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* emptyStream() {}
        const mockHandler = vi.fn().mockReturnValue(emptyStream());
        testApi.mock('logs.stream', mockHandler);

        const logs = bridge['logs'] as { stream: (game: string) => HyveonStreamHandle<string> };
        const handle = logs.stream('terraria');
        await collectChunks(handle);

        const forwardedSignal = mockHandler.mock.calls[0]?.[1] as AbortSignal;
        expect(forwardedSignal.aborted).toBe(false);

        handle.cancel();

        expect(forwardedSignal.aborted).toBe(true);
      });

      it('should not attach any ipcRenderer listeners when the mock handles the stream', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* singleChunk() {
          yield 'only-chunk';
        }
        testApi.mock('logs.stream', vi.fn().mockReturnValue(singleChunk()));

        const logs = bridge['logs'] as { stream: (game: string) => HyveonStreamHandle<string> };
        await collectChunks(logs.stream('factorio'));

        expect(ipcOn).not.toHaveBeenCalled();
        expect(ipcOnce).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // Unmocked passthrough branch
    // -----------------------------------------------------------------------

    describe('unmocked passthrough branch', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        // Load with test-mode OFF so no mock registry is active — the real IPC
        // path is always exercised.
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke logs.stream on ipcRenderer to obtain a streamId when no mock is registered', async () => {
        const streamId = 'sid-001';
        ipcInvoke.mockResolvedValue({ streamId });

        // Simulate the main process sending an end event synchronously after the
        // invoke so the generator completes without hanging.
        ipcOnce.mockImplementation((_channel: string, listener: (...args: unknown[]) => void) => {
          // Fire the end event on the next microtask so the generator has
          // already attached the listener before it resolves.
          Promise.resolve().then(() => listener({} as unknown, {}));
        });

        const logs = bridge['logs'] as { stream: (game: string) => HyveonStreamHandle<string> };
        const chunks = await collectChunks(logs.stream('minecraft'));

        expect(ipcInvoke).toHaveBeenCalledWith('logs.stream', 'minecraft');
        expect(chunks).toEqual([]);
      });

      it('should yield chunks received over the chunk IPC channel', async () => {
        const streamId = 'sid-002';
        ipcInvoke.mockResolvedValue({ streamId });

        const chunkChannel = `logs.stream.${streamId}.chunk`;
        const endChannel = `logs.stream.${streamId}.end`;

        // Capture the chunk listener so we can fire chunks after setup. Held
        // in a ref object (not a bare `let`) — a `let` assigned only from
        // inside the `ipcOn.mockImplementation` closure is narrowed by
        // TypeScript's control-flow analysis to its declaration-site type
        // (`null`) at any read in this outer scope, since the compiler can't
        // see that the closure runs before the read; a mutable property on a
        // `const` object isn't subject to that narrowing.
        const capturedChunkListener: { current: ((_evt: unknown, chunk: string) => void) | null } = { current: null };
        ipcOn.mockImplementation((channel: string, listener: (_evt: unknown, chunk: string) => void) => {
          if (channel === chunkChannel) {
            capturedChunkListener.current = listener;
          }
        });

        // Fire two chunks then end the stream.
        ipcOnce.mockImplementation((channel: string, listener: (_evt: unknown, data: { error?: string }) => void) => {
          if (channel === endChannel) {
            Promise.resolve()
              .then(() => {
                capturedChunkListener.current?.({}, 'line-1');
                capturedChunkListener.current?.({}, 'line-2');
              })
              .then(() => listener({} as unknown, {}));
          }
        });

        const logs = bridge['logs'] as { stream: (game: string) => HyveonStreamHandle<string> };
        const chunks = await collectChunks(logs.stream('factorio'));

        expect(chunks).toEqual(['line-1', 'line-2']);
      });

      it('should throw when the end event carries an error field', async () => {
        const streamId = 'sid-003';
        ipcInvoke.mockResolvedValue({ streamId });

        const endChannel = `logs.stream.${streamId}.end`;

        ipcOnce.mockImplementation((channel: string, listener: (_evt: unknown, data: { error?: string }) => void) => {
          if (channel === endChannel) {
            Promise.resolve().then(() => listener({} as unknown, { error: 'stream-failed' }));
          }
        });

        const logs = bridge['logs'] as { stream: (game: string) => HyveonStreamHandle<string> };

        await expect(collectChunks(logs.stream('valheim'))).rejects.toThrow('stream-failed');
      });

      it('should send cancel immediately and remove listeners once the main process acks the cancel', async () => {
        const streamId = 'sid-004';
        ipcInvoke.mockResolvedValue({ streamId });

        const chunkChannel = `logs.stream.${streamId}.chunk`;
        const endChannel = `logs.stream.${streamId}.end`;
        const cancelChannel = `logs.stream.${streamId}.cancel`;

        // Keep the stream alive — never auto-fire the end event — so the test
        // controls exactly when the main process "acks" the cancel.
        const capturedChunkListener: { current: ((_evt: unknown, chunk: string) => void) | null } = { current: null };
        const capturedEndListener: { current: ((_evt: unknown, data: { error?: string }) => void) | null } = {
          current: null,
        };
        ipcOn.mockImplementation((channel: string, listener: (_evt: unknown, chunk: string) => void) => {
          if (channel === chunkChannel) capturedChunkListener.current = listener;
        });
        ipcOnce.mockImplementation((channel: string, listener: (_evt: unknown, data: { error?: string }) => void) => {
          if (channel === endChannel) capturedEndListener.current = listener;
        });

        const logs = bridge['logs'] as { stream: (game: string) => HyveonStreamHandle<string> };
        const handle = logs.stream('terraria');

        // Start consuming — the handle suspends at its inner `await new Promise`
        // because no chunk has arrived yet and the buffer is empty. Deliver a
        // chunk to wake it, then let that first `next()` resolve.
        const firstNext = handle.next();
        await Promise.resolve();
        capturedChunkListener.current?.({}, 'first-chunk');
        await firstNext;

        // `cancel()` is the bridge handle's only early-stop signal — unlike the
        // old raw-generator shape, the handle exposes no `return()` for a
        // `for await` `break` to call automatically, so cancellation is always
        // explicit. It should send the cancel IPC message synchronously,
        // exactly like an aborted `AbortSignal` used to.
        handle.cancel();
        expect(ipcSend).toHaveBeenCalledWith(cancelChannel);

        // Listener cleanup only happens once the underlying generator actually
        // completes — which, for `logs.stream`, means waiting for the main
        // process to ack the cancel with its own `.end` event.
        capturedEndListener.current?.({}, {});
        const finalResult = await handle.next();

        expect(finalResult.done).toBe(true);
        expect(ipcRemoveListener).toHaveBeenCalledWith(chunkChannel, expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith(endChannel, expect.any(Function));
      }, 10_000);
    });
  });

  // -------------------------------------------------------------------------
  // iac.stack.initialize
  // -------------------------------------------------------------------------

  describe('iac.stack.initialize', () => {
    /**
     * Helper to collect all phase events from an `iac.stack.initialize`
     * {@link HyveonStreamHandle} into an array.
     */
    async function collectEvents(
      handle: HyveonStreamHandle<{ phase: string; status: string }>,
    ): Promise<{ phase: string; status: string }[]> {
      const events: { phase: string; status: string }[] = [];
      for await (const event of handle) {
        events.push(event);
      }
      return events;
    }

    // -----------------------------------------------------------------------
    // Mocked-delegation branch
    // -----------------------------------------------------------------------

    describe('mocked-delegation branch', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should delegate to the registered mock iterable instead of ipcRenderer when iac.stack.initialize is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* fakeStream() {
          yield { phase: 'engine' as const, status: 'start' as const };
          yield { phase: 'engine' as const, status: 'end' as const };
        }

        const mockHandler = vi.fn().mockReturnValue(fakeStream());
        testApi.mock('iac.stack.initialize', mockHandler);

        const iac = bridge['iac'] as {
          stack: { initialize: () => HyveonStreamHandle<{ phase: string; status: string }> };
        };
        const events = await collectEvents(iac.stack.initialize());

        expect(mockHandler).toHaveBeenCalledWith(expect.any(AbortSignal));
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(ipcSend).not.toHaveBeenCalled();
        expect(events).toEqual([
          { phase: 'engine', status: 'start' },
          { phase: 'engine', status: 'end' },
        ]);
      });

      it("should abort the mock's forwarded AbortSignal only once the returned handle is cancelled", async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* emptyStream() {}
        const mockHandler = vi.fn().mockReturnValue(emptyStream());
        testApi.mock('iac.stack.initialize', mockHandler);

        const iac = bridge['iac'] as {
          stack: { initialize: () => HyveonStreamHandle<{ phase: string; status: string }> };
        };
        const handle = iac.stack.initialize();
        await collectEvents(handle);

        const forwardedSignal = mockHandler.mock.calls[0]?.[0] as AbortSignal;
        expect(forwardedSignal.aborted).toBe(false);

        handle.cancel();

        expect(forwardedSignal.aborted).toBe(true);
      });

      it('should not attach any ipcRenderer listeners when the mock handles the stream', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* emptyStream() {}
        testApi.mock('iac.stack.initialize', vi.fn().mockReturnValue(emptyStream()));

        const iac = bridge['iac'] as {
          stack: { initialize: () => HyveonStreamHandle<{ phase: string; status: string }> };
        };
        await collectEvents(iac.stack.initialize());

        expect(ipcOn).not.toHaveBeenCalled();
        expect(ipcOnce).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // Unmocked passthrough branch
    // -----------------------------------------------------------------------

    describe('unmocked passthrough branch', () => {
      let bridge: Record<string, unknown>;

      /**
       * `IacController.initializeStack` mints a per-call `streamId` and tags
       * every phase-event/end payload with it (returning the same id in the
       * invoke ack) so a second, rejected concurrent call can't
       * cross-terminate this call's stream. Tests below default to this id
       * when simulating the ack/events.
       */
      const STREAM_ID = 'sid-stack-init-1';

      /**
       * Listener signatures captured off `ipcOn.mockImplementation` calls below.
       * Named aliases (rather than a self-referential `as typeof captured...`
       * cast at the assignment site) keep these call sites typechecking
       * regardless of unrelated checker-ordering changes elsewhere in the
       * package — the self-referential cast pattern is fragile because it
       * types the assignment against the (possibly still-narrowed) type of
       * the variable being assigned.
       */
      type ChunkListener = (
        _evt: unknown,
        data: { streamId: string; phase: string; status: string },
      ) => void;
      type EndListener = (_evt: unknown, data: { streamId: string; error?: string }) => void;

      beforeEach(async () => {
        // Load with test-mode OFF so no mock registry is active — the real IPC
        // path is always exercised.
        bridge = await loadPreloadBridge('0');
      });

      it('should attach the chunk/end listeners before calling ipcRenderer.invoke so no early event is dropped', async () => {
        ipcInvoke.mockResolvedValue({ started: true, streamId: STREAM_ID });

        // Simulate the main process sending an end event synchronously after the
        // invoke so the generator completes without hanging. `iac.stack.initialize.end`
        // is registered via `ipcRenderer.on` (not `.once`), since a foreign
        // (rejected concurrent call's) end event could otherwise arrive first
        // on the same fixed channel and be consumed by a `once` listener.
        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'iac.stack.initialize.end') {
            Promise.resolve().then(() => listener({} as unknown, { streamId: STREAM_ID }));
          }
        });

        const iac = bridge['iac'] as {
          stack: { initialize: () => HyveonStreamHandle<{ phase: string; status: string }> };
        };
        await collectEvents(iac.stack.initialize());

        // Registration must happen strictly before the invoke call resolves —
        // otherwise an event sent immediately after the main process
        // acknowledges the call could be dropped.
        const firstOnCallOrder = ipcOn.mock.invocationCallOrder[0];
        const secondOnCallOrder = ipcOn.mock.invocationCallOrder[1];
        const invokeCallOrder = ipcInvoke.mock.invocationCallOrder[0];

        expect(firstOnCallOrder).toBeLessThan(invokeCallOrder);
        expect(secondOnCallOrder).toBeLessThan(invokeCallOrder);
      });

      it('should invoke iac.stack.initialize on ipcRenderer with no payload and attach chunk/end listeners', async () => {
        ipcInvoke.mockResolvedValue({ started: true, streamId: STREAM_ID });

        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'iac.stack.initialize.end') {
            Promise.resolve().then(() => listener({} as unknown, { streamId: STREAM_ID }));
          }
        });

        const iac = bridge['iac'] as {
          stack: { initialize: () => HyveonStreamHandle<{ phase: string; status: string }> };
        };
        const events = await collectEvents(iac.stack.initialize());

        expect(ipcInvoke).toHaveBeenCalledWith('iac.stack.initialize');
        expect(events).toEqual([]);
      });

      it('should yield phase events received over the iac.stack.initialize.chunk IPC channel in order', async () => {
        ipcInvoke.mockResolvedValue({ started: true, streamId: STREAM_ID });

        // Capture the chunk/end listeners so we can fire events after setup.
        // Held in a ref object (not a bare `let`) — a `let` assigned only from
        // inside the `ipcOn.mockImplementation` closure is narrowed by
        // TypeScript's control-flow analysis to its declaration-site type
        // (`null`) at any read in this outer scope, since the compiler can't
        // see that the closure runs before the read; a mutable property on a
        // `const` object isn't subject to that narrowing.
        const capturedChunkListener: { current: ChunkListener | null } = { current: null };
        const capturedEndListener: { current: EndListener | null } = { current: null };
        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'iac.stack.initialize.chunk') capturedChunkListener.current = listener as ChunkListener;
          if (channel === 'iac.stack.initialize.end') capturedEndListener.current = listener as EndListener;
        });

        const iac = bridge['iac'] as {
          stack: { initialize: () => HyveonStreamHandle<{ phase: string; status: string }> };
        };
        const collected = collectEvents(iac.stack.initialize());

        // Fire a few phase events then end the stream, all tagged with this call's streamId.
        await Promise.resolve();
        await Promise.resolve();
        capturedChunkListener.current?.({}, { streamId: STREAM_ID, phase: 'engine', status: 'start' });
        capturedChunkListener.current?.({}, { streamId: STREAM_ID, phase: 'engine', status: 'end' });
        capturedEndListener.current?.({}, { streamId: STREAM_ID });

        const events = await collected;

        expect(events).toEqual([
          { phase: 'engine', status: 'start' },
          { phase: 'engine', status: 'end' },
        ]);
      });

      it('should ignore chunk/end events tagged with a foreign streamId so a rejected concurrent call cannot cross-terminate this stream', async () => {
        ipcInvoke.mockResolvedValue({ started: true, streamId: STREAM_ID });

        // See the ref-object note in the previous test — a bare `let` here
        // reads back as narrowed-to-`null` at every call site below.
        const capturedChunkListener: { current: ChunkListener | null } = { current: null };
        const capturedEndListener: { current: EndListener | null } = { current: null };
        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'iac.stack.initialize.chunk') capturedChunkListener.current = listener as ChunkListener;
          if (channel === 'iac.stack.initialize.end') capturedEndListener.current = listener as EndListener;
        });

        const iac = bridge['iac'] as {
          stack: { initialize: () => HyveonStreamHandle<{ phase: string; status: string }> };
        };
        const collected = collectEvents(iac.stack.initialize());

        await Promise.resolve();
        await Promise.resolve();
        // A rejected, overlapping call's end event fires first, tagged with a
        // different streamId — must not terminate this stream.
        capturedEndListener.current?.({}, { streamId: 'sid-other-rejected-call', error: 'boom' });
        // Nor should a foreign event be yielded into this stream.
        capturedChunkListener.current?.({}, { streamId: 'sid-other-rejected-call', phase: 'engine', status: 'start' });
        // This call's own chunk/end events still resolve the generator normally.
        capturedChunkListener.current?.({}, { streamId: STREAM_ID, phase: 'engine', status: 'start' });
        capturedEndListener.current?.({}, { streamId: STREAM_ID });

        const events = await collected;

        expect(events).toEqual([{ phase: 'engine', status: 'start' }]);
      });

      it('should throw when the iac.stack.initialize.end event carries an error field', async () => {
        ipcInvoke.mockResolvedValue({ started: true, streamId: STREAM_ID });

        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'iac.stack.initialize.end') {
            Promise.resolve().then(() =>
              listener({} as unknown, { streamId: STREAM_ID, error: 'Pulumi stack initialization failed during the "engine" phase: boom' }),
            );
          }
        });

        const iac = bridge['iac'] as {
          stack: { initialize: () => HyveonStreamHandle<{ phase: string; status: string }> };
        };

        await expect(collectEvents(iac.stack.initialize())).rejects.toThrow(
          'Pulumi stack initialization failed during the "engine" phase: boom',
        );
      });

      it('should throw using the ack error, after cleaning up the listeners, when the invoke resolves with started: false', async () => {
        ipcInvoke.mockResolvedValue({
          started: false,
          error: 'stack initialization refused: up is already in flight; wait for it to finish before starting another operation',
        });

        const iac = bridge['iac'] as {
          stack: { initialize: () => HyveonStreamHandle<{ phase: string; status: string }> };
        };

        await expect(collectEvents(iac.stack.initialize())).rejects.toThrow(
          'stack initialization refused: up is already in flight; wait for it to finish before starting another operation',
        );

        // Listeners are attached before invoke (so no early event is dropped),
        // but must be torn down once the ack reports the run never started.
        expect(ipcOn).toHaveBeenCalledWith('iac.stack.initialize.chunk', expect.any(Function));
        expect(ipcOn).toHaveBeenCalledWith('iac.stack.initialize.end', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('iac.stack.initialize.chunk', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('iac.stack.initialize.end', expect.any(Function));
      });

      it('should remove chunk/end listeners once the stream completes', async () => {
        ipcInvoke.mockResolvedValue({ started: true, streamId: STREAM_ID });

        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'iac.stack.initialize.end') {
            Promise.resolve().then(() => listener({} as unknown, { streamId: STREAM_ID }));
          }
        });

        const iac = bridge['iac'] as {
          stack: { initialize: () => HyveonStreamHandle<{ phase: string; status: string }> };
        };
        await collectEvents(iac.stack.initialize());

        expect(ipcRemoveListener).toHaveBeenCalledWith('iac.stack.initialize.chunk', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('iac.stack.initialize.end', expect.any(Function));
      });

      // -----------------------------------------------------------------------
      // cancel()
      // -----------------------------------------------------------------------

      it('should stop yielding and clean up listeners without calling invoke when cancelled before the first next()', async () => {
        const iac = bridge['iac'] as {
          stack: { initialize: () => HyveonStreamHandle<{ phase: string; status: string }> };
        };
        const handle = iac.stack.initialize();
        // Cancelling before the underlying generator has ever run mirrors the
        // old "signal already aborted" scenario: `bridgeStream` mints the
        // `AbortController` synchronously in `openStackInitializeStream`, but
        // `streamStackInitialize`'s body (and its `signal.aborted` check) only
        // runs once the handle is actually iterated.
        handle.cancel();

        const events = await collectEvents(handle);

        expect(events).toEqual([]);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(ipcRemoveListener).toHaveBeenCalledWith('iac.stack.initialize.chunk', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('iac.stack.initialize.end', expect.any(Function));
      });

      it('should stop the stream and clean up listeners when cancelled mid-stream', async () => {
        ipcInvoke.mockResolvedValue({ started: true, streamId: STREAM_ID });

        // Keep the stream alive — never fire the end event — so the consumer
        // must be interrupted by cancel() instead.
        // See the ref-object note above — a bare `let` here reads back as
        // narrowed-to-`null` at the call site below.
        const capturedChunkListener: { current: ChunkListener | null } = { current: null };
        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'iac.stack.initialize.chunk') capturedChunkListener.current = listener as ChunkListener;
          // 'iac.stack.initialize.end' listener is captured but intentionally
          // never invoked — the stream stays open until cancel() is called.
        });

        const iac = bridge['iac'] as {
          stack: { initialize: () => HyveonStreamHandle<{ phase: string; status: string }> };
        };
        const handle = iac.stack.initialize();

        // Start consuming — it suspends at the inner `await new Promise` once
        // the ack resolves and no event has arrived yet.
        const nextPromise = handle.next();
        await Promise.resolve();
        await Promise.resolve();
        // Deliver one event to prove the stream was flowing before cancel().
        capturedChunkListener.current?.({}, { streamId: STREAM_ID, phase: 'engine', status: 'start' });
        const first = await nextPromise;
        expect(first).toEqual({ done: false, value: { phase: 'engine', status: 'start' } });

        // Now cancel — the underlying generator should stop waiting for
        // further events and complete on its own, without the main process
        // ever having to be told (there is no per-run cancel side channel
        // for `iac.stack.initialize` — see its doc comment).
        handle.cancel();
        const second = await handle.next();

        expect(second.done).toBe(true);
        expect(ipcRemoveListener).toHaveBeenCalledWith('iac.stack.initialize.chunk', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('iac.stack.initialize.end', expect.any(Function));
      }, 10_000);
    });
  });

  // -------------------------------------------------------------------------
  // iac.plan
  // -------------------------------------------------------------------------

  describe('iac.plan', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the iac.plan channel with the opts payload and resolve the started ack with a runId', async () => {
        const ack = { started: true, runId: 'run-001' };
        ipcInvoke.mockResolvedValue(ack);
        const iac = bridge['iac'] as {
          plan: (opts?: { configVersionId?: string }) => Promise<unknown>;
        };
        const opts = { configVersionId: 'v-123' };

        const result = await iac.plan(opts);

        expect(ipcInvoke).toHaveBeenCalledWith('iac.plan', opts);
        expect(result).toEqual(ack);
      });

      it('should invoke the iac.plan channel with no opts when omitted', async () => {
        ipcInvoke.mockResolvedValue({ started: true, runId: 'run-002' });
        const iac = bridge['iac'] as {
          plan: (opts?: { configVersionId?: string }) => Promise<unknown>;
        };

        await iac.plan();

        expect(ipcInvoke).toHaveBeenCalledWith('iac.plan', undefined);
      });

      it('should resolve conflict details when the shared workspace is already busy', async () => {
        const ack = {
          started: false,
          error: 'plan refused: apply is already in flight',
          conflict: 'apply' as const,
        };
        ipcInvoke.mockResolvedValue(ack);
        const iac = bridge['iac'] as {
          plan: (opts?: { configVersionId?: string }) => Promise<unknown>;
        };

        const result = await iac.plan();

        expect(result).toEqual(ack);
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when iac.plan is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const ack = { started: true, runId: 'run-mock' };
        const mockHandler = vi.fn().mockResolvedValue(ack);
        testApi.mock('iac.plan', mockHandler);

        const iac = bridge['iac'] as {
          plan: (opts?: { configVersionId?: string }) => Promise<unknown>;
        };
        const opts = { configVersionId: 'v-456' };
        const result = await iac.plan(opts);

        expect(mockHandler).toHaveBeenCalledWith(opts);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(result).toEqual(ack);
      });
    });
  });

  // -------------------------------------------------------------------------
  // iac.approve
  // -------------------------------------------------------------------------

  describe('iac.approve', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the iac.approve channel with the opts payload', async () => {
        const result = { approved: true, approvedBy: 'admin@example.com', approvedAt: '2026-07-21T00:00:00.000Z' };
        ipcInvoke.mockResolvedValue(result);
        const iac = bridge['iac'] as { approve: (opts: { planRunId: string }) => Promise<unknown> };
        const opts = { planRunId: 'run-001' };

        const response = await iac.approve(opts);

        expect(ipcInvoke).toHaveBeenCalledWith('iac.approve', opts);
        expect(response).toEqual(result);
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when iac.approve is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const result = { approved: true, approvedBy: 'admin@example.com', approvedAt: '2026-07-21T00:00:00.000Z' };
        const mockHandler = vi.fn().mockResolvedValue(result);
        testApi.mock('iac.approve', mockHandler);

        const iac = bridge['iac'] as { approve: (opts: { planRunId: string }) => Promise<unknown> };
        const opts = { planRunId: 'run-mock' };
        const response = await iac.approve(opts);

        expect(mockHandler).toHaveBeenCalledWith(opts);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(response).toEqual(result);
      });
    });
  });

  // -------------------------------------------------------------------------
  // iac.apply
  // -------------------------------------------------------------------------

  describe('iac.apply', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the iac.apply channel with the payload and resolve the started ack with a runId', async () => {
        const ack = { started: true, runId: 'run-002' };
        ipcInvoke.mockResolvedValue(ack);
        const iac = bridge['iac'] as {
          apply: (payload: { planRunId: string; planHash: string }) => Promise<unknown>;
        };
        const payload = { planRunId: 'run-001', planHash: 'sha256:abc123' };

        const result = await iac.apply(payload);

        expect(ipcInvoke).toHaveBeenCalledWith('iac.apply', payload);
        expect(result).toEqual(ack);
      });

      it('should resolve conflict details when the shared workspace is already busy', async () => {
        const ack = {
          started: false,
          error: 'pulumi apply refused: plan is already in flight',
          conflict: 'plan' as const,
        };
        ipcInvoke.mockResolvedValue(ack);
        const iac = bridge['iac'] as {
          apply: (payload: { planRunId: string; planHash: string }) => Promise<unknown>;
        };

        const result = await iac.apply({ planRunId: 'run-001', planHash: 'sha256:abc123' });

        expect(result).toEqual(ack);
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when iac.apply is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const ack = { started: true, runId: 'run-mock' };
        const mockHandler = vi.fn().mockResolvedValue(ack);
        testApi.mock('iac.apply', mockHandler);

        const iac = bridge['iac'] as {
          apply: (payload: { planRunId: string; planHash: string }) => Promise<unknown>;
        };
        const payload = { planRunId: 'run-001', planHash: 'sha256:def456' };
        const result = await iac.apply(payload);

        expect(mockHandler).toHaveBeenCalledWith(payload);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(result).toEqual(ack);
      });
    });
  });

  // -------------------------------------------------------------------------
  // iac.rollback
  // -------------------------------------------------------------------------

  describe('iac.rollback', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the iac.rollback.resolve channel with the opts payload', async () => {
        const ack = { resolved: true, versionId: 'v-prior', lastModified: '2026-07-20T00:00:00.000Z' };
        ipcInvoke.mockResolvedValue(ack);
        const rollback = (bridge['iac'] as Record<string, unknown>)['rollback'] as {
          resolve: (opts: { applyRunId: string }) => Promise<unknown>;
        };
        const opts = { applyRunId: 'apply-run-1' };

        const result = await rollback.resolve(opts);

        expect(ipcInvoke).toHaveBeenCalledWith('iac.rollback.resolve', opts);
        expect(result).toEqual(ack);
      });

      it('should invoke the iac.rollback.confirm channel with the opts payload', async () => {
        const ack = { confirmed: true, versionId: 'v-new-head' };
        ipcInvoke.mockResolvedValue(ack);
        const rollback = (bridge['iac'] as Record<string, unknown>)['rollback'] as {
          confirm: (opts: { applyRunId: string }) => Promise<unknown>;
        };
        const opts = { applyRunId: 'apply-run-1' };

        const result = await rollback.confirm(opts);

        expect(ipcInvoke).toHaveBeenCalledWith('iac.rollback.confirm', opts);
        expect(result).toEqual(ack);
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when iac.rollback.confirm is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const ack = { confirmed: true, versionId: 'v-mock-head' };
        const mockHandler = vi.fn().mockResolvedValue(ack);
        testApi.mock('iac.rollback.confirm', mockHandler);

        const rollback = (bridge['iac'] as Record<string, unknown>)['rollback'] as {
          confirm: (opts: { applyRunId: string }) => Promise<unknown>;
        };
        const opts = { applyRunId: 'apply-run-mock' };
        const result = await rollback.confirm(opts);

        expect(mockHandler).toHaveBeenCalledWith(opts);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(result).toEqual(ack);
      });
    });
  });

  // -------------------------------------------------------------------------
  // iac.settings
  // -------------------------------------------------------------------------

  describe('iac.settings', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the iac.settings.get channel with no arguments', async () => {
        const result = { ok: true, settings: { hostedZoneName: 'example.com' }, etag: 'etag-1' };
        ipcInvoke.mockResolvedValue(result);
        const settings = (bridge['iac'] as Record<string, unknown>)['settings'] as {
          get: () => Promise<unknown>;
        };

        const response = await settings.get();

        expect(ipcInvoke).toHaveBeenCalledWith('iac.settings.get');
        expect(response).toEqual(result);
      });

      it('should invoke the iac.settings.update channel with the payload', async () => {
        const result = {
          ok: true,
          settings: { hostedZoneName: 'example.com', dnsTtl: 60 },
          etag: 'etag-2',
          versionId: 'v-2',
        };
        ipcInvoke.mockResolvedValue(result);
        const settings = (bridge['iac'] as Record<string, unknown>)['settings'] as {
          update: (payload: { patch: Record<string, unknown>; expectedVersionId?: string }) => Promise<unknown>;
        };
        const payload = { patch: { dnsTtl: 60 }, expectedVersionId: 'etag-1' };

        const response = await settings.update(payload);

        expect(ipcInvoke).toHaveBeenCalledWith('iac.settings.update', payload);
        expect(response).toEqual(result);
      });

      it('should invoke the iac.settings.engineVersion channel with no arguments', async () => {
        const result = { resolvedVersion: '3.255.0' };
        ipcInvoke.mockResolvedValue(result);
        const settings = (bridge['iac'] as Record<string, unknown>)['settings'] as {
          engineVersion: () => Promise<unknown>;
        };

        const response = await settings.engineVersion();

        expect(ipcInvoke).toHaveBeenCalledWith('iac.settings.engineVersion');
        expect(response).toEqual(result);
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when iac.settings.update is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const result = { ok: false, code: 'conflict', message: 'stale etag' };
        const mockHandler = vi.fn().mockResolvedValue(result);
        testApi.mock('iac.settings.update', mockHandler);

        const settings = (bridge['iac'] as Record<string, unknown>)['settings'] as {
          update: (payload: { patch: Record<string, unknown>; expectedVersionId?: string }) => Promise<unknown>;
        };
        const payload = { patch: { dnsTtl: 60 }, expectedVersionId: 'etag-mock' };
        const response = await settings.update(payload);

        expect(mockHandler).toHaveBeenCalledWith(payload);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(response).toEqual(result);
      });

      it('should call the registered mock instead of ipcRenderer.invoke when iac.settings.engineVersion is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const result = { resolvedVersion: null };
        const mockHandler = vi.fn().mockResolvedValue(result);
        testApi.mock('iac.settings.engineVersion', mockHandler);

        const settings = (bridge['iac'] as Record<string, unknown>)['settings'] as {
          engineVersion: () => Promise<unknown>;
        };
        const response = await settings.engineVersion();

        expect(mockHandler).toHaveBeenCalledWith();
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(response).toEqual(result);
      });
    });
  });

  // -------------------------------------------------------------------------
  // iac.output
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // iac.destroy.mintToken / iac.destroy
  // -------------------------------------------------------------------------

  describe('iac.destroy.mintToken', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the iac.destroy.mintToken channel with no arguments and resolve the token', async () => {
        const ack = { token: 'destroy-token-abc' };
        ipcInvoke.mockResolvedValue(ack);
        const iac = bridge['iac'] as { mintDestroyToken: () => Promise<unknown> };

        const result = await iac.mintDestroyToken();

        expect(ipcInvoke).toHaveBeenCalledWith('iac.destroy.mintToken');
        expect(result).toEqual(ack);
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when iac.destroy.mintToken is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const ack = { token: 'destroy-token-mock' };
        const mockHandler = vi.fn().mockResolvedValue(ack);
        testApi.mock('iac.destroy.mintToken', mockHandler);

        const iac = bridge['iac'] as { mintDestroyToken: () => Promise<unknown> };
        const result = await iac.mintDestroyToken();

        expect(mockHandler).toHaveBeenCalledWith();
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(result).toEqual(ack);
      });
    });
  });

  describe('iac.destroy', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the iac.destroy channel with the payload and resolve the started ack with a runId', async () => {
        const ack = { started: true, runId: 'destroy-run-001' };
        ipcInvoke.mockResolvedValue(ack);
        const iac = bridge['iac'] as {
          destroy: (payload: { confirmationToken: string }) => Promise<unknown>;
        };
        const payload = { confirmationToken: 'destroy-token-abc' };

        const result = await iac.destroy(payload);

        expect(ipcInvoke).toHaveBeenCalledWith('iac.destroy', payload);
        expect(result).toEqual(ack);
      });

      it('should resolve conflict details when the shared workspace is already busy', async () => {
        const ack = {
          started: false,
          error: 'pulumi destroy refused: apply is already in flight',
          conflict: 'apply' as const,
        };
        ipcInvoke.mockResolvedValue(ack);
        const iac = bridge['iac'] as {
          destroy: (payload: { confirmationToken: string }) => Promise<unknown>;
        };

        const result = await iac.destroy({ confirmationToken: 'destroy-token-abc' });

        expect(result).toEqual(ack);
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when iac.destroy is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const ack = { started: true, runId: 'destroy-run-mock' };
        const mockHandler = vi.fn().mockResolvedValue(ack);
        testApi.mock('iac.destroy', mockHandler);

        const iac = bridge['iac'] as {
          destroy: (payload: { confirmationToken: string }) => Promise<unknown>;
        };
        const payload = { confirmationToken: 'destroy-token-def' };
        const result = await iac.destroy(payload);

        expect(mockHandler).toHaveBeenCalledWith(payload);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(result).toEqual(ack);
      });
    });
  });

  describe('iac.output', () => {
    /** Minimal `StackOutputs`-shaped fixture used across these tests. */
    const OUTPUTS = {
      aws_region: 'us-east-1',
      ecs_cluster_name: 'hyveon-cluster',
      ecs_cluster_arn: 'arn:aws:ecs:us-east-1:123456789012:cluster/hyveon-cluster',
      subnet_ids: 'subnet-1,subnet-2',
      security_group_id: 'sg-1',
      file_manager_security_group_id: 'sg-2',
      efs_file_system_id: 'fs-1',
      efs_access_points: { minecraft: 'fsap-1' },
      domain_name: 'example.com',
      game_names: ['minecraft'],
      discord_table_name: 'hyveon-discord',
      audit_table_name: 'hyveon-audit',
      discord_bot_token_secret_arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:bot-token',
      discord_public_key_secret_arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:public-key',
      interactions_invoke_url: null,
      discord_interactions_url: null,
      applied_game_servers: null,
    };

    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the iac.output channel with { force: true } and resolve with the typed outputs object', async () => {
        ipcInvoke.mockResolvedValue(OUTPUTS);
        const iac = bridge['iac'] as { output: (force?: boolean) => Promise<unknown> };

        const result = await iac.output(true);

        expect(ipcInvoke).toHaveBeenCalledWith('iac.output', { force: true });
        expect(result).toEqual(OUTPUTS);
      });

      it('should invoke the iac.output channel with { force: false } when force is explicitly false', async () => {
        ipcInvoke.mockResolvedValue(OUTPUTS);
        const iac = bridge['iac'] as { output: (force?: boolean) => Promise<unknown> };

        await iac.output(false);

        expect(ipcInvoke).toHaveBeenCalledWith('iac.output', { force: false });
      });

      it('should invoke the iac.output channel with { force: undefined } when no argument is supplied', async () => {
        ipcInvoke.mockResolvedValue(OUTPUTS);
        const iac = bridge['iac'] as { output: (force?: boolean) => Promise<unknown> };

        await iac.output();

        expect(ipcInvoke).toHaveBeenCalledWith('iac.output', { force: undefined });
      });

      it('should resolve with null when iac.output reports no outputs', async () => {
        ipcInvoke.mockResolvedValue(null);
        const iac = bridge['iac'] as { output: (force?: boolean) => Promise<unknown> };

        const result = await iac.output();

        expect(result).toBeNull();
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when iac.output is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const mockHandler = vi.fn().mockResolvedValue(OUTPUTS);
        testApi.mock('iac.output', mockHandler);

        const iac = bridge['iac'] as { output: (force?: boolean) => Promise<unknown> };
        const result = await iac.output(true);

        expect(mockHandler).toHaveBeenCalledWith({ force: true });
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(result).toEqual(OUTPUTS);
      });
    });
  });

  // -------------------------------------------------------------------------
  // iac.runs.get
  // -------------------------------------------------------------------------

  describe('iac.runs.get', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the iac.runs.get channel with a { runId } payload and resolve the result', async () => {
        const result = { found: true, status: 'success', record: { runId: 'run-001', kind: 'plan', startedAt: '2026-07-17T00:00:00.000Z', completedAt: '2026-07-17T00:01:00.000Z', exitCode: 0 } };
        ipcInvoke.mockResolvedValue(result);
        const iacRuns = (bridge['iac'] as { runs: { get: (runId: string) => Promise<unknown> } }).runs;

        const actual = await iacRuns.get('run-001');

        expect(ipcInvoke).toHaveBeenCalledWith('iac.runs.get', { runId: 'run-001' });
        expect(actual).toEqual(result);
      });

      it('should resolve { found: false } when the run is unknown', async () => {
        ipcInvoke.mockResolvedValue({ found: false });
        const iacRuns = (bridge['iac'] as { runs: { get: (runId: string) => Promise<unknown> } }).runs;

        const actual = await iacRuns.get('run-missing');

        expect(actual).toEqual({ found: false });
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when iac.runs.get is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const result = { found: true, status: 'running' };
        const mockHandler = vi.fn().mockResolvedValue(result);
        testApi.mock('iac.runs.get', mockHandler);

        const iacRuns = (bridge['iac'] as { runs: { get: (runId: string) => Promise<unknown> } }).runs;
        const actual = await iacRuns.get('run-002');

        expect(mockHandler).toHaveBeenCalledWith({ runId: 'run-002' });
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(actual).toEqual(result);
      });
    });
  });

  // -------------------------------------------------------------------------
  // iac.runs.list
  // -------------------------------------------------------------------------

  describe('iac.runs.list', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the iac.runs.list channel with the given opts and resolve the page', async () => {
        const page = { records: [{ sk: 's1', runId: 'run-001', kind: 'apply', status: 'success', startedAt: 't1', completedAt: 't2', exitCode: 0 }], nextBefore: 's1' };
        ipcInvoke.mockResolvedValue(page);
        const iacRuns = (bridge['iac'] as { runs: { list: (opts?: unknown) => Promise<unknown> } }).runs;

        const actual = await iacRuns.list({ limit: 10, before: 'cursor', status: 'failed' });

        expect(ipcInvoke).toHaveBeenCalledWith('iac.runs.list', { limit: 10, before: 'cursor', status: 'failed' });
        expect(actual).toEqual(page);
      });

      it('should invoke with undefined opts when called with no arguments', async () => {
        ipcInvoke.mockResolvedValue({ records: [] });
        const iacRuns = (bridge['iac'] as { runs: { list: (opts?: unknown) => Promise<unknown> } }).runs;

        await iacRuns.list();

        expect(ipcInvoke).toHaveBeenCalledWith('iac.runs.list', undefined);
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when iac.runs.list is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const page = { records: [] };
        const mockHandler = vi.fn().mockResolvedValue(page);
        testApi.mock('iac.runs.list', mockHandler);

        const iacRuns = (bridge['iac'] as { runs: { list: (opts?: unknown) => Promise<unknown> } }).runs;
        const actual = await iacRuns.list({ limit: 5 });

        expect(mockHandler).toHaveBeenCalledWith({ limit: 5 });
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(actual).toEqual(page);
      });
    });
  });

  // -------------------------------------------------------------------------
  // iac.runs.logUrl
  // -------------------------------------------------------------------------

  describe('iac.runs.logUrl', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the iac.runs.logUrl channel and unwrap { url } to a bare string', async () => {
        ipcInvoke.mockResolvedValue({ url: 'https://example.com/signed-log' });
        const iacRuns = (bridge['iac'] as {
          runs: { logUrl: (logKey: string, expiresInSeconds?: number) => Promise<string> };
        }).runs;

        const actual = await iacRuns.logUrl('runs/run-123.log', 60);

        expect(ipcInvoke).toHaveBeenCalledWith('iac.runs.logUrl', {
          logKey: 'runs/run-123.log',
          expiresInSeconds: 60,
        });
        expect(actual).toBe('https://example.com/signed-log');
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when iac.runs.logUrl is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const mockHandler = vi.fn().mockResolvedValue({ url: 'https://example.com/mocked' });
        testApi.mock('iac.runs.logUrl', mockHandler);

        const iacRuns = (bridge['iac'] as {
          runs: { logUrl: (logKey: string, expiresInSeconds?: number) => Promise<string> };
        }).runs;
        const actual = await iacRuns.logUrl('runs/run-456.log');

        expect(mockHandler).toHaveBeenCalledWith({ logKey: 'runs/run-456.log', expiresInSeconds: undefined });
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(actual).toBe('https://example.com/mocked');
      });
    });
  });

  // -------------------------------------------------------------------------
  // iac.runs.streamLogs
  // -------------------------------------------------------------------------

  describe('iac.runs.streamLogs', () => {
    /** Helper to collect all chunks from an `iac.runs.streamLogs` {@link HyveonStreamHandle} into an array. */
    async function collectChunks(
      handle: HyveonStreamHandle<{ stream: 'stdout' | 'stderr'; line: string }>,
    ): Promise<{ stream: 'stdout' | 'stderr'; line: string }[]> {
      const chunks: { stream: 'stdout' | 'stderr'; line: string }[] = [];
      for await (const chunk of handle) {
        chunks.push(chunk);
      }
      return chunks;
    }

    // -----------------------------------------------------------------------
    // Mocked-delegation branch
    // -----------------------------------------------------------------------

    describe('mocked-delegation branch', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should delegate to the registered mock iterable instead of ipcRenderer when iac.runs.logs is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* fakeStream() {
          yield { stream: 'stdout' as const, line: 'Refreshing state...' };
          yield { stream: 'stdout' as const, line: 'Plan: 1 to add, 0 to change, 0 to destroy.' };
        }

        const mockHandler = vi.fn().mockReturnValue(fakeStream());
        testApi.mock('iac.runs.logs', mockHandler);

        const iacRuns = (
          bridge['iac'] as {
            runs: {
              streamLogs: (runId: string) => HyveonStreamHandle<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        const chunks = await collectChunks(iacRuns.streamLogs('run-003'));

        expect(mockHandler).toHaveBeenCalledWith('run-003', expect.any(AbortSignal));
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(ipcSend).not.toHaveBeenCalled();
        expect(chunks).toEqual([
          { stream: 'stdout', line: 'Refreshing state...' },
          { stream: 'stdout', line: 'Plan: 1 to add, 0 to change, 0 to destroy.' },
        ]);
      });

      it("should abort the mock's forwarded AbortSignal only once the returned handle is cancelled", async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* emptyStream() {}
        const mockHandler = vi.fn().mockReturnValue(emptyStream());
        testApi.mock('iac.runs.logs', mockHandler);

        const iacRuns = (
          bridge['iac'] as {
            runs: {
              streamLogs: (runId: string) => HyveonStreamHandle<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        const handle = iacRuns.streamLogs('run-004');
        await collectChunks(handle);

        const forwardedSignal = mockHandler.mock.calls[0]?.[1] as AbortSignal;
        expect(forwardedSignal.aborted).toBe(false);

        handle.cancel();

        expect(forwardedSignal.aborted).toBe(true);
      });

      it('should not attach any ipcRenderer listeners when the mock handles the stream', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* emptyStream() {}
        testApi.mock('iac.runs.logs', vi.fn().mockReturnValue(emptyStream()));

        const iacRuns = (
          bridge['iac'] as {
            runs: {
              streamLogs: (runId: string) => HyveonStreamHandle<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        await collectChunks(iacRuns.streamLogs('run-005'));

        expect(ipcOn).not.toHaveBeenCalled();
        expect(ipcOnce).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // Unmocked passthrough branch
    // -----------------------------------------------------------------------

    describe('unmocked passthrough branch', () => {
      /**
       * `IacRunsController.logs` mints a per-call `streamId` and tags every
       * chunk/end payload with it (returning the same id in the invoke ack) so an
       * overlapping subscription to a different run's log stream can't
       * cross-terminate this call's stream. Tests below default to this id when
       * simulating the ack/events.
       */
      const STREAM_ID = 'sid-iac-runs-1';

      /** Listener signatures captured off `ipcOn.mockImplementation` calls below. */
      type ChunkListener = (
        _evt: unknown,
        data: { streamId: string; chunk: { stream: string; line: string } },
      ) => void;
      type EndListener = (_evt: unknown, data: { streamId: string; error?: string }) => void;

      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        // Load with test-mode OFF so no mock registry is active — the real IPC
        // path is always exercised.
        bridge = await loadPreloadBridge('0');
      });

      it('should attach the chunk/end listeners before calling ipcRenderer.invoke so no early chunk is dropped', async () => {
        ipcInvoke.mockResolvedValue({ streamId: STREAM_ID });

        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'iac.runs.logs.end') {
            Promise.resolve().then(() => listener({} as unknown, { streamId: STREAM_ID }));
          }
        });

        const iacRuns = (
          bridge['iac'] as {
            runs: {
              streamLogs: (runId: string) => HyveonStreamHandle<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        await collectChunks(iacRuns.streamLogs('run-006'));

        // Registration must happen strictly before the invoke call resolves —
        // otherwise a chunk sent immediately after the main process
        // acknowledges the call could be dropped.
        const firstOnCallOrder = ipcOn.mock.invocationCallOrder[0];
        const secondOnCallOrder = ipcOn.mock.invocationCallOrder[1];
        const invokeCallOrder = ipcInvoke.mock.invocationCallOrder[0];

        expect(firstOnCallOrder).toBeLessThan(invokeCallOrder);
        expect(secondOnCallOrder).toBeLessThan(invokeCallOrder);
      });

      it('should invoke iac.runs.logs on ipcRenderer with the { runId } payload', async () => {
        ipcInvoke.mockResolvedValue({ streamId: STREAM_ID });

        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'iac.runs.logs.end') {
            Promise.resolve().then(() => listener({} as unknown, { streamId: STREAM_ID }));
          }
        });

        const iacRuns = (
          bridge['iac'] as {
            runs: {
              streamLogs: (runId: string) => HyveonStreamHandle<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        const chunks = await collectChunks(iacRuns.streamLogs('run-007'));

        expect(ipcInvoke).toHaveBeenCalledWith('iac.runs.logs', { runId: 'run-007' });
        expect(chunks).toEqual([]);
      });

      it('should yield chunks received over the iac.runs.logs.chunk IPC channel in order', async () => {
        ipcInvoke.mockResolvedValue({ streamId: STREAM_ID });

        const capturedChunkListener: { current: ChunkListener | null } = { current: null };
        const capturedEndListener: { current: EndListener | null } = { current: null };
        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'iac.runs.logs.chunk') capturedChunkListener.current = listener as ChunkListener;
          if (channel === 'iac.runs.logs.end') capturedEndListener.current = listener as EndListener;
        });

        const iacRuns = (
          bridge['iac'] as {
            runs: {
              streamLogs: (runId: string) => HyveonStreamHandle<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        const collected = collectChunks(iacRuns.streamLogs('run-008'));

        await Promise.resolve();
        await Promise.resolve();
        capturedChunkListener.current?.({}, { streamId: STREAM_ID, chunk: { stream: 'stdout', line: 'Refreshing state...' } });
        capturedChunkListener.current?.({}, {
          streamId: STREAM_ID,
          chunk: { stream: 'stdout', line: 'Plan: 1 to add, 0 to change, 0 to destroy.' },
        });
        capturedEndListener.current?.({}, { streamId: STREAM_ID });

        const chunks = await collected;

        expect(chunks).toEqual([
          { stream: 'stdout', line: 'Refreshing state...' },
          { stream: 'stdout', line: 'Plan: 1 to add, 0 to change, 0 to destroy.' },
        ]);
      });

      it('should ignore chunk/end events tagged with a foreign streamId so an overlapping subscription to a different run cannot cross-terminate this stream', async () => {
        ipcInvoke.mockResolvedValue({ streamId: STREAM_ID });

        const capturedChunkListener: { current: ChunkListener | null } = { current: null };
        const capturedEndListener: { current: EndListener | null } = { current: null };
        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'iac.runs.logs.chunk') capturedChunkListener.current = listener as ChunkListener;
          if (channel === 'iac.runs.logs.end') capturedEndListener.current = listener as EndListener;
        });

        const iacRuns = (
          bridge['iac'] as {
            runs: {
              streamLogs: (runId: string) => HyveonStreamHandle<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        const collected = collectChunks(iacRuns.streamLogs('run-009'));

        await Promise.resolve();
        await Promise.resolve();
        // A subscription to a different run's log stream fires first, tagged
        // with a different streamId — must not terminate this stream.
        capturedEndListener.current?.({}, { streamId: 'sid-other-run', error: 'boom' });
        capturedChunkListener.current?.({}, { streamId: 'sid-other-run', chunk: { stream: 'stdout', line: 'not mine' } });
        // This call's own chunk/end events still resolve the generator normally.
        capturedChunkListener.current?.({}, { streamId: STREAM_ID, chunk: { stream: 'stdout', line: 'Refreshing state...' } });
        capturedEndListener.current?.({}, { streamId: STREAM_ID });

        const chunks = await collected;

        expect(chunks).toEqual([{ stream: 'stdout', line: 'Refreshing state...' }]);
      });

      it('should throw when the iac.runs.logs.end event carries an error field', async () => {
        ipcInvoke.mockResolvedValue({ streamId: STREAM_ID });

        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'iac.runs.logs.end') {
            Promise.resolve().then(() => listener({} as unknown, { streamId: STREAM_ID, error: 'run not found' }));
          }
        });

        const iacRuns = (
          bridge['iac'] as {
            runs: {
              streamLogs: (runId: string) => HyveonStreamHandle<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;

        await expect(collectChunks(iacRuns.streamLogs('run-010'))).rejects.toThrow('run not found');
      });

      it('should remove chunk/end listeners once the stream completes', async () => {
        ipcInvoke.mockResolvedValue({ streamId: STREAM_ID });

        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'iac.runs.logs.end') {
            Promise.resolve().then(() => listener({} as unknown, { streamId: STREAM_ID }));
          }
        });

        const iacRuns = (
          bridge['iac'] as {
            runs: {
              streamLogs: (runId: string) => HyveonStreamHandle<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        await collectChunks(iacRuns.streamLogs('run-011'));

        expect(ipcRemoveListener).toHaveBeenCalledWith('iac.runs.logs.chunk', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('iac.runs.logs.end', expect.any(Function));
      });

      // -----------------------------------------------------------------------
      // cancel()
      // -----------------------------------------------------------------------

      it('should stop yielding and clean up listeners without calling invoke when cancelled before the first next()', async () => {
        const iacRuns = (
          bridge['iac'] as {
            runs: {
              streamLogs: (runId: string) => HyveonStreamHandle<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        const handle = iacRuns.streamLogs('run-012');
        // Cancelling before the underlying generator has ever run mirrors the
        // old "signal already aborted" scenario — see the equivalent
        // `iac.stack.initialize` test for why this works before any IPC
        // round trip.
        handle.cancel();

        const chunks = await collectChunks(handle);

        expect(chunks).toEqual([]);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(ipcRemoveListener).toHaveBeenCalledWith('iac.runs.logs.chunk', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('iac.runs.logs.end', expect.any(Function));
      });

      it('should stop the stream and clean up listeners when cancelled mid-stream', async () => {
        ipcInvoke.mockResolvedValue({ streamId: STREAM_ID });

        const capturedChunkListener: { current: ChunkListener | null } = { current: null };
        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'iac.runs.logs.chunk') capturedChunkListener.current = listener as ChunkListener;
          // 'iac.runs.logs.end' listener is captured but intentionally
          // never invoked — the stream stays open until cancel() is called.
        });

        const iacRuns = (
          bridge['iac'] as {
            runs: {
              streamLogs: (runId: string) => HyveonStreamHandle<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        const handle = iacRuns.streamLogs('run-013');

        const nextPromise = handle.next();
        await Promise.resolve();
        await Promise.resolve();
        capturedChunkListener.current?.({}, { streamId: STREAM_ID, chunk: { stream: 'stdout', line: 'Refreshing state...' } });
        const first = await nextPromise;
        expect(first).toEqual({ done: false, value: { stream: 'stdout', line: 'Refreshing state...' } });

        handle.cancel();
        const second = await handle.next();

        expect(second.done).toBe(true);
        expect(ipcRemoveListener).toHaveBeenCalledWith('iac.runs.logs.chunk', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('iac.runs.logs.end', expect.any(Function));
      }, 10_000);
    });
  });

  // -------------------------------------------------------------------------
  // diagnostics.reportError
  // -------------------------------------------------------------------------

  describe('diagnostics.reportError', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the diagnostics.reportError channel with the message, stack, and source', async () => {
        ipcInvoke.mockResolvedValue(undefined);
        const diagnostics = bridge['diagnostics'] as {
          reportError: (
            message: string,
            stack: string | undefined,
            source: 'boundary' | 'window-error' | 'unhandled-rejection',
          ) => Promise<void>;
        };

        await diagnostics.reportError('boom', 'Error: boom\n  at x', 'boundary');

        expect(ipcInvoke).toHaveBeenCalledWith('diagnostics.reportError', {
          message: 'boom',
          stack: 'Error: boom\n  at x',
          source: 'boundary',
        });
      });

      it('should forward an undefined stack unchanged', async () => {
        ipcInvoke.mockResolvedValue(undefined);
        const diagnostics = bridge['diagnostics'] as {
          reportError: (
            message: string,
            stack: string | undefined,
            source: 'boundary' | 'window-error' | 'unhandled-rejection',
          ) => Promise<void>;
        };

        await diagnostics.reportError('rejected', undefined, 'unhandled-rejection');

        expect(ipcInvoke).toHaveBeenCalledWith('diagnostics.reportError', {
          message: 'rejected',
          stack: undefined,
          source: 'unhandled-rejection',
        });
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when diagnostics.reportError is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const mockHandler = vi.fn().mockResolvedValue(undefined);
        testApi.mock('diagnostics.reportError', mockHandler);

        const diagnostics = bridge['diagnostics'] as {
          reportError: (
            message: string,
            stack: string | undefined,
            source: 'boundary' | 'window-error' | 'unhandled-rejection',
          ) => Promise<void>;
        };
        await diagnostics.reportError('boom', undefined, 'window-error');

        expect(mockHandler).toHaveBeenCalledWith({ message: 'boom', stack: undefined, source: 'window-error' });
        expect(ipcInvoke).not.toHaveBeenCalled();
      });
    });
  });

  // -------------------------------------------------------------------------
  // diagnostics.reportLog
  // -------------------------------------------------------------------------

  describe('diagnostics.reportLog', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the diagnostics.reportLog channel with the entries and dropped count', async () => {
        ipcInvoke.mockResolvedValue(undefined);
        const diagnostics = bridge['diagnostics'] as {
          reportLog: (entries: Array<{ level: string; message: string }>, droppedCount?: number) => Promise<void>;
        };
        const entries = [{ level: 'log', message: 'hello' }];

        await diagnostics.reportLog(entries, 2);

        expect(ipcInvoke).toHaveBeenCalledWith('diagnostics.reportLog', { entries, droppedCount: 2 });
      });

      it('should forward an undefined droppedCount unchanged', async () => {
        ipcInvoke.mockResolvedValue(undefined);
        const diagnostics = bridge['diagnostics'] as {
          reportLog: (entries: Array<{ level: string; message: string }>, droppedCount?: number) => Promise<void>;
        };
        const entries = [{ level: 'error', message: 'oh no' }];

        await diagnostics.reportLog(entries);

        expect(ipcInvoke).toHaveBeenCalledWith('diagnostics.reportLog', { entries, droppedCount: undefined });
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when diagnostics.reportLog is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const mockHandler = vi.fn().mockResolvedValue(undefined);
        testApi.mock('diagnostics.reportLog', mockHandler);

        const diagnostics = bridge['diagnostics'] as {
          reportLog: (entries: Array<{ level: string; message: string }>, droppedCount?: number) => Promise<void>;
        };
        const entries = [{ level: 'warn', message: 'careful' }];
        await diagnostics.reportLog(entries, 1);

        expect(mockHandler).toHaveBeenCalledWith({ entries, droppedCount: 1 });
        expect(ipcInvoke).not.toHaveBeenCalled();
      });
    });
  });
});
