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
  TerraformApplyError,
  StalePlanError,
  type TerraformInitConfig,
  type TerraformRunChunk,
  type TerraformApplyResult,
  type TerraformRunRecord,
} from './TerraformService.js';
import type { ConfigService } from './ConfigService.js';
import type { RemoteFileStore } from '@hyveon/shared';

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
 * `ConfigService` stub for `apply()` tests: exposes `getTerraformDir`,
 * `getRunsDir`, `getTfvarsBucket`, and `getTfvarsPath` — the accessors
 * `apply()` (directly, or via {@link TerraformService.assertPlanTfvarsNotStale}
 * and {@link TerraformService.writeRunRecord}) reads.
 */
function stubApplyConfigService(
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
 * constructor dependency. `listVersions` is a directly-controllable mock so
 * S3-mode `apply()` tests can queue a tfvars version-history response for
 * the stale-plan guard.
 */
function stubRemoteFileStore(): RemoteFileStore & {
  listVersions: ReturnType<typeof vi.fn>;
} {
  const store: Partial<RemoteFileStore> = {
    get: vi.fn(),
    put: vi.fn(),
    listVersions: vi.fn(),
  };
  return store as RemoteFileStore & {
    listVersions: ReturnType<typeof vi.fn>;
  };
}

/**
 * A fake `child_process.ChildProcess` sufficient for exercising `apply()`'s
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
 * boundary) before returning. `apply()` awaits the stale-plan guard plus the
 * binary/version resolution before it reaches the `spawn()` call and
 * registers listeners on the child process, so tests must flush past that
 * chain before driving `child.emitStdout`/`close`/`error` — otherwise those
 * events fire before any listener has been attached.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drains an `apply()` async generator to completion, collecting every
 * yielded chunk plus the generator's final return value — a
 * `TerraformApplyResult` on success, or `undefined` on a clean abort.
 * `driveChild` is invoked once (after the first `.next()` has been issued so
 * the child process is spawned and listeners are attached) to let the caller
 * emit data/close/error events on the fake child at the right moment
 * relative to iteration.
 */
async function collectApplyChunks(
  gen: AsyncGenerator<TerraformRunChunk, TerraformApplyResult | undefined>,
  driveChild?: () => void,
): Promise<{ chunks: TerraformRunChunk[]; result: TerraformApplyResult | undefined }> {
  const chunks: TerraformRunChunk[] = [];
  const first = gen.next();
  // Attach a no-op rejection handler immediately so a generator that throws
  // before `driveChild` is even relevant (e.g. binary resolution failure)
  // doesn't trip Node's unhandled-rejection detection during the
  // `flushMicrotasks` gap below — the real `await first` a few lines down
  // still surfaces the rejection to the caller.
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

/** A minimal `TerraformInitConfig` used only to exercise `init()` in the cross-subcommand lock tests below. */
const sampleInitConfig: TerraformInitConfig = {
  bucket: 'hyveon-tf-state',
  region: 'us-east-1',
  dynamodbTable: 'hyveon-tf-locks',
};

beforeEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
  mkdirSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  existsSyncMock.mockReset();
  // Default to "plan file exists" so tests that don't care about the
  // pre-spawn existsSync(planFile) guard aren't tripped up by it — only the
  // dedicated "missing planFile" test below overrides this.
  existsSyncMock.mockReturnValue(true);
});

describe('TerraformService.apply stale-plan guard', () => {
  it('should reject with a StalePlanError instance and never call spawn when the supplied tfvarsVersionId no longer matches the head version returned by listVersions', async () => {
    queueSuccessfulResolution();

    const remoteFileStore = stubRemoteFileStore();
    remoteFileStore.listVersions.mockResolvedValue([
      { versionId: 'v2', lastModified: new Date('2024-01-02') },
      { versionId: 'v1', lastModified: new Date('2024-01-01') },
    ]);

    const service = new TerraformService(
      stubApplyConfigService({ tfvarsBucket: 'hyveon-tfvars', tfvarsPath: '/repo/terraform/terraform.tfvars' }),
      remoteFileStore,
    );

    await expect(
      collectApplyChunks(service.apply('run-1', 'v1', '/repo/runs/run-1/run-1.tfplan')),
    ).rejects.toBeInstanceOf(StalePlanError);
    expect(remoteFileStore.listVersions).toHaveBeenCalledWith('terraform.tfvars');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('should proceed to spawn when the supplied tfvarsVersionId matches the head version returned by listVersions', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const remoteFileStore = stubRemoteFileStore();
    remoteFileStore.listVersions.mockResolvedValue([
      { versionId: 'v2', lastModified: new Date('2024-01-02') },
      { versionId: 'v1', lastModified: new Date('2024-01-01') },
    ]);

    const service = new TerraformService(
      stubApplyConfigService({ tfvarsBucket: 'hyveon-tfvars', tfvarsPath: '/repo/terraform/terraform.tfvars' }),
      remoteFileStore,
    );

    await collectApplyChunks(service.apply('run-2', 'v2', '/repo/runs/run-2/run-2.tfplan'), () =>
      child.close(0),
    );

    expect(remoteFileStore.listVersions).toHaveBeenCalledWith('terraform.tfvars');
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/terraform',
      ['apply', '-input=false', '-no-color', '/repo/runs/run-2/run-2.tfplan'],
      { cwd: '/repo/terraform' },
    );
  });

  it('should proceed to spawn without consulting listVersions when no tfvars bucket is configured (local-file mode)', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const remoteFileStore = stubRemoteFileStore();
    const service = new TerraformService(stubApplyConfigService({ tfvarsBucket: null }), remoteFileStore);

    await collectApplyChunks(service.apply('run-3', 'v1', '/repo/runs/run-3/run-3.tfplan'), () =>
      child.close(0),
    );

    expect(remoteFileStore.listVersions).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('should proceed to spawn without consulting listVersions when tfvarsVersionId is omitted', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const remoteFileStore = stubRemoteFileStore();
    const service = new TerraformService(
      stubApplyConfigService({ tfvarsBucket: 'hyveon-tfvars' }),
      remoteFileStore,
    );

    await collectApplyChunks(service.apply('run-4', undefined, '/repo/runs/run-4/run-4.tfplan'), () =>
      child.close(0),
    );

    expect(remoteFileStore.listVersions).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('should reject with a TerraformNotFoundError instance and never call spawn when the binary cannot be resolved', async () => {
    queueExecFileFailure();

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());

    await expect(
      collectApplyChunks(service.apply('run-5', undefined, '/repo/runs/run-5/run-5.tfplan')),
    ).rejects.toBeInstanceOf(TerraformNotFoundError);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('TerraformService.apply streaming', () => {
  it('should yield stdout and stderr lines as they are produced, not only after the process exits', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());
    const { chunks } = await collectApplyChunks(
      service.apply('run-6', undefined, '/repo/runs/run-6/run-6.tfplan'),
      () => {
        child.emitStdout('aws_instance.game: Creating...\n');
        child.emitStderr('Warning: something\n');
        child.close(0);
      },
    );

    expect(chunks).toContainEqual({ stream: 'stdout', line: 'aws_instance.game: Creating...' });
    expect(chunks).toContainEqual({ stream: 'stderr', line: 'Warning: something' });
  });
});

describe('TerraformService.apply summary parsing and return value', () => {
  it('should parse the added/changed/destroyed counts from the Apply complete! summary line and return them alongside runId', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());

    const { result } = await collectApplyChunks(
      service.apply('run-7', undefined, '/repo/runs/run-7/run-7.tfplan'),
      () => {
        child.emitStdout('aws_instance.game: Creation complete\n');
        child.emitStdout('Apply complete! Resources: 3 added, 1 changed, 2 destroyed.\n');
        child.close(0);
      },
    );

    expect(result).toEqual({ runId: 'run-7', added: 3, changed: 1, destroyed: 2 });
  });

  it('should resolve all three counts to 0 when the summary line is never seen despite a clean exit', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());

    const { result } = await collectApplyChunks(
      service.apply('run-8', undefined, '/repo/runs/run-8/run-8.tfplan'),
      () => {
        child.emitStdout('No changes.\n');
        child.close(0);
      },
    );

    expect(result).toEqual({ runId: 'run-8', added: 0, changed: 0, destroyed: 0 });
  });
});

describe('TerraformService.apply exit handling', () => {
  it('should reject with a TerraformApplyError carrying the exit code when the process exits non-zero', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());

    const result = collectApplyChunks(service.apply('run-9', undefined, '/repo/runs/run-9/run-9.tfplan'), () =>
      child.close(1),
    );

    await expect(result).rejects.toBeInstanceOf(TerraformApplyError);
    await expect(result).rejects.toMatchObject({ exitCode: 1 });
  });

  it('should reject when the spawned process itself errors out (e.g. ENOENT)', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());

    const result = collectApplyChunks(
      service.apply('run-10', undefined, '/repo/runs/run-10/run-10.tfplan'),
      () => child.emit('error', new Error('spawn ENOENT')),
    );

    await expect(result).rejects.toThrow('spawn ENOENT');
  });
});

describe('TerraformService.apply planFile existence guard', () => {
  it('should throw a descriptive Error synchronously and never call spawn when planFile does not exist on disk', async () => {
    existsSyncMock.mockReturnValue(false);

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());
    const gen = service.apply('run-25', undefined, '/repo/runs/run-25/run-25.tfplan');

    await expect(gen.next()).rejects.toThrow(/plan file .* does not exist/i);
    expect(existsSyncMock).toHaveBeenCalledWith('/repo/runs/run-25/run-25.tfplan');
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('TerraformService.apply abort handling', () => {
  it('should kill the child process and end the generator cleanly with an undefined return value when the AbortSignal fires mid-run', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const controller = new AbortController();
    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());
    const gen = service.apply('run-11', undefined, '/repo/runs/run-11/run-11.tfplan', controller.signal);

    const pendingNext = gen.next();
    await flushMicrotasks();

    controller.abort();
    // The fake child doesn't auto-emit `close` on `kill()` — simulate the
    // real process actually terminating in response to the kill signal.
    child.close(null);

    const result = await pendingNext;

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it('should end the generator cleanly without resolving the binary or spawning when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());
    const gen = service.apply('run-12', undefined, '/repo/runs/run-12/run-12.tfplan', controller.signal);

    const result = await gen.next();

    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('should end the generator cleanly without consulting listVersions when the signal is already aborted and a tfvarsVersionId + tfvarsBucket are both supplied', async () => {
    const controller = new AbortController();
    controller.abort();

    const remoteFileStore = stubRemoteFileStore();
    const service = new TerraformService(
      stubApplyConfigService({ tfvarsBucket: 'hyveon-tfvars' }),
      remoteFileStore,
    );
    const gen = service.apply('run-26', 'v1', '/repo/runs/run-26/run-26.tfplan', controller.signal);

    const result = await gen.next();

    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
    expect(remoteFileStore.listVersions).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('should end the generator cleanly without spawning when the signal is aborted while resolving the binary path', async () => {
    const controller = new AbortController();
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      controller.abort();
      lastArgAsCallback(args)(null, { stdout: '/usr/local/bin/terraform\n', stderr: '' });
    });
    queueExecFileSuccess(JSON.stringify({ terraform_version: '1.7.0' }));

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());
    const gen = service.apply('run-13', undefined, '/repo/runs/run-13/run-13.tfplan', controller.signal);

    const result = await gen.next();

    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('should end the generator cleanly without spawning when the signal is aborted while the stale-plan guard is checking listVersions', async () => {
    queueSuccessfulResolution();
    const controller = new AbortController();

    const remoteFileStore = stubRemoteFileStore();
    remoteFileStore.listVersions.mockImplementation(async () => {
      controller.abort();
      return [{ versionId: 'v1', lastModified: new Date('2024-01-01') }];
    });

    const service = new TerraformService(
      stubApplyConfigService({ tfvarsBucket: 'hyveon-tfvars' }),
      remoteFileStore,
    );
    const gen = service.apply('run-14', 'v1', '/repo/runs/run-14/run-14.tfplan', controller.signal);

    const result = await gen.next();

    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('should kill the child process and wait for it to close when the generator is force-closed early (e.g. consumer break) before the process exits', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());
    const gen = service.apply('run-15', undefined, '/repo/runs/run-15/run-15.tfplan');

    // Drive the generator to its first yielded chunk, mirroring a consumer
    // that starts iterating (e.g. a `for await...of` loop) but never reaches
    // the child process's `close` event before bailing out.
    const first = gen.next();
    await flushMicrotasks();
    child.emitStdout('aws_instance.game: Creating...\n');
    await first;

    // Simulate the consumer force-closing the generator early (what a
    // `for await...of` `break`/`throw` desugars to under the hood). This
    // should propagate through apply()'s finally into spawnAndStream's
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
});

describe('TerraformService.apply run.json persistence', () => {
  it('should write a run.json record with runId/kind/startedAt/completedAt/exitCode/tfvarsVersionId when the process exits cleanly', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(
      stubApplyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
    );

    await collectApplyChunks(service.apply('run-16', 'v1', '/repo/runs/run-16/run-16.tfplan'), () =>
      child.close(0),
    );

    expect(mkdirSyncMock).toHaveBeenCalledWith('/repo/runs/run-16', { recursive: true });
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    const [path, contents] = writeFileSyncMock.mock.calls[0] as [string, string];
    expect(path).toBe('/repo/runs/run-16/run.json');
    const record = JSON.parse(contents) as TerraformRunRecord;
    expect(record.runId).toBe('run-16');
    expect(record.kind).toBe('apply');
    expect(record.exitCode).toBe(0);
    expect(record.tfvarsVersionId).toBe('v1');
    expect(typeof record.startedAt).toBe('string');
    expect(typeof record.completedAt).toBe('string');
  });

  it('should write a run.json record carrying the actual exit code when the process exits non-zero', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(
      stubApplyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
    );

    await expect(
      collectApplyChunks(service.apply('run-17', undefined, '/repo/runs/run-17/run-17.tfplan'), () =>
        child.close(1),
      ),
    ).rejects.toBeInstanceOf(TerraformApplyError);

    const [path, contents] = writeFileSyncMock.mock.calls[0] as [string, string];
    expect(path).toBe('/repo/runs/run-17/run.json');
    const record = JSON.parse(contents) as TerraformRunRecord;
    expect(record.exitCode).toBe(1);
  });

  it('should write a run.json record with a null exitCode when the run was aborted mid-flight', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const controller = new AbortController();
    const service = new TerraformService(
      stubApplyConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
    );
    const gen = service.apply('run-18', undefined, '/repo/runs/run-18/run-18.tfplan', controller.signal);

    const pendingNext = gen.next();
    await flushMicrotasks();
    controller.abort();
    child.close(null);
    await pendingNext;

    const [path, contents] = writeFileSyncMock.mock.calls[0] as [string, string];
    expect(path).toBe('/repo/runs/run-18/run.json');
    const record = JSON.parse(contents) as TerraformRunRecord;
    expect(record.exitCode).toBeNull();
  });
});

describe('TerraformService.apply concurrency guard', () => {
  it('should throw a descriptive Error from a second apply() call while the first is still in flight', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());
    const firstGen = service.apply('run-19', undefined, '/repo/runs/run-19/run-19.tfplan');
    const firstNext = firstGen.next(); // starts the generator body, setting the in-flight flag synchronously

    const secondGen = service.apply('run-20', undefined, '/repo/runs/run-20/run-20.tfplan');
    await expect(secondGen.next()).rejects.toThrow(/already running/i);

    // Let the first call finish so it doesn't leak into other tests.
    await flushMicrotasks();
    child.close(0);
    await firstNext;
    await firstGen.next();
  });

  it('should allow a new apply() call once the previous one has completed', async () => {
    queueSuccessfulResolution();
    const firstChild = new FakeChildProcess();
    queueSpawn(firstChild);

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());
    await collectApplyChunks(service.apply('run-21', undefined, '/repo/runs/run-21/run-21.tfplan'), () =>
      firstChild.close(0),
    );

    const secondChild = new FakeChildProcess();
    queueSpawn(secondChild);
    const { result } = await collectApplyChunks(
      service.apply('run-22', undefined, '/repo/runs/run-22/run-22.tfplan'),
      () => secondChild.close(0),
    );

    expect(result).toBeDefined();
  });

  it('should allow a new apply() call once the previous one has failed', async () => {
    queueSuccessfulResolution();
    const firstChild = new FakeChildProcess();
    queueSpawn(firstChild);

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());
    await expect(
      collectApplyChunks(service.apply('run-23', undefined, '/repo/runs/run-23/run-23.tfplan'), () =>
        firstChild.close(1),
      ),
    ).rejects.toBeInstanceOf(TerraformApplyError);

    const secondChild = new FakeChildProcess();
    queueSpawn(secondChild);
    const { result } = await collectApplyChunks(
      service.apply('run-24', undefined, '/repo/runs/run-24/run-24.tfplan'),
      () => secondChild.close(0),
    );

    expect(result).toBeDefined();
  });
});

describe('TerraformService.apply cross-subcommand lock enforcement', () => {
  it('should throw a descriptive Error from apply() when plan() is already running against the same workspace', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());
    const planGen = service.plan();
    const planNext = planGen.next(); // starts plan()'s body, setting the shared in-flight flag synchronously

    const applyGen = service.apply('run-27', undefined, '/repo/runs/run-27/run-27.tfplan');
    await expect(applyGen.next()).rejects.toThrow(/plan\(\) is already running/i);

    // Let the in-flight plan() finish so it doesn't leak into other tests.
    await flushMicrotasks();
    child.close(0);
    await planNext;
    await planGen.next();
  });

  it('should throw a descriptive Error from apply() when init() is already running against the same workspace', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());
    const initGen = service.init(sampleInitConfig);
    const initNext = initGen.next(); // starts init()'s body, setting the shared in-flight flag synchronously

    const applyGen = service.apply('run-28', undefined, '/repo/runs/run-28/run-28.tfplan');
    await expect(applyGen.next()).rejects.toThrow(/init\(\) is already running/i);

    // Let the in-flight init() finish so it doesn't leak into other tests.
    await flushMicrotasks();
    child.close(0);
    await initNext;
    await initGen.next();
  });

  it('should throw a descriptive Error from plan() when apply() is already running against the same workspace', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());
    const applyGen = service.apply('run-29', undefined, '/repo/runs/run-29/run-29.tfplan');
    const applyNext = applyGen.next(); // starts apply()'s body, setting the shared in-flight flag synchronously

    const planGen = service.plan();
    await expect(planGen.next()).rejects.toThrow(/apply\(\) is already running/i);

    // Let the in-flight apply() finish so it doesn't leak into other tests.
    await flushMicrotasks();
    child.close(0);
    await applyNext;
    await applyGen.next();
  });

  it('should throw a descriptive Error from init() when apply() is already running against the same workspace', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubApplyConfigService(), stubRemoteFileStore());
    const applyGen = service.apply('run-30', undefined, '/repo/runs/run-30/run-30.tfplan');
    const applyNext = applyGen.next(); // starts apply()'s body, setting the shared in-flight flag synchronously

    const initGen = service.init(sampleInitConfig);
    await expect(initGen.next()).rejects.toThrow(/apply\(\) is already running/i);

    // Let the in-flight apply() finish so it doesn't leak into other tests.
    await flushMicrotasks();
    child.close(0);
    await applyNext;
    await applyGen.next();
  });
});
