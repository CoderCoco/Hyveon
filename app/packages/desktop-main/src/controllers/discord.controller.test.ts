import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { DiscordController } from './discord.controller.js';
import type { DiscordConfigService, DiscordAction } from '../services/DiscordConfigService.js';
import type { DiscordCommandRegistrar } from '../services/DiscordCommandRegistrar.js';
import type { ConfigService, TfOutputs } from '../services/ConfigService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Canned redacted config returned by getRedacted() stubs. */
const REDACTED = {
  clientId: 'app-123',
  allowedGuilds: ['G1'],
  admins: { userIds: ['U1'], roleIds: [] },
  gamePermissions: {},
  baseAllowedGuilds: [],
  baseAdmins: { userIds: [], roleIds: [] },
  botTokenSet: true,
  publicKeySet: true,
};

/** Canned dynamic config returned by getConfig() stubs. */
const DYNAMIC_CONFIG = {
  clientId: 'app-123',
  allowedGuilds: ['G1'],
  admins: { userIds: ['U1'], roleIds: [] },
  gamePermissions: {} as Record<string, { userIds: string[]; roleIds: string[]; actions: DiscordAction[] }>,
};

/** Canned base config returned by getBaseConfig() stubs. */
const BASE_CONFIG = {
  allowedGuilds: [] as string[],
  admins: { userIds: [] as string[], roleIds: [] as string[] },
};

/** Build a DiscordConfigService stub with all methods wired to succeed. */
function makeDiscord(): DiscordConfigService {
  return {
    getRedacted: vi.fn().mockResolvedValue(REDACTED),
    getConfig: vi.fn().mockResolvedValue(DYNAMIC_CONFIG),
    getBaseConfig: vi.fn().mockResolvedValue(BASE_CONFIG),
    setCredentials: vi.fn().mockResolvedValue(true),
    addAllowedGuild: vi.fn().mockResolvedValue(undefined),
    removeAllowedGuild: vi.fn().mockResolvedValue({ ok: true }),
    setAdmins: vi.fn().mockResolvedValue(undefined),
    setGamePermission: vi.fn().mockResolvedValue(true),
    deleteGamePermission: vi.fn().mockResolvedValue(true),
  } as unknown as DiscordConfigService;
}

/** Build a DiscordCommandRegistrar stub. */
function makeRegistrar(): DiscordCommandRegistrar {
  return {
    registerForGuild: vi.fn().mockResolvedValue({ success: true, message: '4 commands registered' }),
  } as unknown as DiscordCommandRegistrar;
}

/**
 * Build a ConfigService stub. Pass null to simulate absent Terraform outputs
 * (i.e. Terraform has not been applied yet).
 */
function makeConfig(invokeUrl: string | null = 'https://xyz.lambda-url.us-east-1.on.aws/'): ConfigService {
  return {
    getTfOutputs: vi.fn().mockReturnValue(
      invokeUrl !== null ? ({ interactions_invoke_url: invokeUrl } as Partial<TfOutputs>) : null,
    ),
  } as unknown as ConfigService;
}

function ctrl(
  discord: DiscordConfigService = makeDiscord(),
  registrar: DiscordCommandRegistrar = makeRegistrar(),
  config: ConfigService = makeConfig(),
) {
  return new DiscordController(discord, registrar, config);
}

/**
 * The metadata key NestJS stores on each method decorated with
 * `@MessagePattern`. Asserting this value is the only automated guard
 * that prevents a typo in the controller from silently breaking IPC —
 * calling the method directly (as every other test does) would succeed
 * regardless of what string is registered with the transport.
 */
const PATTERN_METADATA_KEY = 'microservices:pattern';

describe('DiscordController', () => {
  describe('@MessagePattern channel names', () => {
    it('should register getConfig on the "discord.getConfig" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, DiscordController.prototype.getConfig);
      expect(pattern).toEqual(['discord.getConfig']);
    });

    it('should register putConfig on the "discord.putConfig" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, DiscordController.prototype.putConfig);
      expect(pattern).toEqual(['discord.putConfig']);
    });

    it('should register listGuilds on the "discord.listGuilds" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, DiscordController.prototype.listGuilds);
      expect(pattern).toEqual(['discord.listGuilds']);
    });

    it('should register addGuild on the "discord.addGuild" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, DiscordController.prototype.addGuild);
      expect(pattern).toEqual(['discord.addGuild']);
    });

    it('should register removeGuild on the "discord.removeGuild" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, DiscordController.prototype.removeGuild);
      expect(pattern).toEqual(['discord.removeGuild']);
    });

    it('should register registerCommands on the "discord.registerCommands" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, DiscordController.prototype.registerCommands);
      expect(pattern).toEqual(['discord.registerCommands']);
    });

    it('should register getAdmins on the "discord.getAdmins" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, DiscordController.prototype.getAdmins);
      expect(pattern).toEqual(['discord.getAdmins']);
    });

    it('should register putAdmins on the "discord.putAdmins" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, DiscordController.prototype.putAdmins);
      expect(pattern).toEqual(['discord.putAdmins']);
    });

    it('should register getPermissions on the "discord.getPermissions" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, DiscordController.prototype.getPermissions);
      expect(pattern).toEqual(['discord.getPermissions']);
    });

    it('should register putPermission on the "discord.putPermission" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, DiscordController.prototype.putPermission);
      expect(pattern).toEqual(['discord.putPermission']);
    });

    it('should register deletePermission on the "discord.deletePermission" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, DiscordController.prototype.deletePermission);
      expect(pattern).toEqual(['discord.deletePermission']);
    });
  });

  describe('getConfig', () => {
    it('should return the redacted config merged with the interactions endpoint URL', async () => {
      const result = await ctrl().getConfig();
      expect(result.clientId).toBe('app-123');
      expect(result.interactionsEndpointUrl).toBe('https://xyz.lambda-url.us-east-1.on.aws/');
    });

    it('should never expose the raw bot token or public key', async () => {
      const result = await ctrl().getConfig();
      expect(result).not.toHaveProperty('botToken');
      expect(result).not.toHaveProperty('publicKey');
      expect(result.botTokenSet).toBe(true);
      expect(result.publicKeySet).toBe(true);
    });

    it('should return null interactionsEndpointUrl when Terraform outputs are absent', async () => {
      const result = await ctrl(makeDiscord(), makeRegistrar(), makeConfig(null)).getConfig();
      expect(result.interactionsEndpointUrl).toBeNull();
    });
  });

  describe('putConfig', () => {
    it('should throw BadRequestException when botToken is not a string', async () => {
      await expect(ctrl().putConfig({ botToken: 42 as unknown as string })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should throw BadRequestException when clientId is not a string', async () => {
      await expect(ctrl().putConfig({ clientId: [] as unknown as string })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should throw BadRequestException when publicKey is not a string', async () => {
      await expect(ctrl().putConfig({ publicKey: true as unknown as string })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should throw BadRequestException when setCredentials returns false (invalid credentials)', async () => {
      const discord = makeDiscord();
      vi.mocked(discord.setCredentials).mockResolvedValue(false);
      await expect(ctrl(discord).putConfig({ botToken: 'bad' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should accept a body with no fields and delegate to setCredentials', async () => {
      const discord = makeDiscord();
      const result = await ctrl(discord).putConfig({});
      expect(discord.setCredentials).toHaveBeenCalledWith({});
      expect(result.success).toBe(true);
      expect(result.config).toBeDefined();
      expect(result.config.interactionsEndpointUrl).toBeDefined();
    });

    it('should return success with updated config when credentials are valid', async () => {
      const result = await ctrl().putConfig({ botToken: 'tok', clientId: 'cid', publicKey: 'pkey' });
      expect(result.success).toBe(true);
      expect(result.config).toBeDefined();
      expect(result.config.interactionsEndpointUrl).toBeDefined();
    });

    it('should never echo the submitted secrets back in the response', async () => {
      const result = await ctrl().putConfig({ botToken: 'tok', publicKey: 'pkey' });
      expect(result.config).not.toHaveProperty('botToken');
      expect(result.config).not.toHaveProperty('publicKey');
    });
  });

  describe('listGuilds', () => {
    it('should return the dynamic guild list and the base guild list', async () => {
      const result = await ctrl().listGuilds();
      expect(result.guilds).toEqual(['G1']);
      expect(result.baseGuilds).toEqual([]);
    });
  });

  describe('addGuild', () => {
    it('should throw BadRequestException when guildId is missing from the body', async () => {
      await expect(ctrl().addGuild({})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should throw BadRequestException when guildId is not a string', async () => {
      await expect(ctrl().addGuild({ guildId: 99 as unknown as string })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should throw BadRequestException when guildId trims to an empty string', async () => {
      await expect(ctrl().addGuild({ guildId: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should call addAllowedGuild with the trimmed guild ID', async () => {
      const discord = makeDiscord();
      await ctrl(discord).addGuild({ guildId: '  G2  ' });
      expect(discord.addAllowedGuild).toHaveBeenCalledWith('G2');
    });

    it('should return success with the updated guild lists', async () => {
      const result = await ctrl().addGuild({ guildId: 'G2' });
      expect(result.success).toBe(true);
    });
  });

  describe('removeGuild', () => {
    it('should throw BadRequestException when the guildId path param is empty after trim', async () => {
      await expect(ctrl().removeGuild('')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should throw BadRequestException when removeAllowedGuild returns a failure reason', async () => {
      const discord = makeDiscord();
      vi.mocked(discord.removeAllowedGuild).mockResolvedValue({
        ok: false,
        reason: 'Guild is in the Terraform base config',
      });
      await expect(ctrl(discord).removeGuild('G-base')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should return success with updated guild lists on a valid removal', async () => {
      const result = await ctrl().removeGuild('G1');
      expect(result.success).toBe(true);
    });
  });

  describe('registerCommands', () => {
    it('should throw BadRequestException when guildId is empty', async () => {
      await expect(ctrl().registerCommands('')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should delegate to DiscordCommandRegistrar.registerForGuild', async () => {
      const registrar = makeRegistrar();
      await ctrl(makeDiscord(), registrar).registerCommands('G1');
      expect(registrar.registerForGuild).toHaveBeenCalledWith('G1');
    });

    it('should return the result from DiscordCommandRegistrar', async () => {
      const result = await ctrl().registerCommands('G1');
      expect(result).toMatchObject({ success: true });
    });
  });

  describe('getAdmins', () => {
    it('should return both the dynamic admin lists and the base admin lists', async () => {
      const result = await ctrl().getAdmins();
      expect(result).toMatchObject({ userIds: ['U1'], roleIds: [] });
      expect(result.baseAdmins).toEqual({ userIds: [], roleIds: [] });
    });
  });

  describe('putAdmins', () => {
    it('should throw BadRequestException when userIds is not an array of strings', async () => {
      await expect(ctrl().putAdmins({ userIds: 'not-array' as unknown as string[] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should throw BadRequestException when roleIds contains a non-string element', async () => {
      await expect(ctrl().putAdmins({ roleIds: [42] as unknown as string[] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should treat omitted fields as empty arrays', async () => {
      const discord = makeDiscord();
      await ctrl(discord).putAdmins({});
      expect(discord.setAdmins).toHaveBeenCalledWith({ userIds: [], roleIds: [] });
    });

    it('should call setAdmins and return success with the updated admin lists', async () => {
      const discord = makeDiscord();
      const result = await ctrl(discord).putAdmins({ userIds: ['U2'], roleIds: ['R1'] });
      expect(discord.setAdmins).toHaveBeenCalledWith({ userIds: ['U2'], roleIds: ['R1'] });
      expect(result.success).toBe(true);
    });
  });

  describe('getPermissions', () => {
    it('should return the gamePermissions map from the live config', async () => {
      const result = await ctrl().getPermissions();
      expect(result).toEqual({});
    });
  });

  describe('putPermission', () => {
    it('should throw BadRequestException when actions is not an array', async () => {
      await expect(
        ctrl().putPermission({ game: 'minecraft', body: { actions: 'start' as unknown as string[] } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should throw BadRequestException when setGamePermission returns false (unknown game)', async () => {
      const discord = makeDiscord();
      vi.mocked(discord.setGamePermission).mockResolvedValue(false);
      await expect(ctrl(discord).putPermission({ game: 'unknown-game', body: {} })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should call setGamePermission with parsed user/role/action lists', async () => {
      const discord = makeDiscord();
      await ctrl(discord).putPermission({
        game: 'minecraft',
        body: { userIds: ['U1'], roleIds: ['R1'], actions: ['start', 'stop'] },
      });
      expect(discord.setGamePermission).toHaveBeenCalledWith('minecraft', {
        userIds: ['U1'],
        roleIds: ['R1'],
        actions: ['start', 'stop'],
      });
    });

    it('should return success with the updated permissions map', async () => {
      const result = await ctrl().putPermission({ game: 'minecraft', body: { userIds: ['U1'], actions: ['start'] } });
      expect(result.success).toBe(true);
      expect(result.permissions).toBeDefined();
    });
  });

  describe('deletePermission', () => {
    it('should throw BadRequestException when deleteGamePermission returns false (unknown game)', async () => {
      const discord = makeDiscord();
      vi.mocked(discord.deleteGamePermission).mockResolvedValue(false);
      await expect(ctrl(discord).deletePermission('unknown-game')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should return success with the updated permissions map after deletion', async () => {
      const result = await ctrl().deletePermission('minecraft');
      expect(result.success).toBe(true);
      expect(result.permissions).toBeDefined();
    });
  });
});
