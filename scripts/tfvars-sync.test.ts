/**
 * Unit tests for tfvars-sync.ts's public pull/push/diff/status API, backed by
 * a mocked S3 client (via `aws-sdk-client-mock`) and a real, throwaway
 * temp-directory filesystem (the module reads/writes files with plain
 * `node:fs` calls, so faking `fs` would just re-implement it).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pullTfvars,
  pushTfvars,
  diffTfvars,
  lockStatus,
  checkTfvars,
  parseArgs,
  VersionMismatchError,
  BucketNotVersionedError,
  type LockFile,
} from './tfvars-sync.ts';

/** Typed stand-in for the AWS S3 SDK client — patches every `new S3Client()` instance. */
const s3Mock = mockClient(S3Client);

/** Builds a fake `GetObjectCommand` `Body` whose `transformToString()` resolves to `content`. */
function fakeBody(content: string): { transformToString: () => Promise<string> } {
  return { transformToString: async () => content };
}

/** Writes a `LockFile` sidecar directly to `${path}.lock`, bypassing `pullTfvars`/`pushTfvars`. */
function writeLockFile(path: string, lock: LockFile): void {
  writeFileSync(`${path}.lock`, JSON.stringify(lock, null, 2));
}

describe('tfvars-sync', () => {
  let tmpDir: string;
  let localPath: string;

  beforeEach(() => {
    s3Mock.reset();
    tmpDir = mkdtempSync(join(tmpdir(), 'tfvars-sync-test-'));
    localPath = join(tmpDir, 'terraform.tfvars');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('pullTfvars', () => {
    it('should write the remote content to the local path and record a matching lock file', async () => {
      s3Mock.on(GetObjectCommand).resolves({
        Body: fakeBody('project_name = "demo"\n') as never,
        VersionId: 'v1',
        ETag: '"etag-1"',
        ContentLength: 22,
        LastModified: new Date('2024-01-01T00:00:00Z'),
      });

      const result = await pullTfvars({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(readFileSync(localPath, 'utf8')).toBe('project_name = "demo"\n');
      expect(result.lock).toMatchObject({
        bucket: 'my-bucket',
        key: 'terraform.tfvars',
        versionId: 'v1',
        etag: 'etag-1',
        size: 22,
        lastModified: '2024-01-01T00:00:00.000Z',
      });
      expect(JSON.parse(readFileSync(result.lockPath, 'utf8'))).toMatchObject({ versionId: 'v1', etag: 'etag-1' });

      const input = s3Mock.commandCalls(GetObjectCommand)[0]!.args[0].input;
      expect(input.Bucket).toBe('my-bucket');
      expect(input.Key).toBe('terraform.tfvars');
    });

    it('should create missing parent directories before writing the local file', async () => {
      const nestedPath = join(tmpDir, 'nested', 'dir', 'terraform.tfvars');
      s3Mock.on(GetObjectCommand).resolves({
        Body: fakeBody('a = 1\n') as never,
        VersionId: 'v1',
        ETag: '"e"',
      });

      await pullTfvars({ bucket: 'my-bucket', path: nestedPath, key: 'terraform.tfvars' });

      expect(readFileSync(nestedPath, 'utf8')).toBe('a = 1\n');
    });
  });

  describe('pushTfvars', () => {
    it('should upload the local file and refresh the lock when the local lock matches the remote version', async () => {
      writeFileSync(localPath, 'project_name = "demo"\n');
      writeLockFile(localPath, {
        bucket: 'my-bucket',
        key: 'terraform.tfvars',
        versionId: 'v1',
        etag: 'etag-1',
        size: 22,
        lastModified: '2024-01-01T00:00:00.000Z',
        pulledAt: '2024-01-01T00:00:01.000Z',
      });
      s3Mock.on(HeadObjectCommand).resolves({ VersionId: 'v1', ETag: '"etag-1"' });
      s3Mock.on(PutObjectCommand).resolves({ VersionId: 'v2', ETag: '"etag-2"' });

      const result = await pushTfvars({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
      // The conditional write is the actual race guard: assert PutObject was
      // sent with `IfMatch` pinned to the locked etag, not just that some
      // PutObject happened. A regression that drops the conditional write
      // would otherwise still pass this test.
      expect(s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input.IfMatch).toBe('"etag-1"');
      expect(result.lock.versionId).toBe('v2');
      expect(result.lock.etag).toBe('etag-2');
      expect(JSON.parse(readFileSync(result.lockPath, 'utf8'))).toMatchObject({ versionId: 'v2', etag: 'etag-2' });
    });

    it('should upload without requiring a lock when the remote object does not exist yet', async () => {
      writeFileSync(localPath, 'project_name = "demo"\n');
      s3Mock.on(HeadObjectCommand).rejects({ name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      s3Mock.on(PutObjectCommand).resolves({ VersionId: 'v1', ETag: '"etag-1"' });

      const result = await pushTfvars({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
      // The first-write guard is the actual TOCTOU protection here: assert
      // PutObject was sent with `IfNoneMatch: '*'` so a concurrent create by
      // another writer is rejected, not just that some PutObject happened.
      expect(s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input.IfNoneMatch).toBe('*');
      expect(result.lock.versionId).toBe('v1');
    });

    it('should throw when the local file does not exist', async () => {
      await expect(
        pushTfvars({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' }),
      ).rejects.toThrow(`Local file not found: ${localPath}`);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('should reject with VersionMismatchError and never call PutObject when the remote exists but no local lock was found', async () => {
      writeFileSync(localPath, 'project_name = "demo"\n');
      s3Mock.on(HeadObjectCommand).resolves({ VersionId: 'v1', ETag: '"etag-1"' });
      s3Mock.on(PutObjectCommand).resolves({ VersionId: 'v2', ETag: '"etag-2"' });

      const err: unknown = await pushTfvars({
        bucket: 'my-bucket',
        path: localPath,
        key: 'terraform.tfvars',
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(VersionMismatchError);
      expect((err as VersionMismatchError).localVersion).toBeNull();
      expect((err as VersionMismatchError).remoteVersion).toBe('v1');
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('should reject a stale local lock with VersionMismatchError and never call PutObject', async () => {
      writeFileSync(localPath, 'project_name = "demo"\n');
      writeLockFile(localPath, {
        bucket: 'my-bucket',
        key: 'terraform.tfvars',
        versionId: 'stale-version',
        etag: 'stale-etag',
        size: 22,
        lastModified: '2024-01-01T00:00:00.000Z',
        pulledAt: '2024-01-01T00:00:01.000Z',
      });
      // Someone else pushed since the last pull — the remote has moved on to v2.
      s3Mock.on(HeadObjectCommand).resolves({ VersionId: 'v2', ETag: '"etag-2"' });
      s3Mock.on(PutObjectCommand).resolves({ VersionId: 'v3', ETag: '"etag-3"' });

      const err: unknown = await pushTfvars({
        bucket: 'my-bucket',
        path: localPath,
        key: 'terraform.tfvars',
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(VersionMismatchError);
      expect((err as VersionMismatchError).localVersion).toBe('stale-version');
      expect((err as VersionMismatchError).remoteVersion).toBe('v2');
      expect(err).toHaveProperty('message', expect.stringContaining('Run "pull" to refresh before pushing.'));
      // The whole point of the lock check: a stale lock must never reach PutObject.
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      // Nor should the (now-stale) lock file have been overwritten.
      expect(JSON.parse(readFileSync(`${localPath}.lock`, 'utf8'))).toMatchObject({ versionId: 'stale-version' });
    });

    it('should reject with BucketNotVersionedError and never call PutObject when the remote object exists but HeadObject reports no VersionId', async () => {
      // Simulates an unversioned (or versioning-suspended) bucket: HeadObject
      // omits VersionId even though the object exists.
      writeFileSync(localPath, 'project_name = "demo"\n');
      writeLockFile(localPath, {
        bucket: 'my-bucket',
        key: 'terraform.tfvars',
        versionId: null,
        etag: 'etag-1',
        size: 22,
        lastModified: '2024-01-01T00:00:00.000Z',
        pulledAt: '2024-01-01T00:00:01.000Z',
      });
      s3Mock.on(HeadObjectCommand).resolves({ ETag: '"etag-1"' });
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"etag-2"' });

      const err: unknown = await pushTfvars({
        bucket: 'my-bucket',
        path: localPath,
        key: 'terraform.tfvars',
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BucketNotVersionedError);
      expect(err).toHaveProperty('message', expect.stringContaining('does not appear to have S3 versioning enabled'));
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('should reject with VersionMismatchError when PutObject fails with a 412 precondition-failed response', async () => {
      // The HeadObject check passes (lock matches remote at the time of the
      // check), but a concurrent push slips in between the check and the
      // PutObject call, so S3 rejects the conditional write with 412. This is
      // the actual race guard the HeadObject check can't cover on its own.
      writeFileSync(localPath, 'project_name = "demo"\n');
      writeLockFile(localPath, {
        bucket: 'my-bucket',
        key: 'terraform.tfvars',
        versionId: 'v1',
        etag: 'etag-1',
        size: 22,
        lastModified: '2024-01-01T00:00:00.000Z',
        pulledAt: '2024-01-01T00:00:01.000Z',
      });
      s3Mock.on(HeadObjectCommand).resolves({ VersionId: 'v1', ETag: '"etag-1"' });
      s3Mock.on(PutObjectCommand).rejects({ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });

      const err: unknown = await pushTfvars({
        bucket: 'my-bucket',
        path: localPath,
        key: 'terraform.tfvars',
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(VersionMismatchError);
      expect((err as VersionMismatchError).localVersion).toBe('v1');
      expect((err as VersionMismatchError).remoteVersion).toBeNull();
      expect(err).toHaveProperty('message', expect.stringContaining('concurrent push detected'));
      // The stale lock file must not have been overwritten with a failed push.
      expect(JSON.parse(readFileSync(`${localPath}.lock`, 'utf8'))).toMatchObject({ versionId: 'v1' });
    });
  });

  describe('diffTfvars', () => {
    it('should report matches: true when local and remote content are identical', async () => {
      writeFileSync(localPath, 'project_name = "demo"\n');
      s3Mock.on(GetObjectCommand).resolves({ Body: fakeBody('project_name = "demo"\n') as never });

      const result = await diffTfvars({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(result.matches).toBe(true);
    });

    it('should report matches: false and include a unified patch when local and remote content differ', async () => {
      writeFileSync(localPath, 'project_name = "local"\n');
      s3Mock.on(GetObjectCommand).resolves({ Body: fakeBody('project_name = "remote"\n') as never });

      const result = await diffTfvars({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(result.matches).toBe(false);
      expect(result.patch).toContain('remote');
      expect(result.patch).toContain('local');
    });

    it('should treat a missing remote object as empty content rather than throwing', async () => {
      writeFileSync(localPath, 'project_name = "local"\n');
      s3Mock.on(GetObjectCommand).rejects({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });

      const result = await diffTfvars({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(result.matches).toBe(false);
    });

    it('should treat a missing local file as empty content rather than throwing', async () => {
      s3Mock.on(GetObjectCommand).resolves({ Body: fakeBody('project_name = "remote"\n') as never });

      const result = await diffTfvars({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(result.matches).toBe(false);
    });
  });

  describe('lockStatus', () => {
    it('should report inSync: true when the local lock version matches the remote head version', async () => {
      writeLockFile(localPath, {
        bucket: 'my-bucket',
        key: 'terraform.tfvars',
        versionId: 'v1',
        etag: 'etag-1',
        size: 22,
        lastModified: '2024-01-01T00:00:00.000Z',
        pulledAt: '2024-01-01T00:00:01.000Z',
      });
      s3Mock.on(HeadObjectCommand).resolves({ VersionId: 'v1', ETag: '"etag-1"' });

      const result = await lockStatus({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(result.inSync).toBe(true);
      expect(result.lock?.versionId).toBe('v1');
      expect(result.remote.exists).toBe(true);
    });

    it('should report inSync: false when the local lock version differs from the remote head version', async () => {
      writeLockFile(localPath, {
        bucket: 'my-bucket',
        key: 'terraform.tfvars',
        versionId: 'stale-version',
        etag: 'stale-etag',
        size: 22,
        lastModified: '2024-01-01T00:00:00.000Z',
        pulledAt: '2024-01-01T00:00:01.000Z',
      });
      s3Mock.on(HeadObjectCommand).resolves({ VersionId: 'v2', ETag: '"etag-2"' });

      const result = await lockStatus({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(result.inSync).toBe(false);
    });

    it('should report a null lock and inSync: false when the file was never pulled', async () => {
      s3Mock.on(HeadObjectCommand).resolves({ VersionId: 'v1', ETag: '"etag-1"' });

      const result = await lockStatus({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(result.lock).toBeNull();
      expect(result.inSync).toBe(false);
      expect(result.localExists).toBe(false);
    });

    it('should report remote.exists: false when the remote object does not exist', async () => {
      s3Mock.on(HeadObjectCommand).rejects({ name: 'NotFound', $metadata: { httpStatusCode: 404 } });

      const result = await lockStatus({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(result.remote.exists).toBe(false);
      expect(result.inSync).toBe(false);
    });
  });

  describe('checkTfvars', () => {
    it('should report inSync: true with a clear reason when the local lock version matches the remote head version', async () => {
      writeLockFile(localPath, {
        bucket: 'my-bucket',
        key: 'terraform.tfvars',
        versionId: 'v1',
        etag: 'etag-1',
        size: 22,
        lastModified: '2024-01-01T00:00:00.000Z',
        pulledAt: '2024-01-01T00:00:01.000Z',
      });
      s3Mock.on(HeadObjectCommand).resolves({ VersionId: 'v1', ETag: '"etag-1"' });

      const result = await checkTfvars({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(result.inSync).toBe(true);
      expect(result.reason).toContain('v1');
    });

    it('should report inSync: false with a clear reason when the local lock version differs from the remote head version', async () => {
      writeLockFile(localPath, {
        bucket: 'my-bucket',
        key: 'terraform.tfvars',
        versionId: 'stale-version',
        etag: 'stale-etag',
        size: 22,
        lastModified: '2024-01-01T00:00:00.000Z',
        pulledAt: '2024-01-01T00:00:01.000Z',
      });
      s3Mock.on(HeadObjectCommand).resolves({ VersionId: 'v2', ETag: '"etag-2"' });

      const result = await checkTfvars({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(result.inSync).toBe(false);
      expect(result.reason).toContain('stale-version');
      expect(result.reason).toContain('v2');
    });

    it('should report inSync: false with a clear reason when no local lock file was found', async () => {
      s3Mock.on(HeadObjectCommand).resolves({ VersionId: 'v1', ETag: '"etag-1"' });

      const result = await checkTfvars({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(result.inSync).toBe(false);
      expect(result.reason).toContain('no local lock file found');
    });

    it('should report inSync: false with a clear reason when the remote object does not exist', async () => {
      writeLockFile(localPath, {
        bucket: 'my-bucket',
        key: 'terraform.tfvars',
        versionId: 'v1',
        etag: 'etag-1',
        size: 22,
        lastModified: '2024-01-01T00:00:00.000Z',
        pulledAt: '2024-01-01T00:00:01.000Z',
      });
      s3Mock.on(HeadObjectCommand).rejects({ name: 'NotFound', $metadata: { httpStatusCode: 404 } });

      const result = await checkTfvars({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(result.inSync).toBe(false);
      expect(result.reason).toContain('does not exist');
    });

    it('should report inSync: false when the remote object exists but the bucket returns no VersionId (unversioned bucket)', async () => {
      writeLockFile(localPath, {
        bucket: 'my-bucket',
        key: 'terraform.tfvars',
        versionId: null,
        etag: 'etag-1',
        size: 22,
        lastModified: '2024-01-01T00:00:00.000Z',
        pulledAt: '2024-01-01T00:00:01.000Z',
      });
      s3Mock.on(HeadObjectCommand).resolves({ ETag: '"etag-1"' });

      const result = await checkTfvars({ bucket: 'my-bucket', path: localPath, key: 'terraform.tfvars' });

      expect(result.inSync).toBe(false);
      expect(result.reason).toContain('versioning');
    });
  });

  describe('parseArgs', () => {
    /**
     * The generated parent Makefile (see `renderMakefile()` in
     * `init-parent.ts`) renders every call site as
     * `$(TFVARS_SYNC) <subcommand> $(TFVARS_SYNC_ARGS)`, which Make expands
     * to `... tfvars-sync.ts <subcommand> --path <file> --bucket <bucket>`
     * — i.e. the subcommand always precedes the flags. This is the exact
     * argv shape `parseArgs()` must accept.
     */
    it('should parse the subcommand-then-flags argv shape the generated Makefile emits', () => {
      const { command, options } = parseArgs(['pull', '--path', '/tmp/parent/terraform.tfvars', '--bucket', 'my-bucket']);

      expect(command).toBe('pull');
      expect(options.path).toBe('/tmp/parent/terraform.tfvars');
      expect(options.bucket).toBe('my-bucket');
    });

    it('should parse the subcommand-then-flags argv shape for every Makefile-driven subcommand (push/diff/check)', () => {
      for (const command of ['push', 'diff', 'check'] as const) {
        const parsed = parseArgs([command, '--path', '/tmp/parent/terraform.tfvars', '--bucket', 'my-bucket']);
        expect(parsed.command).toBe(command);
        expect(parsed.options.bucket).toBe('my-bucket');
      }
    });

    it('should throw a usage error when flags precede the subcommand', () => {
      // Regression pin: an earlier Makefile template baked --path/--bucket
      // into the TFVARS_SYNC variable itself, so every call site rendered
      // "--path <file> --bucket <bucket> <subcommand>" — flags before the
      // subcommand. parseArgs() takes argv[0] as the command unconditionally,
      // so that shape threw this exact usage error on every tfvars-pull/
      // push/diff/check/setup invocation, yet no test exercised parseArgs()
      // with the Makefile's actual emitted argv shape to catch it.
      expect(() =>
        parseArgs(['--path', '/tmp/parent/terraform.tfvars', '--bucket', 'my-bucket', 'pull']),
      ).toThrow(/Usage: tfvars-sync\.ts <pull\|push\|diff\|status\|check>/);
    });
  });
});
