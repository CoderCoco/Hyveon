/**
 * Cloud-agnostic error types shared between the desktop-main API and the
 * Lambda packages. Kept in their own module (rather than alongside a single
 * consumer) so both sides of an operation — the writer that detects the
 * conflict and the caller that needs to react to it — can `instanceof`
 * check against the same class.
 */

import type { RunLock } from './runs.js';

/**
 * Thrown by tfvars write helpers (e.g. `TfvarsService.updateGameServer`)
 * when an optimistic-concurrency check fails: the caller supplied the etag
 * it last read, but the remote file has since moved to a different etag.
 * Carries both etags so the UI can surface a clear "remote moved — refresh"
 * message instead of a generic write failure.
 */
export class OptimisticLockError extends Error {
  /** The etag the caller expected to still be current (from its last read). */
  readonly expectedEtag: string;

  /** The etag actually stored remotely at the time of the write attempt, if known. */
  readonly currentEtag?: string;

  /**
   * @param expectedEtag - The etag the caller expected to still be current.
   * @param currentEtag - The etag actually stored remotely, if known.
   * @param message - Optional human-readable message; defaults to a message
   *   derived from the two etags.
   */
  constructor(expectedEtag: string, currentEtag?: string, message?: string) {
    super(
      message ??
        `Optimistic lock failed: expected etag "${expectedEtag}" but remote is now ${
          currentEtag ? `"${currentEtag}"` : 'unknown'
        }.`,
    );
    this.name = 'OptimisticLockError';
    this.expectedEtag = expectedEtag;
    this.currentEtag = currentEtag;
    Object.setPrototypeOf(this, OptimisticLockError.prototype);
  }
}

/**
 * Thrown by `RunService.createRun()` (desktop-main, #106) when a caller
 * tries to start a new `terraform` plan/apply/destroy while another
 * non-terminal run is already holding the apply lock. Carries the current
 * {@link RunLock} so the HTTP layer can respond `409 Conflict` with details
 * of who holds the lock (initiator, kind, when it was acquired) instead of a
 * generic failure.
 */
export class RunLockHeldError extends Error {
  /** The lock currently held by another in-flight run. */
  readonly lock: RunLock;

  /**
   * @param lock - The lock currently held by another in-flight run.
   * @param message - Optional human-readable message; defaults to a message
   *   derived from the lock's initiator and kind.
   */
  constructor(lock: RunLock, message?: string) {
    super(message ?? `Run lock already held by "${lock.initiator}" (${lock.kind}, runId "${lock.runId}").`);
    this.name = 'RunLockHeldError';
    this.lock = lock;
    Object.setPrototypeOf(this, RunLockHeldError.prototype);
  }
}
