import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { RunLockHeldError } from '@hyveon/shared';
import type { RunLock, RunRecord } from '@hyveon/shared';
import { AwsRunRecordStore } from './AwsRunRecordStore.js';

/** Stub replacing `@aws-sdk/s3-request-presigner`'s `getSignedUrl` so tests
 * never attempt real SigV4 signing (which requires resolvable credentials). */
const getSignedUrlMock = vi.fn<() => Promise<string>>();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrlMock(...(args as [])),
}));

/** Typed stand-in for the DynamoDB document client SDK. */
const ddbMock = mockClient(DynamoDBDocumentClient);
/** Typed stand-in for the AWS S3 SDK client. */
const s3Mock = mockClient(S3Client);

/**
 * Build an {@link AwsRunRecordStore} whose config-resolution callback
 * returns a fixed table/bucket/region, avoiding any need to read/mutate
 * `process.env` in tests. Pass `null` to simulate a store constructed with
 * no `getConfig` callback at all (the zero-arg-constructible case).
 */
function makeStore(
  config: { tableName: string; bucket: string; region?: string } | null = {
    tableName: 'hyveon-runs',
    bucket: 'hyveon-runs-logs',
    region: 'us-east-1',
  },
): AwsRunRecordStore {
  return new AwsRunRecordStore(config === null ? undefined : () => config);
}

/** Builds a sample {@link RunRecord}, overridable per-test. */
function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
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

/** Builds a sample {@link RunLock}, overridable per-test. */
function makeLock(overrides: Partial<RunLock> = {}): RunLock {
  return {
    runId: 'run-123',
    kind: 'apply',
    initiator: 'alice',
    acquiredAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2026-07-17T01:00:00.000Z',
    ...overrides,
  };
}

describe('AwsRunRecordStore', () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
    getSignedUrlMock.mockReset();
  });

  describe('putRecord', () => {
    it('should send a PutCommand with pk RUN, the record sk, and status on the written item', async () => {
      ddbMock.on(PutCommand).resolves({});

      const store = makeStore();
      const record = makeRecord();
      await store.putRecord(record);

      const calls = ddbMock.commandCalls(PutCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.TableName).toBe('hyveon-runs');
      expect(input.Item).toEqual({
        pk: 'RUN',
        sk: record.sk,
        runId: record.runId,
        kind: record.kind,
        status: record.status,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        exitCode: record.exitCode,
      });
    });

    it('should include tfvarsVersionId and logS3Key on the written item when present on the record', async () => {
      ddbMock.on(PutCommand).resolves({});

      const store = makeStore();
      const record = makeRecord({ tfvarsVersionId: 'v-1', logS3Key: 'runs/run-123.log' });
      await store.putRecord(record);

      const input = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(input.Item?.['tfvarsVersionId']).toBe('v-1');
      expect(input.Item?.['logS3Key']).toBe('runs/run-123.log');
      expect(input.Item).not.toHaveProperty('logInline');
    });

    it('should include logInline (and not logS3Key) on the written item when the log was embedded', async () => {
      ddbMock.on(PutCommand).resolves({});

      const store = makeStore();
      const record = makeRecord({ logInline: 'terraform plan output' });
      await store.putRecord(record);

      const input = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(input.Item?.['logInline']).toBe('terraform plan output');
      expect(input.Item).not.toHaveProperty('logS3Key');
    });

    it('should omit tfvarsVersionId, logInline, and logS3Key from the written item when absent on the record', async () => {
      ddbMock.on(PutCommand).resolves({});

      const store = makeStore();
      await store.putRecord(makeRecord());

      const input = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(input.Item).not.toHaveProperty('tfvarsVersionId');
      expect(input.Item).not.toHaveProperty('logInline');
      expect(input.Item).not.toHaveProperty('logS3Key');
    });

    it('should include rolledBackFrom on the written item when present on the record', async () => {
      ddbMock.on(PutCommand).resolves({});

      const store = makeStore();
      const record = makeRecord({ kind: 'plan', rolledBackFrom: 'apply-run-1' });
      await store.putRecord(record);

      const input = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(input.Item?.['rolledBackFrom']).toBe('apply-run-1');
    });

    it('should omit rolledBackFrom from the written item when absent on the record', async () => {
      ddbMock.on(PutCommand).resolves({});

      const store = makeStore();
      await store.putRecord(makeRecord());

      const input = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(input.Item).not.toHaveProperty('rolledBackFrom');
    });

    it('should throw a clear error when constructed without a getConfig callback', async () => {
      const store = makeStore(null);
      await expect(store.putRecord(makeRecord())).rejects.toThrow(
        'AwsRunRecordStore: table not configured. Supply a getConfig callback that resolves { tableName }.',
      );
    });
  });

  describe('getRecordByRunId', () => {
    it('should query the RUN partition newest-first and return the matching record', async () => {
      const record = makeRecord();
      ddbMock.on(QueryCommand).resolves({ Items: [{ pk: 'RUN', ...record }] });

      const store = makeStore();
      await expect(store.getRecordByRunId('run-123')).resolves.toEqual(record);

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.TableName).toBe('hyveon-runs');
      expect(input.KeyConditionExpression).toBe('pk = :pk');
      expect(input.FilterExpression).toBe('runId = :runId');
      expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'RUN', ':runId': 'run-123' });
      expect(input.ScanIndexForward).toBe(false);
    });

    it('should return the newest record when the query returns multiple items for the runId', async () => {
      // ScanIndexForward: false means DynamoDB returns items sk-descending
      // (sk is `<startedAt>#<runId>`), so the newest record is Items[0].
      const newest = makeRecord({
        sk: '2026-07-18T00:00:00.000Z#run-123',
        startedAt: '2026-07-18T00:00:00.000Z',
        status: 'success',
      });
      const older = makeRecord({
        sk: '2026-07-17T00:00:00.000Z#run-123',
        startedAt: '2026-07-17T00:00:00.000Z',
        status: 'error',
      });
      ddbMock.on(QueryCommand).resolves({ Items: [{ pk: 'RUN', ...newest }, { pk: 'RUN', ...older }] });

      const store = makeStore();
      await expect(store.getRecordByRunId('run-123')).resolves.toEqual(newest);
    });

    it('should page through LastEvaluatedKey until a matching item is found', async () => {
      const record = makeRecord();
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [], LastEvaluatedKey: { pk: 'RUN', sk: 'cursor-1' } })
        .resolvesOnce({ Items: [{ pk: 'RUN', ...record }] });

      const store = makeStore();
      await expect(store.getRecordByRunId('run-123')).resolves.toEqual(record);

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.args[0].input.ExclusiveStartKey).toBeUndefined();
      expect(calls[1]!.args[0].input.ExclusiveStartKey).toEqual({ pk: 'RUN', sk: 'cursor-1' });
    });

    it('should return undefined once the partition is exhausted with no match', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const store = makeStore();
      await expect(store.getRecordByRunId('missing-run')).resolves.toBeUndefined();
    });

    it('should restore optional fields (tfvarsVersionId, logS3Key) on the returned record when present', async () => {
      const record = makeRecord({ tfvarsVersionId: 'v-1', logS3Key: 'runs/run-123.log' });
      ddbMock.on(QueryCommand).resolves({ Items: [{ pk: 'RUN', ...record }] });

      const store = makeStore();
      const result = await store.getRecordByRunId('run-123');

      expect(result?.tfvarsVersionId).toBe('v-1');
      expect(result?.logS3Key).toBe('runs/run-123.log');
    });

    it('should restore rolledBackFrom on the returned record when present', async () => {
      const record = makeRecord({ kind: 'plan', rolledBackFrom: 'apply-run-1' });
      ddbMock.on(QueryCommand).resolves({ Items: [{ pk: 'RUN', ...record }] });

      const store = makeStore();
      const result = await store.getRecordByRunId('run-123');

      expect(result?.rolledBackFrom).toBe('apply-run-1');
    });

    it('should throw a clear error when constructed without a getConfig callback', async () => {
      const store = makeStore(null);
      await expect(store.getRecordByRunId('run-123')).rejects.toThrow(
        'AwsRunRecordStore: table not configured. Supply a getConfig callback that resolves { tableName }.',
      );
    });
  });

  describe('putLog', () => {
    it('should write the body to the runs/<runId>.log S3 key and return that key', async () => {
      s3Mock.on(PutObjectCommand).resolves({});

      const store = makeStore();
      const body = new Uint8Array([1, 2, 3]);
      await expect(store.putLog('run-123', body)).resolves.toBe('runs/run-123.log');

      const input = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
      expect(input.Bucket).toBe('hyveon-runs-logs');
      expect(input.Key).toBe('runs/run-123.log');
      expect(input.Body).toBe(body);
    });

    it('should throw a clear error when constructed without a getConfig callback', async () => {
      const store = makeStore(null);
      await expect(store.putLog('run-123', new Uint8Array([1]))).rejects.toThrow(
        'AwsRunRecordStore: bucket not configured. Supply a getConfig callback that resolves { bucket }.',
      );
    });
  });

  describe('getLogUrl', () => {
    it('should return a presigned URL for a stored log key', async () => {
      getSignedUrlMock.mockResolvedValue('https://hyveon-runs-logs.s3.amazonaws.com/runs/run-123.log?X-Amz-Signature=abc');

      const store = makeStore();
      const url = await store.getLogUrl('runs/run-123.log');

      expect(url).toBe('https://hyveon-runs-logs.s3.amazonaws.com/runs/run-123.log?X-Amz-Signature=abc');
      expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
      const [, command, options] = getSignedUrlMock.mock.calls[0]!;
      expect((command as GetObjectCommand).input).toEqual({
        Bucket: 'hyveon-runs-logs',
        Key: 'runs/run-123.log',
      });
      expect(options).toEqual({ expiresIn: 3600 });
    });

    it('should pass a custom expiresInSeconds through to the presigner', async () => {
      getSignedUrlMock.mockResolvedValue('https://example.com/signed');

      const store = makeStore();
      await store.getLogUrl('runs/run-123.log', 60);

      const [, , options] = getSignedUrlMock.mock.calls[0]!;
      expect(options).toEqual({ expiresIn: 60 });
    });

    it('should throw a clear error when constructed without a getConfig callback', async () => {
      const store = makeStore(null);
      await expect(store.getLogUrl('runs/run-123.log')).rejects.toThrow(
        'AwsRunRecordStore: bucket not configured. Supply a getConfig callback that resolves { bucket }.',
      );
    });
  });

  describe('acquireRunLock', () => {
    it('should resolve without throwing when no lock item currently exists', async () => {
      ddbMock.on(PutCommand).resolves({});

      const store = makeStore();
      const lock = makeLock();
      await expect(store.acquireRunLock(lock)).resolves.toBeUndefined();

      const calls = ddbMock.commandCalls(PutCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.TableName).toBe('hyveon-runs');
      expect(input.Item).toEqual({
        pk: 'LOCK',
        sk: 'CURRENT',
        runId: lock.runId,
        kind: lock.kind,
        initiator: lock.initiator,
        acquiredAt: lock.acquiredAt,
        expiresAt: lock.expiresAt,
      });
      expect(input.ConditionExpression).toBe('attribute_not_exists(pk) OR expiresAt < :now');
      expect(input.ExpressionAttributeValues).toEqual({
        ':now': expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });
    });

    it('should resolve without throwing when the existing lock item has already expired', async () => {
      // The conditional PutItem's ExpressionAttributeValues comparison is
      // evaluated server-side by DynamoDB; from the client's perspective an
      // expired stale lock is indistinguishable from no lock at all — both
      // let the conditional write through, so this test exercises the same
      // "the condition passed" path as the empty-lock case above.
      ddbMock.on(PutCommand).resolves({});

      const store = makeStore();
      await expect(store.acquireRunLock(makeLock())).resolves.toBeUndefined();
    });

    it('should throw RunLockHeldError carrying the current lock holder when an unexpired lock is already held', async () => {
      ddbMock.on(PutCommand).rejects(
        new ConditionalCheckFailedException({ message: 'conditional check failed', $metadata: {} }),
      );
      const holder = makeLock({ runId: 'run-999', initiator: 'bob', kind: 'destroy' });
      ddbMock.on(GetCommand).resolves({
        Item: {
          pk: 'LOCK',
          sk: 'CURRENT',
          runId: holder.runId,
          kind: holder.kind,
          initiator: holder.initiator,
          acquiredAt: holder.acquiredAt,
          expiresAt: holder.expiresAt,
        },
      });

      const store = makeStore();
      const error = await store.acquireRunLock(makeLock({ runId: 'run-new' })).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RunLockHeldError);
      expect((error as RunLockHeldError).lock).toEqual(holder);
    });

    it('should re-throw any error that is not a ConditionalCheckFailedException', async () => {
      const boom = new Error('boom');
      ddbMock.on(PutCommand).rejects(boom);

      const store = makeStore();
      await expect(store.acquireRunLock(makeLock())).rejects.toThrow('boom');
    });
  });

  describe('getRunLock', () => {
    it('should return undefined when no lock item exists', async () => {
      ddbMock.on(GetCommand).resolves({});

      const store = makeStore();
      await expect(store.getRunLock()).resolves.toBeUndefined();

      const input = ddbMock.commandCalls(GetCommand)[0]!.args[0].input;
      expect(input.TableName).toBe('hyveon-runs');
      expect(input.Key).toEqual({ pk: 'LOCK', sk: 'CURRENT' });
    });

    it('should return the parsed lock when a lock item exists', async () => {
      const lock = makeLock();
      ddbMock.on(GetCommand).resolves({
        Item: {
          pk: 'LOCK',
          sk: 'CURRENT',
          runId: lock.runId,
          kind: lock.kind,
          initiator: lock.initiator,
          acquiredAt: lock.acquiredAt,
          expiresAt: lock.expiresAt,
        },
      });

      const store = makeStore();
      await expect(store.getRunLock()).resolves.toEqual(lock);
    });
  });

  describe('listRuns', () => {
    it('should query pk = RUN newest-first with the given Limit and no sk condition on the first page', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const store = makeStore();
      await store.listRuns({ limit: 20 });

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.TableName).toBe('hyveon-runs');
      expect(input.IndexName).toBeUndefined();
      expect(input.KeyConditionExpression).toBe('pk = :pk');
      expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'RUN' });
      expect(input.ScanIndexForward).toBe(false);
      expect(input.Limit).toBe(20);
    });

    it('should return an empty page with no nextBefore when the table is empty', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const store = makeStore();
      await expect(store.listRuns({ limit: 20 })).resolves.toEqual({ records: [] });
    });

    it('should add sk < before to the KeyConditionExpression when a cursor is given, without a status filter', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const store = makeStore();
      await store.listRuns({ limit: 20, before: '2026-07-17T00:00:00.000Z#run-123' });

      const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
      expect(input.KeyConditionExpression).toBe('pk = :pk AND sk < :before');
      expect(input.ExpressionAttributeValues).toEqual({
        ':pk': 'RUN',
        ':before': '2026-07-17T00:00:00.000Z#run-123',
      });
    });

    it('should return nextBefore set to the oldest record in the page when DynamoDB reports a LastEvaluatedKey', async () => {
      const first = makeRecord({ sk: '2026-07-18T00:00:00.000Z#run-1', runId: 'run-1' });
      const second = makeRecord({ sk: '2026-07-17T00:00:00.000Z#run-2', runId: 'run-2' });
      ddbMock.on(QueryCommand).resolves({
        Items: [{ pk: 'RUN', ...first }, { pk: 'RUN', ...second }],
        LastEvaluatedKey: { pk: 'RUN', sk: second.sk },
      });

      const store = makeStore();
      const result = await store.listRuns({ limit: 2 });

      expect(result.nextBefore).toBe(second.sk);
      expect(result.records.map((r) => r.sk)).toEqual([first.sk, second.sk]);
    });

    it('should query the status-index GSI with status = :status when a status filter is given', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const store = makeStore();
      await store.listRuns({ limit: 20, status: 'failed' });

      const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
      expect(input.IndexName).toBe('status-index');
      expect(input.KeyConditionExpression).toBe('status = :status');
      expect(input.ExpressionAttributeValues).toEqual({ ':status': 'failed' });
      expect(input.ScanIndexForward).toBe(false);
      expect(input.Limit).toBe(20);
    });

    it('should resume the status-index GSI via ExclusiveStartKey reconstructed from the sk cursor', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const store = makeStore();
      await store.listRuns({
        limit: 20,
        status: 'failed',
        before: '2026-07-17T00:00:00.000Z#run-123',
      });

      const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
      expect(input.KeyConditionExpression).toBe('status = :status');
      expect(input.ExpressionAttributeValues).toEqual({ ':status': 'failed' });
      expect(input.ExclusiveStartKey).toEqual({
        pk: 'RUN',
        sk: '2026-07-17T00:00:00.000Z#run-123',
        status: 'failed',
        startedAt: '2026-07-17T00:00:00.000Z',
      });
    });

    it('should not set ExclusiveStartKey on the status-index GSI query when no cursor is given', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const store = makeStore();
      await store.listRuns({ limit: 20, status: 'failed' });

      const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
      expect(input.ExclusiveStartKey).toBeUndefined();
    });

    it('should restore optional fields on records returned by a listRuns page', async () => {
      const record = makeRecord({ tfvarsVersionId: 'v-1', logS3Key: 'runs/run-123.log' });
      ddbMock.on(QueryCommand).resolves({ Items: [{ pk: 'RUN', ...record }] });

      const store = makeStore();
      const result = await store.listRuns({ limit: 20 });

      expect(result.records).toEqual([record]);
    });

    it('should throw a clear error when constructed without a getConfig callback', async () => {
      const store = makeStore(null);
      await expect(store.listRuns({ limit: 20 })).rejects.toThrow(
        'AwsRunRecordStore: table not configured. Supply a getConfig callback that resolves { tableName }.',
      );
    });
  });

  describe('releaseRunLock', () => {
    it('should send a DeleteCommand scoped to the given runId', async () => {
      ddbMock.on(DeleteCommand).resolves({});

      const store = makeStore();
      await expect(store.releaseRunLock('run-123')).resolves.toBeUndefined();

      const calls = ddbMock.commandCalls(DeleteCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.TableName).toBe('hyveon-runs');
      expect(input.Key).toEqual({ pk: 'LOCK', sk: 'CURRENT' });
      expect(input.ConditionExpression).toBe('runId = :runId');
      expect(input.ExpressionAttributeValues).toEqual({ ':runId': 'run-123' });
    });

    it('should no-op instead of throwing when the held lock belongs to a different runId', async () => {
      ddbMock.on(DeleteCommand).rejects(
        new ConditionalCheckFailedException({ message: 'conditional check failed', $metadata: {} }),
      );

      const store = makeStore();
      await expect(store.releaseRunLock('some-other-run')).resolves.toBeUndefined();
    });

    it('should re-throw any error that is not a ConditionalCheckFailedException', async () => {
      const boom = new Error('boom');
      ddbMock.on(DeleteCommand).rejects(boom);

      const store = makeStore();
      await expect(store.releaseRunLock('run-123')).rejects.toThrow('boom');
    });
  });
});
