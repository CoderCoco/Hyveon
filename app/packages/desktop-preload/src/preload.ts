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
 * Log streaming uses an invoke+event pattern: `logs.stream` invokes main to
 * start a stream and returns a `streamId`; `logs.onChunk` / `logs.onEnd`
 * subscribe to per-stream IPC events; `logs.cancel` sends a cancel signal.
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

import type { GsdApi } from './gsd-api.js';

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
    stream: (game: string) => ipcRenderer.invoke('logs.stream', game),
    onChunk: (streamId: string, cb: (chunk: string) => void) => {
      const ch = `logs.stream.${streamId}.chunk`;
      const handler = (_evt: IpcRendererEvent, chunk: string) => cb(chunk);
      ipcRenderer.on(ch, handler);
      return () => ipcRenderer.removeListener(ch, handler);
    },
    onEnd: (streamId: string, cb: (err?: string) => void) => {
      const ch = `logs.stream.${streamId}.end`;
      const handler = (_evt: IpcRendererEvent, data: { error?: string }) => cb(data?.error);
      ipcRenderer.once(ch, handler);
      return () => ipcRenderer.removeListener(ch, handler);
    },
    cancel: (streamId: string) => {
      ipcRenderer.send(`logs.stream.${streamId}.cancel`);
    },
  },

  files: {
    getStatus: (game: string) => ipcRenderer.invoke('files.getStatus', game),
    start: (game: string) => ipcRenderer.invoke('files.start', game),
    stop: (game: string) => ipcRenderer.invoke('files.stop', game),
  },

  discord: {
    getConfig: () => ipcRenderer.invoke('discord.getConfig'),
    putConfig: (body: { botToken?: string; clientId?: string; publicKey?: string }) =>
      ipcRenderer.invoke('discord.putConfig', body),
    listGuilds: () => ipcRenderer.invoke('discord.listGuilds'),
    addGuild: (guildId: string) => ipcRenderer.invoke('discord.addGuild', guildId),
    removeGuild: (guildId: string) => ipcRenderer.invoke('discord.removeGuild', guildId),
    registerCommands: (guildId: string) => ipcRenderer.invoke('discord.registerCommands', guildId),
    getAdmins: () => ipcRenderer.invoke('discord.getAdmins'),
    putAdmins: (body: { userIds?: string[]; roleIds?: string[] }) =>
      ipcRenderer.invoke('discord.putAdmins', body),
    getPermissions: () => ipcRenderer.invoke('discord.getPermissions'),
    putPermission: (
      game: string,
      body: { userIds?: string[]; roleIds?: string[]; actions?: string[] },
    ) => ipcRenderer.invoke('discord.putPermission', game, body),
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
};

contextBridge.exposeInMainWorld('gsd', api);
