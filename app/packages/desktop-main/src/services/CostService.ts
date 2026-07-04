import { Injectable } from '@nestjs/common';
import { AwsCloudProvider, FARGATE_VCPU_PER_HOUR, FARGATE_GB_PER_HOUR } from '@hyveon/cloud-aws';
import { logger } from '../logger.js';

/** Per-game Fargate cost projection derived from its CPU/memory spec. */
export interface GameEstimate {
  vcpu: number;
  memoryGb: number;
  costPerHour: number;
  costPerDay24h: number;
  costPerMonth4hpd: number;
}

/** Aggregate of per-game estimates plus the cost if every game were running simultaneously. */
export interface CostEstimates {
  games: Record<string, GameEstimate>;
  totalPerHourIfAllOn: number;
}

/**
 * Actual-billed-cost snapshot for the Cost Explorer tab. `error` is set when
 * the Cost Explorer call failed so the UI can show a message instead of
 * silently rendering zeros.
 */
export interface ActualCosts {
  daily: { date: string; cost: number }[];
  total: number;
  currency: string;
  days: number;
  error?: string;
}

/**
 * Produces the numbers that back the Cost Explorer tab: static Fargate
 * estimates derived from each game's task-definition CPU/memory, and the
 * actual billed total pulled from AWS Cost Explorer (ECS + Fargate only).
 */
@Injectable()
export class CostService {
  constructor(private readonly provider: AwsCloudProvider = new AwsCloudProvider()) {}

  /**
   * Translate a Fargate task's raw `cpu` (1024 = 1 vCPU) and `memory` (MiB)
   * into projected dollar costs. Pure arithmetic — no AWS calls — so it's
   * safe to run in a tight loop over every game.
   */
  estimateForSpec(cpuUnits: number, memoryMib: number): GameEstimate {
    const vcpu = cpuUnits / 1024;
    const memGb = memoryMib / 1024;
    const hourly = vcpu * FARGATE_VCPU_PER_HOUR + memGb * FARGATE_GB_PER_HOUR;
    return {
      vcpu,
      memoryGb: memGb,
      costPerHour: Math.round(hourly * 10000) / 10000,
      costPerDay24h: Math.round(hourly * 24 * 100) / 100,
      costPerMonth4hpd: Math.round(hourly * 4 * 30 * 100) / 100,
    };
  }

  /**
   * Pull daily billed cost for ECS + Fargate over the trailing `days` window
   * from Cost Explorer. Swallows errors into the returned `error` field so
   * the UI can keep rendering the rest of the dashboard if Cost Explorer is
   * unavailable or not yet enabled on the account.
   */
  async getActualCosts(days = 7): Promise<ActualCosts> {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);

    try {
      const { total, currency, breakdown } = await this.provider.getActualCosts({ start, end });
      const daily = Object.entries(breakdown).map(([date, cost]) => ({ date, cost }));
      return { daily, total, currency, days };
    } catch (err) {
      logger.error('Failed to fetch actual costs', { err });
      return { daily: [], total: 0, currency: 'USD', days, error: String(err) };
    }
  }
}
