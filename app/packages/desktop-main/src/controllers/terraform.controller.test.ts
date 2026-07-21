import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerraformController } from './terraform.controller.js';
import {
  TerraformInitError,
  TerraformPlanError,
  type TerraformInitConfig,
  type TerraformRunChunk,
  type TerraformPlanResult,
} from '../services/TerraformService.js';
import type { TfOutputs } from '../services/ConfigService.js';
import type { TerraformService } from '../services/TerraformService.js';
import type { AuditService, RecordAuditEntryParams } from '../services/AuditService.js';

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before any vi.mock() factory runs.
// ---------------------------------------------------------------------------

/**
 * Captures every `ipcMain.handle`/`ipcMain.removeHandler` call so tests can
 * assert on routing registration without a real Electron main process.
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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A minimal backend config payload shared across test cases. */
const CONFIG: TerraformInitConfig = {
  bucket: 'hyveon-tf-state',
  region: 'us-east-1',
  dynamodbTable: 'hyveon-tf-locks',
};

/**
 * Build a TerraformService stub whose `init` yields nothing by default,
 * whose `output` resolves `null` by default, whose `plan` yields nothing and
 * returns `undefined` by default, and whose `getWorkspaceInFlight` reports
 * `null` (no in-flight run) by default.
 */
function makeTerraform(): TerraformService {
  const stub: Partial<TerraformService> = {
    init: vi.fn().mockImplementation(async function* () { /* empty */ }),
    output: vi.fn().mockResolvedValue(null),
    plan: vi.fn().mockImplementation(async function* () { /* empty */ }),
    getWorkspaceInFlight: vi.fn().mockReturnValue(null),
  };
  return stub as TerraformService;
}

/**
 * Build a fake `TerraformService` that mimics the real
 * `workspaceInFlight`-locking behaviour `TerraformService.plan()` implements:
 * `plan()`'s synchronous prefix (before its first `await`) throws when a run
 * is already in flight, and otherwise reserves the lock synchronously before
 * yielding a single chunk (after one microtask tick, standing in for the real
 * `await this.getBinaryPath()` gap) and releasing the lock once the generator
 * settles. Used to exercise the TOCTOU fix in `TerraformController.plan()`:
 * only a real synchronous check-and-set can prove two concurrent invocations
 * can't both win the reservation.
 */
function makeRacyTerraform(): TerraformService {
  let workspaceInFlight: 'init' | 'plan' | 'apply' | 'destroy' | null = null;
  const stub: Partial<TerraformService> = {
    init: vi.fn().mockImplementation(async function* () { /* empty */ }),
    output: vi.fn().mockResolvedValue(null),
    getWorkspaceInFlight: vi.fn(() => workspaceInFlight),
    plan: vi.fn().mockImplementation(async function* (
      _tfvarsVersionId?: string,
      _signal?: AbortSignal,
      preMintedRunId?: string,
    ): AsyncGenerator<TerraformRunChunk, TerraformPlanResult | undefined> {
      if (workspaceInFlight) {
        throw new Error(
          `TerraformService.plan() cannot run while ${workspaceInFlight}() is already running; ` +
            'wait for it to finish before calling plan() again.',
        );
      }
      workspaceInFlight = 'plan';
      try {
        // Stand-in for the real await this.getBinaryPath() gap between the
        // synchronous reservation above and the first yielded chunk.
        await Promise.resolve();
        yield { stream: 'stdout', line: 'Refreshing Terraform state...' };
        return {
          runId: preMintedRunId ?? 'unknown',
          artifactPath: '/tmp/plan.tfplan',
          varFilePath: '/tmp/terraform.tfvars',
          add: 1,
          change: 0,
          destroy: 0,
        };
      } finally {
        workspaceInFlight = null;
      }
    }),
  };
  return stub as TerraformService;
}

/** Build an AuditService stub whose `record` resolves immediately by default and captures every call. */
function makeAudit(): { audit: AuditService; record: ReturnType<typeof vi.fn> } {
  const record = vi.fn().mockResolvedValue(undefined);
  const stub: Partial<AuditService> = { record };
  return { audit: stub as AuditService, record };
}

/**
 * Build a minimal `IpcMainInvokeEvent` stub with a controlled `sender`
 * (WebContents). Tests can inspect calls on `sender.send` and control the
 * return value of `sender.isDestroyed()`.
 */
function makeCtx(isDestroyed = false) {
  const sender = {
    send: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(isDestroyed),
    // `TerraformController.init` registers a `'destroyed'` listener (and
    // removes it once the run settles) so it can abort immediately when the
    // WebContents goes away instead of only checking `isDestroyed()` between
    // chunks.
    once: vi.fn(),
    removeListener: vi.fn(),
  };
  const ctx: { evt: { sender: typeof sender } } = { evt: { sender } };
  return { ctx, sender };
}

/** Flush the microtask queue so async fire-and-forget loops fully settle. */
function flushPromises(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * The metadata key NestJS stores on each method decorated with
 * `@MessagePattern`. Asserting this value guards against typos in the
 * channel name that would silently break IPC routing.
 */
const PATTERN_METADATA_KEY = 'microservices:pattern';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('TerraformController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // @MessagePattern channel name registration
  // -------------------------------------------------------------------------

  describe('@MessagePattern channel names', () => {
    it('should register init on the "terraform.init" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, TerraformController.prototype.init);
      expect(pattern).toEqual(['terraform.init']);
    });

    it('should register output on the "terraform.output" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, TerraformController.prototype.output);
      expect(pattern).toEqual(['terraform.output']);
    });

    it('should register plan on the "terraform.plan" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, TerraformController.prototype.plan);
      expect(pattern).toEqual(['terraform.plan']);
    });
  });

  // -------------------------------------------------------------------------
  // onModuleInit — ipcMain.handle bridge for terraform.init
  // -------------------------------------------------------------------------

  describe('onModuleInit', () => {
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
    beforeEach(() => setElectron('30.0.0'));
    afterEach(() => setElectron(realElectronVersion));

    it('should skip the ipcMain bridge when not running inside an Electron main process', async () => {
      // Plain-Node runtimes (integration test server, Docker, CI) have no
      // `process.versions.electron`; importing electron there would throw, so
      // the bridge must be skipped without touching ipcMain at all.
      setElectron(undefined);
      await new TerraformController(makeTerraform()).onModuleInit();
      expect(mockIpcMainHandle).not.toHaveBeenCalled();
      expect(mockIpcMainRemoveHandler).not.toHaveBeenCalled();
    });

    it('should register ipcMain.handle for "terraform.init" so ipcRenderer.invoke can resolve', async () => {
      await new TerraformController(makeTerraform()).onModuleInit();
      expect(mockIpcMainHandle).toHaveBeenCalledWith('terraform.init', expect.any(Function));
    });

    it('should remove any existing "terraform.init" handler before registering so hot-reload re-bootstrap does not throw', async () => {
      // A second bootstrap (hot-reload / dev restart) would otherwise hit
      // "Attempted to register a second handler for 'terraform.init'".
      // Clearing the handler first keeps re-registration idempotent.
      await new TerraformController(makeTerraform()).onModuleInit();
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('terraform.init');
      expect(mockIpcMainRemoveHandler.mock.invocationCallOrder[0]).toBeLessThan(
        mockIpcMainHandle.mock.invocationCallOrder[0],
      );
    });
  });

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  describe('init', () => {
    it('should return { started: true } immediately without waiting for the run to settle', async () => {
      // TerraformService.init never yields/returns on its own here, so if
      // init() awaited the whole loop synchronously this call would hang.
      const terraform = makeTerraform();
      // eslint-disable-next-line require-yield -- generator intentionally never yields/returns to prove init() doesn't await it
      vi.mocked(terraform.init).mockImplementation(async function* () {
        await new Promise<void>(() => { /* never resolves */ });
      });
      const { ctx } = makeCtx();

      const result = await new TerraformController(terraform).init(CONFIG, ctx);

      expect(result).toEqual({ started: true, streamId: expect.any(String) });
    });

    it('should send each yielded chunk to the renderer via sender.send, in order', async () => {
      const chunks: TerraformRunChunk[] = [
        { stream: 'stdout', line: 'Initializing the backend...' },
        { stream: 'stdout', line: 'Initializing provider plugins...' },
        { stream: 'stdout', line: 'Terraform has been successfully initialized!' },
      ];
      async function* yieldChunks() {
        for (const chunk of chunks) yield chunk;
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.init).mockImplementation(yieldChunks);
      const { ctx, sender } = makeCtx();

      await new TerraformController(terraform).init(CONFIG, ctx);
      await flushPromises();

      const chunkCalls = sender.send.mock.calls.filter(([channel]) => channel === 'terraform.init.chunk');
      // Every chunk payload is tagged with the same per-call streamId so the
      // renderer (and a rejected concurrent call) can tell which run it
      // belongs to.
      const streamIds = new Set(chunkCalls.map(([, payload]) => (payload as { streamId: string }).streamId));
      expect(streamIds.size).toBe(1);
      expect(chunkCalls.map(([, payload]) => (payload as { chunk: TerraformRunChunk }).chunk)).toEqual(chunks);
    });

    it('should forward the config payload and an AbortSignal to TerraformService.init', async () => {
      const terraform = makeTerraform();
      const { ctx } = makeCtx();

      await new TerraformController(terraform).init(CONFIG, ctx);
      await flushPromises();

      expect(terraform.init).toHaveBeenCalledWith(CONFIG, expect.any(AbortSignal));
    });

    it('should send an end message with exitCode 0 and no error when the run succeeds', async () => {
      async function* empty() { /* no chunks, generator returns normally */ }
      const terraform = makeTerraform();
      vi.mocked(terraform.init).mockImplementation(empty);
      const { ctx, sender } = makeCtx();

      await new TerraformController(terraform).init(CONFIG, ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith('terraform.init.end', { streamId: expect.any(String), exitCode: 0 });
      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'terraform.init.end');
      expect(endCall?.[1]).not.toHaveProperty('error');
    });

    it('should send an end message with the process exit code and a stringified error on TerraformInitError', async () => {
      async function* failsWithExitCode(): AsyncGenerator<TerraformRunChunk> {
        yield { stream: 'stderr', line: 'Error configuring backend "s3"' };
        throw new TerraformInitError(1);
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.init).mockImplementation(failsWithExitCode);
      const { ctx, sender } = makeCtx();

      await new TerraformController(terraform).init(CONFIG, ctx);
      await flushPromises();

      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'terraform.init.end');
      expect(endCall?.[1]).toMatchObject({ exitCode: 1 });
      expect(String(endCall?.[1]?.error)).toContain('terraform init exited with code 1');
    });

    it('should send an end message with a null exitCode for a non-process failure (e.g. binary not found)', async () => {
      // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate a pre-spawn failure
      async function* failsWithoutExitCode(): AsyncGenerator<TerraformRunChunk> {
        throw new Error('terraform binary not found on PATH');
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.init).mockImplementation(failsWithoutExitCode);
      const { ctx, sender } = makeCtx();

      await new TerraformController(terraform).init(CONFIG, ctx);
      await flushPromises();

      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'terraform.init.end');
      expect(endCall?.[1]).toMatchObject({ exitCode: null });
      expect(String(endCall?.[1]?.error)).toContain('terraform binary not found on PATH');
    });

    it('should not send further chunks or an end message once the WebContents is destroyed', async () => {
      async function* twoLines(): AsyncGenerator<TerraformRunChunk> {
        yield { stream: 'stdout', line: 'first' };
        yield { stream: 'stdout', line: 'second' };
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.init).mockImplementation(twoLines);
      // Simulate WebContents already destroyed before the loop runs.
      const { ctx, sender } = makeCtx(true);

      await new TerraformController(terraform).init(CONFIG, ctx);
      await flushPromises();

      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error } and never call TerraformService.init when the payload fails validation', async () => {
      const terraform = makeTerraform();
      const { ctx, sender } = makeCtx();
      const invalidConfig = { bucket: '', region: 'us-east-1', dynamodbTable: 'hyveon-tf-locks' };

      const result = await new TerraformController(terraform).init(invalidConfig, ctx);
      await flushPromises();

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.init).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // plan
  // -------------------------------------------------------------------------

  describe('plan', () => {
    it('should return { started: true, runId } immediately without waiting for the run to settle', async () => {
      // TerraformService.plan never yields/returns on its own here, so if
      // plan() awaited the whole loop synchronously this call would hang.
      const terraform = makeTerraform();
      // eslint-disable-next-line require-yield -- generator intentionally never yields/returns to prove plan() doesn't await it
      vi.mocked(terraform.plan).mockImplementation(async function* () {
        await new Promise<void>(() => { /* never resolves */ });
      });
      const { audit } = makeAudit();
      const { ctx } = makeCtx();

      const result = await new TerraformController(terraform, audit).plan({}, ctx);

      expect(result).toEqual({ started: true, runId: expect.any(String) });
    });

    it('should send each yielded chunk to the renderer via sender.send, in order, tagged with runId', async () => {
      const chunks: TerraformRunChunk[] = [
        { stream: 'stdout', line: 'Refreshing Terraform state...' },
        { stream: 'stdout', line: 'Plan: 1 to add, 0 to change, 0 to destroy.' },
      ];
      async function* yieldChunks() {
        for (const chunk of chunks) yield chunk;
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.plan).mockImplementation(yieldChunks);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new TerraformController(terraform, audit).plan({}, ctx);
      await flushPromises();

      const chunkCalls = sender.send.mock.calls.filter(([channel]) => channel === 'terraform.plan.chunk');
      // Every chunk payload is tagged with the same runId already handed back
      // in the ack, so the renderer (and a rejected concurrent call) can tell
      // which run it belongs to.
      const runIds = new Set(chunkCalls.map(([, payload]) => (payload as { runId: string }).runId));
      expect(runIds).toEqual(new Set([result.runId]));
      expect(chunkCalls.map(([, payload]) => (payload as { chunk: TerraformRunChunk }).chunk)).toEqual(chunks);
    });

    it('should forward tfvarsVersionId, an AbortSignal, and the pre-minted runId to TerraformService.plan', async () => {
      const terraform = makeTerraform();
      const { audit } = makeAudit();
      const { ctx } = makeCtx();

      const result = await new TerraformController(terraform, audit).plan({ tfvarsVersionId: 'v123' }, ctx);
      await flushPromises();

      expect(terraform.plan).toHaveBeenCalledWith('v123', expect.any(AbortSignal), result.runId);
    });

    it('should send an end message with exitCode 0, the resolved result, and no error when the run succeeds', async () => {
      const planResult: TerraformPlanResult = {
        runId: 'ignored-because-controller-mints-its-own',
        artifactPath: '/tmp/plan.tfplan',
        varFilePath: '/tmp/terraform.tfvars',
        add: 1,
        change: 0,
        destroy: 0,
      };
      async function* succeeds(): AsyncGenerator<TerraformRunChunk, TerraformPlanResult> {
        yield { stream: 'stdout', line: 'Plan: 1 to add, 0 to change, 0 to destroy.' };
        return planResult;
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.plan).mockImplementation(succeeds);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new TerraformController(terraform, audit).plan({}, ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith('terraform.plan.end', {
        runId: result.runId,
        exitCode: 0,
        result: planResult,
      });
      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'terraform.plan.end');
      expect(endCall?.[1]).not.toHaveProperty('error');
    });

    it('should send an end message with the process exit code and a stringified error on TerraformPlanError', async () => {
      async function* failsWithExitCode(): AsyncGenerator<TerraformRunChunk> {
        yield { stream: 'stderr', line: 'Error: Invalid count argument' };
        throw new TerraformPlanError(1);
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.plan).mockImplementation(failsWithExitCode);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      await new TerraformController(terraform, audit).plan({}, ctx);
      await flushPromises();

      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'terraform.plan.end');
      expect(endCall?.[1]).toMatchObject({ exitCode: 1 });
      expect(String(endCall?.[1]?.error)).toContain('terraform plan exited with code 1');
    });

    it('should send an end message with a null exitCode for a non-process failure (e.g. binary not found)', async () => {
      // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate a pre-spawn failure
      async function* failsWithoutExitCode(): AsyncGenerator<TerraformRunChunk> {
        throw new Error('terraform binary not found on PATH');
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.plan).mockImplementation(failsWithoutExitCode);
      const { audit } = makeAudit();
      const { ctx, sender } = makeCtx();

      await new TerraformController(terraform, audit).plan({}, ctx);
      await flushPromises();

      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'terraform.plan.end');
      expect(endCall?.[1]).toMatchObject({ exitCode: null });
      expect(String(endCall?.[1]?.error)).toContain('terraform binary not found on PATH');
    });

    it('should not send further chunks or an end message, and should finalize the generator via stream.return, once the WebContents is destroyed', async () => {
      let returnCalled = false;
      async function* twoLines(): AsyncGenerator<TerraformRunChunk, TerraformPlanResult | undefined> {
        try {
          yield { stream: 'stdout', line: 'first' };
          yield { stream: 'stdout', line: 'second' };
          return undefined;
        } finally {
          returnCalled = true;
        }
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.plan).mockImplementation(twoLines);
      const { audit } = makeAudit();
      // Simulate WebContents already destroyed before the loop runs.
      const { ctx, sender } = makeCtx(true);

      await new TerraformController(terraform, audit).plan({}, ctx);
      await flushPromises();

      expect(sender.send).not.toHaveBeenCalled();
      expect(returnCalled).toBe(true);
    });

    it('should return a conflict ack naming the in-flight op and never call TerraformService.plan or record an audit entry when the workspace is busy', async () => {
      const terraform = makeTerraform();
      vi.mocked(terraform.getWorkspaceInFlight).mockReturnValue('apply');
      const { audit, record } = makeAudit();
      const { ctx, sender } = makeCtx();

      const result = await new TerraformController(terraform, audit).plan({}, ctx);
      await flushPromises();

      expect(result).toEqual({ started: false, error: expect.any(String), conflict: 'apply' });
      expect(result.runId).toBeUndefined();
      expect(terraform.plan).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should record an audit entry with action "plan" for an accepted submission', async () => {
      async function* succeeds(): AsyncGenerator<TerraformRunChunk> {
        yield { stream: 'stdout', line: 'Plan: 0 to add, 0 to change, 0 to destroy.' };
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.plan).mockImplementation(succeeds);
      const { audit, record } = makeAudit();
      const { ctx } = makeCtx();

      await new TerraformController(terraform, audit).plan({ tfvarsVersionId: 'v42' }, ctx);
      await flushPromises();

      expect(record).toHaveBeenCalledTimes(1);
      const recordedEntry = record.mock.calls[0][0] as RecordAuditEntryParams;
      expect(recordedEntry).toMatchObject({ action: 'plan', versionId: 'v42' });
    });

    it('should never reject with started: true for a second submission while a plan/init/apply/destroy is already in flight, even when audit.record() is slow (TOCTOU regression)', async () => {
      // Regression test for the race where the workspace reservation only
      // happened deep inside the fire-and-forget block, after awaiting
      // audit.record() — two back-to-back submissions could both observe the
      // workspace as free and both resolve started: true before the second
      // one's run failed deep inside TerraformService.plan(). Using a slow,
      // controllable audit.record() here maximises the window a buggy
      // implementation would race in.
      const terraform = makeRacyTerraform();
      let resolveAudit: (() => void) | undefined;
      const record = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveAudit = resolve;
          }),
      );
      const auditStub: Partial<AuditService> = { record };
      const audit = auditStub as AuditService;
      const { ctx: ctxA, sender: senderA } = makeCtx();
      const { ctx: ctxB, sender: senderB } = makeCtx();
      const controller = new TerraformController(terraform, audit);

      // Fire the first submission; it will suspend on the still-pending
      // audit.record() promise before this awaits anything further.
      const resultAPromise = controller.plan({}, ctxA);
      // Give the first call's synchronous prefix (through the reservation
      // and the audit.record() call) a chance to run before firing the
      // second submission.
      await Promise.resolve();
      const resultB = await controller.plan({}, ctxB);

      // The second submission must be rejected as a conflict — it must NOT
      // see started: true while the first is still in flight.
      expect(resultB.started).toBe(false);
      expect(resultB.conflict).toBe('plan');
      expect(resultB.runId).toBeUndefined();

      // Only the first (accepted) submission should have triggered an audit
      // write so far — the second was rejected before ever calling
      // audit.record().
      expect(record).toHaveBeenCalledTimes(1);

      // Let the first submission's audit.record() resolve and its streaming
      // loop finish.
      resolveAudit?.();
      const resultA = await resultAPromise;
      await flushPromises();

      expect(resultA.started).toBe(true);
      expect(resultA.runId).toEqual(expect.any(String));
      expect(senderB.send).not.toHaveBeenCalled();
      const endCallA = senderA.send.mock.calls.find(([channel]) => channel === 'terraform.plan.end');
      expect(endCallA?.[1]).toMatchObject({ exitCode: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // output
  // -------------------------------------------------------------------------

  describe('output', () => {
    /** A minimal resolved outputs payload shared across the "output" cases. */
    const OUTPUTS = {
      ecs_cluster_name: 'hyveon-cluster',
    } as Partial<TfOutputs> as TfOutputs;

    it('should resolve with whatever TerraformService.output resolves with', async () => {
      const terraform = makeTerraform();
      vi.mocked(terraform.output).mockResolvedValue(OUTPUTS);

      const result = await new TerraformController(terraform).output({});

      expect(result).toBe(OUTPUTS);
    });

    it('should pass force: true through to TerraformService.output when the payload sets it', async () => {
      const terraform = makeTerraform();

      await new TerraformController(terraform).output({ force: true });

      expect(terraform.output).toHaveBeenCalledWith(true);
    });

    it('should default force to false when the payload omits it', async () => {
      const terraform = makeTerraform();

      await new TerraformController(terraform).output({});

      expect(terraform.output).toHaveBeenCalledWith(false);
    });

    it('should default force to false when no payload is provided at all', async () => {
      const terraform = makeTerraform();

      await new TerraformController(terraform).output(undefined);

      expect(terraform.output).toHaveBeenCalledWith(false);
    });

    it('should propagate whatever error TerraformService.output rejects with', async () => {
      const terraform = makeTerraform();
      const error = new Error('terraform output -json exited with code 1');
      vi.mocked(terraform.output).mockRejectedValue(error);

      await expect(new TerraformController(terraform).output({})).rejects.toThrow(error);
    });
  });
});
