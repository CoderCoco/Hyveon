import { logger } from '../logger.js';

/**
 * Reusable cancellation-with-escalation primitive satisfying the
 * `pulumi-engine-runtime` delta spec's "Engine process lifecycle" requirement
 * ("cancellation MUST escalate to a forceful termination after a bounded
 * timeout rather than waiting indefinitely").
 *
 * ## What the SDK does on abort
 *
 * `node_modules/@pulumi/pulumi/automation/cmd.js`'s internal `exec()`
 * function (the thing every `stack.preview()`/`.up()`/`.destroy()` call
 * eventually reaches via `PulumiCommand.run()`) wires cancellation like this,
 * verbatim:
 *
 * ```js
 * if (signal) {
 *   signal.addEventListener("abort", () => {
 *     proc.kill("SIGINT", { forceKillAfterTimeout: false });
 *   });
 * }
 * ```
 *
 * Exactly one `SIGINT` is sent, `forceKillAfterTimeout` is hard-coded
 * `false`, and there is no second, stronger signal the SDK will ever send on
 * its own. A wedged engine that ignores `SIGINT` (or is stuck in a
 * cloud-provider API call between signal checks) stays alive forever as far
 * as the SDK's own cancellation mechanism is concerned.
 *
 * ## No PID exposed via the public API
 *
 * No `Stack`/`Workspace` method anywhere in the public Automation API surface
 * exposes the spawned process, its PID, or any other handle to it — the
 * `execa` child process `cmd.js` spawns internally never escapes that module.
 * Given that, what {@link runWithEscalatingCancellation} implements is a
 * **logical** escalation, not a literal `SIGKILL`: once the bounded
 * escalation window elapses without `operation` settling, this function
 * stops waiting on it and settles its own returned promise as forcefully
 * terminated (rejecting with {@link PulumiOperationEscalatedError}) —
 * satisfying "the app does not wait on it indefinitely" and "the run still
 * settles as aborted either way" without a real process kill. The abandoned
 * `operation` promise, if it ever settles in the background, is still
 * consumed internally (so it can never produce an unhandled rejection) but
 * its result is discarded. The optional
 * {@link EscalatingCancellationOptions.onEscalate} hook is the extension
 * point for any additional process-level cleanup a caller wants to run at
 * that point; this module does not supply one itself.
 *
 * ## A pre-aborted signal must never reach the SDK
 *
 * `AbortSignal`'s `addEventListener('abort', ...)` does **not** fire for a
 * listener attached to a signal that is *already* aborted:
 *
 * ```js
 * const c = new AbortController();
 * c.abort();
 * c.signal.addEventListener('abort', () => console.log('fired'));
 * // never logs
 * ```
 *
 * Combined with the `cmd.js` snippet above, this means: if a caller passes an
 * *already-aborted* signal straight into `PreviewOptions.signal`/
 * `UpOptions.signal`/`DestroyOptions.signal`, the SDK's own
 * `addEventListener` call is a permanent no-op — the spawned CLI process
 * would never receive `SIGINT` at all and would run to completion entirely
 * ungoverned by the cancellation the caller thought they had already
 * requested. This is why {@link runWithEscalatingCancellation} checks
 * `userSignal?.aborted` first and refuses to invoke `operation` at all in
 * that case (rejecting with {@link PulumiOperationNotStartedError}) —
 * skipping the invocation entirely is the only way to guarantee a genuinely
 * undesired operation never runs uninterrupted.
 *
 * ## Three distinct settlement shapes, so callers never have to read `signal.aborted` post-hoc
 *
 * This function latches a local `aborted` flag inside its own abort handler,
 * rather than reading `signal.aborted` after the fact, specifically so a
 * signal that fires late can't misclassify an already-successful run — and
 * produces one of three distinct outcomes rather than leaving the *common*
 * case (cancellation worked, the CLI exited via `SIGINT`) indistinguishable
 * from a genuine unrelated failure:
 *
 * 1. {@link PulumiOperationNotStartedError} — `userSignal` was already
 *    aborted before this call; `operation` never ran at all.
 * 2. {@link PulumiOperationAbortedError} — `userSignal` aborted *while*
 *    `operation` was running, and `operation` subsequently rejected (the
 *    expected shape once the SDK's `SIGINT` takes effect: `stack.up()`
 *    rejects with a plain `CommandError`, indistinguishable by type alone
 *    from a genuine failure). This wraps the original rejection as `.cause`
 *    so a caller can record the run as aborted while still retaining the
 *    underlying detail for logs.
 * 3. {@link PulumiOperationEscalatedError} — the bounded escalation window
 *    elapsed with `operation` still pending; see the "logical escalation"
 *    section above.
 *
 * If `operation` instead *resolves* after `userSignal` aborted (a real race:
 * the CLI happened to finish successfully right as `SIGINT` was sent), this
 * function resolves normally rather than fabricating an aborted outcome for
 * a genuinely successful run — the same "don't report success as failure"
 * principle `PulumiLeakedPromise.ts` applies to a different SDK quirk.
 */

/**
 * Bounded window a cancelled operation is given to exit gracefully (i.e. to
 * respond to the SDK's own `SIGINT`) before {@link runWithEscalatingCancellation}
 * gives up waiting and escalates. The `pulumi-engine-runtime` delta spec
 * doesn't name a specific value here — only that a wedged engine would keep
 * the Electron main process alive forever, hence this escalation timer — so
 * this is a deliberately chosen default rather than one derived from the spec.
 *
 * 30 seconds was chosen over a shorter value because a graceful `SIGINT`
 * during a real `up`/`destroy` can legitimately need time to let an
 * in-flight cloud-provider API call (e.g. an ECS `RunTask`/`StopTask` or an
 * S3 multipart upload) return before the CLI can act on the signal — a
 * timeout of a few seconds would routinely escalate healthy, still-working
 * cancellations. 30s was chosen over a longer value (e.g. 60s) so an
 * operator who has already asked to cancel is not left staring at a
 * "cancelling…" state for an excessive stretch when the engine genuinely is
 * wedged. This is a single named constant specifically so it can be tuned
 * later without hunting for a magic number.
 */
export const PULUMI_CANCELLATION_ESCALATION_TIMEOUT_MS = 30_000;

/**
 * Thrown by {@link runWithEscalatingCancellation} when `userSignal` is
 * already `aborted` at call time, so `operation` is never invoked at all —
 * see this file's top-level TSDoc's "pre-aborted signal" section for why
 * this must short-circuit rather than invoking `operation` and trusting the
 * SDK's own signal handling to interrupt it (it wouldn't).
 *
 * Distinct from {@link PulumiOperationAbortedError} (which requires
 * `operation` to have actually started and then been interrupted) — the two
 * error classes exist so "never started" and "started, then genuinely
 * aborted" are always distinguishable.
 */
export class PulumiOperationNotStartedError extends Error {
  constructor() {
    super('Pulumi operation was not started: cancellation was already requested before it began.');
    this.name = 'PulumiOperationNotStartedError';
  }
}

/**
 * Thrown by {@link runWithEscalatingCancellation} when `userSignal` aborted
 * *while* `operation` was running and `operation` subsequently rejected —
 * the expected shape once the SDK's `SIGINT` takes effect (`stack.up()`
 * etc. reject with a plain `CommandError`, otherwise indistinguishable by
 * type from a genuine failure). See this file's top-level TSDoc's "Three
 * distinct settlement shapes" section.
 */
export class PulumiOperationAbortedError extends Error {
  constructor(public readonly cause: unknown) {
    super(
      'Pulumi operation was aborted: cancellation was requested and the underlying invocation ' +
        `subsequently exited/rejected. Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PulumiOperationAbortedError';
  }
}

/**
 * Thrown by {@link runWithEscalatingCancellation} when `operation` does not
 * settle within `escalationTimeoutMs` of `userSignal` aborting. See this
 * file's top-level TSDoc "No PID exposed via the public API" section for why
 * this represents this layer giving up waiting on the operation (a
 * *logical* forceful termination) rather than a literal `SIGKILL` of the
 * underlying engine process.
 */
export class PulumiOperationEscalatedError extends Error {
  constructor(public readonly escalationTimeoutMs: number) {
    super(
      `Pulumi engine invocation did not exit within the ${escalationTimeoutMs}ms escalation timeout after ` +
        'cancellation was requested; it has been forcefully terminated so the app does not wait on it indefinitely.',
    );
    this.name = 'PulumiOperationEscalatedError';
  }
}

/** Options for {@link runWithEscalatingCancellation}. */
export interface EscalatingCancellationOptions {
  /** Overrides {@link PULUMI_CANCELLATION_ESCALATION_TIMEOUT_MS} — primarily for tests. */
  escalationTimeoutMs?: number;
  /**
   * Invoked synchronously, at most once, the instant the escalation timeout
   * elapses without `operation` having settled — before this function's own
   * returned promise rejects with {@link PulumiOperationEscalatedError}. See
   * this file's top-level TSDoc, "No PID exposed via the public API", for
   * what process-level mechanism (if any) a caller might plug in here — this
   * module does not supply one itself.
   */
  onEscalate?: () => void;
}

/**
 * Runs `operation` with a bounded escalation window layered on top of
 * whatever cancellation behaviour `operation` itself implements in response
 * to `userSignal` aborting.
 *
 * `operation` receives an `AbortSignal` to forward into the SDK call it
 * wraps (e.g. `stack.up({ signal, ... })`) — this is `userSignal` itself
 * when one is supplied (not a derived/wrapped signal), so the SDK's own
 * `addEventListener('abort', ...)` fires at exactly the same moment this
 * function's own abort handling does, with no extra indirection.
 *
 * Behaviour:
 * - If `userSignal` is already `aborted` when this is called, `operation` is
 *   **never invoked** and this rejects immediately with
 *   {@link PulumiOperationNotStartedError}.
 * - If `userSignal` is `undefined`, `operation` runs with a signal that will
 *   never abort — no escalation timer is ever armed, since there is nothing
 *   for it to escalate past.
 * - Otherwise, `operation` runs normally until either:
 *   1. It **resolves** — this function resolves the same way, whether or
 *      not `userSignal` ever aborted (see the file TSDoc's note on why a
 *      late-arriving success is never reported as an aborted failure).
 *   2. It **rejects** without `userSignal` ever having aborted — a genuine
 *      failure; this function rejects with the same error, unchanged.
 *   3. It **rejects** *after* `userSignal` aborted — this function rejects
 *      with {@link PulumiOperationAbortedError} wrapping the original
 *      rejection as `.cause`, so a caller can record the run as aborted
 *      without inspecting `signal.aborted` after the fact.
 *   4. `userSignal` aborts and then `escalationTimeoutMs` elapses with
 *      `operation` still pending — `onEscalate` (if supplied) is invoked
 *      once, and this function's returned promise rejects with
 *      {@link PulumiOperationEscalatedError} **without waiting further** for
 *      `operation` to settle. `operation`'s eventual settlement (if any) is
 *      still consumed internally so it can never produce an unhandled
 *      rejection, but its result/error is discarded.
 *
 * If `operation` throws *synchronously* (rather than returning a rejected
 * promise), that is treated the same as an immediate rejection — the abort
 * listener is still removed and this function's promise still rejects
 * (wrapped in {@link PulumiOperationAbortedError} if `userSignal` had
 * already aborted by then).
 *
 * @param operation - The cancellable work to run, given a signal to forward
 *   into the underlying SDK call.
 * @param userSignal - The user-facing Cancel signal, or `undefined` if this
 *   operation cannot be cancelled by the caller.
 * @param options - See {@link EscalatingCancellationOptions}.
 */
export function runWithEscalatingCancellation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  userSignal: AbortSignal | undefined,
  options: EscalatingCancellationOptions = {},
): Promise<T> {
  logger.debug('runWithEscalatingCancellation: invoking Pulumi operation', {
    hasSignal: userSignal !== undefined,
  });

  if (userSignal?.aborted) {
    logger.warn(
      'runWithEscalatingCancellation: userSignal was already aborted before the operation could start — refusing to invoke it',
    );
    return Promise.reject(new PulumiOperationNotStartedError());
  }

  if (!userSignal) {
    return operation(new AbortController().signal);
  }

  const escalationTimeoutMs = options.escalationTimeoutMs ?? PULUMI_CANCELLATION_ESCALATION_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    // Latched the instant the abort listener fires, rather than read from
    // `userSignal.aborted` when `operation` later rejects (see this file's
    // top-level TSDoc). Using the live `.aborted` getter instead would give
    // the same answer here in practice (nothing unlatches it), but the
    // explicit local flag keeps this function's classification logic
    // independent of exactly when `userSignal` itself is inspected.
    let abortRequested = false;
    let escalationTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (escalationTimer) clearTimeout(escalationTimer);
      userSignal.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      abortRequested = true;
      escalationTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        logger.warn('Pulumi engine invocation did not exit within the escalation timeout — force-terminating', {
          escalationTimeoutMs,
        });
        options.onEscalate?.();
        reject(new PulumiOperationEscalatedError(escalationTimeoutMs));
      }, escalationTimeoutMs);
    };
    userSignal.addEventListener('abort', onAbort);

    const handleResolve = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const handleReject = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (abortRequested) {
        logger.warn('runWithEscalatingCancellation: Pulumi operation rejected after cancellation was requested', {
          error: err instanceof Error ? err.message : String(err),
        });
        reject(new PulumiOperationAbortedError(err));
      } else {
        reject(err);
      }
    };

    // `operation` is expected to return a promise, but a caller/underlying
    // SDK call could in principle throw synchronously before ever returning
    // one — guard against that so the abort listener is still cleaned up and
    // this function's own promise still settles, rather than leaving a
    // dangling listener and a permanently-pending outer promise.
    let operationPromise: Promise<T>;
    try {
      operationPromise = operation(userSignal);
    } catch (err) {
      handleReject(err);
      return;
    }
    operationPromise.then(handleResolve, handleReject);
  });
}
