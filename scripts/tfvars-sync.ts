#!/usr/bin/env -S npx tsx
/**
 * tfvars-sync.ts
 *
 * CLI mirror of the app's `RemoteTfvarsStore` service: pulls, pushes, diffs,
 * and reports status for a `terraform.tfvars` file stored in the versioned
 * S3 bucket provisioned by `terraform/bootstrap` (see
 * `docs/docs/setup.md` for the bootstrap flow).
 *
 * Usage:
 *   tsx tfvars-sync.ts pull   [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
 *   tsx tfvars-sync.ts push   [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
 *   tsx tfvars-sync.ts diff   [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
 *   tsx tfvars-sync.ts status [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
 *
 * `--path` defaults to `terraform/terraform.tfvars` and is the local file to
 * sync. `--key` defaults to `terraform.tfvars` and is the S3 object key —
 * pass it explicitly if the bucket should hold the object under a different
 * key than the local file's basename.
 *
 * `--bucket` is resolved through a fallback chain when the flag is omitted:
 * the `GSD_TFVARS_BUCKET` environment variable, then the contents of the
 * nearest `.gsd/tfvars-bucket` marker file found walking up from the current
 * working directory. The CLI exits with an error if none of these resolve.
 *
 * A sidecar lock file (`${path}.lock`) records the S3 version id + etag
 * observed on the last successful `pull` or `push`. `push` refuses to
 * overwrite the remote object if the lock is missing (never pulled) or
 * stale (someone else pushed since the last pull) — run `pull` again to
 * resolve. That version check and the upload itself are also raced against
 * each other with an S3 conditional write (`IfMatch: <locked etag>` on the
 * `PutObject` call): if another push slips in between our `HeadObject`
 * check and the write, S3 rejects it with 412 and we surface the same
 * `VersionMismatchError` rather than silently overwriting.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit, stdout as output } from 'node:process';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createTwoFilesPatch } from 'diff';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default local path when `--path` is omitted from the CLI. */
const DEFAULT_PATH = 'terraform/terraform.tfvars';

/** Default S3 object key when `--key` is omitted from the CLI (and no `opts.key` is set). */
const DEFAULT_KEY = 'terraform.tfvars';

/** Environment variable consulted by the `--bucket` fallback chain. */
const BUCKET_ENV_VAR = 'GSD_TFVARS_BUCKET';

/** Marker file (relative to a project root) holding the bucket name, as a last-resort fallback. */
const BUCKET_MARKER_PATH = ['.gsd', 'tfvars-bucket'];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Options shared by every sync operation. */
export interface TfvarsSyncOptions {
  /** S3 bucket that holds the tfvars object. */
  bucket: string;
  /** Local file path to read from / write to. */
  path: string;
  /** S3 object key. Defaults to the local path's basename when omitted. */
  key?: string;
  /** Optional AWS region override; falls back to the SDK's default provider chain. */
  region?: string;
  /** Optional pre-built S3 client, so callers/tests can inject a mocked client. Defaults to `new S3Client({ region })`. */
  client?: S3Client;
}

/**
 * Sidecar metadata written to `${path}.lock` after a successful pull or push.
 *
 * `versionId` is `null` (never `''`) when S3 reports no `VersionId` — i.e.
 * the bucket is unversioned or versioning is suspended — so it compares
 * equal to `RemoteHead.versionId`'s own `null` in that same situation
 * instead of tripping a spurious `VersionMismatchError`.
 */
export interface LockFile {
  bucket: string;
  key: string;
  versionId: string | null;
  etag: string;
  size: number;
  lastModified: string | null;
  pulledAt: string;
}

/** Metadata describing the current remote object, or its absence. */
export interface RemoteHead {
  exists: boolean;
  versionId: string | null;
  etag: string | null;
  size: number | null;
  lastModified: string | null;
}

export interface PullResult {
  path: string;
  lockPath: string;
  lock: LockFile;
}

export interface PushResult {
  path: string;
  lockPath: string;
  lock: LockFile;
}

export interface DiffResult {
  /** True when the local file's contents are byte-for-byte identical to the remote object. */
  matches: boolean;
  /** Unified diff (remote → local), empty-hunk when `matches` is true. */
  patch: string;
}

export interface StatusReport {
  bucket: string;
  key: string;
  path: string;
  localExists: boolean;
  lock: LockFile | null;
  remote: RemoteHead;
  /** True when the local lock's version id matches the remote object's current version id. */
  inSync: boolean;
}

/** Thrown by `pushTfvars()` when the local lock doesn't match (or is missing for) the current remote version. */
export class VersionMismatchError extends Error {
  constructor(
    message: string,
    public readonly localVersion: string | null,
    public readonly remoteVersion: string | null,
  ) {
    super(message);
    this.name = 'VersionMismatchError';
  }
}

/**
 * Thrown by `pushTfvars()` when the remote object exists but S3 reports no
 * `VersionId` for it — the bucket is unversioned or has versioning
 * suspended, so the version-based conflict check that guards concurrent
 * edits cannot function. This is distinct from `VersionMismatchError`
 * because there is no stale/missing lock to fix by re-pulling; the bucket
 * itself needs versioning enabled.
 */
export class BucketNotVersionedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BucketNotVersionedError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns `opts.client` when provided, otherwise builds a fresh `S3Client` from `opts.region`. */
function resolveClient(opts: Pick<TfvarsSyncOptions, 'region' | 'client'>): S3Client {
  return opts.client ?? new S3Client({ region: opts.region });
}

/** Derives the S3 object key: `opts.key` when set, otherwise the local path's basename. */
function keyFor(opts: Pick<TfvarsSyncOptions, 'path' | 'key'>): string {
  return opts.key ?? basename(opts.path);
}

function lockPathFor(path: string): string {
  return `${path}.lock`;
}

function stripQuotes(etag: string | undefined): string {
  return (etag ?? '').replace(/^"|"$/g, '');
}

/** Reads the sidecar lock file, if present and parseable. */
function readLock(path: string): LockFile | null {
  const lockPath = lockPathFor(path);
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')) as LockFile;
  } catch {
    return null;
  }
}

function writeLock(path: string, lock: LockFile): void {
  writeFileSync(lockPathFor(path), `${JSON.stringify(lock, null, 2)}\n`);
}

/** True for the shapes the AWS SDK v3 uses to signal a missing S3 object. */
function isNotFound(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const name = (err as { name?: string }).name;
    if (name === 'NotFound' || name === 'NoSuchKey') return true;
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return true;
  }
  return false;
}

/** True for the shapes the AWS SDK v3 uses to signal a failed `IfMatch` conditional write (HTTP 412). */
function isPreconditionFailed(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const name = (err as { name?: string }).name;
    if (name === 'PreconditionFailed') return true;
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 412) return true;
  }
  return false;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** HeadObject against the bucket/key, normalized to a `RemoteHead` (never throws on 404). */
async function headRemote(s3: S3Client, bucket: string, key: string): Promise<RemoteHead> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      exists: true,
      versionId: head.VersionId ?? null,
      etag: stripQuotes(head.ETag) || null,
      size: head.ContentLength ?? null,
      lastModified: head.LastModified ? head.LastModified.toISOString() : null,
    };
  } catch (err) {
    if (isNotFound(err)) {
      return { exists: false, versionId: null, etag: null, size: null, lastModified: null };
    }
    throw err;
  }
}

/**
 * Walks up from `startDir` looking for a `.gsd/tfvars-bucket` marker file.
 * Returns its trimmed contents (the bucket name) if found and non-empty.
 */
function findBucketMarker(startDir: string): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    const markerPath = join(dir, ...BUCKET_MARKER_PATH);
    if (existsSync(markerPath)) {
      const content = readFileSync(markerPath, 'utf8').trim();
      if (content) return content;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolves the target S3 bucket: an explicit value wins, then the
 * `GSD_TFVARS_BUCKET` environment variable, then the contents of the
 * nearest `.gsd/tfvars-bucket` marker file walking up from `startDir`.
 */
export function resolveBucket(explicit?: string, startDir: string = process.cwd()): string | undefined {
  if (explicit) return explicit;
  if (process.env[BUCKET_ENV_VAR]) return process.env[BUCKET_ENV_VAR];
  return findBucketMarker(startDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Downloads the remote tfvars object to `opts.path` and writes a matching
 * lock file recording the version just pulled.
 */
export async function pullTfvars(opts: TfvarsSyncOptions): Promise<PullResult> {
  const s3 = resolveClient(opts);
  const key = keyFor(opts);

  let response;
  try {
    response = await s3.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key }));
  } catch (err) {
    throw new Error(`Failed to pull s3://${opts.bucket}/${key}: ${errorMessage(err)}`);
  }

  const content = (await response.Body?.transformToString()) ?? '';
  const dir = dirname(opts.path);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
  writeFileSync(opts.path, content);

  const lock: LockFile = {
    bucket: opts.bucket,
    key,
    versionId: response.VersionId ?? null,
    etag: stripQuotes(response.ETag),
    size: response.ContentLength ?? Buffer.byteLength(content),
    lastModified: response.LastModified ? response.LastModified.toISOString() : null,
    pulledAt: new Date().toISOString(),
  };
  writeLock(opts.path, lock);

  return { path: opts.path, lockPath: lockPathFor(opts.path), lock };
}

/**
 * Uploads the local tfvars file to the remote bucket, refusing to do so if
 * the remote object has moved on since the last `pull` (or was never pulled
 * at all). On success, refreshes the lock file with the newly-created
 * version id.
 */
export async function pushTfvars(opts: TfvarsSyncOptions): Promise<PushResult> {
  if (!existsSync(opts.path)) {
    throw new Error(`Local file not found: ${opts.path}`);
  }

  const s3 = resolveClient(opts);
  const key = keyFor(opts);
  const lock = readLock(opts.path);
  const remote = await headRemote(s3, opts.bucket, key);

  if (remote.exists) {
    if (remote.versionId === null) {
      throw new BucketNotVersionedError(
        `Bucket "${opts.bucket}" does not appear to have S3 versioning enabled (HeadObject returned no VersionId for s3://${opts.bucket}/${key}). The version-based conflict check that "push" relies on requires a versioned bucket — enable versioning on "${opts.bucket}" before pushing.`,
      );
    }
    if (!lock) {
      throw new VersionMismatchError(
        `Remote object s3://${opts.bucket}/${key} already exists but no local lock file was found at ${lockPathFor(opts.path)}. Run "pull" first.`,
        null,
        remote.versionId,
      );
    }
    if (lock.versionId !== remote.versionId) {
      throw new VersionMismatchError(
        `Local lock version "${lock.versionId}" does not match remote version "${remote.versionId}" for s3://${opts.bucket}/${key}. Run "pull" to refresh before pushing.`,
        lock.versionId,
        remote.versionId,
      );
    }
  }

  const body = readFileSync(opts.path);

  // Guard the window between the HeadObject check above and this write with an
  // S3 conditional write, so a concurrent push that slips in between the head
  // check and this PutObject fails with 412 instead of silently overwriting.
  // For an existing remote object, pass `IfMatch` whenever a lock is on file.
  // For a brand-new object (no remote object observed above), pass
  // `IfNoneMatch: '*'` so a concurrent first-ever push also fails with 412
  // instead of one silently clobbering the other. The head check above still
  // runs first purely to produce a friendlier, more specific error message
  // for the common (non-racy) case.
  let put;
  try {
    put = await s3.send(
      new PutObjectCommand({
        Bucket: opts.bucket,
        Key: key,
        Body: body,
        ...(remote.exists && lock ? { IfMatch: `"${lock.etag}"` } : {}),
        ...(!remote.exists ? { IfNoneMatch: '*' } : {}),
      }),
    );
  } catch (err) {
    if (isPreconditionFailed(err)) {
      throw new VersionMismatchError(
        `Remote object s3://${opts.bucket}/${key} changed after the version check (concurrent push detected). Run "pull" to refresh before pushing.`,
        lock?.versionId ?? null,
        null,
      );
    }
    throw err;
  }

  const newLock: LockFile = {
    bucket: opts.bucket,
    key,
    versionId: put.VersionId ?? null,
    etag: stripQuotes(put.ETag),
    size: body.byteLength,
    lastModified: new Date().toISOString(),
    pulledAt: new Date().toISOString(),
  };
  writeLock(opts.path, newLock);

  return { path: opts.path, lockPath: lockPathFor(opts.path), lock: newLock };
}

/**
 * Compares the local file against the remote object and returns a unified
 * diff (remote → local). `matches` is true only when both sides are
 * byte-identical.
 */
export async function diffTfvars(opts: TfvarsSyncOptions): Promise<DiffResult> {
  const s3 = resolveClient(opts);
  const key = keyFor(opts);

  const localContent = existsSync(opts.path) ? readFileSync(opts.path, 'utf8') : '';

  let remoteContent = '';
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key }));
    remoteContent = (await response.Body?.transformToString()) ?? '';
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  const matches = localContent === remoteContent;
  const patch = createTwoFilesPatch(`remote:${key}`, `local:${opts.path}`, remoteContent, localContent);

  return { matches, patch };
}

/**
 * Reports the local lock metadata alongside the remote object's current
 * head metadata, plus whether the two agree on version id.
 */
export async function lockStatus(opts: TfvarsSyncOptions): Promise<StatusReport> {
  const s3 = resolveClient(opts);
  const key = keyFor(opts);
  const lock = readLock(opts.path);
  const remote = await headRemote(s3, opts.bucket, key);
  const inSync = Boolean(lock && remote.versionId && lock.versionId === remote.versionId);

  return {
    bucket: opts.bucket,
    key,
    path: opts.path,
    localExists: existsSync(opts.path),
    lock,
    remote,
    inSync,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const COMMANDS = ['pull', 'push', 'diff', 'status'] as const;
type Command = (typeof COMMANDS)[number];

interface ParsedArgs {
  command: Command;
  options: TfvarsSyncOptions;
}

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value);
}

/**
 * Parses `<command> [--bucket <b>] [--path <p>] [--key <k>] [--region <r>]`
 * argv (excluding node + script). `--path` defaults to
 * `terraform/terraform.tfvars` and `--key` to `terraform.tfvars`. `--bucket`
 * is resolved via `resolveBucket()` (flag > `GSD_TFVARS_BUCKET` env var >
 * `.gsd/tfvars-bucket` marker file) and throws if nothing resolves.
 */
export function parseArgs(rawArgv: string[]): ParsedArgs {
  const [command, ...rest] = rawArgv;
  if (!isCommand(command)) {
    throw new Error(
      `Usage: tfvars-sync.ts <${COMMANDS.join('|')}> [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]`,
    );
  }

  let bucket: string | undefined;
  let path: string | undefined;
  let key: string | undefined;
  let region: string | undefined;

  const KNOWN_FLAGS = ['--bucket', '--path', '--key', '--region'] as const;

  /**
   * Consumes the value following a recognized flag, throwing if it is
   * missing or looks like another flag — guards against typos such as a
   * trailing `--bucket` with no value silently falling through to the
   * bucket-resolution fallback chain.
   */
  function readValue(flag: string, index: number): string {
    const value = rest[index];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--bucket') bucket = readValue(arg, ++i);
    else if (arg === '--path') path = readValue(arg, ++i);
    else if (arg === '--key') key = readValue(arg, ++i);
    else if (arg === '--region') region = readValue(arg, ++i);
    else {
      throw new Error(
        `Unrecognized argument '${arg}'. Known flags: ${KNOWN_FLAGS.join(', ')}`,
      );
    }
  }

  const resolvedBucket = resolveBucket(bucket);
  if (!resolvedBucket) {
    throw new Error(
      `--bucket is required (or set ${BUCKET_ENV_VAR}, or create a ${join(...BUCKET_MARKER_PATH)} marker file)`,
    );
  }

  return {
    command,
    options: {
      bucket: resolvedBucket,
      path: path ?? DEFAULT_PATH,
      key: key ?? DEFAULT_KEY,
      region,
    },
  };
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(argv.slice(2));

  switch (command) {
    case 'pull': {
      const result = await pullTfvars(options);
      output.write(`✓ Pulled s3://${options.bucket}/${result.lock.key} → ${result.path}\n`);
      output.write(`  lock written to ${result.lockPath} (version ${result.lock.versionId})\n`);
      return;
    }
    case 'push': {
      const result = await pushTfvars(options);
      output.write(`✓ Pushed ${result.path} → s3://${options.bucket}/${result.lock.key}\n`);
      output.write(`  lock written to ${result.lockPath} (version ${result.lock.versionId})\n`);
      return;
    }
    case 'diff': {
      const result = await diffTfvars(options);
      if (result.patch.trim()) output.write(result.patch);
      if (result.matches) {
        output.write('✓ local and remote match\n');
      } else {
        output.write('✗ local and remote differ\n');
        process.exitCode = 1;
      }
      return;
    }
    case 'status': {
      const result = await lockStatus(options);
      output.write(`bucket: ${result.bucket}\n`);
      output.write(`key:    ${result.key}\n`);
      output.write(`path:   ${result.path} (${result.localExists ? 'exists' : 'missing'})\n`);
      output.write('\nlock:\n');
      if (result.lock) {
        output.write(`  version:       ${result.lock.versionId}\n`);
        output.write(`  etag:          ${result.lock.etag}\n`);
        output.write(`  pulled at:     ${result.lock.pulledAt}\n`);
      } else {
        output.write('  (none — never pulled)\n');
      }
      output.write('\nremote head:\n');
      if (result.remote.exists) {
        output.write(`  version:       ${result.remote.versionId}\n`);
        output.write(`  etag:          ${result.remote.etag}\n`);
        output.write(`  last modified: ${result.remote.lastModified}\n`);
      } else {
        output.write('  (object does not exist)\n');
      }
      output.write(`\nin sync: ${result.inSync ? 'yes' : 'no'}\n`);
      return;
    }
  }
}

// Only run when this file is the entry point — keeps the exported functions
// importable from tests without auto-launching the CLI. Compare normalized
// absolute paths so relative invocations (e.g. `tsx tfvars-sync.ts`) still
// match.
const isEntrypoint =
  argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(argv[1]);

if (isEntrypoint) {
  main().catch((err) => {
    process.stderr.write(`\n✗ ${errorMessage(err)}\n`);
    exit(1);
  });
}
