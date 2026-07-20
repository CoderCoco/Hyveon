/**
 * Owns the single apply lock that guards `terraform` plan/apply/destroy
 * submissions (issue #106): only one non-terminal run may be in flight at a
 * time. Two layers cooperate:
 *
 * - An in-memory `RunLock` field, checked and optimistically set
 *   synchronously (before any `await`) at the top of {@link createRun} — this
 *   is what actually makes two "simultaneous" calls within this Node process
 *   race-free despite there being no real mutex primitive: JS runs a
 *   function's synchronous prologue to completion before yielding to any
 *   other queued call, so the second of two back-to-back `createRun()` calls
 *   always observes the first call's lock.
 * - The DynamoDB-backed apply lock item exposed via
 *   `RunRecordStore.acquireRunLock`/`getRunLock`/`releaseRunLock` (see
 *   `@hyveon/shared/cloud.js`), which makes the lock durable across app
 *   restarts and consistent if more than one desktop-main process is ever
 *   run against the same deploy. When `runs_table_name` isn't in the
 *   Terraform outputs yet (table not deployed — the same chicken-and-egg
 *   case `RunRecordService.persist`/`AuditService.record` guard against),
 *   the DynamoDB call is skipped entirely and the in-memory lock alone
 *   enforces exclusivity.
 */
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { isRunLockExpired, RunLockHeldError } from '@hyveon/shared';
import type { RunKind, RunLock, RunRecordStore } from '@hyveon/shared';
import { ConfigService } from './ConfigService.js';
import { RUN_RECORD_STORE } from '../modules/cloud-provider.tokens.js';

/**
 * How long an acquired {@link RunLock} remains valid, in milliseconds, before
 * {@link isRunLockExpired} treats it as stale even if the run that acquired
 * it never released it (e.g. the process crashed mid-run). One hour comfortably
 * covers the longest `terraform apply` this project's game-server stack is
 * expected to take, while still bounding how long a crashed run can wedge
 * the lock.
 */
export const DEFAULT_LOCK_TTL_MS = 60 * 60 * 1000;

/**
 * Owns the apply lock guarding `terraform` plan/apply/destroy submissions.
 * See the file-level doc comment above for the in-memory + DynamoDB
 * two-layer contract.
 */
@Injectable()
export class RunService {
  /**
   * The lock currently held in this process, or `null` when no run is
   * in flight. Read/written synchronously outside of any `await` boundary
   * in {@link createRun}/{@link releaseRun} so it behaves as a mutex despite
   * being a plain field — see the file-level doc comment.
   */
  private currentLock: RunLock | null = null;

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
  ) {}

  /**
   * Attempts to acquire the apply lock on behalf of a new `terraform`
   * plan/apply/destroy run and returns the acquired {@link RunLock}
   * (`runId` freshly minted via `randomUUID()`).
   *
   * Checks (and, if free, optimistically sets) the in-memory lock
   * synchronously before touching DynamoDB, so a second call issued before
   * this one's first `await` is rejected immediately rather than racing the
   * network call. If `runs_table_name` is configured, the lock is then
   * mirrored to the DynamoDB-backed apply lock item via
   * `RunRecordStore.acquireRunLock` — if that call rejects with a
   * `RunLockHeldError` (another process holds the durable lock), the
   * in-memory lock this call had provisionally set is rolled back and the
   * error is re-thrown. When `runs_table_name` isn't configured yet (table
   * not deployed), the DynamoDB call is skipped and the in-memory lock
   * alone enforces exclusivity.
   *
   * @param kind - Which `terraform` subcommand the caller is about to run.
   * @param initiator - Opaque identifier (e.g. username or API caller) of
   *   who is starting the run, surfaced to the UI as the current lock holder.
   * @returns The newly acquired {@link RunLock}.
   * @throws {@link RunLockHeldError} carrying the currently held lock when
   *   another non-terminal run already holds it, whether that lock was
   *   observed in-memory or in DynamoDB.
   */
  async createRun(kind: RunKind, initiator: string): Promise<RunLock> {
    const now = new Date();
    if (this.currentLock !== null && !isRunLockExpired(this.currentLock, now)) {
      throw new RunLockHeldError(this.currentLock);
    }

    const lock: RunLock = {
      runId: randomUUID(),
      kind,
      initiator,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DEFAULT_LOCK_TTL_MS).toISOString(),
    };

    // Optimistically hold the in-memory lock synchronously (no `await` has
    // happened yet), so a concurrent caller sees it immediately.
    this.currentLock = lock;

    const tableName = this.config.getTfOutputs()?.runs_table_name;
    if (tableName) {
      try {
        await this.store.acquireRunLock(lock);
      } catch (err) {
        if (this.currentLock?.runId === lock.runId) {
          this.currentLock = null;
        }
        throw err;
      }
    }

    return lock;
  }

  /**
   * Returns the lock currently held in this process, or `undefined` when no
   * run is in flight or the held lock has expired (see
   * `isRunLockExpired`) — an expired lock is treated as already released
   * even if {@link releaseRun} was never called for it.
   *
   * @returns The in-flight {@link RunLock}, or `undefined`.
   */
  getCurrentLock(): RunLock | undefined {
    if (this.currentLock !== null && !isRunLockExpired(this.currentLock)) {
      return this.currentLock;
    }
    return undefined;
  }

  /**
   * Releases the apply lock, scoped to `runId` so a caller can never release
   * a lock it doesn't itself hold. Clears the in-memory lock first (only if
   * it's still held by `runId`), then, when `runs_table_name` is configured,
   * releases the DynamoDB-backed lock item via `RunRecordStore.releaseRunLock`
   * — both layers no-op rather than throw when `runId` doesn't match the
   * currently held lock.
   *
   * @param runId - The `runId` of the run releasing the lock (matches
   *   {@link RunLock.runId}).
   */
  async releaseRun(runId: string): Promise<void> {
    if (this.currentLock?.runId === runId) {
      this.currentLock = null;
    }

    const tableName = this.config.getTfOutputs()?.runs_table_name;
    if (tableName) {
      await this.store.releaseRunLock(runId);
    }
  }
}
