import 'reflect-metadata';
import * as os from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerraformController } from './terraform.controller.js';
import {
  TerraformInitError,
  TerraformPlanError,
  TerraformApplyError,
  RollbackVersionMissingError,
  type TerraformInitConfig,
  type TerraformRunChunk,
  type TerraformPlanResult,
  type TerraformApplyResult,
} from '../services/TerraformService.js';
import type { TfOutputs, ConfigService } from '../services/ConfigService.js';
import type { TerraformService } from '../services/TerraformService.js';
import type { AuditService, RecordAuditEntryParams } from '../services/AuditService.js';
import {
  RunRecordNotFoundError,
  RunRecordNotPlanError,
  RunRecordNotSuccessfulError,
  RunRecordTableNotConfiguredError,
  type RunRecordService,
} from '../services/RunRecordService.js';
import type { RunService } from '../services/RunService.js';
import { RunLockHeldError, APPROVAL_WINDOW_MS, type RunRecord, type RunLock } from '@hyveon/shared';

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

// `TerraformController.approve` resolves the approver identity via
// `os.userInfo().username` rather than trusting a client-supplied field —
// stub it the same way `AuditService.test.ts` does so tests can assert on a
// deterministic resolved username.
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    userInfo: vi.fn(() => ({ username: 'test-operator' })),
  };
});

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
 * whose `output` resolves `null` by default, whose `plan`/`apply` yield
 * nothing and return `undefined` by default, whose `getWorkspaceInFlight`
 * reports `null` (no in-flight run) by default, and whose
 * `computePlanHash` resolves `'plan-hash-abc'` by default — matching the
 * fixed `planHash` {@link makeApprovedPlanRecord} and `APPLY_PAYLOAD` both
 * use, so an accepted `apply()` submission's on-disk artifact
 * re-verification passes unmodified unless a test explicitly overrides it
 * to simulate a forged/tampered `.tfplan` artifact.
 */
function makeTerraform(): TerraformService {
  const stub: Partial<TerraformService> = {
    init: vi.fn().mockImplementation(async function* () { /* empty */ }),
    output: vi.fn().mockResolvedValue(null),
    plan: vi.fn().mockImplementation(async function* () { /* empty */ }),
    apply: vi.fn().mockImplementation(async function* () { /* empty */ }),
    getWorkspaceInFlight: vi.fn().mockReturnValue(null),
    computePlanHash: vi.fn().mockReturnValue('plan-hash-abc'),
    resolveRollbackTarget: vi.fn().mockResolvedValue({
      versionId: 'tfvars-v-prior',
      lastModified: new Date('2026-07-20T00:00:00.000Z'),
    }),
    confirmRollback: vi.fn().mockResolvedValue({ versionId: 'tfvars-v-new-head' }),
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
 * Build a `RunRecordService` stub whose `approveRun` resolves with the
 * approved record (`approvedBy`/`approvedAt` matching whatever it was called
 * with) by default, and whose `getByRunId` resolves `undefined` by default
 * (no matching plan run — the "no run found" rejection path in
 * `TerraformController.apply`). Tests can override either implementation to
 * simulate any of `RunRecordService`'s documented failure modes.
 */
function makeRunRecord(): {
  runRecord: RunRecordService;
  approveRun: ReturnType<typeof vi.fn>;
  getByRunId: ReturnType<typeof vi.fn>;
} {
  const approveRun = vi.fn().mockImplementation(async (runId: string, approvedBy: string) => {
    const record: RunRecord = {
      sk: `2026-07-21T00:00:00.000Z#${runId}`,
      runId,
      kind: 'plan',
      status: 'success',
      startedAt: '2026-07-21T00:00:00.000Z',
      completedAt: '2026-07-21T00:00:05.000Z',
      exitCode: 0,
      approvedBy,
      approvedAt: '2026-07-21T00:05:00.000Z',
    };
    return record;
  });
  const getByRunId = vi.fn().mockResolvedValue(undefined);
  const stub: Partial<RunRecordService> = { approveRun, getByRunId };
  return { runRecord: stub as RunRecordService, approveRun, getByRunId };
}

/**
 * Builds an approved, successful `plan` {@link RunRecord} ready to be applied
 * — `planHash` fixed at `'plan-hash-abc'` (matching {@link APPLY_PAYLOAD}'s
 * own `planHash`) and `approvedAt` set to "now" (well within
 * {@link APPROVAL_WINDOW_MS}), so `TerraformController.apply` accepts it
 * unmodified. Tests override individual fields (e.g. `approvedBy: undefined`,
 * a stale `approvedAt`, or a mismatched `planHash`) to exercise `apply`'s
 * rejection paths.
 */
function makeApprovedPlanRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    sk: `2026-07-21T00:00:00.000Z#plan-run-1`,
    runId: 'plan-run-1',
    kind: 'plan',
    status: 'success',
    startedAt: '2026-07-21T00:00:00.000Z',
    completedAt: '2026-07-21T00:00:05.000Z',
    exitCode: 0,
    planHash: 'plan-hash-abc',
    tfvarsVersionId: 'tfvars-v1',
    approvedBy: 'test-operator',
    approvedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** The `terraform.apply` payload matching {@link makeApprovedPlanRecord}'s default fixture. */
const APPLY_PAYLOAD = { planRunId: 'plan-run-1', planHash: 'plan-hash-abc' };

/**
 * Build a `RunService` stub whose `createRun` resolves a freshly "acquired"
 * {@link RunLock} by default (mirroring the real service's fallback to a
 * freshly minted id when no `runId` is supplied) and whose `releaseRun`
 * resolves immediately. Tests override `createRun`'s implementation (e.g. to
 * reject with {@link RunLockHeldError}) to simulate the durable apply lock
 * already being held by another run.
 */
function makeRunService(): { runService: RunService; createRun: ReturnType<typeof vi.fn>; releaseRun: ReturnType<typeof vi.fn> } {
  const createRun = vi.fn().mockImplementation(
    async (kind: 'plan' | 'apply' | 'destroy', initiator: string, runId?: string): Promise<RunLock> => ({
      runId: runId ?? 'minted-run-id',
      kind,
      initiator,
      acquiredAt: '2026-07-21T00:00:00.000Z',
      expiresAt: '2026-07-21T01:00:00.000Z',
    }),
  );
  const releaseRun = vi.fn().mockResolvedValue(undefined);
  const stub: Partial<RunService> = { createRun, releaseRun };
  return { runService: stub as RunService, createRun, releaseRun };
}

/** Build a `ConfigService` stub whose `getRunsDir` resolves a fixed directory by default. */
function makeConfig(runsDir = '/runs'): ConfigService {
  const stub: Partial<ConfigService> = { getRunsDir: vi.fn().mockReturnValue(runsDir) };
  return stub as ConfigService;
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
    vi.mocked(os.userInfo).mockReturnValue({ username: 'test-operator' } as ReturnType<typeof os.userInfo>);
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

    it('should register approve on the "terraform.approve" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, TerraformController.prototype.approve);
      expect(pattern).toEqual(['terraform.approve']);
    });

    it('should register apply on the "terraform.apply" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, TerraformController.prototype.apply);
      expect(pattern).toEqual(['terraform.apply']);
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

    it('should register ipcMain.handle for "terraform.apply" so ipcRenderer.invoke can resolve', async () => {
      await new TerraformController(makeTerraform()).onModuleInit();
      expect(mockIpcMainHandle).toHaveBeenCalledWith('terraform.apply', expect.any(Function));
    });

    it('should remove any existing "terraform.apply" handler before registering so hot-reload re-bootstrap does not throw', async () => {
      await new TerraformController(makeTerraform()).onModuleInit();
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('terraform.apply');
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

      expect(terraform.plan).toHaveBeenCalledWith('v123', expect.any(AbortSignal), result.runId, undefined);
    });

    it('should forward rolledBackFrom to TerraformService.plan when present on the payload', async () => {
      const terraform = makeTerraform();
      const { audit } = makeAudit();
      const { ctx } = makeCtx();

      const result = await new TerraformController(terraform, audit).plan(
        { tfvarsVersionId: 'v123', rolledBackFrom: 'apply-run-1' },
        ctx,
      );
      await flushPromises();

      expect(terraform.plan).toHaveBeenCalledWith('v123', expect.any(AbortSignal), result.runId, 'apply-run-1');
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
  // apply
  // -------------------------------------------------------------------------

  describe('apply', () => {
    /**
     * Wires up a `TerraformController` with every dependency `apply()` needs
     * (`terraform`, `audit`, `runRecord`, `runService`, `config`), returning
     * both the controller and the individual stubs/spies so each test can
     * override just the piece it's exercising.
     */
    function makeApplyController(terraform: TerraformService = makeTerraform()) {
      const { audit, record } = makeAudit();
      const { runRecord, getByRunId } = makeRunRecord();
      const { runService, createRun, releaseRun } = makeRunService();
      const config = makeConfig('/runs');
      getByRunId.mockResolvedValue(makeApprovedPlanRecord());
      const controller = new TerraformController(terraform, audit, runRecord, runService, config);
      return { controller, terraform, getByRunId, createRun, releaseRun, config, record };
    }

    it('should reject with { started: false, error } and never call TerraformService.apply when planRunId is missing', async () => {
      const { controller, terraform, createRun, record } = makeApplyController();
      const { ctx, sender } = makeCtx();

      const result = await controller.apply({ planRunId: '', planHash: 'plan-hash-abc' }, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.apply).not.toHaveBeenCalled();
      expect(createRun).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error } and never call TerraformService.apply when planHash is missing', async () => {
      const { controller, terraform, record } = makeApplyController();
      const { ctx } = makeCtx();

      const result = await controller.apply({ planRunId: 'plan-run-1', planHash: '' }, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.apply).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error } when no plan run exists for planRunId, without ever calling TerraformService.apply', async () => {
      const { controller, terraform, getByRunId, record } = makeApplyController();
      getByRunId.mockResolvedValue(undefined);
      const { ctx } = makeCtx();

      const result = await controller.apply(APPLY_PAYLOAD, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.apply).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error } when the run record is not a "plan" run, without ever calling TerraformService.apply', async () => {
      const { controller, terraform, getByRunId, record } = makeApplyController();
      getByRunId.mockResolvedValue(makeApprovedPlanRecord({ kind: 'apply' }));
      const { ctx } = makeCtx();

      const result = await controller.apply(APPLY_PAYLOAD, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.apply).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error } when the plan run has not been approved (missing approval), without ever calling TerraformService.apply', async () => {
      const { controller, terraform, getByRunId, createRun, record } = makeApplyController();
      getByRunId.mockResolvedValue(makeApprovedPlanRecord({ approvedBy: undefined, approvedAt: undefined }));
      const { ctx } = makeCtx();

      const result = await controller.apply(APPLY_PAYLOAD, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.apply).not.toHaveBeenCalled();
      expect(createRun).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error } when the approval has expired, without ever calling TerraformService.apply', async () => {
      const { controller, terraform, getByRunId, createRun, record } = makeApplyController();
      const staleApprovedAt = new Date(Date.now() - (APPROVAL_WINDOW_MS + 60_000)).toISOString();
      getByRunId.mockResolvedValue(makeApprovedPlanRecord({ approvedAt: staleApprovedAt }));
      const { ctx } = makeCtx();

      const result = await controller.apply(APPLY_PAYLOAD, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.apply).not.toHaveBeenCalled();
      expect(createRun).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error } when the supplied planHash does not match the approved plan record (mismatched/forged hash), without ever calling TerraformService.apply', async () => {
      const { controller, terraform, getByRunId, createRun, record } = makeApplyController();
      getByRunId.mockResolvedValue(makeApprovedPlanRecord({ planHash: 'plan-hash-abc' }));
      const { ctx } = makeCtx();

      const result = await controller.apply({ planRunId: 'plan-run-1', planHash: 'forged-hash' }, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.apply).not.toHaveBeenCalled();
      expect(createRun).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error } and never call TerraformService.apply or RunService.createRun when the on-disk plan artifact re-hashes to a different value (forged/tampered artifact), even though payload.planHash and record.planHash still agree', async () => {
      // Simulates a swapped/tampered .tfplan file on disk: the stored
      // RunRecord.planHash and payload.planHash both still say
      // 'plan-hash-abc' (makeApprovedPlanRecord()'s default), but a fresh
      // SHA-256 digest of the actual file content no longer matches — this
      // is exactly the artifact-level re-verification issue #109 requires,
      // on top of comparing the two in-memory hash values to each other.
      const terraform = makeTerraform();
      vi.mocked(terraform.computePlanHash).mockReturnValue('tampered-artifact-hash');
      const { controller, createRun, record } = makeApplyController(terraform);
      const { ctx } = makeCtx();

      const result = await controller.apply(APPLY_PAYLOAD, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.apply).not.toHaveBeenCalled();
      expect(createRun).not.toHaveBeenCalled();
      expect(terraform.computePlanHash).toHaveBeenCalledWith(
        join('/runs', 'plan-run-1', 'plan-run-1.tfplan'),
      );
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error } and never call TerraformService.apply when re-hashing the on-disk plan artifact throws (e.g. the file is missing)', async () => {
      const terraform = makeTerraform();
      vi.mocked(terraform.computePlanHash).mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });
      const { controller, createRun, record } = makeApplyController(terraform);
      const { ctx } = makeCtx();

      const result = await controller.apply(APPLY_PAYLOAD, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.apply).not.toHaveBeenCalled();
      expect(createRun).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error, conflict } and never call TerraformService.apply or RunService.createRun when the shared workspace is busy', async () => {
      const { controller, terraform, createRun, record } = makeApplyController();
      vi.mocked(terraform.getWorkspaceInFlight).mockReturnValue('plan');
      const { ctx } = makeCtx();

      const result = await controller.apply(APPLY_PAYLOAD, ctx);

      expect(result).toEqual({ started: false, error: expect.any(String), conflict: 'plan' });
      expect(terraform.apply).not.toHaveBeenCalled();
      expect(createRun).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should release the just-acquired apply lock and reject with { started: false, error, conflict } when the workspace becomes busy between the pre-lock check and RunService.createRun (TOCTOU regression)', async () => {
      const { controller, terraform, createRun, releaseRun, record } = makeApplyController();
      vi.mocked(terraform.getWorkspaceInFlight).mockReturnValueOnce(null).mockReturnValueOnce('plan');
      const { ctx } = makeCtx();

      const result = await controller.apply(APPLY_PAYLOAD, ctx);

      expect(result).toEqual({ started: false, error: expect.any(String), conflict: 'plan' });
      expect(createRun).toHaveBeenCalledWith('apply', 'test-operator', 'plan-run-1');
      expect(releaseRun).toHaveBeenCalledWith('plan-run-1');
      expect(terraform.apply).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error, conflict: "apply" } and never call TerraformService.apply when the durable apply lock is already held (RunLockHeldError)', async () => {
      const { controller, terraform, createRun, releaseRun, record } = makeApplyController();
      const heldLock: RunLock = {
        runId: 'other-run',
        kind: 'apply',
        initiator: 'someone-else',
        acquiredAt: '2026-07-21T00:00:00.000Z',
        expiresAt: '2026-07-21T01:00:00.000Z',
      };
      createRun.mockRejectedValue(new RunLockHeldError(heldLock));
      const { ctx } = makeCtx();

      const result = await controller.apply(APPLY_PAYLOAD, ctx);

      expect(result).toEqual({ started: false, error: expect.any(String), conflict: 'apply' });
      expect(terraform.apply).not.toHaveBeenCalled();
      // No lock was ever acquired by this call, so there is nothing to release.
      expect(releaseRun).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should acquire the apply lock with the plan record\'s runId as initiator, and call TerraformService.apply with the plan\'s runId, its stored tfvarsVersionId, and the expected plan file path', async () => {
      const { controller, terraform, createRun, config } = makeApplyController();
      const { ctx } = makeCtx();

      await controller.apply(APPLY_PAYLOAD, ctx);
      await flushPromises();

      expect(createRun).toHaveBeenCalledWith('apply', 'test-operator', 'plan-run-1');
      expect(terraform.apply).toHaveBeenCalledWith(
        'plan-run-1',
        'tfvars-v1',
        join(config.getRunsDir(), 'plan-run-1', 'plan-run-1.tfplan'),
        expect.any(AbortSignal),
      );
    });

    it('should record an audit entry with action "apply" for an accepted apply submission', async () => {
      const { controller, record } = makeApplyController();
      const { ctx } = makeCtx();

      await controller.apply(APPLY_PAYLOAD, ctx);
      await flushPromises();

      expect(record).toHaveBeenCalledTimes(1);
      const recordedEntry = record.mock.calls[0]?.[0] as RecordAuditEntryParams;
      expect(recordedEntry).toMatchObject({ action: 'apply', versionId: 'tfvars-v1' });
    });

    it('should resolve { started: true, runId } immediately, then deliver a normal end-message error and release the just-acquired lock, when TerraformService.apply rejects before spawning (e.g. a stale-tfvars guard)', async () => {
      // Mirrors plan()'s own synchronous-first-.next() workspace reservation
      // shape: the reservation happens synchronously before the ack
      // resolves, so a pre-spawn failure inside TerraformService.apply
      // itself (e.g. a StalePlanError) is *not* observed before the ack —
      // it surfaces later as a normal terraform.apply.end error once the
      // fire-and-forget streaming loop awaits its already-in-flight first
      // step, exactly like any other TerraformService.apply failure.
      // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate a pre-spawn (e.g. StalePlanError) failure
      async function* rejectsBeforeSpawn(): AsyncGenerator<TerraformRunChunk> {
        throw new Error('tfvars object is stale for this plan');
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.apply).mockImplementation(rejectsBeforeSpawn);
      const { controller, releaseRun } = makeApplyController(terraform);
      const { ctx, sender } = makeCtx();

      const result = await controller.apply(APPLY_PAYLOAD, ctx);

      expect(result).toEqual({ started: true, runId: 'plan-run-1' });

      await flushPromises();

      expect(sender.send).not.toHaveBeenCalledWith('terraform.apply.chunk', expect.anything());
      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'terraform.apply.end');
      expect(endCall?.[1]).toMatchObject({ runId: 'plan-run-1', exitCode: null });
      expect(String(endCall?.[1]?.error)).toContain('tfvars object is stale for this plan');
      expect(releaseRun).toHaveBeenCalledWith('plan-run-1');
    });

    it('should return { started: true, runId } immediately without waiting for the run to settle', async () => {
      // TerraformService.apply never yields/returns on its own here, so if
      // apply() awaited the whole loop (or even just its first step)
      // synchronously this call would hang.
      const terraform = makeTerraform();
      // eslint-disable-next-line require-yield -- generator intentionally never yields/returns to prove apply() doesn't await it
      vi.mocked(terraform.apply).mockImplementation(async function* () {
        await new Promise<void>(() => { /* never resolves */ });
      });
      const { controller } = makeApplyController(terraform);
      const { ctx } = makeCtx();

      const result = await controller.apply(APPLY_PAYLOAD, ctx);

      expect(result).toEqual({ started: true, runId: 'plan-run-1' });
    });

    it('should send each yielded chunk to the renderer via sender.send, in order, tagged with the plan\'s runId', async () => {
      const chunks: TerraformRunChunk[] = [
        { stream: 'stdout', line: 'terraform_appliance.game: Creating...' },
        { stream: 'stdout', line: 'Apply complete! Resources: 1 added, 0 changed, 0 destroyed.' },
      ];
      async function* yieldChunks() {
        for (const chunk of chunks) yield chunk;
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.apply).mockImplementation(yieldChunks);
      const { controller } = makeApplyController(terraform);
      const { ctx, sender } = makeCtx();

      await controller.apply(APPLY_PAYLOAD, ctx);
      await flushPromises();

      const chunkCalls = sender.send.mock.calls.filter(([channel]) => channel === 'terraform.apply.chunk');
      const runIds = new Set(chunkCalls.map(([, payload]) => (payload as { runId: string }).runId));
      expect(runIds).toEqual(new Set(['plan-run-1']));
      expect(chunkCalls.map(([, payload]) => (payload as { chunk: TerraformRunChunk }).chunk)).toEqual(chunks);
    });

    it('should send an end message with exitCode 0, the resolved result, and no error, and release the apply lock, when the run succeeds', async () => {
      const applyResult: TerraformApplyResult = { runId: 'plan-run-1', added: 1, changed: 0, destroyed: 0 };
      async function* succeeds(): AsyncGenerator<TerraformRunChunk, TerraformApplyResult> {
        yield { stream: 'stdout', line: 'Apply complete! Resources: 1 added, 0 changed, 0 destroyed.' };
        return applyResult;
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.apply).mockImplementation(succeeds);
      const { controller, releaseRun } = makeApplyController(terraform);
      const { ctx, sender } = makeCtx();

      await controller.apply(APPLY_PAYLOAD, ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith('terraform.apply.end', {
        runId: 'plan-run-1',
        exitCode: 0,
        result: applyResult,
      });
      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'terraform.apply.end');
      expect(endCall?.[1]).not.toHaveProperty('error');
      expect(releaseRun).toHaveBeenCalledWith('plan-run-1');
    });

    it('should send an end message with the process exit code and a stringified error, and still release the apply lock, on TerraformApplyError', async () => {
      async function* failsWithExitCode(): AsyncGenerator<TerraformRunChunk> {
        yield { stream: 'stderr', line: 'Error: creation failed' };
        throw new TerraformApplyError(1);
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.apply).mockImplementation(failsWithExitCode);
      const { controller, releaseRun } = makeApplyController(terraform);
      const { ctx, sender } = makeCtx();

      await controller.apply(APPLY_PAYLOAD, ctx);
      await flushPromises();

      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'terraform.apply.end');
      expect(endCall?.[1]).toMatchObject({ exitCode: 1 });
      expect(String(endCall?.[1]?.error)).toContain('terraform apply exited with code 1');
      expect(releaseRun).toHaveBeenCalledWith('plan-run-1');
    });

    it('should not send further chunks or an end message, should finalize the generator via stream.return, and should still release the apply lock, once the WebContents is destroyed', async () => {
      let returnCalled = false;
      async function* twoLines(): AsyncGenerator<TerraformRunChunk, TerraformApplyResult | undefined> {
        try {
          yield { stream: 'stdout', line: 'first' };
          yield { stream: 'stdout', line: 'second' };
          return undefined;
        } finally {
          returnCalled = true;
        }
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.apply).mockImplementation(twoLines);
      const { controller, releaseRun } = makeApplyController(terraform);
      // Simulate WebContents already destroyed before the loop runs.
      const { ctx, sender } = makeCtx(true);

      await controller.apply(APPLY_PAYLOAD, ctx);
      await flushPromises();

      expect(sender.send).not.toHaveBeenCalled();
      expect(returnCalled).toBe(true);
      expect(releaseRun).toHaveBeenCalledWith('plan-run-1');
    });

    it('should return { started: false, error } when no RunRecordService is available', async () => {
      const terraform = makeTerraform();
      const controller = new TerraformController(terraform);
      const { ctx } = makeCtx();

      const result = await controller.apply(APPLY_PAYLOAD, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.apply).not.toHaveBeenCalled();
    });

    it('should return { started: false, error } when no RunService is available', async () => {
      const terraform = makeTerraform();
      const { audit } = makeAudit();
      const { runRecord, getByRunId } = makeRunRecord();
      getByRunId.mockResolvedValue(makeApprovedPlanRecord());
      const controller = new TerraformController(terraform, audit, runRecord);
      const { ctx } = makeCtx();

      const result = await controller.apply(APPLY_PAYLOAD, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.apply).not.toHaveBeenCalled();
    });

    it('should return { started: false, error } when no ConfigService is available', async () => {
      const terraform = makeTerraform();
      const { audit } = makeAudit();
      const { runRecord, getByRunId } = makeRunRecord();
      getByRunId.mockResolvedValue(makeApprovedPlanRecord());
      const { runService } = makeRunService();
      const controller = new TerraformController(terraform, audit, runRecord, runService);
      const { ctx } = makeCtx();

      const result = await controller.apply(APPLY_PAYLOAD, ctx);

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.apply).not.toHaveBeenCalled();
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

  // -------------------------------------------------------------------------
  // approve
  // -------------------------------------------------------------------------

  describe('approve', () => {
    it('should write approvedBy/approvedAt to the run record, using the OS-resolved username, and return them on a successful plan run', async () => {
      const terraform = makeTerraform();
      const { runRecord, approveRun } = makeRunRecord();
      const { audit, record } = makeAudit();

      const result = await new TerraformController(terraform, audit, runRecord).approve({
        planRunId: 'run-123',
      });

      // The approver identity is always resolved server-side from
      // os.userInfo() — never taken from the (now nonexistent) client
      // payload field — so approveRun must be called with the stubbed OS
      // username rather than anything the caller supplied.
      expect(approveRun).toHaveBeenCalledWith('run-123', 'test-operator');
      expect(result).toEqual({
        approved: true,
        approvedBy: 'test-operator',
        approvedAt: expect.any(String),
      });
      expect(record).toHaveBeenCalledTimes(1);
      const recordedEntry = record.mock.calls[0][0] as RecordAuditEntryParams;
      expect(recordedEntry).toMatchObject({ action: 'approve' });
    });

    it('should return { approved: false, error } and never call RunRecordService.approveRun or AuditService.record when planRunId is missing', async () => {
      const terraform = makeTerraform();
      const { runRecord, approveRun } = makeRunRecord();
      const { audit, record } = makeAudit();

      const result = await new TerraformController(terraform, audit, runRecord).approve({
        planRunId: '',
      });

      expect(result.approved).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(approveRun).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('should return { approved: false, error } when the run-history table is not configured, without writing anything or recording an audit entry', async () => {
      const terraform = makeTerraform();
      const { runRecord, approveRun } = makeRunRecord();
      const { audit, record } = makeAudit();
      const error = new RunRecordTableNotConfiguredError('run-123');
      approveRun.mockRejectedValue(error);

      const result = await new TerraformController(terraform, audit, runRecord).approve({
        planRunId: 'run-123',
      });

      expect(result).toEqual({ approved: false, error: error.message });
      expect(record).not.toHaveBeenCalled();
    });

    it('should return { approved: false, error } when no run record exists for planRunId, without writing anything or recording an audit entry', async () => {
      const terraform = makeTerraform();
      const { runRecord, approveRun } = makeRunRecord();
      const { audit, record } = makeAudit();
      const error = new RunRecordNotFoundError('run-123');
      approveRun.mockRejectedValue(error);

      const result = await new TerraformController(terraform, audit, runRecord).approve({
        planRunId: 'run-123',
      });

      expect(result).toEqual({ approved: false, error: error.message });
      expect(record).not.toHaveBeenCalled();
    });

    it('should return { approved: false, error } when the run record is not a plan run, without writing anything or recording an audit entry', async () => {
      const terraform = makeTerraform();
      const { runRecord, approveRun } = makeRunRecord();
      const { audit, record } = makeAudit();
      const error = new RunRecordNotPlanError('run-123', 'apply');
      approveRun.mockRejectedValue(error);

      const result = await new TerraformController(terraform, audit, runRecord).approve({
        planRunId: 'run-123',
      });

      expect(result).toEqual({ approved: false, error: error.message });
      expect(record).not.toHaveBeenCalled();
    });

    it('should return { approved: false, error } when the plan run did not succeed, without writing anything or recording an audit entry', async () => {
      const terraform = makeTerraform();
      const { runRecord, approveRun } = makeRunRecord();
      const { audit, record } = makeAudit();
      const error = new RunRecordNotSuccessfulError('run-123', 'failed');
      approveRun.mockRejectedValue(error);

      const result = await new TerraformController(terraform, audit, runRecord).approve({
        planRunId: 'run-123',
      });

      expect(result).toEqual({ approved: false, error: error.message });
      expect(record).not.toHaveBeenCalled();
    });

    it('should return { approved: false, error } when no RunRecordService is available', async () => {
      const terraform = makeTerraform();

      const result = await new TerraformController(terraform).approve({
        planRunId: 'run-123',
      });

      expect(result.approved).toBe(false);
      expect(typeof result.error).toBe('string');
    });
  });

  describe('resolveRollback', () => {
    it('should return resolved: true with the target versionId and lastModified on success', async () => {
      const terraform = makeTerraform();

      const result = await new TerraformController(terraform).resolveRollback({
        applyRunId: 'apply-run-1',
      });

      expect(terraform.resolveRollbackTarget).toHaveBeenCalledWith('apply-run-1');
      expect(result).toEqual({
        resolved: true,
        versionId: 'tfvars-v-prior',
        lastModified: '2026-07-20T00:00:00.000Z',
      });
    });

    it('should return { resolved: false, error } and never call TerraformService.resolveRollbackTarget when applyRunId is missing', async () => {
      const terraform = makeTerraform();

      const result = await new TerraformController(terraform).resolveRollback({
        applyRunId: '',
      });

      expect(result.resolved).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.resolveRollbackTarget).not.toHaveBeenCalled();
    });

    it('should return { resolved: false, error } with the thrown error message when resolution fails', async () => {
      const terraform = makeTerraform();
      const error = new RollbackVersionMissingError('tfvars-v-expired');
      vi.mocked(terraform.resolveRollbackTarget).mockRejectedValue(error);

      const result = await new TerraformController(terraform).resolveRollback({
        applyRunId: 'apply-run-1',
      });

      expect(result).toEqual({ resolved: false, error: error.message });
    });
  });

  describe('confirmRollback', () => {
    it('should return confirmed: true with the new head versionId on success', async () => {
      const terraform = makeTerraform();

      const result = await new TerraformController(terraform).confirmRollback({
        applyRunId: 'apply-run-1',
      });

      expect(terraform.confirmRollback).toHaveBeenCalledWith('apply-run-1');
      expect(result).toEqual({ confirmed: true, versionId: 'tfvars-v-new-head' });
    });

    it('should return { confirmed: false, error } and never call TerraformService.confirmRollback when applyRunId is missing', async () => {
      const terraform = makeTerraform();

      const result = await new TerraformController(terraform).confirmRollback({
        applyRunId: '',
      });

      expect(result.confirmed).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.confirmRollback).not.toHaveBeenCalled();
    });

    it('should return { confirmed: false, error } with the thrown error message and write nothing when confirmation fails', async () => {
      const terraform = makeTerraform();
      const error = new RollbackVersionMissingError('tfvars-v-expired');
      vi.mocked(terraform.confirmRollback).mockRejectedValue(error);

      const result = await new TerraformController(terraform).confirmRollback({
        applyRunId: 'apply-run-1',
      });

      expect(result).toEqual({ confirmed: false, error: error.message });
    });
  });
});
