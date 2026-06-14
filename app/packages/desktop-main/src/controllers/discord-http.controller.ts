import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  DiscordConfigService,
  type DiscordAction,
} from '../services/DiscordConfigService.js';
import { DiscordCommandRegistrar } from '../services/DiscordCommandRegistrar.js';
import { ConfigService } from '../services/ConfigService.js';

/**
 * Verify a body field is either missing or an array of strings. Returns the
 * validated array (empty if the field was omitted), or throws
 * `BadRequestException` which Nest maps to a 400 with the same shape the
 * legacy Express handlers used.
 */
function requireStringArray(field: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new BadRequestException({
      success: false,
      error: `${field} must be an array of strings`,
    });
  }
  return value as string[];
}

/**
 * HTTP shim that exposes the Discord operations as plain REST endpoints under
 * `/api/discord/*`. The browser client (`api.service.ts`) and the
 * integration-test server both consume these routes over HTTP; the Electron
 * main-process host uses the IPC {@link DiscordController} (`@MessagePattern`)
 * handlers instead.
 *
 * Both controllers delegate to the same {@link DiscordConfigService},
 * {@link DiscordCommandRegistrar}, and {@link ConfigService} providers — the
 * heavy lifting lives in those services, not in the thin orchestration
 * duplicated here. Secrets are never returned: `getRedacted()` yields
 * `botTokenSet` / `publicKeySet` booleans instead of the raw values.
 */
@Controller('discord')
export class DiscordHttpController {
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
  @Get('config')
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
  @Put('config')
  async putConfig(
    @Body() body: { botToken?: unknown; clientId?: unknown; publicKey?: unknown } = {},
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
  @Get('guilds')
  async listGuilds() {
    const [cfg, base] = await Promise.all([this.discord.getConfig(), this.discord.getBaseConfig()]);
    return { guilds: cfg.allowedGuilds, baseGuilds: base.allowedGuilds };
  }

  /** Adds a guild ID to the dynamic allowlist persisted in DynamoDB. Takes effect on the next interaction (Lambda re-reads per invocation). */
  @Post('guilds')
  async addGuild(@Body() body: { guildId?: unknown } = {}) {
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
  @Delete('guilds/:guildId')
  async removeGuild(@Param('guildId') guildIdRaw: string) {
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
  @Post('guilds/:guildId/register-commands')
  async registerCommands(@Param('guildId') guildIdRaw: string) {
    const guildId = (guildIdRaw ?? '').trim();
    if (!guildId) throw new BadRequestException({ success: false, error: 'guildId required' });
    return this.registrar.registerForGuild(guildId);
  }

  /**
   * Returns the dynamic admin user/role lists and the Terraform-managed base admin lists.
   * The UI should render base admins as locked (non-removable).
   */
  @Get('admins')
  async getAdmins() {
    const [cfg, base] = await Promise.all([this.discord.getConfig(), this.discord.getBaseConfig()]);
    return { ...cfg.admins, baseAdmins: base.admins };
  }

  /**
   * Replaces the dynamic admin user/role lists atomically. Omitted fields are treated as empty arrays
   * (not "leave alone"). Base admins set via Terraform are unaffected by this endpoint.
   */
  @Put('admins')
  async putAdmins(@Body() body: { userIds?: unknown; roleIds?: unknown } = {}) {
    const userIds = requireStringArray('userIds', body.userIds);
    const roleIds = requireStringArray('roleIds', body.roleIds);
    await this.discord.setAdmins({ userIds, roleIds });
    const [cfg, base] = await Promise.all([this.discord.getConfig(), this.discord.getBaseConfig()]);
    return { success: true, admins: cfg.admins, baseAdmins: base.admins };
  }

  /** Returns the per-game permission map (user/role IDs allowed to run specific actions on each game). */
  @Get('permissions')
  async getPermissions() {
    return (await this.discord.getConfig()).gamePermissions;
  }

  /**
   * Sets the allowed users/roles/actions for a single game. `game` must match
   * a key in the Terraform `game_servers` map; unknown keys return 400. The
   * `actions` array is the permission bucket `canRun()` checks against.
   */
  @Put('permissions/:game')
  async putPermission(
    @Param('game') game: string,
    @Body() body: { userIds?: unknown; roleIds?: unknown; actions?: unknown } = {},
  ) {
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
  @Delete('permissions/:game')
  async deletePermission(@Param('game') game: string) {
    const deleted = await this.discord.deleteGamePermission(game);
    if (!deleted) {
      throw new BadRequestException({ success: false, error: `invalid game key: ${game}` });
    }
    return { success: true, permissions: (await this.discord.getConfig()).gamePermissions };
  }
}
