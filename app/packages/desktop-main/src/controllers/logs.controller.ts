import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { LogsService } from '../services/LogsService.js';

/** IPC-only logs controller. Handles Electron main-process messages via
 * `@MessagePattern` — no HTTP routes are registered here.
 *
 * Tails CloudWatch logs from the `/ecs/{game}-server` log group.
 */
@Controller()
export class LogsController {
  constructor(private readonly logs: LogsService) {}

  /**
   * Returns the most recent `limit` (default 50) log lines for a game's ECS task.
   *
   * Reachable via the Electron IPC transport (`logs.get`).
   */
  @MessagePattern('logs.get')
  async getRecentLogs(
    @Payload() payload: { game: string; limit?: number },
  ): Promise<{ game: string; lines: string[] }> {
    const { game, limit = 50 } = payload;
    const lines = await this.logs.getRecentLogs(game, limit);
    return { game, lines };
  }

  /**
   * Async-generator stream of new log lines for a game, delivered as they
   * arrive from `FilterLogEvents`. The `AbortSignal` is sourced from the
   * Nest execution context (`ctx.signal`) as wired by
   * `StreamingElectronIPCTransport` — the renderer cancels the stream by
   * sending the matching `.cancel` IPC message.
   *
   * Reachable via the Electron IPC transport (`logs.stream`).
   */
  @MessagePattern('logs.stream')
  async *streamLogs(
    @Payload() game: string,
    ctx: { signal: AbortSignal },
  ): AsyncGenerator<string> {
    yield* this.logs.streamLogs(game, ctx.signal);
  }
}
