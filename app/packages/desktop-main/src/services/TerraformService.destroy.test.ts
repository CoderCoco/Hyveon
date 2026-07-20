import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * Spy variables must be hoisted before vi.mock() factories run, because
 * vi.mock() calls are lifted to the top of the compiled output above regular
 * declarations.
 */
const { execFileMock, spawnMock, mkdirSyncMock, writeFileSyncMock, existsSyncMock, runRecordPersistMock } =
  vi.hoisted(() => {
    const execFileMock = vi.fn();
    const spawnMock = vi.fn();
    const mkdirSyncMock = vi.fn();
    const writeFileSyncMock = vi.fn();
    const existsSyncMock = vi.fn();
    const runRecordPersistMock = vi.fn();
    return { execFileMock, spawnMock, mkdirSyncMock, writeFileSyncMock, existsSyncMock, runRecordPersistMock };
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

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  TerraformService,
  TerraformNotFoundError,
  TerraformDestroyError,
  DestroyNotConfirmedError,
  TerraformRunPersistError,
  type TerraformRunChunk,
  type TerraformDestroyResult,
  type TerraformRunRecord,
} from './TerraformService.js';
import type { ConfigService } from './ConfigService.js';
import type { RunRecordService } from './RunRecordService.js';
import type { RemoteFileStore } from '@hyveon/shared';
import { logger } from '../logger.js';

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
 * {@link TerraformService.writeRunRecord}) reads. Also exposes
 * `getTfvarsBucket`/`getTfvarsPath` (defaulting to local-file mode) purely so
 * the cross-subcommand lock tests below can exercise a real `plan()`/`apply()`
 * call — `destroy()` itself never touches either accessor.
 */
function stubDestroyConfigService(
  opts: {
    terraformDir?: string;
    runsDir?: string;
    tfvarsBucket?: string | null;
    tfvarsPath?: string;
  } = {},
): ConfigService {
  return {
    getTerraformDir: () => opts.terraformDir ?? '/repo/terraform',
    getRunsDir: () => opts.runsDir ?? '/repo/runs',
    getTfvarsBucket: () => opts.tfvarsBucket ?? null,
    getTfvarsPath: () => opts.tfvarsPath ?? '/repo/terraform/terraform.tfvars',
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
 * `RunRecordService` stub for `destroy()` tests: `persist` is backed by the
 * shared, hoisted `runRecordPersistMock` so tests can assert on the exact
 * `RunRecord` params and log path `destroy()` persisted, regardless of which
 * test constructed the `TerraformService` instance under test.
 */
function stubRunRecordService(): RunRecordService {
  return { persist: runRecordPersistMock } as Partial<RunRecordService> as RunRecordService;
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
  runRecordPersistMock.mockReset();
});

describe('TerraformService.destroy confirmation gate', () => {
  it('should reject with a DestroyNotConfirmedError instance and never call spawn when no confirmation token has ever been minted', async () => {
    const service = new TerraformService(stubDestroyConfigService(), stubRemoteFileStore(), stubRunRecordService());

    await expect(collectDestroyChunks(service.destroy('guessed-token'))).rejects.toBeInstanceOf(
      DestroyNotConfirmedError,
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('should reject with a DestroyNotConfirmedError instance and never call spawn when the supplied token does not match the most recently minted token', async () => {
    const service = new TerraformService(stubDestroyConfigService(), stubRemoteFileStore(), stubRunRecordService());
    service.mintDestroyConfirmationToken();

    await expect(collectDestroyChunks(service.destroy('some-other-token'))).rejects.toBeInstanceOf(
      DestroyNotConfirmedError,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('should reject with a DestroyNotConfirmedError instance when the most recently minted token has expired', async () => {
    const service = new TerraformService(stubDestroyConfigService(), stubRemoteFileStore(), stubRunRecordService());

    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockReturnValueOnce(1_000_000);
    const token = service.mintDestroyConfirmationToken();

    dateNowSpy.mockReturnValueOnce(1_000_000 + DESTROY_CONFIRMATION_TTL_MS + 1);
    await expect(collectDestroyChunks(service.destroy(token))).rejects.toBeInstanceOf(DestroyNotConfirmedError);
    expect(spawnMock).not.toHaveBeenCalled();

    dateNowSpy.mockRestore();
  });

  it('should reject with a DestroyNotConfirmedError instance on a second destroy() call reusing an already-consumed token', async () => {
    const service = new TerraformService(stubDestroyConfigService(), stubRemoteFileStore(), stubRunRecordService());
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
      stubRunRecordService(),
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
    // One write for run.json, one for the accumulated terraform.log.
    expect(writeFileSyncMock).toHaveBeenCalledTimes(2);
    const [path, contents] = writeFileSyncMock.mock.calls.find(
      ([callPath]) => callPath === `/repo/runs/${runId}/run.json`,
    ) as [string, string];
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
      stubRunRecordService(),
    );
    const token = service.mintDestroyConfirmationToken();

    const pending = collectDestroyChunks(service.destroy(token), () => child.close(1));

    await expect(pending).rejects.toBeInstanceOf(TerraformDestroyError);
    await expect(pending).rejects.toMatchObject({ exitCode: 1 });

    // One write for run.json, one for the accumulated terraform.log.
    expect(writeFileSyncMock).toHaveBeenCalledTimes(2);
    const [path, contents] = writeFileSyncMock.mock.calls.find(([callPath]) =>
      (callPath as string).endsWith('run.json'),
    ) as [string, string];
    expect(path).toMatch(/^\/repo\/runs\/.+\/run\.json$/);
    const record = JSON.parse(contents) as TerraformRunRecord;
    expect(record.kind).toBe('destroy');
    expect(record.exitCode).toBe(1);
  });

  it('should reject with a TerraformNotFoundError instance and never call spawn when the binary cannot be resolved, even with a valid confirmation token', async () => {
    queueExecFileFailure();

    const service = new TerraformService(stubDestroyConfigService(), stubRemoteFileStore(), stubRunRecordService());
    const token = service.mintDestroyConfirmationToken();

    await expect(collectDestroyChunks(service.destroy(token))).rejects.toBeInstanceOf(TerraformNotFoundError);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});

describe('TerraformService.destroy concurrency guard', () => {
  it('should throw a descriptive Error from a second destroy() call while the first is still in flight', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubDestroyConfigService(), stubRemoteFileStore(), stubRunRecordService());
    const firstToken = service.mintDestroyConfirmationToken();
    const firstGen = service.destroy(firstToken);
    const firstNext = firstGen.next(); // starts the generator body, setting the in-flight flag synchronously

    const secondToken = service.mintDestroyConfirmationToken();
    const secondGen = service.destroy(secondToken);
    await expect(secondGen.next()).rejects.toThrow(/already running/i);

    // Let the first call finish so it doesn't leak into other tests.
    await flushMicrotasks();
    child.close(0);
    await firstNext;
    await firstGen.next();
  });

  it('should throw a descriptive Error from destroy() when apply() is already running against the same workspace', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);
    existsSyncMock.mockReturnValue(true);

    const service = new TerraformService(
      stubDestroyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
      stubRunRecordService(),
    );
    const applyGen = service.apply('run-1', undefined, '/repo/runs/run-1/run-1.tfplan');
    const applyNext = applyGen.next(); // starts apply()'s body, setting the shared in-flight flag synchronously

    const token = service.mintDestroyConfirmationToken();
    const destroyGen = service.destroy(token);
    await expect(destroyGen.next()).rejects.toThrow(/apply\(\) is already running/i);

    // Let the in-flight apply() finish so it doesn't leak into other tests.
    await flushMicrotasks();
    child.close(0);
    await applyNext;
    await applyGen.next();
  });

  it('should throw a descriptive Error from destroy() when plan() is already running against the same workspace', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);
    // plan() pulls a local-file tfvars snapshot ahead of spawning — stub a
    // "source file exists" answer so that read succeeds and plan() reaches
    // spawn (and the shared workspace lock) the same way destroy() would.
    existsSyncMock.mockReturnValue(true);

    const service = new TerraformService(stubDestroyConfigService(), stubRemoteFileStore(), stubRunRecordService());
    const planGen = service.plan();
    const planNext = planGen.next(); // starts plan()'s body, setting the shared in-flight flag synchronously

    const token = service.mintDestroyConfirmationToken();
    const destroyGen = service.destroy(token);
    await expect(destroyGen.next()).rejects.toThrow(/plan\(\) is already running/i);

    // Let the in-flight plan() finish so it doesn't leak into other tests.
    await flushMicrotasks();
    child.close(0);
    await planNext;
    await planGen.next();
  });
});

describe('TerraformService.destroy run.json persistence failure', () => {
  it('should reject with a TerraformRunPersistError carrying the real (successful) destroy outcome when writeRunRecord fails to persist the run record', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);
    const persistFailure = new Error('ENOSPC: no space left on device');
    // Only the run.json write fails — the terraform.log write (which now
    // also happens once the process closes) uses the default no-op mock, so
    // this targets the specific writeFileSync call the assertions below care
    // about regardless of the order the two writes happen in.
    writeFileSyncMock.mockImplementation((path: unknown) => {
      if (typeof path === 'string' && path.endsWith('run.json')) {
        throw persistFailure;
      }
    });

    const service = new TerraformService(
      stubDestroyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
      stubRunRecordService(),
    );
    const token = service.mintDestroyConfirmationToken();

    const pending = collectDestroyChunks(service.destroy(token), () => {
      child.emitStdout('Destroy complete! Resources: 2 destroyed.\n');
      child.close(0);
    });

    await expect(pending).rejects.toBeInstanceOf(TerraformRunPersistError);
    // The real destroy outcome (the process succeeded and destroyed 2
    // resources) must survive the persistence failure rather than being
    // discarded behind it.
    await expect(pending).rejects.toMatchObject({
      runId: expect.any(String),
      outcome: { kind: 'success', result: { destroyed: 2 } },
    });
    // `writeRunRecord` wraps the raw filesystem error in a descriptive
    // `Error` (with `{ cause }`) before `destroy()` re-wraps *that* as the
    // `TerraformRunPersistError`'s own `cause` — assert the original
    // `persistFailure` is still reachable two levels down rather than lost.
    const rejection = (await pending.catch((err: unknown) => err)) as TerraformRunPersistError;
    expect(rejection.cause).toBeInstanceOf(Error);
    expect((rejection.cause as Error).cause).toBe(persistFailure);
  });
});

describe('TerraformService.destroy forced early termination', () => {
  it('should kill the child process and wait for it to close when the generator is force-closed early (e.g. consumer break) before the process exits', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubDestroyConfigService(), stubRemoteFileStore(), stubRunRecordService());
    const token = service.mintDestroyConfirmationToken();
    const gen = service.destroy(token);

    // Drive the generator to its first yielded chunk, mirroring a consumer
    // that starts iterating (e.g. a `for await...of` loop) but never reaches
    // the child process's `close` event before bailing out.
    const first = gen.next();
    await flushMicrotasks();
    child.emitStdout('aws_instance.game: Destroying...\n');
    await first;

    // Simulate the consumer force-closing the generator early (what a
    // `for await...of` `break`/`throw` desugars to under the hood). This
    // should propagate through destroy()'s finally into spawnAndStream's
    // finally, which must kill the still-running child rather than just
    // detaching the abort listener.
    let returnSettled = false;
    const returnPromise = gen.return(undefined).then((result) => {
      returnSettled = true;
      return result;
    });

    await flushMicrotasks();
    expect(child.kill).toHaveBeenCalledTimes(1);
    // The generator must not resolve its forced return until the child
    // process actually reports closing — killing it isn't enough on its own.
    expect(returnSettled).toBe(false);

    child.close(null);
    const result = await returnPromise;

    expect(returnSettled).toBe(true);
    expect(result.done).toBe(true);
  });

  it('should write exactly one run.json record with a null exitCode via the outer finally when the generator is force-closed before the process exits', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(
      stubDestroyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
      stubRunRecordService(),
    );
    const token = service.mintDestroyConfirmationToken();
    const gen = service.destroy(token);

    // Drive the generator to its first yielded chunk, then force-close it —
    // as `for await...of` `break`/`throw` would — before the child process
    // has closed. writeRunRecord() lives after the inner try/finally in
    // destroy()'s body, which a forced completion unwinds straight past; the
    // persistence must instead happen from the outer finally's `forceKilled`
    // cleanup path.
    const first = gen.next();
    await flushMicrotasks();
    child.emitStdout('aws_instance.game: Destroying...\n');
    await first;

    const returnPromise = gen.return(undefined);
    await flushMicrotasks();
    expect(child.kill).toHaveBeenCalledTimes(1);

    child.close(null);
    await returnPromise;

    // One write for run.json, one for the accumulated terraform.log — both
    // persisted from the outer finally's force-killed branch.
    expect(writeFileSyncMock).toHaveBeenCalledTimes(2);
    const [path, contents] = writeFileSyncMock.mock.calls.find(([callPath]) =>
      (callPath as string).endsWith('run.json'),
    ) as [string, string];
    expect(path).toMatch(/^\/repo\/runs\/.+\/run\.json$/);
    const record = JSON.parse(contents) as TerraformRunRecord;
    expect(record.kind).toBe('destroy');
    expect(record.exitCode).toBeNull();
  });
});

describe('TerraformService.destroy RunRecordService persistence', () => {
  it('should call RunRecordService.persist exactly once with a matching RunRecord and the captured terraform.log path when the process exits cleanly', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);
    runRecordPersistMock.mockResolvedValue(undefined);

    const service = new TerraformService(
      stubDestroyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
      stubRunRecordService(),
    );
    const token = service.mintDestroyConfirmationToken();

    const { result } = await collectDestroyChunks(service.destroy(token), () => {
      child.emitStdout('Destroy complete! Resources: 3 destroyed.\n');
      child.close(0);
    });
    const runId = result?.runId as string;

    expect(runRecordPersistMock).toHaveBeenCalledTimes(1);
    const [params, logFilePath] = runRecordPersistMock.mock.calls[0] as [
      { runId: string; kind: string; exitCode: number | null },
      string,
    ];
    expect(params).toMatchObject({ runId, kind: 'destroy', exitCode: 0 });
    expect(logFilePath).toBe(`/repo/runs/${runId}/terraform.log`);

    // The persisted record's timestamps must match the local run.json's own
    // timestamps — both are written from the same captured values.
    const [, localContents] = writeFileSyncMock.mock.calls.find(
      ([callPath]) => callPath === `/repo/runs/${runId}/run.json`,
    ) as [string, string];
    const localRecord = JSON.parse(localContents) as TerraformRunRecord;
    expect((params as { startedAt: string }).startedAt).toBe(localRecord.startedAt);
    expect((params as { completedAt: string }).completedAt).toBe(localRecord.completedAt);
  });

  it('should call RunRecordService.persist exactly once with the non-zero exit code when the process exits non-zero', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);
    runRecordPersistMock.mockResolvedValue(undefined);

    const service = new TerraformService(
      stubDestroyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
      stubRunRecordService(),
    );
    const token = service.mintDestroyConfirmationToken();

    const pending = collectDestroyChunks(service.destroy(token), () => child.close(1));
    await expect(pending).rejects.toBeInstanceOf(TerraformDestroyError);

    expect(runRecordPersistMock).toHaveBeenCalledTimes(1);
    const [params] = runRecordPersistMock.mock.calls[0] as [{ runId: string; kind: string; exitCode: number | null }];
    expect(params).toMatchObject({ kind: 'destroy', exitCode: 1 });
  });

  it('should call RunRecordService.persist exactly once with a null exit code when the generator is force-closed before the process exits', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);
    runRecordPersistMock.mockResolvedValue(undefined);

    const service = new TerraformService(
      stubDestroyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
      stubRunRecordService(),
    );
    const token = service.mintDestroyConfirmationToken();
    const gen = service.destroy(token);

    const first = gen.next();
    await flushMicrotasks();
    child.emitStdout('aws_instance.game: Destroying...\n');
    await first;

    const returnPromise = gen.return(undefined);
    await flushMicrotasks();
    child.close(null);
    await returnPromise;

    expect(runRecordPersistMock).toHaveBeenCalledTimes(1);
    const [params] = runRecordPersistMock.mock.calls[0] as [{ runId: string; kind: string; exitCode: number | null }];
    expect(params).toMatchObject({ kind: 'destroy', exitCode: null });
  });

  it('should never call RunRecordService.persist when the run never spawns (e.g. no confirmation token was minted)', async () => {
    const service = new TerraformService(
      stubDestroyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
      stubRunRecordService(),
    );

    await expect(
      collectDestroyChunks(service.destroy('guessed-token')),
    ).rejects.toBeInstanceOf(DestroyNotConfirmedError);

    expect(runRecordPersistMock).not.toHaveBeenCalled();
  });

  it('should still resolve the generator with the real destroy result when RunRecordService.persist rejects', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);
    runRecordPersistMock.mockRejectedValue(new Error('DynamoDB unavailable'));

    const service = new TerraformService(
      stubDestroyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
      stubRunRecordService(),
    );
    const token = service.mintDestroyConfirmationToken();

    const { result } = await collectDestroyChunks(service.destroy(token), () => {
      child.emitStdout('Destroy complete! Resources: 3 destroyed.\n');
      child.close(0);
    });

    expect(result).toMatchObject({ destroyed: 3 });
    expect(runRecordPersistMock).toHaveBeenCalledTimes(1);
  });
});

describe('TerraformService.destroy run log capture', () => {
  it('should write the accumulated stdout+stderr transcript to <runsDir>/<runId>/terraform.log in a single writeFileSync once the process closes', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(
      stubDestroyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
      stubRunRecordService(),
    );
    const token = service.mintDestroyConfirmationToken();

    const { result } = await collectDestroyChunks(service.destroy(token), () => {
      child.emitStdout('aws_instance.game: Destroying...\n');
      child.emitStderr('Warning: something\n');
      child.close(0);
    });

    const runId = result?.runId as string;
    const logCalls = writeFileSyncMock.mock.calls.filter(
      ([path]) => path === `/repo/runs/${runId}/terraform.log`,
    );
    expect(logCalls).toHaveLength(1);
    const [, contents] = logCalls[0] as [string, string];
    expect(contents).toBe('aws_instance.game: Destroying...\nWarning: something\n');
  });

  it('should still write the accumulated transcript to terraform.log when the process exits non-zero', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(
      stubDestroyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
      stubRunRecordService(),
    );
    const token = service.mintDestroyConfirmationToken();

    const pending = collectDestroyChunks(service.destroy(token), () => {
      child.emitStdout('Error: something went wrong\n');
      child.close(1);
    });

    await expect(pending).rejects.toBeInstanceOf(TerraformDestroyError);

    const logCalls = writeFileSyncMock.mock.calls.filter(([path]) =>
      (path as string).endsWith('/terraform.log'),
    );
    expect(logCalls).toHaveLength(1);
    const [, contents] = logCalls[0] as [string, string];
    expect(contents).toBe('Error: something went wrong\n');
  });

  it('should write whatever transcript was captured to terraform.log when the generator is force-closed early', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(
      stubDestroyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
      stubRunRecordService(),
    );
    const token = service.mintDestroyConfirmationToken();
    const gen = service.destroy(token);

    const first = gen.next();
    await flushMicrotasks();
    child.emitStdout('aws_instance.game: Destroying...\n');
    await first;

    const returnPromise = gen.return(undefined);
    await flushMicrotasks();
    child.close(null);
    await returnPromise;

    const logCalls = writeFileSyncMock.mock.calls.filter(([path]) =>
      (path as string).endsWith('/terraform.log'),
    );
    expect(logCalls).toHaveLength(1);
    const [, contents] = logCalls[0] as [string, string];
    expect(contents).toBe('aws_instance.game: Destroying...\n');
  });
});

describe('TerraformService.destroy forced-cleanup persistence failure', () => {
  it('should have already emitted the confirmed-start WARN log, and resolve cleanly, when the outer finally\'s forced-cleanup writeRunRecord call itself throws', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);
    // Every writeFileSync call (including the outer finally's forced-cleanup
    // attempt) fails — the run was never persisted, and the failure must not
    // crash the generator's forced teardown.
    writeFileSyncMock.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    const service = new TerraformService(
      stubDestroyConfigService({ terraformDir: '/repo/terraform' }),
      stubRemoteFileStore(),
      stubRunRecordService(),
    );
    const token = service.mintDestroyConfirmationToken();
    const gen = service.destroy(token);

    const first = gen.next();
    await flushMicrotasks();
    child.emitStdout('aws_instance.game: Destroying...\n');
    await first;

    // The "confirmed — spawning" WARN log is emitted unconditionally before
    // the spawned process is ever streamed, well before the forced-cleanup
    // path below runs — it must still be on record afterward.
    expect(logger.warn).toHaveBeenCalledWith(
      'terraform destroy confirmed — spawning terraform destroy -auto-approve',
      expect.objectContaining({ cwd: '/repo/terraform' }),
    );

    const returnPromise = gen.return(undefined);
    await flushMicrotasks();
    expect(child.kill).toHaveBeenCalledTimes(1);

    child.close(null);
    const result = await returnPromise;

    // The forced-cleanup writeRunRecord attempt is swallowed (best-effort)
    // rather than crashing the generator's teardown or rejecting return() —
    // and so is the equally-failing writeRunLog attempt alongside it.
    expect(result.done).toBe(true);
    expect(writeFileSyncMock).toHaveBeenCalledTimes(2);
  });
});
