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
   * Registers an `ipcMain.handle` bridge for the `logs.stream` channel after
   * the Nest module initialises, so that `ipcRenderer.invoke('logs.stream')`
   * in the preload resolves with `{ streamId }`.
   *
   * `@MessagePattern('logs.stream')` only wires the transport's internal
   * dispatcher — it does **not** call `ipcMain.handle`, so `ipcRenderer.invoke`
   * would otherwise hang. This hook bridges the gap.
   *
   * Only runs inside a real Electron main process. In plain-Node runtimes
   * (integration test server, Docker, CI) `process.versions.electron` is
   * undefined and importing `electron` would throw — either MODULE_NOT_FOUND
   * or "Electron failed to install correctly" when the package is present but
   * its binary isn't — so we skip the bridge entirely rather than guessing
   * which error means "no Electron" from the message. When we *are* in
   * Electron, the import succeeds and any `ipcMain.handle` failure propagates
   * so a broken bridge fails startup loudly instead of hanging invoke.
   */
  async onModuleInit(): Promise<void> {
    if (!process.versions.electron) {
      // Not running inside the Electron main process — ipcMain bridge skipped.
      return;
    }
    const { ipcMain } = await import('electron') as unknown as { ipcMain: IpcMain };
    // Remove any existing handler first so hot-reload re-registration does
    // not throw "IPC channel already registered".
    ipcMain.removeHandler('logs.stream');
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
   * immediately. Chunks are pushed to the renderer via `sender.send` on the
   * `logs.stream.<streamId>.chunk` channel as they arrive from FilterLogEvents.
   * The stream terminates with a `logs.stream.<streamId>.end` message
   * carrying `{ error?: string }`.
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
          if (sender.isDestroyed()) { ac.abort(); break; }
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
