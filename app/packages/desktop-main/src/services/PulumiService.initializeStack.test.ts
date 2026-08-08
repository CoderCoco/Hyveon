/**
 * Unit tests for `PulumiService.initializeStack` — the wizard's
 * stack-initialization step, including the
 * `'engine'`-vs-`'operation'` failure-tag distinction covered by the
 * `should tag an engine-resolution failure as 'engine', not 'operation'`
 * case below.
 *
 * Mirrors `PulumiService.clearStaleLock.test.ts`'s `makeStore`/`makeWorkspace`/
 * `makeEngine`/`makeModuleRef`-style helpers — this method shares
 * `clearStaleLock()`'s "no-op inline program, no run persistence, no
 * REMOTE_FILE_STORE/RUN_RECORD_PERSISTER/RUN_LOCK_SERVICE wiring" shape, so
 * the same lightweight construction pattern applies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModuleRef } from '@nestjs/core';
import type { Stack } from '@pulumi/pulumi/automation/index.js';
import type { RunLock } from '@hyveon/shared';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../logger.js', () => ({ logger: loggerMock }));

import {
  PulumiService,
  PulumiOperationInFlightError,
  PulumiStackInitializationError,
  RUN_RECORD_PERSISTER,
  RUN_LOCK_SERVICE,
  CONFIG_CACHE_INVALIDATOR,
  type RunRecordPersister,
  type RunLockService,
  type ConfigCacheInvalidator,
} from './PulumiService.js';
import type { PulumiWorkspaceService } from './PulumiWorkspaceService.js';
import { PulumiPassphraseUnavailableError } from './PulumiWorkspaceService.js';
import type { PulumiEngineService, PulumiPhaseCallback } from './PulumiEngineService.js';
import { PulumiEngineNetworkError } from './PulumiEngineService.js';
import { PulumiCredentialsNotConfiguredError } from './PulumiCredentialResolver.js';
import { AwsPastedCredentialDecryptError } from './awsCredentialSource.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';

/** `bootstrap`/`aws`/`pulumi` fields `initializeStack()` reads off the store before ever calling Pulumi — mirrors `PulumiService.clearStaleLock.test.ts`'s identical fixture. */
const FULLY_CONFIGURED = { stateBucket: 'my-state-bucket', awsRegion: 'us-east-1' };

/** Builds a real `ElectronStoreService` (in-memory Map outside Electron) with the given fields pre-seeded. */
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

/** A fully-configured store (state bucket, AWS region) with no passphrase on record — the genuinely-new-stack case. */
function makeNewStackStore(): ElectronStoreService {
  return makeStore(FULLY_CONFIGURED);
}

/** The same fully-configured store, but with a passphrase already on record — the "stack already exists" case. */
function makeExistingStackStore(): ElectronStoreService {
  return makeStore({ ...FULLY_CONFIGURED, passphrase: 'enc-secret' });
}

/**
 * Builds a `PulumiWorkspaceService` stub whose `getOrCreateStack`:
 *  - fires `input.onPhase?.('engine', 'start')` then `('engine', 'end')`
 *    (mirroring `PulumiEngineService.resolve`'s own "always fires 'end',
 *    success or failure alike" contract) before settling,
 *  - resolves to a `Stack` stub wrapping the given `installPlugin`/`refresh`
 *    implementations, unless `rejectWith` is supplied, in which case it
 *    rejects with that error instead (still after firing the engine
 *    start/end pair, matching real behaviour for a `createOrSelectStack`
 *    failure that happens after engine resolution succeeded).
 */
function makeWorkspace(
  opts: {
    installPlugin?: ReturnType<typeof vi.fn>;
    refresh?: ReturnType<typeof vi.fn>;
    rejectWith?: unknown;
    /** When true, never fires the `'engine'` start/end pair at all — mirrors a failure that happens strictly BEFORE `engine.resolve()` is called (passphrase/credentials). */
    failBeforeEngine?: boolean;
  } = {},
): PulumiWorkspaceService & { getOrCreateStack: ReturnType<typeof vi.fn> } {
  const installPlugin = opts.installPlugin ?? vi.fn().mockResolvedValue(undefined);
  const refresh = opts.refresh ?? vi.fn().mockResolvedValue(undefined);
  const stack = { workspace: { installPlugin }, refresh } as unknown as Stack;

  const getOrCreateStack = vi.fn().mockImplementation(async (input: { onPhase?: PulumiPhaseCallback }) => {
    if (opts.failBeforeEngine) {
      throw opts.rejectWith;
    }
    input.onPhase?.('engine', 'start');
    input.onPhase?.('engine', 'end');
    if (opts.rejectWith !== undefined) {
      throw opts.rejectWith;
    }
    return stack;
  });

  return { getOrCreateStack } as unknown as PulumiWorkspaceService & { getOrCreateStack: ReturnType<typeof vi.fn> };
}

/** Stub `ModuleRef` — `initializeStack()` never resolves anything through it, but the constructor still requires one. */
function makeModuleRef(): ModuleRef {
  const get = vi.fn(() => {
    throw new Error('ModuleRef.get() should never be called by initializeStack()');
  });
  return { get } as unknown as ModuleRef;
}

/** Stub `PulumiEngineService` — an ordinary constructor dependency `initializeStack()` never reads directly (engine resolution happens inside `getOrCreateStack`, which is itself stubbed here). */
function makeEngine(): PulumiEngineService {
  return {
    resolve: vi.fn().mockResolvedValue({}),
    getResolvedVersion: vi.fn().mockReturnValue('3.255.0'),
  } as unknown as PulumiEngineService;
}

/** Constructs `PulumiService` with every dependency stubbed. */
function makeService(opts: { workspace: PulumiWorkspaceService; store?: ElectronStoreService }): PulumiService {
  return new PulumiService(opts.workspace, opts.store ?? makeNewStackStore(), makeModuleRef(), makeEngine());
}

beforeEach(() => {
  loggerMock.debug.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
});

describe('PulumiService.initializeStack', () => {
  describe('phase reporting', () => {
    it('should report start/end for all three phases, in order, on a fully successful run', async () => {
      const workspace = makeWorkspace();
      const service = makeService({ workspace });
      const events: Array<{ phase: string; status: string }> = [];

      await service.initializeStack((phase, status) => events.push({ phase, status }));

      expect(events).toEqual([
        { phase: 'engine', status: 'start' },
        { phase: 'engine', status: 'end' },
        { phase: 'plugins', status: 'start' },
        { phase: 'plugins', status: 'end' },
        { phase: 'operation', status: 'start' },
        { phase: 'operation', status: 'end' },
      ]);
    });

    it('should call getOrCreateStack with a zero-argument, zero-resource inline program', async () => {
      const workspace = makeWorkspace();
      const service = makeService({ workspace });

      await service.initializeStack();

      expect(workspace.getOrCreateStack).toHaveBeenCalledTimes(1);
      const input = workspace.getOrCreateStack.mock.calls[0]![0] as Record<string, unknown>;
      expect(typeof input['program']).toBe('function');
      const program = input['program'] as () => Promise<unknown>;
      await expect(program()).resolves.toBeUndefined();
    });

    it('should explicitly install the pinned @pulumi/aws provider plugin as a resource plugin', async () => {
      const installPlugin = vi.fn().mockResolvedValue(undefined);
      const workspace = makeWorkspace({ installPlugin });
      const service = makeService({ workspace });

      await service.initializeStack();

      expect(installPlugin).toHaveBeenCalledTimes(1);
      const [name, version, kind] = installPlugin.mock.calls[0]!;
      expect(name).toBe('aws');
      expect(typeof version).toBe('string');
      expect((version as string).length).toBeGreaterThan(0);
      expect(kind).toBe('resource');
    });

    it('should call stack.refresh() for the operation phase', async () => {
      const refresh = vi.fn().mockResolvedValue(undefined);
      const workspace = makeWorkspace({ refresh });
      const service = makeService({ workspace });

      await service.initializeStack();

      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('should record a Pulumi lock attempt immediately before stack.refresh() and clear it once refresh settles — success case', async () => {
      const store = makeNewStackStore();
      const recordSpy = vi.spyOn(store, 'recordPulumiLockAttempt');
      const clearSpy = vi.spyOn(store, 'clearPulumiLockAttempt');
      const refresh = vi.fn().mockImplementation(async () => {
        // At the moment refresh() itself runs, the lock attempt must
        // already be recorded and not yet cleared.
        expect(recordSpy).toHaveBeenCalledTimes(1);
        expect(clearSpy).not.toHaveBeenCalled();
      });
      const workspace = makeWorkspace({ refresh });
      const service = makeService({ workspace, store });

      await service.initializeStack();

      expect(recordSpy).toHaveBeenCalledWith('production');
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).toHaveBeenCalledWith(recordSpy.mock.results[0]!.value);
    });

    it('should still clear the recorded lock attempt when stack.refresh() itself fails', async () => {
      const store = makeNewStackStore();
      const recordSpy = vi.spyOn(store, 'recordPulumiLockAttempt');
      const clearSpy = vi.spyOn(store, 'clearPulumiLockAttempt');
      const refresh = vi.fn().mockRejectedValue(new Error('refresh failed'));
      const workspace = makeWorkspace({ refresh });
      const service = makeService({ workspace, store });

      await expect(service.initializeStack()).rejects.toThrow();

      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('should not report plugins/operation phases at all when getOrCreateStack fails', async () => {
      const workspace = makeWorkspace({ rejectWith: new Error('boom') });
      const service = makeService({ workspace });
      const events: Array<{ phase: string; status: string }> = [];

      await expect(service.initializeStack((phase, status) => events.push({ phase, status }))).rejects.toThrow();

      expect(events.some((e) => e.phase === 'plugins')).toBe(false);
      expect(events.some((e) => e.phase === 'operation')).toBe(false);
    });

    it('should still report plugins end when installPlugin fails, and never reach the operation phase', async () => {
      const installPlugin = vi.fn().mockRejectedValue(new Error('network unreachable'));
      const workspace = makeWorkspace({ installPlugin });
      const service = makeService({ workspace });
      const events: Array<{ phase: string; status: string }> = [];

      await expect(service.initializeStack((phase, status) => events.push({ phase, status }))).rejects.toThrow();

      expect(events).toEqual([
        { phase: 'engine', status: 'start' },
        { phase: 'engine', status: 'end' },
        { phase: 'plugins', status: 'start' },
        { phase: 'plugins', status: 'end' },
      ]);
    });
  });

  describe('error attribution', () => {
    it("should tag an engine-resolution failure as 'engine', not 'operation'", async () => {
      // PulumiEngineService.resolve fires ('engine', 'end') on BOTH success
      // AND rejection — makeWorkspace() reproduces that exact real behaviour
      // (fires the engine start/end pair unconditionally, then rejects).
      // The original implementation inferred 'operation' from seeing
      // ('engine', 'end') fire at all, which is wrong for exactly this
      // case: engine resolution itself failed, but 'end' still fired.
      const cause = new PulumiEngineNetworkError('/fake/root', new Error('ENOTFOUND get.pulumi.com'));
      const workspace = makeWorkspace({ rejectWith: cause });
      const service = makeService({ workspace });

      let caught: unknown;
      try {
        await service.initializeStack();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PulumiStackInitializationError);
      expect((caught as PulumiStackInitializationError).phase).toBe('engine');
      expect((caught as PulumiStackInitializationError).cause).toBe(cause);
    });

    it("should tag a pre-engine passphrase failure as 'engine' (no better phase slot exists)", async () => {
      const cause = new PulumiPassphraseUnavailableError('new-stack-keychain-unavailable');
      const workspace = makeWorkspace({ rejectWith: cause, failBeforeEngine: true });
      const service = makeService({ workspace });

      let caught: unknown;
      try {
        await service.initializeStack();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PulumiStackInitializationError);
      expect((caught as PulumiStackInitializationError).phase).toBe('engine');
    });

    it("should tag a pre-engine credentials failure as 'engine' (no better phase slot exists)", async () => {
      const cause = new PulumiCredentialsNotConfiguredError();
      const workspace = makeWorkspace({ rejectWith: cause, failBeforeEngine: true });
      const service = makeService({ workspace });

      let caught: unknown;
      try {
        await service.initializeStack();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PulumiStackInitializationError);
      expect((caught as PulumiStackInitializationError).phase).toBe('engine');
    });

    it("should tag a pasted-credential decrypt failure as 'engine' — regression test for Finding 4 (final whole-branch review)", async () => {
      // resolveCredentialEnvVars -> resolveAwsCredentialSource ->
      // ElectronStoreService.getPastedCredentials -> SafeStorageService.decrypt
      // can throw Electron's own raw decrypt error on a corrupt/foreign
      // pasted-credentials ciphertext blob, wrapped as
      // AwsPastedCredentialDecryptError (Finding 4's fix) — genuinely a
      // pre-engine failure (credential resolution happens strictly before
      // engine.resolve()), same class of mis-attribution bug the
      // PulumiPassphraseUnavailableError/PulumiCredentialsNotConfiguredError
      // tests above already cover for different error types.
      const cause = new AwsPastedCredentialDecryptError('hyveon-pasted', new Error('decrypt failed'));
      const workspace = makeWorkspace({ rejectWith: cause, failBeforeEngine: true });
      const service = makeService({ workspace });

      let caught: unknown;
      try {
        await service.initializeStack();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PulumiStackInitializationError);
      expect((caught as PulumiStackInitializationError).phase).toBe('engine');
      expect((caught as PulumiStackInitializationError).cause).toBe(cause);
    });

    it("should tag a createOrSelectStack failure (after engine resolution succeeded) as 'operation'", async () => {
      const cause = new Error('bucket does not exist');
      const workspace = makeWorkspace({ rejectWith: cause });
      const service = makeService({ workspace });

      let caught: unknown;
      try {
        await service.initializeStack();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PulumiStackInitializationError);
      expect((caught as PulumiStackInitializationError).phase).toBe('operation');
      expect((caught as PulumiStackInitializationError).cause).toBe(cause);
    });

    it('should log an error with the failure message (not a raw error object) when getOrCreateStack fails', async () => {
      const cause = new Error('bucket does not exist');
      const workspace = makeWorkspace({ rejectWith: cause });
      const service = makeService({ workspace });

      await expect(service.initializeStack()).rejects.toBeInstanceOf(PulumiStackInitializationError);

      expect(loggerMock.error).toHaveBeenCalledWith(
        'PulumiService.initializeStack: getOrCreateStack failed',
        expect.objectContaining({ error: expect.stringContaining('bucket does not exist') }),
      );
    });

    it("should tag an installPlugin failure as 'plugins'", async () => {
      const cause = new Error('plugin install failed');
      const installPlugin = vi.fn().mockRejectedValue(cause);
      const workspace = makeWorkspace({ installPlugin });
      const service = makeService({ workspace });

      let caught: unknown;
      try {
        await service.initializeStack();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PulumiStackInitializationError);
      expect((caught as PulumiStackInitializationError).phase).toBe('plugins');
      expect((caught as PulumiStackInitializationError).cause).toBe(cause);
    });

    it("should tag a stack.refresh() failure as 'operation'", async () => {
      const cause = new Error('refresh failed');
      const refresh = vi.fn().mockRejectedValue(cause);
      const workspace = makeWorkspace({ refresh });
      const service = makeService({ workspace });

      let caught: unknown;
      try {
        await service.initializeStack();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PulumiStackInitializationError);
      expect((caught as PulumiStackInitializationError).phase).toBe('operation');
      expect((caught as PulumiStackInitializationError).cause).toBe(cause);
    });

    it('should log an error with the failure message (not a raw error object) when installPlugin fails', async () => {
      const cause = new Error('plugin install failed');
      const installPlugin = vi.fn().mockRejectedValue(cause);
      const workspace = makeWorkspace({ installPlugin });
      const service = makeService({ workspace });

      await expect(service.initializeStack()).rejects.toBeInstanceOf(PulumiStackInitializationError);

      expect(loggerMock.error).toHaveBeenCalledWith(
        'PulumiService.initializeStack: installPlugin("aws") failed',
        expect.objectContaining({ error: expect.stringContaining('plugin install failed') }),
      );
    });

    it('should log an error with the failure message (not a raw error object) when stack.refresh() fails', async () => {
      const cause = new Error('refresh failed');
      const refresh = vi.fn().mockRejectedValue(cause);
      const workspace = makeWorkspace({ refresh });
      const service = makeService({ workspace });

      await expect(service.initializeStack()).rejects.toBeInstanceOf(PulumiStackInitializationError);

      expect(loggerMock.error).toHaveBeenCalledWith(
        'PulumiService.initializeStack: stack.refresh() failed',
        expect.objectContaining({ error: expect.stringContaining('refresh failed') }),
      );
    });
  });

  describe('getOrCreateStack input shape (Finding 1, final review: no more caller-supplied stackExists)', () => {
    /**
     * `PulumiWorkspaceInput.stackExists` was retired by Finding 1's fix
     * (final whole-branch review): every real call site computed it as
     * `this.store.get('pulumi')?.passphrase !== undefined`, definitionally
     * identical to `PulumiWorkspaceService`'s own internal check, which made
     * its "existing stack with no local record" guard permanently
     * unreachable. `getOrCreateStack` now determines this itself via a real
     * `listStacks()` probe against the backend — see
     * `PulumiWorkspaceService.resolveNewPassphrase`'s doc comment — so
     * `initializeStack` (this app's very first real caller of
     * `getOrCreateStack`, in the first-run wizard) no longer computes or
     * passes any such field at all, regardless of whether a passphrase is
     * already on record.
     */
    it('should never pass a stackExists field, whether or not a passphrase is already on record', async () => {
      const newStackWorkspace = makeWorkspace();
      const newStackService = makeService({ workspace: newStackWorkspace, store: makeNewStackStore() });
      await newStackService.initializeStack();
      const newStackInput = newStackWorkspace.getOrCreateStack.mock.calls[0]![0] as Record<string, unknown>;
      expect('stackExists' in newStackInput).toBe(false);

      const existingStackWorkspace = makeWorkspace();
      const existingStackService = makeService({ workspace: existingStackWorkspace, store: makeExistingStackStore() });
      await existingStackService.initializeStack();
      const existingStackInput = existingStackWorkspace.getOrCreateStack.mock.calls[0]![0] as Record<string, unknown>;
      expect('stackExists' in existingStackInput).toBe(false);
    });

    it('should always pass backendReady: true', async () => {
      const workspace = makeWorkspace();
      const service = makeService({ workspace });

      await service.initializeStack();

      const input = workspace.getOrCreateStack.mock.calls[0]![0] as Record<string, unknown>;
      expect(input['backendReady']).toBe(true);
    });
  });

  describe('pre-flight config check', () => {
    it('should reject with a descriptive, engine-tagged error and never call getOrCreateStack when the state bucket / AWS region is not configured', async () => {
      const workspace = makeWorkspace();
      const store = makeStore();
      const service = makeService({ workspace, store });

      let caught: unknown;
      try {
        await service.initializeStack();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PulumiStackInitializationError);
      expect((caught as PulumiStackInitializationError).phase).toBe('engine');
      expect((caught as Error).message).toMatch(/state bucket.*AWS region.*not.*configured/i);
      expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
    });
  });

  describe('reentrancy guards', () => {
    it('should reject with PulumiOperationInFlightError, and never call getOrCreateStack, when destroy() is already in flight', async () => {
      // Mirrors PulumiService.clearStaleLock.test.ts's identical concurrency
      // test — uses a genuinely concurrent destroy() (rather than faking
      // operationInFlight directly, a private field) as the in-flight
      // operation.
      let resolveDestroy!: () => void;
      const destroyMock = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveDestroy = () =>
              resolve({
                stdout: '',
                stderr: '',
                summary: {
                  kind: 'destroy',
                  startTime: new Date(),
                  endTime: new Date(),
                  message: '',
                  environment: {},
                  config: {},
                  result: 'succeeded',
                  version: 1,
                },
              });
          }),
      );
      const getOrCreateStack = vi
        .fn()
        .mockResolvedValue({ destroy: destroyMock, cancel: vi.fn() } as Partial<Stack> as Stack);
      const workspace = { getOrCreateStack } as unknown as PulumiWorkspaceService;

      const lock: RunLock = {
        runId: 'destroy-run-1',
        kind: 'destroy',
        initiator: 'test-initiator',
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const runRecordPersister: RunRecordPersister = {
        getByRunId: vi.fn(),
        persist: vi.fn().mockResolvedValue(undefined),
        writePreflightMarker: vi.fn().mockResolvedValue(undefined),
      };
      const runLockService: RunLockService = { createRun: vi.fn().mockResolvedValue(lock), releaseRun: vi.fn().mockResolvedValue(undefined) };
      const configCacheInvalidator: ConfigCacheInvalidator = { invalidateCache: vi.fn() };
      const moduleRef = {
        get: vi.fn((token: unknown) => {
          if (token === RUN_RECORD_PERSISTER) return runRecordPersister;
          if (token === RUN_LOCK_SERVICE) return runLockService;
          if (token === CONFIG_CACHE_INVALIDATOR) return configCacheInvalidator;
          throw new Error(`unexpected ModuleRef token ${String(token)}`);
        }),
      } as unknown as ModuleRef;

      // destroy()'s own gate requires a passphrase on record (mirrors
      // PulumiService.destroy.test.ts's own fixtures) — without one its
      // gate rejects with "no Pulumi stack has ever been created" before
      // ever setting operationInFlight, which would make this test's
      // initializeStack() call race right past the guard it's meant to
      // exercise.
      const store = makeExistingStackStore();
      const service = new PulumiService(workspace, store, moduleRef, makeEngine());
      const token = service.mintDestroyConfirmationToken();

      const destroyGen = service.destroy(token);
      const destroyNext = destroyGen.next();
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      getOrCreateStack.mockClear();

      await expect(service.initializeStack()).rejects.toBeInstanceOf(PulumiOperationInFlightError);
      await expect(service.initializeStack()).rejects.toThrow(/destroy.*already running/i);
      expect(getOrCreateStack).not.toHaveBeenCalled();

      resolveDestroy();
      await destroyNext;
      await destroyGen.next();
    });

    it('should reject a second concurrent initializeStack() call while the first is still in flight, and never call getOrCreateStack for the rejected call', async () => {
      let resolveGetOrCreateStack!: () => void;
      const getOrCreateStack = vi.fn().mockImplementation(
        (input: { onPhase?: PulumiPhaseCallback }) =>
          new Promise((resolve) => {
            input.onPhase?.('engine', 'start');
            resolveGetOrCreateStack = () => {
              input.onPhase?.('engine', 'end');
              resolve({ workspace: { installPlugin: vi.fn().mockResolvedValue(undefined) }, refresh: vi.fn().mockResolvedValue(undefined) });
            };
          }),
      );
      const workspace = { getOrCreateStack } as unknown as PulumiWorkspaceService;
      const service = makeService({ workspace });

      const firstCall = service.initializeStack();
      // Let the first call's synchronous prefix run (reserving stackInitInFlight).
      await new Promise<void>((resolve) => setImmediate(resolve));

      await expect(service.initializeStack()).rejects.toThrow(/initializeStack.*already running/i);
      // Only the first call's own invocation — the rejected second call
      // never reaches `getOrCreateStack` at all.
      expect(getOrCreateStack).toHaveBeenCalledTimes(1);

      // Let the first call settle cleanly, proving the guard is released
      // once it does (a fresh call after settling is covered by its own
      // dedicated test below, using a simpler always-resolving mock).
      resolveGetOrCreateStack();
      await expect(firstCall).resolves.toBeUndefined();
    });

    it('should allow a fresh initializeStack() call on the SAME instance after a prior one failed (stackInitInFlight is released)', async () => {
      let shouldFail = true;
      const getOrCreateStack = vi.fn().mockImplementation(async (input: { onPhase?: PulumiPhaseCallback }) => {
        input.onPhase?.('engine', 'start');
        input.onPhase?.('engine', 'end');
        if (shouldFail) throw new Error('boom');
        return { workspace: { installPlugin: vi.fn().mockResolvedValue(undefined) }, refresh: vi.fn().mockResolvedValue(undefined) };
      });
      const workspace = { getOrCreateStack } as unknown as PulumiWorkspaceService;
      const service = makeService({ workspace });

      await expect(service.initializeStack()).rejects.toThrow();

      shouldFail = false;
      await expect(service.initializeStack()).resolves.toBeUndefined();
    });
  });
});
