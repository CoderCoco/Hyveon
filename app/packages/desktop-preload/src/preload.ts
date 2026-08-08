/**
 * Electron preload script.
 *
 * Runs in a sandboxed Node context before the renderer loads. Exposes a
 * typed `window.hyveon` bridge via `contextBridge` so the renderer can call
 * into the main process over IPC without any direct access to Node or
 * Electron internals.
 *
 * Channel naming convention: `<namespace>.<action>`
 *
 * ## Streaming channels and the contextBridge clone boundary
 *
 * `contextBridge.exposeInMainWorld` structured-clones every value crossing
 * the isolated-world boundary. Neither a raw `AsyncGenerator` nor a raw
 * `AbortSignal` survives that clone: a generator throws synchronously
 * (`Uncaught Error: An object could not be cloned.`) the instant a bridged
 * function returns one, and a signal arrives on the other side as an inert
 * object with no own keys (its `aborted` getter and `addEventListener`
 * method live on its prototype, which the clone drops). Every streaming
 * channel below is therefore split into two layers:
 *
 * - A **preload-internal** `async function*` (`streamLogs`,
 *   `streamStackInitialize`, `streamIacRunLogs`) that does the real IPC
 *   listener wiring and still accepts a real `AbortSignal` — this signal is
 *   always minted *inside* preload by a `bridgeStream` wrapper, so it never
 *   itself crosses the bridge.
 * - A thin **bridge-facing wrapper** (`openLogsStream`, `openStackInitializeStream`,
 *   `openIacRunLogsStream`) that mints an `AbortController`, calls the
 *   internal generator with its signal, and hands the renderer a
 *   {@link HyveonStreamHandle} — a plain object with an own `next()`, an own
 *   `cancel()`, and an own `[Symbol.asyncIterator]` returning itself. This
 *   shape was empirically verified to survive the clone boundary intact and
 *   remains directly usable in a renderer-side `for await` loop over the
 *   handle. `cancel()` aborts the wrapper's internal controller, driving the
 *   same cancellation path the internal generator already had.
 *
 * Log streaming: `openLogsStream(game)` invokes main to open a stream
 * (returning an opaque `streamId`), then wraps the per-stream
 * `logs.stream.<id>.chunk` / `.end` IPC events in an async generator.
 * Calling the returned handle's `cancel()` — or breaking out of the
 * `for await` loop — sends `logs.stream.<id>.cancel` to stop the main loop.
 *
 * `openStackInitializeStream()` streams similarly, replacing the deleted
 * `iac.init` channel, but `IacController.initializeStack`
 * pushes phase-event/end messages on fixed `iac.stack.initialize.chunk` /
 * `iac.stack.initialize.end` side channels shared by every call rather than
 * per-call channel names. `invoke('iac.stack.initialize')` resolves with a
 * `streamId` minted by the controller for this call, and every event on
 * those shared channels is tagged with the `streamId` of the call that
 * produced it — the generator ignores any message whose `streamId` doesn't
 * match its own, so a rejected concurrent call or a late message from an
 * abandoned stream can never resolve/terminate a different call's generator.
 * There is no dedicated cancel channel — `cancel()` simply stops the
 * generator from consuming further events, since the main process has
 * nothing to tear down early (`PulumiService.initializeStack` keeps running
 * to completion regardless).
 *
 * `iac.plan(opts)` is a plain `invoke` — unlike `iac.stack.initialize`, it
 * does not itself stream progress. It resolves the immediate `IacPlanAck`
 * `IacController.plan` returns: `{ started: true, runId }` once the run
 * has been kicked off in the background, or `{ started: false, error, conflict?, staleLock? }`
 * when the submission was rejected outright (e.g. the shared workspace was
 * already busy running another operation, or an unrecognized Pulumi backend
 * lock conflict was hit).
 *
 * `iac.runs.get(runId)` is a plain `invoke('iac.runs.get', { runId })`
 * call — it resolves a single `IacRunsGetResult` snapshot with no
 * streaming involved. `openIacRunLogsStream(runId)` mirrors
 * `openStackInitializeStream`'s fixed-side-channel streaming shape: `IacRunsController.logs`
 * pushes chunk/end messages on fixed `iac.runs.logs.chunk` /
 * `iac.runs.logs.end` side channels shared by every call, each tagged
 * with the `streamId` minted for that call, so overlapping subscriptions to
 * different runs' log output can never cross-terminate one another.
 *
 * `iac.runs.list(opts)` and `iac.runs.logUrl(logKey, expiresInSeconds)`
 * are further plain-invoke examples, backing the apply-history view: `list`
 * resolves a `RunHistoryPageResult` page of persisted run records, and
 * `logUrl` resolves a presigned URL for a run's offloaded log, unwrapped from
 * the IPC channel's `{ url }` result to a bare string.
 *
 * Note there is no streaming plumbing in this file for `iac.plan`/`iac.apply`/
 * `iac.destroy`'s `.chunk`/`.end` side channels — those channels exist on the
 * main-process side (carrying the structured `PulumiPreviewResult`/
 * `PulumiUpResult`/`PulumiDestroyResult`) but nothing here subscribes to
 * them; `iac.runs.get`/`iac.runs.list`'s `changeSummary`/`engineVersion`/
 * `partialApply` fields are the intended path to that same structured data
 * once a run has settled (see `IacRunRecord`/`RunHistoryRecord` in
 * `hyveon-api.ts`).
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

import type {
  CreateGamePayload,
  DeleteGamePayload,
  DeploymentSettingsGetResult,
  DeploymentSettingsWriteResult,
  HyveonApi,
  HyveonStreamHandle,
  HyveonTestApi,
  LogChunk,
  PulumiEngineVersionResult,
  IacApplyPayload,
  IacApproveAck,
  IacDestroyMintAck,
  IacDestroyPayload,
  IacLockClearAck,
  IacLockClearMintAck,
  IacLockClearPayload,
  IacPlanAck,
  IacPlanPayload,
  IacRollbackConfirmAck,
  IacRollbackResolveAck,
  IacRunChunk,
  IacRunsGetResult,
  IacRunsListOpts,
  RunHistoryPageResult,
  StackInitPhaseEvent,
  UpdateDeploymentSettingsPayload,
  UpdateGamePayload,
  AwsProfileSummary,
  SavePastedCredentialsInput,
  WizardState,
  SaveWizardStateInput,
  BootstrapStateBucketInput,
  BootstrapConfigurationBucketInput,
  BootstrapDeploymentConfigInput,
  BootstrapResult,
  IamCheckResult,
  WizardProgress,
  SaveWizardProgressInput,
  RenderedTemplateResult,
  OpenGuidedIamConsoleInput,
  OpenConsoleResult,
  BootstrapKeyIntakeInput,
  BootstrapKeyIntakeResult,
  RotationInput,
  RotationResult,
  RevokeBootstrapKeyInput,
  RevokeBootstrapKeyResult,
  RendererLogEntry,
} from './hyveon-api.js';
import type { StackOutputs } from '@hyveon/shared';

/** Fixed side-channel `IacController.initializeStack` pushes streamed phase events on. */
const STACK_INIT_CHUNK_CHANNEL = 'iac.stack.initialize.chunk';

/** Fixed side-channel `IacController.initializeStack` sends its terminal message on. */
const STACK_INIT_END_CHANNEL = 'iac.stack.initialize.end';

/** Fixed side-channel `IacRunsController.logs` pushes streamed run output on. */
const IAC_RUNS_LOGS_CHUNK_CHANNEL = 'iac.runs.logs.chunk';

/** Fixed side-channel `IacRunsController.logs` sends its terminal message on. */
const IAC_RUNS_LOGS_END_CHANNEL = 'iac.runs.logs.end';

/**
 * Per-channel mock registry populated by tests via `window.hyveon.__test.mock(channel, handler)`.
 * Each entry is a function (or a plain value) that replaces the real IPC call
 * for that channel.  A `() => value` handler is treated as the mock; a
 * non-function entry is wrapped so the resolver always returns that value.
 */
const mockRegistry: Map<string, (...args: unknown[]) => unknown> = new Map();

/**
 * Registers a mock for the given IPC channel.  If `handler` is not a
 * function it is wrapped in one so callers always receive a Promise.
 *
 * @param channel - IPC channel name, e.g. `'games.list'`.
 * @param handler - Replacement implementation or a plain return value.
 */
function registerMock(channel: string, handler: unknown): void {
  mockRegistry.set(channel, typeof handler === 'function' ? (handler as (...args: unknown[]) => unknown) : () => handler);
}

/**
 * Mock-aware `ipcRenderer.invoke` wrapper.  If a mock is registered for
 * the channel it is called with the supplied args and its return value
 * (synchronous or Promise) is awaited; otherwise the call is forwarded to
 * the real Electron IPC.
 *
 * @param channel - IPC channel name.
 * @param args    - Arguments forwarded to the handler or IPC channel.
 */
function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const mock = mockRegistry.get(channel);
  if (mock !== undefined) {
    try {
      return Promise.resolve(mock(...args)) as Promise<T>;
    } catch (err) {
      return Promise.reject(err) as Promise<T>;
    }
  }
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

/**
 * Preload-internal — never exposed to the renderer directly (see
 * {@link openLogsStream}, its bridge-facing wrapper). Bridges the per-stream
 * chunk/end/cancel IPC channels into an {@link AsyncIterable} of log chunks.
 *
 * When a mock is registered for the `'logs.stream'` channel (test mode only),
 * the mock handler is called with `(game, signal)` and its return value is
 * treated as an `AsyncIterable<LogChunk>` — the real IPC listener path is
 * never touched. The `signal` is forwarded to the mock so test code can honour
 * cancellation if needed.
 *
 * In production (no mock registered), opens the stream via
 * `ipcRenderer.invoke('logs.stream', game)`, buffers incoming chunks, and
 * yields them in order. Completes when the `.end` event fires (throwing if it
 * carried an `error`). If the consumer aborts the `signal` or breaks out of
 * the `for await` loop early, the `finally` block detaches all listeners and
 * sends `.cancel` so the main process tears the stream down.
 *
 * The listener-attach happens after the `invoke` resolves with the `streamId`,
 * which is the only point the chunk/end channel names are known — identical to
 * the prior callback implementation, so there is no new dropped-chunk window.
 */
async function* streamLogs(game: string, signal?: AbortSignal): AsyncGenerator<LogChunk> {
  const streamMock = mockRegistry.get('logs.stream');
  if (streamMock !== undefined) {
    const mockIterable = streamMock(game, signal) as AsyncIterable<LogChunk>;
    yield* mockIterable;
    return;
  }

  const { streamId } = (await invoke('logs.stream', game)) as { streamId: string };
  const chunkChannel = `logs.stream.${streamId}.chunk`;
  const endChannel = `logs.stream.${streamId}.end`;
  const sendCancel = () => ipcRenderer.send(`logs.stream.${streamId}.cancel`);

  /** Chunks received but not yet yielded. */
  const buffer: LogChunk[] = [];
  let ended = false;
  let endError: string | undefined;
  /** Resolves the pending `await` when a chunk arrives or the stream ends. */
  let wake: (() => void) | null = null;
  const signalWake = () => {
    if (wake) {
      const fn = wake;
      wake = null;
      fn();
    }
  };

  const onChunk = (_evt: IpcRendererEvent, chunk: LogChunk) => {
    buffer.push(chunk);
    signalWake();
  };
  const onEnd = (_evt: IpcRendererEvent, data: { error?: string }) => {
    ended = true;
    endError = data?.error;
    signalWake();
  };
  const onAbort = () => sendCancel();

  ipcRenderer.on(chunkChannel, onChunk);
  ipcRenderer.once(endChannel, onEnd);
  if (signal) {
    if (signal.aborted) sendCancel();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      while (buffer.length > 0) {
        yield buffer.shift()!;
      }
      if (ended) {
        if (endError) throw new Error(endError);
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    ipcRenderer.removeListener(chunkChannel, onChunk);
    ipcRenderer.removeListener(endChannel, onEnd);
    signal?.removeEventListener('abort', onAbort);
    // Consumer left before the stream ended (early break/return or abort) —
    // tell the main process to stop tailing so it doesn't leak the loop.
    if (!ended) sendCancel();
  }
}

/**
 * Preload-internal — never exposed to the renderer directly (see
 * {@link openStackInitializeStream}, its bridge-facing wrapper). Bridges
 * `IacController.initializeStack`'s fixed `iac.stack.initialize.chunk` /
 * `iac.stack.initialize.end` side channels into an {@link AsyncIterable} of
 * {@link StackInitPhaseEvent}.
 *
 * `IacController.initializeStack` pushes phase-event/end messages on these
 * two fixed channel names for *every* call (rather than minting per-call
 * channel names the way `streamLogs` does), but tags each payload with the
 * `streamId` it minted for this call and returned in the invoke ack
 * (`{ started, streamId, error? }`). Events whose `streamId` doesn't match
 * this call's own `streamId` are ignored — this is what stops a second,
 * rejected concurrent `iac.stack.initialize` call from broadcasting an end
 * event that would otherwise prematurely terminate this caller's stream.
 * (Replaces the deleted `iac.init` streaming helper, which used this
 * exact same fixed-side-channel-plus-streamId shape.)
 *
 * When a mock is registered for the `'iac.stack.initialize'` channel (test
 * mode only), the mock handler is called with `(signal)` and its return
 * value is treated as an `AsyncIterable<StackInitPhaseEvent>` — the real IPC
 * listener path is never touched.
 *
 * In production (no mock registered), the `iac.stack.initialize.chunk` /
 * `iac.stack.initialize.end` listeners are attached **before**
 * `ipcRenderer.invoke('iac.stack.initialize')` is called, so no event sent
 * immediately after the main process acknowledges the call can ever be
 * dropped. Since this call's own `streamId` isn't known until the invoke
 * resolves, events observed before then are held in a raw buffer and
 * replayed (filtered by the now-known `streamId`) once the ack arrives. The
 * invoke call resolves with `{ started, streamId?, error?, conflict? }`: a
 * `false` `started` value means the shared workspace was already busy (see
 * `StackInitializeAck.conflict` in `iac.controller.ts`) and no run was ever
 * attempted — no chunk/end messages will ever arrive, so the generator
 * throws right away using `error` (and cleans up the now-unused listeners in
 * `finally`). When `started` is `true`, events tagged with this call's
 * `streamId` are buffered as they arrive on `iac.stack.initialize.chunk` and
 * yielded in order; the generator completes when an
 * `iac.stack.initialize.end` event tagged with this call's `streamId` fires
 * with no `error`, or throws using its `error` field otherwise.
 *
 * Following the `logs.stream` pattern, an optional `signal` may be supplied to
 * cancel consumption early: aborting (or breaking out of the `for await`
 * loop) stops the wait loop and the `finally` block detaches the listeners.
 * There is no per-run cancel side channel to notify the main process — the
 * run itself (`PulumiService.initializeStack`) keeps running to completion in
 * the background, but the generator stops yielding further events to the
 * caller.
 */
async function* streamStackInitialize(signal?: AbortSignal): AsyncGenerator<StackInitPhaseEvent> {
  const initMock = mockRegistry.get('iac.stack.initialize');
  if (initMock !== undefined) {
    const mockIterable = initMock(signal) as AsyncIterable<StackInitPhaseEvent>;
    yield* mockIterable;
    return;
  }

  /** Events received but not yet yielded. */
  const buffer: StackInitPhaseEvent[] = [];
  let ended = false;
  let endError: string | undefined;
  let aborted = false;
  /**
   * This call's own `streamId`, known only once the `iac.stack.initialize`
   * invoke resolves. `null` until then, at which point every raw chunk/end
   * event buffered so far is replayed through the `streamId` filter below.
   */
  let ownStreamId: string | null = null;
  /** Chunk events observed before `ownStreamId` is known. */
  const rawChunkBuffer: Array<{ streamId: string; phase: StackInitPhaseEvent['phase']; status: StackInitPhaseEvent['status'] }> = [];
  /** End events observed before `ownStreamId` is known. */
  const rawEndBuffer: Array<{ streamId: string; error?: string }> = [];
  /** Resolves the pending `await` when an event arrives, the stream ends, or the signal aborts. */
  let wake: (() => void) | null = null;
  const signalWake = () => {
    if (wake) {
      const fn = wake;
      wake = null;
      fn();
    }
  };

  /** Applies a phase-event, discarding it if it belongs to a different `iac.stack.initialize` call. */
  const applyChunk = (data: { streamId: string; phase: StackInitPhaseEvent['phase']; status: StackInitPhaseEvent['status'] }) => {
    if (data.streamId !== ownStreamId) return;
    buffer.push({ phase: data.phase, status: data.status });
    signalWake();
  };
  /** Applies an end event, discarding it if it belongs to a different `iac.stack.initialize` call. */
  const applyEnd = (data: { streamId: string; error?: string }) => {
    if (data.streamId !== ownStreamId) return;
    ended = true;
    endError = data.error;
    signalWake();
  };

  const onChunk = (
    _evt: IpcRendererEvent,
    data: { streamId: string; phase: StackInitPhaseEvent['phase']; status: StackInitPhaseEvent['status'] },
  ) => {
    if (ownStreamId === null) {
      rawChunkBuffer.push(data);
      return;
    }
    applyChunk(data);
  };
  const onEnd = (_evt: IpcRendererEvent, data: { streamId: string; error?: string }) => {
    if (ownStreamId === null) {
      rawEndBuffer.push(data);
      return;
    }
    applyEnd(data);
  };
  const onAbort = () => {
    aborted = true;
    signalWake();
  };

  // Attach both listeners before invoking so no early event sent right after
  // the main process acknowledges the call is ever dropped — unlike
  // `streamLogs`, the channel names here are fixed constants known up front,
  // so there is no need to wait for the invoke response first. `onEnd` can no
  // longer use `ipcRenderer.once`: a rejected concurrent call's end event
  // (tagged with a foreign `streamId`) could arrive on this same fixed
  // channel before our own, and a `once` listener would consume and discard
  // it, missing our own end event entirely.
  ipcRenderer.on(STACK_INIT_CHUNK_CHANNEL, onChunk);
  ipcRenderer.on(STACK_INIT_END_CHANNEL, onEnd);
  if (signal) {
    if (signal.aborted) aborted = true;
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    if (aborted) return;

    const ack = (await invoke('iac.stack.initialize')) as { started: boolean; streamId?: string; error?: string };
    if (!ack.started || !ack.streamId) {
      throw new Error(ack.error ?? 'iac.stack.initialize failed to start');
    }
    ownStreamId = ack.streamId;

    // Replay anything observed before we knew our own streamId, filtering
    // out events tagged with a different (foreign, overlapping) run.
    for (const data of rawChunkBuffer) applyChunk(data);
    rawChunkBuffer.length = 0;
    for (const data of rawEndBuffer) applyEnd(data);
    rawEndBuffer.length = 0;

    while (true) {
      while (buffer.length > 0) {
        if (aborted) return;
        yield buffer.shift()!;
      }
      if (aborted) return;
      if (ended) {
        if (endError) throw new Error(endError);
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    ipcRenderer.removeListener(STACK_INIT_CHUNK_CHANNEL, onChunk);
    ipcRenderer.removeListener(STACK_INIT_END_CHANNEL, onEnd);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Preload-internal — never exposed to the renderer directly (see
 * {@link openIacRunLogsStream}, its bridge-facing wrapper). Bridges
 * `IacRunsController.logs`'s fixed `iac.runs.logs.chunk` /
 * `iac.runs.logs.end` side channels into an {@link AsyncIterable} of
 * {@link IacRunChunk} for a single run identified by `runId`.
 *
 * Mirrors {@link streamStackInitialize}'s streaming shape: `IacRunsController.logs`
 * tags every chunk/end payload with the `streamId` it minted for this call and
 * returned in the invoke ack (`{ streamId }`), so events from an overlapping
 * subscription to a *different* run's log stream (which share the same fixed
 * channel names) are filtered out and can never cross-terminate this stream.
 *
 * When a mock is registered for the `'iac.runs.logs'` channel (test mode
 * only), the mock handler is called with `(runId, signal)` and its return
 * value is treated as an `AsyncIterable<IacRunChunk>` — the real IPC
 * listener path is never touched.
 *
 * In production (no mock registered), the `iac.runs.logs.chunk` /
 * `iac.runs.logs.end` listeners are attached **before**
 * `ipcRenderer.invoke('iac.runs.logs', { runId })` is called, so no
 * chunk sent immediately after the main process acknowledges the call can
 * ever be dropped. Since this call's own `streamId` isn't known until the
 * invoke resolves, events observed before then are held in a raw buffer and
 * replayed (filtered by the now-known `streamId`) once the ack arrives.
 * Chunks tagged with this call's `streamId` are buffered as they arrive and
 * yielded in order; the generator completes when an `iac.runs.logs.end`
 * event tagged with this call's `streamId` fires with no `error`, or throws
 * using its `error` field otherwise.
 *
 * Following the `logs.stream`/`iac.stack.initialize` pattern, an optional
 * `signal` may be supplied to stop consumption early: aborting (or breaking out of the
 * `for await` loop) stops the wait loop and the `finally` block detaches the
 * listeners. There is no per-run cancel side channel — the run itself (and
 * its log tailing in the main process) keeps going in the background; only
 * this caller's consumption stops.
 */
async function* streamIacRunLogs(runId: string, signal?: AbortSignal): AsyncGenerator<IacRunChunk> {
  const logsMock = mockRegistry.get('iac.runs.logs');
  if (logsMock !== undefined) {
    const mockIterable = logsMock(runId, signal) as AsyncIterable<IacRunChunk>;
    yield* mockIterable;
    return;
  }

  /** Chunks received but not yet yielded. */
  const buffer: IacRunChunk[] = [];
  let ended = false;
  let endError: string | undefined;
  let aborted = false;
  /**
   * This call's own `streamId`, known only once the `iac.runs.logs`
   * invoke resolves. `null` until then, at which point every raw chunk/end
   * event buffered so far is replayed through the `streamId` filter below.
   */
  let ownStreamId: string | null = null;
  /** Chunk events observed before `ownStreamId` is known. */
  const rawChunkBuffer: Array<{ streamId: string; chunk: IacRunChunk }> = [];
  /** End events observed before `ownStreamId` is known. */
  const rawEndBuffer: Array<{ streamId: string; error?: string }> = [];
  /** Resolves the pending `await` when a chunk arrives, the stream ends, or the signal aborts. */
  let wake: (() => void) | null = null;
  const signalWake = () => {
    if (wake) {
      const fn = wake;
      wake = null;
      fn();
    }
  };

  /** Applies a chunk event, discarding it if it belongs to a different run's log subscription. */
  const applyChunk = (data: { streamId: string; chunk: IacRunChunk }) => {
    if (data.streamId !== ownStreamId) return;
    buffer.push(data.chunk);
    signalWake();
  };
  /** Applies an end event, discarding it if it belongs to a different run's log subscription. */
  const applyEnd = (data: { streamId: string; error?: string }) => {
    if (data.streamId !== ownStreamId) return;
    ended = true;
    endError = data.error;
    signalWake();
  };

  const onChunk = (_evt: IpcRendererEvent, data: { streamId: string; chunk: IacRunChunk }) => {
    if (ownStreamId === null) {
      rawChunkBuffer.push(data);
      return;
    }
    applyChunk(data);
  };
  const onEnd = (_evt: IpcRendererEvent, data: { streamId: string; error?: string }) => {
    if (ownStreamId === null) {
      rawEndBuffer.push(data);
      return;
    }
    applyEnd(data);
  };
  const onAbort = () => {
    aborted = true;
    signalWake();
  };

  // Attach both listeners before invoking so no early event sent right after
  // the main process acknowledges the call is ever dropped — the channel
  // names here are fixed constants known up front, so there is no need to
  // wait for the invoke response first. `onEnd` uses `ipcRenderer.on` (not
  // `.once`): a subscription to a different run's log stream could deliver
  // its end event on this same fixed channel before our own, and a `once`
  // listener would consume and discard it, missing our own end event
  // entirely.
  ipcRenderer.on(IAC_RUNS_LOGS_CHUNK_CHANNEL, onChunk);
  ipcRenderer.on(IAC_RUNS_LOGS_END_CHANNEL, onEnd);
  if (signal) {
    if (signal.aborted) aborted = true;
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    if (aborted) return;

    const ack = (await invoke('iac.runs.logs', { runId })) as { streamId: string };
    ownStreamId = ack.streamId;

    // Replay anything observed before we knew our own streamId, filtering
    // out events tagged with a different (foreign, overlapping) run.
    for (const data of rawChunkBuffer) applyChunk(data);
    rawChunkBuffer.length = 0;
    for (const data of rawEndBuffer) applyEnd(data);
    rawEndBuffer.length = 0;

    while (true) {
      while (buffer.length > 0) {
        if (aborted) return;
        yield buffer.shift()!;
      }
      if (aborted) return;
      if (ended) {
        if (endError) throw new Error(endError);
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    ipcRenderer.removeListener(IAC_RUNS_LOGS_CHUNK_CHANNEL, onChunk);
    ipcRenderer.removeListener(IAC_RUNS_LOGS_END_CHANNEL, onEnd);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Wraps a preload-internal `AsyncGenerator` in a plain, contextBridge-safe
 * {@link HyveonStreamHandle} — see the module doc comment's "Streaming
 * channels and the contextBridge clone boundary" section for why a raw
 * `AsyncGenerator` can't be returned to the renderer directly.
 *
 * `next()` delegates straight to `source.next()`. `cancel()` aborts
 * `controller`, which is the same (real, preload-internal-only)
 * `AbortSignal` source `source` was created with — from `source`'s own
 * perspective this is indistinguishable from the renderer aborting a signal
 * it had been handed directly, so none of the three generators' existing
 * `signal.aborted` / `signal.addEventListener('abort', …)` cancellation
 * logic needed to change.
 *
 * @param source - The preload-internal async generator to wrap.
 * @param controller - The `AbortController` `source` was invoked with; never exposed to the renderer.
 */
function bridgeStream<T>(source: AsyncGenerator<T>, controller: AbortController): HyveonStreamHandle<T> {
  const handle: HyveonStreamHandle<T> = {
    next: () => source.next(),
    cancel: () => controller.abort(),
    [Symbol.asyncIterator]: () => handle,
  };
  return handle;
}

/**
 * Bridge-facing wrapper for {@link streamLogs}. Mints an `AbortController`
 * that never leaves preload and returns a {@link HyveonStreamHandle} in
 * place of the raw async generator — see {@link bridgeStream}.
 */
function openLogsStream(game: string): HyveonStreamHandle<LogChunk> {
  const controller = new AbortController();
  return bridgeStream(streamLogs(game, controller.signal), controller);
}

/**
 * Bridge-facing wrapper for {@link streamStackInitialize}. Mints an
 * `AbortController` that never leaves preload and returns a
 * {@link HyveonStreamHandle} in place of the raw async generator — see
 * {@link bridgeStream}.
 */
function openStackInitializeStream(): HyveonStreamHandle<StackInitPhaseEvent> {
  const controller = new AbortController();
  return bridgeStream(streamStackInitialize(controller.signal), controller);
}

/**
 * Bridge-facing wrapper for {@link streamIacRunLogs}. Mints an
 * `AbortController` that never leaves preload and returns a
 * {@link HyveonStreamHandle} in place of the raw async generator — see
 * {@link bridgeStream}.
 */
function openIacRunLogsStream(runId: string): HyveonStreamHandle<IacRunChunk> {
  const controller = new AbortController();
  return bridgeStream(streamIacRunLogs(runId, controller.signal), controller);
}

const api: HyveonApi = {
  games: {
    list: () => invoke('games.list'),
    status: () => invoke('games.status'),
    getStatus: (game: string) => invoke('games.getStatus', game),
    start: (game: string) => invoke('games.start', game),
    stop: (game: string) => invoke('games.stop', game),
    // Transport note: `nestjs-electron-ipc-transport` only delivers the first
    // argument to `@Payload`, so each write op passes a single payload object
    // rather than separate positional arguments.
    create: (payload: CreateGamePayload) => invoke('games.create', payload),
    update: (payload: UpdateGamePayload) => invoke('games.update', payload),
    delete: (payload: DeleteGamePayload) => invoke('games.delete', payload),
  },

  costs: {
    estimate: () => invoke('costs.estimate'),
  },

  logs: {
    get: (game: string, limit?: number) => invoke('logs.get', { game, limit }),
    stream: openLogsStream,
  },

  files: {
    list: (game: string) => invoke('files.list', game),
    start: (game: string) => invoke('files.start', game),
    stop: (game: string) => invoke('files.stop', game),
  },

  discord: {
    getConfig: () => invoke('discord.getConfig'),
    putConfig: (body: { botToken?: string; clientId?: string; publicKey?: string }) =>
      invoke('discord.putConfig', body),
    listGuilds: () => invoke('discord.listGuilds'),
    addGuild: (guildId: string) => invoke('discord.addGuild', { guildId }),
    removeGuild: (guildId: string) => invoke('discord.removeGuild', guildId),
    registerCommands: (guildId: string) => invoke('discord.registerCommands', guildId),
    getAdmins: () => invoke('discord.getAdmins'),
    putAdmins: (body: { userIds?: string[]; roleIds?: string[] }) =>
      invoke('discord.putAdmins', body),
    getPermissions: () => invoke('discord.getPermissions'),
    putPermission: (
      game: string,
      body: { userIds?: string[]; roleIds?: string[]; actions?: string[] },
    ) => invoke('discord.putPermission', { game, body }),
    deletePermission: (game: string) => invoke('discord.deletePermission', game),
  },

  env: {
    get: () => invoke('env.get'),
  },

  wizard: {
    listAwsProfiles: () => invoke<AwsProfileSummary[]>('wizard.aws.listProfiles'),
    saveCredentials: (input: SavePastedCredentialsInput) =>
      invoke<{ profileName: string }>('wizard.aws.saveCredentials', input),
    getState: () => invoke<WizardState>('wizard.state.get'),
    saveState: (input: SaveWizardStateInput) => invoke<WizardState>('wizard.state.save', input),
    bootstrapStateBucket: (input: BootstrapStateBucketInput) =>
      invoke<BootstrapResult>('wizard.bootstrap.stateBucket', input),
    bootstrapConfigurationBucket: (input: BootstrapConfigurationBucketInput) =>
      invoke<BootstrapResult>('wizard.bootstrap.configurationBucket', input),
    bootstrapDeploymentConfig: (input: BootstrapDeploymentConfigInput) =>
      invoke<BootstrapResult>('wizard.bootstrap.deploymentConfig', input),
    bootstrapRunsTable: () => invoke<BootstrapResult>('wizard.bootstrap.runsTable'),
    simulateIamPermissions: () => invoke<IamCheckResult>('wizard.iam.simulate'),
    getProgress: () => invoke<WizardProgress>('wizard.progress.get'),
    saveProgress: (input: SaveWizardProgressInput) => invoke<void>('wizard.progress.save', input),
    complete: () => invoke<WizardState>('wizard.complete'),
    reset: () => invoke<WizardState>('wizard.reset'),
    guidedIamPrepareTemplate: () => invoke<RenderedTemplateResult>('wizard.guidedIam.prepareTemplate'),
    guidedIamOpenConsole: (input: OpenGuidedIamConsoleInput) =>
      invoke<OpenConsoleResult>('wizard.guidedIam.openConsole', input),
    guidedIamSubmitBootstrapKey: (input: BootstrapKeyIntakeInput) =>
      invoke<BootstrapKeyIntakeResult>('wizard.guidedIam.submitBootstrapKey', input),
    guidedIamRotate: (input: RotationInput) => invoke<RotationResult>('wizard.guidedIam.rotate', input),
    guidedIamRevokeBootstrapKey: (input: RevokeBootstrapKeyInput) =>
      invoke<RevokeBootstrapKeyResult>('wizard.guidedIam.revokeBootstrapKey', input),
  },

  drift: {
    get: () => invoke('drift.get'),
  },

  diagnostics: {
    tail: () => invoke('diagnostics.tail'),
    path: () => invoke('diagnostics.path'),
    reportError: (message: string, stack: string | undefined, source: 'boundary' | 'window-error' | 'unhandled-rejection') =>
      invoke('diagnostics.reportError', { message, stack, source }),
    reportLog: (entries: RendererLogEntry[], droppedCount?: number) =>
      invoke('diagnostics.reportLog', { entries, droppedCount }),
  },

  audit: {
    list: (opts?: { limit?: number; before?: string }) => invoke('audit.list', opts),
  },

  iac: {
    stack: {
      initialize: openStackInitializeStream,
    },
    plan: (opts?: IacPlanPayload) => invoke<IacPlanAck>('iac.plan', opts),
    approve: (opts: { planRunId: string }) => invoke<IacApproveAck>('iac.approve', opts),
    apply: (payload: IacApplyPayload) => invoke<IacPlanAck>('iac.apply', payload),
    mintDestroyToken: () => invoke<IacDestroyMintAck>('iac.destroy.mintToken'),
    destroy: (payload: IacDestroyPayload) => invoke<IacPlanAck>('iac.destroy', payload),
    output: (force?: boolean) => invoke<StackOutputs | null>('iac.output', { force }),
    runs: {
      get: (runId: string) => invoke<IacRunsGetResult>('iac.runs.get', { runId }),
      streamLogs: openIacRunLogsStream,
      list: (opts?: IacRunsListOpts) => invoke<RunHistoryPageResult>('iac.runs.list', opts),
      logUrl: (logKey: string, expiresInSeconds?: number) =>
        invoke<{ url: string }>('iac.runs.logUrl', { logKey, expiresInSeconds }).then((r) => r.url),
    },
    rollback: {
      resolve: (opts: { applyRunId: string }) =>
        invoke<IacRollbackResolveAck>('iac.rollback.resolve', opts),
      confirm: (opts: { applyRunId: string }) =>
        invoke<IacRollbackConfirmAck>('iac.rollback.confirm', opts),
    },
    lock: {
      mintToken: () => invoke<IacLockClearMintAck>('iac.lock.clear.mintToken'),
      clear: (payload: IacLockClearPayload) => invoke<IacLockClearAck>('iac.lock.clear', payload),
    },
    settings: {
      get: () => invoke<DeploymentSettingsGetResult>('iac.settings.get'),
      update: (payload: UpdateDeploymentSettingsPayload) =>
        invoke<DeploymentSettingsWriteResult>('iac.settings.update', payload),
      engineVersion: () => invoke<PulumiEngineVersionResult>('iac.settings.engineVersion'),
    },
  },
};

/**
 * Returns `true` when this process was started in test mode by the integration
 * test harness (`HYVEON_TEST_MODE=1`).  Extracted as a function so tests can
 * stub the env read via `vi.spyOn` instead of mutating `process.env` directly.
 */
export function isTestModeEnabled(): boolean {
  return process.env['HYVEON_TEST_MODE'] === '1';
}

/** Whether this process was started in test mode by the integration test harness. */
const isTestMode = isTestModeEnabled();

const hyveonBridge: HyveonApi & { __test?: HyveonTestApi } = { ...api };

if (isTestMode) {
  /**
   * Test-only injection surface, present only when `HYVEON_TEST_MODE=1`.
   *
   * Exposes `mock(channel, handler)` so Playwright / Vitest can register
   * per-channel IPC overrides without touching the real Electron IPC layer.
   * `clearMocks` and `reset` both clear the registry so state does not leak
   * between test cases (mirror the {@link HyveonTestApi} contract).
   */
  hyveonBridge.__test = {
    mock: registerMock,
    /** Clears all registered mock handlers from the registry. */
    clearMocks: () => mockRegistry.clear(),
    /** Alias for {@link clearMocks} — symmetry with `vi.resetAllMocks()`. */
    reset: () => mockRegistry.clear(),
  };
}

contextBridge.exposeInMainWorld('hyveon', hyveonBridge);
