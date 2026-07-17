import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.service.js';

/**
 * Builds a fresh `window.gsd` IPC-bridge double. Every namespace method is a
 * `vi.fn()` returning a minimal payload of the right shape, so each `api.*`
 * wrapper has something to await and we can assert it delegated to the matching
 * bridge method with the right arguments.
 */
function makeGsdMock() {
  return {
    games: {
      list: vi.fn().mockResolvedValue({ games: [] }),
      status: vi.fn().mockResolvedValue([]),
      getStatus: vi.fn().mockResolvedValue({ game: 'minecraft', state: 'stopped' }),
      start: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
      stop: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
      create: vi.fn().mockResolvedValue({ ok: true, games: [] }),
      update: vi.fn().mockResolvedValue({ ok: true, games: [] }),
      delete: vi.fn().mockResolvedValue({ ok: true, games: [] }),
    },
    costs: {
      estimate: vi.fn().mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 }),
      actual: vi.fn().mockResolvedValue({ daily: [], total: 0, currency: 'USD', days: 7 }),
    },
    logs: {
      get: vi.fn().mockResolvedValue({ game: 'minecraft', lines: [] }),
      stream: vi.fn(),
    },
    files: {
      list: vi.fn().mockResolvedValue({ game: 'minecraft', state: 'stopped' }),
      start: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
      stop: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
    },
    discord: {
      getConfig: vi.fn().mockResolvedValue({ clientId: '', allowedGuilds: [], gamePermissions: {} }),
      putConfig: vi.fn().mockResolvedValue({ success: true, config: {} }),
      listGuilds: vi.fn().mockResolvedValue({ guilds: [], baseGuilds: [] }),
      addGuild: vi.fn().mockResolvedValue({ success: true, guilds: [], baseGuilds: [] }),
      removeGuild: vi.fn().mockResolvedValue({ success: true, guilds: [], baseGuilds: [] }),
      registerCommands: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
      getAdmins: vi.fn().mockResolvedValue({ userIds: [], roleIds: [], baseAdmins: { userIds: [], roleIds: [] } }),
      putAdmins: vi.fn().mockResolvedValue({ success: true, admins: { userIds: [], roleIds: [] }, baseAdmins: { userIds: [], roleIds: [] } }),
      getPermissions: vi.fn().mockResolvedValue({}),
      putPermission: vi.fn().mockResolvedValue({ success: true, permissions: {} }),
      deletePermission: vi.fn().mockResolvedValue({ success: true, permissions: {} }),
    },
    env: {
      get: vi.fn().mockResolvedValue({ region: 'us-east-1', domain: 'example.com', environment: 'dev' }),
    },
    config: {
      get: vi.fn().mockResolvedValue({ watchdog_interval_minutes: 5, watchdog_idle_checks: 3, watchdog_min_packets: 100 }),
      update: vi.fn().mockResolvedValue({ success: true, config: { watchdog_interval_minutes: 5, watchdog_idle_checks: 3, watchdog_min_packets: 100 } }),
    },
    diagnostics: {
      tail: vi.fn().mockResolvedValue({ lines: [] }),
      path: vi.fn().mockResolvedValue({ path: '/var/log/today.log' }),
    },
    drift: {
      get: vi.fn().mockResolvedValue({ entries: [] }),
    },
  };
}

let gsd: ReturnType<typeof makeGsdMock>;

beforeEach(() => {
  gsd = makeGsdMock();
  vi.stubGlobal('gsd', gsd);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('IPC bridge delegation', () => {
  it('should delegate api.env() to window.gsd.env.get()', async () => {
    await api.env();
    expect(gsd.env.get).toHaveBeenCalledOnce();
  });

  it('should delegate api.games() to window.gsd.games.list()', async () => {
    await api.games();
    expect(gsd.games.list).toHaveBeenCalledOnce();
  });

  it('should delegate api.status() to window.gsd.games.status()', async () => {
    await api.status();
    expect(gsd.games.status).toHaveBeenCalledOnce();
  });

  it('should delegate api.statusGame() to window.gsd.games.getStatus() with the game id', async () => {
    await api.statusGame('minecraft');
    expect(gsd.games.getStatus).toHaveBeenCalledWith('minecraft');
  });

  it('should delegate api.start() to window.gsd.games.start() with the game id', async () => {
    await api.start('minecraft');
    expect(gsd.games.start).toHaveBeenCalledWith('minecraft');
  });

  it('should delegate api.stop() to window.gsd.games.stop() with the game id', async () => {
    await api.stop('palworld');
    expect(gsd.games.stop).toHaveBeenCalledWith('palworld');
  });

  it('should delegate api.config() to window.gsd.config.get()', async () => {
    await api.config();
    expect(gsd.config.get).toHaveBeenCalledOnce();
  });

  it('should delegate api.saveConfig() to window.gsd.config.update() with the config', async () => {
    const cfg = { watchdog_interval_minutes: 10, watchdog_idle_checks: 4, watchdog_min_packets: 50 };
    await api.saveConfig(cfg);
    expect(gsd.config.update).toHaveBeenCalledWith(cfg);
  });

  it('should delegate api.costsEstimate() to window.gsd.costs.estimate()', async () => {
    await api.costsEstimate();
    expect(gsd.costs.estimate).toHaveBeenCalledOnce();
  });

  it('should delegate api.costsActual() to window.gsd.costs.actual() with the days window', async () => {
    await api.costsActual(14);
    expect(gsd.costs.actual).toHaveBeenCalledWith(14);
  });

  it('should default api.costsActual() to a 7-day window', async () => {
    await api.costsActual();
    expect(gsd.costs.actual).toHaveBeenCalledWith(7);
  });

  it('should delegate api.filesMgrStatus() to window.gsd.files.list() with the game id', async () => {
    await api.filesMgrStatus('minecraft');
    expect(gsd.files.list).toHaveBeenCalledWith('minecraft');
  });

  it('should delegate api.filesMgrStart() to window.gsd.files.start() with the game id', async () => {
    await api.filesMgrStart('minecraft');
    expect(gsd.files.start).toHaveBeenCalledWith('minecraft');
  });

  it('should delegate api.filesMgrStop() to window.gsd.files.stop() with the game id', async () => {
    await api.filesMgrStop('minecraft');
    expect(gsd.files.stop).toHaveBeenCalledWith('minecraft');
  });

  it('should delegate api.createGame() to window.gsd.games.create() with the exact payload', async () => {
    const payload = {
      name: 'minecraft',
      config: {
        image: 'itzg/minecraft-server',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 25565, protocol: 'tcp' }],
        volumes: [{ name: 'data', container_path: '/data' }],
      },
    };
    await api.createGame(payload);
    expect(gsd.games.create).toHaveBeenCalledWith(payload);
  });

  it('should delegate api.updateGame() to window.gsd.games.update() with the exact payload', async () => {
    const payload = {
      name: 'minecraft',
      config: {
        image: 'itzg/minecraft-server',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 25565, protocol: 'tcp' }],
        volumes: [{ name: 'data', container_path: '/data' }],
      },
    };
    await api.updateGame(payload);
    expect(gsd.games.update).toHaveBeenCalledWith(payload);
  });

  it('should delegate api.deleteGame() to window.gsd.games.delete() with the exact payload', async () => {
    const payload = { name: 'minecraft' };
    await api.deleteGame(payload);
    expect(gsd.games.delete).toHaveBeenCalledWith(payload);
  });

  it('should delegate api.discordConfig() to window.gsd.discord.getConfig()', async () => {
    await api.discordConfig();
    expect(gsd.discord.getConfig).toHaveBeenCalledOnce();
  });

  it('should delegate api.discordSaveCredentials() to window.gsd.discord.putConfig() with the body', async () => {
    const body = { botToken: 't', clientId: 'c', publicKey: 'k' };
    await api.discordSaveCredentials(body);
    expect(gsd.discord.putConfig).toHaveBeenCalledWith(body);
  });

  it('should delegate api.discordAddGuild() to window.gsd.discord.addGuild() with the guild id', async () => {
    await api.discordAddGuild('G1');
    expect(gsd.discord.addGuild).toHaveBeenCalledWith('G1');
  });

  it('should delegate api.discordRemoveGuild() to window.gsd.discord.removeGuild() with the guild id', async () => {
    await api.discordRemoveGuild('G1');
    expect(gsd.discord.removeGuild).toHaveBeenCalledWith('G1');
  });

  it('should delegate api.discordRegisterCommands() to window.gsd.discord.registerCommands() with the guild id', async () => {
    await api.discordRegisterCommands('G1');
    expect(gsd.discord.registerCommands).toHaveBeenCalledWith('G1');
  });

  it('should delegate api.discordSaveAdmins() to window.gsd.discord.putAdmins() with the admins', async () => {
    const admins = { userIds: ['u1'], roleIds: ['r1'] };
    await api.discordSaveAdmins(admins);
    expect(gsd.discord.putAdmins).toHaveBeenCalledWith(admins);
  });

  it('should delegate api.discordSavePermission() to window.gsd.discord.putPermission() with the game and permission', async () => {
    const perm = { userIds: ['u1'], roleIds: [], actions: ['start' as const] };
    await api.discordSavePermission('minecraft', perm);
    expect(gsd.discord.putPermission).toHaveBeenCalledWith('minecraft', perm);
  });

  it('should delegate api.discordDeletePermission() to window.gsd.discord.deletePermission() with the game', async () => {
    await api.discordDeletePermission('minecraft');
    expect(gsd.discord.deletePermission).toHaveBeenCalledWith('minecraft');
  });

  it('should delegate api.diagnosticsTail() to window.gsd.diagnostics.tail()', async () => {
    await api.diagnosticsTail();
    expect(gsd.diagnostics.tail).toHaveBeenCalledOnce();
  });

  it('should delegate api.diagnosticsLogPath() to window.gsd.diagnostics.path()', async () => {
    await api.diagnosticsLogPath();
    expect(gsd.diagnostics.path).toHaveBeenCalledOnce();
  });

  it('should resolve api.drift() with the bridge drift.get() result', async () => {
    const report = { entries: [{ game: 'minecraft', kind: 'pending_create' as const }] };
    gsd.drift.get.mockResolvedValueOnce(report);
    await expect(api.drift()).resolves.toEqual(report);
    expect(gsd.drift.get).toHaveBeenCalledOnce();
  });

  it('should return the payload resolved by the bridge', async () => {
    const entries = [
      { name: 'minecraft', declared: false, deployed: true },
      { name: 'palworld', declared: false, deployed: false },
    ];
    gsd.games.list.mockResolvedValueOnce({ games: entries });
    await expect(api.games()).resolves.toEqual({ games: entries });
  });
});

describe('missing IPC bridge', () => {
  it('should throw a descriptive error when window.gsd is unavailable', async () => {
    vi.stubGlobal('gsd', undefined);
    await expect(api.env()).rejects.toThrow('window.gsd IPC bridge is unavailable');
  });

  it('should reject api.drift() with a descriptive error when window.gsd is unavailable', async () => {
    vi.stubGlobal('gsd', undefined);
    await expect(api.drift()).rejects.toThrow('window.gsd IPC bridge is unavailable');
  });
});
