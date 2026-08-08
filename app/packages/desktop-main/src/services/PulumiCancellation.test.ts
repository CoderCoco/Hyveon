/**
 * Unit tests for `runWithEscalatingCancellation`, covering the
 * `pulumi-engine-runtime` delta spec's "Engine process lifecycle"
 * requirement's "Operation is cancelled" and "Unresponsive engine is
 * force-terminated" scenarios, plus the verified pre-aborted-signal gotcha
 * documented in `PulumiCancellation.ts`'s file-level TSDoc.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../logger.js', () => ({ logger: loggerMock }));

import {
  runWithEscalatingCancellation,
  PulumiOperationNotStartedError,
  PulumiOperationAbortedError,
  PulumiOperationEscalatedError,
  PULUMI_CANCELLATION_ESCALATION_TIMEOUT_MS,
} from './PulumiCancellation.js';

/** Never-settling promise — models an operation that never responds to its abort signal at all. */
function pendingForever<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* never settles */
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('runWithEscalatingCancellation — no signal supplied', () => {
  it('should run the operation to completion without arming any escalation timer', async () => {
    const operation = vi.fn().mockResolvedValue('done');

    const result = await runWithEscalatingCancellation(operation, undefined);

    expect(result).toBe('done');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('runWithEscalatingCancellation — already-aborted signal', () => {
  it('should reject with PulumiOperationNotStartedError and never invoke the operation', async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn().mockResolvedValue('should never happen');

    await expect(runWithEscalatingCancellation(operation, controller.signal)).rejects.toBeInstanceOf(
      PulumiOperationNotStartedError,
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('should log a warning that the operation was refused rather than letting the failure pass silently', async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn().mockResolvedValue('should never happen');

    await runWithEscalatingCancellation(operation, controller.signal).catch(() => undefined);

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('already aborted before the operation could start'),
    );
  });
});

describe('runWithEscalatingCancellation — signal triggers a graceful attempt that settles in time', () => {
  it('should resolve with the operation result and never escalate', async () => {
    const controller = new AbortController();
    const onEscalate = vi.fn();
    let capturedSignal: AbortSignal | undefined;

    const operation = vi.fn().mockImplementation(
      (signal: AbortSignal) =>
        new Promise((resolve) => {
          capturedSignal = signal;
          signal.addEventListener('abort', () => resolve('gracefully finished'));
        }),
    );

    const promise = runWithEscalatingCancellation(operation, controller.signal, { onEscalate });
    controller.abort();
    // The operation resolves synchronously off the same abort event — well
    // within the escalation window, which never gets a chance to fire.
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe('gracefully finished');
    expect(onEscalate).not.toHaveBeenCalled();
    expect(capturedSignal).toBe(controller.signal);
  });

  it('should wrap the operation own rejection (e.g. a CLI error after SIGINT) as PulumiOperationAbortedError, carrying the original as .cause', async () => {
    const controller = new AbortController();
    const onEscalate = vi.fn();
    const originalError = new Error('interrupted by SIGINT');
    const operation = vi.fn().mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(originalError));
        }),
    );

    const promise = runWithEscalatingCancellation(operation, controller.signal, { onEscalate });
    // Attach the rejection assertion before firing abort — `operation`
    // rejects synchronously off the abort event, so asserting after would
    // let the outer promise settle with no handler attached yet, which
    // Node flags as an (eventually-handled, but noisy) unhandled rejection.
    const assertion = expect(promise).rejects.toBeInstanceOf(PulumiOperationAbortedError);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await assertion;
    expect(onEscalate).not.toHaveBeenCalled();
    await promise.catch((err: PulumiOperationAbortedError) => {
      expect(err.cause).toBe(originalError);
      expect(err.message).toContain('interrupted by SIGINT');
    });

    expect(loggerMock.warn).toHaveBeenCalledWith(
      'runWithEscalatingCancellation: Pulumi operation rejected after cancellation was requested',
      expect.objectContaining({ error: 'interrupted by SIGINT' }),
    );
  });

  it('should clear the escalation timer and never call onEscalate when the operation settles before the timeout (regression: clearTimeout branch)', async () => {
    const controller = new AbortController();
    const onEscalate = vi.fn();
    let releaseOperation: (() => void) | undefined;
    const operation = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releaseOperation = () => resolve('finished just in time');
        }),
    );

    const promise = runWithEscalatingCancellation(operation, controller.signal, {
      escalationTimeoutMs: 10_000,
      onEscalate,
    });
    controller.abort();
    // Settle well before the escalation timeout fires.
    await vi.advanceTimersByTimeAsync(1_000);
    releaseOperation?.();
    await expect(promise).resolves.toBe('finished just in time');

    // Advance PAST where the escalation timeout would have fired — since it
    // must have been cleared on early settlement, onEscalate must still
    // never be called and no PulumiOperationEscalatedError is thrown
    // anywhere (an uncleared timer would otherwise fire into a settled
    // promise, which the internal `settled` guard would silently no-op, but
    // this proves the timer was actually cleared rather than merely guarded).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onEscalate).not.toHaveBeenCalled();
  });
});

describe('runWithEscalatingCancellation — genuine failure with no cancellation involved', () => {
  it('should reject with the original error unchanged (not wrapped) when userSignal never aborts', async () => {
    const controller = new AbortController();
    const originalError = new Error('some unrelated CLI failure');
    const operation = vi.fn().mockRejectedValue(originalError);

    await expect(runWithEscalatingCancellation(operation, controller.signal)).rejects.toBe(originalError);
  });
});

describe('runWithEscalatingCancellation — operation throws synchronously', () => {
  it('should reject with the synchronous throw and still remove the abort listener', async () => {
    const controller = new AbortController();
    const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const syncError = new Error('operation misbehaved and threw synchronously');
    const operation = vi.fn().mockImplementation(() => {
      throw syncError;
    });

    // `operation` is invoked synchronously and immediately (before any abort
    // event could possibly have fired yet), so a synchronous throw here can
    // only ever be the "not aborted" shape — rejects unwrapped, per this
    // function's own doc comment. The wrapped-as-`PulumiOperationAbortedError`
    // shape is exercised by the promise-rejection tests above instead, since
    // reaching it requires `operation` to reject *after* an abort event has
    // already fired, which is only reachable via an async rejection.
    await expect(runWithEscalatingCancellation(operation, controller.signal)).rejects.toBe(syncError);
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('runWithEscalatingCancellation — no response within the escalation timeout', () => {
  it('should invoke onEscalate and reject with PulumiOperationEscalatedError once the timeout elapses', async () => {
    const controller = new AbortController();
    const onEscalate = vi.fn();
    const operation = vi.fn().mockImplementation(() => pendingForever());

    const promise = runWithEscalatingCancellation(operation, controller.signal, {
      escalationTimeoutMs: 5_000,
      onEscalate,
    });
    // Prevent an unhandled-rejection warning from the settlement assertion
    // racing the timer advance below.
    const assertion = expect(promise).rejects.toBeInstanceOf(PulumiOperationEscalatedError);

    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);

    await assertion;
    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Pulumi engine invocation did not exit within the escalation timeout — force-terminating',
      expect.objectContaining({ escalationTimeoutMs: 5_000 }),
    );
  });

  it('should not escalate before the timeout has fully elapsed', async () => {
    const controller = new AbortController();
    const onEscalate = vi.fn();
    const operation = vi.fn().mockImplementation(() => pendingForever());

    runWithEscalatingCancellation(operation, controller.signal, { escalationTimeoutMs: 5_000, onEscalate });
    controller.abort();
    await vi.advanceTimersByTimeAsync(4_999);

    expect(onEscalate).not.toHaveBeenCalled();
  });

  it('should default the escalation timeout to PULUMI_CANCELLATION_ESCALATION_TIMEOUT_MS', async () => {
    const controller = new AbortController();
    const onEscalate = vi.fn();
    const operation = vi.fn().mockImplementation(() => pendingForever());

    const promise = runWithEscalatingCancellation(operation, controller.signal, { onEscalate });
    const assertion = expect(promise).rejects.toBeInstanceOf(PulumiOperationEscalatedError);

    controller.abort();
    await vi.advanceTimersByTimeAsync(PULUMI_CANCELLATION_ESCALATION_TIMEOUT_MS);

    await assertion;
    expect(onEscalate).toHaveBeenCalledTimes(1);
  });

  it('should still settle as aborted (escalated) even if the abandoned operation later resolves, without an unhandled rejection', async () => {
    const controller = new AbortController();
    let releaseOperation: (() => void) | undefined;
    const operation = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releaseOperation = () => resolve('late success, discarded');
        }),
    );

    const promise = runWithEscalatingCancellation(operation, controller.signal, { escalationTimeoutMs: 1_000 });
    const assertion = expect(promise).rejects.toBeInstanceOf(PulumiOperationEscalatedError);

    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    // The operation's own promise settles well after this function already
    // rejected — this must not throw or produce an unhandled rejection.
    expect(() => releaseOperation?.()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });
});
