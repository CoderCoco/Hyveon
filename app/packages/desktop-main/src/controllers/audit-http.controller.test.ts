import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { AuditPageResult } from '@hyveon/shared';
import { AuditHttpController } from './audit-http.controller.js';
import type { AuditService } from '../services/AuditService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Default audit page used by most tests. */
const DEFAULT_PAGE: AuditPageResult = {
  entries: [
    {
      sk: '2026-07-17T00:00:00.000Z#01J',
      timestamp: '2026-07-17T00:00:00.000Z',
      actor: 'chris',
      action: 'add',
      game: 'minecraft',
      before: null,
      after: null,
    },
  ],
};

/** Build an AuditService stub with `list` pre-wired to resolve `page`. */
function makeAudit(page: AuditPageResult = DEFAULT_PAGE): AuditService {
  return {
    list: vi.fn().mockResolvedValue(page),
  } as Partial<AuditService> as AuditService;
}

describe('AuditHttpController', () => {
  describe('list', () => {
    it('should return the AuditPageResult from AuditService', async () => {
      const result = await new AuditHttpController(makeAudit()).list();
      expect(result).toEqual(DEFAULT_PAGE);
    });

    it('should call AuditService.list with limit/before undefined when the query is empty', async () => {
      const audit = makeAudit();
      await new AuditHttpController(audit).list();
      expect(audit.list).toHaveBeenCalledWith({ limit: undefined, before: undefined });
    });

    it('should parse a valid limit query string into a number', async () => {
      const audit = makeAudit();
      await new AuditHttpController(audit).list('10');
      expect(audit.list).toHaveBeenCalledWith({ limit: 10, before: undefined });
    });

    it('should forward the before cursor verbatim', async () => {
      const audit = makeAudit();
      await new AuditHttpController(audit).list(undefined, 'cursor-value');
      expect(audit.list).toHaveBeenCalledWith({ limit: undefined, before: 'cursor-value' });
    });

    it('should treat an empty before string the same as an absent query param', async () => {
      const audit = makeAudit();
      await new AuditHttpController(audit).list(undefined, '');
      expect(audit.list).toHaveBeenCalledWith({ limit: undefined, before: undefined });
    });

    it('should throw BadRequestException when limit is not a number', async () => {
      const audit = makeAudit();
      expect(() => new AuditHttpController(audit).list('not-a-number')).toThrow(BadRequestException);
      expect(audit.list).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when limit is zero or negative', async () => {
      const audit = makeAudit();
      expect(() => new AuditHttpController(audit).list('0')).toThrow(BadRequestException);
      expect(() => new AuditHttpController(audit).list('-5')).toThrow(BadRequestException);
    });

    it('should return an empty entries list when there is no audit history', async () => {
      const audit = makeAudit({ entries: [] });
      const result = await new AuditHttpController(audit).list();
      expect(result).toEqual({ entries: [] });
    });
  });
});
