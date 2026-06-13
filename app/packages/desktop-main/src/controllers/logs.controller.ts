import { randomUUID } from 'node:crypto';
import { Controller, OnModuleInit } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { LogsService } from '../services/LogsService.js';
import { logger } from '../logger.js';

/** IPC-only logs controller. Handles Electron main-process messages via
 * `@MessagePattern` — no HTTP routes are registered here.
 *
 * Tails CloudWatch logs from the `/ecs/{game}-server` log group.
 */
@Controller()
export class LogsController implements OnModuleInit {
  constructor(private readonly logs: LogsService) {}

  /**
   * Registers `ipcMain.handle('logs.stream', ...)` after the Nest module is
   * initialised so that `ipcRenderer.invoke('logs.stream', game)` in the
   * preload resolves with `{ streamId }`.
   *
   * `@MessagePattern('logs.stream')` only registers a handler in the
   * transport's internal `ipcMessageDispatcher` — it does **not** call
   * `ipcMain.handle`, so `ipcRenderer.invoke` would otherwise hang. This
   * lifecycle hook bridges the gap by wiring an explicit `ipcMain.handle`
   * that forwards the call into `streamLogs` through the same context shape
   * (`{ evt }`) that `ElectronIPCTransport.onMessage` produces.
   *
   * The electron import is deferred so the module remains loadable in
   * plain-Node test environments where the Electron runtime is absent.
   */
  async onModuleInit(): Promise<void> {
    const { ipcMain } = await import('electron') as unknown as { ipcMain: IpcMain };
    ipcMain.handle('logs.stream', (evt, game: string) =>
      this.streamLogs(game, { evt: evt as IpcMainInvokeEvent }),
    );
  }

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
   * Opens a live log stream for `game` and returns an opaque `streamId`
   * immediately. Chunks are pushed back to the renderer via
   * `evt.sender.send(`logs.stream.${streamId}.chunk`, line)` as they arrive
   * from `FilterLogEvents`. The stream ends with a
   * `logs.stream.${streamId}.end` message carrying `{ error?: string }`.
   *
   * The renderer cancels the stream by sending
   * `logs.stream.${streamId}.cancel` via `ipcRenderer.send`.
   *
   * The controller creates its own `AbortController` per invocation because
   * `ElectronIPCTransport` passes `{ evt }` as the execution context — there
   * is no `signal` property injected by the transport.
   *
   * Reachable via the Electron IPC transport (`logs.stream`).
   */
  @MessagePattern('logs.stream')
  async streamLogs(
    @Payload() game: string,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<{ streamId: string }> {
    const streamId = randomUUID();
    const ac = new AbortController();
    const sender: WebContents = ctx.evt.sender;
    const chunkChannel = `logs.stream.${streamId}.chunk`;
    const endChannel = `logs.stream.${streamId}.end`;
    const cancelChannel = `logs.stream.${streamId}.cancel`;

    // Lazily import ipcMain so the module stays importable in plain-Node test
    // environments where the Electron runtime is absent.
    const { ipcMain } = await import('electron') as unknown as { ipcMain: IpcMain };

    // Register a one-shot cancel listener so the renderer can abort the stream.
    ipcMain.once(cancelChannel, () => {
      ac.abort();
    });

    // Fire-and-forget the streaming loop. Chunks are pushed back to the
    // renderer directly via WebContents.send rather than through the normal
    // invoke reply mechanism, which only supports a single return value.
    void (async () => {
      try {
        for await (const line of this.logs.streamLogs(game, ac.signal)) {
          if (sender.isDestroyed()) break;
          sender.send(chunkChannel, line);
        }
        if (!sender.isDestroyed()) {
          sender.send(endChannel, {});
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          if (!sender.isDestroyed()) sender.send(endChannel, {});
        } else {
          logger.error('Log stream error', { err, game, streamId });
          if (!sender.isDestroyed()) {
            sender.send(endChannel, { error: String(err) });
          }
        }
      } finally {
        // Ensure the cancel listener is removed if the stream ended on its own
        // so it doesn't linger until the next cancel message arrives.
        ipcMain.removeAllListeners(cancelChannel);
      }
    })();

    return { streamId };
  }
}
