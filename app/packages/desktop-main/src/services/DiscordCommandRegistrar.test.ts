/**
 * Tests for DiscordCommandRegistrar — the server's per-guild
 * slash-command REST PUT that replaces the old always-on
 * `DiscordBotService.registerCommandsForGuild()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '../logger.js';
import { DiscordCommandRegistrar } from './DiscordCommandRegistrar.js';
import { DiscordConfigService } from './DiscordConfigService.js';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

// Realistic Snowflake values — Discord IDs are 17–20 digit numeric strings.
const VALID_CLIENT_ID = '123456789012345678';
const VALID_GUILD_ID = '987654321098765432';

function makeDiscord(overrides: Partial<DiscordConfigService> = {}): DiscordConfigService {
  const config = {
    getConfig: vi.fn().mockResolvedValue({
      clientId: VALID_CLIENT_ID,
      allowedGuilds: [VALID_GUILD_ID],
      admins: { userIds: [], roleIds: [] },
      gamePermissions: {},
    }),
    getEffectiveToken: vi.fn().mockResolvedValue('bot-token-xyz'),
    ...overrides,
  } as Partial<DiscordConfigService>;
  return config as DiscordConfigService;
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('DiscordCommandRegistrar.registerForGuild', () => {
  it('should reject an empty guildId early without touching Discord', async () => {
    const registrar = new DiscordCommandRegistrar(makeDiscord());
    const result = await registrar.registerForGuild('');
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should return an actionable error when clientId is not configured', async () => {
    const registrar = new DiscordCommandRegistrar(
      makeDiscord({
        getConfig: vi.fn().mockResolvedValue({
          clientId: '',
          allowedGuilds: [VALID_GUILD_ID],
          admins: { userIds: [], roleIds: [] },
          gamePermissions: {},
        }),
      }),
    );
    const result = await registrar.registerForGuild(VALID_GUILD_ID);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/clientId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should return an actionable error when the bot token is not configured', async () => {
    const registrar = new DiscordCommandRegistrar(
      makeDiscord({ getEffectiveToken: vi.fn().mockResolvedValue(null) }),
    );
    const result = await registrar.registerForGuild(VALID_GUILD_ID);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/token/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should PUT the command descriptors to Discord with a Bot authorization header', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    const registrar = new DiscordCommandRegistrar(makeDiscord());
    const result = await registrar.registerForGuild(VALID_GUILD_ID);
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `https://discord.com/api/v10/applications/${VALID_CLIENT_ID}/guilds/${VALID_GUILD_ID}/commands`,
    );
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe('Bot bot-token-xyz');
    const body = JSON.parse(init.body);
    const names = body.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(['server-list', 'server-start', 'server-status', 'server-stop']);
  });

  it('should surface Discord non-2xx responses verbatim', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => '{"code":10004}' });
    const registrar = new DiscordCommandRegistrar(makeDiscord());
    const result = await registrar.registerForGuild(VALID_GUILD_ID);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/404/);
    expect(result.message).toMatch(/10004/);
  });

  it('should surface thrown errors without crashing the request handler', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const registrar = new DiscordCommandRegistrar(makeDiscord());
    const result = await registrar.registerForGuild(VALID_GUILD_ID);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/network down/);
  });

  it('should log an error with just the error message when the request throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const registrar = new DiscordCommandRegistrar(makeDiscord());
    await registrar.registerForGuild(VALID_GUILD_ID);
    expect(logger.error).toHaveBeenCalledWith(
      'Discord command registration threw',
      { error: 'network down', guildId: VALID_GUILD_ID },
    );
  });

  it('should log a warning when Discord returns a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => '{"code":10004}' });
    const registrar = new DiscordCommandRegistrar(makeDiscord());
    await registrar.registerForGuild(VALID_GUILD_ID);
    expect(logger.warn).toHaveBeenCalledWith('Discord command registration failed', {
      status: 404,
      body: '{"code":10004}',
      guildId: VALID_GUILD_ID,
    });
  });

  it('should reject non-Snowflake guildId values before they can reach the URL', async () => {
    const registrar = new DiscordCommandRegistrar(makeDiscord());
    const attacks = [
      '123/../../../evil',
      'abc',
      '123',                   // too short
      '123456789012345678901', // too long (21 digits)
      '../evil',
      '123%2F456',
    ];
    for (const bad of attacks) {
      const result = await registrar.registerForGuild(bad);
      expect(result.success, `expected ${bad} to be rejected`).toBe(false);
      expect(result.message).toMatch(/Snowflake/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject a malformed stored clientId without making the request', async () => {
    const registrar = new DiscordCommandRegistrar(
      makeDiscord({
        getConfig: vi.fn().mockResolvedValue({
          clientId: 'not-a-snowflake',
          allowedGuilds: [VALID_GUILD_ID],
          admins: { userIds: [], roleIds: [] },
          gamePermissions: {},
        }),
      }),
    );
    const result = await registrar.registerForGuild(VALID_GUILD_ID);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/clientId is malformed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
