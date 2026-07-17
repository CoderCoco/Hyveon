// Typed API wrappers — every call is delegated to the Electron IPC bridge
// (`window.gsd.*`) exposed by the preload script. There are no `fetch` calls and
// no bearer-token plumbing left in this module: the renderer talks to the main
// process over IPC, not HTTP.

/** Live status for a single game, as returned by `GET /api/status` and `/api/status/:game`. */
export interface GameStatus {
  game: string;
  state: 'running' | 'starting' | 'stopped' | 'not_deployed' | 'error';
  publicIp?: string;
  hostname?: string;
  taskArn?: string;
  message?: string;
}

/** Result envelope for mutation endpoints (start/stop), with a user-facing message. */
export interface ActionResult {
  success: boolean;
  message: string;
  taskArn?: string;
}

/** Watchdog tuning knobs persisted in `server_config.json` and read/written via `/api/config`. */
export interface WatchdogConfig {
  watchdog_interval_minutes: number;
  watchdog_idle_checks: number;
  watchdog_min_packets: number;
}

/** Per-game Fargate cost breakdown used by `CostsPage` and `GameCard` to surface hourly/monthly estimates. */
export interface GameEstimate {
  vcpu: number;
  memoryGb: number;
  costPerHour: number;
  costPerDay24h: number;
  costPerMonth4hpd: number;
}

/** Aggregate cost estimates returned by `GET /api/costs/estimate`. */
export interface CostEstimates {
  games: Record<string, GameEstimate>;
  totalPerHourIfAllOn: number;
}

/** Actual daily AWS Cost Explorer spend returned by `GET /api/costs/actual`. */
export interface ActualCosts {
  daily: { date: string; cost: number }[];
  total: number;
  currency: string;
  days: number;
  error?: string;
}

/**
 * Per-game container configuration, keyed by game name in the
 * `game_servers` Terraform variable (`terraform/variables.tf`).
 *
 * Mirrors `GameServer` in `@hyveon/shared/src/tfvars.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface GameServer {
  name: string;
  image: string;
  cpu: number;
  memory: number;
  ports: { container: number; protocol: string }[];
  environment?: { name: string; value: string }[];
  volumes: { name: string; container_path: string }[];
  https?: boolean;
  connect_message?: string;
  file_seeds?: { path: string; content?: string; content_base64?: string; mode?: string }[];
}

/**
 * Response entry for the merged games list (the `games.list` IPC channel).
 * Combines the declared view (`terraform.tfvars`, via {@link GameServer})
 * with the deployed view (`terraform.tfstate`) so callers can tell
 * "declared but not yet applied" apart from "live" games — see issue #92.
 *
 * Mirrors `GameListEntry` in `@hyveon/shared/src/tfvars.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export interface GameListEntry {
  /**
   * Game key. Sourced from the tfvars `game_servers` map key when
   * `declared` is true, otherwise from the tfstate game name.
   */
  name: string;
  /** True when this game has an entry in the tfvars `game_servers` map. */
  declared: boolean;
  /** True when this game has a deployed ECS task definition in tfstate. */
  deployed: boolean;
  /**
   * Full tfvars-parsed configuration for this game. Only present when
   * `declared` is true.
   */
  config?: GameServer;
}

/**
 * A single structural or business-rule validation failure for a proposed
 * `game_servers` entry.
 *
 * Mirrors `GameServerValidationIssue` in
 * `@hyveon/shared/src/gameServerValidator.ts` — that file is the source of
 * truth; keep this copy in sync with it.
 */
export interface GameServerValidationIssue {
  path: string;
  message: string;
}

/**
 * Successful create/update/delete. `game` is the affected entry's
 * post-write config (omitted for a delete); `games` is the full, freshly
 * merged games list so callers can refresh their view without a second
 * round trip.
 *
 * Mirrors `GameWriteSuccess` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface GameWriteSuccess {
  ok: true;
  game?: GameServer;
  games: GameListEntry[];
}

/**
 * The write was rejected because the caller's `expectedVersionId` didn't
 * match the current tfvars file version — someone else edited
 * `terraform.tfvars` since the caller last read it. `currentVersionId` lets
 * the caller re-fetch and retry.
 *
 * Mirrors `GameWriteConflict` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface GameWriteConflict {
  ok: false;
  code: 'conflict';
  expectedVersionId?: string;
  currentVersionId?: string;
  message: string;
}

/**
 * The proposed `game_servers` entry failed {@link GameServerValidationIssue}-shaped
 * structural or business-rule validation.
 *
 * Mirrors `GameWriteValidationFailure` in `@hyveon/shared/src/gamesWrite.ts`
 * — that file is the source of truth; keep this copy in sync with it.
 */
export interface GameWriteValidationFailure {
  ok: false;
  code: 'validation';
  issues: GameServerValidationIssue[];
}

/**
 * The named game does not exist (e.g. update/delete targeting an
 * undeclared game).
 *
 * Mirrors `GameWriteNotFound` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface GameWriteNotFound {
  ok: false;
  code: 'not_found';
  message: string;
}

/**
 * Catch-all failure for errors that aren't a conflict, validation failure,
 * or not-found (e.g. filesystem I/O).
 *
 * Mirrors `GameWriteFailure` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface GameWriteFailure {
  ok: false;
  code: 'error';
  message: string;
}

/**
 * Discriminated union returned by the `games.create` / `games.update` /
 * `games.delete` handlers. Discriminate on `ok` first, then `code` for the
 * failure branches.
 *
 * Mirrors `GameWriteResult` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export type GameWriteResult =
  | GameWriteSuccess
  | GameWriteConflict
  | GameWriteValidationFailure
  | GameWriteNotFound
  | GameWriteFailure;

/**
 * Request payload for `games.create`. `expectedVersionId`, when supplied,
 * is checked against the current tfvars file version and a
 * {@link GameWriteConflict} is returned on mismatch.
 *
 * Mirrors `CreateGamePayload` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface CreateGamePayload {
  name: string;
  config: Omit<GameServer, 'name'>;
  expectedVersionId?: string;
}

/**
 * Request payload for `games.update`. Same shape as {@link CreateGamePayload}
 * — `name` identifies the existing game to overwrite with `config`.
 *
 * Mirrors `UpdateGamePayload` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface UpdateGamePayload {
  name: string;
  config: Omit<GameServer, 'name'>;
  expectedVersionId?: string;
}

/**
 * Request payload for `games.delete`.
 *
 * Mirrors `DeleteGamePayload` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface DeleteGamePayload {
  name: string;
  expectedVersionId?: string;
}

/** Status of the FileBrowser helper task per game, returned by `GET /api/files/:game`. */
export interface FileMgrStatus {
  game: string;
  state: 'running' | 'starting' | 'stopped' | 'not_deployed';
  url?: string;
  taskArn?: string;
}

/** Discord slash-command action a user can be permitted to invoke on a game. */
export type DiscordAction = 'start' | 'stop' | 'status';

/** Users and roles with server-wide admin privileges (all commands on all games). */
export interface DiscordAdmins {
  userIds: string[];
  roleIds: string[];
}

/** Per-game permission entry: which users/roles can run which actions on this game. */
export interface DiscordGamePermission {
  userIds: string[];
  roleIds: string[];
  actions: DiscordAction[];
}

/**
 * Discord config returned by `GET /api/discord/config`. Neither the bot token
 * nor the application public key is ever sent to the client — the `*Set`
 * booleans indicate whether each secret is configured in AWS Secrets Manager.
 *
 * `interactionsEndpointUrl` is the Lambda Function URL the operator pastes
 * into the Discord developer portal as the "Interactions Endpoint URL".
 */
export interface DiscordConfigRedacted {
  clientId: string;
  allowedGuilds: string[];
  admins: DiscordAdmins;
  gamePermissions: Record<string, DiscordGamePermission>;
  /** Guild IDs locked in by Terraform — non-removable via the UI. */
  baseAllowedGuilds: string[];
  /** Admin user/role IDs locked in by Terraform — non-removable via the UI. */
  baseAdmins: DiscordAdmins;
  botTokenSet: boolean;
  publicKeySet: boolean;
  interactionsEndpointUrl: string | null;
}

/** Result of a server-side mutation that may surface a human-readable error to the UI. */
export interface DiscordMutationResult {
  success: boolean;
  message: string;
}

/** Environment context returned by `GET /api/env`. */
export interface EnvInfo {
  region: string;
  domain: string;
  environment: string;
}

/**
 * Returns the `window.gsd` IPC bridge, throwing a descriptive error if it is
 * absent. The bridge is injected by the Electron preload script, so a missing
 * one means the renderer is running outside Electron (e.g. a plain browser).
 */
function gsd() {
  const bridge = window.gsd;
  if (!bridge) {
    throw new Error(
      'window.gsd IPC bridge is unavailable — the renderer must run inside the Electron preload context.',
    );
  }
  return bridge;
}

// The Discord `actions` field is typed as the narrower `DiscordAction[]` in this
// module but as the wider `string[]` in the preload bridge. The runtime values
// are identical, so the single-step narrowings below (never `as unknown as`) are
// safe — `DiscordAction[]` is assignable to `string[]`, which makes the cast legal.
//
// Every method is `async` so the missing-bridge guard in `gsd()` surfaces as a
// rejected promise rather than a synchronous throw: callers that chain
// `.then().catch()` (rather than `await`) still route the failure to `.catch`.

export const api = {
  env: async (): Promise<EnvInfo> => gsd().env.get(),
  games: async (): Promise<{ games: GameListEntry[] }> => gsd().games.list(),
  status: async (): Promise<GameStatus[]> => gsd().games.status(),
  statusGame: async (game: string): Promise<GameStatus> => gsd().games.getStatus(game),
  start: async (game: string): Promise<ActionResult> => gsd().games.start(game),
  stop: async (game: string): Promise<ActionResult> => gsd().games.stop(game),
  config: async (): Promise<WatchdogConfig> => gsd().config.get(),
  saveConfig: async (cfg: WatchdogConfig): Promise<{ success: boolean; config: WatchdogConfig }> =>
    gsd().config.update(cfg),
  costsEstimate: async (): Promise<CostEstimates> => gsd().costs.estimate(),
  costsActual: async (days = 7): Promise<ActualCosts> => gsd().costs.actual(days),
  filesMgrStatus: async (game: string): Promise<FileMgrStatus> => gsd().files.list(game),
  filesMgrStart: async (game: string): Promise<ActionResult> => gsd().files.start(game),
  filesMgrStop: async (game: string): Promise<ActionResult> => gsd().files.stop(game),
  createGame: async (payload: CreateGamePayload): Promise<GameWriteResult> =>
    gsd().games.create(payload) as Promise<GameWriteResult>,
  updateGame: async (payload: UpdateGamePayload): Promise<GameWriteResult> =>
    gsd().games.update(payload) as Promise<GameWriteResult>,
  deleteGame: async (payload: DeleteGamePayload): Promise<GameWriteResult> =>
    gsd().games.delete(payload) as Promise<GameWriteResult>,

  discordConfig: async (): Promise<DiscordConfigRedacted> =>
    gsd().discord.getConfig() as Promise<DiscordConfigRedacted>,
  discordSaveCredentials: async (body: {
    botToken?: string;
    clientId?: string;
    publicKey?: string;
  }): Promise<{ success: boolean; config: DiscordConfigRedacted }> =>
    gsd().discord.putConfig(body) as Promise<{ success: boolean; config: DiscordConfigRedacted }>,
  discordAddGuild: async (guildId: string): Promise<{ success: boolean; guilds: string[] }> =>
    gsd().discord.addGuild(guildId),
  discordRemoveGuild: async (guildId: string): Promise<{ success: boolean; guilds: string[] }> =>
    gsd().discord.removeGuild(guildId),
  discordRegisterCommands: async (guildId: string): Promise<DiscordMutationResult> =>
    gsd().discord.registerCommands(guildId),
  discordSaveAdmins: async (admins: DiscordAdmins): Promise<{ success: boolean; admins: DiscordAdmins }> =>
    gsd().discord.putAdmins(admins),
  discordSavePermission: async (
    game: string,
    perm: DiscordGamePermission,
  ): Promise<{ success: boolean; permissions: Record<string, DiscordGamePermission> }> =>
    gsd().discord.putPermission(game, perm) as Promise<{
      success: boolean;
      permissions: Record<string, DiscordGamePermission>;
    }>,
  discordDeletePermission: async (
    game: string,
  ): Promise<{ success: boolean; permissions: Record<string, DiscordGamePermission> }> =>
    gsd().discord.deletePermission(game) as Promise<{
      success: boolean;
      permissions: Record<string, DiscordGamePermission>;
    }>,

  diagnosticsTail: async (): Promise<{ lines: string[] }> => gsd().diagnostics.tail(),
  diagnosticsLogPath: async (): Promise<{ path: string }> => gsd().diagnostics.path(),
};
