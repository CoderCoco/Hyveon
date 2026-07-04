/** Options for launching a game workload. Intentionally open/opaque for v1; implementations may accept provider-specific keys or refine this via intersection. */
export interface StartOpts {
  [key: string]: unknown;
}

/** Opaque handle returned by startWorkload — uniquely identifies the launched workload within the provider. */
export interface WorkloadHandle {
  workloadId: string;
}

/** Cloud-agnostic status of a game workload. */
export interface WorkloadStatus {
  state: 'running' | 'starting' | 'stopped' | 'not_deployed' | 'error';
  /** Provider-assigned workload identifier (replaces cloud-specific IDs such as task ARNs). */
  workloadId?: string;
  publicIp?: string;
  hostname?: string;
  message?: string;
}

/** A single timestamped log entry streamed from a running workload. */
export interface LogChunk {
  message: string;
  timestamp: Date;
}

/**
 * Cloud-agnostic cost snapshot. Shared return type for both forward-looking
 * estimates (getCostEstimate) and billed actuals (getActualCosts).
 */
export interface CostBreakdown {
  /** Total cost across all items in the breakdown. */
  total: number;
  currency: string;
  /** Per-game or per-service cost keyed by name. */
  breakdown: Record<string, number>;
}

/** Closed date interval used by getActualCosts to scope the billing query. */
export interface DateRange {
  start: Date;
  end: Date;
}

/**
 * Cloud-provider abstraction. No `@aws-sdk/*` shapes appear in this interface
 * or its parameter/return types. Concrete implementations live in provider
 * packages (e.g. `@hyveon/cloud-aws`).
 */
export interface CloudProvider {
  startWorkload(game: string, opts: StartOpts): Promise<WorkloadHandle>;
  stopWorkload(game: string): Promise<void>;
  getWorkloadStatus(game: string): Promise<WorkloadStatus>;
  streamWorkloadLogs(game: string, signal: AbortSignal): AsyncIterable<LogChunk>;
  getCostEstimate(): Promise<CostBreakdown>;
  getActualCosts(range: DateRange): Promise<CostBreakdown>;
}

/**
 * Cloud-agnostic interface for reading and writing secrets in a key-value store.
 * Implementations may target AWS Secrets Manager, Azure Key Vault, GCP Secret Manager,
 * or any other backend — callers depend only on this contract.
 */
export interface SecretsStore {
  /**
   * Retrieves the value of a secret by name.
   *
   * @param name - The name (identifier) of the secret to retrieve.
   * @returns The secret value as a string, or `undefined` if no secret with
   *   that name exists in the store.
   */
  get(name: string): Promise<string | undefined>;

  /**
   * Stores a secret value under the given name, creating or overwriting the
   * secret as needed.
   *
   * @param name  - The name (identifier) to store the secret under.
   * @param value - The plaintext value to store.
   */
  put(name: string, value: string): Promise<void>;

  /**
   * Checks whether a secret with the given name exists in the store.
   *
   * @param name - The name (identifier) to look up.
   * @returns `true` if the secret exists, `false` otherwise.
   */
  exists(name: string): Promise<boolean>;
}

/**
 * Cloud-agnostic interface for reading and writing versioned binary files in a
 * remote object store. Implementations may target AWS S3, Azure Blob Storage,
 * GCP Cloud Storage, or any other backend — callers depend only on this contract.
 * No `@aws-sdk/*` shapes appear in this interface or its parameter/return types.
 */
export interface RemoteFileStore {
  /**
   * Retrieves the current version of a file by path.
   *
   * @param path - The store-relative path of the file to retrieve.
   * @returns An object containing the raw file contents (`body`) and the
   *   provider-assigned entity tag (`etag`), or `undefined` if no file
   *   exists at the given path.
   */
  get(path: string): Promise<{ body: Uint8Array; etag: string } | undefined>;

  /**
   * Writes a file to the store at the given path, creating or overwriting it.
   * Supports optimistic concurrency via an optional `ifMatch` etag guard — if
   * provided, the write is rejected (provider throws) when the stored etag no
   * longer matches, preventing lost-update races.
   *
   * @param path - The store-relative path to write the file to.
   * @param body - The raw file contents to store.
   * @param opts - Optional write options. When `opts.ifMatch` is set, the write
   *   only succeeds when the current stored etag matches this value (optimistic
   *   concurrency guard).
   * @returns An object containing the provider-assigned etag for the newly
   *   stored version.
   */
  put(path: string, body: Uint8Array, opts?: { ifMatch?: string }): Promise<{ etag: string }>;

  /**
   * Lists all available versions of a file in reverse-chronological order.
   *
   * @param path - The store-relative path of the file to query.
   * @returns An array of version descriptors, each containing a provider-
   *   assigned `versionId` and the `lastModified` timestamp for that version.
   */
  listVersions(path: string): Promise<Array<{ versionId: string; lastModified: Date }>>;
}

/**
 * Thrown by `RemoteFileStore.put` implementations when an optimistic
 * concurrency guard (`opts.ifMatch`) is provided but no longer matches the
 * etag currently stored at `path` — i.e. the remote file was modified by
 * another writer since the caller last read it. Cloud-agnostic: providers
 * (e.g. `@hyveon/cloud-aws`'s `AwsS3Store`) must translate their SDK-specific
 * precondition-failure errors into this type before surfacing them to callers.
 */
export class RemoteFileConflictError extends Error {
  /** The store-relative path of the file that failed the conflict check. */
  readonly path: string;

  /** The stale `ifMatch` etag that was provided for the conflicting write, if any. */
  readonly ifMatch?: string;

  /**
   * @param path - The store-relative path of the file that failed the
   *   conflict check.
   * @param message - Optional human-readable message; defaults to a message
   *   derived from `path`.
   * @param ifMatch - Optional stale `ifMatch` etag that was provided for the
   *   conflicting write.
   */
  constructor(path: string, message?: string, ifMatch?: string) {
    super(message ?? `Conflicting write detected for file at path: ${path}`);
    this.name = 'RemoteFileConflictError';
    this.path = path;
    this.ifMatch = ifMatch;
    Object.setPrototypeOf(this, RemoteFileConflictError.prototype);
  }
}

/**
 * Cloud-agnostic interface for resolving the Discord interactions endpoint URL
 * from provider-managed configuration (e.g. an API Gateway invoke URL stored in
 * infrastructure state or a secrets store). Callers depend only on this contract;
 * no `@aws-sdk/*` shapes appear in this interface or its parameter/return types.
 */
export interface DiscordEventReceiver {
  /**
   * Resolves the public HTTPS URL that Discord will POST interaction events to.
   *
   * @returns The fully-qualified interactions endpoint URL registered with Discord
   *   (e.g. a custom domain or provider-managed public URL), or `null` if no
   *   endpoint has been configured or provisioned yet.
   */
  getInteractionEndpointUrl(): Promise<string | null>;
}
