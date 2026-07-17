import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { AuditPageResult } from '@hyveon/shared';
import { AuditController } from './audit.controller.js';
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

/**
 * The metadata key NestJS stores on each method decorated with
 * `@MessagePattern`. Asserting this value is the only automated guard
 * that prevents a typo in the controller from silently breaking IPC —
 * calling the method directly (as every other test does) would succeed
 * regardless of what string is registered with the transport.
 */
const PATTERN_METADATA_KEY = 'microservices:pattern';

describe('AuditController', () => {
  describe('@MessagePattern channel names', () => {
    it('should register list on the "audit.list" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, AuditController.prototype.list);
      expect(pattern).toEqual(['audit.list']);
    });
  });

  describe('list', () => {
    it('should return the AuditPageResult from AuditService', async () => {
      const result = await new AuditController(makeAudit()).list();
      expect(result).toEqual(DEFAULT_PAGE);
    });

    it('should delegate to AuditService.list with the given opts', async () => {
      const audit = makeAudit();
      const opts = { limit: 10, before: 'cursor-value' };
      await new AuditController(audit).list(opts);
      expect(audit.list).toHaveBeenCalledWith(opts);
    });

    it('should default to an empty opts object when called with no arguments', async () => {
      const audit = makeAudit();
      await new AuditController(audit).list();
      expect(audit.list).toHaveBeenCalledWith({});
    });

    it('should return an empty entries list when there is no audit history', async () => {
      const audit = makeAudit({ entries: [] });
      const result = await new AuditController(audit).list();
      expect(result).toEqual({ entries: [] });
    });
  });
});
