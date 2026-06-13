import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ConfigService } from '../services/ConfigService.js';
import { EcsService } from '../services/EcsService.js';

/**
 * IPC-only game-server controller. Handles Electron main-process messages via
 * `@MessagePattern` / `@Payload` — no HTTP routes are registered here.
 *
 * The HTTP surface (`/api/games`, `/api/status`, `/api/start/:game`,
 * `/api/stop/:game`) is covered entirely by {@link GamesHttpController}.
 * Both controllers delegate to the same {@link ConfigService} and
 * {@link EcsService} providers — there is no duplicated logic.
 */
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
   * Reachable via the Electron IPC transport (`games.list`).
   */
  @MessagePattern('games.list')
  listGames(): { games: string[] } {
    this.config.invalidateCache();
    const outputs = this.config.getTfOutputs();
    return { games: outputs?.game_names ?? [] };
  }

  /**
   * Returns the current ECS status of every game in parallel. Also
   * invalidates the tfstate cache — this is the natural place to pick up
   * newly-added games when called from the Electron renderer.
   *
   * Reachable via the Electron IPC transport (`games.status`).
   */
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
   * Reachable via the Electron IPC transport (`games.getStatus`).
   */
  @MessagePattern('games.getStatus')
  getStatus(@Payload() game: string) {
    return this.ecs.getStatus(game);
  }

  /**
   * Launches the `{game}-server` task via `ecs.run_task()`. There is no
   * long-running ECS Service by design — this is the only way a game starts.
   *
   * Reachable via the Electron IPC transport (`games.start`).
   */
  @MessagePattern('games.start')
  start(@Payload() game: string) {
    return this.ecs.start(game);
  }

  /**
   * Stops the running task for `game`. Triggers the EventBridge → update-dns
   * Lambda path that deletes the Route 53 record.
   *
   * Reachable via the Electron IPC transport (`games.stop`).
   */
  @MessagePattern('games.stop')
  stop(@Payload() game: string) {
    return this.ecs.stop(game);
  }
}
