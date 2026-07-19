import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { RunRecord } from '@hyveon/shared';
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

    it('should include tfvarsVersionId and log on the written item when present on the record', async () => {
      ddbMock.on(PutCommand).resolves({});

      const store = makeStore();
      const record = makeRecord({ tfvarsVersionId: 'v-1', log: 'runs/run-123.log' });
      await store.putRecord(record);

      const input = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(input.Item?.['tfvarsVersionId']).toBe('v-1');
      expect(input.Item?.['log']).toBe('runs/run-123.log');
    });

    it('should omit tfvarsVersionId and log from the written item when absent on the record', async () => {
      ddbMock.on(PutCommand).resolves({});

      const store = makeStore();
      await store.putRecord(makeRecord());

      const input = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(input.Item).not.toHaveProperty('tfvarsVersionId');
      expect(input.Item).not.toHaveProperty('log');
    });

    it('should throw a clear error when constructed without a getConfig callback', async () => {
      const store = makeStore(null);
      await expect(store.putRecord(makeRecord())).rejects.toThrow(
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
});
