import { contextBridge, ipcRenderer } from 'electron';

/**
 * Electron preload script. Exposes a typed IPC bridge as `window.gsd` so the
 * renderer can invoke NestJS controller methods without requiring Node access.
 *
 * Channel naming convention: `<namespace>.<action>` — mirrors the
 * `@MessagePattern` decorators on the desktop-main controllers.
 *
 * SSE-based endpoints (e.g. logs stream) are intentionally omitted here;
 * streaming over IPC requires a separate event-based approach outside the
 * request/response `invoke` pattern.
 */
contextBridge.exposeInMainWorld('gsd', {
  /** Game-server lifecycle: list games, query status, start/stop ECS tasks. */
  games: {
    /** Lists game keys from Terraform tfstate. */
    list: () => ipcRenderer.invoke('games.list'),
    /** Returns ECS status for every game in parallel. */
    status: () => ipcRenderer.invoke('games.status'),
    /** Returns ECS status for a single game. */
    getStatus: (game: string) => ipcRenderer.invoke('games.getStatus', game),
    /** Launches the `{game}-server` ECS task. */
    start: (game: string) => ipcRenderer.invoke('games.start', game),
    /** Stops the running ECS task for `game`. */
    stop: (game: string) => ipcRenderer.invoke('games.stop', game),
  },

  /** Cost endpoints: forward-looking Fargate estimates and historical CE data. */
  costs: {
    /** Estimates per-game and total hourly Fargate cost. */
    estimate: () => ipcRenderer.invoke('costs.estimate'),
    /** Returns actual costs over a trailing window via Cost Explorer. */
    actual: (days?: number) => ipcRenderer.invoke('costs.actual', days),
  },

  /**
   * CloudWatch log endpoints. The SSE stream (`logs.stream`) is omitted here
   * because IPC `invoke` is request/response only — wire streaming separately
   * via `ipcRenderer.on` if needed.
   */
  logs: {
    /** Returns recent log lines for a game's ECS task. */
    get: (game: string, limit?: number) => ipcRenderer.invoke('logs.get', game, limit),
  },

  /** EFS file-manager task endpoints: status, start, and stop per game. */
  files: {
    /** Returns whether a file-manager task is running for `game`, with connection details. */
    getStatus: (game: string) => ipcRenderer.invoke('files.getStatus', game),
    /** Launches an ECS file-manager task for `game`. */
    start: (game: string) => ipcRenderer.invoke('files.start', game),
    /** Stops the file-manager task for `game`. */
    stop: (game: string) => ipcRenderer.invoke('files.stop', game),
  },

  /** Discord bot configuration: credentials, guild allowlist, admins, permissions, command registration. */
  discord: {
    /** Returns the Discord config with secrets redacted to booleans. */
    getConfig: () => ipcRenderer.invoke('discord.getConfig'),
    /** Updates bot token, client ID, and/or public key in Secrets Manager. */
    putConfig: (body: { botToken?: string; clientId?: string; publicKey?: string }) =>
      ipcRenderer.invoke('discord.putConfig', body),
    /** Lists dynamic and Terraform-base allowed guild IDs. */
    listGuilds: () => ipcRenderer.invoke('discord.listGuilds'),
    /** Adds a guild ID to the dynamic allowlist in DynamoDB. */
    addGuild: (guildId: string) => ipcRenderer.invoke('discord.addGuild', guildId),
    /** Removes a guild ID from the dynamic allowlist. */
    removeGuild: (guildId: string) => ipcRenderer.invoke('discord.removeGuild', guildId),
    /** Registers slash commands for a guild in the Discord developer portal. */
    registerCommands: (guildId: string) => ipcRenderer.invoke('discord.registerCommands', guildId),
    /** Returns the dynamic and Terraform-base admin user/role lists. */
    getAdmins: () => ipcRenderer.invoke('discord.getAdmins'),
    /** Replaces the dynamic admin user/role lists. */
    putAdmins: (body: { userIds?: string[]; roleIds?: string[] }) =>
      ipcRenderer.invoke('discord.putAdmins', body),
    /** Returns the per-game permission map. */
    getPermissions: () => ipcRenderer.invoke('discord.getPermissions'),
    /** Sets allowed users/roles/actions for a single game. */
    putPermission: (
      game: string,
      body: { userIds?: string[]; roleIds?: string[]; actions?: string[] },
    ) => ipcRenderer.invoke('discord.putPermission', game, body),
    /** Removes the permission entry for a game. */
    deletePermission: (game: string) => ipcRenderer.invoke('discord.deletePermission', game),
  },

  /** Environment metadata: region, domain, and environment label for UI display. */
  env: {
    /** Returns region, domain, and environment label derived from Terraform outputs. */
    get: () => ipcRenderer.invoke('env.get'),
  },

  /** Watchdog configuration stored in server_config.json. */
  config: {
    /** Returns the current watchdog config (interval, idle-check count, min packets). */
    get: () => ipcRenderer.invoke('config.get'),
    /** Partially updates the watchdog config on disk. */
    update: (body: {
      watchdog_interval_minutes?: number;
      watchdog_idle_checks?: number;
      watchdog_min_packets?: number;
    }) => ipcRenderer.invoke('config.update', body),
  },
});
