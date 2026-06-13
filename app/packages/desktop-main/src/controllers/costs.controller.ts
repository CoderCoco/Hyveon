import { Controller, Get, Query } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ConfigService } from '../services/ConfigService.js';
import { CostService } from '../services/CostService.js';
import { EcsService } from '../services/EcsService.js';

/** Cost-related endpoints: forward-looking per-hour estimates and historical CE-based breakdowns. */
@Controller('costs')
export class CostsController {
  constructor(
    private readonly config: ConfigService,
    private readonly costs: CostService,
    private readonly ecs: EcsService,
  ) {}

  /**
   * Estimates the hourly Fargate cost of each game from its task definition's
   * CPU/memory, plus the sum-if-everything-were-running. Reads the game list
   * from tfstate; falls back to `2048 cpu / 8192 MiB` if the task definition
   * can't be resolved. Returns zeros when tfstate is missing.
   *
   * Reachable via HTTP (`GET /costs/estimate`) and the Electron IPC transport
   * (`costs.estimate`).
   */
  @Get('estimate')
  @MessagePattern('costs.estimate')
  async estimate() {
    const outputs = this.config.getTfOutputs();
    if (!outputs) {
      return { games: {}, totalPerHourIfAllOn: 0 };
    }

    const estimates: Record<string, ReturnType<CostService['estimateForSpec']>> = {};
    for (const game of outputs.game_names) {
      const td = await this.ecs.getTaskDefinition(game);
      estimates[game] = this.costs.estimateForSpec(td?.cpu ?? 2048, td?.memory ?? 8192);
    }

    const totalPerHourIfAllOn = Object.values(estimates).reduce((sum, e) => sum + e.costPerHour, 0);

    return {
      games: estimates,
      totalPerHourIfAllOn: Math.round(totalPerHourIfAllOn * 10000) / 10000,
    };
  }

  /**
   * Returns actual costs over the trailing `days` window (default 7) via Cost
   * Explorer, grouped by the `Project` cost-allocation tag. Requires the tag
   * to have been activated in AWS Billing — see CLAUDE.md "Cost Tagging".
   *
   * Reachable via HTTP (`GET /costs/actual?days=N`) and the Electron IPC
   * transport (`costs.actual`) with `days` supplied as a bare string or number
   * in the payload.
   */
  @Get('actual')
  @MessagePattern('costs.actual')
  actual(@Query('days') @Payload() daysRaw?: string | number) {
    const days = parseInt(String(daysRaw ?? '7'), 10);
    return this.costs.getActualCosts(days);
  }
}
