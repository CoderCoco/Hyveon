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
import type { RunKind, RunRecord, RunRecordStore } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { RunService } from './RunService.js';
import { RUN_RECORD_STORE } from '../modules/cloud-provider.tokens.js';

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
}
