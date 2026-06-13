import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { LogsController } from './logs.controller.js';
import type { LogsService } from '../services/LogsService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Build a LogsService stub. */
function makeLogs(): LogsService {
  return {
    getRecentLogs: vi.fn().mockResolvedValue(['line1', 'line2']),
    streamLogs: vi.fn().mockImplementation(async function* () { /* empty */ }),
  } as unknown as LogsService;
}

/**
 * Build a minimal execution-context stub that carries an AbortSignal,
 * matching what StreamingElectronIPCTransport wires into `ctx.signal`.
 */
function makeCtx(signal?: AbortSignal): { signal: AbortSignal } {
  return { signal: signal ?? new AbortController().signal };
}

/** Collect all values from an AsyncGenerator into an array. */
async function collectGenerator<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of gen) {
    results.push(item);
  }
  return results;
}

/**
 * The metadata key NestJS stores on each method decorated with
 * `@MessagePattern`. Asserting this value guards against typos in the
 * channel name that would silently break IPC routing.
 */
const PATTERN_METADATA_KEY = 'microservices:pattern';

describe('LogsController', () => {
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

  describe('streamLogs', () => {
    it('should yield each string line from LogsService.streamLogs', async () => {
      async function* fakeStream() {
        yield 'hello';
        yield 'world';
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(fakeStream);

      const gen = new LogsController(logs).streamLogs('minecraft', makeCtx());
      const received = await collectGenerator(gen);

      expect(received).toEqual(['hello', 'world']);
    });

    it('should stop cleanly when the generator is exhausted', async () => {
      async function* empty() { /* no lines */ }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(empty);

      const gen = new LogsController(logs).streamLogs('minecraft', makeCtx());
      const received = await collectGenerator(gen);

      expect(received).toEqual([]);
    });

    it('should propagate the AbortSignal from ctx.signal to LogsService.streamLogs', async () => {
      const logs = makeLogs();
      const abortController = new AbortController();
      const ctx = makeCtx(abortController.signal);

      const gen = new LogsController(logs).streamLogs('minecraft', ctx);
      await collectGenerator(gen);

      expect(logs.streamLogs).toHaveBeenCalledWith('minecraft', abortController.signal);
    });
  });
});
