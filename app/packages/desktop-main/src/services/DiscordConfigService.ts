/**
 * Persistence service for the Discord serverless backend.
 *
 * Responsibilities:
 *  - Read/write the DiscordConfig row in DynamoDB (allowedGuilds, admins,
 *    gamePermissions, clientId).
 *  - Read/write the bot token + Ed25519 public key in AWS Secrets Manager.
 *  - Expose a redacted view of all of the above that's safe to return over
 *    `/api/discord/config`.
 *
 * The InteractionsLambda has its own copy of the read paths (via
 * `@hyveon/shared`), so this service only exists to back the management UI's
 * configuration tab.
 */
import { Inject, Injectable } from '@nestjs/common';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { SECRETS_STORE } from '../modules/cloud-provider.tokens.js';
import {
  asStringArray,
  getBaseDiscordConfig,
  getDiscordConfig,
  isSafeGameKey,
  putDiscordConfig,
  type BaseDiscordConfig,
  type DiscordAction,
  type DiscordConfig,
  type RedactedDiscordConfig,
  type SecretsStore,
} from '@hyveon/shared';

/** Slash-command action that can be gated via permissions. */
export type { DiscordAction } from '@hyveon/shared';

function emptyConfig(): DiscordConfig {
  return {
    clientId: '',
    allowedGuilds: [],
    admins: { userIds: [], roleIds: [] },
    gamePermissions: {},
  };
}

/**
 * Management-side interface to the Discord DynamoDB row and the two Secrets
 * Manager secrets. The interactions/followup Lambdas have their own read
 * paths via `@hyveon/shared`; this service backs the web UI's Credentials /
 * Permissions tabs.
 *
 * Security invariant: the raw `botToken` and `publicKey` values are **never**
 * returned from this service. Callers get booleans via `getRedacted()` —
 * `getEffectiveToken()` is the one escape hatch and is only used by the
 * command registrar which needs to authenticate to Discord.
 */
@Injectable()
export class DiscordConfigService {
  private cache: DiscordConfig | null = null;
  /** Promise of an in-flight load — coalesces concurrent reads into one DDB call. */
  private inflight: Promise<DiscordConfig> | null = null;

  private baseCache: BaseDiscordConfig | null = null;
  private baseInflight: Promise<BaseDiscordConfig> | null = null;

  /**
   * `secrets` is typed against the cloud-agnostic `SecretsStore` contract
   * (not a concrete AWS class) so this service depends only on the
   * interface; `@Inject(SECRETS_STORE)` tells Nest which concrete provider
   * (bound by `CloudProviderModule` for whichever cloud is active) to
   * resolve for that parameter, since interfaces don't survive to runtime
   * for Nest's reflection-based DI to key off of.
   */
  constructor(
    private readonly config: ConfigService,
    @Inject(SECRETS_STORE) private readonly secrets: SecretsStore,
  ) {}

  /** Resolve the DDB table name from the deployed stack's outputs; throws if not deployed yet. */
  private async tableName(): Promise<string> {
    const t = (await this.config.getStackOutputs())?.discordTableName;
    if (!t) throw new Error('discordTableName not in the deployed stack outputs — deploy first.');
    return t;
  }

  private async botTokenSecretArn(): Promise<string> {
    const a = (await this.config.getStackOutputs())?.discordBotTokenSecretArn;
    if (!a) throw new Error('discordBotTokenSecretArn not in the deployed stack outputs.');
    return a;
  }

  private async publicKeySecretArn(): Promise<string> {
    const a = (await this.config.getStackOutputs())?.discordPublicKeySecretArn;
    if (!a) throw new Error('discordPublicKeySecretArn not in the deployed stack outputs.');
    return a;
  }

  /** Read the config from DynamoDB; subsequent calls return a cached copy until a write invalidates. */
  private async load(): Promise<DiscordConfig> {
    if (this.cache) return this.cache;
    if (this.inflight) return this.inflight;
    logger.debug('DiscordConfigService.load: reading Discord config from DynamoDB');
    this.inflight = (async () => {
      try {
        const cfg = await getDiscordConfig(await this.tableName());
        this.cache = cfg;
        return cfg;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Failed to load Discord config from DynamoDB', { error: message });
        const empty = emptyConfig();
        this.cache = empty;
        return empty;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /**
   * Read the Pulumi-managed BASE#discord row (populated from
   * `DeploymentConfig.baseAllowedGuilds`/`baseAdmins` on every deploy). Empty
   * base returned when the row is absent (i.e. no base allowlist/admins were
   * configured). Result is cached
   * until `invalidateCache()` is called, same as the dynamic config cache.
   */
  private async loadBase(): Promise<BaseDiscordConfig> {
    if (this.baseCache) return this.baseCache;
    if (this.baseInflight) return this.baseInflight;
    logger.debug('DiscordConfigService.loadBase: reading base Discord config from DynamoDB');
    this.baseInflight = (async () => {
      try {
        const tableName = (await this.config.getStackOutputs())?.discordTableName;
        if (!tableName) return { allowedGuilds: [], admins: { userIds: [], roleIds: [] } };
        const base = await getBaseDiscordConfig(tableName);
        this.baseCache = base;
        return base;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Failed to load base Discord config from DynamoDB', { error: message });
        return { allowedGuilds: [], admins: { userIds: [], roleIds: [] } };
      } finally {
        this.baseInflight = null;
      }
    })();
    return this.baseInflight;
  }

  /**
   * Writes the config to DynamoDB and refreshes the in-memory cache on
   * success. Any failure from `putDiscordConfig` (e.g. a DynamoDB SDK
   * error) is logged and rethrown as a plain `Error` carrying just the
   * message — never the raw SDK error object — since this is called from
   * every write-path public method (`setAllowedGuilds`, `setAdmins`,
   * `setGamePermission`, etc.) with no try/catch of their own.
   */
  private async save(cfg: DiscordConfig): Promise<void> {
    logger.debug('DiscordConfigService.save: writing Discord config to DynamoDB');
    try {
      await putDiscordConfig(await this.tableName(), cfg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to save Discord config to DynamoDB', { error: message });
      throw new Error(message);
    }
    this.cache = cfg;
    logger.info('Discord config saved', {
      allowedGuilds: cfg.allowedGuilds.length,
      games: Object.keys(cfg.gamePermissions).length,
    });
  }

  /** Full (unredacted) dynamic config — only call this server-side. */
  async getConfig(): Promise<DiscordConfig> {
    return this.load();
  }

  /** The Pulumi-managed base allowlist and admins (from `DeploymentConfig.baseAllowedGuilds`/`baseAdmins`) — read-only from the app's perspective. */
  async getBaseConfig(): Promise<BaseDiscordConfig> {
    return this.loadBase();
  }

  /**
   * Bot token from Secrets Manager (used by the slash-command registrar).
   * `null` if unset, or if the stack hasn't been deployed yet — degrading
   * via {@link readSecretSafe} rather than throwing, since
   * `DiscordCommandRegistrar` awaits this with no try/catch.
   */
  async getEffectiveToken(): Promise<string | null> {
    const token = await this.readSecretSafe(() => this.botTokenSecretArn(), 'Discord bot token');
    return token ?? null;
  }

  /**
   * Resolve a secret ARN and read it, without ever throwing.
   *
   * `arnResolver` throws when the stack hasn't been deployed yet (see
   * `botTokenSecretArn`/`publicKeySecretArn`) — that's an expected,
   * recoverable state (`logger.warn`), distinct from a deployed stack whose
   * `secrets.get` call fails for some other reason (`logger.error`). Both
   * degrade to `undefined` rather than escaping to the caller: previously the
   * `arnResolver` throw happened *before* `.catch()` was attached to the
   * `secrets.get(...)` chain, so it escaped `getRedacted()` uncaught,
   * NestJS's RPC layer wrapped it in an Observable, and Electron's IPC bridge
   * failed to clone it across to the renderer ("An object could not be
   * cloned") instead of surfacing a usable error.
   */
  private async readSecretSafe(
    arnResolver: () => Promise<string>,
    label: string,
  ): Promise<string | undefined> {
    logger.debug('DiscordConfigService.readSecretSafe: reading secret from Secrets Manager', { label });
    let arn: string;
    try {
      arn = await arnResolver();
    } catch (err) {
      logger.warn(`${label} secret ARN unavailable — stack not deployed yet`, {
        err: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
    try {
      return await this.secrets.get(arn);
    } catch (err) {
      logger.error(`Failed to read ${label} from Secrets Manager`, {
        err: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /** Redacted view safe to return to the web client. Includes `*Set` flags for both secrets and the Pulumi-managed base lists. */
  async getRedacted(): Promise<RedactedDiscordConfig> {
    const [cfg, base, botToken, publicKey] = await Promise.all([
      this.load(),
      this.loadBase(),
      this.readSecretSafe(() => this.botTokenSecretArn(), 'Discord bot token'),
      this.readSecretSafe(() => this.publicKeySecretArn(), 'Discord public key'),
    ]);
    return {
      clientId: cfg.clientId,
      allowedGuilds: cfg.allowedGuilds,
      admins: cfg.admins,
      gamePermissions: cfg.gamePermissions,
      baseAllowedGuilds: base.allowedGuilds,
      baseAdmins: base.admins,
      botTokenSet: Boolean(botToken),
      publicKeySet: Boolean(publicKey),
    };
  }

  /**
   * Update bot credentials. Any field can be omitted to leave it unchanged.
   * `botToken` and `publicKey` go to Secrets Manager; `clientId` to DynamoDB.
   *
   * @returns `true` on success, `false` if any provided field wasn't a string.
   */
  async setCredentials(params: {
    botToken?: unknown;
    clientId?: unknown;
    publicKey?: unknown;
  }): Promise<boolean> {
    // Only which fields were submitted is logged — values may carry the bot token/public key.
    logger.debug('DiscordConfigService.setCredentials: updating bot credentials', {
      botToken: params.botToken !== undefined,
      clientId: params.clientId !== undefined,
      publicKey: params.publicKey !== undefined,
    });
    if (params.botToken !== undefined && typeof params.botToken !== 'string') return false;
    if (params.clientId !== undefined && typeof params.clientId !== 'string') return false;
    if (params.publicKey !== undefined && typeof params.publicKey !== 'string') return false;
    const cfg = await this.load();
    if (typeof params.clientId === 'string') {
      cfg.clientId = params.clientId;
      await this.save(cfg);
    }
    const writes: Promise<void>[] = [];
    if (typeof params.botToken === 'string' && params.botToken.length > 0) {
      writes.push(this.secrets.put(await this.botTokenSecretArn(), params.botToken));
    }
    if (typeof params.publicKey === 'string' && params.publicKey.length > 0) {
      writes.push(this.secrets.put(await this.publicKeySecretArn(), params.publicKey));
    }
    if (writes.length) {
      try {
        await Promise.all(writes);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Failed to write Discord bot credentials to Secrets Manager', { error: message });
        throw new Error(message);
      }
    }
    return true;
  }

  /** Replace the entire guild allowlist (deduped, empty strings dropped). */
  async setAllowedGuilds(guildIds: string[]): Promise<void> {
    const cfg = await this.load();
    cfg.allowedGuilds = [...new Set(guildIds.filter(Boolean))];
    await this.save(cfg);
  }

  /** Add a guild to the allowlist if not already present; otherwise no-op. */
  async addAllowedGuild(guildId: string): Promise<void> {
    const cfg = await this.load();
    if (!cfg.allowedGuilds.includes(guildId)) {
      cfg.allowedGuilds.push(guildId);
      await this.save(cfg);
    }
  }

  /**
   * Remove a guild from the dynamic allowlist. Returns `{ ok: false }` when the
   * guild is in the base config — those entries can only be removed by editing
   * "Base allowed guild IDs" on the Settings page and re-applying.
   */
  async removeAllowedGuild(guildId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const base = await this.loadBase();
    if (base.allowedGuilds.includes(guildId)) {
      return {
        ok: false,
        reason: `Guild ${guildId} is in the base config and cannot be removed via the UI. Edit "Base allowed guild IDs" on the Settings page and re-apply from the Infrastructure page.`,
      };
    }
    const cfg = await this.load();
    cfg.allowedGuilds = cfg.allowedGuilds.filter((g) => g !== guildId);
    await this.save(cfg);
    return { ok: true };
  }

  /**
   * Replace the server-wide admin user/role lists (deduped, empty strings
   * dropped, non-string entries discarded). Accepts `unknown` shapes defensively
   * so a malformed API body (e.g. `userIds: "..."`) can't crash the handler.
   */
  async setAdmins(admins: { userIds?: unknown; roleIds?: unknown }): Promise<void> {
    const cfg = await this.load();
    cfg.admins = {
      userIds: [...new Set(asStringArray(admins.userIds).filter(Boolean))],
      roleIds: [...new Set(asStringArray(admins.roleIds).filter(Boolean))],
    };
    await this.save(cfg);
  }

  /**
   * Overwrite the permission entry for a single game.
   * Returns `false` if the game key was rejected for prototype-pollution safety.
   */
  async setGamePermission(
    game: string,
    perm: { userIds?: unknown; roleIds?: unknown; actions?: unknown },
  ): Promise<boolean> {
    if (!isSafeGameKey(game)) {
      logger.warn('Rejected setGamePermission with unsafe key', { game });
      return false;
    }
    const cfg = await this.load();
    cfg.gamePermissions[game] = {
      userIds: [...new Set(asStringArray(perm.userIds).filter(Boolean))],
      roleIds: [...new Set(asStringArray(perm.roleIds).filter(Boolean))],
      actions: [
        ...new Set(
          asStringArray(perm.actions).filter(
            (a): a is DiscordAction => a === 'start' || a === 'stop' || a === 'status',
          ),
        ),
      ],
    };
    await this.save(cfg);
    return true;
  }

  /**
   * Remove the permission entry for a game so no non-admin can run commands
   * on it. Returns `false` if the game key was rejected for prototype-pollution
   * safety; the caller should surface that as a 4xx.
   */
  async deleteGamePermission(game: string): Promise<boolean> {
    if (!isSafeGameKey(game)) {
      logger.warn('Rejected deleteGamePermission with unsafe key', { game });
      return false;
    }
    const cfg = await this.load();
    delete cfg.gamePermissions[game];
    await this.save(cfg);
    return true;
  }

  /** Drop the in-memory cache so the next read sees fresh values from DDB. */
  invalidateCache(): void {
    this.cache = null;
    this.baseCache = null;
  }
}

