/**
 * Write/read facade over the cloud-agnostic `RunRecordStore` contract (see
 * `@hyveon/shared/cloud.js`), backing the `terraform` plan/apply/destroy run
 * history table (`terraform/aws/runs_store.tf`).
 *
 * `persist()` decides, per call, whether a run's captured log is small
 * enough to embed directly on the `RunRecord.logInline` attribute or must be
 * offloaded to the store's remote file backend (S3 for AWS) via
 * `RunRecordStore.putLog`, with the resulting key stored on
 * `RunRecord.logS3Key` instead — see {@link INLINE_LOG_LIMIT_BYTES}. The two
 * attributes are mutually exclusive; a record never has both set. It is
 * intentionally best-effort: a run-history write failure must never mask
 * (or retroactively fail) an otherwise-successful `terraform` run, so every
 * failure path logs a winston warning and falls back to the least-lossy
 * option it can rather than throwing — mirrors `AuditService.record`'s
 * swallow-on-error contract.
 *
 * `persist()` also owns releasing the apply lock (issue #106) that
 * `RunService.createRun` acquired for `params.runId`: the release is wrapped
 * in a `finally` so it happens unconditionally — whether the table-not-
 * deployed guard short-circuits the method, the write succeeds, or any of
 * the best-effort log/record writes fails — since a lock left held after its
 * run has finished would wedge every subsequent `terraform` submission.
 */
import { readFileSync } from 'node:fs';
import { Inject, Injectable } from '@nestjs/common';
import { buildRunSk, deriveRunStatus } from '@hyveon/shared';
import type { RunKind, RunRecord, RunRecordStore, RunStatus } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { RunService } from './RunService.js';
import { RUN_RECORD_STORE } from '../modules/cloud-provider.tokens.js';

/**
 * Thrown by {@link RunRecordService.approveRun} when the run-history table
 * isn't configured yet (`ConfigService.getTfOutputs().runs_table_name` is
 * unset) — the same chicken-and-egg guard {@link RunRecordService.persist}
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

/**
 * Input to {@link RunRecordService.persist} — everything about a finished
 * `terraform` run except its derived `status`, sort key, and captured log,
 * which the service fills in / reads itself (`status` via
 * {@link deriveRunStatus}, `sk` via {@link buildRunSk}, log contents from the
 * `logFilePath` passed alongside these params).
 */
export interface PersistRunRecordParams {
  /** Unique identifier of the run — matches the `runId` minted by `TerraformService` when the subcommand was spawned. */
  runId: string;
  /** Which `terraform` subcommand produced this run. */
  kind: RunKind;
  /** ISO-8601 timestamp captured immediately before the process was spawned. */
  startedAt: string;
  /** ISO-8601 timestamp captured immediately after the process closed. */
  completedAt: string;
  /** The process's exit code, or `null` if it never reported one (e.g. killed via abort signal). */
  exitCode: number | null;
  /** The tfvars version id the run was executed against, if the caller supplied one. */
  tfvarsVersionId?: string;
  /**
   * SHA-256 hex digest of the `.tfplan` artifact this run produced (a
   * successful `plan` run only — see `TerraformService.computePlanHash` and
   * issue #109), if the caller supplied one.
   */
  planHash?: string;
}

/**
 * Persists `terraform` plan/apply/destroy run history to (and resolves
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
  ) {}

  /**
   * Builds a {@link RunRecord} from `params` (`status` derived via
   * {@link deriveRunStatus}, `sk` via {@link buildRunSk}) and persists it via
   * `store.putRecord`.
   *
   * Never throws, and never lets a run-history write failure mask (or
   * retroactively fail) the `terraform` run it describes:
   *
   * - When `runs_table_name` isn't in the Terraform outputs yet (table not
   *   deployed — the same chicken-and-egg case `AuditService.record` guards
   *   against, since the very `terraform apply` that creates the table
   *   can't itself be recorded to it), a winston warning is logged and the
   *   method returns without touching `store` at all.
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
    try {
      const tableName = this.config.getTfOutputs()?.runs_table_name;
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
          ...(params.tfvarsVersionId !== undefined ? { tfvarsVersionId: params.tfvarsVersionId } : {}),
          ...(params.planHash !== undefined ? { planHash: params.planHash } : {}),
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
    return this.store.getLogUrl(logKey, expiresInSeconds);
  }

  /**
   * Looks up a previously persisted run record by its `runId`, delegating
   * directly to `store.getRecordByRunId` — exposed on the service (rather
   * than requiring callers to reach for the injected store themselves) so
   * consumers such as the apply IPC handler (#109) depend only on
   * `RunRecordService`.
   *
   * Guarded by the same `runs_table_name`-not-configured check as
   * {@link persist}: when the run-history table isn't in the Terraform
   * outputs yet, a winston warning is logged and `undefined` is returned
   * without calling `store.getRecordByRunId`.
   *
   * @param runId - Unique identifier of the run to look up.
   * @returns The matching {@link RunRecord}, or `undefined` if no record with
   *   that `runId` exists in the store (or the run-history table isn't
   *   configured yet).
   */
  async getByRunId(runId: string): Promise<RunRecord | undefined> {
    const tableName = this.config.getTfOutputs()?.runs_table_name;
    if (!tableName) {
      logger.warn('RunRecordService.getByRunId: runs_table_name not configured, returning undefined', {
        runId,
      });
      return undefined;
    }

    return this.store.getRecordByRunId(runId);
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
    const tableName = this.config.getTfOutputs()?.runs_table_name;
    if (!tableName) {
      throw new RunRecordTableNotConfiguredError(runId);
    }

    const record = await this.store.getRecordByRunId(runId);
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

    await this.store.putRecord(updated);
    return updated;
  }
}
