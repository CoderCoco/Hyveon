import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * Spy variables must be hoisted before vi.mock() factories run, because
 * vi.mock() calls are lifted to the top of the compiled output above regular
 * declarations.
 */
const { execFileMock, spawnMock, mkdirSyncMock, existsSyncMock, writeFileSyncMock, copyFileSyncMock, randomUUIDMock } =
  vi.hoisted(() => {
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
  TerraformInitError,
  TerraformPlanError,
  type TerraformInitConfig,
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
 * Minimal `ConfigService` stub sufficient to satisfy `TerraformService`'s
 * constructor dependency and its `getTerraformDir()` call from `init()`.
 */
function stubConfigService(terraformDir = '/repo/terraform'): ConfigService {
  return { getTerraformDir: () => terraformDir } as ConfigService;
}

/**
 * `ConfigService` stub for `plan()` tests: exposes `getTerraformDir`,
 * `getRunsDir`, `getTfvarsBucket`, and `getTfvarsPath` — the accessors
 * `plan()` reads, beyond the narrower `getTerraformDir()`-only stub above
 * that's sufficient for `init()`.
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
 * A fake `child_process.ChildProcess` sufficient for exercising `init()`'s
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
 * boundary) before returning. `init()` awaits the binary/version resolution
 * (itself a chain of `execFileAsync` promises) before it reaches the
 * `spawn()` call and registers listeners on the child process, so tests must
 * flush past that chain before driving `child.emitStdout`/`close`/`error` —
 * otherwise those events fire before any listener has been attached.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drains an `init()` async generator to completion, collecting every yielded
 * chunk. `driveChild` is invoked once (after the first `.next()` has been
 * issued so the child process is spawned and listeners are attached) to let
 * the caller emit data/close/error events on the fake child at the right
 * moment relative to iteration.
 */
async function collectAllChunks(
  gen: AsyncGenerator<TerraformRunChunk, void>,
  driveChild?: () => void,
): Promise<TerraformRunChunk[]> {
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
  let result = await first;
  while (!result.done) {
    chunks.push(result.value);
    const next = gen.next();
    next.catch(() => {});
    result = await next;
  }
  return chunks;
}

/**
 * Drains a `plan()` async generator to completion, collecting every yielded
 * chunk plus the generator's final return value — a `TerraformPlanResult` on
 * success, or `undefined` on a clean abort. Mirrors {@link collectAllChunks}
 * but also captures the return value, which `plan()` (unlike `init()`)
 * resolves with on success.
 */
async function collectPlanChunks(
  gen: AsyncGenerator<TerraformRunChunk, TerraformPlanResult | undefined>,
  driveChild?: () => void,
): Promise<{ chunks: TerraformRunChunk[]; result: TerraformPlanResult | undefined }> {
  const chunks: TerraformRunChunk[] = [];
  const first = gen.next();
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

const sampleConfig: TerraformInitConfig = {
  bucket: 'hyveon-tf-state',
  region: 'us-east-1',
  dynamodbTable: 'hyveon-tf-locks',
};

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

describe('TerraformService.init spawning', () => {
  it('should spawn terraform init with backend-config args derived from the resolved binary path and terraform dir', async () => {
    queueSuccessfulResolution('/usr/local/bin/terraform', '1.7.0');
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubConfigService('/repo/terraform'), stubRemoteFileStore());

    await collectAllChunks(service.init(sampleConfig), () => child.close(0));

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/terraform',
      [
        'init',
        '-input=false',
        '-no-color',
        '-backend-config=bucket=hyveon-tf-state',
        '-backend-config=region=us-east-1',
        '-backend-config=dynamodb_table=hyveon-tf-locks',
      ],
      { cwd: '/repo/terraform' },
    );
  });

  it('should reject with a TerraformNotFoundError instance and never call spawn when the binary cannot be resolved', async () => {
    queueExecFileFailure();

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());

    await expect(collectAllChunks(service.init(sampleConfig))).rejects.toBeInstanceOf(
      TerraformNotFoundError,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('TerraformService.init streaming', () => {
  it('should yield each stdout line as it is produced, not only after the process exits', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());
    const gen = service.init(sampleConfig);

    const first = gen.next();
    await flushMicrotasks();
    child.emitStdout('Initializing the backend...\n');
    const firstResult = await first;
    expect(firstResult).toEqual({
      value: { stream: 'stdout', line: 'Initializing the backend...' },
      done: false,
    });

    const second = gen.next();
    child.emitStdout('Terraform has been successfully initialized!\n');
    child.close(0);
    const secondResult = await second;

    expect(secondResult).toEqual({
      value: { stream: 'stdout', line: 'Terraform has been successfully initialized!' },
      done: false,
    });

    const finalResult = await gen.next();
    expect(finalResult.done).toBe(true);
  });

  it('should yield stderr lines tagged as the stderr stream', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());
    const chunks = await collectAllChunks(service.init(sampleConfig), () => {
      child.emitStderr('Warning: something\n');
      child.close(0);
    });

    expect(chunks).toContainEqual({ stream: 'stderr', line: 'Warning: something' });
  });

  it('should split a single data event containing multiple lines into one chunk per line', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());
    const chunks = await collectAllChunks(service.init(sampleConfig), () => {
      child.emitStdout('line one\nline two\nline three\n');
      child.close(0);
    });

    expect(chunks).toEqual([
      { stream: 'stdout', line: 'line one' },
      { stream: 'stdout', line: 'line two' },
      { stream: 'stdout', line: 'line three' },
    ]);
  });

  it('should flush a trailing partial line without a terminating newline once the process closes', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());
    const chunks = await collectAllChunks(service.init(sampleConfig), () => {
      child.emitStdout('no trailing newline');
      child.close(0);
    });

    expect(chunks).toContainEqual({ stream: 'stdout', line: 'no trailing newline' });
  });

  it('should complete with no chunks when the process produces no output', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());
    const chunks = await collectAllChunks(service.init(sampleConfig), () => child.close(0));

    expect(chunks).toEqual([]);
  });
});

describe('TerraformService.init exit handling', () => {
  it('should complete normally when the spawned process exits with code 0', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());

    await expect(collectAllChunks(service.init(sampleConfig), () => child.close(0))).resolves.toEqual(
      [],
    );
  });

  it('should reject with a TerraformInitError carrying the exit code when the process exits non-zero', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());

    const result = collectAllChunks(service.init(sampleConfig), () => child.close(1));

    await expect(result).rejects.toBeInstanceOf(TerraformInitError);
    await expect(result).rejects.toMatchObject({ exitCode: 1 });
  });

  it('should reject when the spawned process itself errors out (e.g. ENOENT)', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());

    const result = collectAllChunks(service.init(sampleConfig), () =>
      child.emit('error', new Error('spawn ENOENT')),
    );

    await expect(result).rejects.toThrow('spawn ENOENT');
  });
});

describe('TerraformService.init idempotency', () => {
  it('should complete a second init() call with an identical config without calling spawn again', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());
    await collectAllChunks(service.init(sampleConfig), () => child.close(0));

    expect(spawnMock).toHaveBeenCalledTimes(1);

    await collectAllChunks(service.init({ ...sampleConfig }));

    // The second call must be a genuine no-op: spawn is not invoked again.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('should yield exactly one informational stdout chunk and return without spawning when the config is unchanged', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());
    await collectAllChunks(service.init(sampleConfig), () => child.close(0));

    spawnMock.mockClear();

    const secondChunks = await collectAllChunks(service.init({ ...sampleConfig }));

    expect(secondChunks).toHaveLength(1);
    expect(secondChunks[0]?.stream).toBe('stdout');
    expect(secondChunks[0]?.line).toContain('backend config unchanged');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('should spawn again when a subsequent init() call uses a different backend config', async () => {
    queueSuccessfulResolution();
    const firstChild = new FakeChildProcess();
    queueSpawn(firstChild);

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());
    await collectAllChunks(service.init(sampleConfig), () => firstChild.close(0));

    expect(spawnMock).toHaveBeenCalledTimes(1);

    const secondChild = new FakeChildProcess();
    queueSpawn(secondChild);
    await collectAllChunks(service.init({ ...sampleConfig, bucket: 'a-different-bucket' }), () =>
      secondChild.close(0),
    );

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('should not memoize a failed init() call, so a retry with the same config spawns again', async () => {
    queueSuccessfulResolution();
    const firstChild = new FakeChildProcess();
    queueSpawn(firstChild);

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());
    await expect(
      collectAllChunks(service.init(sampleConfig), () => firstChild.close(1)),
    ).rejects.toBeInstanceOf(TerraformInitError);

    const secondChild = new FakeChildProcess();
    queueSpawn(secondChild);
    await expect(
      collectAllChunks(service.init(sampleConfig), () => secondChild.close(0)),
    ).resolves.toEqual([]);

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});

describe('TerraformService.init abort handling', () => {
  it('should kill the child process and end the generator cleanly when the AbortSignal fires mid-run', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const controller = new AbortController();
    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());
    const gen = service.init(sampleConfig, controller.signal);

    const pendingNext = gen.next();
    await flushMicrotasks();

    controller.abort();
    // The fake child doesn't auto-emit `close` on `kill()` — simulate the
    // real process actually terminating in response to the kill signal.
    child.close(null);

    const result = await pendingNext;

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(result.done).toBe(true);

    // Iterating further keeps returning done, never throwing.
    await expect(gen.next()).resolves.toMatchObject({ done: true });
  });

  it('should end the generator cleanly without resolving the binary or spawning when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());
    const gen = service.init(sampleConfig, controller.signal);

    const result = await gen.next();

    expect(result.done).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('should not update the memoized config when a run is aborted, so a later identical config still spawns', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const controller = new AbortController();
    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());

    const pendingNext = service.init(sampleConfig, controller.signal).next();
    await flushMicrotasks();
    controller.abort();
    child.close(null);
    await pendingNext;

    const secondChild = new FakeChildProcess();
    queueSpawn(secondChild);
    await collectAllChunks(service.init({ ...sampleConfig }), () => secondChild.close(0));

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});

describe('TerraformService.init concurrency guard', () => {
  it('should throw a descriptive Error from a second init() call while the first is still in flight', async () => {
    queueSuccessfulResolution();
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());
    const firstGen = service.init(sampleConfig);
    const firstNext = firstGen.next(); // starts the generator body, setting the in-flight flag synchronously

    const secondGen = service.init(sampleConfig);
    await expect(secondGen.next()).rejects.toThrow(/already running/i);

    // Let the first call finish so it doesn't leak into other tests.
    await flushMicrotasks();
    child.close(0);
    await firstNext;
    await firstGen.next();
  });

  it('should allow a new init() call once the previous one has completed', async () => {
    queueSuccessfulResolution();
    const firstChild = new FakeChildProcess();
    queueSpawn(firstChild);

    const service = new TerraformService(stubConfigService(), stubRemoteFileStore());
    await collectAllChunks(service.init(sampleConfig), () => firstChild.close(0));

    const secondChild = new FakeChildProcess();
    queueSpawn(secondChild);
    await expect(
      collectAllChunks(service.init({ ...sampleConfig, bucket: 'another-bucket' }), () =>
        secondChild.close(0),
      ),
    ).resolves.toEqual([]);
  });
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
});
