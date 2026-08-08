/**
 * Unit tests for `PulumiService.preview` — the first real Pulumi operation.
 * Covers spawn/artifact persistence, streaming, run-log capture, `run.json`
 * persistence, `RunRecordService` persistence, structured summary, abort
 * handling, the config-version-aware plan hash, engine-version stamping,
 * and leaked-promise recovery.
 *
 * `node:fs` is fully mocked so no test touches the real filesystem.
 * `node:crypto`'s `randomUUID` is
 * mocked for deterministic `runId`s; `createHash` is delegated to the real
 * implementation so `computePlanHash`'s SHA-256 digest is independently
 * verifiable. `PulumiWorkspaceService.getOrCreateStack` is stubbed to
 * return a fake `Stack` whose `preview()` method each test controls
 * directly — the underlying `@pulumi/pulumi` SDK's own `stack.preview()`
 * implementation is not exercised here (that's `PulumiWorkspaceService`'s
 * own test file's concern via `getOrCreateStack`, and `node_modules`'
 * concern for `stack.preview()` itself). `@hyveon/infra`'s `createInfraProgram`
 * is the REAL implementation — it only captures its arguments in a closure
 * at call time (verified by reading `program.ts`), never touching the
 * filesystem or invoking the closure itself, so it's safe to call
 * unmocked and cheaper than maintaining a parallel stub of its contract.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModuleRef } from '@nestjs/core';
import type { EngineEvent, PreviewOptions, PreviewResult, Stack } from '@pulumi/pulumi/automation/index.js';
import type { RemoteFileStore } from '@hyveon/shared';

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

// `createHash` is delegated to the real `node:crypto` implementation so
// `computePlanHash`'s SHA-256 digest is a real, independently-verifiable
// hash of whatever bytes `readFileSyncMock` returns — only `randomUUID`
// needs to be deterministically controlled.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: randomUUIDMock };
});

vi.mock('../logger.js', () => ({ logger: loggerMock }));

import {
  PulumiService,
  PulumiPreviewError,
  PulumiPlanHashError,
  PulumiRunPersistError,
  RUN_RECORD_PERSISTER,
  type RunRecordPersister,
} from './PulumiService.js';
import { REMOTE_FILE_STORE } from '../modules/cloud-provider.tokens.js';
import type { PulumiWorkspaceService } from './PulumiWorkspaceService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import type { PulumiEngineService } from './PulumiEngineService.js';
import { SafeStorageService } from './SafeStorageService.js';

/** `bootstrap`/`aws`/`pulumi` fields `preview()` reads off the store before ever calling Pulumi. */
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

/** A fully-configured store, including a configuration bucket (which `FULLY_CONFIGURED` in `PulumiService.test.ts` doesn't need). */
function makeFullyConfiguredStore(): ElectronStoreService {
  return makeStore({ ...FULLY_CONFIGURED, configurationBucket: 'hyveon-config' });
}

/** Minimal deployment-config JSON `preview()` fetches and parses — content doesn't matter since `createInfraProgram`'s closure is never invoked. */
const CONFIG_JSON = JSON.stringify({ hostedZoneName: 'example.com', gameServers: {} });

/** `RemoteFileStore` stub whose `get`/`listVersions` resolve fixture configuration content by default. */
function makeRemoteFileStore(
  overrides: Partial<RemoteFileStore> = {},
): RemoteFileStore & { get: ReturnType<typeof vi.fn>; listVersions: ReturnType<typeof vi.fn> } {
  const store: Partial<RemoteFileStore> = {
    get: vi.fn().mockResolvedValue({ body: new TextEncoder().encode(CONFIG_JSON), etag: 'etag-1' }),
    put: vi.fn(),
    listVersions: vi.fn().mockResolvedValue([{ versionId: 'cfg-v1', lastModified: new Date('2026-01-01') }]),
    getVersion: vi.fn(),
  };
  return Object.assign(store, overrides) as RemoteFileStore & {
    get: ReturnType<typeof vi.fn>;
    listVersions: ReturnType<typeof vi.fn>;
  };
}

/**
 * `RunRecordPersister` stub backed by directly-inspectable `persist`/
 * `getByRunId` mocks. `getByRunId` (used by `apply()`'s gate) defaults to
 * rejecting loudly — none of this
 * file's `preview()` tests ever reach it, so an unexpected call fails loudly
 * instead of silently resolving `undefined`.
 */
function makeRunRecordPersister(): RunRecordPersister & {
  persist: ReturnType<typeof vi.fn>;
  getByRunId: ReturnType<typeof vi.fn>;
  writePreflightMarker: ReturnType<typeof vi.fn>;
} {
  return {
    persist: vi.fn().mockResolvedValue(undefined),
    getByRunId: vi.fn(() => {
      throw new Error('RunRecordPersister.getByRunId() was not expected to be called by this test');
    }),
    writePreflightMarker: vi.fn(() => {
      throw new Error('RunRecordPersister.writePreflightMarker() was not expected to be called by this test');
    }),
  };
}

/** Shape `preview()`'s `stack.preview` mock is driven with — lets each test script onOutput/onError/onEvent calls and the eventual settlement. */
type FakeStackPreview = (opts: PreviewOptions) => Promise<PreviewResult>;

/** Builds a `PulumiWorkspaceService` stub whose `getOrCreateStack` resolves to a stack stub wrapping the given `preview` implementation. */
function makeWorkspace(previewImpl: FakeStackPreview): PulumiWorkspaceService & {
  getOrCreateStack: ReturnType<typeof vi.fn>;
} {
  const previewMock = vi.fn().mockImplementation(previewImpl);
  const getOrCreateStack = vi.fn().mockResolvedValue({ preview: previewMock } as Partial<Stack> as Stack);
  return { getOrCreateStack } as unknown as PulumiWorkspaceService & { getOrCreateStack: ReturnType<typeof vi.fn> };
}

/** A `stack.preview` implementation that streams one stdout/one stderr line, reports a summary, and resolves cleanly. */
function makeHappyPathPreview(changeSummary: Record<string, number> = { create: 2, same: 1 }): FakeStackPreview {
  return async (opts) => {
    opts.onOutput?.('Previewing update...\n');
    opts.onError?.('warning: something\n');
    const event: EngineEvent = {
      sequence: 1,
      timestamp: Math.floor(Date.now() / 1000),
      summaryEvent: { maybeCorrupt: false, durationSeconds: 1, resourceChanges: changeSummary, policyPacks: {} },
    };
    opts.onEvent?.(event);
    return { stdout: 'Previewing update...\n', stderr: 'warning: something\n', changeSummary };
  };
}

/**
 * Stub `ModuleRef` routing `.get(token, { strict: false })` to the given
 * `RunRecordPersister`/`RemoteFileStore` stubs — mirrors how `preview()`
 * actually resolves them at call time (see `PulumiService.ts`'s
 * `getRunRecordPersister`/`getRemoteFileStore` and `pulumi-service.module.ts`'s
 * doc comment for why this is a `ModuleRef` lookup rather than a normal
 * constructor-injected dependency).
 */
function makeModuleRef(runRecordPersister: RunRecordPersister, remoteFileStore: RemoteFileStore): ModuleRef {
  const get = vi.fn((token: unknown) => {
    if (token === RUN_RECORD_PERSISTER) return runRecordPersister;
    if (token === REMOTE_FILE_STORE) return remoteFileStore;
    throw new Error(`ModuleRef.get() called with an unexpected token: ${String(token)}`);
  });
  return { get } as unknown as ModuleRef;
}

/**
 * Stub `PulumiEngineService` — `preview()` never touches it (`apply()`'s
 * gate is this dependency's only real caller), so both methods
 * throwing is intentional, mirroring `makeRunRecordPersister`'s
 * `getByRunId` stub above.
 */
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

/** Constructs `PulumiService` with every dependency stubbed, using real `createHash`. */
function makeService(opts: {
  workspace: PulumiWorkspaceService;
  store?: ElectronStoreService;
  runRecordPersister?: ReturnType<typeof makeRunRecordPersister>;
  remoteFileStore?: ReturnType<typeof makeRemoteFileStore>;
  engine?: PulumiEngineService;
}): PulumiService {
  const runRecordPersister = opts.runRecordPersister ?? makeRunRecordPersister();
  const remoteFileStore = opts.remoteFileStore ?? makeRemoteFileStore();
  return new PulumiService(
    opts.workspace,
    opts.store ?? makeFullyConfiguredStore(),
    makeModuleRef(runRecordPersister, remoteFileStore),
    opts.engine ?? makeEngine(),
  );
}

/** Drains a `preview()` async generator to completion, collecting every yielded chunk plus the final return value. */
async function collectPreviewChunks(gen: ReturnType<PulumiService['preview']>) {
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
  readFileSyncMock.mockReturnValue(Buffer.from(JSON.stringify({ manifest: { version: 'v3.255.0' } })));
  randomUUIDMock.mockReset();
  randomUUIDMock.mockReturnValue('run-123');
  loggerMock.warn.mockReset();
});

describe('PulumiService.preview spawning and artifact persistence', () => {
  it('should mint a runId, create its run directory, and call stack.preview with the plan artifact path', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview());
    const service = makeService({ workspace });

    await collectPreviewChunks(service.preview());

    expect(mkdirSyncMock).toHaveBeenCalledWith(expect.stringContaining('run-123'), { recursive: true });
    const stack = await workspace.getOrCreateStack.mock.results[0]!.value;
    expect(stack.preview).toHaveBeenCalledWith(
      expect.objectContaining({ plan: expect.stringContaining('run-123.plan.json') }),
    );
  });

  it('should construct the stack via getOrCreateStack without passing credentialEnvVars', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview());
    const service = makeService({ workspace });

    await collectPreviewChunks(service.preview());

    expect(workspace.getOrCreateStack).toHaveBeenCalledTimes(1);
    const input = workspace.getOrCreateStack.mock.calls[0]![0] as Record<string, unknown>;
    expect(input['credentialEnvVars']).toBeUndefined();
    expect(input).toMatchObject({
      stateBucket: 'my-state-bucket',
      stateBucketRegion: 'us-east-1',
      backendReady: true,
    });
  });

  it('should read the configuration object from the RemoteFileStore before calling stack.preview', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview());
    const remoteFileStore = makeRemoteFileStore();
    const service = makeService({ workspace, remoteFileStore });

    await collectPreviewChunks(service.preview());

    expect(remoteFileStore.listVersions).toHaveBeenCalledWith('deployment-config.json');
    expect(remoteFileStore.get).toHaveBeenCalledWith('deployment-config.json');
  });

  it('should throw and never call getOrCreateStack when no configuration bucket is configured', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview());
    const service = makeService({ workspace, store: makeStore(FULLY_CONFIGURED) });

    await expect(collectPreviewChunks(service.preview())).rejects.toThrow(/configuration bucket/i);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should throw and never call getOrCreateStack when the configuration object does not exist', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview());
    const remoteFileStore = makeRemoteFileStore({ listVersions: vi.fn().mockResolvedValue([]) });
    const service = makeService({ workspace, remoteFileStore });

    await expect(collectPreviewChunks(service.preview())).rejects.toThrow(/not found/i);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should throw and never call getOrCreateStack when configVersionId no longer matches the head version', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview());
    const remoteFileStore = makeRemoteFileStore();
    const service = makeService({ workspace, remoteFileStore });

    await expect(collectPreviewChunks(service.preview('stale-version'))).rejects.toThrow(/stale/i);
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should proceed to call stack.preview when the supplied configVersionId matches the head version', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview());
    const remoteFileStore = makeRemoteFileStore();
    const service = makeService({ workspace, remoteFileStore });

    await collectPreviewChunks(service.preview('cfg-v1'));

    expect(workspace.getOrCreateStack).toHaveBeenCalledTimes(1);
  });

  it('should throw synchronously when preview() is called while another operation is already in flight', async () => {
    const workspace = makeWorkspace(
      () =>
        new Promise<PreviewResult>(() => {
          // Never resolves — keeps the first call "in flight" for this test.
        }),
    );
    const service = makeService({ workspace });

    const first = service.preview();
    void first.next(); // Drive it far enough to set operationInFlight.
    await Promise.resolve();
    await Promise.resolve();

    const second = service.preview();
    await expect(second.next()).rejects.toThrow(/already.*running/i);
  });

  it('should throw synchronously when preview() is called while initializeStack() is already in flight', async () => {
    // Regression test for a code-reviewer-traced race: initializeStack()
    // does not set `operationInFlight` (see PulumiService.ts's own
    // `stackInitInFlight` doc comment for why it's a separate flag), so
    // preview() must check `stackInitInFlight` itself or it would sail
    // straight through this check while initializeStack() is still running
    // against the same shared local workspace.
    const hangingWorkspace = {
      getOrCreateStack: vi.fn(() => new Promise(() => {
        // Never resolves — keeps initializeStack() "in flight" for this test.
      })),
    } as unknown as PulumiWorkspaceService;
    const service = makeService({ workspace: hangingWorkspace });

    const initPromise = service.initializeStack();
    // Let initializeStack()'s synchronous prefix run (reserving stackInitInFlight).
    await Promise.resolve();
    await Promise.resolve();

    await expect(collectPreviewChunks(service.preview())).rejects.toThrow(/initializeStack.*already running/i);

    void initPromise.catch(() => {}); // Left permanently in flight — never awaited to settle, by design.
  });
});

describe('PulumiService.preview streaming', () => {
  it('should yield stdout and stderr chunks in production order, split into lines', async () => {
    const workspace = makeWorkspace(async (opts) => {
      opts.onOutput?.('line one\nline two\n');
      opts.onError?.('err line\n');
      return { stdout: '', stderr: '', changeSummary: { same: 1 } };
    });
    const service = makeService({ workspace });

    const { chunks } = await collectPreviewChunks(service.preview());

    expect(chunks).toEqual([
      { stream: 'stdout', line: 'line one' },
      { stream: 'stdout', line: 'line two' },
      { stream: 'stderr', line: 'err line' },
    ]);
  });

  it('should hold back a trailing partial line and flush it once the operation settles', async () => {
    const workspace = makeWorkspace(async (opts) => {
      opts.onOutput?.('complete line\npartial-no-newline');
      return { stdout: '', stderr: '', changeSummary: { same: 1 } };
    });
    const service = makeService({ workspace });

    const { chunks } = await collectPreviewChunks(service.preview());

    expect(chunks).toEqual([
      { stream: 'stdout', line: 'complete line' },
      { stream: 'stdout', line: 'partial-no-newline' },
    ]);
  });

  it('should write the accumulated transcript to pulumi.log once the operation settles', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview());
    const service = makeService({ workspace });

    await collectPreviewChunks(service.preview());

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('pulumi.log'),
      'Previewing update...\nwarning: something\n',
    );
  });
});

describe('PulumiService.preview environment redaction', () => {
  /** Distinctive operator-set environment value that must never survive into streamed or persisted output verbatim. */
  const SECRET_VALUE = 'sup3rSecretValue';

  /** `RemoteFileStore` override whose configuration object has one game server with `SECRET_VALUE` as an environment value. */
  function makeRemoteFileStoreWithSecretEnv(): ReturnType<typeof makeRemoteFileStore> {
    return makeRemoteFileStore({
      get: vi.fn().mockResolvedValue({
        body: new TextEncoder().encode(
          JSON.stringify({
            hostedZoneName: 'example.com',
            gameServers: { minecraft: { environment: [{ name: 'RCON_PASSWORD', value: SECRET_VALUE }] } },
          }),
        ),
        etag: 'etag-1',
      }),
    });
  }

  it('should redact an operator-set environment value from streamed stdout and stderr chunks', async () => {
    const remoteFileStore = makeRemoteFileStoreWithSecretEnv();
    const workspace = makeWorkspace(async (opts) => {
      opts.onOutput?.(`applying RCON_PASSWORD=${SECRET_VALUE}\n`);
      opts.onError?.(`warning: leaked ${SECRET_VALUE} in output\n`);
      return { stdout: '', stderr: '', changeSummary: { same: 1 } };
    });
    const service = makeService({ workspace, remoteFileStore });

    const { chunks } = await collectPreviewChunks(service.preview());

    expect(chunks).toEqual([
      { stream: 'stdout', line: 'applying RCON_PASSWORD=***REDACTED***' },
      { stream: 'stderr', line: 'warning: leaked ***REDACTED*** in output' },
    ]);
    expect(chunks.some((chunk) => chunk.line.includes(SECRET_VALUE))).toBe(false);
  });

  it('should redact the same environment value from the persisted pulumi.log transcript', async () => {
    const remoteFileStore = makeRemoteFileStoreWithSecretEnv();
    const workspace = makeWorkspace(async (opts) => {
      opts.onOutput?.(`applying RCON_PASSWORD=${SECRET_VALUE}\n`);
      return { stdout: '', stderr: '', changeSummary: { same: 1 } };
    });
    const service = makeService({ workspace, remoteFileStore });

    await collectPreviewChunks(service.preview());

    const logCall = writeFileSyncMock.mock.calls.find(
      (call): call is [string, string] => typeof call[0] === 'string' && call[0].includes('pulumi.log'),
    );
    expect(logCall?.[1]).toContain('***REDACTED***');
    expect(logCall?.[1]).not.toContain(SECRET_VALUE);
  });

  it('should not redact environment values shorter than the minimum redactable length, to avoid false-positive redaction noise', async () => {
    const remoteFileStore = makeRemoteFileStore({
      get: vi.fn().mockResolvedValue({
        body: new TextEncoder().encode(
          JSON.stringify({
            hostedZoneName: 'example.com',
            gameServers: { minecraft: { environment: [{ name: 'EULA', value: '1' }] } },
          }),
        ),
        etag: 'etag-1',
      }),
    });
    const workspace = makeWorkspace(async (opts) => {
      opts.onOutput?.('resource count: 1 of 1\n');
      return { stdout: '', stderr: '', changeSummary: { same: 1 } };
    });
    const service = makeService({ workspace, remoteFileStore });

    const { chunks } = await collectPreviewChunks(service.preview());

    expect(chunks).toEqual([{ stream: 'stdout', line: 'resource count: 1 of 1' }]);
  });

  it('should fully redact a shorter environment value even when it is a prefix of a longer one', async () => {
    const remoteFileStore = makeRemoteFileStore({
      get: vi.fn().mockResolvedValue({
        body: new TextEncoder().encode(
          JSON.stringify({
            hostedZoneName: 'example.com',
            gameServers: {
              minecraft: {
                environment: [
                  { name: 'SHORT', value: 'sup3rSecret' },
                  { name: 'LONG', value: 'sup3rSecretValue' },
                ],
              },
            },
          }),
        ),
        etag: 'etag-1',
      }),
    });
    const workspace = makeWorkspace(async (opts) => {
      opts.onOutput?.('token=sup3rSecretValue\n');
      return { stdout: '', stderr: '', changeSummary: { same: 1 } };
    });
    const service = makeService({ workspace, remoteFileStore });

    const { chunks } = await collectPreviewChunks(service.preview());

    expect(chunks).toEqual([{ stream: 'stdout', line: 'token=***REDACTED***' }]);
  });
});

describe('PulumiService.preview structured changeSummary', () => {
  it('should return the changeSummary captured from onEvent, not derived from stdout text', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview({ create: 3, update: 1, same: 5 }));
    const service = makeService({ workspace });

    const { result } = await collectPreviewChunks(service.preview());

    expect(result?.changeSummary).toEqual({ create: 3, update: 1, same: 5 });
  });

  it('should return an empty changeSummary (not throw, not treated as no-changes) when the summary event is never observed', async () => {
    const workspace = makeWorkspace(async (opts) => {
      opts.onOutput?.('some output\n');
      // Deliberately never calls onEvent.
      return { stdout: 'some output\n', stderr: '', changeSummary: {} };
    });
    const service = makeService({ workspace });

    const { result } = await collectPreviewChunks(service.preview());

    expect(result?.changeSummary).toEqual({});
  });
});

describe('PulumiService.preview plan hash and engine version', () => {
  it('should compute planHash as sha256(artifactBytes ++ utf8(configVersionId))', async () => {
    const artifactBytes = Buffer.from(JSON.stringify({ manifest: { version: 'v3.255.0' } }));
    readFileSyncMock.mockReturnValue(artifactBytes);
    const workspace = makeWorkspace(makeHappyPathPreview());
    const remoteFileStore = makeRemoteFileStore({
      listVersions: vi.fn().mockResolvedValue([{ versionId: 'cfg-abc', lastModified: new Date() }]),
    });
    const service = makeService({ workspace, remoteFileStore });

    const { result } = await collectPreviewChunks(service.preview());

    const expectedHash = createHash('sha256')
      .update(Buffer.concat([artifactBytes, Buffer.from('cfg-abc', 'utf8')]))
      .digest('hex');
    expect(result?.planHash).toBe(expectedHash);
  });

  it('should read engineVersion from the plan artifact\'s manifest.version field, stripping the leading "v"', async () => {
    readFileSyncMock.mockReturnValue(Buffer.from(JSON.stringify({ manifest: { version: 'v3.255.0' } })));
    const workspace = makeWorkspace(makeHappyPathPreview());
    const service = makeService({ workspace });

    const { result } = await collectPreviewChunks(service.preview());

    // Normalized against `PulumiEngineService.getResolvedVersion()`'s own
    // un-prefixed shape (`SemVer.toString()` never includes a "v") so an
    // apply-time comparison against this value is a bare string equality.
    expect(result?.engineVersion).toBe('3.255.0');
  });

  it('should fail with PulumiPlanHashError (not a raw error) when the plan artifact cannot be read after a successful preview', async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const workspace = makeWorkspace(makeHappyPathPreview());
    const service = makeService({ workspace });

    await expect(collectPreviewChunks(service.preview())).rejects.toBeInstanceOf(PulumiPlanHashError);
  });
});

describe('PulumiService.preview run persistence', () => {
  it('should persist a run.json with kind "plan", the config version id, planHash, changeSummary, and engineVersion', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview({ create: 1 }));
    const service = makeService({ workspace });

    await collectPreviewChunks(service.preview());

    const call = writeFileSyncMock.mock.calls.find((c) => String(c[0]).endsWith('run.json'));
    expect(call).toBeDefined();
    const record = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(record).toMatchObject({
      runId: 'run-123',
      kind: 'plan',
      exitCode: 0,
      configVersionId: 'cfg-v1',
      changeSummary: { create: 1 },
      engineVersion: '3.255.0',
    });
    expect(record['planHash']).toEqual(expect.any(String));
  });

  it('should persist the run to RunRecordService via RunRecordPersister with a matching log path', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview());
    const runRecordPersister = makeRunRecordPersister();
    const service = makeService({ workspace, runRecordPersister });

    await collectPreviewChunks(service.preview());

    expect(runRecordPersister.persist).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-123', kind: 'plan', exitCode: 0 }),
      expect.stringContaining('pulumi.log'),
    );
  });

  it('should wrap a local run.json write failure in PulumiRunPersistError without discarding the real outcome', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview());
    const service = makeService({ workspace });
    writeFileSyncMock.mockImplementation((path: string) => {
      if (String(path).endsWith('run.json')) throw new Error('disk full');
    });

    await expect(collectPreviewChunks(service.preview())).rejects.toBeInstanceOf(PulumiRunPersistError);
  });

  it('should log an error with the failure message (not a raw error object) when the local run.json write fails', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview());
    const service = makeService({ workspace });
    writeFileSyncMock.mockImplementation((path: string) => {
      if (String(path).endsWith('run.json')) throw new Error('disk full');
    });

    await expect(collectPreviewChunks(service.preview())).rejects.toBeInstanceOf(PulumiRunPersistError);

    expect(loggerMock.error).toHaveBeenCalledWith(
      'PulumiService.writeRunRecord: failed to write run record to disk',
      expect.objectContaining({ error: expect.stringContaining('disk full') }),
    );
  });
});

describe('PulumiService.preview failure handling', () => {
  it('should throw PulumiPreviewError (wrapping the cause) when stack.preview() itself rejects', async () => {
    const cause = new Error('preview command failed');
    const workspace = makeWorkspace(async () => {
      throw cause;
    });
    const service = makeService({ workspace });

    await expect(collectPreviewChunks(service.preview())).rejects.toBeInstanceOf(PulumiPreviewError);
  });

  it('should persist a failed run record with exitCode 1 when stack.preview() rejects', async () => {
    const workspace = makeWorkspace(async () => {
      throw new Error('preview command failed');
    });
    const runRecordPersister = makeRunRecordPersister();
    const service = makeService({ workspace, runRecordPersister });

    await expect(collectPreviewChunks(service.preview())).rejects.toThrow();

    expect(runRecordPersister.persist).toHaveBeenCalledWith(
      expect.objectContaining({ exitCode: 1 }),
      expect.any(String),
    );
  });

  it('should log an error with the failure message (not a raw error object) when stack.preview() rejects', async () => {
    const cause = new Error('preview command failed');
    const workspace = makeWorkspace(async () => {
      throw cause;
    });
    const service = makeService({ workspace });

    await expect(collectPreviewChunks(service.preview())).rejects.toBeInstanceOf(PulumiPreviewError);

    expect(loggerMock.error).toHaveBeenCalledWith(
      'pulumi preview: operation failed',
      expect.objectContaining({ error: expect.stringContaining('preview command failed') }),
    );
  });
});

describe('PulumiService.preview abort handling', () => {
  /**
   * Regression test for Finding 3 (final whole-branch review): `apply()`/
   * `destroy()` already register their internal abort listener with
   * `{ once: true }` (see either method's own test file for the identical
   * test), but `previewCore` (the method `preview()` actually delegates to
   * — see that method's own TSDoc) never got this back-ported: its listener
   * was a bare anonymous `signal.addEventListener('abort', () => ...)` with
   * no options and no `removeEventListener` at all.
   */
  it('should register the internal abort listener with { once: true }', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview());
    const service = makeService({ workspace });
    const controller = new AbortController();
    const addEventListenerSpy = vi.spyOn(controller.signal, 'addEventListener');

    await collectPreviewChunks(service.preview(undefined, controller.signal));

    expect(addEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
  });

  it('should actually remove the abort listener on normal completion, not merely register it with { once: true } — a reused signal never accumulates a live listener across calls', async () => {
    // `{ once: true }` alone only detaches a listener once the signal FIRES —
    // it does nothing for the overwhelmingly common case where the signal
    // never aborts across a normal completion. This test proves the
    // listener is gone afterward (removeEventListener called with the exact
    // same handler addEventListener registered), not merely that the option
    // was passed — the exact leak Finding 3 closes.
    const workspace = makeWorkspace(makeHappyPathPreview());
    const service = makeService({ workspace });
    const controller = new AbortController();
    const addEventListenerSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await collectPreviewChunks(service.preview(undefined, controller.signal));
    const registeredHandler = addEventListenerSpy.mock.calls[0]![1];
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', registeredHandler);

    // A second call on the SAME reused signal must not accumulate a second
    // live listener either.
    addEventListenerSpy.mockClear();
    removeEventListenerSpy.mockClear();
    await collectPreviewChunks(service.preview(undefined, controller.signal));
    expect(addEventListenerSpy).toHaveBeenCalledTimes(1);
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', addEventListenerSpy.mock.calls[0]![1]);

    // Never actually aborted, so nothing should have fired.
    expect(controller.signal.aborted).toBe(false);
  });

  it('should end the generator cleanly (resolving undefined) without touching Pulumi when the signal is already aborted', async () => {
    const workspace = makeWorkspace(makeHappyPathPreview());
    const service = makeService({ workspace });
    const controller = new AbortController();
    controller.abort();

    const { chunks, result } = await collectPreviewChunks(service.preview(undefined, controller.signal));

    expect(chunks).toEqual([]);
    expect(result).toBeUndefined();
    expect(workspace.getOrCreateStack).not.toHaveBeenCalled();
  });

  it('should end the generator cleanly and persist an aborted run record when the signal aborts mid-flight', async () => {
    let rejectPreview!: (err: unknown) => void;
    const previewMock = vi.fn().mockImplementation(
      () =>
        new Promise<PreviewResult>((_resolve, reject) => {
          rejectPreview = reject;
        }),
    );
    const getOrCreateStack = vi.fn().mockResolvedValue({ preview: previewMock } as Partial<Stack> as Stack);
    const workspace = { getOrCreateStack } as unknown as PulumiWorkspaceService;
    const runRecordPersister = makeRunRecordPersister();
    const service = makeService({ workspace, runRecordPersister });
    const controller = new AbortController();

    const gen = service.preview(undefined, controller.signal);
    const first = gen.next();

    // Let the generator reach the point where stack.preview() has actually
    // been invoked and its returned promise is pending — several real
    // `await`s (listVersions, get, getOrCreateStack) separate the start of
    // the generator from that point, each its own microtask hop.
    for (let i = 0; i < 10 && previewMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(previewMock).toHaveBeenCalled();

    controller.abort();
    // The SDK's own `SIGINT` handling would eventually reject the in-flight
    // call — simulate that here, mirroring what `runWithEscalatingCancellation`
    // classifies as `PulumiOperationAbortedError` once `abortRequested` is set.
    rejectPreview(new Error('killed by SIGINT'));

    const next = await first;
    expect(next.done).toBe(true);
    expect(next.value).toBeUndefined();

    expect(runRecordPersister.persist).toHaveBeenCalledWith(
      expect.objectContaining({ exitCode: null }),
      expect.any(String),
    );
  });

  it('should abort the in-flight stack.preview() call and await its settlement before releasing the concurrency guard when the generator is force-closed', async () => {
    // Regression coverage for a force-closed generator: it must not report
    // itself finished while the
    // underlying operation is still genuinely running). Crucially — like
    // that test — the generator must first be driven to an actual `yield`
    // suspension point before `.return()` is called: an async generator
    // mid-`await` (not mid-`yield`, e.g. still inside the config-fetch/
    // workspace-construction awaits, or blocked on the internal
    // queue-drain wait with nothing queued yet) queues a `.return()`
    // request rather than processing it immediately, so calling `.return()`
    // too early would never actually exercise the force-close path this
    // test exists to cover.
    let capturedSignal: AbortSignal | undefined;
    let rejectPreview!: (err: unknown) => void;
    const previewMock = vi.fn().mockImplementation((opts: PreviewOptions) => {
      capturedSignal = opts.signal;
      // Emit one output line synchronously so the drain loop has something
      // to yield immediately — this is what lets the generator reach its
      // first genuine `yield` suspension point.
      opts.onOutput?.('Previewing update...\n');
      // Deliberately does NOT auto-reject when `opts.signal` aborts (unlike
      // the "aborts mid-flight" test above) — this test controls exactly
      // when the underlying promise settles (via the later, explicit
      // `rejectPreview` call) specifically to prove `preview()` genuinely
      // AWAITS that settlement in its outer `finally` rather than resolving
      // its own forced return the instant it calls `internalController.abort()`.
      return new Promise<PreviewResult>((_resolve, reject) => {
        rejectPreview = reject;
      });
    });
    const getOrCreateStack = vi.fn().mockResolvedValue({ preview: previewMock } as Partial<Stack> as Stack);
    const workspace = { getOrCreateStack } as unknown as PulumiWorkspaceService;
    const service = makeService({ workspace });

    const gen = service.preview();
    // Drive the generator to its first yielded chunk — by the time this
    // resolves, `stack.preview()` has been called and its returned promise
    // is genuinely pending.
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ stream: 'stdout', line: 'Previewing update...' });
    expect(previewMock).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);

    // Force-close the generator (consumer `break`/`.return()`/`.throw()`)
    // while `stack.preview()` is still genuinely pending — no signal was
    // ever passed to `preview()` itself, so the ONLY way this can be
    // cancelled at all is the internal controller the outer `finally` owns.
    let returnSettled = false;
    const returnPromise = gen.return(undefined).then((result) => {
      returnSettled = true;
      return result;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    // The internal signal must have been aborted and forwarded into the
    // exact signal `stack.preview()` was called with.
    expect(capturedSignal?.aborted).toBe(true);
    // The generator's forced return must NOT resolve until the in-flight
    // operation has actually settled — this is the whole point of the fix:
    // releasing the concurrency guard before this would let a second
    // `preview()`/`up()`/`destroy()` call start against the same workspace
    // while the first is still live.
    expect(returnSettled).toBe(false);

    rejectPreview(new Error('killed by SIGINT'));
    const result = await returnPromise;

    expect(returnSettled).toBe(true);
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();

    // The concurrency guard must be released by now — a second `.next()`
    // call on the SAME service instance must not reject with the
    // "already running" error. (It's expected to never fully settle in
    // this test — this test's `previewMock` returns a fresh pending
    // promise on every call and nothing here ever resolves it — so this
    // only asserts it doesn't reject *synchronously with the guard error*
    // within one macrotask, not that it completes.)
    let secondRejection: unknown;
    service
      .preview()
      .next()
      .catch((err: unknown) => {
        secondRejection = err;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondRejection).toBeUndefined();
  });
});

describe('PulumiService.preview leaked-promise recovery', () => {
  it('should recover a leaked-promise rejection as a success, using the changeSummary already captured via onEvent', async () => {
    const workspace = makeWorkspace(async (opts) => {
      opts.onOutput?.('Previewing update...\n');
      const event: EngineEvent = {
        sequence: 1,
        timestamp: Math.floor(Date.now() / 1000),
        summaryEvent: { maybeCorrupt: false, durationSeconds: 1, resourceChanges: { create: 1 }, policyPacks: {} },
      };
      opts.onEvent?.(event);
      throw new Error(
        'The Pulumi runtime detected that 1 promises were still active when the process exited',
      );
    });
    const service = makeService({ workspace });

    const { result } = await collectPreviewChunks(service.preview());

    expect(result?.changeSummary).toEqual({ create: 1 });
    expect(result?.planHash).toEqual(expect.any(String));
  });
});
