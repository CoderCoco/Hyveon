import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * Spy variables must be hoisted before vi.mock() factories run, because
 * vi.mock() calls are lifted to the top of the compiled output above regular
 * declarations.
 */
const {
  execFileMock,
  spawnMock,
  mkdirSyncMock,
  existsSyncMock,
  writeFileSyncMock,
  copyFileSyncMock,
  randomUUIDMock,
} = vi.hoisted(() => {
  const execFileMock = vi.fn();
  const spawnMock = vi.fn();
  const mkdirSyncMock = vi.fn();
  const existsSyncMock = vi.fn();
  const writeFileSyncMock = vi.fn();
  const copyFileSyncMock = vi.fn();
  const randomUUIDMock = vi.fn();
  return {
    execFileMock,
    spawnMock,
    mkdirSyncMock,
    existsSyncMock,
    writeFileSyncMock,
    copyFileSyncMock,
    randomUUIDMock,
  };
});

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

vi.mock('node:fs', () => ({
  mkdirSync: mkdirSyncMock,
  existsSync: existsSyncMock,
  writeFileSync: writeFileSyncMock,
  copyFileSync: copyFileSyncMock,
}));

vi.mock('node:crypto', () => ({
  randomUUID: randomUUIDMock,
}));

import {
  TerraformService,
  TerraformNotFoundError,
  TerraformPlanError,
  type TerraformRunChunk,
  type TerraformPlanResult,
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
 * `ConfigService` stub for `plan()` tests: exposes `getTerraformDir`,
 * `getRunsDir`, `getTfvarsBucket`, and `getTfvarsPath` — the accessors
 * `plan()` reads.
 */
function stubPlanConfigService(
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
 * constructor dependency. `get`/`put`/`listVersions` are directly-controllable
 * mocks so S3-mode `plan()` tests can queue a tfvars object response.
 */
function stubRemoteFileStore(): RemoteFileStore & {
  get: ReturnType<typeof vi.fn>;
  listVersions: ReturnType<typeof vi.fn>;
} {
  const store: Partial<RemoteFileStore> = {
    get: vi.fn(),
    put: vi.fn(),
    listVersions: vi.fn(),
  };
  return store as RemoteFileStore & {
    get: ReturnType<typeof vi.fn>;
    listVersions: ReturnType<typeof vi.fn>;
  };
}

/**
 * A fake `child_process.ChildProcess` sufficient for exercising `plan()`'s
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
 * boundary) before returning. `plan()` awaits the binary/version resolution
 * plus the tfvars pull (itself a chain of promises) before it reaches the
 * `spawn()` call and registers listeners on the child process, so tests must
 * flush past that chain before driving `child.emitStdout`/`close`/`error` —
 * otherwise those events fire before any listener has been attached.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drains a `plan()` async generator to completion, collecting every yielded
 * chunk plus the generator's final return value — a `TerraformPlanResult` on
 * success, or `undefined` on a clean abort. `driveChild` is invoked once
 * (after the first `.next()` has been issued so the child process is spawned
 * and listeners are attached) to let the caller emit data/close/error events
 * on the fake child at the right moment relative to iteration.
 */
async function collectPlanChunks(
  gen: AsyncGenerator<TerraformRunChunk, TerraformPlanResult | undefined>,
  driveChild?: () => void,
): Promise<{ chunks: TerraformRunChunk[]; result: TerraformPlanResult | undefined }> {
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

beforeEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
  mkdirSyncMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
  writeFileSyncMock.mockReset();
  copyFileSyncMock.mockReset();
  randomUUIDMock.mockReset();
  randomUUIDMock.mockReturnValue('run-123');
});

describe('TerraformService.plan spawning and artifact persistence', () => {
  it('should mint a runId, create its runs-dir, pull the local tfvars snapshot, and spawn terraform plan with -out/-var-file derived from them', async () => {
    queueSuccessfulResolution('/usr/local/bin/terraform', '1.7.0');
    randomUUIDMock.mockReturnValue('run-123');
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(
      stubPlanConfigService({
        terraformDir: '/repo/terraform',
        runsDir: '/repo/runs',
        tfvarsBucket: null,
        tfvarsPath: '/repo/terraform/terraform.tfvars',
      }),
      stubRemoteFileStore(),
    );

    await collectPlanChunks(service.plan(), () => child.close(0));

    expect(mkdirSyncMock).toHaveBeenCalledWith('/repo/runs/run-123', { recursive: true });
    expect(copyFileSyncMock).toHaveBeenCalledWith(
      '/repo/terraform/terraform.tfvars',
      '/repo/runs/run-123/terraform.tfvars',
    );
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/terraform',
      [
        'plan',
        '-input=false',
        '-no-color',
        '-out=/repo/runs/run-123/run-123.tfplan',
        '-var-file=/repo/runs/run-123/terraform.tfvars',
      ],
      { cwd: '/repo/terraform' },
    );
  });

  it('should pull the tfvars snapshot from the RemoteFileStore instead of the local filesystem when a tfvars bucket is configured', async () => {
    queueSuccessfulResolution();
    randomUUIDMock.mockReturnValue('run-456');
    const child = new FakeChildProcess();
    queueSpawn(child);

    const remoteFileStore = stubRemoteFileStore();
    remoteFileStore.get.mockResolvedValue({
      body: new TextEncoder().encode('game_servers = {}'),
      etag: 'etag-1',
    });

    const service = new TerraformService(
      stubPlanConfigService({ tfvarsBucket: 'hyveon-tfvars', tfvarsPath: '/repo/terraform/terraform.tfvars' }),
      remoteFileStore,
    );

    await collectPlanChunks(service.plan(), () => child.close(0));

    expect(remoteFileStore.get).toHaveBeenCalledWith('terraform.tfvars');
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      '/repo/runs/run-456/terraform.tfvars',
      expect.any(Uint8Array),
    );
    expect(copyFileSyncMock).not.toHaveBeenCalled();
  });

  it('should proceed to spawn when the supplied tfvarsVersionId matches the head version returned by listVersions', async () => {
    queueSuccessfulResolution();
    randomUUIDMock.mockReturnValue('run-999');
    const child = new FakeChildProcess();
    queueSpawn(child);

    const remoteFileStore = stubRemoteFileStore();
    remoteFileStore.listVersions.mockResolvedValue([
      { versionId: 'v2', lastModified: new Date('2024-01-02') },
      { versionId: 'v1', lastModified: new Date('2024-01-01') },
    ]);
    remoteFileStore.get.mockResolvedValue({
      body: new TextEncoder().encode('game_servers = {}'),
      etag: 'etag-1',
    });

    const service = new TerraformService(
      stubPlanConfigService({ tfvarsBucket: 'hyveon-tfvars', tfvarsPath: '/repo/terraform/terraform.tfvars' }),
      remoteFileStore,
    );

    await collectPlanChunks(service.plan('v2'), () => child.close(0));

    expect(remoteFileStore.listVersions).toHaveBeenCalledWith('terraform.tfvars');
    expect(remoteFileStore.get).toHaveBeenCalledWith('terraform.tfvars');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('should reject and never call spawn when the supplied tfvarsVersionId no longer matches the head version returned by listVersions', async () => {
    queueSuccessfulResolution();

    const remoteFileStore = stubRemoteFileStore();
    remoteFileStore.listVersions.mockResolvedValue([
      { versionId: 'v2', lastModified: new Date('2024-01-02') },
      { versionId: 'v1', lastModified: new Date('2024-01-01') },
    ]);

    const service = new TerraformService(
      stubPlanConfigService({ tfvarsBucket: 'hyveon-tfvars', tfvarsPath: '/repo/terraform/terraform.tfvars' }),
      remoteFileStore,
    );

    await expect(collectPlanChunks(service.plan('v1'))).rejects.toThrow(/stale/i);
    expect(remoteFileStore.listVersions).toHaveBeenCalledWith('terraform.tfvars');
    expect(remoteFileStore.get).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('should reject and never call spawn when the S3 tfvars object is missing from the bucket', async () => {
    queueSuccessfulResolution();

    const remoteFileStore = stubRemoteFileStore();
    remoteFileStore.get.mockResolvedValue(null);

    const service = new TerraformService(
      stubPlanConfigService({ tfvarsBucket: 'hyveon-tfvars', tfvarsPath: '/repo/terraform/terraform.tfvars' }),
      remoteFileStore,
    );

    await expect(collectPlanChunks(service.plan())).rejects.toThrow(/not found in S3 bucket/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('should reject and never call spawn when the local tfvars source does not exist', async () => {
    queueSuccessfulResolution();
    existsSyncMock.mockReturnValue(false);

    const service = new TerraformService(stubPlanConfigService({ tfvarsBucket: null }), stubRemoteFileStore());

    await expect(collectPlanChunks(service.plan())).rejects.toThrow(/tfvars file not found/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('should reject with a TerraformNotFoundError instance and never call spawn when the binary cannot be resolved', async () => {
    queueExecFileFailure();

    const service = new TerraformService(stubPlanConfigService(), stubRemoteFileStore());

    await expect(collectPlanChunks(service.plan())).rejects.toBeInstanceOf(TerraformNotFoundError);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('TerraformService.plan streaming', () => {
  it('should yield stdout and stderr lines as they are produced, not only after the process exits', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubPlanConfigService(), stubRemoteFileStore());
    const { chunks } = await collectPlanChunks(service.plan(), () => {
      child.emitStdout('Refreshing state...\n');
      child.emitStderr('Warning: something\n');
      child.close(0);
    });

    expect(chunks).toContainEqual({ stream: 'stdout', line: 'Refreshing state...' });
    expect(chunks).toContainEqual({ stream: 'stderr', line: 'Warning: something' });
  });

  it('should split a single data event containing multiple lines into one chunk per line', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubPlanConfigService(), stubRemoteFileStore());
    const { chunks } = await collectPlanChunks(service.plan(), () => {
      child.emitStdout('line one\nline two\nline three\n');
      child.close(0);
    });

    expect(chunks).toEqual([
      { stream: 'stdout', line: 'line one' },
      { stream: 'stdout', line: 'line two' },
      { stream: 'stdout', line: 'line three' },
    ]);
  });
});

describe('TerraformService.plan run log capture', () => {
  it('should write the accumulated stdout+stderr transcript to <runsDir>/<runId>/terraform.log in a single writeFileSync once the process closes', async () => {
    queueSuccessfulResolution();
    randomUUIDMock.mockReturnValue('run-log-1');
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(
      stubPlanConfigService({ runsDir: '/repo/runs', tfvarsBucket: null }),
      stubRemoteFileStore(),
    );

    await collectPlanChunks(service.plan(), () => {
      child.emitStdout('Refreshing state...\n');
      child.emitStderr('Warning: something\n');
      child.close(0);
    });

    const logCalls = writeFileSyncMock.mock.calls.filter(
      ([path]) => path === '/repo/runs/run-log-1/terraform.log',
    );
    expect(logCalls).toHaveLength(1);
    const [, contents] = logCalls[0] as [string, string];
    expect(contents).toBe('Refreshing state...\nWarning: something\n');
  });

  it('should still write the accumulated transcript to terraform.log when the process exits non-zero', async () => {
    queueSuccessfulResolution();
    randomUUIDMock.mockReturnValue('run-log-2');
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(
      stubPlanConfigService({ runsDir: '/repo/runs', tfvarsBucket: null }),
      stubRemoteFileStore(),
    );

    await expect(
      collectPlanChunks(service.plan(), () => {
        child.emitStdout('Error: something went wrong\n');
        child.close(1);
      }),
    ).rejects.toBeInstanceOf(TerraformPlanError);

    const logCalls = writeFileSyncMock.mock.calls.filter(
      ([path]) => path === '/repo/runs/run-log-2/terraform.log',
    );
    expect(logCalls).toHaveLength(1);
    const [, contents] = logCalls[0] as [string, string];
    expect(contents).toBe('Error: something went wrong\n');
  });

  it('should still write whatever transcript was captured to terraform.log when the run is aborted mid-flight', async () => {
    queueSuccessfulResolution();
    randomUUIDMock.mockReturnValue('run-log-3');
    const child = new FakeChildProcess();
    queueSpawn(child);

    const controller = new AbortController();
    const service = new TerraformService(
      stubPlanConfigService({ runsDir: '/repo/runs', tfvarsBucket: null }),
      stubRemoteFileStore(),
    );
    const gen = service.plan(undefined, controller.signal);

    const first = gen.next();
    await flushMicrotasks();
    child.emitStdout('Refreshing state...\n');
    const firstResult = await first;
    expect(firstResult.done).toBe(false);

    controller.abort();
    // The fake child doesn't auto-emit `close` on `kill()` — simulate the
    // real process actually terminating in response to the kill signal.
    child.close(null);

    const secondResult = await gen.next();
    expect(secondResult.done).toBe(true);
    expect(secondResult.value).toBeUndefined();

    const logCalls = writeFileSyncMock.mock.calls.filter(
      ([path]) => path === '/repo/runs/run-log-3/terraform.log',
    );
    expect(logCalls).toHaveLength(1);
    const [, contents] = logCalls[0] as [string, string];
    expect(contents).toBe('Refreshing state...\n');
  });
});

describe('TerraformService.plan summary parsing and return value', () => {
  it('should parse the add/change/destroy counts from the Plan: summary line and return them alongside the artifact/var-file paths', async () => {
    queueSuccessfulResolution();
    randomUUIDMock.mockReturnValue('run-789');
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(
      stubPlanConfigService({ runsDir: '/repo/runs' }),
      stubRemoteFileStore(),
    );

    const { result } = await collectPlanChunks(service.plan(), () => {
      child.emitStdout('Terraform will perform the following actions:\n');
      child.emitStdout('Plan: 3 to add, 1 to change, 2 to destroy.\n');
      child.close(0);
    });

    expect(result).toEqual({
      runId: 'run-789',
      artifactPath: '/repo/runs/run-789/run-789.tfplan',
      varFilePath: '/repo/runs/run-789/terraform.tfvars',
      add: 3,
      change: 1,
      destroy: 2,
    });
  });

  it('should resolve all three counts to 0 when the plan has no changes', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubPlanConfigService(), stubRemoteFileStore());

    const { result } = await collectPlanChunks(service.plan(), () => {
      child.emitStdout('No changes. Your infrastructure matches the configuration.\n');
      child.close(0);
    });

    expect(result).toMatchObject({ add: 0, change: 0, destroy: 0 });
  });
});

describe('TerraformService.plan exit handling', () => {
  it('should reject with a TerraformPlanError carrying the exit code when the process exits non-zero', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubPlanConfigService(), stubRemoteFileStore());

    const result = collectPlanChunks(service.plan(), () => child.close(1));

    await expect(result).rejects.toBeInstanceOf(TerraformPlanError);
    await expect(result).rejects.toMatchObject({ exitCode: 1 });
  });

  it('should reject when the spawned process itself errors out (e.g. ENOENT)', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubPlanConfigService(), stubRemoteFileStore());

    const result = collectPlanChunks(service.plan(), () => child.emit('error', new Error('spawn ENOENT')));

    await expect(result).rejects.toThrow('spawn ENOENT');
  });
});

describe('TerraformService.plan abort handling', () => {
  it('should kill the child process and end the generator cleanly with an undefined return value when the AbortSignal fires mid-run', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const controller = new AbortController();
    const service = new TerraformService(stubPlanConfigService(), stubRemoteFileStore());
    const gen = service.plan(undefined, controller.signal);

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

    const service = new TerraformService(stubPlanConfigService(), stubRemoteFileStore());
    const gen = service.plan(undefined, controller.signal);

    const result = await gen.next();

    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
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

    const service = new TerraformService(stubPlanConfigService(), stubRemoteFileStore());
    const gen = service.plan(undefined, controller.signal);

    const result = await gen.next();

    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('should end the generator cleanly without spawning when the signal is aborted while pulling the tfvars snapshot', async () => {
    queueSuccessfulResolution();
    const controller = new AbortController();

    const remoteFileStore = stubRemoteFileStore();
    remoteFileStore.get.mockImplementation(async () => {
      controller.abort();
      return { body: new TextEncoder().encode('game_servers = {}'), etag: 'etag-1' };
    });

    const service = new TerraformService(
      stubPlanConfigService({ tfvarsBucket: 'hyveon-tfvars' }),
      remoteFileStore,
    );
    const gen = service.plan(undefined, controller.signal);

    const result = await gen.next();

    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('should kill the child process and wait for it to close when the generator is force-closed early (e.g. consumer break) before the process exits', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubPlanConfigService(), stubRemoteFileStore());
    const gen = service.plan();

    // Drive the generator to its first yielded chunk, mirroring a consumer
    // that starts iterating (e.g. a `for await...of` loop) but never reaches
    // the child process's `close` event before bailing out.
    const first = gen.next();
    await flushMicrotasks();
    child.emitStdout('Refreshing state...\n');
    await first;

    // Simulate the consumer force-closing the generator early (what a
    // `for await...of` `break`/`throw` desugars to under the hood). This
    // should propagate through plan()'s finally into spawnAndStream's
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

describe('TerraformService.plan concurrency guard', () => {
  it('should throw a descriptive Error from a second plan() call while the first is still in flight', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubPlanConfigService(), stubRemoteFileStore());
    const firstGen = service.plan();
    const firstNext = firstGen.next(); // starts the generator body, setting the in-flight flag synchronously

    const secondGen = service.plan();
    await expect(secondGen.next()).rejects.toThrow(/already running/i);

    // Let the first call finish so it doesn't leak into other tests.
    await flushMicrotasks();
    child.close(0);
    await firstNext;
    await firstGen.next();
  });

  it('should allow a new plan() call once the previous one has completed', async () => {
    queueSuccessfulResolution();
    const firstChild = new FakeChildProcess();
    queueSpawn(firstChild);

    const service = new TerraformService(stubPlanConfigService(), stubRemoteFileStore());
    await collectPlanChunks(service.plan(), () => firstChild.close(0));

    const secondChild = new FakeChildProcess();
    queueSpawn(secondChild);
    const { result } = await collectPlanChunks(service.plan(), () => secondChild.close(0));

    expect(result).toBeDefined();
  });

  it('should allow a new plan() call once the previous one has failed', async () => {
    queueSuccessfulResolution();
    const firstChild = new FakeChildProcess();
    queueSpawn(firstChild);

    const service = new TerraformService(stubPlanConfigService(), stubRemoteFileStore());
    await expect(
      collectPlanChunks(service.plan(), () => firstChild.close(1)),
    ).rejects.toBeInstanceOf(TerraformPlanError);

    const secondChild = new FakeChildProcess();
    queueSpawn(secondChild);
    const { result } = await collectPlanChunks(service.plan(), () => secondChild.close(0));

    expect(result).toBeDefined();
  });
});
