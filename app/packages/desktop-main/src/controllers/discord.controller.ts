import { BadRequestException, Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  DiscordConfigService,
  type DiscordAction,
} from '../services/DiscordConfigService.js';
import { DiscordCommandRegistrar } from '../services/DiscordCommandRegistrar.js';
import { ConfigService } from '../services/ConfigService.js';
import { requireStringArray } from './validation.js';

/**
 * IPC-only controller for the serverless Discord bot: credentials
 * (Secrets Manager), per-guild allowlist, admins, per-game permissions, and
 * command registration. All state lives in DynamoDB + Secrets Manager; this
 * controller never talks to a gateway connection (there isn't one).
 *
 * Every handler is bound to an IPC channel via `@MessagePattern` / `@Payload`
 * — no HTTP routes are registered here.
 */
@Controller()
export class DiscordController {
  constructor(
    private readonly discord: DiscordConfigService,
    private readonly registrar: DiscordCommandRegistrar,
    private readonly config: ConfigService,
  ) {}

  /**
   * Returns the `DiscordConfig` with secrets redacted to booleans
   * (`botTokenSet` / `publicKeySet`) plus the interactions Lambda Function URL
   * from tfstate — the value the operator copies into Discord's developer
   * portal. The raw bot token and public key are never sent to the client.
   */
  @MessagePattern('discord.getConfig')
  async getConfig() {
    const redacted = await this.discord.getRedacted();
    return { ...redacted, interactionsEndpointUrl: this.config.getTfOutputs()?.interactions_invoke_url ?? null };
  }

  /**
   * Writes the bot token and/or public key to Secrets Manager and the
   * `clientId` to the DynamoDB config row. Requires
   * `secretsmanager:PutSecretValue` on the IAM principal running the app.
   * Any field omitted from the body is left untouched.
   */
  @MessagePattern('discord.putConfig')
  async putConfig(
    @Payload() body: { botToken?: unknown; clientId?: unknown; publicKey?: unknown } = {},
  ) {
    if (body.botToken !== undefined && typeof body.botToken !== 'string') {
      throw new BadRequestException({ success: false, error: 'botToken must be a string' });
    }
    if (body.clientId !== undefined && typeof body.clientId !== 'string') {
      throw new BadRequestException({ success: false, error: 'clientId must be a string' });
    }
    if (body.publicKey !== undefined && typeof body.publicKey !== 'string') {
      throw new BadRequestException({ success: false, error: 'publicKey must be a string' });
    }
    const ok = await this.discord.setCredentials({
      ...(body.botToken !== undefined ? { botToken: body.botToken } : {}),
      ...(body.clientId !== undefined ? { clientId: body.clientId } : {}),
      ...(body.publicKey !== undefined ? { publicKey: body.publicKey } : {}),
    });
    if (!ok) throw new BadRequestException({ success: false, error: 'invalid credentials' });
    const redacted = await this.discord.getRedacted();
    return {
      success: true,
      config: { ...redacted, interactionsEndpointUrl: this.config.getTfOutputs()?.interactions_invoke_url ?? null },
    };
  }

  /**
   * Returns the dynamic allowlisted guild IDs and the Terraform-managed base guild IDs.
   * The UI should render base guilds as locked (non-removable).
   */
  @MessagePattern('discord.listGuilds')
  async listGuilds() {
    const [cfg, base] = await Promise.all([this.discord.getConfig(), this.discord.getBaseConfig()]);
    return { guilds: cfg.allowedGuilds, baseGuilds: base.allowedGuilds };
  }

  /** Adds a guild ID to the dynamic allowlist persisted in DynamoDB. Takes effect on the next interaction (Lambda re-reads per invocation). */
  @MessagePattern('discord.addGuild')
  async addGuild(@Payload() body: { guildId?: unknown } = {}) {
    if (typeof body.guildId !== 'string') {
      throw new BadRequestException({ success: false, error: 'guildId required' });
    }
    const guildId = body.guildId.trim();
    if (!guildId) throw new BadRequestException({ success: false, error: 'guildId required' });
    await this.discord.addAllowedGuild(guildId);
    const [cfg, base] = await Promise.all([this.discord.getConfig(), this.discord.getBaseConfig()]);
    return { success: true, guilds: cfg.allowedGuilds, baseGuilds: base.allowedGuilds };
  }

  /**
   * Removes a guild ID from the dynamic allowlist. Returns 400 if the guild is
   * in the Terraform base config — those entries require a tfvars edit + re-apply.
   * Already-registered slash commands remain in Discord until manually cleaned up.
   */
  @MessagePattern('discord.removeGuild')
  async removeGuild(@Payload() guildIdRaw: string) {
    const guildId = (guildIdRaw ?? '').trim();
    if (!guildId) throw new BadRequestException({ success: false, error: 'guildId required' });
    const result = await this.discord.removeAllowedGuild(guildId);
    if (!result.ok) {
      throw new BadRequestException({ success: false, error: result.reason });
    }
    const [cfg, base] = await Promise.all([this.discord.getConfig(), this.discord.getBaseConfig()]);
    return { success: true, guilds: cfg.allowedGuilds, baseGuilds: base.allowedGuilds };
  }

  /**
   * PUTs the slash-command descriptors to Discord for a single guild. Only
   * per-guild registration is supported by design — global commands would
   * leak to every server the bot is invited to. Operators run this after
   * bumping `COMMAND_DESCRIPTORS` and redeploying the Lambdas.
   */
  @MessagePattern('discord.registerCommands')
  async registerCommands(@Payload() guildIdRaw: string) {
    const guildId = (guildIdRaw ?? '').trim();
    if (!guildId) throw new BadRequestException({ success: false, error: 'guildId required' });
    return this.registrar.registerForGuild(guildId);
  }

  /**
   * Returns the dynamic admin user/role lists and the Terraform-managed base admin lists.
   * The UI should render base admins as locked (non-removable).
   */
  @MessagePattern('discord.getAdmins')
  async getAdmins() {
    const [cfg, base] = await Promise.all([this.discord.getConfig(), this.discord.getBaseConfig()]);
    return { ...cfg.admins, baseAdmins: base.admins };
  }

  /**
   * Replaces the dynamic admin user/role lists atomically. Omitted fields are treated as empty arrays
   * (not "leave alone"). Base admins set via Terraform are unaffected by this endpoint.
   */
  @MessagePattern('discord.putAdmins')
  async putAdmins(@Payload() body: { userIds?: unknown; roleIds?: unknown } = {}) {
    const userIds = requireStringArray('userIds', body.userIds);
    const roleIds = requireStringArray('roleIds', body.roleIds);
    await this.discord.setAdmins({ userIds, roleIds });
    const [cfg, base] = await Promise.all([this.discord.getConfig(), this.discord.getBaseConfig()]);
    return { success: true, admins: cfg.admins, baseAdmins: base.admins };
  }

  /** Returns the per-game permission map (user/role IDs allowed to run specific actions on each game). */
  @MessagePattern('discord.getPermissions')
  async getPermissions() {
    return (await this.discord.getConfig()).gamePermissions;
  }

  /**
   * Sets the allowed users/roles/actions for a single game. `game` must match
   * a key in the Terraform `game_servers` map; unknown keys return 400. The
   * `actions` array is the permission bucket `canRun()` checks against.
   *
   * The IPC payload is a single object `{ game, body }` — `nestjs-electron-ipc-transport`
   * only delivers the first `ipcRenderer.invoke` argument to `@Payload`, so
   * the two parameters are collapsed here and the preload sends
   * `ipcRenderer.invoke('discord.putPermission', { game, body })`.
   */
  @MessagePattern('discord.putPermission')
  async putPermission(
    @Payload() payload: { game: string; body: { userIds?: unknown; roleIds?: unknown; actions?: unknown } } = { game: '', body: {} },
  ) {
    const { game, body = {} } = payload;
    if (!game) {
      throw new BadRequestException({ success: false, error: 'game is required' });
    }
    const userIds = requireStringArray('userIds', body.userIds);
    const roleIds = requireStringArray('roleIds', body.roleIds);
    const actions = requireStringArray('actions', body.actions);
    const written = await this.discord.setGamePermission(game, {
      userIds,
      roleIds,
      actions: actions as DiscordAction[],
    });
    if (!written) {
      throw new BadRequestException({ success: false, error: `invalid game key: ${game}` });
    }
    return { success: true, permissions: (await this.discord.getConfig()).gamePermissions };
  }

  /** Removes the permission entry for a game. Returns 400 if `game` isn't a known key from the Terraform `game_servers` map. */
  @MessagePattern('discord.deletePermission')
  async deletePermission(@Payload() game: string) {
    const deleted = await this.discord.deleteGamePermission(game);
    if (!deleted) {
      throw new BadRequestException({ success: false, error: `invalid game key: ${game}` });
    }
    return { success: true, permissions: (await this.discord.getConfig()).gamePermissions };
  }
}
