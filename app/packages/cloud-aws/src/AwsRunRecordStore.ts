import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { RunLockHeldError } from '@hyveon/shared';
import type { RunLock, RunPageResult, RunRecord, RunRecordStore, RunStatus } from '@hyveon/shared';
import { resolveDefaultAwsRegion } from './awsRegionEnv.js';

/**
 * The single DynamoDB partition every run record lives under (`pk = RUN`).
 * The table's sort key (`sk`, see `buildRunSk` in `@hyveon/shared/runs.js`)
 * is `<ISO startedAt>#<runId>`, matching `terraform/aws/runs_store.tf`.
 */
const PARTITION_KEY = 'RUN';

/**
 * Name of the `status-index` GSI (hash key `status`, range key `startedAt`)
 * that status-filtered {@link AwsRunRecordStore.listRuns} queries switch to
 * — see `terraform/aws/runs_store.tf`.
 */
const STATUS_INDEX_NAME = 'status-index';

/**
 * The single, well-known item the apply lock lives under: a dedicated
 * partition (`pk = "LOCK"`) separate from the `pk = "RUN"` partition ordinary
 * {@link RunRecord} items live in, with a fixed sort key (`sk = "CURRENT"`)
 * since there is ever only one outstanding lock (see `terraform/aws/runs_store.tf`
 * and `RunRecordStore.acquireRunLock` in `@hyveon/shared/cloud.js`).
 */
const LOCK_PK = 'LOCK';
const LOCK_SK = 'CURRENT';

/**
 * How long a presigned log URL remains valid when the caller doesn't supply
 * an explicit `expiresInSeconds` to {@link AwsRunRecordStore.getLogUrl}.
 */
const DEFAULT_PRESIGNED_URL_EXPIRY_SECONDS = 3600;

/**
 * Builds the S3 key a run's captured log is stored under, keyed by `runId`
 * so a run's log is always addressable without consulting the DynamoDB
 * record first.
 *
 * @param runId - Unique identifier of the run the log belongs to.
 * @returns The `runs/<runId>.log` S3 key.
 */
function buildLogKey(runId: string): string {
  return `runs/${runId}.log`;
}

/**
 * Recovers the `startedAt` portion of a {@link RunRecord.sk} value
 * (`<startedAt>#<runId>`, see `buildRunSk` in `@hyveon/shared/runs.js`), so
 * a `sk`-shaped listing cursor can be compared against the `status-index`
 * GSI's `startedAt` range key. Splits on the first `#` — safe because ISO-8601
 * timestamps never contain that character.
 *
 * @param sk - A {@link RunRecord.sk} value.
 * @returns The `startedAt` prefix of `sk`.
 */
function parseStartedAtFromSk(sk: string): string {
  return sk.slice(0, sk.indexOf('#'));
}

/**
 * AWS implementation of the cloud-agnostic {@link RunRecordStore} contract,
 * backed by the DynamoDB run-history table provisioned in
 * `terraform/aws/runs_store.tf` (`pk = RUN`, `sk` = `buildRunSk()`) for
 * record metadata, and an S3 bucket for offloaded run logs (see
 * {@link buildLogKey}). No `@aws-sdk/*` shapes appear outside this class's
 * private fields/method bodies, so callers depend only on
 * {@link RunRecordStore}.
 */
export class AwsRunRecordStore implements RunRecordStore {
  private dynamoClient: DynamoDBDocumentClient | null = null;
  private dynamoClientRegion: string | null = null;
  private s3Client: S3Client | null = null;
  private s3ClientRegion: string | null = null;

  /**
   * @param getConfig - Resolves the DynamoDB table and S3 bucket (and
   *   optional region) this store reads/writes, on every call — so a
   *   rename picked up between calls (e.g. after a Terraform re-apply)
   *   isn't stuck targeting a stale table/bucket. Optional so the class
   *   remains constructible with no arguments, mirroring
   *   `AwsAuditLogStore`/`AwsRemoteFileStore`'s zero-arg-constructible
   *   pattern. When omitted (or when it returns no `tableName`/`bucket`),
   *   the relevant methods throw a clear "not configured" error rather
   *   than sending a malformed request. When `region` is omitted, it falls
   *   back to {@link resolveDefaultAwsRegion} — never read from
   *   `process.env` directly here, per CLAUDE.md's "no raw `process.env`
   *   in business logic" guideline.
   */
  constructor(
    private readonly getConfig?: () => { tableName: string; bucket: string; region?: string },
  ) {}

  /**
   * Resolves the configured table name, throwing a clear error instead of
   * letting an unconfigured table fall through to a malformed DynamoDB
   * request.
   */
  private getTableName(): string {
    const tableName = this.getConfig?.()?.tableName;
    if (!tableName) {
      throw new Error(
        'AwsRunRecordStore: table not configured. Supply a getConfig callback that resolves { tableName }.',
      );
    }
    return tableName;
  }

  /**
   * Resolves the configured bucket name, throwing a clear error instead of
   * letting an unconfigured bucket fall through to a malformed S3 request.
   */
  private getBucketName(): string {
    const bucket = this.getConfig?.()?.bucket;
    if (!bucket) {
      throw new Error(
        'AwsRunRecordStore: bucket not configured. Supply a getConfig callback that resolves { bucket }.',
      );
    }
    return bucket;
  }

  /**
   * Resolves the region to build clients with, falling back to
   * {@link resolveDefaultAwsRegion} when `getConfig` omits one.
   */
  private getRegion(): string {
    return this.getConfig?.()?.region ?? resolveDefaultAwsRegion();
  }

  /**
   * Lazily constructs the DynamoDB document client, recreating it whenever
   * the freshly-resolved region differs from the region the cached client
   * was built with — mirrors `AwsAuditLogStore.getClient`'s
   * rebuild-on-region-change pattern.
   */
  private getDynamoClient(): DynamoDBDocumentClient {
    const region = this.getRegion();
    if (!this.dynamoClient || this.dynamoClientRegion !== region) {
      this.dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
      this.dynamoClientRegion = region;
    }
    return this.dynamoClient;
  }

  /**
   * Lazily constructs the S3 client, recreating it whenever the
   * freshly-resolved region differs from the region the cached client was
   * built with — same rebuild-on-region-change pattern as
   * {@link getDynamoClient}.
   */
  private getS3Client(): S3Client {
    const region = this.getRegion();
    if (!this.s3Client || this.s3ClientRegion !== region) {
      this.s3Client = new S3Client({ region });
      this.s3ClientRegion = region;
    }
    return this.s3Client;
  }

  /**
   * Creates or overwrites a run record, keyed on `pk = RUN` + {@link RunRecord.sk}.
   *
   * @param record - The record to persist, including its `sk` (see `buildRunSk`).
   */
  async putRecord(record: RunRecord): Promise<void> {
    await this.getDynamoClient().send(
      new PutCommand({
        TableName: this.getTableName(),
        Item: {
          pk: PARTITION_KEY,
          sk: record.sk,
          runId: record.runId,
          kind: record.kind,
          status: record.status,
          startedAt: record.startedAt,
          completedAt: record.completedAt,
          exitCode: record.exitCode,
          ...(record.tfvarsVersionId !== undefined ? { tfvarsVersionId: record.tfvarsVersionId } : {}),
          ...(record.logInline !== undefined ? { logInline: record.logInline } : {}),
          ...(record.logS3Key !== undefined ? { logS3Key: record.logS3Key } : {}),
        },
      }),
    );
  }

  /**
   * Looks up a previously persisted run record by its `runId`. The table's
   * sort key is `<startedAt>#<runId>` (see `buildRunSk`) rather than `runId`
   * alone, and there is no GSI keyed on `runId` (see `terraform/aws/runs_store.tf`),
   * so this queries the fixed `pk = RUN` partition and filters on `runId`,
   * paging through `LastEvaluatedKey` until a match is found or the
   * partition is exhausted — acceptable at the run-history table's expected
   * volume; a dedicated `runId`-index can be added later if this becomes a
   * hot path. `ScanIndexForward: false` walks the partition newest-`sk`-first
   * (sk is `<startedAt>#<runId>`, so lexicographic descending order is also
   * chronological descending order), so the first matching item encountered
   * — whether on the first page or a later one — is always the newest record
   * for that `runId`.
   *
   * @param runId - Unique identifier of the run to look up (matches
   *   {@link RunRecord.runId}).
   * @returns The newest matching {@link RunRecord}, or `undefined` if no
   *   record with that `runId` exists in the store.
   */
  async getRecordByRunId(runId: string): Promise<RunRecord | undefined> {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.getDynamoClient().send(
        new QueryCommand({
          TableName: this.getTableName(),
          KeyConditionExpression: 'pk = :pk',
          FilterExpression: 'runId = :runId',
          ExpressionAttributeValues: { ':pk': PARTITION_KEY, ':runId': runId },
          ExclusiveStartKey: exclusiveStartKey,
          ScanIndexForward: false,
        }),
      );
      const item = result.Items?.[0];
      if (item) {
        return this.toRunRecord(item as Record<string, unknown>);
      }
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
    return undefined;
  }

  /**
   * Lists run records newest-first, optionally paginated and/or filtered to
   * a single {@link RunStatus}.
   *
   * The unfiltered path queries the fixed `pk = RUN` partition directly,
   * constraining to `sk < :before` when a cursor is supplied (mirrors
   * `AwsAuditLogStore.listEntries`). The status-filtered path switches to
   * the {@link STATUS_INDEX_NAME} GSI (hash key `status`, range key
   * `startedAt`, `projection_type = ALL` per `terraform/aws/runs_store.tf`)
   * instead, resuming via `ExclusiveStartKey` rather than a `startedAt < :before`
   * boundary condition — a boundary condition would drop the remaining rows
   * of any same-`startedAt` group that got split across a page boundary,
   * since it excludes every item at that exact `startedAt`, not just the
   * ones already returned. `ExclusiveStartKey` needs the table's primary key
   * (`pk`, `sk`) plus the index's key (`status`, `startedAt`); all four are
   * reconstructible from the caller-supplied cursor without any extra data:
   * `pk` is always {@link PARTITION_KEY}, `sk` is `before` itself, `status`
   * is the filter already being applied to this query, and `startedAt` is
   * recovered from `before` via {@link parseStartedAtFromSk} (since `before`
   * is always a {@link RunRecord.sk} value, `<startedAt>#<runId>` — see
   * `buildRunSk`). This mirrors the exact `LastEvaluatedKey` DynamoDB itself
   * returned for the prior page, so pagination is gap-free even across ties.
   * Both paths use `ScanIndexForward: false` so DynamoDB returns
   * newest-first without an in-memory sort, and `nextBefore` is only
   * populated when DynamoDB reports a `LastEvaluatedKey` — i.e. there are
   * more rows beyond this page — set to the oldest (last) record's `sk` in
   * the page.
   *
   * @param opts - Listing options:
   * - `limit` - The maximum number of records to return.
   * - `before` - When provided, only records older than this cursor (a
   *   {@link RunRecord.sk} value) are returned.
   * - `status` - When provided, only records with this {@link RunStatus} are
   *   returned, via the `status-index` GSI.
   * @returns The requested page of records plus a cursor for the next page.
   */
  async listRuns(opts: { limit: number; before?: string; status?: RunStatus }): Promise<RunPageResult> {
    const { limit, before, status } = opts;
    const resp = status
      ? await this.getDynamoClient().send(
          new QueryCommand({
            TableName: this.getTableName(),
            IndexName: STATUS_INDEX_NAME,
            KeyConditionExpression: 'status = :status',
            ExpressionAttributeValues: { ':status': status },
            ExclusiveStartKey: before
              ? { pk: PARTITION_KEY, sk: before, status, startedAt: parseStartedAtFromSk(before) }
              : undefined,
            ScanIndexForward: false,
            Limit: limit,
          }),
        )
      : await this.getDynamoClient().send(
          new QueryCommand({
            TableName: this.getTableName(),
            KeyConditionExpression: before ? 'pk = :pk AND sk < :before' : 'pk = :pk',
            ExpressionAttributeValues: before
              ? { ':pk': PARTITION_KEY, ':before': before }
              : { ':pk': PARTITION_KEY },
            ScanIndexForward: false,
            Limit: limit,
          }),
        );

    const records = (resp.Items ?? []).map((item) => this.toRunRecord(item as Record<string, unknown>));
    const nextBefore = resp.LastEvaluatedKey ? records[records.length - 1]?.sk : undefined;
    return nextBefore ? { records, nextBefore } : { records };
  }

  /**
   * Maps a raw DynamoDB item from the `pk = RUN` partition back into a
   * {@link RunRecord}, restoring the optional fields {@link putRecord} wrote
   * conditionally.
   *
   * @param item - The raw item read back from DynamoDB.
   * @returns The reconstructed {@link RunRecord}.
   */
  private toRunRecord(item: Record<string, unknown>): RunRecord {
    const record: RunRecord = {
      sk: item['sk'] as string,
      runId: item['runId'] as string,
      kind: item['kind'] as RunRecord['kind'],
      status: item['status'] as RunRecord['status'],
      startedAt: item['startedAt'] as string,
      completedAt: item['completedAt'] as string,
      exitCode: item['exitCode'] as number | null,
    };
    if (item['tfvarsVersionId'] !== undefined) {
      record.tfvarsVersionId = item['tfvarsVersionId'] as string;
    }
    if (item['planHash'] !== undefined) {
      record.planHash = item['planHash'] as string;
    }
    if (item['approvedBy'] !== undefined) {
      record.approvedBy = item['approvedBy'] as string;
    }
    if (item['approvedAt'] !== undefined) {
      record.approvedAt = item['approvedAt'] as string;
    }
    if (item['logInline'] !== undefined) {
      record.logInline = item['logInline'] as string;
    }
    if (item['logS3Key'] !== undefined) {
      record.logS3Key = item['logS3Key'] as string;
    }
    return record;
  }

  /**
   * Writes a run's captured log to S3 under {@link buildLogKey}'s
   * `runs/<runId>.log` key.
   *
   * @param runId - Unique identifier of the run the log belongs to.
   * @param body  - The raw log contents to store.
   * @returns The `runs/<runId>.log` key the log was written under.
   */
  async putLog(runId: string, body: Uint8Array): Promise<string> {
    const key = buildLogKey(runId);
    await this.getS3Client().send(
      new PutObjectCommand({ Bucket: this.getBucketName(), Key: key, Body: body }),
    );
    return key;
  }

  /**
   * Resolves a presigned, temporary `GetObject` URL for a previously stored
   * log.
   *
   * @param logKey - The key returned by a prior {@link putLog} call.
   * @param expiresInSeconds - How long the returned URL should remain
   *   valid, in seconds. Defaults to {@link DEFAULT_PRESIGNED_URL_EXPIRY_SECONDS}.
   * @returns A presigned URL the caller can fetch the log from directly.
   */
  async getLogUrl(
    logKey: string,
    expiresInSeconds: number = DEFAULT_PRESIGNED_URL_EXPIRY_SECONDS,
  ): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.getBucketName(), Key: logKey });
    return getSignedUrl(this.getS3Client(), command, { expiresIn: expiresInSeconds });
  }

  /**
   * Attempts to atomically acquire the apply lock item (`pk = LOCK`,
   * `sk = CURRENT`) via a conditional `PutItem`: the write succeeds when no
   * lock item exists yet, or when the currently stored item's `expiresAt`
   * has already passed (a stale lock left behind by a crashed/orphaned
   * process). Any other in-flight, unexpired lock causes the condition to
   * fail, at which point the current lock is re-read and surfaced via a
   * {@link RunLockHeldError}.
   *
   * @param lock - The lock to acquire on behalf of the run about to start.
   * @throws {@link RunLockHeldError} carrying the currently held lock when an
   *   unexpired lock already exists.
   */
  async acquireRunLock(lock: RunLock): Promise<void> {
    try {
      await this.getDynamoClient().send(
        new PutCommand({
          TableName: this.getTableName(),
          Item: {
            pk: LOCK_PK,
            sk: LOCK_SK,
            runId: lock.runId,
            kind: lock.kind,
            initiator: lock.initiator,
            acquiredAt: lock.acquiredAt,
            expiresAt: lock.expiresAt,
          },
          ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
          ExpressionAttributeValues: { ':now': new Date().toISOString() },
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        const currentLock = await this.getRunLock();
        throw new RunLockHeldError(currentLock ?? lock);
      }
      throw error;
    }
  }

  /**
   * Reads the apply lock item (`pk = LOCK`, `sk = CURRENT`) currently on
   * record, if any, without regard to whether it has expired.
   *
   * @returns The current {@link RunLock}, or `undefined` if no run currently
   *   holds the lock.
   */
  async getRunLock(): Promise<RunLock | undefined> {
    const result = await this.getDynamoClient().send(
      new GetCommand({
        TableName: this.getTableName(),
        Key: { pk: LOCK_PK, sk: LOCK_SK },
      }),
    );
    const item = result.Item;
    if (!item) {
      return undefined;
    }
    return {
      runId: item['runId'] as string,
      kind: item['kind'] as RunLock['kind'],
      initiator: item['initiator'] as string,
      acquiredAt: item['acquiredAt'] as string,
      expiresAt: item['expiresAt'] as string,
    };
  }

  /**
   * Releases the apply lock item, scoped to `runId` via a conditional
   * `DeleteItem` so a caller can never release a lock it doesn't itself
   * hold. No-ops (rather than throwing) both when no lock item exists and
   * when the held lock's `runId` doesn't match the one supplied here.
   *
   * @param runId - The `runId` of the run releasing the lock (matches
   *   {@link RunLock.runId}).
   */
  async releaseRunLock(runId: string): Promise<void> {
    try {
      await this.getDynamoClient().send(
        new DeleteCommand({
          TableName: this.getTableName(),
          Key: { pk: LOCK_PK, sk: LOCK_SK },
          ConditionExpression: 'runId = :runId',
          ExpressionAttributeValues: { ':runId': runId },
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return;
      }
      throw error;
    }
  }
}
