/**
 * DiscordCommandRegistrar — calls Discord's REST API to install our four
 * slash commands into a single guild.
 *
 * Replaces the on-`ready` and on-`guildCreate` registration that the old
 * always-on `DiscordBotService` did. With the bot now serverless, there is no
 * gateway connection to react to those events; instead the operator clicks
 * "Register commands" in the web UI for each allowlisted guild.
 *
 * Uses native `fetch` rather than `discord.js` so we don't reintroduce the
 * dependency we just removed.
 */
import { Injectable } from '@nestjs/common';
import { logger } from '../logger.js';
import { DiscordConfigService } from './DiscordConfigService.js';
import { COMMAND_DESCRIPTORS } from '@hyveon/shared';

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Discord Snowflake IDs (guild IDs, application IDs, etc.) are unsigned 64-bit
 * integers represented as numeric strings of 17–20 digits. Rejecting anything
 * else before it hits the URL template prevents path-traversal / SSRF attempts
 * where a malicious `guildId` like `123/../../../something` would otherwise
 * be interpolated raw into the request URL.
 */
const SNOWFLAKE_REGEX = /^\d{17,20}$/;

function isSnowflake(value: string): boolean {
  return SNOWFLAKE_REGEX.test(value);
}

/**
 * Outcome of a `PUT .../guilds/{id}/commands` call, shaped for direct
 * passthrough to the "Register commands" UI button.
 */
export interface RegisterResult {
  success: boolean;
  message: string;
}

/**
 * Service-facing wrapper around Discord's bulk-overwrite-guild-commands
 * endpoint. Always registers **per guild** (never globally) — the bot should
 * only expose commands to servers in the allowlist, and global commands leak
 * to every guild the bot is invited to.
 */
@Injectable()
export class DiscordCommandRegistrar {
  constructor(private readonly discord: DiscordConfigService) {}

  /**
   * Install (or overwrite) the four game-server slash commands in a single
   * Discord guild. The underlying endpoint is
   * `PUT /applications/\{app_id\}/guilds/\{guild_id\}/commands` with the full
   * command descriptor array as the body — Discord replaces everything for
   * that guild in one call.
   *
   * Returns a `RegisterResult` the controller can surface verbatim:
   *  - Success: `{ success: true, message: 'Registered N commands in guild {id}.' }`
   *  - Missing client ID / token: `success: false` with an actionable message.
   *  - Non-2xx from Discord: status + response body passed through.
   *  - Network/unexpected error: `Request failed: <error>`.
   */
  async registerForGuild(guildId: string): Promise<RegisterResult> {
    logger.debug('DiscordCommandRegistrar.registerForGuild: registering slash commands', { guildId });
    if (!guildId) return { success: false, message: 'guildId is required' };
    // Reject anything that isn't a plain Snowflake ID so it can never
    // manipulate the URL path — e.g. `123/../../../evil`. CodeQL flagged
    // the unvalidated interpolation as an SSRF vector even though the host
    // is fixed to discord.com.
    if (!isSnowflake(guildId)) {
      return { success: false, message: 'guildId must be a numeric Discord Snowflake (17–20 digits).' };
    }

    const cfg = await this.discord.getConfig();
    const clientId = cfg.clientId;
    if (!clientId) {
      return { success: false, message: 'clientId is not configured. Save it in the Credentials tab.' };
    }
    if (!isSnowflake(clientId)) {
      return { success: false, message: 'Stored clientId is malformed — re-save it in the Credentials tab.' };
    }
    const token = await this.discord.getEffectiveToken();
    if (!token) {
      return { success: false, message: 'Bot token is not configured. Save it in the Credentials tab.' };
    }

    // Both values are pure digits at this point (Snowflake-validated), so
    // they can't affect the URL structure. `encodeURIComponent` is belt-and-
    // suspenders so static analyzers see the sanitization.
    const url = `${DISCORD_API}/applications/${encodeURIComponent(clientId)}/guilds/${encodeURIComponent(guildId)}/commands`;
    try {
      const resp = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${token}`,
        },
        body: JSON.stringify(COMMAND_DESCRIPTORS),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        logger.warn('Discord command registration failed', { status: resp.status, body, guildId });
        return { success: false, message: `Discord returned ${resp.status}: ${body || 'no body'}` };
      }
      logger.info('Discord commands registered', { guildId, count: COMMAND_DESCRIPTORS.length });
      return { success: true, message: `Registered ${COMMAND_DESCRIPTORS.length} commands in guild ${guildId}.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Discord command registration threw', { error: message, guildId });
      return { success: false, message: `Request failed: ${message}` };
    }
  }
}
