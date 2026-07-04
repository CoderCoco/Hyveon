import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectVersionsCommand,
  NoSuchKey,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { RemoteFileConflictError } from '@hyveon/shared';
import { AwsRemoteFileStore } from './AwsRemoteFileStore.js';

/** Typed stand-in for the AWS S3 SDK client. */
const s3Mock = mockClient(S3Client);

/**
 * Build an {@link AwsRemoteFileStore} whose `getConfig` callback resolves to
 * the given bucket/region. Pass `null` to simulate a store constructed with no
 * `getConfig` callback at all (the zero-arg-constructible case) — a dedicated
 * `null` sentinel is used (rather than `undefined`) because an explicit
 * `undefined` argument would just fall through to the default parameter.
 */
function makeStore(config: { bucket: string; region?: string } | null = { bucket: 'my-bucket' }) {
  return new AwsRemoteFileStore(config === null ? undefined : () => config);
}

/** Builds a fake S3 `Body` stream whose `transformToByteArray()` resolves to the given bytes. */
function fakeBody(bytes: Uint8Array): { transformToByteArray: () => Promise<Uint8Array> } {
  return { transformToByteArray: async () => bytes };
}

describe('AwsRemoteFileStore', () => {
  beforeEach(() => {
    s3Mock.reset();
  });

  afterEach(() => {
    delete process.env['AWS_REGION_'];
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
  });

  describe('get', () => {
    it('should return the body and unquoted etag on a successful lookup', async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      s3Mock.on(GetObjectCommand).resolves({
        Body: fakeBody(bytes) as never,
        ETag: '"abc123"',
      });

      const store = makeStore();
      await expect(store.get('foo/bar.txt')).resolves.toEqual({ body: bytes, etag: 'abc123' });

      const input = s3Mock.commandCalls(GetObjectCommand)[0]!.args[0].input;
      expect(input.Bucket).toBe('my-bucket');
      expect(input.Key).toBe('foo/bar.txt');
    });

    it('should return undefined when the object does not exist (NoSuchKey)', async () => {
      s3Mock.on(GetObjectCommand).rejects(new NoSuchKey({ message: 'not found', $metadata: {} }));

      const store = makeStore();
      await expect(store.get('missing.txt')).resolves.toBeUndefined();
    });

    it('should return undefined when S3ServiceException carries a 404 status code', async () => {
      s3Mock.on(GetObjectCommand).rejects(
        new S3ServiceException({
          name: 'NotFound',
          $fault: 'client',
          message: 'not found',
          $metadata: { httpStatusCode: 404 },
        }),
      );

      const store = makeStore();
      await expect(store.get('missing.txt')).resolves.toBeUndefined();
    });

    it('should rethrow a non-404 S3ServiceException', async () => {
      s3Mock.on(GetObjectCommand).rejects(
        new S3ServiceException({
          name: 'InternalError',
          $fault: 'server',
          message: 'internal failure',
          $metadata: { httpStatusCode: 500 },
        }),
      );

      const store = makeStore();
      await expect(store.get('foo.txt')).rejects.toThrow('internal failure');
    });

    it('should rethrow errors that are not NoSuchKey or S3ServiceException', async () => {
      s3Mock.on(GetObjectCommand).rejects(new Error('network down'));

      const store = makeStore();
      await expect(store.get('foo.txt')).rejects.toThrow('network down');
    });

    it('should return undefined when the response has no Body', async () => {
      s3Mock.on(GetObjectCommand).resolves({ ETag: '"abc123"' });

      const store = makeStore();
      await expect(store.get('foo.txt')).resolves.toBeUndefined();
    });

    it('should return undefined when the response has no ETag', async () => {
      s3Mock.on(GetObjectCommand).resolves({ Body: fakeBody(new Uint8Array([9])) as never });

      const store = makeStore();
      await expect(store.get('foo.txt')).resolves.toBeUndefined();
    });
  });

  describe('put', () => {
    it('should write the body and return the unquoted etag when no ifMatch is given', async () => {
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"etag-1"' });

      const store = makeStore();
      const body = new Uint8Array([1, 2, 3]);
      await expect(store.put('foo.txt', body)).resolves.toEqual({ etag: 'etag-1' });

      const input = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
      expect(input.Bucket).toBe('my-bucket');
      expect(input.Key).toBe('foo.txt');
      expect(input.Body).toBe(body);
      expect(input.IfMatch).toBeUndefined();
    });

    it('should send IfMatch when opts.ifMatch is provided', async () => {
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"etag-2"' });

      const store = makeStore();
      await store.put('foo.txt', new Uint8Array([1]), { ifMatch: 'stale-etag' });

      const input = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
      expect(input.IfMatch).toBe('stale-etag');
    });

    it('should throw a clear error when the PutObject response has no ETag', async () => {
      s3Mock.on(PutObjectCommand).resolves({});

      const store = makeStore();
      await expect(store.put('foo.txt', new Uint8Array([1]))).rejects.toThrow(
        'S3 PutObject for path "foo.txt" did not return an ETag.',
      );
    });

    it('should throw RemoteFileConflictError when S3 returns 412 Precondition Failed', async () => {
      s3Mock.on(PutObjectCommand).rejects(
        new S3ServiceException({
          name: 'PreconditionFailed',
          $fault: 'client',
          message: 'precondition failed',
          $metadata: { httpStatusCode: 412 },
        }),
      );

      const store = makeStore();
      const err: unknown = await store
        .put('foo.txt', new Uint8Array([1]), { ifMatch: 'stale-etag' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RemoteFileConflictError);
      expect((err as RemoteFileConflictError).path).toBe('foo.txt');
      expect((err as RemoteFileConflictError).ifMatch).toBe('stale-etag');
    });

    it('should throw RemoteFileConflictError when S3 returns 409 ConditionalRequestConflict', async () => {
      s3Mock.on(PutObjectCommand).rejects(
        new S3ServiceException({
          name: 'ConditionalRequestConflict',
          $fault: 'client',
          message: 'conflicting write',
          $metadata: { httpStatusCode: 409 },
        }),
      );

      const store = makeStore();
      await expect(
        store.put('foo.txt', new Uint8Array([1]), { ifMatch: 'stale-etag' }),
      ).rejects.toBeInstanceOf(RemoteFileConflictError);
    });

    it('should rethrow an S3ServiceException whose status code is not a conflict code', async () => {
      s3Mock.on(PutObjectCommand).rejects(
        new S3ServiceException({
          name: 'InternalError',
          $fault: 'server',
          message: 'internal failure',
          $metadata: { httpStatusCode: 500 },
        }),
      );

      const store = makeStore();
      await expect(store.put('foo.txt', new Uint8Array([1]))).rejects.toThrow('internal failure');
    });

    it('should rethrow errors that are not S3ServiceException', async () => {
      s3Mock.on(PutObjectCommand).rejects(new Error('network down'));

      const store = makeStore();
      await expect(store.put('foo.txt', new Uint8Array([1]))).rejects.toThrow('network down');
    });
  });

  describe('listVersions', () => {
    it('should return matching versions sorted newest-first', async () => {
      s3Mock.on(ListObjectVersionsCommand).resolves({
        Versions: [
          { Key: 'foo.txt', VersionId: 'v1', LastModified: new Date('2024-01-01T00:00:00Z') },
          { Key: 'foo.txt', VersionId: 'v2', LastModified: new Date('2024-06-01T00:00:00Z') },
          { Key: 'other.txt', VersionId: 'v3', LastModified: new Date('2024-12-01T00:00:00Z') },
        ],
      });

      const store = makeStore();
      await expect(store.listVersions('foo.txt')).resolves.toEqual([
        { versionId: 'v2', lastModified: new Date('2024-06-01T00:00:00Z') },
        { versionId: 'v1', lastModified: new Date('2024-01-01T00:00:00Z') },
      ]);

      const input = s3Mock.commandCalls(ListObjectVersionsCommand)[0]!.args[0].input;
      expect(input.Bucket).toBe('my-bucket');
      expect(input.Prefix).toBe('foo.txt');
    });

    it('should filter out entries missing a VersionId or LastModified', async () => {
      s3Mock.on(ListObjectVersionsCommand).resolves({
        Versions: [
          { Key: 'foo.txt', VersionId: undefined, LastModified: new Date() },
          { Key: 'foo.txt', VersionId: 'v1', LastModified: undefined },
        ],
      });

      const store = makeStore();
      await expect(store.listVersions('foo.txt')).resolves.toEqual([]);
    });

    it('should return an empty array when the response has no Versions', async () => {
      s3Mock.on(ListObjectVersionsCommand).resolves({});

      const store = makeStore();
      await expect(store.listVersions('foo.txt')).resolves.toEqual([]);
    });
  });

  describe('bucket configuration', () => {
    it('should throw a clear error when constructed without a getConfig callback', async () => {
      const store = makeStore(null);
      await expect(store.get('foo.txt')).rejects.toThrow(
        'AwsRemoteFileStore: bucket not configured. Supply a getConfig callback that resolves { bucket }.',
      );
    });

    it('should throw a clear error when getConfig resolves an empty bucket', async () => {
      const store = new AwsRemoteFileStore(() => ({ bucket: '' }));
      await expect(store.put('foo.txt', new Uint8Array([1]))).rejects.toThrow('bucket not configured');
    });

    it('should throw a clear error from listVersions when no bucket is configured', async () => {
      const store = makeStore(null);
      await expect(store.listVersions('foo.txt')).rejects.toThrow('bucket not configured');
    });
  });

  describe('region resolution', () => {
    it('should build the S3 client with the region returned by getConfig', async () => {
      let observedRegion: string | undefined;
      s3Mock.on(GetObjectCommand).callsFake(async (_input, getClient) => {
        observedRegion = await getClient().config.region();
        return { Body: fakeBody(new Uint8Array([1])) as never, ETag: '"e"' };
      });

      const store = makeStore({ bucket: 'my-bucket', region: 'eu-west-1' });
      await store.get('foo.txt');

      expect(observedRegion).toBe('eu-west-1');
    });

    it('should rebuild the client when the configured region changes between calls', async () => {
      const observedRegions: string[] = [];
      s3Mock.on(GetObjectCommand).callsFake(async (_input, getClient) => {
        observedRegions.push(await getClient().config.region());
        return { Body: fakeBody(new Uint8Array([1])) as never, ETag: '"e"' };
      });

      // A mutable config object, rather than a call-count-based index: getConfig
      // is invoked multiple times per store call (once for the client's region,
      // once for the bucket name), so a naive incrementing counter would drift.
      const config = { bucket: 'my-bucket', region: 'us-east-1' };
      const store = new AwsRemoteFileStore(() => config);
      await store.get('foo-a.txt');

      config.region = 'eu-west-1';
      await store.get('foo-b.txt');

      expect(observedRegions).toEqual(['us-east-1', 'eu-west-1']);
    });

    it('should fall back through AWS_REGION_, AWS_REGION, AWS_DEFAULT_REGION, then us-east-1', async () => {
      let observedRegion: string | undefined;
      s3Mock.on(GetObjectCommand).callsFake(async (_input, getClient) => {
        observedRegion = await getClient().config.region();
        return { Body: fakeBody(new Uint8Array([1])) as never, ETag: '"e"' };
      });

      // No getConfig region and no env vars set: falls back to the hardcoded default.
      const storeNoEnv = new AwsRemoteFileStore(() => ({ bucket: 'my-bucket' }));
      await storeNoEnv.get('a.txt');
      expect(observedRegion).toBe('us-east-1');

      // AWS_DEFAULT_REGION is honoured when set.
      process.env['AWS_DEFAULT_REGION'] = 'ap-southeast-2';
      const storeDefault = new AwsRemoteFileStore(() => ({ bucket: 'my-bucket' }));
      await storeDefault.get('b.txt');
      expect(observedRegion).toBe('ap-southeast-2');

      // AWS_REGION takes priority over AWS_DEFAULT_REGION.
      process.env['AWS_REGION'] = 'ca-central-1';
      const storeRegion = new AwsRemoteFileStore(() => ({ bucket: 'my-bucket' }));
      await storeRegion.get('c.txt');
      expect(observedRegion).toBe('ca-central-1');

      // AWS_REGION_ (Lambda's reserved-name workaround) takes priority over AWS_REGION.
      process.env['AWS_REGION_'] = 'ap-northeast-1';
      const storeUnderscore = new AwsRemoteFileStore(() => ({ bucket: 'my-bucket' }));
      await storeUnderscore.get('d.txt');
      expect(observedRegion).toBe('ap-northeast-1');
    });
  });
});
