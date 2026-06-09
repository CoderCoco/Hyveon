import { Controller, Get, Param, Post } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ConfigService } from '../services/ConfigService.js';
import { EcsService } from '../services/EcsService.js';

/** Core game-server endpoints: list games from tfstate, query status, and run/stop the per-game ECS tasks. */
@Controller()
export class GamesController {
  constructor(
    private readonly config: ConfigService,
    private readonly ecs: EcsService,
  ) {}

  /**
   * Lists game keys from the Terraform `game_servers` map. Invalidates the
   * tfstate cache first so a fresh `terraform apply` shows up without having
   * to restart the server.
   *
   * Reachable via HTTP GET /api/games (integration tests, Docker) and the
   * Electron IPC transport (`games.list`).
   */
  @Get('games')
  @MessagePattern('games.list')
  listGames(): { games: string[] } {
    this.config.invalidateCache();
    const outputs = this.config.getTfOutputs();
    return { games: outputs?.game_names ?? [] };
  }

  /**
   * Returns the current ECS status of every game in parallel. Also
   * invalidates the tfstate cache — this is the endpoint the dashboard polls,
   * so it's the natural place to pick up newly-added games.
   *
   * Reachable via HTTP GET /api/status (integration tests, Docker) and the
   * Electron IPC transport (`games.status`).
   */
  @Get('status')
  @MessagePattern('games.status')
  async listStatus() {
    this.config.invalidateCache();
    const outputs = this.config.getTfOutputs();
    if (!outputs) return [];
    return Promise.all(outputs.game_names.map((g) => this.ecs.getStatus(g)));
  }

  /**
   * Returns status for a single game. Does not invalidate the tfstate cache
   * (kept cheap for frequent polling).
   *
   * Dual-transport: `@Get('status/:game')` serves the HTTP surface used by the
   * integration-test server and Docker; `@MessagePattern` serves the Electron
   * IPC transport. Under HTTP `@Param` resolves the game name; under IPC
   * `@Payload` resolves it. The handler merges both so either transport works.
   */
  @Get('status/:game')
  @MessagePattern('games.getStatus')
  getStatus(@Param('game') httpGame: string, @Payload() ipcGame: string) {
    return this.ecs.getStatus(ipcGame ?? httpGame);
  }

  /**
   * Launches the `{game}-server` task via `ecs.run_task()`. There is no
   * long-running ECS Service by design — this is the only way a game starts.
   *
   * Dual-transport: `@Post('start/:game')` for HTTP; `@MessagePattern` for IPC.
   */
  @Post('start/:game')
  @MessagePattern('games.start')
  start(@Param('game') httpGame: string, @Payload() ipcGame: string) {
    return this.ecs.start(ipcGame ?? httpGame);
  }

  /**
   * Stops the running task for `game`. Triggers the EventBridge → update-dns
   * Lambda path that deletes the Route 53 record.
   *
   * Dual-transport: `@Post('stop/:game')` for HTTP; `@MessagePattern` for IPC.
   */
  @Post('stop/:game')
  @MessagePattern('games.stop')
  stop(@Param('game') httpGame: string, @Payload() ipcGame: string) {
    return this.ecs.stop(ipcGame ?? httpGame);
  }
}
