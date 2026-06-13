import { Controller, Get, Param, Post } from '@nestjs/common';
import { ConfigService } from '../services/ConfigService.js';
import { EcsService } from '../services/EcsService.js';

/**
 * HTTP shim that exposes the game-server operations as plain REST endpoints
 * (`/api/games`, `/api/status`, `/api/status/:game`, `/api/start/:game`,
 * `/api/stop/:game`). The browser client (`api.service.ts`) and the
 * integration-test server both consume these routes over HTTP; the Electron
 * main-process host uses the IPC {@link GamesController} (`@MessagePattern`)
 * handlers instead.
 *
 * Both controllers delegate to the same {@link ConfigService} and
 * {@link EcsService} providers — there is no duplicated logic.
 */
@Controller()
export class GamesHttpController {
  constructor(
    private readonly config: ConfigService,
    private readonly ecs: EcsService,
  ) {}

  /**
   * Lists game keys from the Terraform `game_servers` map. Invalidates the
   * tfstate cache first so a fresh `terraform apply` shows up without having
   * to restart the server.
   */
  @Get('games')
  listGames(): { games: string[] } {
    this.config.invalidateCache();
    const outputs = this.config.getTfOutputs();
    return { games: outputs?.game_names ?? [] };
  }

  /**
   * Returns the current ECS status of every game in parallel. Also
   * invalidates the tfstate cache — this is the endpoint the dashboard polls,
   * so it's the natural place to pick up newly-added games.
   */
  @Get('status')
  async listStatus() {
    this.config.invalidateCache();
    const outputs = this.config.getTfOutputs();
    if (!outputs) return [];
    return Promise.all(outputs.game_names.map((g) => this.ecs.getStatus(g)));
  }

  /**
   * Returns status for a single game. Does not invalidate the tfstate cache
   * (kept cheap for frequent per-game polling).
   */
  @Get('status/:game')
  getStatus(@Param('game') game: string) {
    return this.ecs.getStatus(game);
  }

  /** Launches the `{game}-server` task via `ecs.run_task()`. There is no long-running ECS Service by design — this is the only way a game starts. */
  @Post('start/:game')
  start(@Param('game') game: string) {
    return this.ecs.start(game);
  }

  /** Stops the running task for `game`. Triggers the EventBridge → update-dns Lambda path that deletes the Route 53 record. */
  @Post('stop/:game')
  stop(@Param('game') game: string) {
    return this.ecs.stop(game);
  }
}
