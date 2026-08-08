/**
 * Unit tests for `PulumiService.destroy`
 * — the token-gated infrastructure destruction operation, a self-contained
 * method that owns its whole gate (mirrors `apply`'s own "no controller
 * yet, so the method owns its whole gate" ruling).
 *
 * Covers the confirmation
 * gate (missing/wrong/expired/already-consumed token; spawning; streaming;
 * run persistence; abort/force-close handling; concurrency guard) PLUS this
 * dispatch's own additions: target binding (the new "bound to a different
 * stack/workspace" rejection), the token-first gate ordering that makes the
 * `orchestrator-integration-coverage` spec's "concurrent submissions sharing
 * one token" scenario decidable without ever touching `RunLockService`,
 * backend-lock recovery (reclaim-and-retry vs unrecognized, ported from
 * `apply`'s mechanism), and the leaked-promise `recoverResult`.
 *
 * `node:fs` is fully mocked (mirrors `PulumiService.apply.test.ts`) so no
 * test touches the real filesystem. `node:os`'s `userInfo`/`hostname` are
 * mocked to fixed values so `PulumiService.resolveInitiator()` and
 * `PulumiLockRecovery.classifyStackLockConflict`'s default identity are
 * deterministic and mutually consistent. `PulumiWorkspaceService.getOrCreateStack`
 * is stubbed to return a fake `Stack` whose `destroy`/`cancel`/`info` methods
 * each test controls directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModuleRef } from '@nestjs/core';
import type { DestroyOptions, DestroyResult, EngineEvent, Stack, UpdateSummary } from '@pulumi/pulumi/automation/index.js';
import type { RemoteFileStore, RunLock } from '@hyveon/shared';
import { RunLockHeldError } from '@hyveon/shared';

const { mkdirSyncMock, existsSyncMock, writeFileSyncMock, readFileSyncMock, loggerMock } = vi.hoisted(() => ({
  mkdirSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('node:fs', () => ({
  mkdirSync: mkdirSyncMock,
  existsSync: existsSyncMock,
  writeFileSync: writeFileSyncMock,
  readFileSync: readFileSyncMock,
}));

// `userInfo`/`hostname` are fixed so `PulumiService.resolveInitiator()`
// (`os.userInfo().username`) and `PulumiLockRecovery.classifyStackLockConflict`'s
// default identity (`{ userInfo().username, hostname() }`, since `destroy()`
// never overrides it) always agree — required for the lock-recovery tests'
// fabricated conflict messages to match. `tmpdir` is delegated to the real
// implementation since `getRunsDir()`'s fallback path calls it.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ username: TEST_USERNAME }), hostname: () => TEST_HOSTNAME };
});

vi.mock('../logger.js', () => ({ logger: loggerMock }));

import {
  PulumiService,
  PulumiDestroyError,
  DestroyNotConfirmedError,
  PulumiRunPersistError,
  RUN_RECORD_PERSISTER,
  RUN_LOCK_SERVICE,
  CONFIG_CACHE_INVALIDATOR,
  type RunRecordPersister,
  type RunLockService,
  type ConfigCacheInvalidator,
} from './PulumiService.js';
import { PulumiUnrecognizedLockError } from './PulumiLockRecovery.js';
import { REMOTE_FILE_STORE } from '../modules/cloud-provider.tokens.js';
import type { PulumiWorkspaceService } from './PulumiWorkspaceService.js';
import type { PulumiEngineService } from './PulumiEngineService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';

/** Fixed OS identity — see the `node:os` mock above for why this must be a fixed, known value. */
const TEST_USERNAME = 'test-initiator';
const TEST_HOSTNAME = 'test-host';

/** `bootstrap`/`aws`/`pulumi` fields `destroy()` reads off the store before ever calling Pulumi. */
const FULLY_CONFIGURED = { stateBucket: 'my-state-bucket', passphrase: 'enc-secret', awsRegion: 'us-east-1' };

/** Builds a real `ElectronStoreService` (in-memory Map outside Electron) with the given fields pre-seeded — mirrors `PulumiService.apply.test.ts`'s identical helper. */
function makeStore(opts: { stateBucket?: string; passphrase?: string; awsRegion?: string } = {}): ElectronStoreService {
  const store = new ElectronStoreService(new SafeStorageService());
  if (opts.stateBucket !== undefined) {
    store.set('bootstrap', { stateBucket: opts.stateBucket, configurationBucket: '' });
  }
  if (opts.passphrase !== undefined) {
    store.set('pulumi', { passphrase: opts.passphrase });
  }
  if (opts.awsRegion !== undefined) {
    store.set('aws', { region: opts.awsRegion });
  }
  return store;
}

/** A fully-configured store (state bucket, passphrase, AWS region). */
function makeFullyConfiguredStore(): ElectronStoreService {
  return makeStore(FULLY_CONFIGURED);
}

/** `RunRecordPersister` stub — `persist` is a directly-inspectable mock; `getByRunId`/`writePreflightMarker` are unused by `destroy()` but stubbed for interface completeness. */
function makeRunRecordPersister(): RunRecordPersister & {
  persist: ReturnType<typeof vi.fn>;
  getByRunId: ReturnType<typeof vi.fn>;
  writePreflightMarker: ReturnType<typeof vi.fn>;
} {
  return {
    getByRunId: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn().mockResolvedValue(undefined),
    writePreflightMarker: vi.fn().mockResolvedValue(undefined),
  };
}

/** `RunLockService` stub — `createRun` resolves a fresh `RunLock` by default. */
function makeRunLockService(): RunLockService & { createRun: ReturnType<typeof vi.fn>; releaseRun: ReturnType<typeof vi.fn> } {
  const lock: RunLock = {
    runId: 'destroy-run-1',
    kind: 'destroy',
    initiator: TEST_USERNAME,
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return { createRun: vi.fn().mockResolvedValue(lock), releaseRun: vi.fn().mockResolvedValue(undefined) };
}

/** `ConfigCacheInvalidator` stub. */
function makeConfigCacheInvalidator(): ConfigCacheInvalidator & { invalidateCache: ReturnType<typeof vi.fn> } {
  return { invalidateCache: vi.fn(() => {}) };
}

/** Stub `PulumiEngineService` — an ordinary constructor dependency `destroy()` never reads, but the constructor still requires one. */
function makeEngine(): PulumiEngineService {
  return {
    resolve: vi.fn().mockResolvedValue({}),
    getResolvedVersion: vi.fn().mockReturnValue('3.255.0'),
  } as unknown as PulumiEngineService;
}

/**
 * Stub `ModuleRef` routing `.get(token, { strict: false })` to the three
 * lazily-resolved dependencies `destroy()` uses. Unlike `apply()`,
 * `destroy()` never resolves `REMOTE_FILE_STORE` (it never reads the
 * deployment configuration object — see the source's "No-op inline program"
 * doc section) — omitted here so an accidental call to
 * `getRemoteFileStore()` fails loudly instead of silently succeeding.
 */
function makeModuleRef(deps: {
  runRecordPersister: RunRecordPersister;
  runLockService: RunLockService;
  configCacheInvalidator: ConfigCacheInvalidator;
}): ModuleRef {
  const get = vi.fn((token: unknown) => {
    if (token === RUN_RECORD_PERSISTER) return deps.runRecordPersister;
    if (token === RUN_LOCK_SERVICE) return deps.runLockService;
    if (token === CONFIG_CACHE_INVALIDATOR) return deps.configCacheInvalidator;
    throw new Error(`ModuleRef.get() called with an unexpected token: ${String(token)}`);
  });
  return { get } as unknown as ModuleRef;
}

/** Shape `destroy()`'s `stack.destroy` mock is driven with. */
type FakeStackDestroy = (opts: DestroyOptions) => Promise<DestroyResult>;

/** A well-formed `UpdateSummary` for `stack.info()`'s default resolution. */
function makeUpdateSummary(overrides: Partial<UpdateSummary> = {}): UpdateSummary {
  return {
    kind: 'destroy',
    startTime: new Date(),
    endTime: new Date(),
    message: '',
    environment: {},
    config: {},
    result: 'succeeded',
    version: 1,
    ...overrides,
  };
}

/** Builds a `PulumiWorkspaceService` stub whose `getOrCreateStack` resolves to a stack stub wrapping the given `destroy` implementation plus `cancel`/`info`. */
function makeWorkspace(
  destroyImpl: FakeStackDestroy,
  extra: { cancel?: ReturnType<typeof vi.fn>; info?: ReturnType<typeof vi.fn> } = {},
): PulumiWorkspaceService & { getOrCreateStack: ReturnType<typeof vi.fn> } {
  const destroyMock = vi.fn().mockImplementation(destroyImpl);
  const cancelMock = extra.cancel ?? vi.fn().mockResolvedValue(undefined);
  const infoMock = extra.info ?? vi.fn().mockResolvedValue(makeUpdateSummary());
  const getOrCreateStack = vi
    .fn()
    .mockResolvedValue({ destroy: destroyMock, cancel: cancelMock, info: infoMock } as Partial<Stack> as Stack);
  return { getOrCreateStack } as unknown as PulumiWorkspaceService & { getOrCreateStack: ReturnType<typeof vi.fn> };
}

/** A `stack.destroy` implementation that streams one stdout line, reports a summary, and resolves cleanly. */
function makeHappyPathDestroy(changeSummary: Record<string, number> = { delete: 3 }): FakeStackDestroy {
  return async (opts) => {
    opts.onOutput?.('Destroying...\n');
    const event: EngineEvent = {
      sequence: 1,
      timestamp: Math.floor(Date.now() / 1000),
      summaryEvent: { maybeCorrupt: false, durationSeconds: 1, resourceChanges: changeSummary, policyPacks: {} },
    };
    opts.onEvent?.(event);
    return { stdout: 'Destroying...\n', stderr: '', summary: makeUpdateSummary({ resourceChanges: changeSummary }) };
  };
}

/** Constructs `PulumiService` with every dependency stubbed. */
function makeService(opts: {
  workspace: PulumiWorkspaceService;
  store?: ElectronStoreService;
  runRecordPersister?: ReturnType<typeof makeRunRecordPersister>;
  runLockService?: ReturnType<typeof makeRunLockService>;
  configCacheInvalidator?: ReturnType<typeof makeConfigCacheInvalidator>;
}): PulumiService {
  const runRecordPersister = opts.runRecordPersister ?? makeRunRecordPersister();
  const runLockService = opts.runLockService ?? makeRunLockService();
  const configCacheInvalidator = opts.configCacheInvalidator ?? makeConfigCacheInvalidator();
  return new PulumiService(
    opts.workspace,
    opts.store ?? makeFullyConfiguredStore(),
    makeModuleRef({ runRecordPersister, runLockService, configCacheInvalidator }),
    makeEngine(),
  );
}

/** Drains a `destroy()` async generator to completion, collecting every yielded chunk plus the final return value. */
async function collectDestroyChunks(gen: ReturnType<PulumiService['destroy']>) {
  const chunks: { stream: 'stdout' | 'stderr'; line: string }[] = [];
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await gen.next();
  }
  return { chunks, result: next.value };
}

beforeEach(() => {
  mkdirSyncMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
  writeFileSyncMock.mockReset();
  readFileSyncMock.mockReset();
  loggerMock.warn.mockReset();
  vi.restoreAllMocks();
});

describe('PulumiService.destroy concurrency guard', () => {
  it('should throw synchronously when destroy() is called while initializeStack() is already in flight', async () => {
    // Regression test for a code-reviewer-traced race: initializeStack()
    // does not set `operationInFlight` (see PulumiService.ts's own
    // `stackInitInFlight` doc comment for why it's a separate flag), so
    // destroy() must check `stackInitInFlight` itself or it would sail
    // straight through its own top-of-function check while
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

    // No token was even minted — this proves the stackInitInFlight check
    // fires before the (later) token-confirmation gate, not just before
    // some other unrelated failure.
    await expect(collectDestroyChunks(service.destroy('guessed-token'))).rejects.toThrow(
      /initializeStack.*already running/i,
    );

    void initPromise.catch(() => {}); // Left permanently in flight — never awaited to settle, by design.
  });

  /**
   * Regression test for Finding 2 (final whole-branch review) — mirrors
   * `PulumiService.apply.test.ts`'s identical test and reasoning: the
   * post-`createRun` re-check only looked at `operationInFlight`, never
   * `stackInitInFlight`, leaving a TOCTOU gap between `destroy()`'s entry
   * check (both flags clear) and its post-`createRun` recheck, during which
   * `initializeStack()` could start and set `stackInitInFlight` invisibly.
   * Simulated by starting `initializeStack()` from inside the `createRun`
   * mock — the exact async gap Finding 2 closes.
   */
  it('should refuse at the post-createRun recheck when initializeStack() starts concurrently during the gate', async () => {
    const hangingWorkspace = {
      getOrCreateStack: vi.fn(() => new Promise(() => {
        // Never resolves — keeps initializeStack() "in flight" for this test.
      })),
    } as unknown as PulumiWorkspaceService;
    const runLockService = makeRunLockService();
    const service = makeService({ workspace: hangingWorkspace, runLockService });
    const token = service.mintDestroyConfirmationToken();
    let initPromise: Promise<void> | undefined;
    const grantedLock: RunLock = {
      runId: 'destroy-run-1',
      kind: 'destroy',
      initiator: TEST_USERNAME,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    runLockService.createRun.mockImplementationOnce(async () => {
      // `destroy()`'s ENTRY check has already passed by the time
      // `createRun` is called — `initializeStack()`'s own entry checks
      // still see both flags clear here, so it proceeds and sets
      // `stackInitInFlight = true` synchronously before suspending on its
      // own (hanging) `getOrCreateStack` call.
      initPromise = service.initializeStack();
      return grantedLock;
    });

    await expect(collectDestroyChunks(service.destroy(token))).rejects.toThrow(/initializeStack\(\).*already in flight/i);

    // The durable lock this call won moments before the refusal must have
    // been released, not leaked — `destroy()` reserves its own random runId
    // (no `preMintedRunId` supplied here), so only the call COUNT is
    // asserted, not the specific id.
    expect(runLockService.releaseRun).toHaveBeenCalledTimes(1);

    void initPromise?.catch(() => {}); // Left permanently in flight — never awaited to settle, by design.
  });
});

describe('PulumiService.destroy confirmation gate', () => {
  it('should reject with DestroyNotConfirmedError and never call getOrCreateStack or createRun when no token has ever been minted', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const runLockService = makeRunLockService();
    const service = makeService({ workspace, runLockService });

    await expect(collectDestroyChunks(service.destroy('guessed-token'))).rejects.toBeInstanceOf(DestroyNotConfirmedError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
    expect(runLockService.createRun).not.toHaveBeenCalled();
  });

  it('should reject with DestroyNotConfirmedError when the supplied token does not match the most recently minted one', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const service = makeService({ workspace });
    service.mintDestroyConfirmationToken();

    await expect(collectDestroyChunks(service.destroy('some-other-token'))).rejects.toBeInstanceOf(DestroyNotConfirmedError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should reject with DestroyNotConfirmedError when the most recently minted token has expired', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const service = makeService({ workspace });

    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockReturnValueOnce(1_000_000);
    const token = service.mintDestroyConfirmationToken();

    dateNowSpy.mockReturnValueOnce(1_000_000 + 5 * 60 * 1000 + 1);
    await expect(collectDestroyChunks(service.destroy(token))).rejects.toBeInstanceOf(DestroyNotConfirmedError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();

    dateNowSpy.mockRestore();
  });

  it('should reject with DestroyNotConfirmedError on a second destroy() call reusing an already-consumed token', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();

    const { result } = await collectDestroyChunks(service.destroy(token));
    expect(result).toBeDefined();

    await expect(collectDestroyChunks(service.destroy(token))).rejects.toBeInstanceOf(DestroyNotConfirmedError);
  });

  it('should reject with DestroyNotConfirmedError when the token was minted for a different state bucket (target binding)', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const store = makeFullyConfiguredStore();
    const service = makeService({ workspace, store });
    const token = service.mintDestroyConfirmationToken();

    // Simulate a Reconfigure completing between mint and confirm — the
    // operator now points the app at a DIFFERENT S3 state bucket.
    store.set('bootstrap', { stateBucket: 'a-different-bucket', configurationBucket: '' });

    await expect(collectDestroyChunks(service.destroy(token))).rejects.toBeInstanceOf(DestroyNotConfirmedError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should reject with DestroyNotConfirmedError when the token was minted for a different AWS region (target binding)', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const store = makeFullyConfiguredStore();
    const service = makeService({ workspace, store });
    const token = service.mintDestroyConfirmationToken();

    store.set('aws', { region: 'eu-west-1' });

    await expect(collectDestroyChunks(service.destroy(token))).rejects.toBeInstanceOf(DestroyNotConfirmedError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should accept a fresh token whose target still matches the current state bucket/region', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const store = makeFullyConfiguredStore();
    const service = makeService({ workspace, store });
    const token = service.mintDestroyConfirmationToken();

    const { result } = await collectDestroyChunks(service.destroy(token));

    expect(result).toBeDefined();
    expect(workspace.getOrCreateStack).toHaveBeenCalledTimes(1);
  });

  it('should reject with DestroyNotConfirmedError when a superseded (previously minted, never consumed) token is retried after a fresh one was minted', async () => {
    // "Each attempt needs its own token" scenario, `iac-destroy-flow` spec:
    // minting a new token immediately supersedes the prior one, even if the
    // prior one was never itself consumed by a destroy() call.
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const service = makeService({ workspace });

    const tokenA = service.mintDestroyConfirmationToken();
    const tokenB = service.mintDestroyConfirmationToken();
    expect(tokenB).not.toBe(tokenA);

    await expect(collectDestroyChunks(service.destroy(tokenA))).rejects.toBeInstanceOf(DestroyNotConfirmedError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();

    // tokenB is still the live one.
    await expect(collectDestroyChunks(service.destroy(tokenB))).resolves.toBeDefined();
  });

  it('should let two concurrent destroy() calls sharing the SAME token resolve the race via the token itself: the loser gets DestroyNotConfirmedError, not RunLockHeldError', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const runLockService = makeRunLockService();
    const service = makeService({ workspace, runLockService });
    const token = service.mintDestroyConfirmationToken();

    const [firstSettled, secondSettled] = await Promise.allSettled([
      collectDestroyChunks(service.destroy(token)),
      collectDestroyChunks(service.destroy(token)),
    ]);

    const settlements = [firstSettled, secondSettled];
    const fulfilled = settlements.filter((r) => r.status === 'fulfilled');
    const rejected = settlements.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DestroyNotConfirmedError);
    // The loser never even reached the durable-lock reservation — the token
    // gate alone decided the race.
    expect(runLockService.createRun).toHaveBeenCalledTimes(1);
  });

  it('should never call RunLockService.createRun before the token is consumed (token-first gate ordering)', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const runLockService = makeRunLockService();
    const service = makeService({ workspace, runLockService });

    await expect(collectDestroyChunks(service.destroy('guessed-token'))).rejects.toBeInstanceOf(DestroyNotConfirmedError);

    expect(runLockService.createRun).not.toHaveBeenCalled();
  });

  it('should NOT consume the token when the config-presence checks fail — those checks run before the token gate, not after', async () => {
    // Corrected ordering (per review): the config-existence checks are pure,
    // synchronous, idempotent reads with no ordering constraint relative to
    // the token gate (only createRun() must follow the token — see the
    // source's "Gate structure" doc section for the forced-vs-chosen
    // breakdown) — placed BEFORE the token so a call that was always going
    // to fail an ordinary "is anything deployed yet" check doesn't also
    // burn the operator's single-use confirmation.
    //
    // Uses the "stack never created" (missing passphrase) check rather than
    // the state-bucket check specifically because `passphrase` is NOT part
    // of target binding — minting with the bucket/region already configured
    // (so the token's recorded target matches on retry) but the passphrase
    // still unset isolates "was the token consumed" from "does the target
    // still match", which changing the bucket between mint and retry would
    // conflate.
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const store = makeStore({ stateBucket: 'my-state-bucket', awsRegion: 'us-east-1' });
    const service = makeService({ workspace, store });
    const token = service.mintDestroyConfirmationToken();

    await expect(collectDestroyChunks(service.destroy(token))).rejects.toThrow(/no Pulumi stack has ever been created/i);

    // The token was NOT consumed by the first (no-stack-yet) attempt —
    // record a passphrase on the SAME store in place and retry with the
    // SAME token on the SAME service instance: it must succeed, proving the
    // token is still valid rather than having been silently spent on the
    // earlier refusal.
    store.set('pulumi', { passphrase: 'enc-secret' });

    await expect(collectDestroyChunks(service.destroy(token))).resolves.toBeDefined();
  });
});

describe('PulumiService.destroy gate ordering and reservations', () => {
  it('should refuse immediately (never touching the token) when preview()/apply()/an already-running destroy() is using the shared workspace', async () => {
    let resolveDestroy!: () => void;
    let destroyCallCount = 0;
    const workspace = makeWorkspace((_opts) => {
      destroyCallCount += 1;
      if (destroyCallCount === 1) {
        return new Promise((resolve) => {
          resolveDestroy = () => resolve({ stdout: '', stderr: '', summary: makeUpdateSummary() });
        });
      }
      return Promise.resolve({ stdout: '', stderr: '', summary: makeUpdateSummary() });
    });
    const service = makeService({ workspace });
    const firstToken = service.mintDestroyConfirmationToken();
    const firstGen = service.destroy(firstToken);
    const firstNext = firstGen.next();
    // Let the first call reach and win the durable lock, committing operationInFlight.
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const secondToken = service.mintDestroyConfirmationToken();
    const secondGen = service.destroy(secondToken);
    await expect(secondGen.next()).rejects.toThrow(/already running/i);

    // The second token was never touched by the busy refusal — it's still
    // usable once the first call finishes.
    resolveDestroy();
    await firstNext;
    await firstGen.next();
    await expect(collectDestroyChunks(service.destroy(secondToken))).resolves.toBeDefined();
  });

  it('should acquire the durable lock only AFTER the token and config-existence checks pass', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const runLockService = makeRunLockService();
    const service = makeService({ workspace, runLockService });
    const token = service.mintDestroyConfirmationToken();

    await collectDestroyChunks(service.destroy(token));

    expect(runLockService.createRun).toHaveBeenCalledWith('destroy', TEST_USERNAME, expect.any(String));
    const createRunOrder = runLockService.createRun.mock.invocationCallOrder[0]!;
    expect(workspace.getOrCreateStack.mock.invocationCallOrder[0]!).toBeGreaterThan(createRunOrder);
  });

  it('should propagate RunLockHeldError unwrapped, and never call getOrCreateStack, when the durable lock acquisition loses the race', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const runLockService = makeRunLockService();
    const heldLock: RunLock = {
      runId: 'other-run',
      kind: 'destroy',
      initiator: 'someone-else',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    runLockService.createRun.mockRejectedValue(new RunLockHeldError(heldLock));
    const runRecordPersister = makeRunRecordPersister();
    const service = makeService({ workspace, runLockService, runRecordPersister });
    const token = service.mintDestroyConfirmationToken();

    await expect(collectDestroyChunks(service.destroy(token))).rejects.toBeInstanceOf(RunLockHeldError);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
    expect(runRecordPersister.persist).not.toHaveBeenCalled();
  });

  it('should release the just-won durable lock and refuse when a concurrent preview() starts running against the shared workspace DURING the destroy gate phase', async () => {
    // Exercising a genuinely concurrent preview() (rather than faking
    // operationInFlight directly — a private field, deliberately not
    // test-visible) requires preview()'s own dependencies to actually work:
    // a configured configuration bucket and a working REMOTE_FILE_STORE —
    // neither of which destroy() itself needs (see makeModuleRef's doc
    // comment), so this one test wires them in locally rather than via the
    // shared makeService/makeModuleRef helpers.
    let resolveCreateRun!: (lock: RunLock) => void;
    const runLockService = makeRunLockService();
    runLockService.createRun.mockImplementation(
      () =>
        new Promise<RunLock>((resolve) => {
          resolveCreateRun = resolve;
        }),
    );

    let resolvePreview!: () => void;
    const previewMock = vi.fn().mockImplementation(
      (opts: { onOutput?: (out: string) => void }) =>
        new Promise((resolve) => {
          opts.onOutput?.('Previewing...\n');
          resolvePreview = () => resolve({ stdout: '', stderr: '', changeSummary: {} });
        }),
    );
    const destroyMock = vi.fn();
    const getOrCreateStack = vi
      .fn()
      .mockResolvedValue({ preview: previewMock, destroy: destroyMock, cancel: vi.fn(), info: vi.fn() } as Partial<Stack> as Stack);
    const workspace = { getOrCreateStack } as unknown as PulumiWorkspaceService;

    const store = new ElectronStoreService(new SafeStorageService());
    store.set('bootstrap', { stateBucket: 'my-state-bucket', configurationBucket: 'hyveon-config' });
    store.set('pulumi', { passphrase: 'enc-secret' });
    store.set('aws', { region: 'us-east-1' });

    // preview()'s post-settlement plan-hash step reads the saved plan
    // artifact back off disk — this test drives preview() all the way to
    // completion at the very end (`resolvePreview()` below), so
    // readFileSyncMock needs a valid artifact to hash, unlike every other
    // test in this file (which never exercises preview()'s own internals).
    readFileSyncMock.mockReturnValue(Buffer.from(JSON.stringify({ manifest: { version: 'v3.255.0' } })));

    const remoteFileStore = {
      get: vi.fn().mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ hostedZoneName: 'example.com', gameServers: {} })), etag: 'etag-1' }),
      put: vi.fn(),
      listVersions: vi.fn().mockResolvedValue([{ versionId: 'cfg-v1', lastModified: new Date() }]),
      getVersion: vi.fn(),
    } as unknown as RemoteFileStore;
    const runRecordPersister = makeRunRecordPersister();
    const configCacheInvalidator = makeConfigCacheInvalidator();
    const moduleRef = {
      get: vi.fn((token: unknown) => {
        if (token === RUN_RECORD_PERSISTER) return runRecordPersister;
        if (token === RUN_LOCK_SERVICE) return runLockService;
        if (token === CONFIG_CACHE_INVALIDATOR) return configCacheInvalidator;
        if (token === REMOTE_FILE_STORE) return remoteFileStore;
        throw new Error(`unexpected token ${String(token)}`);
      }),
    } as unknown as ModuleRef;
    const service = new PulumiService(workspace, store, moduleRef, makeEngine());
    const token = service.mintDestroyConfirmationToken();

    const destroyChunksPromise = collectDestroyChunks(service.destroy(token, undefined, 'destroy-run'));
    // Let destroy()'s synchronous gate (token + config checks) run and
    // suspend on the controlled createRun promise.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const previewGen = service.preview();
    const previewFirst = await previewGen.next();
    expect(previewFirst.done).toBe(false);

    resolveCreateRun({
      runId: 'destroy-run',
      kind: 'destroy',
      initiator: TEST_USERNAME,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(destroyChunksPromise).rejects.toThrow(/preview.*already in flight/i);
    expect(runLockService.releaseRun).toHaveBeenCalledWith('destroy-run');
    expect(destroyMock).not.toHaveBeenCalled();

    resolvePreview();
    await previewGen.next();
  });

  it('should reject synchronously with a descriptive Error and never call getOrCreateStack when preMintedRunId is malformed', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();

    const gen = service.destroy(token, undefined, '../escape');

    await expect(gen.next()).rejects.toThrow(/not a valid run id/i);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should use a caller-supplied preMintedRunId instead of minting a fresh one', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const runLockService = makeRunLockService();
    const service = makeService({ workspace, runLockService });
    const token = service.mintDestroyConfirmationToken();

    const { result } = await collectDestroyChunks(service.destroy(token, undefined, 'pre-minted-destroy-id'));

    expect(runLockService.createRun).toHaveBeenCalledWith('destroy', TEST_USERNAME, 'pre-minted-destroy-id');
    expect(result).toMatchObject({ runId: 'pre-minted-destroy-id' });
  });
});

describe('PulumiService.destroy spawning', () => {
  it('should construct the stack via getOrCreateStack with a no-op program, then call stack.destroy with no plan option', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();

    await collectDestroyChunks(service.destroy(token));

    expect(workspace.getOrCreateStack).toHaveBeenCalledTimes(1);
    const input = workspace.getOrCreateStack.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({ stateBucket: 'my-state-bucket', stateBucketRegion: 'us-east-1', backendReady: true });
    expect(typeof input['program']).toBe('function');

    const stack = await workspace.getOrCreateStack.mock.results[0]!.value;
    expect(stack.destroy).toHaveBeenCalledTimes(1);
    const destroyOpts = (stack.destroy as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(destroyOpts['plan']).toBeUndefined();
  });
});

describe('PulumiService.destroy streaming and structured changeSummary', () => {
  it('should yield stdout chunks and return the changeSummary captured from onEvent', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy({ delete: 4 }));
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();

    const { chunks, result } = await collectDestroyChunks(service.destroy(token));

    expect(chunks).toEqual([{ stream: 'stdout', line: 'Destroying...' }]);
    expect(result).toMatchObject({ changeSummary: { delete: 4 } });
    expect(typeof (result as { runId: string }).runId).toBe('string');
  });
});

describe('PulumiService.destroy run persistence', () => {
  it('should persist a run.json with kind "destroy", exitCode 0, and the captured changeSummary — no configVersionId/planHash/engineVersion', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy({ delete: 2 }));
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();

    await collectDestroyChunks(service.destroy(token));

    const call = writeFileSyncMock.mock.calls.find((c) => String(c[0]).endsWith('run.json'));
    expect(call).toBeDefined();
    const record = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ kind: 'destroy', exitCode: 0, changeSummary: { delete: 2 } });
    expect(record['configVersionId']).toBeUndefined();
    expect(record['planHash']).toBeUndefined();
    expect(record['engineVersion']).toBeUndefined();
  });

  it('should persist the run to RunRecordService via RunRecordPersister with a matching log path', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const runRecordPersister = makeRunRecordPersister();
    const service = makeService({ workspace, runRecordPersister });
    const token = service.mintDestroyConfirmationToken();

    await collectDestroyChunks(service.destroy(token));

    expect(runRecordPersister.persist).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'destroy', exitCode: 0 }),
      expect.stringContaining('pulumi.log'),
    );
  });

  it('should wrap a local run.json write failure in PulumiRunPersistError without discarding the real outcome', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();
    writeFileSyncMock.mockImplementation((path: string) => {
      if (String(path).endsWith('run.json')) throw new Error('disk full');
    });

    await expect(collectDestroyChunks(service.destroy(token))).rejects.toBeInstanceOf(PulumiRunPersistError);
  });
});

describe('PulumiService.destroy cache invalidation', () => {
  it('should invalidate the stack-outputs cache on a successful destroy', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const configCacheInvalidator = makeConfigCacheInvalidator();
    const service = makeService({ workspace, configCacheInvalidator });
    const token = service.mintDestroyConfirmationToken();

    await collectDestroyChunks(service.destroy(token));

    expect(configCacheInvalidator.invalidateCache).toHaveBeenCalledTimes(1);
  });

  /**
   * Regression test for Finding 5 (final whole-branch review) — mirrors
   * `PulumiService.apply.test.ts`'s identical test and reasoning:
   * `invalidateCache()` must run BEFORE `persistRunRecord`/`RunRecordPersister.persist`,
   * not after, since that call reads `runsTableName` off a cache only
   * `invalidateCache()` clears.
   */
  it('should invalidate the stack-outputs cache BEFORE persisting the run record, not after', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const configCacheInvalidator = makeConfigCacheInvalidator();
    const runRecordPersister = makeRunRecordPersister();
    const service = makeService({ workspace, configCacheInvalidator, runRecordPersister });
    const token = service.mintDestroyConfirmationToken();

    await collectDestroyChunks(service.destroy(token));

    expect(configCacheInvalidator.invalidateCache).toHaveBeenCalledTimes(1);
    expect(runRecordPersister.persist).toHaveBeenCalledTimes(1);
    const invalidateOrder = vi.mocked(configCacheInvalidator.invalidateCache).mock.invocationCallOrder[0]!;
    const persistOrder = vi.mocked(runRecordPersister.persist).mock.invocationCallOrder[0]!;
    expect(invalidateOrder).toBeLessThan(persistOrder);
  });

  it('should NOT invalidate the stack-outputs cache when the destroy fails', async () => {
    const workspace = makeWorkspace(async () => {
      throw new Error('boom');
    });
    const configCacheInvalidator = makeConfigCacheInvalidator();
    const service = makeService({ workspace, configCacheInvalidator });
    const token = service.mintDestroyConfirmationToken();

    await expect(collectDestroyChunks(service.destroy(token))).rejects.toThrow();

    expect(configCacheInvalidator.invalidateCache).not.toHaveBeenCalled();
  });
});

describe('PulumiService.destroy lock-recovery', () => {
  /** Builds the DIY-backend lock-conflict message text, in the shape `pkg/backend/diy/lock.go` produces — mirrors `PulumiService.apply.test.ts`'s identical helper. */
  function diyLockMessage(entries: { pid: number; username: string; hostname: string; lockedAt: string }[]): string {
    const header = `the stack is currently locked by ${entries.length} lock(s). Either wait for the other process(es) to end or delete the lock file with \`pulumi cancel\`.`;
    const lines = entries.map(
      (e, i) => `\n  s3://my-bucket/.pulumi/locks/production/lock-${i}.json: created by ${e.username}@${e.hostname} (pid ${e.pid}) at ${e.lockedAt}`,
    );
    return header + lines.join('');
  }

  it('should clear a provably-own-orphan lock via stack.cancel() and retry stack.destroy() once, succeeding on the retry', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    const store = makeFullyConfiguredStore();
    store.recordPulumiLockAttempt('production');
    const lockedAt = new Date().toISOString();
    const conflictMessage = diyLockMessage([{ pid: 4242, username: TEST_USERNAME, hostname: TEST_HOSTNAME, lockedAt }]);

    let destroyCallCount = 0;
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const workspace = makeWorkspace(
      async () => {
        destroyCallCount += 1;
        if (destroyCallCount === 1) {
          throw new Error(conflictMessage);
        }
        return { stdout: '', stderr: '', summary: makeUpdateSummary({ resourceChanges: { delete: 1 } }) };
      },
      { cancel: cancelMock },
    );
    const service = makeService({ workspace, store });
    const token = service.mintDestroyConfirmationToken();

    const { result } = await collectDestroyChunks(service.destroy(token));

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(destroyCallCount).toBe(2);
    expect(result).toMatchObject({ changeSummary: {} });
  });

  it('should reject with PulumiUnrecognizedLockError, and never call stack.cancel(), when the lock cannot be proven this installation\'s own orphan', async () => {
    const lockedAt = new Date().toISOString();
    const conflictMessage = diyLockMessage([{ pid: 4242, username: 'someone-else', hostname: 'someone-elses-machine', lockedAt }]);

    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const workspace = makeWorkspace(
      async () => {
        throw new Error(conflictMessage);
      },
      { cancel: cancelMock },
    );
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();

    let caught: unknown;
    try {
      await collectDestroyChunks(service.destroy(token));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PulumiUnrecognizedLockError);
    expect(cancelMock).not.toHaveBeenCalled();
  });
});

describe('PulumiService.destroy leaked-promise recovery', () => {
  it('should recover a leaked-promise rejection as a success, using the changeSummary already captured via onEvent', async () => {
    const infoMock = vi.fn().mockResolvedValue(makeUpdateSummary({ result: 'succeeded' }));
    const workspace = makeWorkspace(
      async (opts) => {
        opts.onOutput?.('Destroying...\n');
        opts.onEvent?.({
          sequence: 1,
          timestamp: Math.floor(Date.now() / 1000),
          summaryEvent: { maybeCorrupt: false, durationSeconds: 1, resourceChanges: { delete: 1 }, policyPacks: {} },
        });
        throw new Error('The Pulumi runtime detected that 1 promises were still active when the process exited');
      },
      { info: infoMock },
    );
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();

    const { result } = await collectDestroyChunks(service.destroy(token));

    expect(result).toMatchObject({ changeSummary: { delete: 1 } });
    expect(infoMock).toHaveBeenCalled();
  });

  it('should still recover as a success (trusting the proven-sufficient leak-check) when stack.info() reports a non-"succeeded" result', async () => {
    const infoMock = vi.fn().mockResolvedValue(makeUpdateSummary({ result: 'failed' }));
    const workspace = makeWorkspace(
      async () => {
        throw new Error('The Pulumi runtime detected that 2 promises were still active when the process exited');
      },
      { info: infoMock },
    );
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();

    const { result } = await collectDestroyChunks(service.destroy(token));

    expect(result).toMatchObject({ changeSummary: {} });
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('does not report "succeeded"'), expect.anything());
  });
});

describe('PulumiService.destroy failure handling', () => {
  it('should throw PulumiDestroyError (wrapping the cause) when stack.destroy() itself rejects with a non-lock, non-leak failure', async () => {
    const cause = new Error('destroy command failed');
    const workspace = makeWorkspace(async () => {
      throw cause;
    });
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();

    await expect(collectDestroyChunks(service.destroy(token))).rejects.toBeInstanceOf(PulumiDestroyError);
  });

  it('should persist a failed run record with exitCode 1 when stack.destroy() rejects', async () => {
    const workspace = makeWorkspace(async () => {
      throw new Error('destroy command failed');
    });
    const runRecordPersister = makeRunRecordPersister();
    const service = makeService({ workspace, runRecordPersister });
    const token = service.mintDestroyConfirmationToken();

    await expect(collectDestroyChunks(service.destroy(token))).rejects.toThrow();

    expect(runRecordPersister.persist).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 1 }), expect.any(String));
  });

  it('should log an error with the failure message (not a raw error object) when stack.destroy() rejects', async () => {
    const cause = new Error('destroy command failed');
    const workspace = makeWorkspace(async () => {
      throw cause;
    });
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();

    await expect(collectDestroyChunks(service.destroy(token))).rejects.toBeInstanceOf(PulumiDestroyError);

    expect(loggerMock.error).toHaveBeenCalledWith(
      'pulumi destroy: operation failed',
      expect.objectContaining({ error: expect.stringContaining('destroy command failed') }),
    );
  });
});

describe('PulumiService.destroy abort handling', () => {
  it('should end the generator cleanly (resolving undefined), never consume the token, and never touch Pulumi when the signal is already aborted', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();
    const controller = new AbortController();
    controller.abort();

    const { chunks, result } = await collectDestroyChunks(service.destroy(token, controller.signal));

    expect(chunks).toEqual([]);
    expect(result).toBeUndefined();
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();

    // The token was never consumed — still valid for a real attempt.
    await expect(collectDestroyChunks(service.destroy(token))).resolves.toBeDefined();
  });

  it('should register the internal abort listener with { once: true } and remove it on normal completion', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();
    const controller = new AbortController();
    const addEventListenerSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await collectDestroyChunks(service.destroy(token, controller.signal));

    expect(addEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', addEventListenerSpy.mock.calls[0]![1]);
  });

  it('should abort the in-flight stack.destroy() call and await its settlement before releasing the concurrency guard when the generator is force-closed', async () => {
    let capturedSignal: AbortSignal | undefined;
    let rejectDestroy!: (err: unknown) => void;
    const destroyMock = vi.fn().mockImplementation((opts: DestroyOptions) => {
      capturedSignal = opts.signal;
      opts.onOutput?.('Destroying...\n');
      return new Promise<DestroyResult>((_resolve, reject) => {
        rejectDestroy = reject;
      });
    });
    const getOrCreateStack = vi
      .fn()
      .mockResolvedValue({ destroy: destroyMock, cancel: vi.fn(), info: vi.fn() } as Partial<Stack> as Stack);
    const workspace = { getOrCreateStack } as unknown as PulumiWorkspaceService;
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();

    const gen = service.destroy(token);
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ stream: 'stdout', line: 'Destroying...' });
    expect(capturedSignal?.aborted).toBe(false);

    let returnSettled = false;
    const returnPromise = gen.return(undefined).then((result) => {
      returnSettled = true;
      return result;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(capturedSignal?.aborted).toBe(true);
    expect(returnSettled).toBe(false);

    rejectDestroy(new Error('killed by SIGINT'));
    const result = await returnPromise;

    expect(returnSettled).toBe(true);
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it('should persist a run.json record with a null exitCode via the outer finally when force-closed before the process settles', async () => {
    let rejectDestroy!: (err: unknown) => void;
    const destroyMock = vi.fn().mockImplementation((opts: DestroyOptions) => {
      opts.onOutput?.('Destroying...\n');
      return new Promise<DestroyResult>((_resolve, reject) => {
        rejectDestroy = reject;
      });
    });
    const getOrCreateStack = vi
      .fn()
      .mockResolvedValue({ destroy: destroyMock, cancel: vi.fn(), info: vi.fn() } as Partial<Stack> as Stack);
    const workspace = { getOrCreateStack } as unknown as PulumiWorkspaceService;
    const service = makeService({ workspace });
    const token = service.mintDestroyConfirmationToken();

    const gen = service.destroy(token);
    await gen.next();
    const returnPromise = gen.return(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    rejectDestroy(new Error('killed by SIGINT'));
    await returnPromise;

    const call = writeFileSyncMock.mock.calls.find((c) => String(c[0]).endsWith('run.json'));
    expect(call).toBeDefined();
    const record = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ kind: 'destroy', exitCode: null });
  });
});

describe('PulumiService.destroy concurrency guard', () => {
  it('should allow a new destroy() call once the previous one has completed', async () => {
    const workspace = makeWorkspace(makeHappyPathDestroy());
    const service = makeService({ workspace });

    const token1 = service.mintDestroyConfirmationToken();
    await collectDestroyChunks(service.destroy(token1));

    const token2 = service.mintDestroyConfirmationToken();
    await expect(collectDestroyChunks(service.destroy(token2))).resolves.toBeDefined();
  });

  it('should allow a new destroy() call once the previous one has failed', async () => {
    let shouldFail = true;
    const workspace = makeWorkspace(async () => {
      if (shouldFail) throw new Error('boom');
      return { stdout: '', stderr: '', summary: makeUpdateSummary() };
    });
    const service = makeService({ workspace });

    const token1 = service.mintDestroyConfirmationToken();
    await expect(collectDestroyChunks(service.destroy(token1))).rejects.toBeInstanceOf(PulumiDestroyError);

    shouldFail = false;
    const token2 = service.mintDestroyConfirmationToken();
    await expect(collectDestroyChunks(service.destroy(token2))).resolves.toBeDefined();
  });

  it('should throw a descriptive Error from a second destroy() call while the first is still in flight (different tokens)', async () => {
    let resolveDestroy!: () => void;
    const workspace = makeWorkspace(
      () =>
        new Promise((resolve) => {
          resolveDestroy = () => resolve({ stdout: '', stderr: '', summary: makeUpdateSummary() });
        }),
    );
    const service = makeService({ workspace });
    const firstToken = service.mintDestroyConfirmationToken();
    const firstGen = service.destroy(firstToken);
    const firstNext = firstGen.next();
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const secondToken = service.mintDestroyConfirmationToken();
    await expect(service.destroy(secondToken).next()).rejects.toThrow(/already running/i);

    resolveDestroy();
    await firstNext;
    await firstGen.next();
  });
});
