import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';

vi.mock('node:fs/promises', () => ({
  open: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as fsPromises from 'node:fs/promises';
import { logger } from '../logger.js';
import { DiagnosticsService } from './DiagnosticsService.js';

/** The tail window constant duplicated here so tests can construct oversized content. */
const TAIL_READ_BYTES = 200 * 1024;

const mockOpen = vi.mocked(fsPromises.open);

/** Construct a fresh DiagnosticsService pointed at a predictable log directory. */
function makeService(logDir = '/var/log/hyveon'): DiagnosticsService {
  return new DiagnosticsService(logDir);
}

/**
 * Returns a mock FileHandle that serves `fullContent` exactly as the real
 * fs.open/read/stat would: stat reports the full file size, read fills the
 * caller-allocated buffer from the requested offset.
 */
function makeMockHandle(fullContent: string) {
  const fullBuf = Buffer.from(fullContent, 'utf-8');
  const size = fullBuf.length;
  return {
    stat: vi.fn().mockResolvedValue({ size }),
    read: vi.fn().mockImplementation((buf: Buffer, _offset: number, _len: number, position: number) => {
      fullBuf.copy(buf, 0, position, position + buf.length);
      return Promise.resolve({ bytesRead: buf.length });
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('DiagnosticsService.getTodayLogPath', () => {
  it('should return a date-stamped path matching main-YYYY-MM-DD.log in the configured logDir', () => {
    const service = makeService('/var/log/hyveon');
    const logPath = service.getTodayLogPath();

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const expectedFilename = `main-${yyyy}-${mm}-${dd}.log`;

    expect(logPath).toBe(path.join('/var/log/hyveon', expectedFilename));
  });

  it('should use the logDir supplied via the injection token', () => {
    const logDir = '/custom/logs';
    const service = makeService(logDir);
    const logPath = service.getTodayLogPath();
    expect(path.dirname(logPath)).toBe(logDir);
  });
});

describe('DiagnosticsService.readTail', () => {
  let service: DiagnosticsService;

  beforeEach(() => {
    mockOpen.mockReset();
    service = makeService('/var/log/hyveon');
  });

  it('should return an empty array when the log file does not yet exist', async () => {
    const err = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    mockOpen.mockRejectedValueOnce(err);

    const result = await service.readTail();
    expect(result).toEqual([]);
  });

  it('should re-throw errors that are not ENOENT', async () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    mockOpen.mockRejectedValueOnce(err);

    await expect(service.readTail()).rejects.toThrow('EACCES');
  });

  it('should return all lines when the file has fewer lines than maxLines', async () => {
    const handle = makeMockHandle('line1\nline2\nline3\n');
    mockOpen.mockResolvedValueOnce(handle as unknown as fsPromises.FileHandle);

    const result = await service.readTail(500);
    expect(result).toEqual(['line1', 'line2', 'line3']);
  });

  it('should return only the last N lines when the file has more lines than maxLines', async () => {
    const allLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const handle = makeMockHandle(allLines.join('\n') + '\n');
    mockOpen.mockResolvedValueOnce(handle as unknown as fsPromises.FileHandle);

    const result = await service.readTail(5);
    expect(result).toEqual(['line16', 'line17', 'line18', 'line19', 'line20']);
  });

  it('should default to returning at most 500 lines', async () => {
    const allLines = Array.from({ length: 600 }, (_, i) => `line${i + 1}`);
    const handle = makeMockHandle(allLines.join('\n') + '\n');
    mockOpen.mockResolvedValueOnce(handle as unknown as fsPromises.FileHandle);

    const result = await service.readTail();
    expect(result).toHaveLength(500);
    expect(result[0]).toBe('line101');
    expect(result[499]).toBe('line600');
  });

  it('should strip a trailing empty string caused by a trailing newline', async () => {
    const handle = makeMockHandle('alpha\nbeta\n');
    mockOpen.mockResolvedValueOnce(handle as unknown as fsPromises.FileHandle);

    const result = await service.readTail();
    expect(result).toEqual(['alpha', 'beta']);
  });

  it('should drop the first partial line when reading from a mid-file offset', async () => {
    // Construct content just over TAIL_READ_BYTES so the implementation seeks
    // past the beginning and the first line in the read window is incomplete.
    const prefix = 'partial-line-prefix\n';
    const padding = 'x'.repeat(TAIL_READ_BYTES - prefix.length + 1) + '\n';
    const tail = 'first-full-line\nsecond-full-line\n';
    const handle = makeMockHandle(prefix + padding + tail);
    mockOpen.mockResolvedValueOnce(handle as unknown as fsPromises.FileHandle);

    const result = await service.readTail(10);
    // The padding straddles the read window boundary so its partial fragment is
    // dropped. Both 'first-full-line' and 'second-full-line' are complete within
    // the window and must survive.
    expect(result).toEqual(['first-full-line', 'second-full-line']);
  });

  it('should not drop the first line when the offset lands exactly on a newline boundary', async () => {
    // Place the offset precisely at a newline so the peek-back byte is '\n'.
    // The first line after the boundary ('boundary-line') is complete and must not be dropped.
    const head = 'x'.repeat(TAIL_READ_BYTES) + '\n';
    const tail = 'boundary-line\nnext-line\n';
    const handle = makeMockHandle(head + tail);
    mockOpen.mockResolvedValueOnce(handle as unknown as fsPromises.FileHandle);

    const result = await service.readTail(10);
    expect(result).toContain('boundary-line');
    expect(result).toContain('next-line');
  });
});

describe('DiagnosticsService.logRendererError', () => {
  it('should log the error at the error level with the source tag in the message', () => {
    const service = makeService('/var/log/hyveon');

    service.logRendererError('boom', 'Error: boom\n  at x', 'boundary');

    expect(logger.error).toHaveBeenCalledWith('renderer error (boundary): boom', { stack: 'Error: boom\n  at x' });
  });

  it('should log a stack of undefined unchanged', () => {
    const service = makeService('/var/log/hyveon');

    service.logRendererError('unhandled', undefined, 'unhandled-rejection');

    expect(logger.error).toHaveBeenCalledWith('renderer error (unhandled-rejection): unhandled', { stack: undefined });
  });
});

describe('DiagnosticsService.logRendererConsoleBatch', () => {
  beforeEach(() => {
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it('should log each entry at the winston level mapped from its console level', () => {
    const service = makeService('/var/log/hyveon');

    service.logRendererConsoleBatch([
      { level: 'log', message: 'plain log' },
      { level: 'info', message: 'info message' },
      { level: 'warn', message: 'warn message' },
      { level: 'error', message: 'error message' },
    ]);

    expect(logger.debug).toHaveBeenCalledWith('renderer console (log): plain log');
    expect(logger.info).toHaveBeenCalledWith('renderer console (info): info message');
    expect(logger.warn).toHaveBeenCalledWith('renderer console (warn): warn message');
    expect(logger.error).toHaveBeenCalledWith('renderer console (error): error message');
  });

  it('should not log a dropped-entries warning when nothing was dropped', () => {
    const service = makeService('/var/log/hyveon');

    service.logRendererConsoleBatch([{ level: 'log', message: 'fine' }]);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should log a dropped-entries warning when droppedCount is provided', () => {
    const service = makeService('/var/log/hyveon');

    service.logRendererConsoleBatch([{ level: 'log', message: 'fine' }], 4);

    expect(logger.warn).toHaveBeenCalledWith('renderer console: 4 entries dropped (queue capacity exceeded)');
  });

  it('should cap entries processed per batch and report the overflow as dropped', () => {
    const service = makeService('/var/log/hyveon');
    const entries = Array.from({ length: 250 }, (_, i) => ({ level: 'log' as const, message: `entry ${i}` }));

    service.logRendererConsoleBatch(entries);

    expect(logger.debug).toHaveBeenCalledTimes(200);
    expect(logger.warn).toHaveBeenCalledWith('renderer console: 50 entries dropped (queue capacity exceeded)');
  });

  it('should combine the batch-cap overflow with an already-reported droppedCount', () => {
    const service = makeService('/var/log/hyveon');
    const entries = Array.from({ length: 250 }, (_, i) => ({ level: 'log' as const, message: `entry ${i}` }));

    service.logRendererConsoleBatch(entries, 10);

    expect(logger.warn).toHaveBeenCalledWith('renderer console: 60 entries dropped (queue capacity exceeded)');
  });

  it('should not throw for an empty entries array', () => {
    const service = makeService('/var/log/hyveon');

    expect(() => service.logRendererConsoleBatch([])).not.toThrow();
  });
});
