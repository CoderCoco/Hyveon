import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { GameListEntry, GameServer, GameWriteResult } from '@hyveon/shared';
import { ConfigService } from '../services/ConfigService.js';
import { EcsService } from '../services/EcsService.js';
import { TfvarsService } from '../services/TfvarsService.js';
import { GamesWriteService } from '../services/GamesWriteService.js';
import { mergeGameLists } from '../services/mergeGameLists.js';

/** Request body for `POST /api/games` and `PATCH /api/games/:name`. */
interface GameWriteBody {
  name?: string;
  config: Omit<GameServer, 'name'>;
}

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
    private readonly gamesWrite: GamesWriteService,
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

  /**
   * Creates a new `game_servers` entry. `If-Match` (optional) is forwarded to
   * {@link GamesWriteService.createGame} as `expectedVersionId` so the
   * S3-mode conditional-put guard is honoured. See {@link mapWriteResult} for
   * the result → HTTP status mapping.
   */
  @Post('games')
  async createGame(
    @Body() body: GameWriteBody,
    @Headers('if-match') ifMatch?: string,
  ): Promise<GameWriteResult> {
    const result = await this.gamesWrite.createGame({
      name: body.name ?? '',
      config: body.config,
      expectedVersionId: ifMatch,
    });
    return this.mapWriteResult(result);
  }

  /**
   * Replaces an existing `game_servers` entry, identified by the `:name`
   * route param. `If-Match` (optional) is forwarded to
   * {@link GamesWriteService.updateGame} as `expectedVersionId`. See
   * {@link mapWriteResult} for the result → HTTP status mapping.
   */
  @Patch('games/:name')
  async updateGame(
    @Param('name') name: string,
    @Body() body: GameWriteBody,
    @Headers('if-match') ifMatch?: string,
  ): Promise<GameWriteResult> {
    const result = await this.gamesWrite.updateGame({
      name,
      config: body.config,
      expectedVersionId: ifMatch,
    });
    return this.mapWriteResult(result);
  }

  /**
   * Removes a `game_servers` entry, identified by the `:name` route param.
   * `If-Match` (optional) is forwarded to
   * {@link GamesWriteService.deleteGame} as `expectedVersionId`. See
   * {@link mapWriteResult} for the result → HTTP status mapping.
   */
  @Delete('games/:name')
  async deleteGame(
    @Param('name') name: string,
    @Headers('if-match') ifMatch?: string,
  ): Promise<GameWriteResult> {
    const result = await this.gamesWrite.deleteGame({ name, expectedVersionId: ifMatch });
    return this.mapWriteResult(result);
  }

  /**
   * Maps a {@link GameWriteResult} from `GamesWriteService` onto its HTTP
   * representation: `ok: true` passes through as a 200 body; each failure
   * `code` throws the matching Nest exception so the global exception filter
   * produces the right status code, with the result's fields preserved on
   * the exception body (`currentVersionId`/`expectedVersionId` for
   * conflicts, `issues` for validation failures).
   */
  private mapWriteResult(result: GameWriteResult): GameWriteResult {
    if (result.ok) return result;

    switch (result.code) {
      case 'conflict':
        throw new ConflictException({
          message: result.message,
          code: result.code,
          currentVersionId: result.currentVersionId,
          expectedVersionId: result.expectedVersionId,
        });
      case 'validation':
        throw new HttpException({ code: result.code, issues: result.issues }, 422);
      case 'not_found':
        throw new NotFoundException({ message: result.message, code: result.code });
      case 'error':
      default:
        throw new InternalServerErrorException({ message: result.message, code: result.code });
    }
  }
}
