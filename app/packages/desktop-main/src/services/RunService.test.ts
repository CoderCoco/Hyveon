/**
 * Tests for `RunService` — the in-memory + DynamoDB apply lock (issue #106).
 * `RunRecordStore` is stubbed here; the real `AwsRunRecordStore` has its own
 * tests under `@hyveon/cloud-aws`. Covers `createRun` rejecting a second
 * concurrent submission with `RunLockHeldError`, `getCurrentLock` surfacing
 * the in-flight lock, `releaseRun` freeing it for the next `createRun`, and
 * the table-not-deployed path still enforcing the in-memory mutex.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunLockHeldError } from '@hyveon/shared';
import type { RunLock, RunRecordStore } from '@hyveon/shared';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DEFAULT_LOCK_TTL_MS, RunService } from './RunService.js';
import { ConfigService, type TfOutputs } from './ConfigService.js';

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

const acquireRunLockMock = vi.fn<RunRecordStore['acquireRunLock']>();
const getRunLockMock = vi.fn<RunRecordStore['getRunLock']>();
const releaseRunLockMock = vi.fn<RunRecordStore['releaseRunLock']>();

/** Builds a `RunRecordStore`-shaped stub, only implementing the lock methods `RunService` calls. */
function makeStore(): RunRecordStore {
  return {
    putRecord: vi.fn(),
    putLog: vi.fn(),
    getLogUrl: vi.fn(),
    acquireRunLock: acquireRunLockMock,
    getRunLock: getRunLockMock,
    releaseRunLock: releaseRunLockMock,
  };
}

/** Builds a `RunService` with a `ConfigService` stub returning `outputs` and the given (or default) store stub. */
function makeService(outputs: TfOutputs | null = TF, store: RunRecordStore = makeStore()): RunService {
  const config = { getTfOutputs: () => outputs } as Partial<ConfigService> as ConfigService;
  return new RunService(config, store);
}

beforeEach(() => {
  acquireRunLockMock.mockReset();
  getRunLockMock.mockReset();
  releaseRunLockMock.mockReset();
  acquireRunLockMock.mockResolvedValue(undefined);
  releaseRunLockMock.mockResolvedValue(undefined);
});

describe('RunService', () => {
  describe('createRun', () => {
    it('should acquire the lock, mirror it to the DynamoDB-backed store, and return it', async () => {
      const service = makeService();

      const lock = await service.createRun('apply', 'alice');

      expect(lock.kind).toBe('apply');
      expect(lock.initiator).toBe('alice');
      expect(typeof lock.runId).toBe('string');
      expect(lock.runId.length).toBeGreaterThan(0);
      expect(acquireRunLockMock).toHaveBeenCalledTimes(1);
      expect(acquireRunLockMock).toHaveBeenCalledWith(lock);
    });

    it('should reject the second of two simultaneous createRun calls with RunLockHeldError', async () => {
      const service = makeService();
      // Never resolves within this test — proves the in-memory guard rejects
      // the second call before the first call's DynamoDB round-trip settles.
      acquireRunLockMock.mockReturnValue(new Promise(() => {}));

      const firstCall = service.createRun('apply', 'alice');
      const secondCall = service.createRun('plan', 'bob');

      await expect(secondCall).rejects.toBeInstanceOf(RunLockHeldError);
      await expect(secondCall).rejects.toMatchObject({ lock: { initiator: 'alice', kind: 'apply' } });
      // The first call is intentionally left in-flight (never awaited to
      // resolution) since acquireRunLockMock never resolves in this test.
      void firstCall.catch(() => {});
    });

    it('should roll back the in-memory lock when the DynamoDB acquisition is rejected by another holder', async () => {
      const service = makeService();
      const remoteLock: RunLock = {
        runId: 'remote-run',
        kind: 'destroy',
        initiator: 'carol',
        acquiredAt: '2026-07-20T00:00:00.000Z',
        expiresAt: '2026-07-20T01:00:00.000Z',
      };
      acquireRunLockMock.mockRejectedValueOnce(new RunLockHeldError(remoteLock));

      await expect(service.createRun('apply', 'alice')).rejects.toBeInstanceOf(RunLockHeldError);

      expect(service.getCurrentLock()).toBeUndefined();

      acquireRunLockMock.mockResolvedValueOnce(undefined);
      const nextLock = await service.createRun('plan', 'dave');
      expect(nextLock.initiator).toBe('dave');
    });

    it('should skip the DynamoDB call but still enforce the in-memory mutex when runs_table_name is not configured', async () => {
      const service = makeService(null);

      const lock = await service.createRun('apply', 'alice');

      expect(acquireRunLockMock).not.toHaveBeenCalled();
      expect(service.getCurrentLock()).toEqual(lock);

      await expect(service.createRun('plan', 'bob')).rejects.toBeInstanceOf(RunLockHeldError);
      expect(acquireRunLockMock).not.toHaveBeenCalled();
    });

    it('should allow a new run to be created once the previous run releases the lock', async () => {
      const service = makeService();

      const first = await service.createRun('apply', 'alice');
      await service.releaseRun(first.runId);

      const second = await service.createRun('plan', 'bob');

      expect(second.initiator).toBe('bob');
      expect(service.getCurrentLock()).toEqual(second);
    });

    it('should acquire the lock under a pre-minted runId when one is passed, and release it by that runId', async () => {
      const service = makeService();

      const lock = await service.createRun('apply', 'alice', 'some-id');

      expect(lock.runId).toBe('some-id');
      expect(acquireRunLockMock).toHaveBeenCalledWith(lock);
      expect(service.getCurrentLock()).toEqual(lock);

      await service.releaseRun('some-id');

      expect(releaseRunLockMock).toHaveBeenCalledWith('some-id');
      expect(service.getCurrentLock()).toBeUndefined();
    });

    it('should take over an expired in-memory lock instead of throwing RunLockHeldError', async () => {
      const service = makeService();

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
        const first = await service.createRun('apply', 'alice');

        // Advance past DEFAULT_LOCK_TTL_MS without releasing the first lock
        // (simulates a crashed run that never called releaseRun).
        vi.setSystemTime(new Date(Date.parse(first.acquiredAt) + DEFAULT_LOCK_TTL_MS + 1));

        const second = await service.createRun('plan', 'bob');

        expect(second.initiator).toBe('bob');
        expect(service.getCurrentLock()).toEqual(second);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('getCurrentLock', () => {
    it('should return undefined when no run is in flight', () => {
      const service = makeService();

      expect(service.getCurrentLock()).toBeUndefined();
    });

    it('should surface the in-flight lock acquired by createRun', async () => {
      const service = makeService();

      const lock = await service.createRun('apply', 'alice');

      expect(service.getCurrentLock()).toEqual(lock);
    });

    it('should return undefined once the held lock has expired, without releaseRun being called', async () => {
      const service = makeService();

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
        const lock = await service.createRun('apply', 'alice');
        expect(service.getCurrentLock()).toEqual(lock);

        vi.setSystemTime(new Date(Date.parse(lock.acquiredAt) + DEFAULT_LOCK_TTL_MS + 1));

        expect(service.getCurrentLock()).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('releaseRun', () => {
    it('should free the lock for the next createRun call and release the DynamoDB-backed lock', async () => {
      const service = makeService();
      const lock = await service.createRun('apply', 'alice');

      await service.releaseRun(lock.runId);

      expect(releaseRunLockMock).toHaveBeenCalledWith(lock.runId);
      expect(service.getCurrentLock()).toBeUndefined();
    });

    it('should no-op when runId does not match the currently held lock', async () => {
      const service = makeService();
      const lock = await service.createRun('apply', 'alice');

      await service.releaseRun('some-other-run-id');

      expect(service.getCurrentLock()).toEqual(lock);
      expect(releaseRunLockMock).toHaveBeenCalledWith('some-other-run-id');
    });

    it('should skip the DynamoDB release call when runs_table_name is not configured', async () => {
      const service = makeService(null);
      const lock = await service.createRun('apply', 'alice');

      await service.releaseRun(lock.runId);

      expect(releaseRunLockMock).not.toHaveBeenCalled();
      expect(service.getCurrentLock()).toBeUndefined();
    });

    it('should resolve rather than throw when the DynamoDB release call rejects with a transient error', async () => {
      const service = makeService();
      const lock = await service.createRun('apply', 'alice');
      releaseRunLockMock.mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));

      // Must not reject: RunRecordService.persist() releases the lock from a
      // `finally` block, so a non-conflict DynamoDB error here must be
      // swallowed (with a warning logged) rather than propagated — the lock
      // self-heals via TTL expiry regardless.
      await expect(service.releaseRun(lock.runId)).resolves.toBeUndefined();
      expect(service.getCurrentLock()).toBeUndefined();
    });
  });
});
