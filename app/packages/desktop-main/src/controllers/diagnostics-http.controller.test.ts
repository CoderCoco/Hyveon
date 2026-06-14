import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { DiagnosticsHttpController } from './diagnostics-http.controller.js';
import type { DiagnosticsService } from '../services/DiagnosticsService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Build a DiagnosticsService stub. */
function makeDiagnostics(): DiagnosticsService {
  return {
    readTail: vi.fn().mockResolvedValue(['line1', 'line2', 'line3']),
    getTodayLogPath: vi.fn().mockReturnValue('/var/log/app/main-2026-05-23.log'),
  } as unknown as DiagnosticsService;
}

describe('DiagnosticsHttpController', () => {
  describe('getTail', () => {
    it('should return lines from DiagnosticsService', async () => {
      const svc = makeDiagnostics();
      const result = await new DiagnosticsHttpController(svc).getTail();
      expect(result).toEqual({ lines: ['line1', 'line2', 'line3'] });
    });

    it('should call DiagnosticsService.readTail with 500 lines', async () => {
      const svc = makeDiagnostics();
      await new DiagnosticsHttpController(svc).getTail();
      expect(svc.readTail).toHaveBeenCalledWith(500);
    });
  });

  describe('getPath', () => {
    it('should return the current log path from DiagnosticsService', () => {
      const svc = makeDiagnostics();
      const result = new DiagnosticsHttpController(svc).getPath();
      expect(result).toEqual({ path: '/var/log/app/main-2026-05-23.log' });
    });

    it('should delegate to DiagnosticsService.getTodayLogPath', () => {
      const svc = makeDiagnostics();
      new DiagnosticsHttpController(svc).getPath();
      expect(svc.getTodayLogPath).toHaveBeenCalled();
    });
  });
});
