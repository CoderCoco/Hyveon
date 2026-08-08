import { logger } from '../logger.js';

/**
 * Default backoff schedule for {@link verifyAccessKeyWithRetry}: 5 delays
 * between 6 total attempts (1 initial + 5 retries), summing to ~23s worst
 * case. Newly minted IAM access keys can take a few seconds to propagate
 * across AWS before `sts:GetCallerIdentity` reliably succeeds for them —
 * this schedule exists to absorb that propagation delay without treating a
 * spuriously-failing, otherwise-healthy key as invalid.
 */
export const VERIFY_ACCESS_KEY_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 8000];

/** Options for {@link verifyAccessKeyWithRetry}. */
export interface VerifyAccessKeyWithRetryOptions {
  /**
   * Sleep implementation the loop awaits between failed attempts. Always
   * caller-supplied rather than defaulted to a real `setTimeout`-based sleep
   * inside this module, so a caller's own protected `sleep` seam stays the
   * single source of truth tests stub.
   */
  sleep: (ms: number) => Promise<void>;
  /** Backoff delays between attempts. Defaults to {@link VERIFY_ACCESS_KEY_RETRY_DELAYS_MS}. */
  delaysMs?: readonly number[];
  /**
   * Called after every failed attempt, including the last one right before
   * the final throw, with the 1-based attempt number, the total attempt
   * count, and the raw error — callers use this to log per-attempt
   * warnings.
   */
  onAttemptFailed?: (attempt: number, totalAttempts: number, error: unknown) => void;
}

/**
 * Calls `verify` up to `delaysMs.length + 1` times, sleeping the
 * corresponding `delaysMs` entry between failed attempts, and returns as
 * soon as `verify` resolves.
 *
 * @param verify - The operation to retry; called with no arguments, must
 *   resolve on success and reject on failure.
 * @param options - Sleep implementation (required) and optional
 *   delay/callback overrides.
 * @throws The last error `verify` rejected with, unchanged, once all
 *   attempts are exhausted.
 */
export async function verifyAccessKeyWithRetry(
  verify: () => Promise<void>,
  options: VerifyAccessKeyWithRetryOptions,
): Promise<void> {
  const delaysMs = options.delaysMs ?? VERIFY_ACCESS_KEY_RETRY_DELAYS_MS;
  const totalAttempts = delaysMs.length + 1;
  logger.debug('verifyAccessKeyWithRetry: starting access key verification', { totalAttempts });

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      await verify();
      if (attempt > 1) {
        logger.debug('verifyAccessKeyWithRetry: verification succeeded after retrying', { attempt, totalAttempts });
      }
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      options.onAttemptFailed?.(attempt, totalAttempts, err);
      if (attempt === totalAttempts) {
        logger.warn('verifyAccessKeyWithRetry: exhausted all attempts, giving up', {
          totalAttempts,
          error: message,
        });
        throw err;
      }
      logger.debug('verifyAccessKeyWithRetry: attempt failed, retrying after backoff', {
        attempt,
        totalAttempts,
        error: message,
      });
      await options.sleep(delaysMs[attempt - 1]!);
    }
  }
}
