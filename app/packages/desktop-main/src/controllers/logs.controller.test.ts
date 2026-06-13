import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogsController } from './logs.controller.js';
import type { LogsService } from '../services/LogsService.js';

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before any vi.mock() factory runs.
// ---------------------------------------------------------------------------

/**
 * Captures every listener registered via `ipcMain.handle` or `ipcMain.once`
 * so tests can assert on routing registration and fire cancel callbacks
 * synchronously.
 *
 * `mockIpcMainHandle` captures the `ipcMain.handle('logs.stream', ...)` call
 * made by `onModuleInit()`. Without it, calling `onModuleInit` in a test
 * environment (where the real Electron `ipcMain` is absent) would throw.
 */
const { mockIpcMainHandle, mockIpcMainOnce, mockIpcMainRemoveAllListeners } = vi.hoisted(() => {
  const mockIpcMainHandle = vi.fn();
  const mockIpcMainOnce = vi.fn();
  const mockIpcMainRemoveAllListeners = vi.fn();
  return { mockIpcMainHandle, mockIpcMainOnce, mockIpcMainRemoveAllListeners };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
    once: mockIpcMainOnce,
    removeAllListeners: mockIpcMainRemoveAllListeners,
  },
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a LogsService stub with default no-op implementations. */
function makeLogs(): LogsService {
  return {
    getRecentLogs: vi.fn().mockResolvedValue(['line1', 'line2']),
    streamLogs: vi.fn().mockImplementation(async function* () { /* empty */ }),
  } as unknown as LogsService;
}

/**
 * Build a minimal `IpcMainInvokeEvent` stub with a controlled `sender`
 * (WebContents). Tests can inspect calls on `sender.send` and control the
 * return value of `sender.isDestroyed()`.
 */
function makeCtx(isDestroyed = false) {
  const sender = {
    send: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(isDestroyed),
  };
  return {
    ctx: { evt: { sender } } as unknown as { evt: { sender: typeof sender } },
    sender,
  };
}

/** Flush the microtask queue so async fire-and-forget loops fully settle. */
function flushPromises(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * The metadata key NestJS stores on each method decorated with
 * `@MessagePattern`. Asserting this value guards against typos in the
 * channel name that would silently break IPC routing.
 */
const PATTERN_METADATA_KEY = 'microservices:pattern';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('LogsController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // @MessagePattern channel name registration
  // -------------------------------------------------------------------------

  describe('@MessagePattern channel names', () => {
    it('should register getRecentLogs on the "logs.get" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, LogsController.prototype.getRecentLogs);
      expect(pattern).toEqual(['logs.get']);
    });

    it('should register streamLogs on the "logs.stream" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, LogsController.prototype.streamLogs);
      expect(pattern).toEqual(['logs.stream']);
    });
  });

  // -------------------------------------------------------------------------
  // onModuleInit — ipcMain.handle bridge for logs.stream
  // -------------------------------------------------------------------------

  describe('onModuleInit', () => {
    it('should register ipcMain.handle for "logs.stream" so ipcRenderer.invoke can resolve', async () => {
      // onModuleInit bridges the gap between @MessagePattern (transport-internal
      // dispatch only) and ipcMain.handle (required by ipcRenderer.invoke). Without
      // this registration, invoke hangs indefinitely and { streamId } is never
      // destructured in the preload.
      await new LogsController(makeLogs()).onModuleInit();
      expect(mockIpcMainHandle).toHaveBeenCalledWith('logs.stream', expect.any(Function));
    });
  });

  // -------------------------------------------------------------------------
  // getRecentLogs
  // -------------------------------------------------------------------------

  describe('getRecentLogs', () => {
    it('should return the game name and log lines from LogsService', async () => {
      const result = await new LogsController(makeLogs()).getRecentLogs({ game: 'minecraft' });
      expect(result).toEqual({ game: 'minecraft', lines: ['line1', 'line2'] });
    });

    it('should default to 50 log lines when no limit is provided in the payload', async () => {
      const logs = makeLogs();
      await new LogsController(logs).getRecentLogs({ game: 'palworld' });
      expect(logs.getRecentLogs).toHaveBeenCalledWith('palworld', 50);
    });

    it('should forward the explicit limit from the payload to LogsService', async () => {
      const logs = makeLogs();
      await new LogsController(logs).getRecentLogs({ game: 'minecraft', limit: 100 });
      expect(logs.getRecentLogs).toHaveBeenCalledWith('minecraft', 100);
    });
  });

  // -------------------------------------------------------------------------
  // streamLogs
  // -------------------------------------------------------------------------

  describe('streamLogs', () => {
    it('should return a non-empty streamId string immediately', async () => {
      const logs = makeLogs();
      const { ctx } = makeCtx();

      const result = await new LogsController(logs).streamLogs('minecraft', ctx);

      expect(result).toHaveProperty('streamId');
      expect(typeof result.streamId).toBe('string');
      expect(result.streamId.length).toBeGreaterThan(0);
    });

    it('should register a cancel listener on the per-stream cancel channel', async () => {
      const logs = makeLogs();
      const { ctx } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLogs('minecraft', ctx);

      expect(mockIpcMainOnce).toHaveBeenCalledWith(
        `logs.stream.${streamId}.cancel`,
        expect.any(Function),
      );
    });

    it('should send each log line as a chunk to the renderer via sender.send', async () => {
      async function* twoLines() {
        yield 'hello';
        yield 'world';
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(twoLines);
      const { ctx, sender } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLogs('minecraft', ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith(`logs.stream.${streamId}.chunk`, 'hello');
      expect(sender.send).toHaveBeenCalledWith(`logs.stream.${streamId}.chunk`, 'world');
    });

    it('should send an end message with no error when the generator is exhausted', async () => {
      async function* empty() { /* no lines */ }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(empty);
      const { ctx, sender } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLogs('minecraft', ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith(`logs.stream.${streamId}.end`, {});
    });

    it('should send an end message with no error when the stream is cancelled (AbortError)', async () => {
      async function* throwsAbort(): AsyncGenerator<string> {
        yield 'partial';
        throw new DOMException('Aborted', 'AbortError');
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(throwsAbort);
      const { ctx, sender } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLogs('minecraft', ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith(`logs.stream.${streamId}.end`, {});
      // The error field must NOT be present on an AbortError end message.
      const endCall = sender.send.mock.calls.find(([ch]) => ch === `logs.stream.${streamId}.end`);
      expect(endCall?.[1]).not.toHaveProperty('error');
    });

    it('should send an end message with an error string when the generator throws a non-abort error', async () => {
      async function* throwsNonAbort(): AsyncGenerator<string> {
        yield 'partial';
        throw new Error('CloudWatch throttled');
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(throwsNonAbort);
      const { ctx, sender } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLogs('minecraft', ctx);
      await flushPromises();

      const endCall = sender.send.mock.calls.find(([ch]) => ch === `logs.stream.${streamId}.end`);
      expect(endCall?.[1]).toHaveProperty('error');
      expect(String(endCall?.[1]?.error)).toContain('CloudWatch throttled');
    });

    it('should create its own AbortController and pass the signal to LogsService.streamLogs', async () => {
      const logs = makeLogs();
      const { ctx } = makeCtx();

      await new LogsController(logs).streamLogs('minecraft', ctx);
      await flushPromises();

      // The signal passed to streamLogs must be an AbortSignal created by the controller.
      expect(logs.streamLogs).toHaveBeenCalledWith('minecraft', expect.any(AbortSignal));
    });

    it('should abort the stream when the cancel IPC listener is invoked', async () => {
      // Make streamLogs block until signalled so we can inspect the abort state.
      let capturedSignal: AbortSignal | null = null;
      async function* waitForAbort(
        _game: string,
        signal: AbortSignal,
      ): AsyncGenerator<string> {
        capturedSignal = signal;
        // Yield one line then wait indefinitely so the cancel path is exercised.
        yield 'first';
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(waitForAbort);
      const { ctx } = makeCtx();

      await new LogsController(logs).streamLogs('minecraft', ctx);

      // Retrieve the cancel handler registered via ipcMain.once and invoke it.
      const [, cancelHandler] = mockIpcMainOnce.mock.calls[0] as [string, () => void];
      cancelHandler();

      await flushPromises();

      expect(capturedSignal?.aborted).toBe(true);
    });

    it('should remove the cancel listener after the stream ends naturally', async () => {
      async function* empty() { /* terminates immediately */ }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(empty);
      const { ctx } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLogs('minecraft', ctx);
      await flushPromises();

      expect(mockIpcMainRemoveAllListeners).toHaveBeenCalledWith(`logs.stream.${streamId}.cancel`);
    });

    it('should not send to a destroyed WebContents', async () => {
      async function* oneLine() { yield 'line'; }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(oneLine);
      // Simulate WebContents already destroyed before the loop runs.
      const { ctx, sender } = makeCtx(true);

      await new LogsController(logs).streamLogs('minecraft', ctx);
      await flushPromises();

      expect(sender.send).not.toHaveBeenCalled();
    });
  });
});
