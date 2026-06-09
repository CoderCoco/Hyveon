import { Controller } from '@nestjs/common';
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
   */
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
   */
  @MessagePattern('games.status')
  async listStatus() {
    this.config.invalidateCache();
    const outputs = this.config.getTfOutputs();
    if (!outputs) return [];
    return Promise.all(outputs.game_names.map((g) => this.ecs.getStatus(g)));
  }

  /** Returns status for a single game. Does not invalidate the tfstate cache (kept cheap for frequent polling). */
  @MessagePattern('games.getStatus')
  getStatus(@Payload() game: string) {
    return this.ecs.getStatus(game);
  }

  /** Launches the `{game}-server` task via `ecs.run_task()`. There is no long-running ECS Service by design — this is the only way a game starts. */
  @MessagePattern('games.start')
  start(@Payload() game: string) {
    return this.ecs.start(game);
  }

  /** Stops the running task for `game`. Triggers the EventBridge → update-dns Lambda path that deletes the Route 53 record. */
  @MessagePattern('games.stop')
  stop(@Payload() game: string) {
    return this.ecs.stop(game);
  }
}
