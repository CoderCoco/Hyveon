/**
 * Typed shape of the `window.gsd` object exposed by the Electron preload script.
 *
 * Import this interface in the renderer process to get fully-typed access to the
 * IPC bridge without importing anything from `electron` or Node.js.
 *
 * Keep this file in sync with the `contextBridge.exposeInMainWorld('gsd', {...})`
 * call in `src/index.ts` — the two must always agree on method signatures and
 * namespace names.
 */

// ---------------------------------------------------------------------------
// Shared payload shapes (mirrors types from @hyveon/shared and desktop-main)
// ---------------------------------------------------------------------------

/** Current ECS state of a game server. */
export interface GameStatus {
  game: string;
  state: 'running' | 'starting' | 'stopped' | 'not_deployed' | 'error';
  publicIp?: string;
  hostname?: string;
  taskArn?: string;
  message?: string;
}

/** Result of a start or stop operation. */
export interface StartResult {
  success: boolean;
  message: string;
  taskArn?: string;
}

/** Per-game Fargate cost projection. */
export interface GameEstimate {
  vcpu: number;
  memoryGb: number;
  costPerHour: number;
  costPerDay24h: number;
  costPerMonth4hpd: number;
}

/** Cost estimates for all games plus a "if everything were running" total. */
export interface CostEstimates {
  games: Record<string, GameEstimate>;
  totalPerHourIfAllOn: number;
}

/** Historical daily cost entry from Cost Explorer. */
export interface DailyCost {
  date: string;
  cost: number;
}

/** Actual billed costs pulled from AWS Cost Explorer. */
export interface ActualCosts {
  daily: DailyCost[];
  total: number;
  currency: string;
  days: number;
  error?: string;
}

/** Log lines for a game's ECS task. */
export interface GameLogs {
  game: string;
  lines: string[];
}

/** A single chunk of streamed log text delivered over IPC. */
export type LogChunk = string;

/** State of the EFS FileBrowser helper task for a game. */
export interface FileMgrStatus {
  game: string;
  state: 'running' | 'starting' | 'stopped' | 'not_deployed';
  url?: string;
  taskArn?: string;
}

/** Result of a file-manager start or stop operation. */
export interface FileMgrResult {
  success: boolean;
  message: string;
  taskArn?: string;
}

/** Admin user/role ID lists. */
export interface DiscordAdmins {
  userIds: string[];
  roleIds: string[];
}

/** Permission entry for a single game. */
export interface DiscordGamePermission {
  userIds: string[];
  roleIds: string[];
  /** Action names from the `DiscordAction` union ('start' | 'stop' | 'status'). */
  actions: string[];
}

/**
 * Discord config returned to the renderer — secrets are redacted to
 * presence booleans so the raw bot token and public key are never sent
 * over IPC.
 */
export interface RedactedDiscordConfig {
  clientId: string;
  allowedGuilds: string[];
  admins: DiscordAdmins;
  gamePermissions: Record<string, DiscordGamePermission>;
  baseAllowedGuilds: string[];
  baseAdmins: DiscordAdmins;
  botTokenSet: boolean;
  publicKeySet: boolean;
  /** Function URL for the interactions Lambda, copied from Terraform outputs. Null if not yet applied. */
  interactionsEndpointUrl: string | null;
}

/** Result of a guild allowlist mutation. */
export interface GuildListResult {
  success: boolean;
  guilds: string[];
  baseGuilds: string[];
}

/** Result of registering slash commands for a guild. */
export interface RegisterResult {
  success: boolean;
  message: string;
}

/** Result of updating admin lists. */
export interface AdminsResult {
  success: boolean;
  admins: DiscordAdmins;
  baseAdmins: DiscordAdmins;
}

/** Result of setting or deleting a game permission entry. */
export interface PermissionsResult {
  success: boolean;
  permissions: Record<string, DiscordGamePermission>;
}

/** Result of updating Discord credentials (put-config). */
export interface PutConfigResult {
  success: boolean;
  config: RedactedDiscordConfig;
}

/** Environment metadata derived from Terraform outputs. */
export interface EnvInfo {
  region: string;
  domain: string;
  environment: string;
}

/** Watchdog tuning knobs persisted in server_config.json. */
export interface WatchdogConfig {
  watchdog_interval_minutes: number;
  watchdog_idle_checks: number;
  watchdog_min_packets: number;
}

/** Result of a watchdog config update. */
export interface WatchdogConfigResult {
  success: true;
  config: WatchdogConfig;
}

// ---------------------------------------------------------------------------
// Per-namespace sub-interfaces
// ---------------------------------------------------------------------------

/** Game-server lifecycle: list games, query status, start/stop ECS tasks. */
export interface GsdGamesApi {
  /** Lists game keys from Terraform tfstate. */
  list: () => Promise<{ games: string[] }>;
  /** Returns ECS status for every game in parallel. */
  status: () => Promise<GameStatus[]>;
  /** Returns ECS status for a single game. */
  getStatus: (game: string) => Promise<GameStatus>;
  /** Launches the `{game}-server` ECS task. */
  start: (game: string) => Promise<StartResult>;
  /** Stops the running ECS task for `game`. */
  stop: (game: string) => Promise<StartResult>;
}

/** Cost endpoints: forward-looking Fargate estimates and historical CE data. */
export interface GsdCostsApi {
  /** Estimates per-game and total hourly Fargate cost. */
  estimate: () => Promise<CostEstimates>;
  /** Returns actual costs over a trailing window via Cost Explorer. */
  actual: (days?: number) => Promise<ActualCosts>;
}

/** CloudWatch log endpoints: poll recent lines or open a live IPC stream. */
export interface GsdLogsApi {
  /** Returns recent log lines for a game's ECS task. */
  get: (game: string, limit?: number) => Promise<GameLogs>;
  /**
   * Opens a live log stream for `game` as an async iterable of log chunks.
   * Consume it with `for await (const chunk of stream(game, signal))`.
   *
   * Pass an `AbortSignal` to cancel the stream: aborting (or breaking out of
   * the `for await` loop) tells the main process to stop tailing CloudWatch.
   * The iterator completes when the stream ends and throws if it terminated
   * due to an error. Internally this wraps the per-stream chunk/end/cancel IPC
   * channels in an async generator.
   */
  stream: (game: string, signal?: AbortSignal) => AsyncIterable<LogChunk>;
}

/** EFS file-manager task endpoints: list, start, and stop per game. */
export interface GsdFilesApi {
  /** Lists the file-manager task for `game`, returning whether it is running plus connection details. */
  list: (game: string) => Promise<FileMgrStatus>;
  /** Launches an ECS file-manager task for `game`. */
  start: (game: string) => Promise<FileMgrResult>;
  /** Stops the file-manager task for `game`. */
  stop: (game: string) => Promise<FileMgrResult>;
}

/** Discord bot configuration: credentials, guild allowlist, admins, permissions, command registration. */
export interface GsdDiscordApi {
  /** Returns the Discord config with secrets redacted to booleans. */
  getConfig: () => Promise<RedactedDiscordConfig>;
  /** Updates bot token, client ID, and/or public key in Secrets Manager. */
  putConfig: (body: { botToken?: string; clientId?: string; publicKey?: string }) => Promise<PutConfigResult>;
  /** Lists dynamic and Terraform-base allowed guild IDs. */
  listGuilds: () => Promise<{ guilds: string[]; baseGuilds: string[] }>;
  /** Adds a guild ID to the dynamic allowlist in DynamoDB. */
  addGuild: (guildId: string) => Promise<GuildListResult>;
  /** Removes a guild ID from the dynamic allowlist. */
  removeGuild: (guildId: string) => Promise<GuildListResult>;
  /** Registers slash commands for a guild in the Discord developer portal. */
  registerCommands: (guildId: string) => Promise<RegisterResult>;
  /** Returns the dynamic and Terraform-base admin user/role lists. */
  getAdmins: () => Promise<DiscordAdmins & { baseAdmins: DiscordAdmins }>;
  /** Replaces the dynamic admin user/role lists. */
  putAdmins: (body: { userIds?: string[]; roleIds?: string[] }) => Promise<AdminsResult>;
  /** Returns the per-game permission map. */
  getPermissions: () => Promise<Record<string, DiscordGamePermission>>;
  /**
   * Sets allowed users/roles/actions for a single game.
   *
   * **Transport note:** the preload binding collapses the two parameters into a
   * single object — `ipcRenderer.invoke('discord.putPermission', { game, body })`
   * — because `nestjs-electron-ipc-transport` only delivers the first argument to
   * `@Payload`. Callers must go through `window.gsd.discord.putPermission` and
   * must **not** invoke the `discord.putPermission` IPC channel directly with two
   * separate arguments, as the controller would only receive the first one.
   */
  putPermission: (
    game: string,
    body: { userIds?: string[]; roleIds?: string[]; actions?: string[] },
  ) => Promise<PermissionsResult>;
  /** Removes the permission entry for a game. */
  deletePermission: (game: string) => Promise<PermissionsResult>;
}

/** Environment metadata: region, domain, and environment label for UI display. */
export interface GsdEnvApi {
  /** Returns region, domain, and environment label derived from Terraform outputs. */
  get: () => Promise<EnvInfo>;
}

/** Watchdog configuration stored in server_config.json. */
export interface GsdConfigApi {
  /** Returns the current watchdog config (interval, idle-check count, min packets). */
  get: () => Promise<WatchdogConfig>;
  /** Partially updates the watchdog config on disk. */
  update: (body: {
    watchdog_interval_minutes?: number;
    watchdog_idle_checks?: number;
    watchdog_min_packets?: number;
  }) => Promise<WatchdogConfigResult>;
}

/** Local application log diagnostics: tail recent lines or retrieve the log file path. */
export interface GsdDiagnosticsApi {
  /** Returns the last 500 lines from today's local log file. */
  tail: () => Promise<{ lines: string[] }>;
  /** Returns the absolute path of today's local log file. */
  path: () => Promise<{ path: string }>;
}

// ---------------------------------------------------------------------------
// Test-only injection surface
// ---------------------------------------------------------------------------

/**
 * Mock namespace bag: a partial copy of every `GsdApi` namespace so test
 * harnesses can supply only the methods they care about.
 */
export interface GsdMockNamespaces {
  /** Optional games namespace mock. */
  games?: Partial<GsdGamesApi>;
  /** Optional costs namespace mock. */
  costs?: Partial<GsdCostsApi>;
  /** Optional logs namespace mock. */
  logs?: Partial<GsdLogsApi>;
  /** Optional files namespace mock. */
  files?: Partial<GsdFilesApi>;
  /** Optional discord namespace mock. */
  discord?: Partial<GsdDiscordApi>;
  /** Optional env namespace mock. */
  env?: Partial<GsdEnvApi>;
  /** Optional config namespace mock. */
  config?: Partial<GsdConfigApi>;
  /** Optional diagnostics namespace mock. */
  diagnostics?: Partial<GsdDiagnosticsApi>;
}

/**
 * Test-only API surface injected under `window.gsd.__test`.
 *
 * Present only when the renderer runs inside a Vitest/jsdom environment where
 * the test harness has replaced `window.gsd` with a mock object.  Production
 * code must **never** reference this property — guard every access with an
 * `if (window.gsd?.__test)` check or, better, avoid it entirely outside tests.
 */
export interface GsdTestApi {
  /**
   * Partial mock implementations keyed by namespace name.
   *
   * Tests set individual namespace mocks here before rendering the component
   * under test.  The API client reads the real namespace (e.g. `window.gsd.games`)
   * at call time, so simply replacing `window.gsd.games` is sufficient — the
   * `mock` bag is provided as a structured alternative for registries that need
   * to enumerate which namespaces were mocked.
   */
  mock: GsdMockNamespaces;
  /**
   * Clears all mock implementations stored in `mock` and resets any recorded
   * call counts on injected `vi.fn()` spies.
   *
   * Intended for use in `afterEach` hooks to prevent state leaking between
   * test cases.
   */
  clearMocks: () => void;
  /**
   * Alias for {@link clearMocks} — provided for symmetry with Vitest's
   * `vi.resetAllMocks()` naming convention.
   */
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Top-level interface
// ---------------------------------------------------------------------------

/**
 * Typed shape of `window.gsd` as exposed by the Electron preload script.
 *
 * Declare this on `Window` in a renderer-side `.d.ts` file. Mark it optional
 * (`gsd?`) — the bridge is absent in plain browser/web contexts, so runtime
 * guards like `if (!window.gsd)` need it to be possibly-undefined:
 * ```ts
 * import type { GsdApi } from '@hyveon/desktop-preload/gsd-api';
 * declare global {
 *   interface Window { gsd?: GsdApi; }
 * }
 * ```
 */
export interface GsdApi {
  /** Game-server lifecycle: list games, query status, start/stop ECS tasks. */
  games: GsdGamesApi;
  /** Cost endpoints: forward-looking Fargate estimates and historical CE data. */
  costs: GsdCostsApi;
  /** CloudWatch log endpoints (request/response only; SSE stream is separate). */
  logs: GsdLogsApi;
  /** EFS file-manager task endpoints: status, start, and stop per game. */
  files: GsdFilesApi;
  /** Discord bot configuration: credentials, guild allowlist, admins, permissions, command registration. */
  discord: GsdDiscordApi;
  /** Environment metadata: region, domain, and environment label for UI display. */
  env: GsdEnvApi;
  /** Watchdog configuration stored in server_config.json. */
  config: GsdConfigApi;
  /** Local application log diagnostics: tail recent lines or retrieve the log file path. */
  diagnostics: GsdDiagnosticsApi;
  /**
   * Test-only injection surface; `undefined` in production.
   *
   * Present only when the renderer runs inside a Vitest/jsdom environment
   * where the test harness has stubbed `window.gsd` with a mock object that
   * includes this property.  Never reference this in production code paths.
   */
  __test?: GsdTestApi;
}
