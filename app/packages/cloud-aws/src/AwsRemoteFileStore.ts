import type { RemoteFileStore } from '@hyveon/shared';

/**
 * AWS implementation of the cloud-agnostic {@link RemoteFileStore} contract.
 *
 * This is currently a stub — every method throws until the AWS SDK-backed
 * logic (S3) lands in follow-up tasks. The class exists so the shape of the
 * store is fixed early and downstream wiring (DI, module registration) can
 * be built against a real type.
 */
export class AwsRemoteFileStore implements RemoteFileStore {
  /**
   * Retrieves the body and etag of a remote file.
   *
   * @param _path - The path of the file to retrieve.
   */
  get(_path: string): Promise<{ body: Uint8Array; etag: string } | undefined> {
    throw new Error('Not implemented: get — see Epic #137');
  }

  /**
   * Writes a remote file, optionally conditioned on a matching etag.
   *
   * @param _path - The path of the file to write.
   * @param _body - The bytes to store.
   * @param _opts - Optional write options, e.g. an `ifMatch` etag for optimistic concurrency.
   */
  put(_path: string, _body: Uint8Array, _opts?: { ifMatch?: string }): Promise<{ etag: string }> {
    throw new Error('Not implemented: put — see Epic #137');
  }

  /**
   * Lists the known versions of a remote file.
   *
   * @param _path - The path of the file whose versions should be listed.
   */
  listVersions(_path: string): Promise<Array<{ versionId: string; lastModified: Date }>> {
    throw new Error('Not implemented: listVersions — see Epic #137');
  }
}
