import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { RunLock, RunPageResult, RunRecord } from '@hyveon/shared';
import { TerraformRunsController } from './terraform-runs.controller.js';
import type { TerraformService, TerraformRunChunk, TerraformRunRecord } from '../services/TerraformService.js';
import type { RunService } from '../services/RunService.js';
import type { RunRecordService, ListRunsOpts } from '../services/RunRecordService.js';

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before any vi.mock() factory runs.
// ---------------------------------------------------------------------------

/**
 * Captures every `ipcMain.handle`/`ipcMain.removeHandler` call so
 * `onModuleInit` tests can assert on bridge registration without a real
 * Electron main process.
 */
const { mockIpcMainHandle, mockIpcMainRemoveHandler } = vi.hoisted(() => {
  const mockIpcMainHandle = vi.fn();
  const mockIpcMainRemoveHandler = vi.fn();
  return { mockIpcMainHandle, mockIpcMainRemoveHandler };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
    removeHandler: mockIpcMainRemoveHandler,
  },
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Build a `TerraformService` stub. `record` seeds what `readRunRecord`
 * resolves for any `runId` (defaults to `null`, i.e. no persisted run);
 * `planArtifactExists` seeds `hasPlanArtifact`'s return value;
 * `streamRunOutput` seeds an empty async generator by default so `logs()`
 * tests can override it per-case via `vi.mocked(...).mockImplementation(...)`.
 */
function makeTerraform(
  record: TerraformRunRecord | null = null,
  planArtifactExists = false,
): TerraformService {
  return {
    readRunRecord: vi.fn().mockReturnValue(record),
    hasPlanArtifact: vi.fn().mockReturnValue(planArtifactExists),
    streamRunOutput: vi.fn().mockImplementation(async function* () { /* empty */ }),
  } as unknown as TerraformService;
}

/**
 * Build a minimal `IpcMainInvokeEvent` stub with a controlled `sender`
 * (WebContents). Tests can inspect calls on `sender.send` and control the
 * return value of `sender.isDestroyed()`, plus fire the `'destroyed'` event
 * listener registered via `sender.once('destroyed', ...)`.
 */
function makeCtx(isDestroyed = false) {
  const destroyedListeners: Array<() => void> = [];
  const sender = {
    send: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(isDestroyed),
    once: vi.fn().mockImplementation((event: string, listener: () => void) => {
      if (event === 'destroyed') destroyedListeners.push(listener);
    }),
    removeListener: vi.fn(),
  };
  return {
    ctx: { evt: { sender } } as unknown as { evt: { sender: typeof sender } },
    sender,
    fireDestroyed: () => destroyedListeners.forEach((listener) => listener()),
  };
}

/** Flush the microtask queue so async fire-and-forget loops fully settle. */
function flushPromises(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Build a `RunService` stub whose `getCurrentLock()` returns `lock` (defaults to `undefined`, i.e. no run in flight). */
function makeRunService(lock: RunLock | undefined = undefined): RunService {
  return {
    getCurrentLock: vi.fn().mockReturnValue(lock),
  } as unknown as RunService;
}

/** A `TerraformRunRecord` fixture for a successful `plan` run. */
function buildRecord(overrides: Partial<TerraformRunRecord> = {}): TerraformRunRecord {
  return {
    runId: 'run-1',
    kind: 'plan',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    exitCode: 0,
    ...overrides,
  };
}

/** A `RunLock` fixture for a run currently holding the apply lock. */
function buildLock(overrides: Partial<RunLock> = {}): RunLock {
  return {
    runId: 'run-1',
    kind: 'plan',
    initiator: 'operator',
    acquiredAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T01:00:00.000Z',
    ...overrides,
  };
}

/** Build a `RunRecordService` stub whose `listRuns`/`getLogUrl` return the given (or default) values. */
function makeRunRecordService(
  listRunsResult: RunPageResult = { records: [] },
  logUrl = 'https://example.com/signed',
): RunRecordService {
  return {
    listRuns: vi.fn().mockResolvedValue(listRunsResult),
    getLogUrl: vi.fn().mockResolvedValue(logUrl),
  } as Partial<RunRecordService> as RunRecordService;
}

/** A `RunRecord` fixture (the DynamoDB-persisted history row), overridable per-test. */
function buildDynamoRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    sk: '2026-07-17T00:00:00.000Z#run-123',
    runId: 'run-123',
    kind: 'apply',
    status: 'success',
    startedAt: '2026-07-17T00:00:00.000Z',
    completedAt: '2026-07-17T00:05:00.000Z',
    exitCode: 0,
    ...overrides,
  };
}

describe('TerraformRunsController.get', () => {
  it('should return found: true, status: running for the runId currently holding the apply lock', async () => {
    const runService = makeRunService(buildLock({ runId: 'run-live' }));
    const terraform = makeTerraform();
    const controller = new TerraformRunsController(terraform, runService, makeRunRecordService());

    const result = await controller.get({ runId: 'run-live' });

    expect(result).toEqual({ found: true, status: 'running' });
    expect(terraform.readRunRecord).not.toHaveBeenCalled();
  });

  it('should return found: true, status: success plus the record for a finished apply run', async () => {
    const record = buildRecord({ runId: 'run-apply', kind: 'apply', exitCode: 0 });
    const terraform = makeTerraform(record);
    const runService = makeRunService();
    const controller = new TerraformRunsController(terraform, runService, makeRunRecordService());

    const result = await controller.get({ runId: 'run-apply' });

    expect(result).toEqual({ found: true, status: 'success', record });
  });

  it('should return found: true, status: failed plus the record for a plan run that exited non-zero', async () => {
    const record = buildRecord({ runId: 'run-failed', kind: 'plan', exitCode: 1 });
    const terraform = makeTerraform(record, false);
    const runService = makeRunService();
    const controller = new TerraformRunsController(terraform, runService, makeRunRecordService());

    const result = await controller.get({ runId: 'run-failed' });

    expect(result).toEqual({ found: true, status: 'failed', record });
  });

  it('should return found: true, status: aborted plus the record for a run with no exit code', async () => {
    const record = buildRecord({ runId: 'run-aborted', kind: 'destroy', exitCode: null });
    const terraform = makeTerraform(record);
    const runService = makeRunService();
    const controller = new TerraformRunsController(terraform, runService, makeRunRecordService());

    const result = await controller.get({ runId: 'run-aborted' });

    expect(result).toEqual({ found: true, status: 'aborted', record });
  });

  it('should return found: true, status: awaiting_approval plus the record for a successful plan run whose .tfplan artifact still exists', async () => {
    const record = buildRecord({ runId: 'run-plan', kind: 'plan', exitCode: 0 });
    const terraform = makeTerraform(record, true);
    const runService = makeRunService();
    const controller = new TerraformRunsController(terraform, runService, makeRunRecordService());

    const result = await controller.get({ runId: 'run-plan' });

    expect(result).toEqual({ found: true, status: 'awaiting_approval', record });
    expect(terraform.hasPlanArtifact).toHaveBeenCalledWith('run-plan');
  });

  it('should return found: false when runId is neither the held lock nor a persisted run', async () => {
    const terraform = makeTerraform(null);
    const runService = makeRunService();
    const controller = new TerraformRunsController(terraform, runService, makeRunRecordService());

    const result = await controller.get({ runId: 'does-not-exist' });

    expect(result).toEqual({ found: false });
  });

  it('should reject a payload with a missing runId', async () => {
    const controller = new TerraformRunsController(makeTerraform(), makeRunService(), makeRunRecordService());

    await expect(
      controller.get({} as unknown as { runId: string }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('should reject a payload with a non-string runId', async () => {
    const controller = new TerraformRunsController(makeTerraform(), makeRunService(), makeRunRecordService());

    await expect(
      controller.get({ runId: 42 } as unknown as { runId: string }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('should reject a payload with an empty-string runId', async () => {
    const controller = new TerraformRunsController(makeTerraform(), makeRunService(), makeRunRecordService());

    await expect(controller.get({ runId: '' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('TerraformRunsController.onModuleInit', () => {
  // onModuleInit only wires the bridge when running inside a real Electron
  // main process, detected via `process.versions.electron`. Vitest runs under
  // plain Node where it's undefined, so fake it for the "is Electron" cases
  // and restore afterwards.
  const realElectronVersion = process.versions.electron;
  const setElectron = (value: string | undefined): void => {
    if (value === undefined) {
      delete (process.versions as { electron?: string }).electron;
    } else {
      Object.defineProperty(process.versions, 'electron', { value, configurable: true });
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setElectron('30.0.0');
  });
  afterEach(() => setElectron(realElectronVersion));

  it('should skip the ipcMain bridge when not running inside an Electron main process', async () => {
    setElectron(undefined);
    await new TerraformRunsController(makeTerraform(), makeRunService(), makeRunRecordService()).onModuleInit();

    expect(mockIpcMainHandle).not.toHaveBeenCalled();
    expect(mockIpcMainRemoveHandler).not.toHaveBeenCalled();
  });

  it('should register ipcMain.handle for "terraform.runs.logs" so ipcRenderer.invoke can resolve', async () => {
    await new TerraformRunsController(makeTerraform(), makeRunService(), makeRunRecordService()).onModuleInit();

    expect(mockIpcMainHandle).toHaveBeenCalledWith('terraform.runs.logs', expect.any(Function));
  });

  it('should remove any existing "terraform.runs.logs" handler before registering so hot-reload re-bootstrap does not throw', async () => {
    await new TerraformRunsController(makeTerraform(), makeRunService(), makeRunRecordService()).onModuleInit();

    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('terraform.runs.logs');
    expect(mockIpcMainRemoveHandler.mock.invocationCallOrder[0]).toBeLessThan(
      mockIpcMainHandle.mock.invocationCallOrder[0],
    );
  });
});

describe('TerraformRunsController.logs', () => {
  it('should return a non-empty streamId string immediately', async () => {
    const { ctx } = makeCtx();
    const controller = new TerraformRunsController(makeTerraform(), makeRunService(), makeRunRecordService());

    const result = await controller.logs({ runId: 'run-1' }, ctx);

    expect(result).toHaveProperty('streamId');
    expect(typeof result.streamId).toBe('string');
    expect(result.streamId.length).toBeGreaterThan(0);
  });

  it('should reject a payload with a missing runId without opening a stream', async () => {
    const terraform = makeTerraform();
    const { ctx } = makeCtx();
    const controller = new TerraformRunsController(terraform, makeRunService(), makeRunRecordService());

    await expect(
      controller.logs({} as unknown as { runId: string }, ctx),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(terraform.streamRunOutput).not.toHaveBeenCalled();
  });

  it('should reject a payload with an empty-string runId without opening a stream', async () => {
    const terraform = makeTerraform();
    const { ctx } = makeCtx();
    const controller = new TerraformRunsController(terraform, makeRunService(), makeRunRecordService());

    await expect(controller.logs({ runId: '' }, ctx)).rejects.toBeInstanceOf(BadRequestException);
    expect(terraform.streamRunOutput).not.toHaveBeenCalled();
  });

  it('should forward every chunk, in order, on terraform.runs.logs.chunk tagged with the streamId', async () => {
    const chunks: TerraformRunChunk[] = [
      { stream: 'stdout', line: 'Terraform will perform the following actions:' },
      { stream: 'stdout', line: 'Plan: 1 to add, 0 to change, 0 to destroy.' },
    ];
    async function* twoChunks() {
      for (const chunk of chunks) yield chunk;
    }
    const terraform = makeTerraform();
    vi.mocked(terraform.streamRunOutput).mockImplementation(twoChunks);
    const { ctx, sender } = makeCtx();
    const controller = new TerraformRunsController(terraform, makeRunService(), makeRunRecordService());

    const { streamId } = await controller.logs({ runId: 'run-1' }, ctx);
    await flushPromises();

    const chunkCalls = sender.send.mock.calls.filter(([channel]) => channel === 'terraform.runs.logs.chunk');
    expect(chunkCalls).toEqual([
      ['terraform.runs.logs.chunk', { streamId, chunk: chunks[0] }],
      ['terraform.runs.logs.chunk', { streamId, chunk: chunks[1] }],
    ]);
  });

  it('should call TerraformService.streamRunOutput with the runId and an AbortSignal', async () => {
    const terraform = makeTerraform();
    const { ctx } = makeCtx();
    const controller = new TerraformRunsController(terraform, makeRunService(), makeRunRecordService());

    await controller.logs({ runId: 'run-42' }, ctx);
    await flushPromises();

    expect(terraform.streamRunOutput).toHaveBeenCalledWith('run-42', expect.any(AbortSignal));
  });

  it('should send exactly one terraform.runs.logs.end message with no error when the run reaches a terminal status', async () => {
    async function* empty() { /* run already settled — no further chunks */ }
    const terraform = makeTerraform();
    vi.mocked(terraform.streamRunOutput).mockImplementation(empty);
    const { ctx, sender } = makeCtx();
    const controller = new TerraformRunsController(terraform, makeRunService(), makeRunRecordService());

    const { streamId } = await controller.logs({ runId: 'run-1' }, ctx);
    await flushPromises();

    const endCalls = sender.send.mock.calls.filter(([channel]) => channel === 'terraform.runs.logs.end');
    expect(endCalls).toEqual([['terraform.runs.logs.end', { streamId }]]);
  });

  it('should send exactly one terraform.runs.logs.end message with an error when the stream throws', async () => {
    async function* throwsError(): AsyncGenerator<TerraformRunChunk> {
      yield { stream: 'stdout', line: 'partial' };
      throw new Error('no run found for runId "run-1"');
    }
    const terraform = makeTerraform();
    vi.mocked(terraform.streamRunOutput).mockImplementation(throwsError);
    const { ctx, sender } = makeCtx();
    const controller = new TerraformRunsController(terraform, makeRunService(), makeRunRecordService());

    const { streamId } = await controller.logs({ runId: 'run-1' }, ctx);
    await flushPromises();

    const endCalls = sender.send.mock.calls.filter(([channel]) => channel === 'terraform.runs.logs.end');
    expect(endCalls).toHaveLength(1);
    const [, message] = endCalls[0] as [string, { streamId: string; error?: string }];
    expect(message.streamId).toBe(streamId);
    expect(message.error).toContain('no run found for runId "run-1"');
  });

  it('should stop sending chunks once the WebContents is destroyed mid-stream', async () => {
    let sawAbort = false;
    async function* waitForAbort(
      runId: string,
      signal: AbortSignal,
    ): AsyncGenerator<TerraformRunChunk> {
      yield { stream: 'stdout', line: 'first' };
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve();
        });
      });
      yield { stream: 'stdout', line: 'should never be sent' };
    }
    const terraform = makeTerraform();
    vi.mocked(terraform.streamRunOutput).mockImplementation(waitForAbort);
    const { ctx, sender, fireDestroyed } = makeCtx();
    const controller = new TerraformRunsController(terraform, makeRunService(), makeRunRecordService());

    await controller.logs({ runId: 'run-1' }, ctx);
    await flushPromises();

    fireDestroyed();
    // Once destroyed, sender.isDestroyed() should also reflect that a real
    // WebContents would report — simulate that alongside the abort.
    sender.isDestroyed.mockReturnValue(true);
    await flushPromises();

    expect(sawAbort).toBe(true);
    const chunkCalls = sender.send.mock.calls.filter(([channel]) => channel === 'terraform.runs.logs.chunk');
    expect(chunkCalls).toHaveLength(1);
    const endCalls = sender.send.mock.calls.filter(([channel]) => channel === 'terraform.runs.logs.end');
    expect(endCalls).toHaveLength(0);
  });

  it('should not send any messages when the WebContents is already destroyed before the first chunk', async () => {
    async function* oneChunk(): AsyncGenerator<TerraformRunChunk> {
      yield { stream: 'stdout', line: 'line' };
    }
    const terraform = makeTerraform();
    vi.mocked(terraform.streamRunOutput).mockImplementation(oneChunk);
    const { ctx, sender } = makeCtx(true);
    const controller = new TerraformRunsController(terraform, makeRunService(), makeRunRecordService());

    await controller.logs({ runId: 'run-1' }, ctx);
    await flushPromises();

    expect(sender.send).not.toHaveBeenCalled();
  });

  it('should remove the destroyed listener after the stream ends naturally', async () => {
    async function* empty() { /* terminates immediately */ }
    const terraform = makeTerraform();
    vi.mocked(terraform.streamRunOutput).mockImplementation(empty);
    const { ctx, sender } = makeCtx();
    const controller = new TerraformRunsController(terraform, makeRunService(), makeRunRecordService());

    await controller.logs({ runId: 'run-1' }, ctx);
    await flushPromises();

    expect(sender.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
  });
});

describe('TerraformRunsController.list', () => {
  it("should delegate to RunRecordService.listRuns with the given opts", async () => {
    const runRecordService = makeRunRecordService();
    const controller = new TerraformRunsController(makeTerraform(), makeRunService(), runRecordService);

    await controller.list({ limit: 10, before: 'cursor-sk', status: 'failed' });

    expect(runRecordService.listRuns).toHaveBeenCalledWith({ limit: 10, before: 'cursor-sk', status: 'failed' });
  });

  it('should default to an empty opts object when the renderer invokes with no arguments', async () => {
    const runRecordService = makeRunRecordService();
    const controller = new TerraformRunsController(makeTerraform(), makeRunService(), runRecordService);

    await controller.list();

    expect(runRecordService.listRuns).toHaveBeenCalledWith({});
  });

  it("should return the page resolved by RunRecordService.listRuns", async () => {
    const record = buildDynamoRecord();
    const runRecordService = makeRunRecordService({ records: [record], nextBefore: record.sk });
    const controller = new TerraformRunsController(makeTerraform(), makeRunService(), runRecordService);

    const result = await controller.list({ limit: 20 });

    expect(result).toEqual({ records: [record], nextBefore: record.sk });
  });

  it('should reject a status filter that is not a known RunStatus', async () => {
    const runRecordService = makeRunRecordService();
    const controller = new TerraformRunsController(makeTerraform(), makeRunService(), runRecordService);

    await expect(
      controller.list({ status: 'pending' } as unknown as ListRunsOpts),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(runRecordService.listRuns).not.toHaveBeenCalled();
  });
});

describe('TerraformRunsController.logUrl', () => {
  it("should delegate to RunRecordService.getLogUrl and wrap the result in { url }", async () => {
    const runRecordService = makeRunRecordService(undefined, 'https://example.com/signed-log');
    const controller = new TerraformRunsController(makeTerraform(), makeRunService(), runRecordService);

    const result = await controller.logUrl({ logKey: 'runs/run-123.log' });

    expect(result).toEqual({ url: 'https://example.com/signed-log' });
    expect(runRecordService.getLogUrl).toHaveBeenCalledWith('runs/run-123.log', undefined);
  });

  it('should forward a custom expiresInSeconds to RunRecordService.getLogUrl', async () => {
    const runRecordService = makeRunRecordService();
    const controller = new TerraformRunsController(makeTerraform(), makeRunService(), runRecordService);

    await controller.logUrl({ logKey: 'runs/run-123.log', expiresInSeconds: 60 });

    expect(runRecordService.getLogUrl).toHaveBeenCalledWith('runs/run-123.log', 60);
  });

  it('should reject a payload with a missing logKey', async () => {
    const controller = new TerraformRunsController(makeTerraform(), makeRunService(), makeRunRecordService());

    await expect(
      controller.logUrl({} as unknown as { logKey: string }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('should reject a payload with an empty-string logKey', async () => {
    const controller = new TerraformRunsController(makeTerraform(), makeRunService(), makeRunRecordService());

    await expect(controller.logUrl({ logKey: '' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
