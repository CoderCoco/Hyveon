import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { DiagnosticsController } from './diagnostics.controller.js';
import type { DiagnosticsService } from '../services/DiagnosticsService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Build a DiagnosticsService stub. */
function makeDiagnostics(): DiagnosticsService {
  return {
    readTail: vi.fn().mockResolvedValue(['line1', 'line2', 'line3']),
    getTodayLogPath: vi.fn().mockReturnValue('/var/log/app/main-2026-05-23.log'),
    logRendererError: vi.fn(),
    logRendererConsoleBatch: vi.fn(),
  } as unknown as DiagnosticsService;
}

describe('DiagnosticsController', () => {
  describe('getTail', () => {
    it('should return lines from DiagnosticsService', async () => {
      const svc = makeDiagnostics();
      const result = await new DiagnosticsController(svc).getTail();
      expect(result).toEqual({ lines: ['line1', 'line2', 'line3'] });
    });

    it('should call DiagnosticsService.readTail with 500 lines', async () => {
      const svc = makeDiagnostics();
      await new DiagnosticsController(svc).getTail();
      expect(svc.readTail).toHaveBeenCalledWith(500);
    });
  });

  describe('getPath', () => {
    it('should return the current log path from DiagnosticsService', () => {
      const svc = makeDiagnostics();
      const result = new DiagnosticsController(svc).getPath();
      expect(result).toEqual({ path: '/var/log/app/main-2026-05-23.log' });
    });

    it('should delegate to DiagnosticsService.getTodayLogPath', () => {
      const svc = makeDiagnostics();
      new DiagnosticsController(svc).getPath();
      expect(svc.getTodayLogPath).toHaveBeenCalled();
    });
  });

  describe('reportError', () => {
    it('should call DiagnosticsService.logRendererError with the payload fields', () => {
      const svc = makeDiagnostics();
      new DiagnosticsController(svc).reportError({
        message: 'boom',
        stack: 'Error: boom\n  at x',
        source: 'boundary',
      });

      expect(svc.logRendererError).toHaveBeenCalledWith('boom', 'Error: boom\n  at x', 'boundary');
    });

    it('should pass through an undefined stack unchanged', () => {
      const svc = makeDiagnostics();
      new DiagnosticsController(svc).reportError({
        message: 'unhandled rejection',
        source: 'unhandled-rejection',
      });

      expect(svc.logRendererError).toHaveBeenCalledWith('unhandled rejection', undefined, 'unhandled-rejection');
    });

    it('should return undefined', () => {
      const svc = makeDiagnostics();
      const result = new DiagnosticsController(svc).reportError({
        message: 'boom',
        source: 'window-error',
      });

      expect(result).toBeUndefined();
    });
  });

  describe('reportLog', () => {
    it('should call DiagnosticsService.logRendererConsoleBatch with the entries and dropped count', () => {
      const svc = makeDiagnostics();
      const entries = [
        { level: 'log' as const, message: 'first' },
        { level: 'warn' as const, message: 'second' },
      ];

      new DiagnosticsController(svc).reportLog({ entries, droppedCount: 3 });

      expect(svc.logRendererConsoleBatch).toHaveBeenCalledWith(entries, 3);
    });

    it('should pass through an undefined droppedCount unchanged', () => {
      const svc = makeDiagnostics();
      const entries = [{ level: 'info' as const, message: 'hello' }];

      new DiagnosticsController(svc).reportLog({ entries });

      expect(svc.logRendererConsoleBatch).toHaveBeenCalledWith(entries, undefined);
    });

    it('should return undefined', () => {
      const svc = makeDiagnostics();
      const result = new DiagnosticsController(svc).reportLog({ entries: [] });

      expect(result).toBeUndefined();
    });
  });
});
