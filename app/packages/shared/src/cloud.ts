import type { AuditEntry, AuditPageResult } from './audit.js';
import type { RunLock, RunPageResult, RunRecord, RunStatus } from './runs.js';

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
   * Retrieves a specific historical version of a file by path, for stores
   * that support object versioning (e.g. a versioned S3 bucket). Used by the
   * rollback flow (#112) to read a prior tfvars version's bytes before
   * restoring them as a new head version.
   *
   * @param path - The store-relative path of the file to retrieve.
   * @param versionId - The provider-assigned version id to retrieve, as
   *   returned by {@link listVersions} or {@link put}.
   * @returns An object containing the raw file contents (`body`), or
   *   `undefined` if no file exists at the given path with that version id.
   */
  getVersion(path: string, versionId: string): Promise<{ body: Uint8Array } | undefined>;

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
   *   stored version, plus an optional `versionId` when the underlying store
   *   supports object versioning (e.g. a versioned S3 bucket) and returns one.
   */
  put(
    path: string,
    body: Uint8Array,
    opts?: { ifMatch?: string },
  ): Promise<{ etag: string; versionId?: string }>;

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
 * (e.g. `@hyveon/cloud-aws`'s `AwsRemoteFileStore`) must translate their SDK-specific
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

/**
 * Cloud-agnostic interface for appending to and paginating a game-server
 * mutation audit log. Implementations may target AWS DynamoDB, Azure Table
 * Storage, GCP Firestore, or any other backend — callers depend only on this
 * contract. No `@aws-sdk/*` shapes appear in this interface or its
 * parameter/return types.
 */
export interface AuditLogStore {
  /**
   * Appends a single audit entry to the log.
   *
   * @param entry - The entry to persist, including its `sk` (see `buildAuditSk`).
   */
  putEntry(entry: AuditEntry): Promise<void>;

  /**
   * Lists audit entries newest-first, optionally paginated.
   *
   * @param limit  - The maximum number of entries to return.
   * @param before - When provided, only entries older than this cursor
   *   (an {@link AuditEntry.sk} value, typically taken from a prior page's
   *   `nextBefore`) are returned.
   * @returns The requested page of entries plus a cursor for the next page.
   */
  listEntries(limit: number, before?: string): Promise<AuditPageResult>;
}

/**
 * Cloud-agnostic interface for persisting `terraform` plan/apply/destroy run
 * history and offloading their captured logs. Implementations may target AWS
 * DynamoDB + S3, Azure Table Storage + Blob Storage, GCP Firestore + Cloud
 * Storage, or any other backend — callers depend only on this contract. No
 * `@aws-sdk/*` shapes appear in this interface or its parameter/return
 * types.
 *
 * Also owns the apply lock (see {@link RunLock} in `runs.ts`, issue #106):
 * only one non-terminal run may be in flight at a time, and the lock's
 * source of truth is this store (e.g. a single well-known DynamoDB item)
 * rather than an in-memory flag, so it survives an app restart and is
 * consistent across implementations.
 */
export interface RunRecordStore {
  /**
   * Creates or overwrites a run record, keyed on {@link RunRecord.sk}. Called
   * once the run's process has closed, with `status`/`exitCode`/`completedAt`
   * (and, depending on whether the log was embedded or offloaded,
   * `logInline` or `logS3Key`) already populated.
   *
   * @param record - The record to persist, including its `sk` (see `buildRunSk`).
   */
  putRecord(record: RunRecord): Promise<void>;

  /**
   * Looks up a previously persisted run record by its `runId` (as opposed to
   * `putRecord`'s `sk`-based keying), since callers such as the apply-status
   * IPC handler only have the `runId` minted at run start and not the
   * `<startedAt>#<runId>` sort key.
   *
   * @param runId - Unique identifier of the run to look up (matches
   *   {@link RunRecord.runId}).
   * @returns The matching {@link RunRecord}, or `undefined` if no record with
   *   that `runId` exists in the store.
   */
  getRecordByRunId(runId: string): Promise<RunRecord | undefined>;

  /**
   * Lists run records newest-first, optionally paginated and/or filtered to
   * a single {@link RunStatus}.
   *
   * @param opts - Listing options:
   * - `limit` - The maximum number of records to return.
   * - `before` - When provided, only records older than this cursor (a
   *   {@link RunRecord.sk} value, typically taken from a prior page's
   *   `nextBefore`) are returned.
   * - `status` - When provided, only records with this {@link RunStatus} are
   *   returned, served via the `status-index` GSI rather than a scan of the
   *   whole partition.
   * @returns The requested page of records plus a cursor for the next page.
   */
  listRuns(opts: { limit: number; before?: string; status?: RunStatus }): Promise<RunPageResult>;

  /**
   * Writes a run's captured log to the remote file store, keyed by `runId`.
   *
   * @param runId - Unique identifier of the run the log belongs to.
   * @param body  - The raw log contents to store.
   * @returns The store-assigned key the log was written under, suitable for
   *   passing to {@link RunRecordStore.getLogUrl} and for stashing on
   *   {@link RunRecord.logS3Key}.
   */
  putLog(runId: string, body: Uint8Array): Promise<string>;

  /**
   * Resolves a temporary, publicly-fetchable URL for a previously stored log.
   *
   * @param logKey - The key returned by a prior {@link RunRecordStore.putLog} call.
   * @param expiresInSeconds - How long the returned URL should remain valid, in
   *   seconds. Implementations may apply their own default when omitted.
   * @returns A presigned/temporary URL the caller can fetch the log from directly.
   */
  getLogUrl(logKey: string, expiresInSeconds?: number): Promise<string>;

  /**
   * Attempts to atomically acquire the apply lock on behalf of a new run,
   * guarding against two simultaneous `terraform` plan/apply/destroy
   * submissions (`RunService.createRun`, desktop-main, #106). Implementations
   * must perform the check-and-set atomically (e.g. a DynamoDB conditional
   * `PutItem` against a single well-known lock item) rather than as a
   * separate `getRunLock` read followed by a write, which would leave a race
   * window between two concurrent callers.
   *
   * @param lock - The lock to acquire on behalf of the run about to start.
   * @throws A `RunLockHeldError` (see `errors.ts`) carrying the currently
   *   held lock when an unexpired lock already exists.
   */
  acquireRunLock(lock: RunLock): Promise<void>;

  /**
   * Reads the apply lock currently on record, if any, without regard to
   * whether it has expired — callers pass the result through
   * `isRunLockExpired` (see `runs.ts`) themselves to decide whether a stale
   * lock (left behind by a crashed/orphaned process) should be treated as
   * released.
   *
   * @returns The current {@link RunLock}, or `undefined` if no run currently
   *   holds the lock.
   */
  getRunLock(): Promise<RunLock | undefined>;

  /**
   * Releases the apply lock, scoped to the given `runId` so a caller can
   * never release a lock it doesn't itself hold (e.g. a delayed cleanup from
   * one run racing another run that has since legitimately acquired the
   * lock). Implementations should no-op — rather than throw — when no lock
   * is currently held, or when the held lock's `runId` doesn't match the one
   * supplied here.
   *
   * @param runId - The `runId` of the run releasing the lock (matches
   *   {@link RunLock.runId}).
   */
  releaseRunLock(runId: string): Promise<void>;
}
