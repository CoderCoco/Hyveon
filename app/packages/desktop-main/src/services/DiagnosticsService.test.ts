import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import * as fsPromises from 'node:fs/promises';
import { DiagnosticsService } from './DiagnosticsService.js';

/** Typed handle to the mocked readFile so tests can configure it cleanly. */
const mockReadFile = vi.mocked(fsPromises.readFile);

/** Construct a fresh DiagnosticsService pointed at a predictable log directory. */
function makeService(logDir = '/var/log/hyveon'): DiagnosticsService {
  return new DiagnosticsService(logDir);
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

    expect(logPath).toBe(`/var/log/hyveon/${expectedFilename}`);
  });

  it('should use the logDir supplied via the injection token', () => {
    const service = makeService('/custom/logs');
    const logPath = service.getTodayLogPath();
    expect(logPath.startsWith('/custom/logs/')).toBe(true);
  });
});

describe('DiagnosticsService.readTail', () => {
  let service: DiagnosticsService;

  beforeEach(() => {
    mockReadFile.mockReset();
    service = makeService('/var/log/hyveon');
  });

  it('should return an empty array when the log file does not yet exist', async () => {
    const err = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValueOnce(err);

    const result = await service.readTail();
    expect(result).toEqual([]);
  });

  it('should re-throw errors that are not ENOENT', async () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    mockReadFile.mockRejectedValueOnce(err);

    await expect(service.readTail()).rejects.toThrow('EACCES');
  });

  it('should return all lines when the file has fewer lines than maxLines', async () => {
    mockReadFile.mockResolvedValueOnce('line1\nline2\nline3\n' as unknown as Buffer);

    const result = await service.readTail(500);
    expect(result).toEqual(['line1', 'line2', 'line3']);
  });

  it('should return only the last N lines when the file has more lines than maxLines', async () => {
    const allLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    mockReadFile.mockResolvedValueOnce((allLines.join('\n') + '\n') as unknown as Buffer);

    const result = await service.readTail(5);
    expect(result).toEqual(['line16', 'line17', 'line18', 'line19', 'line20']);
  });

  it('should default to returning at most 500 lines', async () => {
    const allLines = Array.from({ length: 600 }, (_, i) => `line${i + 1}`);
    mockReadFile.mockResolvedValueOnce((allLines.join('\n') + '\n') as unknown as Buffer);

    const result = await service.readTail();
    expect(result).toHaveLength(500);
    expect(result[0]).toBe('line101');
    expect(result[499]).toBe('line600');
  });

  it('should strip a trailing empty string caused by a trailing newline', async () => {
    mockReadFile.mockResolvedValueOnce('alpha\nbeta\n' as unknown as Buffer);

    const result = await service.readTail();
    expect(result).toEqual(['alpha', 'beta']);
  });
});
