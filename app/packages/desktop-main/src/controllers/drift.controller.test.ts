import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { DriftReport } from '@hyveon/shared';
import { DriftController } from './drift.controller.js';
import type { DriftService } from '../services/DriftService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Default drift report used by most tests. */
const DEFAULT_REPORT: DriftReport = {
  entries: [{ game: 'minecraft', kind: 'config_drift', changedFields: ['cpu'] }],
};

/** Build a DriftService stub with `getDrift` pre-wired to resolve `report`. */
function makeDrift(report: DriftReport = DEFAULT_REPORT): DriftService {
  return {
    getDrift: vi.fn().mockResolvedValue(report),
  } as unknown as DriftService;
}

/**
 * The metadata key NestJS stores on each method decorated with
 * `@MessagePattern`. Asserting this value is the only automated guard
 * that prevents a typo in the controller from silently breaking IPC —
 * calling the method directly (as every other test does) would succeed
 * regardless of what string is registered with the transport.
 */
const PATTERN_METADATA_KEY = 'microservices:pattern';

describe('DriftController', () => {
  describe('@MessagePattern channel names', () => {
    it('should register get on the "drift.get" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, DriftController.prototype.get);
      expect(pattern).toEqual(['drift.get']);
    });
  });

  describe('get', () => {
    it('should return the DriftReport from DriftService', async () => {
      const result = await new DriftController(makeDrift()).get();
      expect(result).toEqual(DEFAULT_REPORT);
    });

    it('should delegate to DriftService.getDrift', async () => {
      const drift = makeDrift();
      await new DriftController(drift).get();
      expect(drift.getDrift).toHaveBeenCalledOnce();
    });

    it('should return an empty entries list when there is no drift', async () => {
      const drift = makeDrift({ entries: [] });
      const result = await new DriftController(drift).get();
      expect(result).toEqual({ entries: [] });
    });
  });
});
