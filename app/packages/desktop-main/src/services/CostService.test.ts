import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CloudProvider, CostBreakdown, DateRange } from '@hyveon/shared';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CostService } from './CostService.js';

/** `getActualCosts` mock for the injected `CloudProvider` stub. */
const getActualCostsMock = vi.fn<(range: DateRange) => Promise<CostBreakdown>>();

/** Builds a minimal `CloudProvider`-shaped stub — only `getActualCosts` is exercised by `CostService`. */
function makeCloudProvider(): CloudProvider {
  return {
    startWorkload: vi.fn(),
    stopWorkload: vi.fn(),
    getWorkloadStatus: vi.fn(),
    streamWorkloadLogs: vi.fn(),
    getCostEstimate: vi.fn(),
    getActualCosts: getActualCostsMock,
  };
}

describe('CostService', () => {
  /** Fresh service instance per test, backed by the `CloudProvider` stub. */
  let service: CostService;

  beforeEach(() => {
    getActualCostsMock.mockReset();
    service = new CostService(makeCloudProvider());
  });

  describe('estimateForSpec', () => {
    it('should compute Fargate hourly, daily, and monthly costs for 1 vCPU + 2 GiB', () => {
      const est = service.estimateForSpec(1024, 2048);
      expect(est.vcpu).toBe(1);
      expect(est.memoryGb).toBe(2);
      // 1 * 0.04048 + 2 * 0.004445 = 0.04937
      expect(est.costPerHour).toBeCloseTo(0.0494, 4);
      // 0.04937 * 24 = 1.18488 -> 1.18
      expect(est.costPerDay24h).toBeCloseTo(1.18, 2);
      // 0.04937 * 4 * 30 = 5.9244 -> 5.92
      expect(est.costPerMonth4hpd).toBeCloseTo(5.92, 2);
    });

    it('should scale cost linearly with CPU and memory', () => {
      const half = service.estimateForSpec(512, 1024);
      const full = service.estimateForSpec(1024, 2048);
      expect(half.costPerHour).toBeCloseTo(full.costPerHour / 2, 6);
    });

    it('should round hourly cost to at most 4 decimals', () => {
      const est = service.estimateForSpec(256, 512);
      expect(Number.isFinite(est.costPerHour)).toBe(true);
      const decimals = est.costPerHour.toString().split('.')[1] ?? '';
      expect(decimals.length).toBeLessThanOrEqual(4);
    });
  });

  describe('getActualCosts', () => {
    it('should aggregate daily costs and return a total', async () => {
      getActualCostsMock.mockResolvedValue({
        total: 3.73,
        currency: 'USD',
        breakdown: { '2026-04-10': 1.2345, '2026-04-11': 2.5 },
      });

      const result = await service.getActualCosts(2);
      expect(result.days).toBe(2);
      expect(result.currency).toBe('USD');
      expect(result.daily).toEqual([
        { date: '2026-04-10', cost: 1.2345 },
        { date: '2026-04-11', cost: 2.5 },
      ]);
      expect(result.total).toBeCloseTo(3.73, 2);
      expect(result.error).toBeUndefined();
    });

    it('should pass a start/end range spanning the requested number of days to the provider', async () => {
      getActualCostsMock.mockResolvedValue({ total: 0, currency: 'USD', breakdown: {} });
      await service.getActualCosts(7);
      expect(getActualCostsMock).toHaveBeenCalledTimes(1);
      const range = getActualCostsMock.mock.calls[0]![0];
      const diffDays = Math.round((range.end.getTime() - range.start.getTime()) / (24 * 60 * 60 * 1000));
      expect(diffDays).toBe(7);
    });

    it('should return an error shape when the provider throws', async () => {
      getActualCostsMock.mockRejectedValue(new Error('AccessDenied'));
      const result = await service.getActualCosts(7);
      expect(result.total).toBe(0);
      expect(result.daily).toEqual([]);
      expect(result.days).toBe(7);
      expect(result.error).toContain('AccessDenied');
    });

    it('should handle a missing cost amount gracefully', async () => {
      getActualCostsMock.mockResolvedValue({
        total: 0,
        currency: 'USD',
        breakdown: { '2026-04-10': 0 },
      });
      const result = await service.getActualCosts(1);
      expect(result.daily).toEqual([{ date: '2026-04-10', cost: 0 }]);
      expect(result.total).toBe(0);
    });

    it('should default to 7 days when called with no argument', async () => {
      getActualCostsMock.mockResolvedValue({ total: 0, currency: 'USD', breakdown: {} });
      const result = await service.getActualCosts();
      expect(result.days).toBe(7);
    });
  });
});
