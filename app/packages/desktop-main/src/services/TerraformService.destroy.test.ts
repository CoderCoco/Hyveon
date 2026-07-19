import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * Spy variables must be hoisted before vi.mock() factories run, because
 * vi.mock() calls are lifted to the top of the compiled output above regular
 * declarations.
 */
const { execFileMock, spawnMock, mkdirSyncMock, writeFileSyncMock, existsSyncMock } = vi.hoisted(() => {
  const execFileMock = vi.fn();
  const spawnMock = vi.fn();
  const mkdirSyncMock = vi.fn();
  const writeFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn();
  return { execFileMock, spawnMock, mkdirSyncMock, writeFileSyncMock, existsSyncMock };
});

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

vi.mock('node:fs', () => ({
  mkdirSync: mkdirSyncMock,
  existsSync: existsSyncMock,
  writeFileSync: writeFileSyncMock,
  copyFileSync: vi.fn(),
}));

import {
  TerraformService,
  TerraformNotFoundError,
  TerraformDestroyError,
  DestroyNotConfirmedError,
  type TerraformRunChunk,
  type TerraformDestroyResult,
  type TerraformRunRecord,
} from './TerraformService.js';
import type { ConfigService } from './ConfigService.js';
import type { RemoteFileStore } from '@hyveon/shared';

/**
 * How long a minted destroy-confirmation token stays valid before
 * `TerraformService.destroy()` rejects it as stale — mirrors the private
 * `DESTROY_CONFIRMATION_TTL_MS` constant in `TerraformService.ts` (5
 * minutes). Not exported by the source module, so it's duplicated here to
 * drive the token-expiry test below.
 */
const DESTROY_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/** Error-first callback shape `util.promisify` invokes the mocked `execFile` with. */
type ExecFileCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

/**
 * Extracts the error-first callback from an `execFile` call's arguments,
 * regardless of whether `util.promisify` invoked it with or without an
 * `options` object.
 */
function lastArgAsCallback(args: unknown[]): ExecFileCallback {
  return args[args.length - 1] as ExecFileCallback;
}

/** Queues a successful `execFile` invocation (stdout/stderr) for the next call. */
function queueExecFileSuccess(stdout: string, stderr = ''): void {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    lastArgAsCallback(args)(null, { stdout, stderr });
  });
}

/** Queues a failing `execFile` invocation (e.g. binary not found) for the next call. */
function queueExecFileFailure(error: Error = new Error('spawn ENOENT')): void {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    lastArgAsCallback(args)(error);
  });
}

/** Queues a successful binary lookup followed by a successful `-json` version response. */
function queueSuccessfulResolution(binaryPath = '/usr/local/bin/terraform', version = '1.7.0'): void {
  queueExecFileSuccess(`${binaryPath}\n`);
  queueExecFileSuccess(JSON.stringify({ terraform_version: version }));
}

/**
 * `ConfigService` stub for `destroy()` tests: exposes `getTerraformDir` and
 * `getRunsDir` — the only accessors `destroy()` (directly, or via
 * {@link TerraformService.writeRunRecord}) reads.
 */
function stubDestroyConfigService(
  opts: {
    terraformDir?: string;
    runsDir?: string;
  } = {},
): ConfigService {
  return {
    getTerraformDir: () => opts.terraformDir ?? '/repo/terraform',
    getRunsDir: () => opts.runsDir ?? '/repo/runs',
  } as ConfigService;
}

/**
 * Minimal `RemoteFileStore` stub sufficient to satisfy `TerraformService`'s
 * constructor dependency — `destroy()` never touches it.
 */
function stubRemoteFileStore(): RemoteFileStore {
  const store: Partial<RemoteFileStore> = {
    get: vi.fn(),
    put: vi.fn(),
    listVersions: vi.fn(),
  };
  return store as RemoteFileStore;
}

/**
 * A fake `child_process.ChildProcess` sufficient for exercising `destroy()`'s
 * streaming logic: an `EventEmitter` standing in for the process itself,
 * with `stdout`/`stderr` sub-emitters standing in for the piped streams, and
 * a spied `kill()` so abort tests can assert the process was actually
 * terminated. Tests drive it manually via `emitStdout`/`emitStderr`/`close`/
 * `emit('error', ...)` rather than relying on any real process lifecycle.
 */
class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn();

  emitStdout(chunk: string): void {
    this.stdout.emit('data', Buffer.from(chunk));
  }

  emitStderr(chunk: string): void {
    this.stderr.emit('data', Buffer.from(chunk));
  }

  close(code: number | null): void {
    this.emit('close', code);
  }
}

/** Queues the next `spawn()` call to return `child` instead of a real process. */
function queueSpawn(child: FakeChildProcess): void {
  spawnMock.mockImplementationOnce(() => child);
}

/**
 * Waits for every already-queued microtask to drain (via a macrotask
 * boundary) before returning. `destroy()` awaits binary/version resolution
 * before it reaches the `spawn()` call and registers listeners on the child
 * process, so tests must flush past that chain before driving
 * `child.emitStdout`/`close`/`error` — otherwise those events fire before any
 * listener has been attached.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drains a `destroy()` async generator to completion, collecting every
 * yielded chunk plus the generator's final return value — a
 * `TerraformDestroyResult` on success, or `undefined` on a clean abort.
 * `driveChild` is invoked once (after the first `.next()` has been issued so
 * the child process is spawned and listeners are attached) to let the caller
 * emit data/close/error events on the fake child at the right moment
 * relative to iteration.
 */
async function collectDestroyChunks(
  gen: AsyncGenerator<TerraformRunChunk, TerraformDestroyResult | undefined>,
  driveChild?: () => void,
): Promise<{ chunks: TerraformRunChunk[]; result: TerraformDestroyResult | undefined }> {
  const chunks: TerraformRunChunk[] = [];
  const first = gen.next();
  // Attach a no-op rejection handler immediately so a generator that throws
  // before `driveChild` is even relevant (e.g. an unconfirmed token) doesn't
  // trip Node's unhandled-rejection detection during the `flushMicrotasks`
  // gap below — the real `await first` a few lines down still surfaces the
  // rejection to the caller.
  first.catch(() => {});
  await flushMicrotasks();
  driveChild?.();
  let next = await first;
  while (!next.done) {
    chunks.push(next.value);
    const following = gen.next();
    following.catch(() => {});
    next = await following;
  }
  return { chunks, result: next.value };
}

beforeEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
  mkdirSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  existsSyncMock.mockReset();
});

describe('TerraformService.destroy confirmation gate', () => {
  it('should reject with a DestroyNotConfirmedError instance and never call spawn when no confirmation token has ever been minted', async () => {
    const service = new TerraformService(stubDestroyConfigService(), stubRemoteFileStore());

    await expect(collectDestroyChunks(service.destroy('guessed-token'))).rejects.toBeInstanceOf(
      DestroyNotConfirmedError,
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('should reject with a DestroyNotConfirmedError instance and never call spawn when the supplied token does not match the most recently minted token', async () => {
    const service = new TerraformService(stubDestroyConfigService(), stubRemoteFileStore());
    service.mintDestroyConfirmationToken();

    await expect(collectDestroyChunks(service.destroy('some-other-token'))).rejects.toBeInstanceOf(
      DestroyNotConfirmedError,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('should reject with a DestroyNotConfirmedError instance when the most recently minted token has expired', async () => {
    const service = new TerraformService(stubDestroyConfigService(), stubRemoteFileStore());

    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockReturnValueOnce(1_000_000);
    const token = service.mintDestroyConfirmationToken();

    dateNowSpy.mockReturnValueOnce(1_000_000 + DESTROY_CONFIRMATION_TTL_MS + 1);
    await expect(collectDestroyChunks(service.destroy(token))).rejects.toBeInstanceOf(DestroyNotConfirmedError);
    expect(spawnMock).not.toHaveBeenCalled();

    dateNowSpy.mockRestore();
  });

  it('should reject with a DestroyNotConfirmedError instance on a second destroy() call reusing an already-consumed token', async () => {
    const service = new TerraformService(stubDestroyConfigService(), stubRemoteFileStore());
    const token = service.mintDestroyConfirmationToken();

    // Consume the token via a first call whose signal is already aborted —
    // assertFreshDestroyConfirmation() runs (and consumes the token) before
    // the abort check, so the generator ends cleanly without ever spawning.
    const controller = new AbortController();
    controller.abort();
    const first = await collectDestroyChunks(service.destroy(token, controller.signal));
    expect(first.result).toBeUndefined();

    await expect(collectDestroyChunks(service.destroy(token))).rejects.toBeInstanceOf(DestroyNotConfirmedError);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('TerraformService.destroy confirmed run', () => {
  it('should spawn terraform destroy -auto-approve, stream output, parse the destroyed count, and persist a run.json record once confirmed', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(
      stubDestroyConfigService({ terraformDir: '/repo/terraform', runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
    );
    const token = service.mintDestroyConfirmationToken();

    const { chunks, result } = await collectDestroyChunks(service.destroy(token), () => {
      child.emitStdout('aws_instance.game: Destroying...\n');
      child.emitStdout('Destroy complete! Resources: 3 destroyed.\n');
      child.close(0);
    });

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/terraform',
      ['destroy', '-input=false', '-no-color', '-auto-approve'],
      { cwd: '/repo/terraform' },
    );
    expect(chunks).toContainEqual({ stream: 'stdout', line: 'aws_instance.game: Destroying...' });

    expect(result).toBeDefined();
    expect(result?.destroyed).toBe(3);
    const runId = result?.runId as string;
    expect(typeof runId).toBe('string');

    expect(mkdirSyncMock).toHaveBeenCalledWith(`/repo/runs/${runId}`, { recursive: true });
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    const [path, contents] = writeFileSyncMock.mock.calls[0] as [string, string];
    expect(path).toBe(`/repo/runs/${runId}/run.json`);
    const record = JSON.parse(contents) as TerraformRunRecord;
    expect(record.runId).toBe(runId);
    expect(record.kind).toBe('destroy');
    expect(record.exitCode).toBe(0);
    expect(typeof record.startedAt).toBe('string');
    expect(typeof record.completedAt).toBe('string');
  });

  it('should reject with a TerraformDestroyError carrying the exit code, while still persisting a run.json record, when the process exits non-zero', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(
      stubDestroyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
    );
    const token = service.mintDestroyConfirmationToken();

    const pending = collectDestroyChunks(service.destroy(token), () => child.close(1));

    await expect(pending).rejects.toBeInstanceOf(TerraformDestroyError);
    await expect(pending).rejects.toMatchObject({ exitCode: 1 });

    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    const [path, contents] = writeFileSyncMock.mock.calls[0] as [string, string];
    expect(path).toMatch(/^\/repo\/runs\/.+\/run\.json$/);
    const record = JSON.parse(contents) as TerraformRunRecord;
    expect(record.kind).toBe('destroy');
    expect(record.exitCode).toBe(1);
  });

  it('should reject with a TerraformNotFoundError instance and never call spawn when the binary cannot be resolved, even with a valid confirmation token', async () => {
    queueExecFileFailure();

    const service = new TerraformService(stubDestroyConfigService(), stubRemoteFileStore());
    const token = service.mintDestroyConfirmationToken();

    await expect(collectDestroyChunks(service.destroy(token))).rejects.toBeInstanceOf(TerraformNotFoundError);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});
