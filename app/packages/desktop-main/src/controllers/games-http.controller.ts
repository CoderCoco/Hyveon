import { Controller, Get, Param, Post } from '@nestjs/common';
import type { GameListEntry } from '@hyveon/shared';
import { ConfigService } from '../services/ConfigService.js';
import { EcsService } from '../services/EcsService.js';
import { TfvarsService } from '../services/TfvarsService.js';
import { mergeGameLists } from '../services/mergeGameLists.js';

/**
 * HTTP shim that exposes the game-server operations as plain REST endpoints
 * (`/api/games`, `/api/status`, `/api/status/:game`, `/api/start/:game`,
 * `/api/stop/:game`). The browser client (`api.service.ts`) and the
 * integration-test server both consume these routes over HTTP; the Electron
 * main-process host uses the IPC {@link GamesController} (`@MessagePattern`)
 * handlers instead.
 *
 * Both controllers delegate to the same {@link ConfigService},
 * {@link EcsService}, {@link TfvarsService}, and {@link mergeGameLists}
 * providers — there is no duplicated logic.
 */
@Controller()
export class GamesHttpController {
  constructor(
    private readonly config: ConfigService,
    private readonly ecs: EcsService,
    private readonly tfvars: TfvarsService,
  ) {}

  /**
   * Lists games by merging the declared view (`terraform.tfvars`
   * `game_servers` map, via {@link TfvarsService}) with the deployed view
   * (`terraform.tfstate` `game_names` output, via {@link ConfigService}) —
   * see {@link mergeGameLists}. Invalidates both caches first so a fresh
   * `terraform apply` / tfvars edit shows up without having to restart the
   * server.
   */
  @Get('games')
  async listGames(): Promise<{ games: GameListEntry[] }> {
    this.config.invalidateCache();
    this.tfvars.invalidateCache();
    const outputs = this.config.getTfOutputs();
    const declared = await this.tfvars.getGameServers();
    const deployed = outputs?.game_names ?? [];
    return { games: mergeGameLists(declared, deployed) };
  }

  /**
   * Returns the current ECS status of every game in parallel. Also
   * invalidates the tfstate cache and the `TfvarsService` cache — this is
   * the endpoint the dashboard polls, so it's the natural place to pick up
   * newly-added games.
   */
  @Get('status')
  async listStatus() {
    this.config.invalidateCache();
    this.tfvars.invalidateCache();
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
