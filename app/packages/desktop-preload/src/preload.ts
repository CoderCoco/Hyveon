/**
 * Electron preload script.
 *
 * Runs in a sandboxed Node context before the renderer loads. Exposes a
 * typed `window.gsd` bridge via `contextBridge` so the renderer can call
 * into the main process over IPC without any direct access to Node or
 * Electron internals.
 *
 * Channel naming convention: `<namespace>.<action>`
 *
 * Log streaming exposes a single async iterable: `logs.stream(game, signal)`
 * invokes main to open a stream (returning an opaque `streamId`), then wraps
 * the per-stream `logs.stream.<id>.chunk` / `.end` IPC events in an async
 * generator. Aborting the supplied `AbortSignal` — or breaking out of the
 * `for await` loop — sends `logs.stream.<id>.cancel` to stop the main loop.
 *
 * `terraform.init(config, signal)` streams similarly, but since only one
 * `terraform init` run is ever in flight at a time, it wraps the fixed
 * `terraform.init.chunk` / `terraform.init.end` side channels directly rather
 * than minting a per-call stream id. There is no dedicated cancel channel —
 * aborting simply stops the generator from consuming further chunks, since
 * `TerraformService.init` only ever allows one run in flight at a time and the
 * main process has nothing to tear down early.
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

import type {
  CreateGamePayload,
  DeleteGamePayload,
  GsdApi,
  GsdTestApi,
  LogChunk,
  TerraformInitConfig,
  TerraformRunChunk,
  UpdateGamePayload,
} from './gsd-api.js';

/** Fixed side-channel `TerraformController.init` pushes streamed output on. */
const TERRAFORM_INIT_CHUNK_CHANNEL = 'terraform.init.chunk';

/** Fixed side-channel `TerraformController.init` sends its terminal message on. */
const TERRAFORM_INIT_END_CHANNEL = 'terraform.init.end';

/**
 * Per-channel mock registry populated by tests via `window.gsd.__test.mock(channel, handler)`.
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
 * Bridges the per-stream chunk/end/cancel IPC channels into an
 * {@link AsyncIterable} of log chunks.
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
async function* streamLogs(game: string, signal?: AbortSignal): AsyncIterable<LogChunk> {
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
 * Bridges `TerraformController.init`'s fixed `terraform.init.chunk` /
 * `terraform.init.end` side channels into an {@link AsyncIterable} of
 * {@link TerraformRunChunk}.
 *
 * Unlike `streamLogs`, `TerraformService.init` only ever allows a single run
 * in flight at a time, so `TerraformController.init` always pushes chunks on
 * the same fixed channel names rather than minting a per-call `streamId` —
 * there is nothing to key listeners on beyond the two constants above.
 *
 * When a mock is registered for the `'terraform.init'` channel (test mode
 * only), the mock handler is called with `(config)` and its return value is
 * treated as an `AsyncIterable<TerraformRunChunk>` — the real IPC listener
 * path is never touched.
 *
 * In production (no mock registered), the `terraform.init.chunk` /
 * `terraform.init.end` listeners are attached **before**
 * `ipcRenderer.invoke('terraform.init', config)` is called, so no chunk sent
 * immediately after the main process acknowledges the call can ever be
 * dropped. The invoke call resolves with `{ started, error? }`: a `false`
 * `started` value means `config` failed validation and no `terraform init`
 * process was ever spawned — no chunk/end messages will ever arrive, so the
 * generator throws right away using `error` (and cleans up the now-unused
 * listeners in `finally`). When `started` is `true`, chunks are buffered as
 * they arrive on `terraform.init.chunk` and yielded in order; the generator
 * completes when `terraform.init.end` fires with no `error`, or throws using
 * its `error` field otherwise.
 *
 * Following the `logs.stream` pattern, an optional `signal` may be supplied to
 * cancel consumption early: aborting (or breaking out of the `for await`
 * loop) stops the wait loop and the `finally` block detaches the listeners.
 * There is no per-run cancel side channel to notify the main process — the
 * `terraform init` run itself keeps running to completion in the background,
 * but the generator stops yielding further chunks to the caller.
 */
async function* streamTerraformInit(config: TerraformInitConfig, signal?: AbortSignal): AsyncIterable<TerraformRunChunk> {
  const initMock = mockRegistry.get('terraform.init');
  if (initMock !== undefined) {
    const mockIterable = initMock(config, signal) as AsyncIterable<TerraformRunChunk>;
    yield* mockIterable;
    return;
  }

  /** Chunks received but not yet yielded. */
  const buffer: TerraformRunChunk[] = [];
  let ended = false;
  let endError: string | undefined;
  let aborted = false;
  /** Resolves the pending `await` when a chunk arrives, the stream ends, or the signal aborts. */
  let wake: (() => void) | null = null;
  const signalWake = () => {
    if (wake) {
      const fn = wake;
      wake = null;
      fn();
    }
  };

  const onChunk = (_evt: IpcRendererEvent, chunk: TerraformRunChunk) => {
    buffer.push(chunk);
    signalWake();
  };
  const onEnd = (_evt: IpcRendererEvent, data: { exitCode: number | null; error?: string }) => {
    ended = true;
    endError = data?.error;
    signalWake();
  };
  const onAbort = () => {
    aborted = true;
    signalWake();
  };

  // Attach both listeners before invoking so no early chunk sent right after
  // the main process acknowledges the call is ever dropped — unlike
  // `streamLogs`, the channel names here are fixed constants known up front,
  // so there is no need to wait for the invoke response first.
  ipcRenderer.on(TERRAFORM_INIT_CHUNK_CHANNEL, onChunk);
  ipcRenderer.once(TERRAFORM_INIT_END_CHANNEL, onEnd);
  if (signal) {
    if (signal.aborted) aborted = true;
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    if (aborted) return;

    const ack = (await invoke('terraform.init', config)) as { started: boolean; error?: string };
    if (!ack.started) {
      throw new Error(ack.error ?? 'terraform.init failed to start');
    }

    while (true) {
      while (buffer.length > 0) {
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
    ipcRenderer.removeListener(TERRAFORM_INIT_CHUNK_CHANNEL, onChunk);
    ipcRenderer.removeListener(TERRAFORM_INIT_END_CHANNEL, onEnd);
    signal?.removeEventListener('abort', onAbort);
  }
}

const api: GsdApi = {
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
    actual: (days?: number) => invoke('costs.actual', days),
  },

  logs: {
    get: (game: string, limit?: number) => invoke('logs.get', { game, limit }),
    stream: streamLogs,
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

  config: {
    get: () => invoke('config.get'),
    update: (body: {
      watchdog_interval_minutes?: number;
      watchdog_idle_checks?: number;
      watchdog_min_packets?: number;
    }) => invoke('config.update', body),
  },

  drift: {
    get: () => invoke('drift.get'),
  },

  diagnostics: {
    tail: () => invoke('diagnostics.tail'),
    path: () => invoke('diagnostics.path'),
  },

  audit: {
    list: (opts?: { limit?: number; before?: string }) => invoke('audit.list', opts),
  },

  terraform: {
    init: streamTerraformInit,
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

const gsdBridge: GsdApi & { __test?: GsdTestApi } = { ...api };

if (isTestMode) {
  /**
   * Test-only injection surface, present only when `HYVEON_TEST_MODE=1`.
   *
   * Exposes `mock(channel, handler)` so Playwright / Vitest can register
   * per-channel IPC overrides without touching the real Electron IPC layer.
   * `clearMocks` and `reset` both clear the registry so state does not leak
   * between test cases (mirror the {@link GsdTestApi} contract).
   */
  gsdBridge.__test = {
    mock: registerMock,
    /** Clears all registered mock handlers from the registry. */
    clearMocks: () => mockRegistry.clear(),
    /** Alias for {@link clearMocks} — symmetry with `vi.resetAllMocks()`. */
    reset: () => mockRegistry.clear(),
  };
}

contextBridge.exposeInMainWorld('gsd', gsdBridge);
