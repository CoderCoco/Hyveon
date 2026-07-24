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
     * Helper to collect all chunks from the `logs.stream` async iterable into
     * an array.  Drives the generator to completion without a `for await` loop
     * so we can also exercise early-break behaviour in a separate test.
     */
    async function collectChunks(iterable: AsyncIterable<string>): Promise<string[]> {
      const chunks: string[] = [];
      for await (const chunk of iterable) {
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

        const logs = bridge['logs'] as { stream: (game: string, signal?: AbortSignal) => AsyncIterable<string> };
        const chunks = await collectChunks(logs.stream('valheim'));

        expect(mockHandler).toHaveBeenCalledOnce();
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(ipcSend).not.toHaveBeenCalled();
        expect(chunks).toEqual(['chunk-a', 'chunk-b']);
      });

      it('should forward the game argument to the mock handler', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* emptyStream() {}
        const mockHandler = vi.fn().mockReturnValue(emptyStream());
        testApi.mock('logs.stream', mockHandler);

        const logs = bridge['logs'] as { stream: (game: string, signal?: AbortSignal) => AsyncIterable<string> };
        await collectChunks(logs.stream('minecraft'));

        expect(mockHandler).toHaveBeenCalledWith('minecraft', undefined);
      });

      it('should forward the AbortSignal to the mock handler when one is provided', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* emptyStream() {}
        const mockHandler = vi.fn().mockReturnValue(emptyStream());
        testApi.mock('logs.stream', mockHandler);

        const controller = new AbortController();
        const logs = bridge['logs'] as { stream: (game: string, signal?: AbortSignal) => AsyncIterable<string> };
        await collectChunks(logs.stream('terraria', controller.signal));

        expect(mockHandler).toHaveBeenCalledWith('terraria', controller.signal);
      });

      it('should not attach any ipcRenderer listeners when the mock handles the stream', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* singleChunk() {
          yield 'only-chunk';
        }
        testApi.mock('logs.stream', vi.fn().mockReturnValue(singleChunk()));

        const logs = bridge['logs'] as { stream: (game: string, signal?: AbortSignal) => AsyncIterable<string> };
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

        const logs = bridge['logs'] as { stream: (game: string, signal?: AbortSignal) => AsyncIterable<string> };
        const chunks = await collectChunks(logs.stream('minecraft'));

        expect(ipcInvoke).toHaveBeenCalledWith('logs.stream', 'minecraft');
        expect(chunks).toEqual([]);
      });

      it('should yield chunks received over the chunk IPC channel', async () => {
        const streamId = 'sid-002';
        ipcInvoke.mockResolvedValue({ streamId });

        const chunkChannel = `logs.stream.${streamId}.chunk`;
        const endChannel = `logs.stream.${streamId}.end`;

        // Capture the chunk listener so we can fire chunks after setup.
        let capturedChunkListener: ((_evt: unknown, chunk: string) => void) | null = null;
        ipcOn.mockImplementation((channel: string, listener: (_evt: unknown, chunk: string) => void) => {
          if (channel === chunkChannel) {
            capturedChunkListener = listener;
          }
        });

        // Fire two chunks then end the stream.
        ipcOnce.mockImplementation((channel: string, listener: (_evt: unknown, data: { error?: string }) => void) => {
          if (channel === endChannel) {
            Promise.resolve()
              .then(() => {
                capturedChunkListener?.({}, 'line-1');
                capturedChunkListener?.({}, 'line-2');
              })
              .then(() => listener({} as unknown, {}));
          }
        });

        const logs = bridge['logs'] as { stream: (game: string, signal?: AbortSignal) => AsyncIterable<string> };
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

        const logs = bridge['logs'] as { stream: (game: string, signal?: AbortSignal) => AsyncIterable<string> };

        await expect(collectChunks(logs.stream('valheim'))).rejects.toThrow('stream-failed');
      });

      it('should send cancel and remove listeners when the consumer breaks early', async () => {
        const streamId = 'sid-004';
        ipcInvoke.mockResolvedValue({ streamId });

        const chunkChannel = `logs.stream.${streamId}.chunk`;
        const cancelChannel = `logs.stream.${streamId}.cancel`;

        // Keep the stream alive — never fire the end event — so the consumer
        // must break out of the loop manually.
        let capturedChunkListener: ((_evt: unknown, chunk: string) => void) | null = null;
        ipcOn.mockImplementation((channel: string, listener: (_evt: unknown, chunk: string) => void) => {
          if (channel === chunkChannel) capturedChunkListener = listener;
        });
        ipcOnce.mockImplementation(
          (_channel: string, _listener: (_evt: unknown, data: { error?: string }) => void) => {
            // Never fires — stream stays open until consumer breaks.
          },
        );

        const logs = bridge['logs'] as { stream: (game: string, signal?: AbortSignal) => AsyncIterable<string> };
        const gen = logs.stream('terraria')[Symbol.asyncIterator]();

        // Call next() to start the generator — it will suspend at the inner
        // `await new Promise` because no chunk has arrived yet and the buffer
        // is empty.  Deliver a chunk to wake it, then immediately return.
        const nextPromise = gen.next();
        // Flush the ipcInvoke promise so the generator reaches its first await.
        await Promise.resolve();
        // Now fire a chunk to wake the suspended generator.
        capturedChunkListener?.({}, 'first-chunk');
        // Let the generator resume and yield the chunk.
        await nextPromise;
        // The generator is now at its next inner await (waiting for more chunks).
        // Calling return() interrupts it and triggers the finally block.
        await gen.return!(undefined);

        expect(ipcSend).toHaveBeenCalledWith(cancelChannel);
        expect(ipcRemoveListener).toHaveBeenCalledWith(chunkChannel, expect.any(Function));
      }, 10_000);
    });
  });

  // -------------------------------------------------------------------------
  // terraform.init
  // -------------------------------------------------------------------------

  describe('terraform.init', () => {
    /**
     * Helper to collect all chunks from the `terraform.init` async iterable
     * into an array.
     */
    async function collectChunks(
      iterable: AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>,
    ): Promise<{ stream: 'stdout' | 'stderr'; line: string }[]> {
      const chunks: { stream: 'stdout' | 'stderr'; line: string }[] = [];
      for await (const chunk of iterable) {
        chunks.push(chunk);
      }
      return chunks;
    }

    const CONFIG = { bucket: 'my-bucket', region: 'us-east-1', dynamodbTable: 'my-lock-table' };

    // -----------------------------------------------------------------------
    // Mocked-delegation branch
    // -----------------------------------------------------------------------

    describe('mocked-delegation branch', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should delegate to the registered mock iterable instead of ipcRenderer when terraform.init is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* fakeStream() {
          yield { stream: 'stdout' as const, line: 'Initializing backend...' };
          yield { stream: 'stdout' as const, line: 'Terraform has been successfully initialized!' };
        }

        const mockHandler = vi.fn().mockReturnValue(fakeStream());
        testApi.mock('terraform.init', mockHandler);

        const terraform = bridge['terraform'] as {
          init: (config: unknown, signal?: AbortSignal) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
        };
        const chunks = await collectChunks(terraform.init(CONFIG));

        expect(mockHandler).toHaveBeenCalledWith(CONFIG, undefined);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(ipcSend).not.toHaveBeenCalled();
        expect(chunks).toEqual([
          { stream: 'stdout', line: 'Initializing backend...' },
          { stream: 'stdout', line: 'Terraform has been successfully initialized!' },
        ]);
      });

      it('should forward the AbortSignal to the mock handler when one is provided', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* emptyStream() {}
        const mockHandler = vi.fn().mockReturnValue(emptyStream());
        testApi.mock('terraform.init', mockHandler);

        const controller = new AbortController();
        const terraform = bridge['terraform'] as {
          init: (config: unknown, signal?: AbortSignal) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
        };
        await collectChunks(terraform.init(CONFIG, controller.signal));

        expect(mockHandler).toHaveBeenCalledWith(CONFIG, controller.signal);
      });

      it('should not attach any ipcRenderer listeners when the mock handles the stream', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* emptyStream() {}
        testApi.mock('terraform.init', vi.fn().mockReturnValue(emptyStream()));

        const terraform = bridge['terraform'] as {
          init: (config: unknown) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
        };
        await collectChunks(terraform.init(CONFIG));

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
       * `TerraformController.init` mints a per-call `streamId` and tags every
       * chunk/end payload with it (returning the same id in the invoke ack) so
       * a second, rejected concurrent call can't cross-terminate this call's
       * stream. Tests below default to this id when simulating the ack/events.
       */
      const STREAM_ID = 'sid-terraform-1';

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
        data: { streamId: string; chunk: { stream: string; line: string } },
      ) => void;
      type EndListener = (_evt: unknown, data: { streamId: string; exitCode: number | null; error?: string }) => void;

      beforeEach(async () => {
        // Load with test-mode OFF so no mock registry is active — the real IPC
        // path is always exercised.
        bridge = await loadPreloadBridge('0');
      });

      it('should attach the chunk/end listeners before calling ipcRenderer.invoke so no early chunk is dropped', async () => {
        ipcInvoke.mockResolvedValue({ started: true, streamId: STREAM_ID });

        // Simulate the main process sending an end event synchronously after the
        // invoke so the generator completes without hanging. `terraform.init.end`
        // is registered via `ipcRenderer.on` (not `.once`), since a foreign
        // (rejected concurrent call's) end event could otherwise arrive first
        // on the same fixed channel and be consumed by a `once` listener.
        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'terraform.init.end') {
            Promise.resolve().then(() => listener({} as unknown, { streamId: STREAM_ID, exitCode: 0 }));
          }
        });

        const terraform = bridge['terraform'] as {
          init: (config: unknown) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
        };
        await collectChunks(terraform.init(CONFIG));

        // Registration must happen strictly before the invoke call resolves —
        // otherwise a chunk sent immediately after the main process
        // acknowledges the call could be dropped.
        const firstOnCallOrder = ipcOn.mock.invocationCallOrder[0];
        const secondOnCallOrder = ipcOn.mock.invocationCallOrder[1];
        const invokeCallOrder = ipcInvoke.mock.invocationCallOrder[0];

        expect(firstOnCallOrder).toBeLessThan(invokeCallOrder);
        expect(secondOnCallOrder).toBeLessThan(invokeCallOrder);
      });

      it('should invoke terraform.init on ipcRenderer with the config and attach chunk/end listeners', async () => {
        ipcInvoke.mockResolvedValue({ started: true, streamId: STREAM_ID });

        // Simulate the main process sending an end event synchronously after the
        // invoke so the generator completes without hanging.
        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'terraform.init.end') {
            Promise.resolve().then(() => listener({} as unknown, { streamId: STREAM_ID, exitCode: 0 }));
          }
        });

        const terraform = bridge['terraform'] as {
          init: (config: unknown) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
        };
        const chunks = await collectChunks(terraform.init(CONFIG));

        expect(ipcInvoke).toHaveBeenCalledWith('terraform.init', CONFIG);
        expect(chunks).toEqual([]);
      });

      it('should yield chunks received over the terraform.init.chunk IPC channel in order', async () => {
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
          if (channel === 'terraform.init.chunk') capturedChunkListener.current = listener as ChunkListener;
          if (channel === 'terraform.init.end') capturedEndListener.current = listener as EndListener;
        });

        const terraform = bridge['terraform'] as {
          init: (config: unknown) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
        };
        const collected = collectChunks(terraform.init(CONFIG));

        // Fire two chunks then end the stream, all tagged with this call's streamId.
        await Promise.resolve();
        await Promise.resolve();
        capturedChunkListener.current?.({}, { streamId: STREAM_ID, chunk: { stream: 'stdout', line: 'Initializing backend...' } });
        capturedChunkListener.current?.({}, {
          streamId: STREAM_ID,
          chunk: { stream: 'stdout', line: 'Terraform has been successfully initialized!' },
        });
        capturedEndListener.current?.({}, { streamId: STREAM_ID, exitCode: 0 });

        const chunks = await collected;

        expect(chunks).toEqual([
          { stream: 'stdout', line: 'Initializing backend...' },
          { stream: 'stdout', line: 'Terraform has been successfully initialized!' },
        ]);
      });

      it('should ignore chunk/end events tagged with a foreign streamId so a rejected concurrent call cannot cross-terminate this stream', async () => {
        ipcInvoke.mockResolvedValue({ started: true, streamId: STREAM_ID });

        // See the ref-object note in the previous test — a bare `let` here
        // reads back as narrowed-to-`null` at every call site below.
        const capturedChunkListener: { current: ChunkListener | null } = { current: null };
        const capturedEndListener: { current: EndListener | null } = { current: null };
        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'terraform.init.chunk') capturedChunkListener.current = listener as ChunkListener;
          if (channel === 'terraform.init.end') capturedEndListener.current = listener as EndListener;
        });

        const terraform = bridge['terraform'] as {
          init: (config: unknown) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
        };
        const collected = collectChunks(terraform.init(CONFIG));

        await Promise.resolve();
        await Promise.resolve();
        // A rejected, overlapping call's end event fires first, tagged with a
        // different streamId — must not terminate this stream.
        capturedEndListener.current?.({}, { streamId: 'sid-other-rejected-call', exitCode: null, error: 'boom' });
        // Nor should a foreign chunk be yielded into this stream.
        capturedChunkListener.current?.({}, { streamId: 'sid-other-rejected-call', chunk: { stream: 'stdout', line: 'not mine' } });
        // This call's own chunk/end events still resolve the generator normally.
        capturedChunkListener.current?.({}, { streamId: STREAM_ID, chunk: { stream: 'stdout', line: 'Initializing backend...' } });
        capturedEndListener.current?.({}, { streamId: STREAM_ID, exitCode: 0 });

        const chunks = await collected;

        expect(chunks).toEqual([{ stream: 'stdout', line: 'Initializing backend...' }]);
      });

      it('should throw when the terraform.init.end event carries an error field', async () => {
        ipcInvoke.mockResolvedValue({ started: true, streamId: STREAM_ID });

        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'terraform.init.end') {
            Promise.resolve().then(() =>
              listener({} as unknown, { streamId: STREAM_ID, exitCode: 1, error: 'terraform init exited with code 1' }),
            );
          }
        });

        const terraform = bridge['terraform'] as {
          init: (config: unknown) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
        };

        await expect(collectChunks(terraform.init(CONFIG))).rejects.toThrow('terraform init exited with code 1');
      });

      it('should throw using the ack error, after cleaning up the listeners, when the invoke resolves with started: false', async () => {
        ipcInvoke.mockResolvedValue({
          started: false,
          error: 'terraform.init requires non-empty bucket, region, and dynamodbTable strings',
        });

        const terraform = bridge['terraform'] as {
          init: (config: unknown) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
        };

        await expect(collectChunks(terraform.init(CONFIG))).rejects.toThrow(
          'terraform.init requires non-empty bucket, region, and dynamodbTable strings',
        );

        // Listeners are attached before invoke (so no early chunk is dropped),
        // but must be torn down once the ack reports the run never started.
        expect(ipcOn).toHaveBeenCalledWith('terraform.init.chunk', expect.any(Function));
        expect(ipcOn).toHaveBeenCalledWith('terraform.init.end', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('terraform.init.chunk', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('terraform.init.end', expect.any(Function));
      });

      it('should remove chunk/end listeners once the stream completes', async () => {
        ipcInvoke.mockResolvedValue({ started: true, streamId: STREAM_ID });

        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'terraform.init.end') {
            Promise.resolve().then(() => listener({} as unknown, { streamId: STREAM_ID, exitCode: 0 }));
          }
        });

        const terraform = bridge['terraform'] as {
          init: (config: unknown) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
        };
        await collectChunks(terraform.init(CONFIG));

        expect(ipcRemoveListener).toHaveBeenCalledWith('terraform.init.chunk', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('terraform.init.end', expect.any(Function));
      });

      // -----------------------------------------------------------------------
      // AbortSignal cancellation
      // -----------------------------------------------------------------------

      it('should stop yielding and clean up listeners without calling invoke when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        const terraform = bridge['terraform'] as {
          init: (config: unknown, signal?: AbortSignal) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
        };
        const chunks = await collectChunks(terraform.init(CONFIG, controller.signal));

        expect(chunks).toEqual([]);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(ipcRemoveListener).toHaveBeenCalledWith('terraform.init.chunk', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('terraform.init.end', expect.any(Function));
      });

      it('should stop the async iterable and clean up listeners when the signal aborts mid-stream', async () => {
        ipcInvoke.mockResolvedValue({ started: true, streamId: STREAM_ID });

        // Keep the stream alive — never fire the end event — so the consumer
        // must be interrupted by the abort instead.
        // See the ref-object note above — a bare `let` here reads back as
        // narrowed-to-`null` at the call site below.
        const capturedChunkListener: { current: ChunkListener | null } = { current: null };
        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'terraform.init.chunk') capturedChunkListener.current = listener as ChunkListener;
          // 'terraform.init.end' listener is captured but intentionally never
          // invoked — the stream stays open until the signal aborts.
        });

        const controller = new AbortController();
        const terraform = bridge['terraform'] as {
          init: (config: unknown, signal?: AbortSignal) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
        };
        const gen = terraform.init(CONFIG, controller.signal)[Symbol.asyncIterator]();

        // Start the generator — it suspends at the inner `await new Promise`
        // once the ack resolves and no chunk has arrived yet.
        const nextPromise = gen.next();
        await Promise.resolve();
        await Promise.resolve();
        // Deliver one chunk to prove the stream was flowing before the abort.
        capturedChunkListener.current?.({}, { streamId: STREAM_ID, chunk: { stream: 'stdout', line: 'Initializing backend...' } });
        const first = await nextPromise;
        expect(first).toEqual({ done: false, value: { stream: 'stdout', line: 'Initializing backend...' } });

        // Now abort — the generator should stop waiting for further chunks and
        // complete on its own without the consumer having to call return().
        controller.abort();
        const second = await gen.next();

        expect(second).toEqual({ done: true, value: undefined });
        expect(ipcRemoveListener).toHaveBeenCalledWith('terraform.init.chunk', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('terraform.init.end', expect.any(Function));
      }, 10_000);
    });
  });

  // -------------------------------------------------------------------------
  // terraform.plan
  // -------------------------------------------------------------------------

  describe('terraform.plan', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the terraform.plan channel with the opts payload and resolve the started ack with a runId', async () => {
        const ack = { started: true, runId: 'run-001' };
        ipcInvoke.mockResolvedValue(ack);
        const terraform = bridge['terraform'] as {
          plan: (opts?: { tfvarsVersionId?: string }) => Promise<unknown>;
        };
        const opts = { tfvarsVersionId: 'v-123' };

        const result = await terraform.plan(opts);

        expect(ipcInvoke).toHaveBeenCalledWith('terraform.plan', opts);
        expect(result).toEqual(ack);
      });

      it('should invoke the terraform.plan channel with no opts when omitted', async () => {
        ipcInvoke.mockResolvedValue({ started: true, runId: 'run-002' });
        const terraform = bridge['terraform'] as {
          plan: (opts?: { tfvarsVersionId?: string }) => Promise<unknown>;
        };

        await terraform.plan();

        expect(ipcInvoke).toHaveBeenCalledWith('terraform.plan', undefined);
      });

      it('should resolve conflict details when the shared workspace is already busy', async () => {
        const ack = {
          started: false,
          error: 'terraform plan refused: apply is already in flight',
          conflict: 'apply' as const,
        };
        ipcInvoke.mockResolvedValue(ack);
        const terraform = bridge['terraform'] as {
          plan: (opts?: { tfvarsVersionId?: string }) => Promise<unknown>;
        };

        const result = await terraform.plan();

        expect(result).toEqual(ack);
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when terraform.plan is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const ack = { started: true, runId: 'run-mock' };
        const mockHandler = vi.fn().mockResolvedValue(ack);
        testApi.mock('terraform.plan', mockHandler);

        const terraform = bridge['terraform'] as {
          plan: (opts?: { tfvarsVersionId?: string }) => Promise<unknown>;
        };
        const opts = { tfvarsVersionId: 'v-456' };
        const result = await terraform.plan(opts);

        expect(mockHandler).toHaveBeenCalledWith(opts);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(result).toEqual(ack);
      });
    });
  });

  // -------------------------------------------------------------------------
  // terraform.approve
  // -------------------------------------------------------------------------

  describe('terraform.approve', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the terraform.approve channel with the opts payload', async () => {
        const result = { approved: true, approvedBy: 'admin@example.com', approvedAt: '2026-07-21T00:00:00.000Z' };
        ipcInvoke.mockResolvedValue(result);
        const terraform = bridge['terraform'] as { approve: (opts: { planRunId: string }) => Promise<unknown> };
        const opts = { planRunId: 'run-001' };

        const response = await terraform.approve(opts);

        expect(ipcInvoke).toHaveBeenCalledWith('terraform.approve', opts);
        expect(response).toEqual(result);
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when terraform.approve is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const result = { approved: true, approvedBy: 'admin@example.com', approvedAt: '2026-07-21T00:00:00.000Z' };
        const mockHandler = vi.fn().mockResolvedValue(result);
        testApi.mock('terraform.approve', mockHandler);

        const terraform = bridge['terraform'] as { approve: (opts: { planRunId: string }) => Promise<unknown> };
        const opts = { planRunId: 'run-mock' };
        const response = await terraform.approve(opts);

        expect(mockHandler).toHaveBeenCalledWith(opts);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(response).toEqual(result);
      });
    });
  });

  // -------------------------------------------------------------------------
  // terraform.apply
  // -------------------------------------------------------------------------

  describe('terraform.apply', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the terraform.apply channel with the payload and resolve the started ack with a runId', async () => {
        const ack = { started: true, runId: 'run-002' };
        ipcInvoke.mockResolvedValue(ack);
        const terraform = bridge['terraform'] as {
          apply: (payload: { planRunId: string; planHash: string }) => Promise<unknown>;
        };
        const payload = { planRunId: 'run-001', planHash: 'sha256:abc123' };

        const result = await terraform.apply(payload);

        expect(ipcInvoke).toHaveBeenCalledWith('terraform.apply', payload);
        expect(result).toEqual(ack);
      });

      it('should resolve conflict details when the shared workspace is already busy', async () => {
        const ack = {
          started: false,
          error: 'terraform apply refused: plan is already in flight',
          conflict: 'plan' as const,
        };
        ipcInvoke.mockResolvedValue(ack);
        const terraform = bridge['terraform'] as {
          apply: (payload: { planRunId: string; planHash: string }) => Promise<unknown>;
        };

        const result = await terraform.apply({ planRunId: 'run-001', planHash: 'sha256:abc123' });

        expect(result).toEqual(ack);
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when terraform.apply is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const ack = { started: true, runId: 'run-mock' };
        const mockHandler = vi.fn().mockResolvedValue(ack);
        testApi.mock('terraform.apply', mockHandler);

        const terraform = bridge['terraform'] as {
          apply: (payload: { planRunId: string; planHash: string }) => Promise<unknown>;
        };
        const payload = { planRunId: 'run-001', planHash: 'sha256:def456' };
        const result = await terraform.apply(payload);

        expect(mockHandler).toHaveBeenCalledWith(payload);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(result).toEqual(ack);
      });
    });
  });

  // -------------------------------------------------------------------------
  // terraform.output
  // -------------------------------------------------------------------------

  describe('terraform.output', () => {
    /** Minimal `TfOutputs`-shaped fixture used across these tests. */
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
      alb_dns_name: null,
      acm_certificate_arn: null,
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

      it('should invoke the terraform.output channel with { force: true } and resolve with the typed outputs object', async () => {
        ipcInvoke.mockResolvedValue(OUTPUTS);
        const terraform = bridge['terraform'] as { output: (force?: boolean) => Promise<unknown> };

        const result = await terraform.output(true);

        expect(ipcInvoke).toHaveBeenCalledWith('terraform.output', { force: true });
        expect(result).toEqual(OUTPUTS);
      });

      it('should invoke the terraform.output channel with { force: false } when force is explicitly false', async () => {
        ipcInvoke.mockResolvedValue(OUTPUTS);
        const terraform = bridge['terraform'] as { output: (force?: boolean) => Promise<unknown> };

        await terraform.output(false);

        expect(ipcInvoke).toHaveBeenCalledWith('terraform.output', { force: false });
      });

      it('should invoke the terraform.output channel with { force: undefined } when no argument is supplied', async () => {
        ipcInvoke.mockResolvedValue(OUTPUTS);
        const terraform = bridge['terraform'] as { output: (force?: boolean) => Promise<unknown> };

        await terraform.output();

        expect(ipcInvoke).toHaveBeenCalledWith('terraform.output', { force: undefined });
      });

      it('should resolve with null when terraform.output reports no outputs', async () => {
        ipcInvoke.mockResolvedValue(null);
        const terraform = bridge['terraform'] as { output: (force?: boolean) => Promise<unknown> };

        const result = await terraform.output();

        expect(result).toBeNull();
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when terraform.output is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const mockHandler = vi.fn().mockResolvedValue(OUTPUTS);
        testApi.mock('terraform.output', mockHandler);

        const terraform = bridge['terraform'] as { output: (force?: boolean) => Promise<unknown> };
        const result = await terraform.output(true);

        expect(mockHandler).toHaveBeenCalledWith({ force: true });
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(result).toEqual(OUTPUTS);
      });
    });
  });

  // -------------------------------------------------------------------------
  // terraform.runs.get
  // -------------------------------------------------------------------------

  describe('terraform.runs.get', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the terraform.runs.get channel with a { runId } payload and resolve the result', async () => {
        const result = { found: true, status: 'success', record: { runId: 'run-001', kind: 'plan', startedAt: '2026-07-17T00:00:00.000Z', completedAt: '2026-07-17T00:01:00.000Z', exitCode: 0 } };
        ipcInvoke.mockResolvedValue(result);
        const terraformRuns = (bridge['terraform'] as { runs: { get: (runId: string) => Promise<unknown> } }).runs;

        const actual = await terraformRuns.get('run-001');

        expect(ipcInvoke).toHaveBeenCalledWith('terraform.runs.get', { runId: 'run-001' });
        expect(actual).toEqual(result);
      });

      it('should resolve { found: false } when the run is unknown', async () => {
        ipcInvoke.mockResolvedValue({ found: false });
        const terraformRuns = (bridge['terraform'] as { runs: { get: (runId: string) => Promise<unknown> } }).runs;

        const actual = await terraformRuns.get('run-missing');

        expect(actual).toEqual({ found: false });
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when terraform.runs.get is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const result = { found: true, status: 'running' };
        const mockHandler = vi.fn().mockResolvedValue(result);
        testApi.mock('terraform.runs.get', mockHandler);

        const terraformRuns = (bridge['terraform'] as { runs: { get: (runId: string) => Promise<unknown> } }).runs;
        const actual = await terraformRuns.get('run-002');

        expect(mockHandler).toHaveBeenCalledWith({ runId: 'run-002' });
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(actual).toEqual(result);
      });
    });
  });

  // -------------------------------------------------------------------------
  // terraform.runs.list
  // -------------------------------------------------------------------------

  describe('terraform.runs.list', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the terraform.runs.list channel with the given opts and resolve the page', async () => {
        const page = { records: [{ sk: 's1', runId: 'run-001', kind: 'apply', status: 'success', startedAt: 't1', completedAt: 't2', exitCode: 0 }], nextBefore: 's1' };
        ipcInvoke.mockResolvedValue(page);
        const terraformRuns = (bridge['terraform'] as { runs: { list: (opts?: unknown) => Promise<unknown> } }).runs;

        const actual = await terraformRuns.list({ limit: 10, before: 'cursor', status: 'failed' });

        expect(ipcInvoke).toHaveBeenCalledWith('terraform.runs.list', { limit: 10, before: 'cursor', status: 'failed' });
        expect(actual).toEqual(page);
      });

      it('should invoke with undefined opts when called with no arguments', async () => {
        ipcInvoke.mockResolvedValue({ records: [] });
        const terraformRuns = (bridge['terraform'] as { runs: { list: (opts?: unknown) => Promise<unknown> } }).runs;

        await terraformRuns.list();

        expect(ipcInvoke).toHaveBeenCalledWith('terraform.runs.list', undefined);
      });
    });

    describe('mock-override', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('1');
      });

      it('should call the registered mock instead of ipcRenderer.invoke when terraform.runs.list is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const page = { records: [] };
        const mockHandler = vi.fn().mockResolvedValue(page);
        testApi.mock('terraform.runs.list', mockHandler);

        const terraformRuns = (bridge['terraform'] as { runs: { list: (opts?: unknown) => Promise<unknown> } }).runs;
        const actual = await terraformRuns.list({ limit: 5 });

        expect(mockHandler).toHaveBeenCalledWith({ limit: 5 });
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(actual).toEqual(page);
      });
    });
  });

  // -------------------------------------------------------------------------
  // terraform.runs.logUrl
  // -------------------------------------------------------------------------

  describe('terraform.runs.logUrl', () => {
    describe('real-IPC fallthrough', () => {
      let bridge: Record<string, unknown>;

      beforeEach(async () => {
        bridge = await loadPreloadBridge('0');
      });

      it('should invoke the terraform.runs.logUrl channel and unwrap { url } to a bare string', async () => {
        ipcInvoke.mockResolvedValue({ url: 'https://example.com/signed-log' });
        const terraformRuns = (bridge['terraform'] as {
          runs: { logUrl: (logKey: string, expiresInSeconds?: number) => Promise<string> };
        }).runs;

        const actual = await terraformRuns.logUrl('runs/run-123.log', 60);

        expect(ipcInvoke).toHaveBeenCalledWith('terraform.runs.logUrl', {
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

      it('should call the registered mock instead of ipcRenderer.invoke when terraform.runs.logUrl is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };
        const mockHandler = vi.fn().mockResolvedValue({ url: 'https://example.com/mocked' });
        testApi.mock('terraform.runs.logUrl', mockHandler);

        const terraformRuns = (bridge['terraform'] as {
          runs: { logUrl: (logKey: string, expiresInSeconds?: number) => Promise<string> };
        }).runs;
        const actual = await terraformRuns.logUrl('runs/run-456.log');

        expect(mockHandler).toHaveBeenCalledWith({ logKey: 'runs/run-456.log', expiresInSeconds: undefined });
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(actual).toBe('https://example.com/mocked');
      });
    });
  });

  // -------------------------------------------------------------------------
  // terraform.runs.streamLogs
  // -------------------------------------------------------------------------

  describe('terraform.runs.streamLogs', () => {
    /** Helper to collect all chunks from the `terraform.runs.streamLogs` async iterable into an array. */
    async function collectChunks(
      iterable: AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>,
    ): Promise<{ stream: 'stdout' | 'stderr'; line: string }[]> {
      const chunks: { stream: 'stdout' | 'stderr'; line: string }[] = [];
      for await (const chunk of iterable) {
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

      it('should delegate to the registered mock iterable instead of ipcRenderer when terraform.runs.logs is mocked', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* fakeStream() {
          yield { stream: 'stdout' as const, line: 'Refreshing state...' };
          yield { stream: 'stdout' as const, line: 'Plan: 1 to add, 0 to change, 0 to destroy.' };
        }

        const mockHandler = vi.fn().mockReturnValue(fakeStream());
        testApi.mock('terraform.runs.logs', mockHandler);

        const terraformRuns = (
          bridge['terraform'] as {
            runs: {
              streamLogs: (
                runId: string,
                signal?: AbortSignal,
              ) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        const chunks = await collectChunks(terraformRuns.streamLogs('run-003'));

        expect(mockHandler).toHaveBeenCalledWith('run-003', undefined);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(ipcSend).not.toHaveBeenCalled();
        expect(chunks).toEqual([
          { stream: 'stdout', line: 'Refreshing state...' },
          { stream: 'stdout', line: 'Plan: 1 to add, 0 to change, 0 to destroy.' },
        ]);
      });

      it('should forward the AbortSignal to the mock handler when one is provided', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* emptyStream() {}
        const mockHandler = vi.fn().mockReturnValue(emptyStream());
        testApi.mock('terraform.runs.logs', mockHandler);

        const controller = new AbortController();
        const terraformRuns = (
          bridge['terraform'] as {
            runs: {
              streamLogs: (
                runId: string,
                signal?: AbortSignal,
              ) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        await collectChunks(terraformRuns.streamLogs('run-004', controller.signal));

        expect(mockHandler).toHaveBeenCalledWith('run-004', controller.signal);
      });

      it('should not attach any ipcRenderer listeners when the mock handles the stream', async () => {
        const testApi = bridge['__test'] as { mock: (channel: string, handler: unknown) => void };

        async function* emptyStream() {}
        testApi.mock('terraform.runs.logs', vi.fn().mockReturnValue(emptyStream()));

        const terraformRuns = (
          bridge['terraform'] as {
            runs: {
              streamLogs: (runId: string) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        await collectChunks(terraformRuns.streamLogs('run-005'));

        expect(ipcOn).not.toHaveBeenCalled();
        expect(ipcOnce).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // Unmocked passthrough branch
    // -----------------------------------------------------------------------

    describe('unmocked passthrough branch', () => {
      /**
       * `TerraformRunsController.logs` mints a per-call `streamId` and tags every
       * chunk/end payload with it (returning the same id in the invoke ack) so an
       * overlapping subscription to a different run's log stream can't
       * cross-terminate this call's stream. Tests below default to this id when
       * simulating the ack/events.
       */
      const STREAM_ID = 'sid-terraform-runs-1';

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
          if (channel === 'terraform.runs.logs.end') {
            Promise.resolve().then(() => listener({} as unknown, { streamId: STREAM_ID }));
          }
        });

        const terraformRuns = (
          bridge['terraform'] as {
            runs: {
              streamLogs: (runId: string) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        await collectChunks(terraformRuns.streamLogs('run-006'));

        // Registration must happen strictly before the invoke call resolves —
        // otherwise a chunk sent immediately after the main process
        // acknowledges the call could be dropped.
        const firstOnCallOrder = ipcOn.mock.invocationCallOrder[0];
        const secondOnCallOrder = ipcOn.mock.invocationCallOrder[1];
        const invokeCallOrder = ipcInvoke.mock.invocationCallOrder[0];

        expect(firstOnCallOrder).toBeLessThan(invokeCallOrder);
        expect(secondOnCallOrder).toBeLessThan(invokeCallOrder);
      });

      it('should invoke terraform.runs.logs on ipcRenderer with the { runId } payload', async () => {
        ipcInvoke.mockResolvedValue({ streamId: STREAM_ID });

        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'terraform.runs.logs.end') {
            Promise.resolve().then(() => listener({} as unknown, { streamId: STREAM_ID }));
          }
        });

        const terraformRuns = (
          bridge['terraform'] as {
            runs: {
              streamLogs: (runId: string) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        const chunks = await collectChunks(terraformRuns.streamLogs('run-007'));

        expect(ipcInvoke).toHaveBeenCalledWith('terraform.runs.logs', { runId: 'run-007' });
        expect(chunks).toEqual([]);
      });

      it('should yield chunks received over the terraform.runs.logs.chunk IPC channel in order', async () => {
        ipcInvoke.mockResolvedValue({ streamId: STREAM_ID });

        const capturedChunkListener: { current: ChunkListener | null } = { current: null };
        const capturedEndListener: { current: EndListener | null } = { current: null };
        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'terraform.runs.logs.chunk') capturedChunkListener.current = listener as ChunkListener;
          if (channel === 'terraform.runs.logs.end') capturedEndListener.current = listener as EndListener;
        });

        const terraformRuns = (
          bridge['terraform'] as {
            runs: {
              streamLogs: (runId: string) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        const collected = collectChunks(terraformRuns.streamLogs('run-008'));

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
          if (channel === 'terraform.runs.logs.chunk') capturedChunkListener.current = listener as ChunkListener;
          if (channel === 'terraform.runs.logs.end') capturedEndListener.current = listener as EndListener;
        });

        const terraformRuns = (
          bridge['terraform'] as {
            runs: {
              streamLogs: (runId: string) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        const collected = collectChunks(terraformRuns.streamLogs('run-009'));

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

      it('should throw when the terraform.runs.logs.end event carries an error field', async () => {
        ipcInvoke.mockResolvedValue({ streamId: STREAM_ID });

        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'terraform.runs.logs.end') {
            Promise.resolve().then(() => listener({} as unknown, { streamId: STREAM_ID, error: 'run not found' }));
          }
        });

        const terraformRuns = (
          bridge['terraform'] as {
            runs: {
              streamLogs: (runId: string) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;

        await expect(collectChunks(terraformRuns.streamLogs('run-010'))).rejects.toThrow('run not found');
      });

      it('should remove chunk/end listeners once the stream completes', async () => {
        ipcInvoke.mockResolvedValue({ streamId: STREAM_ID });

        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'terraform.runs.logs.end') {
            Promise.resolve().then(() => listener({} as unknown, { streamId: STREAM_ID }));
          }
        });

        const terraformRuns = (
          bridge['terraform'] as {
            runs: {
              streamLogs: (runId: string) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        await collectChunks(terraformRuns.streamLogs('run-011'));

        expect(ipcRemoveListener).toHaveBeenCalledWith('terraform.runs.logs.chunk', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('terraform.runs.logs.end', expect.any(Function));
      });

      // -----------------------------------------------------------------------
      // AbortSignal cancellation
      // -----------------------------------------------------------------------

      it('should stop yielding and clean up listeners without calling invoke when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        const terraformRuns = (
          bridge['terraform'] as {
            runs: {
              streamLogs: (
                runId: string,
                signal?: AbortSignal,
              ) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        const chunks = await collectChunks(terraformRuns.streamLogs('run-012', controller.signal));

        expect(chunks).toEqual([]);
        expect(ipcInvoke).not.toHaveBeenCalled();
        expect(ipcRemoveListener).toHaveBeenCalledWith('terraform.runs.logs.chunk', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('terraform.runs.logs.end', expect.any(Function));
      });

      it('should stop the async iterable and clean up listeners when the signal aborts mid-stream', async () => {
        ipcInvoke.mockResolvedValue({ streamId: STREAM_ID });

        const capturedChunkListener: { current: ChunkListener | null } = { current: null };
        ipcOn.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === 'terraform.runs.logs.chunk') capturedChunkListener.current = listener as ChunkListener;
          // 'terraform.runs.logs.end' listener is captured but intentionally
          // never invoked — the stream stays open until the signal aborts.
        });

        const controller = new AbortController();
        const terraformRuns = (
          bridge['terraform'] as {
            runs: {
              streamLogs: (
                runId: string,
                signal?: AbortSignal,
              ) => AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>;
            };
          }
        ).runs;
        const gen = terraformRuns.streamLogs('run-013', controller.signal)[Symbol.asyncIterator]();

        const nextPromise = gen.next();
        await Promise.resolve();
        await Promise.resolve();
        capturedChunkListener.current?.({}, { streamId: STREAM_ID, chunk: { stream: 'stdout', line: 'Refreshing state...' } });
        const first = await nextPromise;
        expect(first).toEqual({ done: false, value: { stream: 'stdout', line: 'Refreshing state...' } });

        controller.abort();
        const second = await gen.next();

        expect(second).toEqual({ done: true, value: undefined });
        expect(ipcRemoveListener).toHaveBeenCalledWith('terraform.runs.logs.chunk', expect.any(Function));
        expect(ipcRemoveListener).toHaveBeenCalledWith('terraform.runs.logs.end', expect.any(Function));
      }, 10_000);
    });
  });
});
