/**
 * Which `terraform` subcommand a {@link RunRecord} describes. Mirrors the
 * subset of `TerraformService`'s public surface that produces a run worth
 * tracking in history (`init` is idempotent/frequent and is intentionally
 * excluded).
 */
export type RunKind = 'plan' | 'apply' | 'destroy';

/**
 * Lifecycle status of a {@link RunRecord}, derived (never stored ad hoc) via
 * {@link deriveRunStatus}. Also the hash key of the `status-index` GSI on the
 * `${project_name}-runs` DynamoDB table (see `terraform/aws/runs_store.tf`),
 * so callers can list all runs in a given status ordered by `startedAt`
 * without scanning the table. There is no `pending` status — a
 * {@link RunRecord} is only persisted once the subcommand has finished.
 */
export type RunStatus = 'success' | 'failed' | 'aborted';

/**
 * A single row in the DynamoDB run-history table (`${project_name}-runs`,
 * `pk = "RUN"`, `sk = ` {@link buildRunSk}). Records one `terraform`
 * plan/apply/destroy invocation driven through the management app's
 * apply-history view — see `terraform/aws/runs_store.tf` for the table
 * definition and issue #179 for the field list this mirrors.
 */
export interface RunRecord {
  /** Sort key: `<startedAt>#<runId>` — see {@link buildRunSk}. */
  sk: string;
  /** Unique identifier for the run — matches the `runId` minted by `TerraformService` when the subcommand was spawned. */
  runId: string;
  /** Which `terraform` subcommand produced this record. */
  kind: RunKind;
  /** Lifecycle status, derived via {@link deriveRunStatus} from the process's exit code rather than set directly by callers. */
  status: RunStatus;
  /** ISO-8601 timestamp captured immediately before the process was spawned. Duplicated from `sk` for cheap reads without parsing, and doubles as the `status-index` GSI's range key. */
  startedAt: string;
  /** ISO-8601 timestamp captured immediately after the process closed. */
  completedAt: string;
  /** The process's exit code, or `null` if it never reported one (e.g. killed via abort signal). */
  exitCode: number | null;
  /** The tfvars version id the run was executed against, if the caller supplied one. */
  tfvarsVersionId?: string;
  /**
   * Hash of the plan artifact this record's `terraform` invocation produced
   * (for a `plan` run) or was gated against (for an `apply` run) — see #109.
   * The apply IPC handler compares the caller-supplied `planHash` against the
   * plan run's stored value before allowing the apply to proceed, ensuring
   * the tfvars/plan an admin approved is exactly what gets applied.
   */
  planHash?: string;
  /**
   * Opaque identifier (e.g. username) of the admin who approved this plan
   * run for apply. Set only by the approve endpoint
   * (`POST /api/terraform/runs/:id/approve`, #109) and only ever on `plan`
   * records — an unapproved plan has this unset.
   */
  approvedBy?: string;
  /**
   * ISO-8601 timestamp captured when {@link approvedBy} approved this plan
   * run. Paired with {@link isApprovalExpired} to enforce that apply only
   * proceeds while the approval is still within {@link APPROVAL_WINDOW_MS} of
   * being granted, so a stale approval can't be used to apply drifted state.
   */
  approvedAt?: string;
  /**
   * The run's captured log text, embedded directly on the record because it
   * was small enough to fit under the caller's inline-size threshold (see
   * `RunRecordService.INLINE_LOG_LIMIT_BYTES`). Mutually exclusive with
   * {@link logS3Key} — a record has at most one of the two set, never both.
   * Absent when the log was offloaded instead, or was never captured.
   */
  logInline?: string;
  /**
   * Key returned by {@link RunRecordStore.putLog} identifying where the run's
   * captured log was written (e.g. `runs/${runId}.log` in the remote file
   * store) once it exceeded the inline-attribute size threshold. Pass this
   * value to {@link RunRecordStore.getLogUrl} to resolve a fetchable URL.
   * Mutually exclusive with {@link logInline} — a record has at most one of
   * the two set, never both. Absent when the log was small enough to be
   * embedded inline instead, or was never captured.
   */
  logS3Key?: string;
}

/**
 * A page of run records returned by {@link RunRecordStore.listRuns},
 * newest-first, plus an optional cursor for fetching the next page.
 */
export interface RunPageResult {
  /** The page of records, newest-first. */
  records: RunRecord[];
  /** Cursor (a {@link RunRecord.sk} value) to pass as `before` to fetch the next, older page. Absent on the last page. */
  nextBefore?: string;
}

/**
 * Builds a DynamoDB sort key for a new {@link RunRecord}: the run's ISO-8601
 * `startedAt` timestamp followed by a `#`-separated `runId`, e.g.
 * `2026-07-17T12:34:56.789Z#01J...`. The ISO prefix keeps records sorted
 * chronologically within the fixed `RUN` partition; the `runId` suffix
 * disambiguates records started within the same millisecond.
 *
 * Pure: takes both `startedAt` and `runId` as arguments rather than minting
 * either internally, so callers can pass fixed values for deterministic
 * ordering/testing.
 *
 * @param startedAt - ISO-8601 timestamp the run was spawned at.
 * @param runId - Unique identifier of the run (matches {@link RunRecord.runId}).
 * @returns The `<startedAt>#<runId>` sort key.
 */
export function buildRunSk(startedAt: string, runId: string): string {
  return `${startedAt}#${runId}`;
}

/**
 * Derives a {@link RunStatus} from the run's process exit code, so `status`
 * never has to be set independently of it (and can't drift out of sync).
 *
 * A run is `success` when the process exited `0`, `aborted` when it never
 * reported an exit code (i.e. it was killed via an abort signal, surfaced as
 * `exitCode === null`), and `failed` for any other non-zero exit code.
 *
 * @param exitCode - The process's exit code, or `null` if it never reported one (e.g. killed via abort signal).
 * @returns The derived {@link RunStatus}.
 */
export function deriveRunStatus(exitCode: number | null): RunStatus {
  if (exitCode === null) {
    return 'aborted';
  }
  return exitCode === 0 ? 'success' : 'failed';
}

/**
 * Describes the single non-terminal run currently holding the apply lock —
 * the value returned by `RunService.getCurrentLock()` (desktop-main, #106).
 * Only one {@link RunLock} can be outstanding at a time: `RunService.createRun`
 * checks for an existing, unexpired lock before starting a new `terraform`
 * subcommand and rejects with a {@link RunLockHeldError} (see `errors.ts`) if
 * one is found, mirroring CodeBuild's `concurrent_build_limit = 1`.
 *
 * `expiresAt` exists so a crashed/orphaned process (one that started a run
 * but never wrote a terminal {@link RunStatus}) doesn't wedge the lock
 * forever — {@link isRunLockExpired} treats such locks as released once
 * `expiresAt` has passed, even though no terminal status was ever recorded.
 */
export interface RunLock {
  /** Unique identifier of the run holding the lock — matches {@link RunRecord.runId}. */
  runId: string;
  /** Which `terraform` subcommand holds the lock. */
  kind: RunKind;
  /** Opaque identifier (e.g. username or API caller) of who started the run, surfaced to the UI as the current lock holder. */
  initiator: string;
  /** ISO-8601 timestamp the lock was acquired — matches {@link RunRecord.startedAt}. */
  acquiredAt: string;
  /** ISO-8601 timestamp after which the lock is considered stale even without a terminal status being recorded. */
  expiresAt: string;
}

/**
 * Determines whether a {@link RunLock} is stale and should be treated as
 * released, based on whether `now` has passed the lock's `expiresAt`.
 *
 * Pure: takes `now` as an argument (defaulting to the current time) rather
 * than reading the clock internally, so tests can pass a fixed value for
 * deterministic assertions.
 *
 * @param lock - The lock to check.
 * @param now - The instant to check the lock against. Defaults to `new Date()`.
 * @returns `true` if `now` is at or after {@link RunLock.expiresAt}, `false` otherwise.
 */
export function isRunLockExpired(lock: RunLock, now: Date = new Date()): boolean {
  return now.getTime() >= new Date(lock.expiresAt).getTime();
}

/**
 * Duration (in milliseconds) an admin's approval of a plan run remains valid
 * before the apply IPC handler (#109) must reject it and require
 * re-approval. Fixed at 15 minutes — long enough to review a plan and click
 * apply, short enough that a stale approval can't be used to apply against
 * drifted tfvars long after the reviewer looked at it.
 */
export const APPROVAL_WINDOW_MS = 15 * 60 * 1000;

/**
 * Determines whether a plan {@link RunRecord}'s approval has expired, based
 * on whether `now` has passed {@link RunRecord.approvedAt} plus
 * {@link APPROVAL_WINDOW_MS}.
 *
 * Pure: takes `now` as an argument (defaulting to the current time) rather
 * than reading the clock internally, so tests can pass a fixed value for
 * deterministic assertions.
 *
 * @param approvedAt - ISO-8601 timestamp the run was approved at (see {@link RunRecord.approvedAt}).
 * @param now - The instant to check the approval against. Defaults to `new Date()`.
 * @returns `true` if `now` is at or after `approvedAt + APPROVAL_WINDOW_MS`, `false` otherwise.
 */
export function isApprovalExpired(approvedAt: string, now: Date = new Date()): boolean {
  return now.getTime() >= new Date(approvedAt).getTime() + APPROVAL_WINDOW_MS;
}

/**
 * Status surfaced by the run-detail view (`GET /api/terraform/runs/:id`,
 * issue #108) — a superset of the persisted {@link RunStatus} with two
 * additional, non-persisted values computed at read time by
 * {@link computeRunDetailStatus}:
 *
 * - `running` — no {@link RunRecord} exists yet for this run, because (per
 *   {@link RunRecord}'s own doc) a record is only ever persisted once the
 *   subcommand has finished.
 * - `awaiting_approval` — a `plan` run finished successfully but, per the
 *   epic's design (#83), an `apply` may not proceed until an operator
 *   explicitly approves it (#109), so a bare `success` would be misleading.
 */
export type RunDetailStatus = RunStatus | 'running' | 'awaiting_approval';

/**
 * Derives the {@link RunDetailStatus} the run-detail view should render for
 * a given run.
 *
 * Pure: takes primitive data describing the run's current state as
 * arguments (mirroring {@link deriveRunStatus} and {@link isRunLockExpired}'s
 * convention) rather than resolving a {@link RunRecord} internally, so
 * callers control exactly which state is under test and no I/O happens here.
 *
 * Rules, applied in order:
 * 1. `isInFlight` (the run's id matches the currently held {@link RunLock}
 *    and hasn't expired) always maps to `running`, since {@link RunRecord} is
 *    only ever persisted once the subcommand has finished (there is no
 *    `pending` status to store).
 * 2. A `plan` run that exited `0` maps to `awaiting_approval` only while its
 *    `.tfplan` artifact still exists on disk — because the epic's design
 *    (#83) gates `apply` behind an explicit operator approval (#109), a
 *    successful plan alone hasn't reached a terminal state from the
 *    operator's point of view. `planArtifactExists` is plumbed in for that
 *    future approval flow (#109), which is expected to delete the `.tfplan`
 *    file once consumed; as of this writing nothing does, so this rule's
 *    actual escape hatch is rule ordering, not artifact deletion —
 *    `TerraformService.apply` writes its own {@link TerraformRunRecord}
 *    (`kind: 'apply'`) to the same `<runsDir>/<runId>/run.json` that the
 *    plan run used, so once an apply has run for this `runId` the caller
 *    observes `kind === 'apply'` (not `'plan'`) and this rule no longer
 *    matches, falling through to rule 3.
 * 3. Otherwise, the status is derived from `exitCode` via
 *    {@link deriveRunStatus}.
 *
 * @param input - The run's current state:
 * - `isInFlight` - Whether this run is the one currently holding an unexpired {@link RunLock} (i.e. hasn't produced a persisted {@link RunRecord} yet).
 * - `kind` - Which `terraform` subcommand the run is/was, or `null` if unknown.
 * - `exitCode` - The process's exit code, or `null` if it never reported one.
 * - `planArtifactExists` - Whether the run's `.tfplan` artifact still exists on disk (only meaningful for `plan` runs).
 * @returns The computed {@link RunDetailStatus}.
 */
export function computeRunDetailStatus(input: {
  isInFlight: boolean;
  kind: RunKind | null;
  exitCode: number | null;
  planArtifactExists: boolean;
}): RunDetailStatus {
  const { isInFlight, kind, exitCode, planArtifactExists } = input;
  if (isInFlight) {
    return 'running';
  }
  if (kind === 'plan' && exitCode === 0 && planArtifactExists) {
    return 'awaiting_approval';
  }
  return deriveRunStatus(exitCode);
}
