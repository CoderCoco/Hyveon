import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getStoredApiToken,
  setStoredApiToken,
  setUnauthorizedHandler,
  retryPendingAfterAuth,
  api,
} from './api.service.js';

// jsdom provides localStorage, but we replace it with a controlled stub so
// tests are isolated from each other's stored tokens.
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: () => { store = {}; },
  };
})();

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
  };
}

let gsd: ReturnType<typeof makeGsdMock>;

beforeEach(() => {
  localStorageMock.clear();
  localStorageMock.getItem.mockClear();
  localStorageMock.setItem.mockClear();
  localStorageMock.removeItem.mockClear();
  vi.stubGlobal('localStorage', localStorageMock);
  gsd = makeGsdMock();
  vi.stubGlobal('gsd', gsd);
  setStoredApiToken('');
  setUnauthorizedHandler(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getStoredApiToken / setStoredApiToken', () => {
  it('should return an empty string when no token has been stored', () => {
    expect(getStoredApiToken()).toBe('');
  });

  it('should persist and retrieve a non-empty token', () => {
    setStoredApiToken('my-api-token');
    expect(getStoredApiToken()).toBe('my-api-token');
  });

  it('should remove the stored token when called with an empty string', () => {
    setStoredApiToken('tok');
    setStoredApiToken('');
    expect(getStoredApiToken()).toBe('');
  });

  it('should return empty string when localStorage.getItem throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('unavailable'); },
    });
    expect(getStoredApiToken()).toBe('');
  });

  it('should silently ignore setItem errors (e.g. private browsing quota)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceeded'); },
      removeItem: () => { throw new Error('unavailable'); },
    });
    expect(() => setStoredApiToken('tok')).not.toThrow();
    expect(() => setStoredApiToken('')).not.toThrow();
  });
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

  it('should return the payload resolved by the bridge', async () => {
    gsd.games.list.mockResolvedValueOnce({ games: ['minecraft', 'palworld'] });
    await expect(api.games()).resolves.toEqual({ games: ['minecraft', 'palworld'] });
  });
});

describe('missing IPC bridge', () => {
  it('should throw a descriptive error when window.gsd is unavailable', async () => {
    vi.stubGlobal('gsd', undefined);
    await expect(api.env()).rejects.toThrow('window.gsd IPC bridge is unavailable');
  });
});

describe('inert auth stubs (retained for #162)', () => {
  it('should treat setUnauthorizedHandler as a no-op that never throws', () => {
    expect(() => setUnauthorizedHandler(vi.fn())).not.toThrow();
    expect(() => setUnauthorizedHandler(null)).not.toThrow();
  });

  it('should resolve retryPendingAfterAuth to true since nothing is ever queued', async () => {
    expect(await retryPendingAfterAuth()).toBe(true);
  });
});
