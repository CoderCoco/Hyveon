/**
 * Electron preload script.
 *
 * Runs in a sandboxed Node context before the renderer loads. Exposes a
 * typed `window.gsd` bridge via `contextBridge` so the renderer can call
 * into the main process over IPC without any direct access to Node or
 * Electron internals.
 *
 * Channel naming convention: `<namespace>.<action>`
 *
 * Log streaming exposes a single async iterable: `logs.stream(game, signal)`
 * invokes main to open a stream (returning an opaque `streamId`), then wraps
 * the per-stream `logs.stream.<id>.chunk` / `.end` IPC events in an async
 * generator. Aborting the supplied `AbortSignal` — or breaking out of the
 * `for await` loop — sends `logs.stream.<id>.cancel` to stop the main loop.
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

import type { GsdApi, LogChunk } from './gsd-api.js';

/**
 * Bridges the per-stream chunk/end/cancel IPC channels into an
 * {@link AsyncIterable} of log chunks.
 *
 * Opens the stream via `ipcRenderer.invoke('logs.stream', game)`, buffers
 * incoming chunks, and yields them in order. Completes when the `.end` event
 * fires (throwing if it carried an `error`). If the consumer aborts the
 * `signal` or breaks out of the loop early, the `finally` block detaches all
 * listeners and sends `.cancel` so the main process tears the stream down.
 *
 * The listener-attach happens after the `invoke` resolves with the `streamId`,
 * which is the only point the chunk/end channel names are known — identical to
 * the prior callback implementation, so there is no new dropped-chunk window.
 */
async function* streamLogs(game: string, signal?: AbortSignal): AsyncIterable<LogChunk> {
  const { streamId } = (await ipcRenderer.invoke('logs.stream', game)) as { streamId: string };
  const chunkChannel = `logs.stream.${streamId}.chunk`;
  const endChannel = `logs.stream.${streamId}.end`;
  const sendCancel = () => ipcRenderer.send(`logs.stream.${streamId}.cancel`);

  /** Chunks received but not yet yielded. */
  const buffer: LogChunk[] = [];
  let ended = false;
  let endError: string | undefined;
  /** Resolves the pending `await` when a chunk arrives or the stream ends. */
  let wake: (() => void) | null = null;
  const signalWake = () => {
    if (wake) {
      const fn = wake;
      wake = null;
      fn();
    }
  };

  const onChunk = (_evt: IpcRendererEvent, chunk: LogChunk) => {
    buffer.push(chunk);
    signalWake();
  };
  const onEnd = (_evt: IpcRendererEvent, data: { error?: string }) => {
    ended = true;
    endError = data?.error;
    signalWake();
  };
  const onAbort = () => sendCancel();

  ipcRenderer.on(chunkChannel, onChunk);
  ipcRenderer.once(endChannel, onEnd);
  if (signal) {
    if (signal.aborted) sendCancel();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      while (buffer.length > 0) {
        yield buffer.shift()!;
      }
      if (ended) {
        if (endError) throw new Error(endError);
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    ipcRenderer.removeListener(chunkChannel, onChunk);
    ipcRenderer.removeListener(endChannel, onEnd);
    signal?.removeEventListener('abort', onAbort);
    // Consumer left before the stream ended (early break/return or abort) —
    // tell the main process to stop tailing so it doesn't leak the loop.
    if (!ended) sendCancel();
  }
}

const api: GsdApi = {
  games: {
    list: () => ipcRenderer.invoke('games.list'),
    status: () => ipcRenderer.invoke('games.status'),
    getStatus: (game: string) => ipcRenderer.invoke('games.getStatus', game),
    start: (game: string) => ipcRenderer.invoke('games.start', game),
    stop: (game: string) => ipcRenderer.invoke('games.stop', game),
  },

  costs: {
    estimate: () => ipcRenderer.invoke('costs.estimate'),
    actual: (days?: number) => ipcRenderer.invoke('costs.actual', days),
  },

  logs: {
    get: (game: string, limit?: number) => ipcRenderer.invoke('logs.get', { game, limit }),
    stream: streamLogs,
  },

  files: {
    list: (game: string) => ipcRenderer.invoke('files.list', game),
    start: (game: string) => ipcRenderer.invoke('files.start', game),
    stop: (game: string) => ipcRenderer.invoke('files.stop', game),
  },

  discord: {
    getConfig: () => ipcRenderer.invoke('discord.getConfig'),
    putConfig: (body: { botToken?: string; clientId?: string; publicKey?: string }) =>
      ipcRenderer.invoke('discord.putConfig', body),
    listGuilds: () => ipcRenderer.invoke('discord.listGuilds'),
    addGuild: (guildId: string) => ipcRenderer.invoke('discord.addGuild', { guildId }),
    removeGuild: (guildId: string) => ipcRenderer.invoke('discord.removeGuild', guildId),
    registerCommands: (guildId: string) => ipcRenderer.invoke('discord.registerCommands', guildId),
    getAdmins: () => ipcRenderer.invoke('discord.getAdmins'),
    putAdmins: (body: { userIds?: string[]; roleIds?: string[] }) =>
      ipcRenderer.invoke('discord.putAdmins', body),
    getPermissions: () => ipcRenderer.invoke('discord.getPermissions'),
    putPermission: (
      game: string,
      body: { userIds?: string[]; roleIds?: string[]; actions?: string[] },
    ) => ipcRenderer.invoke('discord.putPermission', { game, body }),
    deletePermission: (game: string) => ipcRenderer.invoke('discord.deletePermission', game),
  },

  env: {
    get: () => ipcRenderer.invoke('env.get'),
  },

  config: {
    get: () => ipcRenderer.invoke('config.get'),
    update: (body: {
      watchdog_interval_minutes?: number;
      watchdog_idle_checks?: number;
      watchdog_min_packets?: number;
    }) => ipcRenderer.invoke('config.update', body),
  },

  diagnostics: {
    tail: () => ipcRenderer.invoke('diagnostics.tail'),
    path: () => ipcRenderer.invoke('diagnostics.path'),
  },
};

contextBridge.exposeInMainWorld('gsd', api);
