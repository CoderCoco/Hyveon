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
  readFileSyncMock,
  randomUUIDMock,
  runRecordPersistMock,
} = vi.hoisted(() => {
  const execFileMock = vi.fn();
  const spawnMock = vi.fn();
  const mkdirSyncMock = vi.fn();
  const existsSyncMock = vi.fn();
  const writeFileSyncMock = vi.fn();
  const copyFileSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  const randomUUIDMock = vi.fn();
  const runRecordPersistMock = vi.fn();
  return {
    execFileMock,
    spawnMock,
    mkdirSyncMock,
    existsSyncMock,
    writeFileSyncMock,
    copyFileSyncMock,
    readFileSyncMock,
    randomUUIDMock,
    runRecordPersistMock,
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
  readFileSync: readFileSyncMock,
}));

// `createHash` is delegated to the real `node:crypto` implementation (rather
// than mocked) so `computePlanHash`'s digest reflects whatever
// `readFileSyncMock` returns for a given test — only `randomUUID` needs to be
// controllable.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: randomUUIDMock,
  };
});

import { TerraformService, type TerraformRunChunk, type TerraformRunRecord } from './TerraformService.js';
import type { ConfigService } from './ConfigService.js';
import type { RunRecordService } from './RunRecordService.js';
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

/** Queues a successful binary lookup followed by a successful `-json` version response. */
function queueSuccessfulResolution(binaryPath = '/usr/local/bin/terraform', version = '1.7.0'): void {
  queueExecFileSuccess(`${binaryPath}\n`);
  queueExecFileSuccess(JSON.stringify({ terraform_version: version }));
}

/**
 * `ConfigService` stub sufficient for `plan()`/`streamRunOutput()`/
 * `readRunRecord()`/`hasPlanArtifact()` tests: exposes `getTerraformDir`, `getRunsDir`,
 * `getTfvarsBucket`, and `getTfvarsPath` — the accessors those methods read.
 */
function stubConfigService(
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
 * constructor dependency for these tests, which all exercise local-file
 * tfvars mode.
 */
function stubRemoteFileStore(): RemoteFileStore {
  return {
    get: vi.fn(),
    put: vi.fn(),
    listVersions: vi.fn(),
  } as Partial<RemoteFileStore> as RemoteFileStore;
}

/**
 * `RunRecordService` stub: `persist` is backed by the shared, hoisted
 * `runRecordPersistMock` so tests don't need to care about its resolution —
 * it defaults to resolving `undefined`, matching the real best-effort
 * contract.
 */
function stubRunRecordService(): RunRecordService {
  return { persist: runRecordPersistMock } as Partial<RunRecordService> as RunRecordService;
}

/**
 * A fake `child_process.ChildProcess` sufficient for driving `plan()`'s
 * streaming logic from a test: an `EventEmitter` standing in for the process
 * itself, with `stdout`/`stderr` sub-emitters standing in for the piped
 * streams. Tests drive it manually via `emitStdout`/`close` rather than
 * relying on any real process lifecycle.
 */
class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn();

  emitStdout(chunk: string): void {
    this.stdout.emit('data', Buffer.from(chunk));
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
 * boundary) before returning — see the equivalent helper in
 * `TerraformService.plan.test.ts` for the full rationale.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Continuously drains a `plan()` (or `apply()`/`destroy()`) async generator
 * in the background — mirroring what a real IPC handler forwarding chunks to
 * a renderer would do — so `TerraformService`'s internal `recordRunChunk`/
 * `endActiveRun` hooks actually fire as the underlying process streams
 * output. Returns a promise that resolves with every yielded chunk plus the
 * generator's final return value once the run completes.
 */
async function drainInBackground<TReturn>(
  gen: AsyncGenerator<TerraformRunChunk, TReturn>,
): Promise<{ chunks: TerraformRunChunk[]; result: TReturn }> {
  const chunks: TerraformRunChunk[] = [];
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await gen.next();
  }
  return { chunks, result: next.value };
}

/** Collects every chunk (and the final `done` signal) a `streamRunOutput()` generator yields, without blocking on completion. */
async function collectStreamChunks(gen: AsyncGenerator<TerraformRunChunk, void>): Promise<TerraformRunChunk[]> {
  const chunks: TerraformRunChunk[] = [];
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await gen.next();
  }
  return chunks;
}

beforeEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
  mkdirSyncMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
  writeFileSyncMock.mockReset();
  copyFileSyncMock.mockReset();
  readFileSyncMock.mockReset();
  // Default so a successful `plan()`'s post-exit `computePlanHash()` read of
  // the `.tfplan` artifact has bytes to hash; tests that care about a
  // specific `readFileSync` return value (e.g. replaying `terraform.log`)
  // override this with their own `mockReturnValue` as before.
  readFileSyncMock.mockReturnValue(Buffer.from(''));
  randomUUIDMock.mockReset();
  randomUUIDMock.mockReturnValue('run-123');
  runRecordPersistMock.mockReset();
});

function buildService(): TerraformService {
  return new TerraformService(
    stubConfigService({ runsDir: '/repo/runs', tfvarsBucket: null }),
    stubRemoteFileStore(),
    stubRunRecordService(),
  );
}

describe('TerraformService.streamRunOutput for an in-flight run', () => {
  it('should yield chunks buffered before the subscription, then live chunks as they arrive, and complete once the run settles', async () => {
    queueSuccessfulResolution();
    randomUUIDMock.mockReturnValue('run-live-1');
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = buildService();

    // Drive plan() in the background exactly like a real caller (e.g. an
    // IPC handler forwarding chunks to the renderer) would — this is what
    // actually causes TerraformService to record chunks into the run's
    // active buffer.
    const planDone = drainInBackground(service.plan());
    await flushMicrotasks();

    // Emit one chunk *before* anyone has subscribed via streamRunOutput —
    // this becomes "buffered" once a subscriber attaches afterward.
    child.emitStdout('Refreshing state...\n');
    await flushMicrotasks();

    const streamGen = service.streamRunOutput('run-live-1');
    const first = await streamGen.next();
    expect(first).toEqual({
      done: false,
      value: { stream: 'stdout', line: 'Refreshing state...' },
    });

    // Now request the next chunk before it exists, then emit it live.
    const secondPromise = streamGen.next();
    child.emitStdout('Apply complete!\n');
    await flushMicrotasks();
    const second = await secondPromise;
    expect(second).toEqual({
      done: false,
      value: { stream: 'stdout', line: 'Apply complete!' },
    });

    // Closing the process settles the run — the subscription should end
    // cleanly (done: true) rather than hang or throw.
    const donePromise = streamGen.next();
    child.close(0);
    await flushMicrotasks();
    const done = await donePromise;
    expect(done.done).toBe(true);

    await planDone;
  });

  it('should deliver every chunk to a late subscriber that attaches after several chunks have already streamed', async () => {
    queueSuccessfulResolution();
    randomUUIDMock.mockReturnValue('run-live-2');
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = buildService();
    const planDone = drainInBackground(service.plan());
    await flushMicrotasks();

    child.emitStdout('line one\n');
    await flushMicrotasks();
    child.emitStdout('line two\n');
    await flushMicrotasks();

    const chunksPromise = collectStreamChunks(service.streamRunOutput('run-live-2'));

    child.close(0);
    await flushMicrotasks();

    const chunks = await chunksPromise;
    expect(chunks).toEqual([
      { stream: 'stdout', line: 'line one' },
      { stream: 'stdout', line: 'line two' },
    ]);

    await planDone;
  });

  it('should support multiple independent subscribers to the same in-flight run', async () => {
    queueSuccessfulResolution();
    randomUUIDMock.mockReturnValue('run-live-3');
    const child = new FakeChildProcess();
    queueSpawn(child);

    const service = buildService();
    const planDone = drainInBackground(service.plan());
    await flushMicrotasks();

    const subscriberAChunks = collectStreamChunks(service.streamRunOutput('run-live-3'));
    const subscriberBChunks = collectStreamChunks(service.streamRunOutput('run-live-3'));

    child.emitStdout('shared line\n');
    await flushMicrotasks();
    child.close(0);
    await flushMicrotasks();

    expect(await subscriberAChunks).toEqual([{ stream: 'stdout', line: 'shared line' }]);
    expect(await subscriberBChunks).toEqual([{ stream: 'stdout', line: 'shared line' }]);

    await planDone;
  });
});

describe('TerraformService.streamRunOutput for a finished run', () => {
  it('should replay the persisted terraform.log for a run that is no longer in flight', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue('Refreshing state...\nApply complete! Resources: 1 added.\n');

    const service = buildService();

    const chunks = await collectStreamChunks(service.streamRunOutput('run-finished-1'));

    expect(existsSyncMock).toHaveBeenCalledWith('/repo/runs/run-finished-1/terraform.log');
    expect(readFileSyncMock).toHaveBeenCalledWith('/repo/runs/run-finished-1/terraform.log', 'utf8');
    expect(chunks).toEqual([
      { stream: 'stdout', line: 'Refreshing state...' },
      { stream: 'stdout', line: 'Apply complete! Resources: 1 added.' },
    ]);
  });

  it('should not yield a spurious trailing empty chunk for a log ending in a newline', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue('only line\n');

    const service = buildService();

    const chunks = await collectStreamChunks(service.streamRunOutput('run-finished-2'));

    expect(chunks).toEqual([{ stream: 'stdout', line: 'only line' }]);
  });
});

describe('TerraformService.streamRunOutput for an unknown run', () => {
  it('should throw when runId is neither in flight nor has a terraform.log on disk', async () => {
    existsSyncMock.mockReturnValue(false);

    const service = buildService();

    await expect(collectStreamChunks(service.streamRunOutput('does-not-exist'))).rejects.toThrow(
      /no run found for runId "does-not-exist"/,
    );
  });

  it('should throw synchronously for a runId containing path-traversal segments before ever touching the filesystem', async () => {
    const service = buildService();

    await expect(collectStreamChunks(service.streamRunOutput('../../etc/passwd'))).rejects.toThrow(
      /not a valid run id/,
    );
    expect(existsSyncMock).not.toHaveBeenCalled();
  });
});

describe('TerraformService.readRunRecord', () => {
  it('should return the parsed run.json record for a finished run', () => {
    existsSyncMock.mockReturnValue(true);
    const record: TerraformRunRecord = {
      runId: 'run-detail-1',
      kind: 'plan',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      exitCode: 0,
    };
    readFileSyncMock.mockReturnValue(JSON.stringify(record));

    const service = buildService();

    const result = service.readRunRecord('run-detail-1');

    expect(existsSyncMock).toHaveBeenCalledWith('/repo/runs/run-detail-1/run.json');
    expect(readFileSyncMock).toHaveBeenCalledWith('/repo/runs/run-detail-1/run.json', 'utf8');
    expect(result).toEqual(record);
  });

  it('should return null when no run.json exists for the given runId', () => {
    existsSyncMock.mockReturnValue(false);

    const service = buildService();

    expect(service.readRunRecord('run-detail-missing')).toBeNull();
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('should throw synchronously for an invalid runId without touching the filesystem', () => {
    const service = buildService();

    expect(() => service.readRunRecord('../escape')).toThrow(/not a valid run id/);
    expect(existsSyncMock).not.toHaveBeenCalled();
  });
});

describe('TerraformService.hasPlanArtifact', () => {
  it('should return true when the .tfplan artifact exists on disk for the given runId', () => {
    existsSyncMock.mockReturnValue(true);

    const service = buildService();

    const result = service.hasPlanArtifact('run-plan-1');

    expect(existsSyncMock).toHaveBeenCalledWith('/repo/runs/run-plan-1/run-plan-1.tfplan');
    expect(result).toBe(true);
  });

  it('should return false when no .tfplan artifact exists on disk for the given runId', () => {
    existsSyncMock.mockReturnValue(false);

    const service = buildService();

    const result = service.hasPlanArtifact('run-plan-missing');

    expect(existsSyncMock).toHaveBeenCalledWith('/repo/runs/run-plan-missing/run-plan-missing.tfplan');
    expect(result).toBe(false);
  });

  it('should throw synchronously for an invalid runId without touching the filesystem', () => {
    const service = buildService();

    expect(() => service.hasPlanArtifact('../escape')).toThrow(/not a valid run id/);
    expect(existsSyncMock).not.toHaveBeenCalled();
  });
});
