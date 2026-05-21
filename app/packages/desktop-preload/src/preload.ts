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
 * SSE / streaming methods (e.g. `logs.stream`) are intentionally absent —
 * `ipcRenderer.invoke` is request/response only; wire streaming separately
 * via `ipcRenderer.on` in a dedicated channel if needed.
 */

import { contextBridge, ipcRenderer } from 'electron';

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
    get: (game: string, limit?: number) => ipcRenderer.invoke('logs.get', game, limit),
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
