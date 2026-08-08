/**
 * Tests for `RunRecordService` — the write/read facade over the
 * cloud-agnostic `RunRecordStore` (a stub here; the real `AwsRunRecordStore`
 * has its own tests under `@hyveon/cloud-aws`). Covers the inline-vs-offload
 * log decision, the missing-table no-op, the swallow-on-error persistence
 * contract, the `getLogUrl` delegation, and (issue #106) that `persist()`
 * always releases the apply lock for its `runId` via the injected
 * `RunService`, regardless of which persistence path is taken.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteFileStore, RunRecord, RunRecordStore, StackOutputs } from '@hyveon/shared';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../logger.js', () => ({ logger: loggerMock }));

import {
  INLINE_LOG_LIMIT_BYTES,
  RunRecordNotFoundError,
  RunRecordNotPlanError,
  RunRecordNotSuccessfulError,
  RunRecordService,
  RunRecordTableNotConfiguredError,
  type PersistRunRecordParams,
} from './RunRecordService.js';
import { ConfigService } from './ConfigService.js';
import { RunService } from './RunService.js';

/** Minimal `StackOutputs` stub exposing just `runsTableName`. */
const STACK_OUTPUTS: StackOutputs = {
  awsRegion: 'us-east-1',
  ecsClusterName: '',
  ecsClusterArn: '',
  subnetIds: [],
  securityGroupId: '',
  fileManagerSecurityGroupId: '',
  efsFileSystemId: '',
  efsAccessPoints: {},
  domainName: '',
  gameNames: [],
  discordTableName: '',
  auditTableName: '',
  runsTableName: 'test-runs',
  discordBotTokenSecretArn: '',
  discordPublicKeySecretArn: '',
  fileBrowserCredentialSecretArn: '',
  fileBrowserSchedulerRoleArn: '',
  interactionsInvokeUrl: null,
  discordInteractionsUrl: null,
  appliedGameServers: null,
};

const putRecordMock = vi.fn<RunRecordStore['putRecord']>();
const putLogMock = vi.fn<RunRecordStore['putLog']>();
const getLogUrlMock = vi.fn<RunRecordStore['getLogUrl']>();
const getRecordByRunIdMock = vi.fn<RunRecordStore['getRecordByRunId']>();
const listRunsMock = vi.fn<RunRecordStore['listRuns']>();
const releaseRunMock = vi.fn<RunService['releaseRun']>();

/** Builds a `RunRecordStore`-shaped stub backed by the shared mocks above; the lock methods are unused no-ops here since `RunRecordService`'s lock release goes through the injected `RunService`, not the store directly. */
function makeStore(): RunRecordStore {
  return {
    putRecord: putRecordMock,
    getRecordByRunId: getRecordByRunIdMock,
    listRuns: listRunsMock,
    putLog: putLogMock,
    getLogUrl: getLogUrlMock,
    acquireRunLock: vi.fn<RunRecordStore['acquireRunLock']>(),
    getRunLock: vi.fn<RunRecordStore['getRunLock']>(),
    releaseRunLock: vi.fn<RunRecordStore['releaseRunLock']>(),
  };
}

/** Builds a sample successful `plan` {@link RunRecord}, overridable per-test. */
function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    sk: '2026-07-17T00:00:00.000Z#run-123',
    runId: 'run-123',
    kind: 'plan',
    status: 'success',
    startedAt: '2026-07-17T00:00:00.000Z',
    completedAt: '2026-07-17T00:05:00.000Z',
    exitCode: 0,
    ...overrides,
  };
}

/** Builds a `RunService`-shaped stub exposing just `releaseRun`, backed by the shared mock above. */
function makeRunService(): RunService {
  return { releaseRun: releaseRunMock } as Partial<RunService> as RunService;
}

/**
 * Builds a `RemoteFileStore` stub whose `get()` resolves to a
 * `DeploymentConfig`-shaped JSON body built from `config` (or `undefined` —
 * the default — simulating no configuration object persisted yet, mirroring
 * every pre-existing "runs_table_name not configured" test's assumption that
 * the pre-apply fallback also has nothing to resolve). Used to prove
 * `RunRecordService`'s bootstrap-deadlock fallback: when
 * `ConfigService.getStackOutputs()` has no `runsTableName` (no apply has
 * ever succeeded), this is the ONLY source `resolveRunsTableName()` can pull
 * a table name from.
 */
function makeRemoteFileStore(config?: { projectName?: string; runsTableName?: string }): RemoteFileStore {
  return {
    get: async () =>
      config === undefined ? undefined : { body: new TextEncoder().encode(JSON.stringify(config)), etag: 'etag-1' },
    getVersion: () => Promise.reject(new Error('not implemented in fake')),
    put: () => Promise.reject(new Error('not implemented in fake')),
    listVersions: () => Promise.reject(new Error('not implemented in fake')),
  };
}

/** Builds a `RunRecordService` with a `ConfigService` stub returning `outputs` and the given (or default) store/run-service/remote-file-store stubs. */
function makeService(
  outputs: StackOutputs | null = STACK_OUTPUTS,
  store: RunRecordStore = makeStore(),
  runService: RunService = makeRunService(),
  remoteFileStore: RemoteFileStore = makeRemoteFileStore(),
): RunRecordService {
  const config = { getStackOutputs: async () => outputs } as Partial<ConfigService> as ConfigService;
  return new RunRecordService(config, store, runService, remoteFileStore);
}

/** Builds a sample {@link PersistRunRecordParams}, overridable per-test. */
function makeParams(overrides: Partial<PersistRunRecordParams> = {}): PersistRunRecordParams {
  return {
    runId: 'run-123',
    kind: 'apply',
    startedAt: '2026-07-17T00:00:00.000Z',
    completedAt: '2026-07-17T00:05:00.000Z',
    exitCode: 0,
    ...overrides,
  };
}

let workDir: string;

/** Writes `contents` to a fresh temp file under `workDir` and returns its absolute path. */
function writeLogFile(contents: string): string {
  const path = join(workDir, `run.log`);
  writeFileSync(path, contents, 'utf8');
  return path;
}

beforeEach(() => {
  putRecordMock.mockReset();
  putLogMock.mockReset();
  getLogUrlMock.mockReset();
  getRecordByRunIdMock.mockReset();
  listRunsMock.mockReset();
  releaseRunMock.mockReset();
  releaseRunMock.mockResolvedValue(undefined);
  loggerMock.debug.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
  workDir = mkdtempSync(join(tmpdir(), 'run-record-service-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('RunRecordService', () => {
  describe('persist', () => {
    it('should embed a small log directly on the record and never call store.putLog', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();
      const smallLog = 'pulumi preview output\nResources: 1 to create, 0 unchanged, 0 to delete.';

      await service.persist(makeParams(), writeLogFile(smallLog));

      expect(putLogMock).not.toHaveBeenCalled();
      expect(putRecordMock).toHaveBeenCalledTimes(1);
      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record.logInline).toBe(smallLog);
    });

    it('should offload a log larger than the inline threshold to the store and record the returned key on logS3Key, not log', async () => {
      putRecordMock.mockResolvedValue(undefined);
      putLogMock.mockResolvedValue('runs/run-123.log');
      const service = makeService();
      const oversizedLog = 'x'.repeat(INLINE_LOG_LIMIT_BYTES + 1);

      await service.persist(makeParams(), writeLogFile(oversizedLog));

      expect(putLogMock).toHaveBeenCalledTimes(1);
      const [runId, body] = putLogMock.mock.calls[0]!;
      expect(runId).toBe('run-123');
      expect(new TextDecoder().decode(body)).toBe(oversizedLog);

      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record.logS3Key).toBe('runs/run-123.log');
      expect(record).not.toHaveProperty('logInline');
    });

    it('should embed a log exactly at the inline threshold without offloading', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();
      const exactLog = 'x'.repeat(INLINE_LOG_LIMIT_BYTES);

      await service.persist(makeParams(), writeLogFile(exactLog));

      expect(putLogMock).not.toHaveBeenCalled();
      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record.logInline).toBe(exactLog);
      expect(record).not.toHaveProperty('logS3Key');
    });

    it('should omit both log attributes entirely when no log was captured', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.persist(makeParams(), null);

      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record).not.toHaveProperty('logInline');
      expect(record).not.toHaveProperty('logS3Key');
    });

    it('should persist without a log when the captured log file cannot be read', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();
      const missingLogPath = join(workDir, 'does-not-exist.log');

      await service.persist(makeParams(), missingLogPath);

      expect(putLogMock).not.toHaveBeenCalled();
      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record).not.toHaveProperty('logInline');
      expect(record).not.toHaveProperty('logS3Key');
    });

    it('should carry changeSummary, engineVersion, and partialApply onto the record when provided', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();
      const changeSummary = { create: 1, update: 0, delete: 0, same: 2 };

      await service.persist(
        makeParams({ changeSummary, engineVersion: '3.255.0', partialApply: true }),
        null,
      );

      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record.changeSummary).toEqual(changeSummary);
      expect(record.engineVersion).toBe('3.255.0');
      expect(record.partialApply).toBe(true);
    });

    it('should build the record sk from startedAt and runId, and derive status from exitCode', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.persist(makeParams({ exitCode: 1 }), null);

      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record.sk).toBe('2026-07-17T00:00:00.000Z#run-123');
      expect(record.status).toBe('failed');
    });

    it('should derive an aborted status when exitCode is null', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.persist(makeParams({ exitCode: null }), null);

      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record.status).toBe('aborted');
    });

    it('should include configVersionId on the record when present on params', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.persist(makeParams({ configVersionId: 'v-1' }), null);

      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record.configVersionId).toBe('v-1');
    });

    it('should include planHash on the record when present on params', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.persist(makeParams({ planHash: 'a'.repeat(64) }), null);

      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record.planHash).toBe('a'.repeat(64));
    });

    it('should omit planHash from the record when absent from params', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.persist(makeParams(), null);

      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record).not.toHaveProperty('planHash');
    });

    it('should include rolledBackFrom on the record when present on params', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.persist(makeParams({ rolledBackFrom: 'apply-run-1' }), null);

      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record.rolledBackFrom).toBe('apply-run-1');
    });

    it('should omit rolledBackFrom from the record when absent from params', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.persist(makeParams(), null);

      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record).not.toHaveProperty('rolledBackFrom');
    });

    it('should swallow a store.putRecord failure and log a warning instead of throwing', async () => {
      putRecordMock.mockRejectedValue(new Error('DynamoDB is down'));
      const service = makeService();

      await expect(service.persist(makeParams(), null)).resolves.toBeUndefined();

      expect(putRecordMock).toHaveBeenCalledTimes(1);
    });

    it('should persist the record without a log when store.putLog rejects, rather than aborting the whole write', async () => {
      putRecordMock.mockResolvedValue(undefined);
      putLogMock.mockRejectedValue(new Error('S3 is down'));
      const service = makeService();
      const oversizedLog = 'x'.repeat(INLINE_LOG_LIMIT_BYTES + 1);

      await expect(service.persist(makeParams(), writeLogFile(oversizedLog))).resolves.toBeUndefined();

      expect(putLogMock).toHaveBeenCalledTimes(1);
      expect(putRecordMock).toHaveBeenCalledTimes(1);
      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record).not.toHaveProperty('logInline');
      expect(record).not.toHaveProperty('logS3Key');
    });

    it('should persist the record without a log when the oversized log cannot be offloaded because no remote file store is configured', async () => {
      putRecordMock.mockResolvedValue(undefined);
      putLogMock.mockRejectedValue(new Error('remote file store not configured: no bucket'));
      const service = makeService();
      const oversizedLog = 'x'.repeat(INLINE_LOG_LIMIT_BYTES + 1);

      await expect(service.persist(makeParams(), writeLogFile(oversizedLog))).resolves.toBeUndefined();

      expect(putLogMock).toHaveBeenCalledTimes(1);
      expect(putRecordMock).toHaveBeenCalledTimes(1);
      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record).not.toHaveProperty('logInline');
      expect(record).not.toHaveProperty('logS3Key');
    });

    it('should skip persistence entirely and log a warning when runs_table_name is not configured', async () => {
      const service = makeService(null);

      await expect(service.persist(makeParams(), writeLogFile('some log text'))).resolves.toBeUndefined();

      expect(putRecordMock).not.toHaveBeenCalled();
      expect(putLogMock).not.toHaveBeenCalled();
    });

    it('should release the apply lock for the run after a successful persist', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.persist(makeParams({ runId: 'run-abc' }), null);

      expect(releaseRunMock).toHaveBeenCalledTimes(1);
      expect(releaseRunMock).toHaveBeenCalledWith('run-abc');
    });

    it('should release the apply lock even when runs_table_name is not configured and persistence is skipped', async () => {
      const service = makeService(null);

      await service.persist(makeParams({ runId: 'run-no-table' }), null);

      expect(putRecordMock).not.toHaveBeenCalled();
      expect(releaseRunMock).toHaveBeenCalledTimes(1);
      expect(releaseRunMock).toHaveBeenCalledWith('run-no-table');
    });

    it('should release the apply lock even when store.putRecord fails', async () => {
      putRecordMock.mockRejectedValue(new Error('DynamoDB is down'));
      const service = makeService();

      await service.persist(makeParams({ runId: 'run-failed-record' }), null);

      expect(releaseRunMock).toHaveBeenCalledTimes(1);
      expect(releaseRunMock).toHaveBeenCalledWith('run-failed-record');
    });

    it('should release the apply lock even when the log offload fails', async () => {
      putRecordMock.mockResolvedValue(undefined);
      putLogMock.mockRejectedValue(new Error('S3 is down'));
      const service = makeService();
      const oversizedLog = 'x'.repeat(INLINE_LOG_LIMIT_BYTES + 1);

      await service.persist(makeParams({ runId: 'run-failed-log' }), writeLogFile(oversizedLog));

      expect(releaseRunMock).toHaveBeenCalledTimes(1);
      expect(releaseRunMock).toHaveBeenCalledWith('run-failed-log');
    });
  });

  describe('writePreflightMarker', () => {
    it('should write a durable kind:"apply", partialApply:true, status:"aborted" marker via store.putRecord', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.writePreflightMarker({ runId: 'run-123', startedAt: '2026-07-17T00:00:00.000Z' });

      expect(putRecordMock).toHaveBeenCalledTimes(1);
      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record.kind).toBe('apply');
      expect(record.partialApply).toBe(true);
      expect(record.status).toBe('aborted');
      expect(record.exitCode).toBeNull();
    });

    it('should build sk from startedAt and runId, and set completedAt equal to startedAt', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.writePreflightMarker({ runId: 'run-123', startedAt: '2026-07-17T00:00:00.000Z' });

      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record.sk).toBe('2026-07-17T00:00:00.000Z#run-123');
      expect(record.startedAt).toBe('2026-07-17T00:00:00.000Z');
      expect(record.completedAt).toBe('2026-07-17T00:00:00.000Z');
    });

    it('should carry configVersionId, planHash, and engineVersion onto the record when provided', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.writePreflightMarker({
        runId: 'run-123',
        startedAt: '2026-07-17T00:00:00.000Z',
        configVersionId: 'v-1',
        planHash: 'a'.repeat(64),
        engineVersion: '3.255.0',
      });

      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record.configVersionId).toBe('v-1');
      expect(record.planHash).toBe('a'.repeat(64));
      expect(record.engineVersion).toBe('3.255.0');
    });

    it('should omit configVersionId, planHash, and engineVersion from the record when absent from params', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.writePreflightMarker({ runId: 'run-123', startedAt: '2026-07-17T00:00:00.000Z' });

      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record).not.toHaveProperty('configVersionId');
      expect(record).not.toHaveProperty('planHash');
      expect(record).not.toHaveProperty('engineVersion');
    });

    it('should propagate a store.putRecord failure rather than swallowing it', async () => {
      putRecordMock.mockRejectedValue(new Error('DynamoDB is down'));
      const service = makeService();

      await expect(
        service.writePreflightMarker({ runId: 'run-123', startedAt: '2026-07-17T00:00:00.000Z' }),
      ).rejects.toThrow('DynamoDB is down');
    });

    it('should log an error with the failure message (not a raw error object) when store.putRecord fails', async () => {
      putRecordMock.mockRejectedValue(new Error('DynamoDB is down'));
      const service = makeService();

      await expect(
        service.writePreflightMarker({ runId: 'run-123', startedAt: '2026-07-17T00:00:00.000Z' }),
      ).rejects.toThrow();

      expect(loggerMock.error).toHaveBeenCalledWith(
        'RunRecordService.writePreflightMarker: failed to write pre-flight marker',
        expect.objectContaining({ runId: 'run-123', error: 'DynamoDB is down' }),
      );
    });

    it('should throw, rather than silently no-op, when runs_table_name is not configured', async () => {
      const service = makeService(null, undefined, undefined, makeRemoteFileStore(undefined));

      await expect(
        service.writePreflightMarker({ runId: 'run-123', startedAt: '2026-07-17T00:00:00.000Z' }),
      ).rejects.toThrow(/runs_table_name not configured/);
      expect(putRecordMock).not.toHaveBeenCalled();
    });

    it('should NOT release the apply lock — unlike persist(), this write happens while the lock must remain held', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.writePreflightMarker({ runId: 'run-still-locked', startedAt: '2026-07-17T00:00:00.000Z' });

      expect(releaseRunMock).not.toHaveBeenCalled();
    });
  });

  describe('getLogUrl', () => {
    it("should return the store's presigned URL for a given log key", async () => {
      getLogUrlMock.mockResolvedValue('https://example.com/signed');
      const service = makeService();

      const url = await service.getLogUrl('runs/run-123.log');

      expect(url).toBe('https://example.com/signed');
      expect(getLogUrlMock).toHaveBeenCalledWith('runs/run-123.log', undefined);
    });

    it('should pass a custom expiresInSeconds through to the store', async () => {
      getLogUrlMock.mockResolvedValue('https://example.com/signed');
      const service = makeService();

      await service.getLogUrl('runs/run-123.log', 60);

      expect(getLogUrlMock).toHaveBeenCalledWith('runs/run-123.log', 60);
    });

    it('should log an error and rethrow (not swallow) when store.getLogUrl fails', async () => {
      getLogUrlMock.mockRejectedValue(new Error('presign failed'));
      const service = makeService();

      await expect(service.getLogUrl('runs/run-123.log')).rejects.toThrow('presign failed');

      expect(loggerMock.error).toHaveBeenCalledWith(
        'RunRecordService.getLogUrl: failed to resolve run log URL',
        expect.objectContaining({ logKey: 'runs/run-123.log', error: 'presign failed' }),
      );
    });
  });

  describe('getByRunId', () => {
    it("should return the store's matching record for a known runId", async () => {
      const record = makeRecord();
      getRecordByRunIdMock.mockResolvedValue(record);
      const service = makeService();

      const result = await service.getByRunId('run-123');

      expect(result).toBe(record);
      expect(getRecordByRunIdMock).toHaveBeenCalledWith('run-123');
    });

    it('should return undefined when no record exists for the runId', async () => {
      getRecordByRunIdMock.mockResolvedValue(undefined);
      const service = makeService();

      const result = await service.getByRunId('missing-run');

      expect(result).toBeUndefined();
    });

    it('should return undefined and not call store.getRecordByRunId when runs_table_name is not configured', async () => {
      const service = makeService(null);

      const result = await service.getByRunId('run-123');

      expect(result).toBeUndefined();
      expect(getRecordByRunIdMock).not.toHaveBeenCalled();
    });

    it('should log an error and rethrow (not swallow) when store.getRecordByRunId fails', async () => {
      getRecordByRunIdMock.mockRejectedValue(new Error('DynamoDB is down'));
      const service = makeService();

      await expect(service.getByRunId('run-123')).rejects.toThrow('DynamoDB is down');

      expect(loggerMock.error).toHaveBeenCalledWith(
        'RunRecordService.getByRunId: failed to look up run record',
        expect.objectContaining({ runId: 'run-123', error: 'DynamoDB is down' }),
      );
    });
  });

  describe('listRuns', () => {
    it("should delegate to the store's listRuns with a default-clamped limit when opts is omitted", async () => {
      listRunsMock.mockResolvedValue({ records: [] });
      const service = makeService();

      const result = await service.listRuns();

      expect(result).toEqual({ records: [] });
      expect(listRunsMock).toHaveBeenCalledWith({ limit: 25 });
    });

    it('should pass through a valid limit, before cursor, and status filter', async () => {
      listRunsMock.mockResolvedValue({ records: [] });
      const service = makeService();

      await service.listRuns({ limit: 10, before: '2026-07-17T00:00:00.000Z#run-123', status: 'failed' });

      expect(listRunsMock).toHaveBeenCalledWith({
        limit: 10,
        before: '2026-07-17T00:00:00.000Z#run-123',
        status: 'failed',
      });
    });

    it('should clamp a requested limit above the maximum down to 100', async () => {
      listRunsMock.mockResolvedValue({ records: [] });
      const service = makeService();

      await service.listRuns({ limit: 1000 });

      expect(listRunsMock).toHaveBeenCalledWith({ limit: 100 });
    });

    it('should fall back to the default limit for a non-positive limit', async () => {
      listRunsMock.mockResolvedValue({ records: [] });
      const service = makeService();

      await service.listRuns({ limit: -5 });

      expect(listRunsMock).toHaveBeenCalledWith({ limit: 25 });
    });

    it('should return the page resolved by the store', async () => {
      const record = makeRecord();
      listRunsMock.mockResolvedValue({ records: [record], nextBefore: record.sk });
      const service = makeService();

      const result = await service.listRuns({ limit: 20 });

      expect(result).toEqual({ records: [record], nextBefore: record.sk });
    });

    it('should return an empty page and not call store.listRuns when runs_table_name is not configured', async () => {
      const service = makeService(null);

      const result = await service.listRuns({ limit: 20 });

      expect(result).toEqual({ records: [] });
      expect(listRunsMock).not.toHaveBeenCalled();
    });

    it('should log an error and rethrow (not swallow) when store.listRuns fails', async () => {
      listRunsMock.mockRejectedValue(new Error('DynamoDB is down'));
      const service = makeService();

      await expect(service.listRuns()).rejects.toThrow('DynamoDB is down');

      expect(loggerMock.error).toHaveBeenCalledWith(
        'RunRecordService.listRuns: failed to list run history',
        expect.objectContaining({ error: 'DynamoDB is down' }),
      );
    });
  });

  describe('approveRun', () => {
    it('should persist approvedBy/approvedAt via putRecord and return the updated record for a successful plan run', async () => {
      const record = makeRecord();
      getRecordByRunIdMock.mockResolvedValue(record);
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      const result = await service.approveRun('run-123', 'alice');

      expect(putRecordMock).toHaveBeenCalledTimes(1);
      const persisted = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(persisted.approvedBy).toBe('alice');
      expect(typeof persisted.approvedAt).toBe('string');
      expect(result).toEqual(persisted);
    });

    it('should reject with RunRecordTableNotConfiguredError when runs_table_name is not configured', async () => {
      const service = makeService(null);

      await expect(service.approveRun('run-123', 'alice')).rejects.toThrow(RunRecordTableNotConfiguredError);
      expect(getRecordByRunIdMock).not.toHaveBeenCalled();
      expect(putRecordMock).not.toHaveBeenCalled();
    });

    it('should reject with RunRecordNotFoundError when no record exists for the runId', async () => {
      getRecordByRunIdMock.mockResolvedValue(undefined);
      const service = makeService();

      await expect(service.approveRun('missing-run', 'alice')).rejects.toThrow(RunRecordNotFoundError);
      expect(putRecordMock).not.toHaveBeenCalled();
    });

    it('should reject with RunRecordNotPlanError when the record is not a plan run', async () => {
      getRecordByRunIdMock.mockResolvedValue(makeRecord({ kind: 'apply' }));
      const service = makeService();

      await expect(service.approveRun('run-123', 'alice')).rejects.toThrow(RunRecordNotPlanError);
      expect(putRecordMock).not.toHaveBeenCalled();
    });

    it('should reject with RunRecordNotSuccessfulError when the plan run did not succeed', async () => {
      getRecordByRunIdMock.mockResolvedValue(makeRecord({ status: 'failed', exitCode: 1 }));
      const service = makeService();

      await expect(service.approveRun('run-123', 'alice')).rejects.toThrow(RunRecordNotSuccessfulError);
      expect(putRecordMock).not.toHaveBeenCalled();
    });

    it('should log an error and rethrow (not swallow) when store.getRecordByRunId fails', async () => {
      getRecordByRunIdMock.mockRejectedValue(new Error('DynamoDB is down'));
      const service = makeService();

      await expect(service.approveRun('run-123', 'alice')).rejects.toThrow('DynamoDB is down');

      expect(loggerMock.error).toHaveBeenCalledWith(
        'RunRecordService.approveRun: failed to look up run record',
        expect.objectContaining({ runId: 'run-123', error: 'DynamoDB is down' }),
      );
      expect(putRecordMock).not.toHaveBeenCalled();
    });

    it('should log an error and rethrow (not swallow) when store.putRecord fails while persisting the approval', async () => {
      const record = makeRecord();
      getRecordByRunIdMock.mockResolvedValue(record);
      putRecordMock.mockRejectedValue(new Error('DynamoDB is down'));
      const service = makeService();

      await expect(service.approveRun('run-123', 'alice')).rejects.toThrow('DynamoDB is down');

      expect(loggerMock.error).toHaveBeenCalledWith(
        'RunRecordService.approveRun: failed to persist run approval',
        expect.objectContaining({ runId: 'run-123', error: 'DynamoDB is down' }),
      );
    });
  });

  /**
   * Proves the specific bootstrap-deadlock sequence the final-review
   * Critical finding described is now fixed: a fresh install has no Pulumi
   * stack outputs yet (no apply has EVER succeeded — `getStackOutputs()`
   * resolves `null`, exactly like `PulumiService.getStackOutputs()`'s own
   * "empty outputs degrades to null" contract), so every one of these tests
   * uses `makeService(null, ...)`. What used to be an unconditional dead end
   * (`RunRecordTableNotConfiguredError`/skipped persistence/`undefined`,
   * regardless of anything else) now succeeds once a `DeploymentConfig` has
   * been persisted — which happens BEFORE the runs table is even reachable
   * via a completed apply, since `BootstrapService.ensureRunsTable` creates
   * it via the AWS SDK at wizard-bootstrap time, well before any Pulumi
   * apply ever runs.
   *
   * Honest scope note: this is a focused unit test on `RunRecordService`
   * directly (per the fix brief's option B — a DI-seam stub can't
   * realistically model "a real Pulumi apply never ran, but the AWS SDK
   * already created a real DynamoDB table," since the Pulumi engine itself
   * is unavailable in this test tier). It proves the SERVICE-LAYER gates
   * (`persist`/`getByRunId`/`listRuns`/`approveRun`) resolve a real table
   * name and proceed instead of dead-ending — it does NOT exercise a real
   * DynamoDB table, a real `BootstrapService.ensureRunsTable` AWS SDK call,
   * or the real Pulumi Automation API. `BootstrapService.test.ts` covers
   * `ensureRunsTable` itself (mocked AWS SDK) and
   * `cloud-provider.module.test.ts` covers `resolveRunRecordStoreConfig`'s
   * identical fallback for the `AwsRunRecordStore` construction path — this
   * describe block is the third leg proving the gates that were the
   * ORIGINAL deadlock (`RunRecordTableNotConfiguredError`,
   * `PulumiPlanRunNotFoundError`'s precondition) no longer trip.
   */
  describe('pre-apply runsTableName fallback (bootstrap-deadlock fix)', () => {
    it('should skip persistence when neither a stack output nor a persisted DeploymentConfig has a runs table name yet (the true pre-bootstrap state)', async () => {
      const service = makeService(null, undefined, undefined, makeRemoteFileStore(undefined));

      await expect(service.persist(makeParams(), null)).resolves.toBeUndefined();

      expect(putRecordMock).not.toHaveBeenCalled();
    });

    it('should persist via the resolved deterministic table name once a DeploymentConfig exists, even though no Pulumi apply has ever succeeded', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const remoteFileStore = makeRemoteFileStore({ projectName: 'hyveon', runsTableName: '' });
      const service = makeService(null, undefined, undefined, remoteFileStore);

      await service.persist(makeParams(), null);

      // The write went through — the fallback resolved SOME table name
      // rather than short-circuiting to the "not configured" no-op.
      expect(putRecordMock).toHaveBeenCalledTimes(1);
    });

    it('should look up a previously persisted record via getByRunId using the pre-apply fallback table name', async () => {
      const record = makeRecord();
      getRecordByRunIdMock.mockResolvedValue(record);
      const remoteFileStore = makeRemoteFileStore({ projectName: 'hyveon', runsTableName: '' });
      const service = makeService(null, undefined, undefined, remoteFileStore);

      const result = await service.getByRunId('run-123');

      expect(result).toBe(record);
      expect(getRecordByRunIdMock).toHaveBeenCalledWith('run-123');
    });

    it('should list runs using the pre-apply fallback table name instead of returning an empty page', async () => {
      listRunsMock.mockResolvedValue({ records: [] });
      const remoteFileStore = makeRemoteFileStore({ projectName: 'hyveon', runsTableName: '' });
      const service = makeService(null, undefined, undefined, remoteFileStore);

      await service.listRuns();

      expect(listRunsMock).toHaveBeenCalledWith({ limit: 25 });
    });

    it('should approve a plan run using the pre-apply fallback table name instead of throwing RunRecordTableNotConfiguredError — the exact gate the bootstrap deadlock tripped', async () => {
      const record = makeRecord();
      getRecordByRunIdMock.mockResolvedValue(record);
      putRecordMock.mockResolvedValue(undefined);
      const remoteFileStore = makeRemoteFileStore({ projectName: 'hyveon', runsTableName: '' });
      const service = makeService(null, undefined, undefined, remoteFileStore);

      const result = await service.approveRun('run-123', 'alice');

      expect(putRecordMock).toHaveBeenCalledTimes(1);
      const persisted = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(persisted.approvedBy).toBe('alice');
      expect(result).toEqual(persisted);
    });

    it('should demonstrate the full deadlock-to-fixed sequence: persist skips before bootstrap, then succeeds and approves after bootstrap — with no Pulumi apply ever having run in between', async () => {
      // Step 1: a genuinely fresh install — no stack outputs, no
      // DeploymentConfig persisted yet (the wizard's bootstrap step, which
      // creates the runs table AND lets the operator configure game servers,
      // hasn't been reached). This is the true pre-bootstrap state.
      const beforeBootstrap = makeService(null, undefined, undefined, makeRemoteFileStore(undefined));
      await expect(beforeBootstrap.persist(makeParams({ runId: 'run-before' }), null)).resolves.toBeUndefined();
      expect(putRecordMock).not.toHaveBeenCalled();

      // Step 2: "bootstrap" has now run (BootstrapService.ensureRunsTable
      // created the table; the operator has since configured game servers,
      // persisting a DeploymentConfig) — but STILL no Pulumi apply has ever
      // succeeded, so getStackOutputs() is still null.
      putRecordMock.mockResolvedValue(undefined);
      const afterBootstrap = makeService(
        null,
        undefined,
        undefined,
        makeRemoteFileStore({ projectName: 'hyveon', runsTableName: '' }),
      );

      // Plan's record can now be persisted...
      await afterBootstrap.persist(makeParams({ runId: 'run-after', kind: 'plan' }), null);
      expect(putRecordMock).toHaveBeenCalledTimes(1);

      // ...and approved — the exact gate `RunRecordService.approveRun`
      // (and, transitively, `PulumiService.apply`'s own gate via
      // `getRunRecordPersister().getByRunId`) used to dead-end on forever.
      getRecordByRunIdMock.mockResolvedValue(makeRecord({ runId: 'run-after', kind: 'plan', status: 'success' }));
      const approved = await afterBootstrap.approveRun('run-after', 'alice');
      expect(approved.approvedBy).toBe('alice');
    });
  });
});
