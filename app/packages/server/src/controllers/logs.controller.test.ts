import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { Observable } from 'rxjs';
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

describe('LogsController', () => {
  describe('getLogs', () => {
    it('should return the game name and log lines from LogsService', async () => {
      const result = await new LogsController(makeLogs()).getLogs('minecraft');
      expect(result).toEqual({ game: 'minecraft', lines: ['line1', 'line2'] });
    });

    it('should default to 50 log lines when no limit query param is provided', async () => {
      const logs = makeLogs();
      await new LogsController(logs).getLogs('palworld', undefined);
      expect(logs.getRecentLogs).toHaveBeenCalledWith('palworld', 50);
    });

    it('should parse the limit query param and forward the integer to LogsService', async () => {
      const logs = makeLogs();
      await new LogsController(logs).getLogs('minecraft', '100');
      expect(logs.getRecentLogs).toHaveBeenCalledWith('minecraft', 100);
    });
  });

  describe('streamLogs', () => {
    it('should return an Observable', () => {
      const result = new LogsController(makeLogs()).streamLogs('minecraft');
      expect(result).toBeInstanceOf(Observable);
    });

    it('should emit MessageEvent objects for each line yielded by LogsService.streamLogs', async () => {
      async function* fakeStream() {
        yield 'hello';
        yield 'world';
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(fakeStream);

      const ctrl = new LogsController(logs);
      const obs = ctrl.streamLogs('minecraft');

      const received: unknown[] = [];
      await new Promise<void>((resolve, reject) => {
        obs.subscribe({
          next: (event) => received.push(event),
          error: reject,
          complete: resolve,
        });
      });

      expect(received).toEqual([
        { data: { line: 'hello' } },
        { data: { line: 'world' } },
      ]);
    });

    it('should complete the stream without error when the generator is exhausted', async () => {
      async function* empty() { /* no lines */ }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(empty);

      let completed = false;
      await new Promise<void>((resolve, reject) => {
        new LogsController(logs).streamLogs('minecraft').subscribe({
          complete: () => { completed = true; resolve(); },
          error: reject,
        });
      });

      expect(completed).toBe(true);
    });

    it('should complete instead of erroring when LogsService throws an AbortError', async () => {
      async function* abortStream() {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
        yield 'unreachable';
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(abortStream);

      let completed = false;
      await new Promise<void>((resolve, reject) => {
        new LogsController(logs).streamLogs('minecraft').subscribe({
          complete: () => { completed = true; resolve(); },
          error: reject,
        });
      });

      expect(completed).toBe(true);
    });

    it('should forward non-AbortError exceptions to the subscriber as errors', async () => {
      async function* badStream() {
        throw new Error('CloudWatch throttled');
        yield 'unreachable';
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(badStream);

      const err = await new Promise<Error>((resolve) => {
        new LogsController(logs).streamLogs('minecraft').subscribe({
          error: (e: Error) => resolve(e),
        });
      });

      expect(err.message).toBe('CloudWatch throttled');
    });
  });
});
