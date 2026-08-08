/**
 * Unit tests for `PulumiService.resolveRollbackTarget`/`.confirmRollback`
 * — the rollback flow, which holds `PulumiService`'s private
 * `operationInFlight` guard across the restore write AND the follow-up
 * plan's persistence — see `confirmRollback`'s own TSDoc,
 * "Why restore and plan are one guarded unit".
 *
 * Named `PulumiService.rollback.test.ts` (covering both methods jointly,
 * not one-method-scoped like `PulumiService.preview.test.ts`/
 * `.apply.test.ts`/`.destroy.test.ts`) because `resolveRollbackTarget` and
 * `confirmRollback` are tightly coupled — `confirmRollback` calls
 * `resolveRollbackTarget` internally.
 *
 * `node:fs` is fully mocked (mirrors every other `PulumiService.*.test.ts`
 * file) so no test touches the real filesystem. `node:crypto`'s `randomUUID`
 * is mocked for a deterministic `runId`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModuleRef } from '@nestjs/core';
import type { PreviewOptions, PreviewResult, Stack } from '@pulumi/pulumi/automation/index.js';
import type { RemoteFileStore, RunRecord } from '@hyveon/shared';

const { mkdirSyncMock, existsSyncMock, writeFileSyncMock, readFileSyncMock, randomUUIDMock, loggerMock } = vi.hoisted(
  () => ({
    mkdirSyncMock: vi.fn(),
    existsSyncMock: vi.fn(),
    writeFileSyncMock: vi.fn(),
    readFileSyncMock: vi.fn(),
    randomUUIDMock: vi.fn(),
    loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }),
);

vi.mock('node:fs', () => ({
  mkdirSync: mkdirSyncMock,
  existsSync: existsSyncMock,
  writeFileSync: writeFileSyncMock,
  readFileSync: readFileSyncMock,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: randomUUIDMock };
});

vi.mock('../logger.js', () => ({ logger: loggerMock }));

import {
  PulumiService,
  PulumiPreviewError,
  PulumiRollbackPlanFailedError,
  RollbackTargetNotFoundError,
  RollbackNotApplyRunError,
  RollbackNoConfigVersionError,
  RollbackVersionMissingError,
  RUN_RECORD_PERSISTER,
  DEPLOYMENT_CONFIG_SERVICE,
  type RunRecordPersister,
  type DeploymentConfigRestorer,
} from './PulumiService.js';
import { REMOTE_FILE_STORE } from '../modules/cloud-provider.tokens.js';
import type { PulumiWorkspaceService } from './PulumiWorkspaceService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import type { PulumiEngineService } from './PulumiEngineService.js';
import { SafeStorageService } from './SafeStorageService.js';

const APPLY_RUN_ID = 'apply-run-1';
/** The apply run's own recorded configuration version — the rollback's starting point. */
const APPLY_CONFIG_VERSION_ID = 'cfg-v3';
/** The version immediately before `APPLY_CONFIG_VERSION_ID` in history — the rollback target. */
const PRIOR_CONFIG_VERSION_ID = 'cfg-v2';
/** The version {@link DeploymentConfigRestorer.restoreRawConfig} writes as the fresh new head once restored. */
const RESTORED_CONFIG_VERSION_ID = 'cfg-v4';
const HISTORIC_RAW_CONFIG = JSON.stringify({ hostedZoneName: 'example.com', gameServers: { old: {} } });

/** `bootstrap`/`aws`/`pulumi` fields `confirmRollback()`'s delegated `previewCore()` reads off the store. */
const FULLY_CONFIGURED = { stateBucket: 'my-state-bucket', passphrase: 'enc-secret', awsRegion: 'us-east-1' };

/** Builds a real `ElectronStoreService` (in-memory Map outside Electron) with the given fields pre-seeded. */
function makeStore(
  opts: { stateBucket?: string; passphrase?: string; awsRegion?: string; configurationBucket?: string } = {},
): ElectronStoreService {
  const store = new ElectronStoreService(new SafeStorageService());
  if (opts.stateBucket !== undefined || opts.configurationBucket !== undefined) {
    store.set('bootstrap', {
      stateBucket: opts.stateBucket ?? '',
      configurationBucket: opts.configurationBucket ?? '',
    });
  }
  if (opts.passphrase !== undefined) {
    store.set('pulumi', { passphrase: opts.passphrase });
  }
  if (opts.awsRegion !== undefined) {
    store.set('aws', { region: opts.awsRegion });
  }
  return store;
}

/** A fully-configured store, including a configuration bucket. */
function makeFullyConfiguredStore(): ElectronStoreService {
  return makeStore({ ...FULLY_CONFIGURED, configurationBucket: 'hyveon-config' });
}

/** A well-formed `apply`-kind run record naming `APPLY_CONFIG_VERSION_ID` — the target `resolveRollbackTarget` looks up. */
function makeApplyRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date();
  return {
    sk: `${now.toISOString()}#${APPLY_RUN_ID}`,
    runId: APPLY_RUN_ID,
    kind: 'apply',
    status: 'success',
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    exitCode: 0,
    configVersionId: APPLY_CONFIG_VERSION_ID,
    ...overrides,
  };
}

/** `RunRecordPersister` stub — `getByRunId` resolves `record` by default, `persist`/`writePreflightMarker` are directly-inspectable mocks. */
function makeRunRecordPersister(
  record: RunRecord | undefined = makeApplyRunRecord(),
): RunRecordPersister & {
  persist: ReturnType<typeof vi.fn>;
  getByRunId: ReturnType<typeof vi.fn>;
  writePreflightMarker: ReturnType<typeof vi.fn>;
} {
  return {
    getByRunId: vi.fn().mockResolvedValue(record),
    persist: vi.fn().mockResolvedValue(undefined),
    writePreflightMarker: vi.fn().mockResolvedValue(undefined),
  };
}

/** The version history `listVersions` returns by default — newest-first, `APPLY_CONFIG_VERSION_ID` immediately followed by `PRIOR_CONFIG_VERSION_ID`. */
function defaultVersionHistory(): { versionId: string; lastModified: Date }[] {
  return [
    { versionId: APPLY_CONFIG_VERSION_ID, lastModified: new Date('2026-01-03') },
    { versionId: PRIOR_CONFIG_VERSION_ID, lastModified: new Date('2026-01-02') },
    { versionId: 'cfg-v1', lastModified: new Date('2026-01-01') },
  ];
}

/** `RemoteFileStore` stub whose `listVersions`/`getVersion`/`get` resolve fixture content by default. */
function makeRemoteFileStore(
  overrides: Partial<RemoteFileStore> = {},
): RemoteFileStore & { listVersions: ReturnType<typeof vi.fn>; getVersion: ReturnType<typeof vi.fn> } {
  const store: Partial<RemoteFileStore> = {
    get: vi.fn().mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ hostedZoneName: 'example.com', gameServers: {} })),
      etag: 'etag-1',
    }),
    put: vi.fn(),
    listVersions: vi.fn().mockResolvedValue(defaultVersionHistory()),
    getVersion: vi.fn().mockImplementation((_path: string, versionId: string) =>
      versionId === PRIOR_CONFIG_VERSION_ID
        ? Promise.resolve({ body: new TextEncoder().encode(HISTORIC_RAW_CONFIG) })
        : Promise.resolve(undefined),
    ),
  };
  return Object.assign(store, overrides) as RemoteFileStore & {
    listVersions: ReturnType<typeof vi.fn>;
    getVersion: ReturnType<typeof vi.fn>;
  };
}

/** `DeploymentConfigRestorer` stub — `restoreRawConfig` resolves a fresh version id by default. */
function makeDeploymentConfigRestorer(
  overrides: Partial<DeploymentConfigRestorer> = {},
): DeploymentConfigRestorer & { restoreRawConfig: ReturnType<typeof vi.fn> } {
  const restorer: DeploymentConfigRestorer = {
    restoreRawConfig: vi.fn().mockResolvedValue({ etag: 'etag-restored', versionId: RESTORED_CONFIG_VERSION_ID }),
  };
  return Object.assign(restorer, overrides) as DeploymentConfigRestorer & { restoreRawConfig: ReturnType<typeof vi.fn> };
}

/**
 * Builds a `remoteFileStore`/`deploymentConfigRestorer` pair that stay consistent with
 * each other the way the real S3-backed implementations would: calling
 * `restoreRawConfig` pushes a fresh `RESTORED_CONFIG_VERSION_ID` entry onto
 * the SAME version history `listVersions` reads from. This matters because
 * `confirmRollback` passes the just-restored version id to `previewCore` as
 * its expected `configVersionId` — `previewCore`'s own staleness check
 * (`head.versionId !== configVersionId`) would spuriously fire on every
 * "the plan actually runs" test if `restoreRawConfig` and `listVersions`
 * were independently stubbed against two different fixed snapshots, since
 * nothing would ever make the mocked `listVersions` head move to reflect the
 * mocked restore. `makeService`'s default `remoteFileStore`/`deploymentConfigRestorer`
 * come from this helper for exactly that reason; a test that overrides
 * either one directly (e.g. the "historic version expired" scenario, which
 * needs `deploymentConfigRestorer.restoreRawConfig` to NEVER be called at all) opts
 * out of this coupling on purpose.
 */
function makeConfigStores(): {
  remoteFileStore: RemoteFileStore & { listVersions: ReturnType<typeof vi.fn>; getVersion: ReturnType<typeof vi.fn> };
  deploymentConfigRestorer: DeploymentConfigRestorer & { restoreRawConfig: ReturnType<typeof vi.fn> };
} {
  const versionHistory = defaultVersionHistory();
  const remoteFileStore = makeRemoteFileStore({
    listVersions: vi.fn().mockImplementation(() => Promise.resolve([...versionHistory])),
  });
  const deploymentConfigRestorer = makeDeploymentConfigRestorer({
    restoreRawConfig: vi.fn().mockImplementation(async () => {
      versionHistory.unshift({ versionId: RESTORED_CONFIG_VERSION_ID, lastModified: new Date() });
      return { etag: 'etag-restored', versionId: RESTORED_CONFIG_VERSION_ID };
    }),
  });
  return { remoteFileStore, deploymentConfigRestorer };
}

/** Shape `confirmRollback()`'s delegated `previewCore()` drives `stack.preview` with. */
type FakeStackPreview = (opts: PreviewOptions) => Promise<PreviewResult>;

/** Builds a `PulumiWorkspaceService` stub whose `getOrCreateStack` resolves to a stack stub wrapping the given `preview` implementation. */
function makeWorkspace(previewImpl: FakeStackPreview): PulumiWorkspaceService & {
  getOrCreateStack: ReturnType<typeof vi.fn>;
} {
  const previewMock = vi.fn().mockImplementation(previewImpl);
  const getOrCreateStack = vi.fn().mockResolvedValue({ preview: previewMock } as Partial<Stack> as Stack);
  return { getOrCreateStack } as unknown as PulumiWorkspaceService & { getOrCreateStack: ReturnType<typeof vi.fn> };
}

/** A `stack.preview` implementation that resolves cleanly with an empty change summary. */
function makeHappyPathPreview(): FakeStackPreview {
  return async () => ({ stdout: '', stderr: '', changeSummary: { same: 1 } });
}

/**
 * Stub `ModuleRef` routing `.get(token, { strict: false })` to the given
 * `RunRecordPersister`/`RemoteFileStore`/`DeploymentConfigRestorer` stubs — mirrors how
 * `confirmRollback()`/`resolveRollbackTarget()` actually resolve them at call
 * time (`getRunRecordPersister`/`getRemoteFileStore`/`getDeploymentConfigService`).
 */
function makeModuleRef(deps: {
  runRecordPersister: RunRecordPersister;
  remoteFileStore: RemoteFileStore;
  deploymentConfigRestorer: DeploymentConfigRestorer;
}): ModuleRef {
  const get = vi.fn((token: unknown) => {
    if (token === RUN_RECORD_PERSISTER) return deps.runRecordPersister;
    if (token === REMOTE_FILE_STORE) return deps.remoteFileStore;
    if (token === DEPLOYMENT_CONFIG_SERVICE) return deps.deploymentConfigRestorer;
    throw new Error(`ModuleRef.get() called with an unexpected token: ${String(token)}`);
  });
  return { get } as unknown as ModuleRef;
}

/** Stub `PulumiEngineService` — neither `resolveRollbackTarget` nor `confirmRollback` ever touch it. */
function makeEngine(): PulumiEngineService {
  return {
    resolve: vi.fn(() => {
      throw new Error('PulumiEngineService.resolve() was not expected to be called by this test');
    }),
    getResolvedVersion: vi.fn(() => {
      throw new Error('PulumiEngineService.getResolvedVersion() was not expected to be called by this test');
    }),
  } as unknown as PulumiEngineService;
}

/** Constructs `PulumiService` with every dependency stubbed. */
function makeService(opts: {
  workspace?: PulumiWorkspaceService;
  store?: ElectronStoreService;
  runRecordPersister?: ReturnType<typeof makeRunRecordPersister>;
  remoteFileStore?: ReturnType<typeof makeRemoteFileStore>;
  deploymentConfigRestorer?: ReturnType<typeof makeDeploymentConfigRestorer>;
  engine?: PulumiEngineService;
}): PulumiService {
  const runRecordPersister = opts.runRecordPersister ?? makeRunRecordPersister();
  const coupled = makeConfigStores();
  const remoteFileStore = opts.remoteFileStore ?? coupled.remoteFileStore;
  const deploymentConfigRestorer = opts.deploymentConfigRestorer ?? coupled.deploymentConfigRestorer;
  return new PulumiService(
    opts.workspace ?? makeWorkspace(makeHappyPathPreview()),
    opts.store ?? makeFullyConfiguredStore(),
    makeModuleRef({ runRecordPersister, remoteFileStore, deploymentConfigRestorer }),
    opts.engine ?? makeEngine(),
  );
}

/** Drains a `confirmRollback()` async generator to completion, collecting every yielded chunk plus the final return value. */
async function collectRollbackChunks(gen: ReturnType<PulumiService['confirmRollback']>) {
  const chunks: { stream: 'stdout' | 'stderr'; line: string }[] = [];
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await gen.next();
  }
  return { chunks, result: next.value };
}

/**
 * Drives any `preview()`-shaped generator to completion and returns its
 * final resolved value — used (instead of inspecting the FIRST `.next()`
 * call's `done` flag) to prove `operationInFlight` is free again after a
 * rollback settles. `makeHappyPathPreview()` in this file never calls
 * `onOutput`/`onError`, so a successful run yields zero chunks and its very
 * first `.next()` already resolves `done: true` — checking `done === false`
 * on that first call would be a false negative for exactly the success case
 * these tests want to prove.
 */
async function drainToCompletion<T>(gen: AsyncGenerator<unknown, T>): Promise<T> {
  let next = await gen.next();
  while (!next.done) {
    next = await gen.next();
  }
  return next.value;
}

beforeEach(() => {
  mkdirSyncMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
  writeFileSyncMock.mockReset();
  readFileSyncMock.mockReset();
  readFileSyncMock.mockReturnValue(Buffer.from(JSON.stringify({ manifest: { version: 'v3.255.0' } })));
  randomUUIDMock.mockReset();
  randomUUIDMock.mockReturnValue('rollback-run-1');
  loggerMock.warn.mockReset();
});

describe('PulumiService.resolveRollbackTarget', () => {
  it('should resolve the configuration version immediately before the apply run', async () => {
    const service = makeService({});

    const target = await service.resolveRollbackTarget(APPLY_RUN_ID);

    expect(target).toEqual({ versionId: PRIOR_CONFIG_VERSION_ID, lastModified: new Date('2026-01-02') });
  });

  it('should throw RollbackTargetNotFoundError when no run record exists for the applyRunId', async () => {
    const runRecordPersister = makeRunRecordPersister();
    runRecordPersister.getByRunId.mockResolvedValue(undefined);
    const service = makeService({ runRecordPersister });

    await expect(service.resolveRollbackTarget(APPLY_RUN_ID)).rejects.toBeInstanceOf(RollbackTargetNotFoundError);
  });

  it('should throw RollbackNotApplyRunError when the run record is not an apply run', async () => {
    const runRecordPersister = makeRunRecordPersister(makeApplyRunRecord({ kind: 'plan' }));
    const service = makeService({ runRecordPersister });

    await expect(service.resolveRollbackTarget(APPLY_RUN_ID)).rejects.toBeInstanceOf(RollbackNotApplyRunError);
  });

  it('should throw RollbackNoConfigVersionError when the apply run has no recorded configuration version id', async () => {
    const runRecordPersister = makeRunRecordPersister(makeApplyRunRecord({ configVersionId: undefined }));
    const service = makeService({ runRecordPersister });

    await expect(service.resolveRollbackTarget(APPLY_RUN_ID)).rejects.toBeInstanceOf(RollbackNoConfigVersionError);
  });

  it('should throw RollbackVersionMissingError when no earlier configuration version exists in history', async () => {
    const remoteFileStore = makeRemoteFileStore({
      listVersions: vi.fn().mockResolvedValue([{ versionId: APPLY_CONFIG_VERSION_ID, lastModified: new Date() }]),
    });
    const service = makeService({ remoteFileStore });

    await expect(service.resolveRollbackTarget(APPLY_RUN_ID)).rejects.toBeInstanceOf(RollbackVersionMissingError);
  });
});

describe('PulumiService.computeRollbackDiff', () => {
  /** A minimal, valid target/current pair with a few deliberate differences, for a happy-path assertion. */
  const TARGET_CONFIG = { hostedZoneName: 'example.com', dnsTtl: 30, gameServers: { minecraft: { image: 'a' } } };
  const CURRENT_CONFIG = { hostedZoneName: 'example.com', dnsTtl: 60, gameServers: { palworld: { image: 'b' } } };

  it('should return a diff computed from the target version and the current head', async () => {
    const remoteFileStore = makeRemoteFileStore({
      get: vi.fn().mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify(CURRENT_CONFIG)), etag: 'e' }),
      getVersion: vi.fn().mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify(TARGET_CONFIG)) }),
    });
    const service = makeService({ remoteFileStore });

    const diff = await service.computeRollbackDiff(PRIOR_CONFIG_VERSION_ID);

    expect(diff).toEqual({
      changedFields: ['dnsTtl'],
      gameServers: { added: ['palworld'], removed: ['minecraft'], changed: [] },
    });
  });

  it('should return undefined without throwing when the target version bytes cannot be read', async () => {
    const remoteFileStore = makeRemoteFileStore({
      getVersion: vi.fn().mockResolvedValue(undefined),
    });
    const service = makeService({ remoteFileStore });

    await expect(service.computeRollbackDiff(PRIOR_CONFIG_VERSION_ID)).resolves.toBeUndefined();
  });

  it('should return undefined without throwing when the current head is missing', async () => {
    const remoteFileStore = makeRemoteFileStore({
      get: vi.fn().mockResolvedValue(undefined),
      getVersion: vi.fn().mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify(TARGET_CONFIG)) }),
    });
    const service = makeService({ remoteFileStore });

    await expect(service.computeRollbackDiff(PRIOR_CONFIG_VERSION_ID)).resolves.toBeUndefined();
  });

  it('should return undefined without throwing when the target version JSON is malformed', async () => {
    const remoteFileStore = makeRemoteFileStore({
      getVersion: vi.fn().mockResolvedValue({ body: new TextEncoder().encode('{not valid json') }),
    });
    const service = makeService({ remoteFileStore });

    await expect(service.computeRollbackDiff(PRIOR_CONFIG_VERSION_ID)).resolves.toBeUndefined();
  });

  it('should return undefined without throwing when a fetch rejects', async () => {
    const remoteFileStore = makeRemoteFileStore({
      getVersion: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const service = makeService({ remoteFileStore });

    await expect(service.computeRollbackDiff(PRIOR_CONFIG_VERSION_ID)).resolves.toBeUndefined();
  });

  it('should report zero changes when the target and current configs are structurally identical', async () => {
    const remoteFileStore = makeRemoteFileStore({
      get: vi.fn().mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify(TARGET_CONFIG)), etag: 'e' }),
      getVersion: vi.fn().mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify(TARGET_CONFIG)) }),
    });
    const service = makeService({ remoteFileStore });

    const diff = await service.computeRollbackDiff(PRIOR_CONFIG_VERSION_ID);

    expect(diff).toEqual({ changedFields: [], gameServers: { added: [], removed: [], changed: [] } });
  });
});

describe('PulumiService.confirmRollback happy path', () => {
  it('should restore the historic bytes byte-for-byte and queue a plan tagged rolledBackFrom', async () => {
    const runRecordPersister = makeRunRecordPersister();
    // Coupled pair (see makeConfigStores' doc comment) — this test drives
    // confirmRollback all the way through previewCore's own staleness
    // re-check, which requires listVersions' head to actually reflect the
    // restore restoreRawConfig just performed.
    const { remoteFileStore, deploymentConfigRestorer } = makeConfigStores();
    const service = makeService({ runRecordPersister, remoteFileStore, deploymentConfigRestorer });

    const { result } = await collectRollbackChunks(service.confirmRollback(APPLY_RUN_ID));

    expect(deploymentConfigRestorer.restoreRawConfig).toHaveBeenCalledWith(HISTORIC_RAW_CONFIG);
    expect(result).toBeDefined();
    expect(result?.runId).toBe('rollback-run-1');

    expect(runRecordPersister.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'plan',
        rolledBackFrom: APPLY_RUN_ID,
        configVersionId: RESTORED_CONFIG_VERSION_ID,
      }),
      expect.anything(),
    );
  });

  it('should leave operationInFlight free again once confirmRollback settles, allowing a subsequent preview()', async () => {
    const service = makeService({});

    await collectRollbackChunks(service.confirmRollback(APPLY_RUN_ID));

    const result = await drainToCompletion(service.preview());
    expect(result).toBeDefined();
  });

  /**
   * Regression test for Finding 3 (final whole-branch review):
   * `confirmRollback` forwards its own `signal` straight through to
   * `previewCore` (see that method's TSDoc, "Why previewCore, not
   * preview()") without attaching a listener of its own, so previewCore's
   * abort-listener leak fix (see `PulumiService.preview.test.ts`'s identical
   * test) covers this path automatically — proven directly here rather than
   * assumed, since `confirmRollback` is a distinct public entry point.
   */
  it('should actually remove the abort listener on normal completion for the forwarded signal, not merely register it with { once: true }', async () => {
    const service = makeService({});
    const controller = new AbortController();
    const addEventListenerSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await collectRollbackChunks(service.confirmRollback(APPLY_RUN_ID, controller.signal));

    expect(addEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    const registeredHandler = addEventListenerSpy.mock.calls[0]![1];
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', registeredHandler);
    expect(controller.signal.aborted).toBe(false);
  });
});

describe('PulumiService.confirmRollback concurrency guard', () => {
  it('should refuse preview()/apply()/destroy() calls started while a rollback is mid-flight, naming rollback as the busy operation', async () => {
    // Mirrors PulumiService.preview.test.ts's identical "already in flight"
    // test pattern: a never-resolving getByRunId keeps confirmRollback
    // suspended at resolveRollbackTarget's first await, well after its
    // synchronous prologue has already set operationInFlight = 'rollback'.
    const runRecordPersister = makeRunRecordPersister();
    runRecordPersister.getByRunId.mockImplementation(() => new Promise<RunRecord>(() => {}));
    const service = makeService({ runRecordPersister });

    const rollbackGen = service.confirmRollback(APPLY_RUN_ID);
    void rollbackGen.next(); // Drive it far enough to set operationInFlight.
    await Promise.resolve();
    await Promise.resolve();

    const previewGen = service.preview();
    await expect(previewGen.next()).rejects.toThrow(/rollback.*already.*running/i);

    const applyGen = service.apply('plan-1', 'hash-1');
    await expect(applyGen.next()).rejects.toThrow(/rollback.*already.*running/i);

    const destroyGen = service.destroy('token-1');
    await expect(destroyGen.next()).rejects.toThrow(/rollback.*already.*running/i);
  });

  it('should throw synchronously when confirmRollback() is called while initializeStack() is already in flight', async () => {
    // Regression test for a code-reviewer-traced race: initializeStack()
    // does not set `operationInFlight` (see PulumiService.ts's own
    // `stackInitInFlight` doc comment for why it's a separate flag), so
    // confirmRollback() must check `stackInitInFlight` itself or it would
    // sail straight through its own top-of-function check while
    // initializeStack() is still running against the same shared local
    // workspace.
    const hangingWorkspace = {
      getOrCreateStack: vi.fn(() => new Promise(() => {
        // Never resolves — keeps initializeStack() "in flight" for this test.
      })),
    } as unknown as PulumiWorkspaceService;
    const service = makeService({ workspace: hangingWorkspace });

    const initPromise = service.initializeStack();
    await Promise.resolve();
    await Promise.resolve();

    await expect(collectRollbackChunks(service.confirmRollback(APPLY_RUN_ID))).rejects.toThrow(
      /initializeStack.*already running/i,
    );

    void initPromise.catch(() => {}); // Left permanently in flight — never awaited to settle, by design.
  });
});

describe('PulumiService.confirmRollback: historic version expired', () => {
  it('should fail before any write when the rollback target expired between preview and confirm', async () => {
    const remoteFileStore = makeRemoteFileStore({
      listVersions: vi.fn().mockResolvedValue([{ versionId: APPLY_CONFIG_VERSION_ID, lastModified: new Date() }]),
    });
    const deploymentConfigRestorer = makeDeploymentConfigRestorer();
    const service = makeService({ remoteFileStore, deploymentConfigRestorer });

    await expect(collectRollbackChunks(service.confirmRollback(APPLY_RUN_ID))).rejects.toBeInstanceOf(
      RollbackVersionMissingError,
    );

    expect(deploymentConfigRestorer.restoreRawConfig).not.toHaveBeenCalled();

    // The lock must have been released too — a subsequent preview() succeeds.
    const result = await drainToCompletion(service.preview());
    expect(result).toBeDefined();
  });
});

describe('PulumiService.confirmRollback: compensating semantics when the plan fails after the restore', () => {
  it('should record a durable orphaned-rollback marker and throw PulumiRollbackPlanFailedError', async () => {
    const workspace = makeWorkspace(async () => {
      throw new Error('engine provisioning failed');
    });
    const store = makeFullyConfiguredStore();
    // Coupled pair (see makeConfigStores' doc comment) — the restore must
    // succeed and be reflected in listVersions' head so previewCore's own
    // staleness re-check passes and this test actually reaches
    // stack.preview() (where the injected failure lives), rather than
    // failing earlier for an unrelated, fixture-induced reason.
    const { remoteFileStore, deploymentConfigRestorer } = makeConfigStores();
    const service = makeService({ workspace, store, remoteFileStore, deploymentConfigRestorer });

    const err = await collectRollbackChunks(service.confirmRollback(APPLY_RUN_ID)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PulumiRollbackPlanFailedError);
    expect((err as PulumiRollbackPlanFailedError).applyRunId).toBe(APPLY_RUN_ID);
    expect((err as PulumiRollbackPlanFailedError).restoredVersionId).toBe(RESTORED_CONFIG_VERSION_ID);
    expect((err as PulumiRollbackPlanFailedError).cause).toBeInstanceOf(PulumiPreviewError);

    const orphan = store.getOrphanedRollback();
    expect(orphan).toBeDefined();
    expect(orphan?.applyRunId).toBe(APPLY_RUN_ID);
    expect(orphan?.restoredVersionId).toBe(RESTORED_CONFIG_VERSION_ID);
    expect(orphan?.failureMessage).toContain('engine provisioning failed');

    // The restore write itself DID happen — this is what makes the failure
    // an orphan rather than a clean pre-write rejection.
    expect(deploymentConfigRestorer.restoreRawConfig).toHaveBeenCalledWith(HISTORIC_RAW_CONFIG);

    // The lock must still have been released despite the failure — proven by
    // a follow-up preview() reaching stack.preview() at all (and failing for
    // the SAME rigged-workspace reason) rather than being refused with the
    // "rollback() is already running" busy error a leaked lock would produce.
    await expect(drainToCompletion(service.preview())).rejects.toBeInstanceOf(PulumiPreviewError);
  });

  it('should log an error with the failure message (not a raw error object) when the follow-up plan fails after the restore', async () => {
    const workspace = makeWorkspace(async () => {
      throw new Error('engine provisioning failed');
    });
    const store = makeFullyConfiguredStore();
    const { remoteFileStore, deploymentConfigRestorer } = makeConfigStores();
    const service = makeService({ workspace, store, remoteFileStore, deploymentConfigRestorer });

    await collectRollbackChunks(service.confirmRollback(APPLY_RUN_ID)).catch((e: unknown) => e);

    expect(loggerMock.error).toHaveBeenCalledWith(
      'PulumiService.confirmRollback: rollback plan failed after the configuration was restored',
      expect.objectContaining({
        applyRunId: APPLY_RUN_ID,
        restoredVersionId: RESTORED_CONFIG_VERSION_ID,
        error: expect.stringContaining('engine provisioning failed'),
      }),
    );
  });
});
