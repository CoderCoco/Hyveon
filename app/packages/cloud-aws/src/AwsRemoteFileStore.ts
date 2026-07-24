import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectVersionsCommand,
  NoSuchKey,
  S3ServiceException,
  type ObjectVersion,
} from '@aws-sdk/client-s3';
import { RemoteFileConflictError, type RemoteFileStore } from '@hyveon/shared';

/**
 * HTTP status codes S3 returns when a conditional write's `If-Match` etag no
 * longer matches the object currently stored at the key — either the
 * standard `412 Precondition Failed`, or the `409 ConditionalRequestConflict`
 * S3 can return when a competing write races the same key. Both map to
 * {@link RemoteFileConflictError}.
 */
const CONFLICT_HTTP_STATUS_CODES = new Set([409, 412]);

/**
 * Strips the surrounding double quotes S3 always wraps `ETag` values in
 * (e.g. `"9bb58f26192e4ba00f01e2e7b136bbd8"`), so callers of the
 * cloud-agnostic {@link RemoteFileStore} contract see a plain token rather
 * than a provider-specific quoting quirk.
 */
function unquoteEtag(etag: string): string {
  return etag.replace(/^"|"$/g, '');
}

/**
 * AWS implementation of the cloud-agnostic {@link RemoteFileStore} contract,
 * backed by a versioned S3 bucket. No `@aws-sdk/*` shapes appear outside
 * this class's private fields/method bodies, so callers depend only on
 * {@link RemoteFileStore}.
 */
export class AwsRemoteFileStore implements RemoteFileStore {
  private client: S3Client | null = null;
  private clientRegion: string | null = null;

  /**
   * @param getConfig - Resolves the S3 bucket (and optional region) this
   *   store reads/writes, on every call — so a bucket rename picked up
   *   between calls (e.g. after a Terraform re-apply) isn't stuck targeting
   *   a stale bucket. Optional so the class remains constructible with no
   *   arguments, mirroring `AwsCloudProvider.getConfig`/`AwsSecretsStore`'s
   *   zero-arg-constructible pattern. When omitted (or when it returns no
   *   `bucket`), every method throws a clear "bucket not configured" error
   *   rather than sending a malformed request. `region` falls back to
   *   `AWS_REGION_` (Lambda's reserved-name workaround, see CLAUDE.md), then
   *   `AWS_REGION`, then `AWS_DEFAULT_REGION`, then `us-east-1` when omitted.
   */
  constructor(private readonly getConfig?: () => { bucket: string; region?: string }) {}

  /**
   * Resolves the configured bucket name, throwing a clear error instead of
   * letting an unconfigured bucket fall through to a malformed S3 request.
   */
  private getBucketName(): string {
    const bucket = this.getConfig?.()?.bucket;
    if (!bucket) {
      throw new Error(
        'AwsRemoteFileStore: bucket not configured. Supply a getConfig callback that resolves { bucket }.',
      );
    }
    return bucket;
  }

  /**
   * Lazily constructs the S3 client, recreating it whenever the
   * freshly-resolved region differs from the region the cached client was
   * built with — mirrors `AwsSecretsStore.getClient`'s rebuild-on-region-
   * change pattern.
   */
  private getClient(): S3Client {
    const region =
      this.getConfig?.()?.region ??
      process.env['AWS_REGION_'] ??
      process.env['AWS_REGION'] ??
      process.env['AWS_DEFAULT_REGION'] ??
      'us-east-1';

    if (!this.client || this.clientRegion !== region) {
      this.client = new S3Client({ region });
      this.clientRegion = region;
    }
    return this.client;
  }

  /**
   * Retrieves the current version of a file by path.
   *
   * @param path - The store-relative path of the file to retrieve.
   */
  async get(path: string): Promise<{ body: Uint8Array; etag: string } | undefined> {
    try {
      const resp = await this.getClient().send(
        new GetObjectCommand({ Bucket: this.getBucketName(), Key: path }),
      );
      const body = await resp.Body?.transformToByteArray();
      if (!body || !resp.ETag) return undefined;
      return { body, etag: unquoteEtag(resp.ETag) };
    } catch (err) {
      if (err instanceof NoSuchKey) return undefined;
      if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404) return undefined;
      throw err;
    }
  }

  /**
   * Writes a remote file, optionally conditioned on a matching etag.
   *
   * @param path - The path of the file to write.
   * @param body - The bytes to store.
   * @param opts - Optional write options, e.g. an `ifMatch` etag for optimistic concurrency.
   * @throws {@link RemoteFileConflictError} when `opts.ifMatch` is provided but no longer
   *   matches the etag currently stored at `path`.
   */
  async put(
    path: string,
    body: Uint8Array,
    opts?: { ifMatch?: string },
  ): Promise<{ etag: string; versionId?: string }> {
    try {
      const resp = await this.getClient().send(
        new PutObjectCommand({
          Bucket: this.getBucketName(),
          Key: path,
          Body: body,
          ...(opts?.ifMatch ? { IfMatch: opts.ifMatch } : {}),
        }),
      );
      if (!resp.ETag) {
        throw new Error(`S3 PutObject for path "${path}" did not return an ETag.`);
      }
      return { etag: unquoteEtag(resp.ETag), versionId: resp.VersionId };
    } catch (err) {
      if (
        err instanceof S3ServiceException &&
        err.$metadata.httpStatusCode !== undefined &&
        CONFLICT_HTTP_STATUS_CODES.has(err.$metadata.httpStatusCode)
      ) {
        throw new RemoteFileConflictError(path, undefined, opts?.ifMatch);
      }
      throw err;
    }
  }

  /**
   * Lists the known versions of a remote file.
   *
   * `ListObjectVersionsCommand` caps each response at 1,000 entries
   * (across all keys sharing the `Prefix`, not just `path`), so a single
   * call silently truncates history for a key with more versions than
   * that. Loops on `IsTruncated`, forwarding `NextKeyMarker`/
   * `NextVersionIdMarker` as the next call's `KeyMarker`/`VersionIdMarker`,
   * accumulating every page's `Versions` before the existing filter/sort —
   * see issue #260.
   *
   * @param path - The path of the file whose versions should be listed.
   */
  async listVersions(path: string): Promise<Array<{ versionId: string; lastModified: Date }>> {
    const allVersions: ObjectVersion[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;

    let resp;
    do {
      resp = await this.getClient().send(
        new ListObjectVersionsCommand({
          Bucket: this.getBucketName(),
          Prefix: path,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );
      allVersions.push(...(resp.Versions ?? []));
      keyMarker = resp.NextKeyMarker;
      versionIdMarker = resp.NextVersionIdMarker;
    } while (resp.IsTruncated);

    return allVersions
      .filter(
        (v): v is typeof v & { Key: string; VersionId: string; LastModified: Date } =>
          v.Key === path && v.VersionId !== undefined && v.LastModified !== undefined,
      )
      .map((v) => ({ versionId: v.VersionId, lastModified: v.LastModified }))
      .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  }
}
