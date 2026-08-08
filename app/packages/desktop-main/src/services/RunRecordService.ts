/**
 * Write/read facade over the cloud-agnostic `RunRecordStore` contract (see
 * `@hyveon/shared/cloud.js`), backing the Pulumi plan/apply/destroy run
 * history table (created via `BootstrapService.ensureRunsTable`, an AWS SDK
 * call made at wizard-bootstrap time — not a Pulumi-managed resource; see
 * `app/packages/infra/src/dynamodb.ts`'s file doc for why).
 *
 * `persist()` decides, per call, whether a run's captured log is small
 * enough to embed directly on the `RunRecord.logInline` attribute or must be
 * offloaded to the store's remote file backend (S3 for AWS) via
 * `RunRecordStore.putLog`, with the resulting key stored on
 * `RunRecord.logS3Key` instead — see {@link INLINE_LOG_LIMIT_BYTES}. The two
 * attributes are mutually exclusive; a record never has both set. It is
 * intentionally best-effort: a run-history write failure must never mask
 * (or retroactively fail) an otherwise-successful Pulumi run, so every
 * failure path logs a winston warning and falls back to the least-lossy
 * option it can rather than throwing — mirrors `AuditService.record`'s
 * swallow-on-error contract.
 *
 * `persist()` also owns releasing the apply lock (issue #106) that
 * `RunService.createRun` acquired for `params.runId`: the release is wrapped
 * in a `finally` so it happens unconditionally — whether the table-not-
 * deployed guard short-circuits the method, the write succeeds, or any of
 * the best-effort log/record writes fails — since a lock left held after its
 * run has finished would wedge every subsequent Pulumi submission.
 */
import { readFileSync } from 'node:fs';
import { Inject, Injectable } from '@nestjs/common';
import { buildRunSk, deriveRunStatus, resolvePreApplyRunsTableName } from '@hyveon/shared';
import type {
  ChangeSummary,
  RemoteFileStore,
  RunKind,
  RunPageResult,
  RunRecord,
  RunRecordStore,
  RunStatus,
} from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { RunService } from './RunService.js';
import { RUN_RECORD_STORE, REMOTE_FILE_STORE } from '../modules/cloud-provider.tokens.js';

/**
 * Thrown by {@link RunRecordService.approveRun} when the run-history table
 * isn't configured yet (`ConfigService.getStackOutputs()`'s `runsTableName`
 * is unset) — the same chicken-and-egg guard {@link RunRecordService.persist}
 * applies, but here it's surfaced to the caller rather than swallowed, since
 * an approval that silently no-ops would let a later apply attempt proceed
 * without ever having recorded who approved it.
 */
export class RunRecordTableNotConfiguredError extends Error {
  constructor(runId: string) {
    super(`RunRecordService.approveRun: runs_table_name not configured, cannot approve run "${runId}"`);
    this.name = 'RunRecordTableNotConfiguredError';
  }
}

/**
 * Thrown by {@link RunRecordService.approveRun} when no run record exists for
 * the given `runId`.
 */
export class RunRecordNotFoundError extends Error {
  constructor(runId: string) {
    super(`No run record found for runId "${runId}"`);
    this.name = 'RunRecordNotFoundError';
  }
}

/**
 * Thrown by {@link RunRecordService.approveRun} when the run record found for
 * `runId` is not a `plan` run — only a `plan` run's `.tfplan` artifact is
 * ever compared against an apply request's `planHash` (see #109), so
 * approving an `apply`/`destroy` record makes no sense.
 */
export class RunRecordNotPlanError extends Error {
  constructor(runId: string, kind: RunKind) {
    super(`Run "${runId}" is a "${kind}" run, not a "plan" run, and cannot be approved`);
    this.name = 'RunRecordNotPlanError';
  }
}

/**
 * Thrown by {@link RunRecordService.approveRun} when the plan run found for
 * `runId` did not finish with `status: 'success'` — a failed or aborted plan
 * produced no trustworthy `.tfplan` artifact for a later apply to reuse.
 */
export class RunRecordNotSuccessfulError extends Error {
  constructor(runId: string, status: RunStatus) {
    super(`Run "${runId}" has status "${status}", not "success", and cannot be approved`);
    this.name = 'RunRecordNotSuccessfulError';
  }
}

/**
 * Maximum size, in UTF-8 encoded bytes, of a captured run log that
 * {@link RunRecordService.persist} will embed directly on the persisted
 * `RunRecord.logInline` attribute instead of offloading to the store's
 * remote file backend (S3 for AWS, via {@link RunRecordStore.putLog}). Set to 350KB
 * (`350 * 1024`) — well under DynamoDB's 400KB item size limit once the
 * record's other attributes are accounted for. This intentionally deviates
 * from the 5MB figure floated in issue #179: 5MB is roughly an order of
 * magnitude past DynamoDB's hard per-item ceiling, so a log anywhere near
 * that size could never be embedded inline regardless — 350KB is the
 * largest threshold that still leaves comfortable headroom for the rest of
 * the item.
 */
export const INLINE_LOG_LIMIT_BYTES = 350 * 1024;

/** Default page size for {@link RunRecordService.listRuns} when `limit` is omitted or invalid. */
const DEFAULT_LIST_LIMIT = 25;

/** Maximum page size {@link RunRecordService.listRuns} will honour, regardless of the requested `limit`. */
const MAX_LIST_LIMIT = 100;

/** Input to {@link RunRecordService.listRuns} — an optional page size, pagination cursor, and status filter. */
export interface ListRunsOpts {
  /** Requested page size; clamped to `[1, 100]` and defaulted to `25` when omitted or invalid. */
  limit?: number;
  /** Cursor (a {@link RunRecord.sk} value) to fetch the page older than. */
  before?: string;
  /** When provided, only runs with this status are returned. */
  status?: RunStatus;
}

/**
 * Clamps a requested page size to a sane default (25) and hard maximum
 * (100). Falls back to the default for anything non-finite or `<= 0`.
 * Mirrors `AuditService`'s identically-named helper.
 */
function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.max(1, Math.min(Math.floor(limit), MAX_LIST_LIMIT));
}

/**
 * Input to {@link RunRecordService.persist} — everything about a finished
 * Pulumi run except its derived `status`, sort key, and captured log,
 * which the service fills in / reads itself (`status` via
 * {@link deriveRunStatus}, `sk` via {@link buildRunSk}, log contents from the
 * `logFilePath` passed alongside these params).
 */
export interface PersistRunRecordParams {
  /** Unique identifier of the run — matches the `runId` minted by `PulumiService` when the subcommand was spawned. */
  runId: string;
  /** Which Pulumi subcommand produced this run. */
  kind: RunKind;
  /** ISO-8601 timestamp captured immediately before the process was spawned. */
  startedAt: string;
  /** ISO-8601 timestamp captured immediately after the process closed. */
  completedAt: string;
  /** The process's exit code, or `null` if it never reported one (e.g. killed via abort signal). */
  exitCode: number | null;
  /** The configuration version id the run was executed against, if the caller supplied one. */
  configVersionId?: string;
  /**
   * SHA-256 hex digest of the `.tfplan` artifact this run produced (a
   * successful `plan` run only — see `PulumiService.computePlanHash` and
   * issue #109), if the caller supplied one.
   */
  planHash?: string;
  /**
   * The `runId` of the `apply` run this plan rolled back, if the caller
   * started this run via the rollback flow (#112).
   */
  rolledBackFrom?: string;
  /**
   * The structured resource-change summary this run's `preview`/`up`
   * reported, if the caller has one — see `ChangeSummary`'s doc comment
   * (`@hyveon/shared/changeSummary.js`). Populated by `PulumiService.preview`
   * and threaded through to {@link RunRecord.changeSummary}.
   */
  changeSummary?: ChangeSummary;
  /**
   * The Pulumi engine version stamped into this run's saved plan artifact,
   * if the caller has one — see {@link RunRecord.engineVersion}'s doc
   * comment. Populated by `PulumiService.preview` and threaded through to
   * {@link RunRecord.engineVersion}.
   */
  engineVersion?: string;
  /**
   * `true` only for a `kind: 'apply'` run that did NOT settle as a success
   * (failed OR aborted) after at least one resource step had already been
   * applied — independent of which of the two it was; see
   * {@link RunRecord.partialApply}'s doc comment (`@hyveon/shared/runs.js`)
   * for why this must never be gated behind `status === 'failed'`. Populated
   * by `PulumiService.apply` and threaded through to
   * {@link RunRecord.partialApply}.
   */
  partialApply?: boolean;
}

/**
 * Input to {@link RunRecordService.writePreflightMarker} — the minimal
 * identifying/gate-carried fields needed to write a durable, in-doubt
 * placeholder {@link RunRecord} for an `apply` attempt BEFORE the underlying
 * engine call (`stack.up()`) begins (issue #399).
 */
export interface PreflightMarkerParams {
  /**
   * Unique identifier of the run about to attempt an apply — always the
   * approved plan run's own `runId` (`PulumiService.apply`'s `planRunId`,
   * reused unchanged as the apply's own `runId`).
   */
  runId: string;
  /**
   * ISO-8601 timestamp captured immediately after the durable apply lock was
   * acquired. Reused, UNCHANGED, as the `startedAt` the eventual settlement
   * write (via {@link persist}) uses for this same attempt, so both writes
   * resolve to the identical {@link RunRecord.sk} (see `buildRunSk`) and the
   * settlement write safely overwrites this marker in place rather than
   * leaving two records behind for one attempt.
   */
  startedAt: string;
  /** The configuration version id the approved plan ran against, if known. */
  configVersionId?: string;
  /** The approved plan's stored `planHash`, if known. */
  planHash?: string;
  /** The approved plan's stamped `engineVersion`, if known. */
  engineVersion?: string;
}

/**
 * Persists Pulumi plan/apply/destroy run history to (and resolves
 * presigned log URLs from) the run-history DynamoDB table + remote log
 * storage via the injected {@link RunRecordStore}. See the file-level doc
 * comment above for the best-effort-write contract.
 */
@Injectable()
export class RunRecordService {
  /**
   * `store` is typed against the cloud-agnostic `RunRecordStore` contract
   * (not a concrete AWS class) so this service depends only on the
   * interface; `@Inject(RUN_RECORD_STORE)` tells Nest which concrete
   * provider (bound by `CloudProviderModule` for whichever cloud is active)
   * to resolve for that parameter, since interfaces don't survive to
   * runtime for Nest's reflection-based DI to key off of.
   */
  constructor(
    private readonly config: ConfigService,
    @Inject(RUN_RECORD_STORE) private readonly store: RunRecordStore,
    private readonly runService: RunService,
    @Inject(REMOTE_FILE_STORE) private readonly remoteFileStore: RemoteFileStore,
  ) {}

  /**
   * Resolves the run-history table's name, preferring
   * `ConfigService.getStackOutputs()`'s `runsTableName` (the deployed
   * stack's own report, once one exists) and falling back to
   * `@hyveon/shared`'s `resolvePreApplyRunsTableName` — which reads the
   * persisted `DeploymentConfig` directly via the injected `RemoteFileStore`
   * — when no stack output is available yet.
   *
   * This fallback is the fix for the bootstrap deadlock this table used to
   * cause: `getStackOutputs()` only ever reports a value after a stack's
   * FIRST successful `apply` (see that method's own doc, "empty outputs also
   * degrades to null"), but every one of this class's public methods needs
   * to resolve a table name on the very first plan/apply cycle of a fresh
   * install, before that has ever happened. Since the runs table is now
   * created via the AWS SDK at wizard-bootstrap time (`BootstrapService.ensureRunsTable`),
   * before any `DeploymentConfig`/Pulumi apply exists at all, computing its
   * deterministic name directly from the persisted config is both correct
   * and available immediately — see `resolvePreApplyRunsTableName`'s own doc
   * for why this never throws and degrades to `undefined` for every "not
   * ready yet" case identically to a genuinely-undeployed stack.
   *
   * @returns The resolved table name, or `undefined` if neither source has
   *   one yet (no stack deployed AND no `DeploymentConfig` persisted yet).
   */
  private async resolveRunsTableName(): Promise<string | undefined> {
    const fromStack = (await this.config.getStackOutputs())?.runsTableName;
    if (fromStack) return fromStack;
    return resolvePreApplyRunsTableName(this.remoteFileStore);
  }

  /**
   * Builds a {@link RunRecord} from `params` (`status` derived via
   * {@link deriveRunStatus}, `sk` via {@link buildRunSk}) and persists it via
   * `store.putRecord`.
   *
   * Never throws, and never lets a run-history write failure mask (or
   * retroactively fail) the Pulumi run it describes:
   *
   * - When {@link resolveRunsTableName} can't resolve a table name yet (no
   *   deployed stack's `runsTableName` output AND no persisted
   *   `DeploymentConfig` to derive it from — i.e. the wizard's bootstrap step,
   *   which creates the table via `BootstrapService.ensureRunsTable`, hasn't
   *   run yet), a winston warning is logged and the method returns without
   *   touching `store` at all.
   * - `logFilePath`, when non-`null`, is read via the filesystem and
   *   embedded on `RunRecord.logInline` when at or under
   *   {@link INLINE_LOG_LIMIT_BYTES} (UTF-8 encoded), or offloaded first via
   *   `store.putLog` (which, for `AwsRunRecordStore`, lands at
   *   `runs/<runId>.log`) with the store-assigned key stored on
   *   `RunRecord.logS3Key` instead — `logInline` and `logS3Key` are mutually
   *   exclusive, so callers (e.g. `getLogUrl`) can tell which one they got
   *   without guessing. `logFilePath` being `null` leaves both attributes
   *   unset entirely — no read/offload attempt is made.
   * - If the log file can't be read, or an oversized log fails to offload
   *   (e.g. no remote file store configured, or the offload call fails),
   *   a winston warning is logged and the record is still persisted via
   *   `store.putRecord` — just without a `logInline`/`logS3Key` attribute —
   *   rather than abandoning the whole write. Losing the log transcript is
   *   preferable to losing the run's existence/status from history.
   * - If the final `store.putRecord` call itself fails, a winston warning is
   *   logged and the method returns.
   *
   * Regardless of which of the above paths is taken (including the
   * table-not-deployed early return), the apply lock `RunService.createRun`
   * acquired for `params.runId` is always released via
   * `RunService.releaseRun` before `persist` returns — the release runs in a
   * `finally` block so a run-history write failure can never leave the lock
   * held.
   *
   * @param params - Everything about the finished run except its log.
   * @param logFilePath - Path to the run's captured stdout+stderr transcript
   *   on disk, or `null` when no log was captured for this run.
   */
  async persist(params: PersistRunRecordParams, logFilePath: string | null): Promise<void> {
    logger.debug('RunRecordService.persist: persisting run record', { runId: params.runId, kind: params.kind });
    try {
      const tableName = await this.resolveRunsTableName();
      if (!tableName) {
        logger.warn('RunRecordService.persist: runs_table_name not configured, skipping run record persistence', {
          runId: params.runId,
          kind: params.kind,
        });
        return;
      }

      let logInline: string | undefined;
      let logS3Key: string | undefined;
      if (logFilePath !== null) {
        let logText: string | undefined;
        try {
          logText = readFileSync(logFilePath, 'utf8');
        } catch (err) {
          logger.warn('RunRecordService.persist: failed to read captured log file, persisting record without log', {
            err,
            runId: params.runId,
            kind: params.kind,
            logFilePath,
          });
        }

        if (logText !== undefined) {
          const byteLength = Buffer.byteLength(logText, 'utf8');
          if (byteLength > INLINE_LOG_LIMIT_BYTES) {
            try {
              logS3Key = await this.store.putLog(params.runId, new TextEncoder().encode(logText));
            } catch (err) {
              logger.warn(
                'RunRecordService.persist: failed to offload log to remote store, persisting record without log',
                { err, runId: params.runId, kind: params.kind },
              );
            }
          } else {
            logInline = logText;
          }
        }
      }

      try {
        const record: RunRecord = {
          sk: buildRunSk(params.startedAt, params.runId),
          runId: params.runId,
          kind: params.kind,
          status: deriveRunStatus(params.exitCode),
          startedAt: params.startedAt,
          completedAt: params.completedAt,
          exitCode: params.exitCode,
          ...(params.configVersionId !== undefined ? { configVersionId: params.configVersionId } : {}),
          ...(params.planHash !== undefined ? { planHash: params.planHash } : {}),
          ...(params.rolledBackFrom !== undefined ? { rolledBackFrom: params.rolledBackFrom } : {}),
          ...(params.changeSummary !== undefined ? { changeSummary: params.changeSummary } : {}),
          ...(params.engineVersion !== undefined ? { engineVersion: params.engineVersion } : {}),
          ...(params.partialApply !== undefined ? { partialApply: params.partialApply } : {}),
          ...(logInline !== undefined ? { logInline } : {}),
          ...(logS3Key !== undefined ? { logS3Key } : {}),
        };

        await this.store.putRecord(record);
      } catch (err) {
        logger.warn('RunRecordService.persist: failed to persist run record', {
          err,
          runId: params.runId,
          kind: params.kind,
        });
      }
    } finally {
      await this.runService.releaseRun(params.runId);
    }
  }

  /**
   * Writes a durable, in-doubt placeholder {@link RunRecord} for an `apply`
   * attempt via a direct `store.putRecord` call — BEFORE `PulumiService.apply`
   * calls `stack.up()` — closing the retry-safety gap issue #399 describes:
   * if the SETTLEMENT write ({@link persist}, called once `stack.up()` has
   * resolved one way or another) itself fails to persist, the apply-kind
   * record `persist` would have written is simply never there, leaving the
   * original approved `plan` record as the only observable record for
   * `runId` — which passes every one of `PulumiService.apply`'s gate checks
   * again, permitting a blind retry against infrastructure a prior attempt
   * may have already partially mutated. Writing this marker durably, before
   * `stack.up()` ever runs, means an apply-kind record for `runId` already
   * exists no matter how the attempt ends — `PulumiService.apply`'s gate
   * checks `record.kind !== 'plan'` (and, more specifically,
   * `record.partialApply === true`) on every subsequent call, and this
   * marker satisfies both.
   *
   * The written record always carries `kind: 'apply'`, `status: 'aborted'`,
   * `exitCode: null`, and `partialApply: true` — NOT because a resource step
   * has actually been applied yet (none has, at the point this is called),
   * but because whether one WILL be applied before this attempt settles is
   * genuinely unknown, and the fix intentionally assumes the worst until a
   * completed successor record (written by {@link persist} once the attempt
   * actually settles, sharing this SAME `sk` — see {@link PreflightMarkerParams.startedAt} —
   * and therefore overwriting this marker in place) proves otherwise.
   *
   * Deliberately bypasses {@link persist} entirely rather than calling it
   * with placeholder fields: `persist`'s own `finally` unconditionally
   * releases the durable apply lock via `RunService.releaseRun` — exactly
   * the lock `PulumiService.apply`'s gate step 8 just acquired and that
   * MUST remain held while `stack.up()` is still ahead of it. Calling
   * `persist` here would release that lock the instant this marker landed,
   * long before the engine call it's supposed to guard even starts.
   *
   * Unlike {@link persist}, this method is NOT best-effort — a failure here
   * is thrown to the caller (`PulumiService.apply`) rather than logged and
   * swallowed, since the whole point is to fail closed: if this marker can't
   * be written durably, `PulumiService.apply` must abort BEFORE calling
   * `stack.up()` (and release the lock itself, in that specific failure
   * path) rather than proceed without one.
   *
   * @param params - The run's identifying/gate-carried fields — see {@link PreflightMarkerParams}.
   * @throws A plain `Error` when `runs_table_name` isn't configured yet, or
   *   whatever `store.putRecord` itself throws (typically a wrapped
   *   DynamoDB error) — neither is caught here, so the caller can tell "the
   *   marker never landed" from "it did."
   */
  async writePreflightMarker(params: PreflightMarkerParams): Promise<void> {
    logger.debug('RunRecordService.writePreflightMarker: writing pre-flight apply marker', { runId: params.runId });
    const tableName = await this.resolveRunsTableName();
    if (!tableName) {
      logger.warn('RunRecordService.writePreflightMarker: runs_table_name not configured, cannot write marker', {
        runId: params.runId,
      });
      throw new Error(
        `RunRecordService.writePreflightMarker: runs_table_name not configured, cannot write pre-flight marker for run "${params.runId}"`,
      );
    }

    const record: RunRecord = {
      sk: buildRunSk(params.startedAt, params.runId),
      runId: params.runId,
      kind: 'apply',
      status: 'aborted',
      startedAt: params.startedAt,
      completedAt: params.startedAt,
      exitCode: null,
      partialApply: true,
      ...(params.configVersionId !== undefined ? { configVersionId: params.configVersionId } : {}),
      ...(params.planHash !== undefined ? { planHash: params.planHash } : {}),
      ...(params.engineVersion !== undefined ? { engineVersion: params.engineVersion } : {}),
    };

    try {
      await this.store.putRecord(record);
    } catch (err) {
      logger.error('RunRecordService.writePreflightMarker: failed to write pre-flight marker', {
        runId: params.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Resolves a temporary, fetchable URL for a previously stored run log,
   * delegating directly to `store.getLogUrl` — `logKey` is expected to be a
   * value previously stored on `RunRecord.logS3Key` by {@link persist} once a
   * log was offloaded (embedded logs, stored on `RunRecord.logInline`
   * instead, have no key to resolve a URL for).
   *
   * @param logKey - The key returned by a prior offload, as stored on `RunRecord.logS3Key`.
   * @param expiresInSeconds - How long the returned URL should remain valid, in
   *   seconds. The underlying store applies its own default when omitted.
   * @returns The store's presigned/temporary URL the caller can fetch the log from directly.
   */
  async getLogUrl(logKey: string, expiresInSeconds?: number): Promise<string> {
    logger.debug('RunRecordService.getLogUrl: resolving run log URL', { logKey });
    try {
      return await this.store.getLogUrl(logKey, expiresInSeconds);
    } catch (err) {
      logger.error('RunRecordService.getLogUrl: failed to resolve run log URL', {
        logKey,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Looks up a previously persisted run record by its `runId`, delegating
   * directly to `store.getRecordByRunId` — exposed on the service (rather
   * than requiring callers to reach for the injected store themselves) so
   * consumers such as the apply IPC handler (#109) depend only on
   * `RunRecordService`.
   *
   * Guarded by the same {@link resolveRunsTableName}-can't-resolve-yet check
   * as {@link persist}: when no table name can be resolved yet, a winston
   * warning is logged and `undefined` is returned without calling
   * `store.getRecordByRunId`.
   *
   * @param runId - Unique identifier of the run to look up.
   * @returns The matching {@link RunRecord}, or `undefined` if no record with
   *   that `runId` exists in the store (or the run-history table isn't
   *   configured yet).
   */
  async getByRunId(runId: string): Promise<RunRecord | undefined> {
    logger.debug('RunRecordService.getByRunId: looking up run record', { runId });
    const tableName = await this.resolveRunsTableName();
    if (!tableName) {
      logger.warn('RunRecordService.getByRunId: runs_table_name not configured, returning undefined', {
        runId,
      });
      return undefined;
    }

    try {
      return await this.store.getRecordByRunId(runId);
    } catch (err) {
      logger.error('RunRecordService.getByRunId: failed to look up run record', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Lists run records newest-first, delegating to `store.listRuns` after
   * clamping `opts.limit` via {@link clampLimit}.
   *
   * Mirrors {@link getByRunId}'s missing-table guard: when
   * {@link resolveRunsTableName} can't resolve a table name yet (table not
   * deployed), a winston warning is logged and an empty page is returned rather than letting
   * `store.listRuns` throw — the apply-history page should render its empty
   * state on pre-runs-table deployments, not an error state.
   *
   * @param opts - Listing options: optional page size, pagination cursor, and status filter.
   * @returns The requested page of records plus a cursor for the next page.
   */
  async listRuns(opts: ListRunsOpts = {}): Promise<RunPageResult> {
    logger.debug('RunRecordService.listRuns: listing run history', { limit: opts.limit, status: opts.status });
    const tableName = await this.resolveRunsTableName();
    if (!tableName) {
      logger.warn('RunRecordService.listRuns: runs_table_name not configured, returning empty run history page');
      return { records: [] };
    }

    try {
      return await this.store.listRuns({
        limit: clampLimit(opts.limit),
        ...(opts.before !== undefined ? { before: opts.before } : {}),
        ...(opts.status !== undefined ? { status: opts.status } : {}),
      });
    } catch (err) {
      logger.error('RunRecordService.listRuns: failed to list run history', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Approves a successful `plan` run for apply: stamps `approvedBy` and an
   * `approvedAt` timestamp onto its persisted {@link RunRecord} and writes it
   * back via `store.putRecord`.
   *
   * Unlike {@link persist}, this method is **not** best-effort — a failure
   * here is thrown to the caller rather than logged and swallowed, since an
   * approval that silently fails would let a later apply proceed without the
   * approval actually having been recorded.
   *
   * Validates, in order, throwing a distinct error for each failure mode so
   * callers (e.g. the approve IPC handler) can surface a precise message:
   *
   * - The run-history table is configured — throws
   *   {@link RunRecordTableNotConfiguredError} otherwise.
   * - A record exists for `runId` — throws {@link RunRecordNotFoundError}
   *   otherwise.
   * - The record's `kind` is `'plan'` — throws {@link RunRecordNotPlanError}
   *   otherwise.
   * - The record's `status` is `'success'` — throws
   *   {@link RunRecordNotSuccessfulError} otherwise.
   *
   * @param runId - Unique identifier of the plan run to approve.
   * @param approvedBy - Opaque identifier (e.g. username) of the admin approving the run.
   * @returns The updated {@link RunRecord}, with `approvedBy`/`approvedAt` set.
   */
  async approveRun(runId: string, approvedBy: string): Promise<RunRecord> {
    logger.debug('RunRecordService.approveRun: approving plan run', { runId });
    const tableName = await this.resolveRunsTableName();
    if (!tableName) {
      throw new RunRecordTableNotConfiguredError(runId);
    }

    let record: RunRecord | undefined;
    try {
      record = await this.store.getRecordByRunId(runId);
    } catch (err) {
      logger.error('RunRecordService.approveRun: failed to look up run record', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    if (!record) {
      throw new RunRecordNotFoundError(runId);
    }

    if (record.kind !== 'plan') {
      throw new RunRecordNotPlanError(runId, record.kind);
    }

    if (record.status !== 'success') {
      throw new RunRecordNotSuccessfulError(runId, record.status);
    }

    const updated: RunRecord = {
      ...record,
      approvedBy,
      approvedAt: new Date().toISOString(),
    };

    try {
      await this.store.putRecord(updated);
    } catch (err) {
      logger.error('RunRecordService.approveRun: failed to persist run approval', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    return updated;
  }
}
