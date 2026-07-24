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
import type { RunRecord, RunRecordStore } from '@hyveon/shared';
import {
  INLINE_LOG_LIMIT_BYTES,
  RunRecordNotFoundError,
  RunRecordNotPlanError,
  RunRecordNotSuccessfulError,
  RunRecordService,
  RunRecordTableNotConfiguredError,
  type PersistRunRecordParams,
} from './RunRecordService.js';
import { ConfigService, type TfOutputs } from './ConfigService.js';
import { RunService } from './RunService.js';

/** Minimal `TfOutputs` stub exposing just `runs_table_name`. */
const TF: TfOutputs = {
  aws_region: 'us-east-1',
  ecs_cluster_name: '',
  ecs_cluster_arn: '',
  subnet_ids: '',
  security_group_id: '',
  file_manager_security_group_id: '',
  efs_file_system_id: '',
  efs_access_points: {},
  domain_name: '',
  game_names: [],
  alb_dns_name: null,
  acm_certificate_arn: null,
  discord_table_name: '',
  audit_table_name: '',
  runs_table_name: 'test-runs',
  discord_bot_token_secret_arn: '',
  discord_public_key_secret_arn: '',
  interactions_invoke_url: null,
  discord_interactions_url: null,
  applied_game_servers: null,
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

/** Builds a `RunRecordService` with a `ConfigService` stub returning `outputs` and the given (or default) store/run-service stubs. */
function makeService(
  outputs: TfOutputs | null = TF,
  store: RunRecordStore = makeStore(),
  runService: RunService = makeRunService(),
): RunRecordService {
  const config = { getTfOutputs: () => outputs } as Partial<ConfigService> as ConfigService;
  return new RunRecordService(config, store, runService);
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
      const smallLog = 'terraform plan output\nPlan: 1 to add, 0 to change, 0 to destroy.';

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

    it('should include tfvarsVersionId on the record when present on params', async () => {
      putRecordMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.persist(makeParams({ tfvarsVersionId: 'v-1' }), null);

      const record = putRecordMock.mock.calls[0]?.[0] as RunRecord;
      expect(record.tfvarsVersionId).toBe('v-1');
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
  });
});
