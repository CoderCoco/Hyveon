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
   * Key returned by {@link RunRecordStore.putLog} identifying where the run's
   * captured log was written (e.g. `runs/${runId}.log` in the remote file
   * store) once it exceeded the inline-attribute size threshold. Absent when
   * the log was small enough to be embedded elsewhere or was never captured.
   */
  log?: string;
}

/**
 * A page of run records returned by a future listing API, newest-first, plus
 * an optional cursor for fetching the next page. Not yet wired into
 * {@link RunRecordStore} — listing/pagination is deferred to a follow-up
 * issue; kept here so the shape is ready when that lands.
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
