import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { CostsHttpController } from './costs-http.controller.js';
import type { ConfigService, TfOutputs } from '../services/ConfigService.js';
import type { CostService } from '../services/CostService.js';
import type { EcsService } from '../services/EcsService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** A canned estimate object returned by CostService stubs. */
const MOCK_ESTIMATE = {
  vcpu: 4,
  memoryGb: 16,
  costPerHour: 0.5,
  costPerDay24h: 12,
  costPerMonth4hpd: 60,
};

/** Build a ConfigService stub with a minimal set of Terraform outputs. */
function makeConfig(outputs: Partial<TfOutputs> | null = { game_names: ['minecraft'] }): ConfigService {
  return {
    getTfOutputs: vi.fn().mockReturnValue(outputs),
  } as unknown as ConfigService;
}

/** Build a CostService stub whose estimateForSpec returns the canned estimate. */
function makeCosts(): CostService {
  return {
    estimateForSpec: vi.fn().mockReturnValue(MOCK_ESTIMATE),
    getActualCosts: vi.fn().mockResolvedValue({ daily: [], total: 0, currency: 'USD', days: 7 }),
  } as unknown as CostService;
}

/**
 * Build an EcsService stub. Pass `null` to simulate a missing task definition
 * (e.g. the game has never been deployed).
 */
function makeEcs(td: { cpu: number; memory: number } | null = { cpu: 4096, memory: 16384 }): EcsService {
  return {
    getTaskDefinition: vi.fn().mockResolvedValue(td),
  } as unknown as EcsService;
}

describe('CostsHttpController', () => {
  describe('estimate', () => {
    it('should return zeroed estimates when Terraform has not been applied', async () => {
      const result = await new CostsHttpController(makeConfig(null), makeCosts(), makeEcs()).estimate();
      expect(result).toEqual({ games: {}, totalPerHourIfAllOn: 0 });
    });

    it('should call getTaskDefinition and estimateForSpec for each game', async () => {
      const ecs = makeEcs();
      const costs = makeCosts();
      await new CostsHttpController(makeConfig(), costs, ecs).estimate();
      expect(ecs.getTaskDefinition).toHaveBeenCalledWith('minecraft');
      expect(costs.estimateForSpec).toHaveBeenCalledWith(4096, 16384);
    });

    it('should fall back to 2048 cpu / 8192 memory when getTaskDefinition returns null', async () => {
      const ecs = makeEcs(null);
      const costs = makeCosts();
      await new CostsHttpController(makeConfig(), costs, ecs).estimate();
      expect(costs.estimateForSpec).toHaveBeenCalledWith(2048, 8192);
    });

    it('should sum costPerHour across all games for totalPerHourIfAllOn', async () => {
      const config = makeConfig({ game_names: ['minecraft', 'palworld'] });
      const costs = makeCosts();
      vi.mocked(costs.estimateForSpec).mockReturnValue({ ...MOCK_ESTIMATE, costPerHour: 0.25 });
      const result = await new CostsHttpController(config, costs, makeEcs()).estimate();
      // 2 games × $0.25/hr = $0.50/hr, rounded to 4 decimal places
      expect(result.totalPerHourIfAllOn).toBe(0.5);
    });

    it('should include an estimate entry for each game', async () => {
      const config = makeConfig({ game_names: ['minecraft', 'palworld'] });
      const result = await new CostsHttpController(config, makeCosts(), makeEcs()).estimate();
      expect(Object.keys(result.games)).toEqual(['minecraft', 'palworld']);
    });
  });

  describe('actual', () => {
    it('should default to 7 days when the query param is absent', () => {
      const costs = makeCosts();
      new CostsHttpController(makeConfig(), costs, makeEcs()).actual(undefined);
      expect(costs.getActualCosts).toHaveBeenCalledWith(7);
    });

    it('should parse the days query string and forward the integer to CostService', () => {
      const costs = makeCosts();
      new CostsHttpController(makeConfig(), costs, makeEcs()).actual('14');
      expect(costs.getActualCosts).toHaveBeenCalledWith(14);
    });

    it('should return whatever CostService returns', async () => {
      const costs = makeCosts();
      vi.mocked(costs.getActualCosts).mockResolvedValue({
        daily: [{ date: '2026-05-01', cost: 1.23 }],
        total: 1.23,
        currency: 'USD',
        days: 7,
      });
      const result = await new CostsHttpController(makeConfig(), costs, makeEcs()).actual('7');
      expect(result).toMatchObject({ total: 1.23, currency: 'USD' });
    });
  });
});
