import { Controller, Get, Query } from '@nestjs/common';
import { ConfigService } from '../services/ConfigService.js';
import { CostService } from '../services/CostService.js';
import { EcsService } from '../services/EcsService.js';

/**
 * HTTP shim that exposes the cost operations as plain REST endpoints
 * (`/api/costs/estimate`, `/api/costs/actual?days=N`). The browser client
 * (`api.service.ts`) and the integration-test server both consume these routes
 * over HTTP; the Electron main-process host uses the IPC
 * {@link CostsController} (`@MessagePattern`) handlers instead.
 *
 * Both controllers delegate to the same {@link ConfigService},
 * {@link CostService}, and {@link EcsService} providers — the heavy lifting
 * lives in those services, not in the thin orchestration duplicated here.
 */
@Controller('costs')
export class CostsHttpController {
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
   */
  @Get('estimate')
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
   */
  @Get('actual')
  actual(@Query('days') daysRaw?: string) {
    const days = parseInt(String(daysRaw ?? '7'), 10);
    return this.costs.getActualCosts(days);
  }
}
