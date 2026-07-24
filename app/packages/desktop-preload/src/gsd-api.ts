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

/**
 * Single TCP/UDP port a game server container listens on.
 *
 * Mirrors `GameServerPort` in `@hyveon/shared/src/tfvars.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export interface GameServerPort {
  container: number;
  protocol: string;
}

/**
 * Environment variable injected into the game server container.
 *
 * Mirrors `GameServerEnvironmentVariable` in `@hyveon/shared/src/tfvars.ts`
 * — that file is the source of truth; keep this copy in sync with it.
 */
export interface GameServerEnvironmentVariable {
  name: string;
  value: string;
}

/**
 * EFS-backed volume mount for a game server container.
 *
 * Mirrors `GameServerVolume` in `@hyveon/shared/src/tfvars.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface GameServerVolume {
  name: string;
  container_path: string;
}

/**
 * File seeded into the container filesystem at task start (e.g. server
 * config or mod files). Exactly one of `content` / `content_base64` is
 * normally supplied.
 *
 * Mirrors `GameServerFileSeed` in `@hyveon/shared/src/tfvars.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface GameServerFileSeed {
  path: string;
  content?: string;
  content_base64?: string;
  mode?: string;
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
  ports: GameServerPort[];
  environment?: GameServerEnvironmentVariable[];
  volumes: GameServerVolume[];
  https?: boolean;
  connect_message?: string;
  file_seeds?: GameServerFileSeed[];
}

/**
 * Response entry for the merged games list (the `games.list` IPC channel).
 * Combines the declared view (`terraform.tfvars`, via {@link GameServer})
 * with the deployed view (`terraform.tfstate`) so callers can tell
 * "declared but not yet applied" apart from "live" games.
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

/**
 * Category of mismatch between a game's declared (tfvars) and deployed
 * (tfstate) state.
 *
 * Mirrors `DriftKind` in `@hyveon/shared/src/drift.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export type DriftKind = 'pending_create' | 'pending_delete' | 'config_drift';

/**
 * Name of a top-level game server config field that can differ between the
 * declared (tfvars) and deployed (tfstate) configuration for a
 * `'config_drift'` finding.
 *
 * Mirrors `DriftChangedField` in `@hyveon/shared/src/drift.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export type DriftChangedField = 'ports' | 'image' | 'cpu' | 'memory' | 'volumes';

/**
 * A single per-game drift finding, produced by comparing a game's declared
 * tfvars configuration against its live tfstate configuration.
 *
 * Mirrors `DriftEntry` in `@hyveon/shared/src/drift.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface DriftEntry {
  game: string;
  kind: DriftKind;
  changedFields?: DriftChangedField[];
}

/**
 * Aggregate drift report returned by the `drift.get` IPC channel. Lists
 * every game that is out of sync between its declared and deployed
 * configuration; games that are in sync are omitted entirely.
 *
 * Mirrors `DriftReport` in `@hyveon/shared/src/drift.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface DriftReport {
  entries: DriftEntry[];
}

/**
 * The kind of mutation an {@link AuditEntry} records, plus `plan` for a
 * dry-run `terraform plan` invocation that touched no infrastructure.
 *
 * Mirrors `AuditAction` in `@hyveon/shared/src/audit.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export type AuditAction = 'add' | 'edit' | 'remove' | 'plan';

/**
 * A single row in the DynamoDB audit log, recording who changed a game
 * server's configuration, what changed, and the resulting `terraform.tfvars`
 * S3 version.
 *
 * Mirrors `AuditEntry` in `@hyveon/shared/src/audit.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface AuditEntry {
  /** Sort key: `<ISO timestamp>#<ULID>`. */
  sk: string;
  /** ISO-8601 timestamp of the mutation. */
  timestamp: string;
  /** Identifier of the user or system that performed the mutation. */
  actor: string;
  /** The kind of mutation performed. */
  action: AuditAction;
  /** The `game_servers` map key the mutation applied to. */
  game: string;
  /** The game's configuration before the mutation, or `null` for `add`. */
  before: GameServer | null;
  /** The game's configuration after the mutation, or `null` for `remove`. */
  after: GameServer | null;
  /** S3 object version id of `terraform.tfvars` produced by the write, if known. */
  versionId?: string;
}

/**
 * A page of audit entries, newest-first, plus an optional cursor for
 * fetching the next page. Returned by the `audit.list` IPC channel.
 *
 * Mirrors `AuditPageResult` in `@hyveon/shared/src/audit.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export interface AuditPageResult {
  /** The page of entries, newest-first. */
  entries: AuditEntry[];
  /** Cursor (an {@link AuditEntry.sk} value) to pass as `before` to fetch the next, older page. Absent on the last page. */
  nextBefore?: string;
}

/**
 * A single line of output from a streamed `terraform` subcommand run, tagged
 * with the stream it came from.
 *
 * Mirrors `TerraformRunChunk` in `@hyveon/desktop-main/src/services/TerraformService.ts`
 * — that file is the source of truth; keep this copy in sync with it.
 */
export interface TerraformRunChunk {
  stream: 'stdout' | 'stderr';
  line: string;
}

/**
 * Backend configuration values passed to `terraform init -backend-config=...`
 * for the S3 remote state backend bootstrapped by the First-Run Wizard.
 *
 * Mirrors `TerraformInitConfig` in `@hyveon/desktop-main/src/services/TerraformService.ts`
 * — that file is the source of truth; keep this copy in sync with it.
 */
export interface TerraformInitConfig {
  bucket: string;
  region: string;
  dynamodbTable: string;
}

/**
 * Which `terraform` subcommand produced a {@link TerraformRunRecord}.
 *
 * Mirrors the `kind` field of `TerraformRunRecord` in
 * `@hyveon/desktop-main/src/services/TerraformService.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export type TerraformRunKind = 'plan' | 'apply' | 'destroy';

/**
 * Persisted local run record for a finished `terraform` plan/apply/destroy
 * run — a lightweight run history entry written once the run's spawned
 * process has closed.
 *
 * Mirrors `TerraformRunRecord` in
 * `@hyveon/desktop-main/src/services/TerraformService.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface TerraformRunRecord {
  /** The `runId` this record describes — matches the directory it's written into. */
  runId: string;
  /** Which subcommand produced this record. */
  kind: TerraformRunKind;
  /** ISO-8601 timestamp captured immediately before the process was spawned. */
  startedAt: string;
  /** ISO-8601 timestamp captured immediately after the process closed. */
  completedAt: string;
  /** The process's exit code, or `null` if it never reported one (e.g. killed via abort signal). */
  exitCode: number | null;
  /** The tfvars version id the applied plan was generated against, if the caller supplied one. */
  tfvarsVersionId?: string;
  /**
   * SHA-256 hex digest of the persisted `.tfplan` artifact this record's
   * `plan` run produced. Set only on a successful `plan` record; a failed
   * or aborted `plan` run (and `apply`/`destroy` records generally) leave
   * this unset. The `/terraform` page passes this straight through to
   * `gsd.terraform.apply`'s `planHash` payload field.
   */
  planHash?: string;
  /** The `runId` of the `apply` run this plan rolled back, if started via the rollback flow. */
  rolledBackFrom?: string;
}

/**
 * Lifecycle status surfaced by the run-detail view — a superset of the
 * persisted `success` / `failed` / `aborted` run status with two additional,
 * non-persisted values computed at read time: `running` (no
 * {@link TerraformRunRecord} exists yet because the run hasn't finished) and
 * `awaiting_approval` (a `plan` run finished successfully but its `.tfplan`
 * artifact still exists on disk, awaiting an operator's explicit apply).
 *
 * Mirrors `RunDetailStatus` in `@hyveon/shared/src/runs.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export type RunDetailStatus = 'success' | 'failed' | 'aborted' | 'running' | 'awaiting_approval';

/**
 * Result of the `terraform.runs.get` IPC channel: `found: false` when the
 * requested `runId` is neither the currently in-flight run nor a persisted
 * {@link TerraformRunRecord} on disk. `found: true` always carries the
 * derived {@link RunDetailStatus}; `record` is present only once the run has
 * produced a persisted {@link TerraformRunRecord} (i.e. every status except
 * `running`, since a run in flight hasn't closed its process yet).
 *
 * Mirrors `TerraformRunsGetResult` in
 * `@hyveon/desktop-main/src/controllers/terraform-runs.controller.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export type TerraformRunsGetResult =
  | { found: false }
  | { found: true; status: RunDetailStatus; record?: TerraformRunRecord };

/**
 * Lifecycle status of a {@link RunHistoryRecord}.
 *
 * Mirrors `RunStatus` in `@hyveon/shared/src/runs.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export type RunHistoryStatus = 'success' | 'failed' | 'aborted';

/**
 * A single row in the DynamoDB-persisted run-history table — the shape
 * `terraform.runs.list` returns pages of. Distinct from the local-disk
 * {@link TerraformRunRecord} that `terraform.runs.get`/`streamLogs` operate
 * on: this record additionally carries `sk`, `status`, `approvedBy`/
 * `approvedAt`, and the offloaded-log fields.
 *
 * Mirrors `RunRecord` in `@hyveon/shared/src/runs.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface RunHistoryRecord {
  /** Sort key: `<startedAt>#<runId>`. */
  sk: string;
  /** Unique identifier for the run. */
  runId: string;
  /** Which `terraform` subcommand produced this record. */
  kind: TerraformRunKind;
  /** Lifecycle status. */
  status: RunHistoryStatus;
  /** ISO-8601 timestamp captured immediately before the process was spawned. */
  startedAt: string;
  /** ISO-8601 timestamp captured immediately after the process closed. */
  completedAt: string;
  /** The process's exit code, or `null` if it never reported one. */
  exitCode: number | null;
  /** The tfvars version id the run was executed against, if the caller supplied one. */
  tfvarsVersionId?: string;
  /** Hash of the plan artifact this record's run produced or was gated against. */
  planHash?: string;
  /** Opaque identifier of the admin who approved this plan run for apply. Set only on approved `plan` records. */
  approvedBy?: string;
  /** ISO-8601 timestamp the run was approved at. */
  approvedAt?: string;
  /** The run's captured log text, embedded directly on the record when small enough. Mutually exclusive with `logS3Key`. */
  logInline?: string;
  /** Key identifying where the run's captured log was offloaded to, once too large to embed. Mutually exclusive with `logInline`. */
  logS3Key?: string;
  /** The `runId` of the `apply` run this plan rolled back, if started via the rollback flow (#112). */
  rolledBackFrom?: string;
}

/**
 * A page of {@link RunHistoryRecord}s, newest-first, plus an optional cursor
 * for fetching the next page. Returned by the `terraform.runs.list` IPC
 * channel.
 *
 * Mirrors `RunPageResult` in `@hyveon/shared/src/runs.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface RunHistoryPageResult {
  /** The page of records, newest-first. */
  records: RunHistoryRecord[];
  /** Cursor (a {@link RunHistoryRecord.sk} value) to pass as `before` to fetch the next, older page. Absent on the last page. */
  nextBefore?: string;
}

/** Options accepted by the `terraform.runs.list` IPC channel. */
export interface TerraformRunsListOpts {
  /** Requested page size; the main process clamps to `[1, 100]` and defaults to `25` when omitted or invalid. */
  limit?: number;
  /** Cursor (a {@link RunHistoryRecord.sk} value) to fetch the page older than. */
  before?: string;
  /** When provided, only runs with this status are returned. */
  status?: RunHistoryStatus;
}

/**
 * Payload accepted by the `terraform.plan` IPC channel. `tfvarsVersionId`,
 * when the configured tfvars source is S3-backed, is forwarded verbatim to
 * `TerraformService.plan`'s pre-spawn staleness check against the current
 * head version of the tfvars object.
 *
 * Mirrors `TerraformPlanPayload` in
 * `@hyveon/desktop-main/src/controllers/terraform.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface TerraformPlanPayload {
  tfvarsVersionId?: string;
  /** The `runId` of the `apply` run being rolled back, if this plan was started via the rollback flow (#112). */
  rolledBackFrom?: string;
}

/**
 * Immediate acknowledgement the `terraform.plan` IPC channel resolves with.
 * `started: true` means a `runId` was minted and the `terraform plan` run
 * was kicked off in the background — the streamed progress/final result
 * (`TerraformPlanResult`) are delivered separately over the
 * `terraform.plan.chunk` / `terraform.plan.end` side channels, tagged with
 * this same `runId`. `started: false` means the submission was rejected
 * before any run was attempted (no `runId` is present): `error` is a
 * human-readable description of why, and `conflict` additionally names the
 * already-running subcommand (`init` / `plan` / `apply` / `destroy`) when the
 * rejection was specifically because the shared Terraform workspace was busy.
 *
 * Mirrors `TerraformPlanAck` in
 * `@hyveon/desktop-main/src/controllers/terraform.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface TerraformPlanAck {
  started: boolean;
  runId?: string;
  error?: string;
  conflict?: 'init' | 'plan' | 'apply' | 'destroy';
}

/**
 * Result the `terraform.rollback.resolve` IPC channel resolves with.
 * `resolved: true` carries the historic version identified as the rollback
 * target — `versionId`/`lastModified` — for the confirmation dialog to
 * display before anything is written. `resolved: false` means resolution
 * was rejected; `error` is always a human-readable description of why.
 *
 * Mirrors `TerraformRollbackResolveAck` in
 * `@hyveon/desktop-main/src/controllers/terraform.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface TerraformRollbackResolveAck {
  resolved: boolean;
  versionId?: string;
  lastModified?: string;
  error?: string;
}

/**
 * Result the `terraform.rollback.confirm` IPC channel resolves with.
 * `confirmed: true` means the historic tfvars content was restored as a new
 * head version — `versionId` is the new version's id. `confirmed: false`
 * means no write was attempted; `error` is always a human-readable
 * description of why.
 *
 * Mirrors `TerraformRollbackConfirmAck` in
 * `@hyveon/desktop-main/src/controllers/terraform.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface TerraformRollbackConfirmAck {
  confirmed: boolean;
  versionId?: string;
  error?: string;
}

/**
 * Payload accepted by the `terraform.apply` IPC channel. `planRunId`
 * identifies the approved plan run to apply; `planHash` is the caller's
 * expected plan hash, checked against the plan run's stored `planHash` to
 * catch drift between when the plan was approved and when apply runs.
 *
 * Mirrors the `POST /api/terraform/apply` request body described in issue
 * #109 — the desktop-main apply IPC handler is the source of truth; keep
 * this copy in sync with it.
 */
export interface TerraformApplyPayload {
  planRunId: string;
  planHash: string;
}

/**
 * Result the `terraform.destroy.mintToken` IPC channel resolves with —
 * `token` must be supplied back on {@link TerraformDestroyPayload.confirmationToken}
 * within its short expiry window (see `TerraformService.mintDestroyConfirmationToken`).
 *
 * Mirrors `TerraformDestroyMintAck` in
 * `@hyveon/desktop-main/src/controllers/terraform.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface TerraformDestroyMintAck {
  token: string;
}

/**
 * Payload accepted by the `terraform.destroy` IPC channel. `confirmationToken`
 * must be the most recently minted, unexpired, not-yet-consumed value
 * returned by `terraform.destroy.mintToken` — enforced server-side, never
 * trusted from the client beyond this single round-trip.
 *
 * Mirrors `TerraformDestroyPayload` in
 * `@hyveon/desktop-main/src/controllers/terraform.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface TerraformDestroyPayload {
  confirmationToken: string;
}

/**
 * Immediate acknowledgement the `terraform.approve` IPC channel resolves
 * with once the identified plan run has been marked approved. Mirrors
 * `TerraformApproveAck` in `@hyveon/desktop-main/src/controllers/terraform.controller.ts`
 * — that type is the source of truth; keep this copy in sync with it.
 * `approved: true` means `RunRecordService.approveRun` succeeded and
 * `approvedBy`/`approvedAt` mirror the values stamped onto the persisted
 * `RunRecord`. `approved: false` means the request failed (invalid payload,
 * missing service, or a thrown error) — `error` carries a human-readable
 * description and `approvedBy`/`approvedAt` are omitted. Note there is no
 * `runId` field — the controller never returns one.
 */
export interface TerraformApproveAck {
  approved: boolean;
  approvedBy?: string;
  approvedAt?: string;
  error?: string;
}

/**
 * Shape of the subset of Terraform root outputs the management app consumes.
 *
 * Mirrors `TfOutputs` in `@hyveon/desktop-main/src/services/ConfigService.ts`
 * — that file is the source of truth; keep this copy in sync with it.
 */
export interface TfOutputs {
  aws_region: string;
  ecs_cluster_name: string;
  ecs_cluster_arn: string;
  subnet_ids: string;
  security_group_id: string;
  file_manager_security_group_id: string;
  efs_file_system_id: string;
  efs_access_points: Record<string, string>;
  domain_name: string;
  game_names: string[];
  alb_dns_name: string | null;
  acm_certificate_arn: string | null;
  discord_table_name: string;
  audit_table_name: string;
  discord_bot_token_secret_arn: string;
  discord_public_key_secret_arn: string;
  interactions_invoke_url: string | null;
  discord_interactions_url: string | null;
  /**
   * Full per-game `game_servers` configuration as last applied by Terraform
   * (the `applied_game_servers` sensitive output — see `terraform/aws/outputs.tf`),
   * keyed by game name. `null` when the output is absent (e.g. state predates
   * this output, or `terraform apply` hasn't run since it was added).
   */
  applied_game_servers: Record<string, Omit<GameServer, 'name'>> | null;
}

// ---------------------------------------------------------------------------
// Per-namespace sub-interfaces
// ---------------------------------------------------------------------------

/** Game-server lifecycle: list games, query status, start/stop ECS tasks. */
export interface GsdGamesApi {
  /** Lists games merged from tfvars (declared) and tfstate (deployed). */
  list: () => Promise<{ games: GameListEntry[] }>;
  /** Returns ECS status for every game in parallel. */
  status: () => Promise<GameStatus[]>;
  /** Returns ECS status for a single game. */
  getStatus: (game: string) => Promise<GameStatus>;
  /** Launches the `{game}-server` ECS task. */
  start: (game: string) => Promise<StartResult>;
  /** Stops the running ECS task for `game`. */
  stop: (game: string) => Promise<StartResult>;
  /** Adds a new entry to the tfvars `game_servers` map. */
  create: (payload: CreateGamePayload) => Promise<GameWriteResult>;
  /** Overwrites an existing entry in the tfvars `game_servers` map. */
  update: (payload: UpdateGamePayload) => Promise<GameWriteResult>;
  /** Removes an entry from the tfvars `game_servers` map. */
  delete: (payload: DeleteGamePayload) => Promise<GameWriteResult>;
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

/** Drift detection: compares declared (tfvars) config against deployed (tfstate) state. */
export interface GsdDriftApi {
  /** Returns the current drift report — games out of sync between declared and deployed state. */
  get: () => Promise<DriftReport>;
}

/** Local application log diagnostics: tail recent lines or retrieve the log file path. */
export interface GsdDiagnosticsApi {
  /** Returns the last 500 lines from today's local log file. */
  tail: () => Promise<{ lines: string[] }>;
  /** Returns the absolute path of today's local log file. */
  path: () => Promise<{ path: string }>;
}

/** Audit log: paginated history of `game_servers` mutations from DynamoDB. */
export interface GsdAuditApi {
  /**
   * Returns a page of audit entries, newest-first. `opts.limit` caps the
   * number of entries returned; `opts.before` is a pagination cursor (an
   * {@link AuditEntry.sk} value) from a previous page's `nextBefore`, used
   * to fetch the next, older page.
   */
  list: (opts?: { limit?: number; before?: string }) => Promise<AuditPageResult>;
}

/**
 * Terraform run history: look up a single plan/apply/destroy run's current
 * status and stream its live/replayed log output (issue #108).
 */
export interface GsdTerraformRunsApi {
  /**
   * Looks up the run identified by `runId` and returns its current
   * {@link TerraformRunsGetResult} — `{ found: false }` if `runId` is
   * neither the in-flight run nor a persisted {@link TerraformRunRecord},
   * otherwise `{ found: true, status, record? }`.
   *
   * Internally this is a plain `invoke('terraform.runs.get', { runId })`
   * call — unlike {@link streamLogs}, there is no streaming involved.
   */
  get: (runId: string) => Promise<TerraformRunsGetResult>;
  /**
   * Opens a live/replayed log stream for the run identified by `runId` as an
   * async iterable of {@link TerraformRunChunk}. Consume it with
   * `for await (const chunk of terraform.runs.streamLogs(runId, signal))`.
   *
   * Mirrors {@link GsdTerraformApi.init}'s streaming shape: the
   * `terraform.runs.logs` invoke call resolves immediately with an opaque
   * `streamId`, and subsequent chunk/end messages arrive on the fixed
   * `terraform.runs.logs.chunk` / `terraform.runs.logs.end` side channels,
   * tagged with that `streamId` so overlapping subscriptions to different
   * runs can never cross-terminate one another.
   *
   * Pass an `AbortSignal` to stop consuming the stream early: aborting (or
   * breaking out of the `for await` loop) stops the generator from yielding
   * further chunks. There is no dedicated cancel side channel — the run
   * itself (and its log tailing on the main-process side) keeps going in the
   * background; only this caller's consumption stops.
   *
   * The iterator completes normally once the run's output finishes
   * replaying/streaming, and throws (using the `terraform.runs.logs.end`
   * payload's `error` field) if it terminated due to an error.
   */
  streamLogs: (runId: string, signal?: AbortSignal) => AsyncIterable<TerraformRunChunk>;
  /**
   * Returns a page of persisted run records, newest-first. `opts.limit` caps
   * the number of records returned; `opts.before` is a pagination cursor (a
   * {@link RunHistoryRecord.sk} value) from a previous page's `nextBefore`,
   * used to fetch the next, older page; `opts.status` filters to a single
   * run status.
   *
   * Internally this is a plain `invoke('terraform.runs.list', opts)` call —
   * no streaming involved.
   */
  list: (opts?: TerraformRunsListOpts) => Promise<RunHistoryPageResult>;
  /**
   * Resolves a temporary, fetchable URL for a run's log once it has been
   * offloaded to remote storage (i.e. the record's `logS3Key` is set,
   * distinguishing it from a small enough log embedded on `logInline`).
   *
   * Internally this is a plain `invoke` call on the `terraform.runs.logUrl`
   * channel, unwrapped from the channel's `url` result field to a bare
   * string for ergonomic `fetch(url)` use at the call site.
   */
  logUrl: (logKey: string, expiresInSeconds?: number) => Promise<string>;
}

/**
 * Terraform orchestration: streams `terraform init` output live as the
 * process runs.
 */
export interface GsdTerraformApi {
  /**
   * Runs `terraform init` against `config` (backend bucket/region/DynamoDB
   * lock table) and returns its output as an async iterable of
   * {@link TerraformRunChunk}. Consume it with
   * `for await (const chunk of terraform.init(config, signal))`.
   *
   * Internally this wraps the fixed `terraform.init.chunk` / `terraform.init.end`
   * side-channel IPC messages `TerraformController.init` sends in an async
   * generator — unlike `logs.stream`, there is no per-call `streamId` because
   * `TerraformService.init` only ever allows one run in flight at a time.
   *
   * Pass an `AbortSignal` to cancel the stream: aborting (or breaking out of
   * the `for await` loop) stops consuming the run early, mirroring
   * `logs.stream`'s cancellation semantics.
   *
   * The iterator completes normally once the run finishes successfully, and
   * throws (using the `terraform.init.end` payload's `error` field) if the
   * run failed — including if the initial `config` failed validation and no
   * `terraform init` process was ever spawned.
   */
  init: (config: TerraformInitConfig, signal?: AbortSignal) => AsyncIterable<TerraformRunChunk>;
  /**
   * Submits a `terraform plan` run by invoking the `terraform.plan` IPC
   * channel and resolves its immediate {@link TerraformPlanAck}.
   *
   * `opts.tfvarsVersionId`, when supplied, is forwarded to
   * `TerraformService.plan`'s staleness check against the current head
   * version of the tfvars object. The resolved ack reports whether the run
   * started (`{ started: true, runId }`) or was rejected before starting —
   * the only rejection path is the shared Terraform workspace already being
   * busy running `init`/`plan`/`apply`/`destroy`
   * (`{ started: false, error, conflict }`). Any other failure — including a
   * stale-tfvars rejection — still resolves `{ started: true, runId }`; the
   * error arrives afterwards on the `terraform.plan.end` side channel
   * (`exitCode: null`) rather than on this ack.
   *
   * This call only resolves the initial acknowledgement — it does not itself
   * stream the run's output; consume `terraform.plan.chunk` /
   * `terraform.plan.end` (tagged with the returned `runId`) separately for
   * progress and the final `TerraformPlanResult`.
   */
  plan: (opts?: TerraformPlanPayload) => Promise<TerraformPlanAck>;
  /**
   * Approves a completed plan run (identified by `opts.planRunId`, its
   * `runId`) so `apply` may proceed against it, by invoking the
   * `terraform.approve` IPC channel with `opts`.
   *
   * Mirrors `POST /api/terraform/runs/:id/approve` (#109) — admin-only;
   * records the approver and approved-at timestamp on the plan run and
   * resolves the {@link TerraformApproveAck}.
   */
  approve: (opts: { planRunId: string }) => Promise<TerraformApproveAck>;
  /**
   * Submits a `terraform apply` run gated on plan-hash + approval by
   * invoking the `terraform.apply` IPC channel, resolving an ack shaped like
   * {@link TerraformPlanAck}. Mirrors `POST /api/terraform/apply` (#109):
   * rejects when the plan run isn't approved, the current tfvars has
   * drifted since the plan, the supplied `planHash` doesn't match the plan
   * run's stored hash, or another run already holds the shared workspace
   * lock.
   */
  apply: (payload: TerraformApplyPayload) => Promise<TerraformPlanAck>;
  /**
   * Mints a fresh, short-lived destroy-confirmation token by invoking the
   * `terraform.destroy.mintToken` IPC channel — call this the moment the
   * operator's type-to-confirm phrase is accepted, then pass the returned
   * `token` straight through to {@link destroy}'s `confirmationToken` before
   * it expires. Minting a new token supersedes (invalidates) any prior
   * unconsumed one.
   */
  mintDestroyToken: () => Promise<TerraformDestroyMintAck>;
  /**
   * Submits a `terraform destroy -auto-approve` run gated on
   * `payload.confirmationToken` (minted via {@link mintDestroyToken}) by
   * invoking the `terraform.destroy` IPC channel, resolving an ack shaped
   * like {@link TerraformPlanAck}. Mirrors {@link apply}: this call only
   * resolves the initial acknowledgement — it does not itself stream the
   * run's output; consume `gsd.terraform.runs.streamLogs(runId)` (tagged
   * with the returned `runId`) for progress, the same seam every other
   * `terraform` run's live output flows through.
   */
  destroy: (payload: TerraformDestroyPayload) => Promise<TerraformPlanAck>;
  /**
   * Returns the current Terraform outputs by invoking the `terraform.output`
   * IPC channel with `{ force }`. `force` defaults to `false`, matching
   * `TerraformService.output`'s own default; pass `true` to bypass its
   * in-memory cache and re-spawn `terraform output -json`. Resolves `null`
   * when Terraform reports no outputs (infra not yet deployed).
   */
  output: (force?: boolean) => Promise<TfOutputs | null>;
  /** Terraform run history: look up a single run's status and stream its log output. */
  runs: GsdTerraformRunsApi;
  /** Rollback flow (#112): preview and restore a prior tfvars version from an apply run in history. */
  rollback: GsdTerraformRollbackApi;
}

/**
 * Rollback flow (#112) IPC surface. A rollback is two calls: {@link resolve}
 * previews the target version for the confirmation dialog without writing
 * anything, then {@link confirm} restores it as a new tfvars head version.
 * The caller completes the rollback with an ordinary `terraform.plan` call
 * (`{ tfvarsVersionId: confirm's returned versionId, rolledBackFrom: applyRunId }`)
 * so the tagged plan streams and gates through the exact same channel every
 * other plan does.
 */
export interface GsdTerraformRollbackApi {
  /**
   * Resolves the tfvars version that was live immediately before the given
   * `apply` run, by invoking the `terraform.rollback.resolve` IPC channel.
   * Read-only — performs no write. `resolved: false` means the target
   * couldn't be resolved (no matching apply run, not an apply run, no
   * recorded `tfvarsVersionId`, or no earlier version exists) — `error`
   * describes why.
   */
  resolve: (opts: { applyRunId: string }) => Promise<TerraformRollbackResolveAck>;
  /**
   * Confirms a previewed rollback of `opts.applyRunId`, by invoking the
   * `terraform.rollback.confirm` IPC channel — restores the historic tfvars
   * content as a new head version. `confirmed: false` means no write was
   * attempted — `error` describes why.
   */
  confirm: (opts: { applyRunId: string }) => Promise<TerraformRollbackConfirmAck>;
}

// ---------------------------------------------------------------------------
// Test-only injection surface
// ---------------------------------------------------------------------------

/**
 * Mock namespace bag: a partial copy of every `GsdApi` namespace so test
 * harnesses can supply only the methods they care about.
 *
 * Derived as a mapped type over every `GsdApi` namespace key (everything
 * except the `__test` injection surface itself) so a namespace added to
 * `GsdApi` flows in automatically — no hand-maintained property list to drift.
 */
export type GsdMockNamespaces = {
  [K in Exclude<keyof GsdApi, '__test'>]?: Partial<GsdApi[K]>;
};

/**
 * Test-only API surface injected under `window.gsd.__test`.
 *
 * Present in two distinct scenarios:
 *
 * 1. **Vitest / jsdom unit tests** — the test harness replaces the entire
 *    `window.gsd` object with a mock built from `test-mock-registry`; the mock
 *    object includes this property so individual test cases can register
 *    per-channel overrides via `window.gsd.__test.mock(channel, handler)`.
 *
 * 2. **Electron preload at runtime** — when the app is launched with
 *    `HYVEON_TEST_MODE=1` (set by the Playwright integration-test harness),
 *    `preload.ts` appends `__test` to the real `window.gsd` bridge so that
 *    Playwright page scripts can inject IPC mocks without touching the real
 *    Electron IPC layer.
 *
 * Production code must **never** reference this property — guard every access
 * with an `if (window.gsd?.__test)` check or, better, avoid it entirely outside
 * tests.
 */
export interface GsdTestApi {
  /**
   * Registers a per-channel mock handler.
   *
   * Call `mock(channel, handler)` before rendering the component under test.
   * When the preload bridge later invokes `ipcRenderer.invoke(channel, ...args)`,
   * the registered handler is called instead and its return value is resolved.
   * Pass a plain value (non-function) to have it returned verbatim.
   *
   * @param channel - The IPC channel name to intercept (e.g. `'games.list'`).
   * @param handler - A function `(...args) => result` or a static return value.
   */
  mock: (channel: string, handler: unknown) => void;
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
  /** Drift detection: compares declared (tfvars) config against deployed (tfstate) state. */
  drift: GsdDriftApi;
  /** Local application log diagnostics: tail recent lines or retrieve the log file path. */
  diagnostics: GsdDiagnosticsApi;
  /** Audit log: paginated history of `game_servers` mutations from DynamoDB. */
  audit: GsdAuditApi;
  /** Terraform orchestration: streams `terraform init` output live as the process runs. */
  terraform: GsdTerraformApi;
  /**
   * Test-only injection surface; `undefined` in production.
   *
   * Present in two scenarios:
   * - **Vitest / jsdom** — the test harness stubs the whole `window.gsd`
   *   object with a mock that includes this property.
   * - **Electron preload** — appended to the real bridge when the process is
   *   started with `HYVEON_TEST_MODE=1` by the Playwright integration-test
   *   harness.
   *
   * Never reference this in production code paths.
   */
  __test?: GsdTestApi;
}
