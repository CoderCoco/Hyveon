import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type {
  DestroyResult,
  EngineEvent,
  OutputMap,
  PreviewResult,
  PulumiFn,
  Stack,
  UpResult,
} from '@pulumi/pulumi/automation/index.js';
import { createInfraProgram } from '@hyveon/infra';
import { CONFIGURATION_OBJECT_KEY, diffDeploymentConfig, isApprovalExpired } from '@hyveon/shared';
import type {
  ChangeSummary,
  DeploymentConfig,
  DeploymentConfigDiff,
  OpType,
  RemoteFileStore,
  RunKind,
  RunLock,
  RunRecord,
  RunStatus,
  StackOutputs,
} from '@hyveon/shared';
import { logger } from '../logger.js';
import { REMOTE_FILE_STORE } from '../modules/cloud-provider.tokens.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import {
  PulumiEngineService,
  PulumiEngineNetworkError,
  PulumiEngineIntegrityError,
  PulumiEngineCacheWriteError,
} from './PulumiEngineService.js';
import type { PulumiPhaseCallback, PulumiProvisioningPhase } from './PulumiEngineService.js';
import {
  PULUMI_PROJECT_NAME,
  PULUMI_STACK_NAME,
  PulumiWorkspaceService,
  PulumiPassphraseUnavailableError,
} from './PulumiWorkspaceService.js';
import { PulumiCredentialsNotConfiguredError } from './PulumiCredentialResolver.js';
import { AwsPastedCredentialDecryptError } from './awsCredentialSource.js';
import {
  PulumiOperationAbortedError,
  PulumiOperationEscalatedError,
  PulumiOperationNotStartedError,
  runWithEscalatingCancellation,
} from './PulumiCancellation.js';
import { runTreatingLeakedPromiseAsSuccess } from './PulumiLeakedPromise.js';
import { classifyStackLockConflict, isStackLockConflict, PulumiUnrecognizedLockError } from './PulumiLockRecovery.js';
import type { PersistRunRecordParams, PreflightMarkerParams } from './RunRecordService.js';

/** Absolute path to the `dist/services/` directory at runtime — mirrors `ConfigService.ts`'s identically-named constant. */
const _dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the app root (`app/` in the repo). Derived by walking 4
 * levels up from `dist/services/` — mirrors `ConfigService.ts`'s
 * identically-named constant exactly (duplicated rather than imported: see
 * this file's `resolveUserDataPath`/`getRunsDir`/`getConfigurationBucket`
 * doc comments for why `PulumiService` never imports `ConfigService`).
 */
const _APP_ROOT = join(_dirname, '..', '..', '..', '..');

/**
 * Fixed placeholder substituted for every redacted game-server environment
 * value in Pulumi run-log output — see
 * {@link PulumiService.redactEnvironmentValues}.
 */
const ENV_REDACTION_PLACEHOLDER = '***REDACTED***';

/**
 * Minimum length an environment variable value must have to be redacted
 * from Pulumi run-log output. Values shorter than this (e.g. `"1"`,
 * `"on"`) recur constantly in unrelated engine output — redacting them
 * would mangle far more of the log than it protects.
 */
const MIN_REDACTABLE_ENV_VALUE_LENGTH = 4;

/**
 * DI token for {@link RunRecordPersister} — the narrow slice of
 * `RunRecordService`'s public surface {@link PulumiService.preview} depends
 * on. Bound to the real `RunRecordService` singleton via `useExisting` in
 * `run-record.module.ts`, and resolved by `PulumiService` lazily via
 * `ModuleRef.get(RUN_RECORD_PERSISTER, { strict: false })` — see
 * `PulumiService.getRunRecordPersister` and `run-record.module.ts`'s doc
 * comment for why this is a runtime lookup rather than a constructor
 * dependency (a `forwardRef()`-guarded static import cycle was tried first
 * and empirically deadlocks this project's native-ESM module graph at
 * boot).
 *
 * `PulumiService` depends on this token (and the {@link RunRecordPersister}
 * *interface*) instead of importing the concrete `RunRecordService` *class*
 * at all, specifically so this file never needs a value-level import of
 * `RunRecordService.ts` — which imports `ConfigService.ts`, which imports
 * this very file (`PulumiService.ts`) for its own `getStackOutputs()`
 * delegate. A class-typed reference here (even just for a
 * `ModuleRef` lookup keyed on the class itself) would introduce a real
 * circular `import` between these three service files; only
 * `PersistRunRecordParams` (a plain interface, safe to reference — no
 * runtime import needed for a type-only reference) crosses from
 * `RunRecordService.ts` into this file.
 */
export const RUN_RECORD_PERSISTER = Symbol('RUN_RECORD_PERSISTER');

/**
 * The slice of `RunRecordService`'s public surface {@link PulumiService.preview}
 * and {@link PulumiService.apply} depend on — persisting a
 * finished run to the cloud-agnostic run-history store (DynamoDB for AWS)
 * alongside the captured log transcript, plus
 * `getByRunId`, which {@link PulumiService.apply}'s gate uses to look up the
 * plan record it's applying (gate step 1). Structurally identical to
 * `RunRecordService.persist`/`.getByRunId`'s own signatures; kept as a
 * separate interface (rather than importing `RunRecordService` as a type and
 * referencing it directly) purely so nothing in this file ever needs
 * `RunRecordService` as a value — see {@link RUN_RECORD_PERSISTER}'s doc
 * comment.
 *
 * `writePreflightMarker` (issue #399) is the narrow slice of
 * `RunRecordService.writePreflightMarker`'s surface {@link PulumiService.apply}
 * depends on — a direct, thin write of a durable in-doubt placeholder record,
 * deliberately NOT routed through {@link persist} (which releases the durable
 * apply lock in its own `finally` — see that method's own doc comment for why
 * that would be wrong here). Only {@link PulumiService.apply} calls it;
 * {@link PulumiService.preview}/`destroy` have no equivalent pre-flight step.
 */
export interface RunRecordPersister {
  persist(params: PersistRunRecordParams, logFilePath: string | null): Promise<void>;
  getByRunId(runId: string): Promise<RunRecord | undefined>;
  writePreflightMarker(params: PreflightMarkerParams): Promise<void>;
}

/**
 * DI token for the narrow slice of `RunService`'s public surface
 * {@link PulumiService.apply} depends on — acquiring the durable apply lock
 * (gate step 8's atomic compare-and-set) via `createRun`. Bound to
 * the real `RunService` singleton via `useExisting` in `run-record.module.ts`,
 * resolved lazily by `PulumiService` via a `strict: false` `ModuleRef.get()`
 * lookup — mirrors {@link RUN_RECORD_PERSISTER} exactly, including the
 * reason (a value-level import of `RunService` here would create the same
 * kind of circular `import` `RUN_RECORD_PERSISTER`'s doc comment describes:
 * `RunService.ts` imports `ConfigService.ts`, which imports this very file
 * for its `getStackOutputs()` delegate).
 */
export const RUN_LOCK_SERVICE = Symbol('RUN_LOCK_SERVICE');

/**
 * The slice of `RunService`'s public surface {@link PulumiService.apply}
 * depends on — see {@link RUN_LOCK_SERVICE}'s doc comment. Structurally
 * identical to `RunService.createRun`/`.releaseRun`'s own signatures.
 * `releaseRun` backstops two distinct paths: the
 * post-`createRun` re-check that closes the apply-vs-`preview`/`destroy`
 * local-workspace race (see {@link apply}'s TSDoc), and the outer `finally`'s
 * unconditional release covering a `writeRunRecord` failure that would
 * otherwise skip `persistRunRecord`'s own lock-releasing `finally` entirely.
 */
export interface RunLockService {
  createRun(kind: RunKind, initiator: string, runId?: string): Promise<RunLock>;
  releaseRun(runId: string): Promise<void>;
}

/**
 * DI token for the narrow slice of `ConfigService`'s public surface
 * {@link PulumiService.apply} depends on — invalidating the memoised
 * `getStackOutputs()`/tfstate cache on a successful apply. Nothing else
 * invalidates it, so without this call the dashboard would show "not
 * deployed" indefinitely after the first real apply. Bound to the real
 * `ConfigService` singleton via `useExisting` in `config.module.ts`,
 * resolved lazily by `PulumiService` via a `strict: false` `ModuleRef.get()`
 * lookup — mirrors {@link RUN_RECORD_PERSISTER} exactly: a value-level
 * import of `ConfigService` here would be the exact circular `import`
 * `PulumiService.getConfigurationBucket`'s doc comment already explains
 * `PulumiService` can never take (`ConfigService.getStackOutputs()` already
 * depends on `PulumiService`).
 */
export const CONFIG_CACHE_INVALIDATOR = Symbol('CONFIG_CACHE_INVALIDATOR');

/**
 * The slice of `ConfigService`'s public surface {@link PulumiService.apply}
 * depends on — see {@link CONFIG_CACHE_INVALIDATOR}'s doc comment.
 * Structurally identical to `ConfigService.invalidateCache`'s own signature.
 */
export interface ConfigCacheInvalidator {
  invalidateCache(): void;
}

/**
 * DI token for the narrow slice of `DeploymentConfigService`'s public surface
 * {@link PulumiService.confirmRollback} depends on — the
 * byte-for-byte restore write (see
 * `DeploymentConfigService.restoreRawConfig`'s own doc comment). Bound to the real
 * `DeploymentConfigService` singleton via `useExisting` in `deployment-config.module.ts`,
 * resolved lazily by `PulumiService` via a `strict: false` `ModuleRef.get()`
 * lookup — mirrors {@link RUN_RECORD_PERSISTER}/{@link REMOTE_FILE_STORE}
 * exactly, and for the same reason: a value-level import of `DeploymentConfigService`
 * here would be a real circular `import`, since `DeploymentConfigService.ts` imports
 * `ConfigService.ts`, which imports THIS file (`PulumiService.ts`) for its
 * `getStackOutputs()` delegate.
 *
 * A dedicated `Symbol` token bound via `useExisting` (this file's own
 * established pattern for every other lazily-resolved dependency) avoids
 * that cycle entirely: this file only ever needs the `DeploymentConfigRestorer`
 * *interface* (safe — no runtime import) and this plain `Symbol` (safe — no
 * import of `DeploymentConfigService.ts` at all). Referencing the `DeploymentConfigService`
 * class itself as the `ModuleRef` token would still require a value import
 * of `DeploymentConfigService` purely to have something to pass as the token/type
 * argument, which is exactly the import this token exists to avoid.
 */
export const DEPLOYMENT_CONFIG_SERVICE = Symbol('DEPLOYMENT_CONFIG_SERVICE');

/**
 * The slice of `DeploymentConfigService`'s public surface {@link PulumiService.confirmRollback}
 * depends on — see {@link DEPLOYMENT_CONFIG_SERVICE}'s doc comment. Structurally
 * identical to `DeploymentConfigService.restoreRawConfig`'s own signature.
 */
export interface DeploymentConfigRestorer {
  restoreRawConfig(rawConfig: string): Promise<{ etag: string; versionId?: string }>;
}

/**
 * Pulumi Automation API service backing the app's infra lifecycle.
 *
 * Provides the typed error classes this class's operations throw (below),
 * {@link getStackOutputs} — the async stack-outputs read — {@link preview} —
 * the plan-equivalent operation, including the plan-hash computation the
 * apply-time staleness-refusal gate depends on — and the `up`/`destroy`/
 * rollback methods on this same class.
 *
 * ## Error-class organization
 *
 * `StalePlanError`, `DestroyNotConfirmedError`, `RollbackTargetNotFoundError`,
 * `RollbackNotApplyRunError`, and `RollbackVersionMissingError` are each about
 * S3 config-object versioning or the destroy confirmation-token gate —
 * concepts independent of which engine runs underneath. The `Pulumi*Error`
 * classes ({@link PulumiPreviewError}/{@link PulumiUpError}/
 * {@link PulumiDestroyError}) wrap a `CommandError` from the Automation API
 * rather than a process exit code. {@link PulumiRunPersistError} carries a
 * Pulumi-shaped `outcome` union. {@link PulumiPartialApplyError} exists for
 * the clean-failure-vs-partial-apply distinction. `PulumiUnrecognizedLockError`
 * (`PulumiLockRecovery.ts`) is the class later dispatches' stale-lock
 * handling uses; it is not duplicated here.
 *
 * Colocated in this one file (rather than a separate `pulumiServiceErrors.ts`)
 * because every one of them is either thrown by, or describes the outcome
 * of, a method this class owns — there's no independent consumer that would
 * benefit from importing the errors without the service, unlike e.g.
 * `@hyveon/shared`'s error types.
 */

/**
 * Matches a bare, single-segment run identifier: letters, digits,
 * underscores, hyphens only — no path separators or traversal segments.
 * `runId` is joined directly into filesystem paths under
 * {@link PulumiService.getRunsDir}, so this guards against path traversal
 * via a malformed id.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * `OpType`s that represent a genuine applied resource mutation — used by
 * {@link PulumiService.apply} to detect a partial apply from `onEvent`'s
 * `resOutputsEvent` stream (see that method's TSDoc, "Partial-apply
 * detection"). Excludes `'same'` (the resource already matched its desired
 * state — no mutation happened), `'read'`/`'read-replacement'`/`'refresh'`
 * (state reads, not mutations), and the `'discard'`/`'discard-replaced'`/
 * `'remove-pending-replace'` plan-only bookkeeping ops (per
 * `@pulumi/pulumi/automation/stack.d.ts`'s `OpType` doc comments, these
 * describe plan-time bookkeeping, not something a real `stack.up()` ever
 * reports as completed). Includes `'import'`/`'import-replacement'` — an
 * import genuinely brings a resource under management, a real mutation of
 * the stack's desired state even though no cloud API call recreates the
 * resource itself.
 */
const MUTATING_OP_TYPES: ReadonlySet<OpType> = new Set([
  'create',
  'update',
  'delete',
  'replace',
  'create-replacement',
  'delete-replaced',
  'import',
  'import-replacement',
]);

/**
 * How long a token minted by {@link PulumiService.mintDestroyConfirmationToken}
 * stays valid before {@link PulumiService.destroy} rejects it as stale, even
 * if it was never consumed (5 minutes) — nothing about the destroy flow
 * itself calls for a different window than the renderer's destroy-
 * confirmation modal stays open for.
 */
const DESTROY_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/**
 * How long a token minted by {@link PulumiService.mintLockClearConfirmationToken}
 * stays valid before {@link PulumiService.clearStaleLock} rejects it as
 * stale, even if it was never consumed — mirrors {@link DESTROY_CONFIRMATION_TTL_MS}.
 */
const LOCK_CLEAR_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/**
 * The most recently minted destroy-confirmation token, its expiry, and the
 * destroy TARGET it was bound to — set by
 * {@link PulumiService.mintDestroyConfirmationToken} and consumed (single-use)
 * by {@link PulumiService.assertFreshDestroyConfirmation} the moment a
 * {@link PulumiService.destroy} call validates it.
 *
 * ## Target binding
 *
 * The `iac-destroy-flow` spec requires a minted token to record the
 * workspace/stack it was issued for, and `destroy` to reject a token whose
 * recorded target doesn't match the stack about to be destroyed.
 *
 * This app operates exactly ONE bare stack name
 * ({@link PULUMI_STACK_NAME} — `'production'`, a constant, never
 * `org/project/stack`), so "a token minted for a different stack" cannot mean
 * what it means in a genuinely multi-stack system — there is no second stack
 * name it could ever diverge to. Binding on `stackName` alone would therefore
 * be real but permanently vacuous: the comparison can never fail in this
 * app's lifetime.
 *
 * What CAN genuinely change between minting a token (when the renderer opens
 * its destroy-confirmation modal) and consuming it (when the operator
 * confirms): the self-managed backend's **state bucket / region** the destroy
 * would run against. `PulumiWorkspaceService.getOrCreateStack`'s
 * `stateBucket`/`stateBucketRegion` inputs come straight from
 * `ElectronStoreService`'s `bootstrap.stateBucket`/`aws.region` — both
 * writable by the First-Run Wizard's "Reconfigure" flow at any time,
 * including while a destroy-confirmation modal is sitting open. An operator
 * who opens that modal against one backend, then (in another window, or after
 * a Reconfigure completes in the same session) points the app at a
 * *different* S3 state bucket before clicking confirm, would otherwise have
 * their original token silently authorize destroying whatever stack now
 * happens to live in the NEW bucket — exactly the "assurance a destroy gate
 * exists to provide" the spec's prose warns a token binds nothing without.
 * `stateBucket`/`stateBucketRegion` together are this app's actual
 * `PulumiWorkspaceInput`-shaped "target" — the pair that, combined with the
 * (always-constant) stack name, fully determines which real Pulumi stack
 * `stack.destroy()` will run against.
 *
 * `stackName`/`projectName` are still recorded and compared (`PULUMI_STACK_NAME`/
 * `PULUMI_PROJECT_NAME`, unconditionally) even though NEITHER can ever
 * mismatch today (both are hardcoded constants, never `org/project/stack`
 * user input) — cheap to check, literally what the spec's prose names ("the
 * workspace **and stack** it was issued for"), and future-proof for free: if
 * this app ever grows a second stack or project, the binding mechanism
 * already accounts for it without a schema change, only a population
 * change.
 *
 * `null` when no token has been minted, or once the most recently minted one
 * has been consumed or superseded by a newer {@link PulumiService.mintDestroyConfirmationToken}
 * call — minting always supersedes, so only the most recently minted token
 * is ever accepted.
 */
interface PulumiPendingDestroyConfirmation {
  /** The single-use token the renderer must supply back to {@link PulumiService.destroy}. */
  token: string;
  /** `Date.now() + DESTROY_CONFIRMATION_TTL_MS`, captured at mint time. */
  expiresAt: number;
  /**
   * The self-managed backend's configured state bucket at mint time
   * (`ElectronStoreService`'s `bootstrap.stateBucket`), or `undefined` if
   * unconfigured at that moment — see this interface's doc comment, "Target
   * binding".
   */
  stateBucket: string | undefined;
  /** The state bucket's configured AWS region at mint time (`aws.region`) — see this interface's doc comment. */
  stateBucketRegion: string | undefined;
  /** {@link PULUMI_STACK_NAME} at mint time — always the same constant today; see this interface's doc comment for why it's still recorded. */
  stackName: string;
  /** {@link PULUMI_PROJECT_NAME} at mint time — always the same constant today, for the identical reason {@link stackName} is still recorded. */
  projectName: string;
}

/**
 * The most recently minted lock-clear-confirmation token, its expiry, and
 * the target it's bound to — set by
 * {@link PulumiService.mintLockClearConfirmationToken} and consumed
 * (single-use) by {@link PulumiService.assertFreshLockClearConfirmation} the
 * moment a {@link PulumiService.clearStaleLock} call validates it. Mirrors
 * {@link PulumiPendingDestroyConfirmation}'s target-binding design exactly.
 */
interface PulumiPendingLockClearConfirmation {
  /** The single-use token the renderer must supply back to {@link PulumiService.clearStaleLock}. */
  token: string;
  /** `Date.now() + LOCK_CLEAR_CONFIRMATION_TTL_MS`, captured at mint time. */
  expiresAt: number;
  /** The self-managed backend's configured state bucket at mint time, or `undefined` if unconfigured. */
  stateBucket: string | undefined;
  /** The state bucket's configured AWS region at mint time. */
  stateBucketRegion: string | undefined;
  /** {@link PULUMI_STACK_NAME} at mint time. */
  stackName: string;
  /** {@link PULUMI_PROJECT_NAME} at mint time. */
  projectName: string;
}

/**
 * A single line of streamed stdout/stderr output from a Pulumi Automation
 * API operation, tagged with the stream it came from — yielded by
 * `preview`/`up`/`destroy` as the operation produces output, consumed by
 * {@link PulumiService.streamRunOutput}'s subscribers.
 */
export interface PulumiRunChunk {
  stream: 'stdout' | 'stderr';
  line: string;
}

/**
 * In-memory fan-out buffer for a single in-flight `preview`/`up`/`destroy`
 * run's streamed output, keyed by `runId` in `PulumiService`'s private
 * `activeRuns` map — populated by {@link PulumiService.recordRunChunk},
 * consumed by {@link PulumiService.streamRunOutput}.
 */
interface PulumiActiveRunBuffer {
  /** Every chunk streamed so far, in production order — replayed in full to a new subscriber before it starts receiving live chunks. */
  chunks: PulumiRunChunk[];
  /** Callbacks invoked synchronously, in registration order, each time a new chunk is recorded. */
  listeners: Set<(chunk: PulumiRunChunk) => void>;
  /** Flips to `true` once the owning run has settled — never flips back. */
  settled: boolean;
  /** Callbacks invoked exactly once, when the run is marked settled. */
  settledListeners: Set<() => void>;
}

/**
 * Outcome of a successful {@link PulumiService.preview} run, resolved via
 * the async generator's return value once `stack.preview()` settles and the
 * run wasn't aborted.
 *
 * The Pulumi inline program takes the deployment config as an in-memory
 * object (see {@link PulumiService.preview}), so there is no separate
 * pulled-var-file artifact on disk to point at. Resource changes are
 * reported as the single structured {@link ChangeSummary} the design doc's
 * "Structured summaries, not scraped stdout" decision requires, rather than
 * counts scraped from a human-readable summary line. `engineVersion` is the
 * engine version stamped into the saved plan artifact's own
 * `manifest.version` field — see {@link PulumiService.preview}'s doc
 * comment, "Engine-version stamping", for why this is a separate field
 * rather than folded into `planHash`.
 */
export interface PulumiPreviewResult {
  /** The `runId` minted for this run — the parent directory (`<runsDir>/<runId>/`) of {@link artifactPath}. */
  runId: string;
  /** Absolute path to the persisted Pulumi update-plan JSON artifact (`--save-plan`) — what a future `up()` passes as `UpOptions.plan`. */
  artifactPath: string;
  /**
   * The structured resource-change summary this run's `stack.preview()`
   * reported — see {@link ChangeSummary}'s doc comment for the "`{}` means
   * summary missed, not no changes" sharp edge every reader must respect.
   */
  changeSummary: ChangeSummary;
  /**
   * SHA-256 hex digest covering both the persisted plan artifact's bytes AND
   * the deployment-config object's S3 version id this run ran against — see
   * {@link PulumiService.computePlanHash}'s doc comment for the exact
   * algorithm.
   */
  planHash: string;
  /**
   * The engine version stamped into the saved plan artifact's own
   * `manifest.version` field, with any leading `v` stripped (e.g. the
   * artifact's `"v3.255.0"` is stored as `"3.255.0"`) so it's directly
   * comparable — via a bare string equality, no caller-side normalization
   * needed — against `PulumiEngineService.getResolvedVersion()`'s own
   * un-prefixed shape. See {@link PulumiService.readEngineVersionFromPlanArtifact}
   * for exactly where the stripping happens. Stored alongside, not folded
   * into, {@link planHash} — see {@link PulumiService.preview}'s doc comment,
   * "Engine-version stamping", for why.
   */
  engineVersion: string;
}

/**
 * Describes what {@link PulumiService.preview} was about to return/throw the
 * moment its operation settled — captured before the run record is
 * persisted so a persistence failure (see {@link PulumiRunPersistError})
 * doesn't discard the real outcome.
 */
export type PulumiPreviewOutcome =
  | { kind: 'success'; result: PulumiPreviewResult }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: PulumiPreviewError | PulumiPlanHashError };

/**
 * Persisted to `<runsDir>/<runId>/run.json` once a {@link PulumiService.preview}
 * (and, later, `up`/`destroy`) run has settled — the local run-history
 * counterpart to the DynamoDB write {@link PulumiService.persistRunRecord}
 * makes through {@link RunRecordPersister}. Field-for-field with
 * `IacRunRecord` (the preload-exposed shape this mirrors), plus
 * `changeSummary`/`engineVersion`. `kind` reuses the same `RunKind` union
 * (`'plan'`/`'apply'`/`'destroy'`) `IacRunRecord` uses, so a Pulumi
 * `preview` run is still recorded as a `'plan'` kind.
 */
export interface PulumiRunRecord {
  /** The `runId` this record describes — matches the directory it's written into. */
  runId: string;
  /** Which operation produced this record (`preview` → `'plan'`, `up` → `'apply'`, `destroy` → `'destroy'`). */
  kind: RunKind;
  /** ISO-8601 timestamp captured immediately before `stack.preview()`/`.up()`/`.destroy()` was called. */
  startedAt: string;
  /** ISO-8601 timestamp captured immediately after the operation settled. */
  completedAt: string;
  /** `0` on success, `null` if aborted, a nonzero sentinel (`1`) on a genuine failure — mirrors `IacRunRecord.exitCode`'s three-way meaning even though there is no real process exit code to report for an Automation API call. */
  exitCode: number | null;
  /** The deployment-config object's S3 version id this run ran against. */
  configVersionId?: string;
  /** SHA-256 hex digest of the persisted plan artifact plus the config version id — see {@link PulumiService.computePlanHash}. */
  planHash?: string;
  /** The `runId` of the `apply` run this plan rolled back, if this run was started via the rollback flow (see {@link PulumiService.confirmRollback}). */
  rolledBackFrom?: string;
  /** The structured resource-change summary this run's `stack.preview()` reported — see {@link ChangeSummary}'s doc comment. */
  changeSummary?: ChangeSummary;
  /** The engine version stamped into the saved plan artifact — see {@link PulumiPreviewResult.engineVersion}. */
  engineVersion?: string;
  /**
   * `true` only on a `kind: 'apply'` record whose `stack.up()` call did NOT
   * settle as `'success'` — failed OR was aborted — AFTER at least one
   * resource step had already been applied, distinguishing a clean failure
   * from a partial apply. Deliberately an ADDITIVE field
   * alongside `exitCode`/`status` rather than a fourth `RunStatus` value:
   * `RunStatus` is also the hash key of the `status-index` DynamoDB GSI
   * (`defineDynamoDb` in `app/packages/infra/src/dynamodb.ts`), so widening its value set is an
   * infra-affecting change — an additive boolean lets the UI/later logic
   * check "is this a partial apply" without touching the GSI's key schema at
   * all.
   *
   * **Independent of which non-`'success'` `status` the run settled with.**
   * This is `true` on a `status: 'failed'` record (`exitCode: 1`) exactly as often
   * as on a `status: 'aborted'` one (`exitCode: null` — the operator
   * pressing Cancel mid-`up()`, arguably the single most likely real-world
   * way this system ends up partway through). **Any consumer MUST check
   * `partialApply` directly and MUST NOT gate that check behind
   * `status === 'failed'` first** — doing so silently misses every
   * cancelled-mid-apply partial. Absent (never `false`) on every
   * non-partial record (including every `status: 'success'` record, however
   * many resources it touched), mirroring this file's established "absence
   * means N/A, not false" convention for `changeSummary`/`engineVersion`
   * above.
   */
  partialApply?: boolean;
}

/**
 * Outcome of a successful {@link PulumiService.apply} run, resolved via the
 * async generator's return value once `stack.up()` settles and the run
 * wasn't aborted. Deliberately narrower than {@link PulumiPreviewResult}: no
 * `artifactPath`/`planHash`/`engineVersion` — those describe the *plan* this
 * apply was constrained by (already on the plan's own {@link PulumiRunRecord},
 * looked up via `planRunId`), not a fresh artifact this run itself produces.
 */
export interface PulumiUpResult {
  /** The `runId` of this apply run — always equal to the `planRunId` the gate validated (see {@link PulumiService.apply}'s "run id" doc section). */
  runId: string;
  /**
   * The structured resource-change summary this run's `stack.up()` reported,
   * captured via `onEvent`'s `summaryEvent` — see {@link ChangeSummary}'s
   * doc comment for the "`{}` means summary missed, not no changes" sharp
   * edge every reader must respect.
   */
  changeSummary: ChangeSummary;
}

/**
 * Describes what {@link PulumiService.apply} was about to return/throw the
 * moment its operation settled — captured before the run record is
 * persisted so a persistence failure (see {@link PulumiRunPersistError})
 * doesn't discard the real outcome. Mirrors {@link PulumiPreviewOutcome},
 * plus `partialApply` on the `'failed'` variant (the clean-failure-
 * vs-partial-apply distinction — see {@link PulumiRunRecord.partialApply}'s
 * doc comment for why this is a sibling flag rather than a fourth outcome
 * kind).
 *
 * **This type's own `partialApply` is NOT what gets persisted** — it exists
 * only for the `'failed'` variant's own internal bookkeeping. The
 * PERSISTED `PulumiRunRecord.partialApply` value {@link apply} actually
 * writes is computed independently, directly from `completedSteps.length`,
 * gated only on `outcome.kind !== 'success'` — covering the `'aborted'`
 * variant too, which carries no `partialApply` field of its own here. See
 * {@link apply}'s implementation and {@link PulumiRunRecord.partialApply}'s
 * doc comment.
 */
export type PulumiApplyOutcome =
  | { kind: 'success'; result: PulumiUpResult }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: Error; partialApply: boolean };

/**
 * Outcome of a successful {@link PulumiService.destroy} run, resolved via the
 * async generator's return value once `stack.destroy()` settles and the run
 * wasn't aborted. Deliberately as narrow as {@link PulumiUpResult}: no
 * `outputs` (there is nothing meaningful to report post-destroy — see
 * {@link PulumiService.destroy}'s TSDoc, "Leaked-promise `recoverResult`",
 * for why `stack.outputs()` is never even re-read on that path either).
 */
export interface PulumiDestroyResult {
  /** The `runId` of this destroy run — always equal to the durable-lock `runId` the gate reserved (see {@link PulumiService.destroy}'s "Gate structure" doc section). */
  runId: string;
  /**
   * The structured resource-change summary this run's `stack.destroy()`
   * reported (every entry a deletion), captured via `onEvent`'s
   * `summaryEvent` — see {@link PulumiService.destroy}'s TSDoc, "`changeSummary`",
   * for why this is handled like {@link PulumiUpResult.changeSummary}, not
   * {@link PulumiPreviewResult.changeSummary}.
   */
  changeSummary: ChangeSummary;
}

/**
 * Describes what {@link PulumiService.destroy} was about to return/throw the
 * moment its operation settled — captured before the run record is persisted
 * so a persistence failure (see {@link PulumiRunPersistError}) doesn't
 * discard the real outcome. Mirrors {@link PulumiPreviewOutcome}'s plain
 * three-way shape, NOT {@link PulumiApplyOutcome}'s `partialApply`-carrying
 * one — see {@link PulumiService.destroy}'s TSDoc, "No partial-destroy
 * concept", for why no fourth signal exists here.
 */
export type PulumiDestroyOutcome =
  | { kind: 'success'; result: PulumiDestroyResult }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: PulumiDestroyError | PulumiUnrecognizedLockError };

/**
 * Pulumi-backed service — see this file's top-level doc comment (above) for
 * the full picture: the error classes, {@link getStackOutputs}, and
 * {@link preview}.
 */
@Injectable()
export class PulumiService {
  /**
   * Name of whichever operation (`preview`, `up`, `destroy`, or
   * `rollback`) is actively running against the shared Pulumi workspace
   * directory, or `null` when none is. Every operation reuses the SAME
   * `workDir`/`Pulumi.<stack>.yaml` (`PulumiWorkspaceService.getWorkspaceRoot`'s
   * doc comment: "one stable directory per stack, reused across
   * operations"), so two concurrent operations against this one
   * `PulumiService` instance would race on that shared local state —
   * independent of whether the DIY backend's own lock is ever taken (see
   * {@link preview}'s doc comment, "Does preview take the backend lock?",
   * for why `preview` itself never takes that lock; this in-process guard
   * exists regardless, for the local workspace files).
   *
   * `'rollback'` ({@link confirmRollback}) is a DISTINCT state
   * from `'preview'`, even though the operation it ultimately runs (via
   * {@link previewCore}) is, underneath, an ordinary plan — see
   * {@link confirmRollback}'s TSDoc, "Lock acquisition", for why a caller
   * refused mid-rollback deserves a busy message naming `rollback`
   * specifically rather than the generic `preview`. Exactly like `'up'`
   * already does for `apply()` — the state name here is a short internal
   * verb for diagnostics, not required to equal the public method's literal
   * name.
   */
  private operationInFlight: 'preview' | 'up' | 'destroy' | 'rollback' | null = null;

  /**
   * Fan-out buffers for every currently in-flight `preview`/`up`/`destroy`
   * run, keyed by `runId` — see {@link PulumiActiveRunBuffer}'s doc comment
   * for the full contract.
   */
  private readonly activeRuns = new Map<string, PulumiActiveRunBuffer>();

  /**
   * The most recently minted destroy-confirmation token, its expiry, and its
   * bound target — see {@link PulumiPendingDestroyConfirmation}'s doc comment
   * for the full contract, including the target-binding design.
   */
  private pendingDestroyConfirmation: PulumiPendingDestroyConfirmation | null = null;

  /**
   * The most recently minted lock-clear-confirmation token, its expiry, and
   * its bound target — see {@link PulumiPendingLockClearConfirmation}'s doc
   * comment for the full contract.
   */
  private pendingLockClearConfirmation: PulumiPendingLockClearConfirmation | null = null;

  /**
   * `engine` is `apply`'s route to
   * `PulumiEngineService.getResolvedVersion()` for the gate's engine-version
   * check (step 7) — an ordinary constructor dependency, not a lazy
   * `ModuleRef` lookup, because `PulumiEngineModule` has no dependencies of
   * its own and importing it into `pulumi-service.module.ts` creates no
   * cycle (unlike `RunRecordModule`/`ConfigModule`, both reachable from
   * `PulumiServiceModule`'s own importers — see below). `moduleRef` is
   * `preview`'s route to `RUN_RECORD_PERSISTER` (the DynamoDB
   * run-history write path) and `REMOTE_FILE_STORE` (the cloud-agnostic
   * config-object store), and `apply`'s route to
   * `RUN_LOCK_SERVICE` (the durable apply lock, gate step 8) and
   * `CONFIG_CACHE_INVALIDATOR` (the post-apply cache invalidation) — see {@link getRunRecordPersister}/
   * {@link getRemoteFileStore}/{@link getRunLockService}/
   * {@link getConfigCacheInvalidator} for why these four are resolved
   * lazily via `ModuleRef.get(token, { strict: false })` at call time rather
   * than taken as ordinary constructor-injected dependencies:
   * `pulumi-service.module.ts`'s own doc comment has the full story (a
   * `forwardRef()`-guarded static import cycle was tried first and
   * empirically deadlocks this project's native-ESM module graph at boot).
   * `ModuleRef` itself is a core Nest primitive with no relation to any
   * module in that cycle, so injecting it creates no new edge at all.
   */
  constructor(
    private readonly workspace: PulumiWorkspaceService,
    private readonly store: ElectronStoreService,
    private readonly moduleRef: ModuleRef,
    private readonly engine: PulumiEngineService,
  ) {}

  /**
   * Read-only accessor for {@link operationInFlight}, for callers'
   * pre-flight busy checks.
   *
   * Deliberately just a getter — no behavior change to {@link operationInFlight}
   * itself, and no new way to observe or influence it beyond what every
   * `preview`/`apply`/`destroy`/`confirmRollback` call site already does
   * internally. `'rollback'` is a real, distinct fourth state
   * ({@link confirmRollback}) alongside `'preview'`/`'up'`/`'destroy'` — this
   * accessor's return type is kept in exact sync with {@link operationInFlight}'s
   * own declared type rather than a separately-maintained copy, so a future
   * state added to one can't silently drift out of sync with the other.
   */
  getOperationInFlight(): 'preview' | 'up' | 'destroy' | 'rollback' | null {
    return this.operationInFlight;
  }

  /**
   * Dedicated reentrancy guard for {@link initializeStack} — deliberately
   * NOT folded into {@link operationInFlight} itself. Widening that field's
   * (and {@link PulumiOperationInFlightError.inFlight}'s) declared union to a
   * fifth `'stack-init'` value would ripple into every place that already
   * types itself against the current four-value union verbatim —
   * `IacController`'s `conflict` mapping and the `IacPlanAck.conflict`
   * type it feeds (`iac.controller.ts`, mirrored in
   * `@hyveon/desktop-preload/src/hyveon-api.ts`), and `iac.page.tsx`'s own
   * `Conflict`/`CONFLICT_LABELS` — none of which `initializeStack` has any
   * other reason to touch.
   *
   * set (see its own TSDoc, "Workspace mutual exclusion"), and
   * `preview`/`apply`/`destroy`/`confirmRollback`/`clearStaleLock` each
   * refuse to start while THIS flag is set too, via
   * {@link assertStackInitNotInFlight}. This closes a race reachable via
   * Settings → Reconfigure → advance to the stack-init step (starts
   * `initializeStack` in the background) → click Cancel: the step's cleanup
   * calls the returned stream handle's `cancel()`, which — per
   * `HyveonStreamHandle`'s own contract — only stops the RENDERER from
   * consuming further progress, while `initializeStack` itself keeps running
   * to completion regardless. Without this guard, `clearStaleLock` could
   * confirm-clear a lock while a legitimate `initializeStack()` refresh was
   * still genuinely running, cancelling live, correct work instead of a
   * genuinely stale one; likewise `preview()`/`apply()`/`destroy()`/
   * `confirmRollback()` would sail straight through their own
   * `operationInFlight` check (still `null` — `initializeStack` never
   * touches it) while `stack.refresh()` was still running against the SAME
   * reused local `workDir`/`Pulumi.<stack>.yaml`/`PULUMI_HOME` plugin cache —
   * and none of those operations take the durable S3 backend lock either
   * (see {@link preview}'s TSDoc, "Does preview take the backend lock?"), so
   * nothing else guards that shared local-workspace state while
   * `initializeStack` is running. The REMAINING asymmetry —
   * `initializeStack` itself only guards against a second concurrent
   * `initializeStack` call via this same flag, not a fifth
   * `operationInFlight` value the other four could also be checked
   * against — is deliberate, to avoid the union-widening cost described
   * above.
   */
  private stackInitInFlight = false;

  /**
   * Throws a plain `Error` if {@link stackInitInFlight} is set — the shared
   * guard {@link preview}/{@link apply}/{@link destroy}/
   * {@link confirmRollback}/{@link clearStaleLock} each call, right alongside
   * their existing {@link operationInFlight} check, to close the race
   * {@link stackInitInFlight}'s own doc comment describes. Deliberately a
   * plain `Error`, not {@link PulumiOperationInFlightError} — that class's
   * `inFlight` field is typed to the pre-existing four-value union, and
   * widening it to a fifth `'stack-init'` value is exactly the ripple
   * {@link stackInitInFlight}'s doc comment explains this guard avoids. A
   * caller submitting through `IacController` still sees a clear rejection
   * message; it just doesn't get the specific busy-banner `conflict`
   * treatment `PulumiOperationInFlightError` triggers there.
   *
   * @param methodName - The calling method's own name, purely for the
   *   thrown message's wording (mirrors `preview`/`confirmRollback`'s
   *   existing inline `operationInFlight` guards, which each hand-write
   *   their own method name into an identically-shaped message).
   */
  private assertStackInitNotInFlight(
    methodName: 'preview' | 'apply' | 'destroy' | 'confirmRollback' | 'clearStaleLock',
  ): void {
    if (this.stackInitInFlight) {
      throw new Error(
        `PulumiService.${methodName}() cannot run while initializeStack() is already running; wait for ` +
          `it to finish before calling ${methodName}() again.`,
      );
    }
  }

  /**
   * Lazily resolves the real `RunRecordService` singleton (bound to
   * {@link RUN_RECORD_PERSISTER} by `run-record.module.ts`) from anywhere in
   * the application's provider container — see the constructor's doc
   * comment and `run-record.module.ts`'s for why this is a `ModuleRef`
   * lookup rather than a constructor dependency. Safe to call from
   * {@link preview} (and later `up`/`destroy`): those methods only ever run
   * once the application has fully bootstrapped, by which point every
   * provider `RUN_RECORD_PERSISTER` could possibly resolve to already
   * exists. `strict: false` searches the whole container, not just this
   * service's own module scope — required, since `PulumiServiceModule`
   * deliberately does not import whatever module provides this token.
   *
   * Throws a clear, wrapped `Error` (naming the missing token and the module
   * expected to provide it) rather than letting Nest's own
   * `UnknownElementException` propagate unexplained — deliberately the SAME
   * failure mode {@link getRemoteFileStore} uses for the identical situation,
   * so a missing DI binding fails loudly and identically regardless of which
   * token is missing. What a *caller* of this method does with that thrown
   * error is a separate, independent choice made at each call site: `preview`'s
   * `persistRunRecord` wraps this call in a try/catch that treats ANY
   * failure of the run-history side-write (a missing token included) as
   * best-effort and logs+swallows it — that is `persistRunRecord`'s own
   * deliberate "never throws" policy about what "run-history persistence
   * failed" means for an otherwise-successful preview, not a difference in
   * what this method itself does on failure.
   */
  private getRunRecordPersister(): RunRecordPersister {
    try {
      return this.moduleRef.get<RunRecordPersister>(RUN_RECORD_PERSISTER, { strict: false });
    } catch (err) {
      throw new Error(
        'PulumiService: RUN_RECORD_PERSISTER is not registered anywhere in the application\'s DI ' +
          `container — this is a wiring bug (see run-record.module.ts), not a runtime condition: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Lazily resolves the real `RemoteFileStore` implementation bound to
   * {@link REMOTE_FILE_STORE} by `cloud-provider.module.ts` — mirrors
   * {@link getRunRecordPersister} exactly, including wrapping a missing
   * binding in the same clear, loud `Error` shape; see that method's doc
   * comment. Unlike {@link getRunRecordPersister}, nothing in {@link preview}
   * currently catches a failure from this method — reading the deployment
   * configuration is load-bearing for `preview()` (there is no meaningful
   * "preview with no configuration" outcome), so a missing binding here is
   * correctly a hard failure of the whole operation, not a best-effort
   * side-write.
   */
  private getRemoteFileStore(): RemoteFileStore {
    try {
      return this.moduleRef.get<RemoteFileStore>(REMOTE_FILE_STORE, { strict: false });
    } catch (err) {
      throw new Error(
        'PulumiService: REMOTE_FILE_STORE is not registered anywhere in the application\'s DI ' +
          `container — this is a wiring bug (see cloud-provider.module.ts), not a runtime condition: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Lazily resolves the real `RunService` singleton (bound to
   * {@link RUN_LOCK_SERVICE} by `run-record.module.ts`) — mirrors
   * {@link getRunRecordPersister} exactly, including the same loud-failure
   * shape on a missing binding. {@link apply}'s gate step 8 (the
   * atomic compare-and-set) is the only caller — nothing wraps this in a
   * try/catch the way `persistRunRecord` wraps {@link getRunRecordPersister},
   * since a missing binding here is a wiring bug, not a condition `apply`
   * should degrade past.
   */
  private getRunLockService(): RunLockService {
    try {
      return this.moduleRef.get<RunLockService>(RUN_LOCK_SERVICE, { strict: false });
    } catch (err) {
      throw new Error(
        'PulumiService: RUN_LOCK_SERVICE is not registered anywhere in the application\'s DI ' +
          `container — this is a wiring bug (see run-record.module.ts), not a runtime condition: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Lazily resolves the real `ConfigService` singleton (bound to
   * {@link CONFIG_CACHE_INVALIDATOR} by `config.module.ts`) — mirrors
   * {@link getRunRecordPersister} exactly. {@link apply} calls this only
   * on a successful apply, to invalidate the memoised `getStackOutputs()`
   * cache — a failure to
   * resolve this token is logged and swallowed at that call site (mirroring
   * `persistRunRecord`'s "never let a side-effect write mask an otherwise-
   * successful apply" policy), not propagated raw the way
   * {@link getRemoteFileStore}'s failures are.
   */
  private getConfigCacheInvalidator(): ConfigCacheInvalidator {
    try {
      return this.moduleRef.get<ConfigCacheInvalidator>(CONFIG_CACHE_INVALIDATOR, { strict: false });
    } catch (err) {
      throw new Error(
        'PulumiService: CONFIG_CACHE_INVALIDATOR is not registered anywhere in the application\'s DI ' +
          `container — this is a wiring bug (see config.module.ts), not a runtime condition: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Lazily resolves the real `DeploymentConfigService` singleton (bound to
   * {@link DEPLOYMENT_CONFIG_SERVICE} by `deployment-config.module.ts`) — mirrors
   * {@link getRemoteFileStore} exactly, including the same loud-failure
   * shape on a missing binding. {@link confirmRollback} is the
   * only caller — the byte-for-byte restore write it makes through
   * {@link DeploymentConfigRestorer.restoreRawConfig} is as load-bearing to a rollback
   * as reading the configuration object is to {@link previewCore}, so a
   * missing binding here is correctly a hard failure, not a best-effort
   * side-write (unlike {@link getConfigCacheInvalidator}'s failure policy).
   */
  private getDeploymentConfigService(): DeploymentConfigRestorer {
    try {
      return this.moduleRef.get<DeploymentConfigRestorer>(DEPLOYMENT_CONFIG_SERVICE, { strict: false });
    } catch (err) {
      throw new Error(
        'PulumiService: DEPLOYMENT_CONFIG_SERVICE is not registered anywhere in the application\'s DI ' +
          `container — this is a wiring bug (see deployment-config.module.ts), not a runtime condition: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Reads every value the app cares about off the deployed Pulumi stack.
   * Returns `null` — NEVER throws, full stop. Every one of the ~14 call
   * sites that use `getStackOutputs()` is written against that never-throw
   * contract (several inside `finally` blocks, or ahead of code that must
   * not be skipped by an unhandled rejection — e.g. `RunService.releaseRun`'s
   * lock release, or `AuditService.record`'s documented "never throws"
   * promise): see the catch-all around the Pulumi call below, which
   * swallows every failure — a missing file, unparseable JSON, a thrown
   * projection error — and returns `null`/logs rather than ever
   * propagating. See `StackOutputs`'s own doc comment for the "not deployed
   * yet" framing this degrades to.
   *
   * ## Concurrency guard
   *
   * Returns `null` immediately, without touching the shared workspace, while
   * {@link stackInitInFlight} or {@link operationInFlight} is set — `initializeStack()`
   * can run `stack.refresh()` and the other operations run `preview`/`up`/`destroy`
   * against the same on-disk workspace `getOrCreateStack()` would otherwise reuse
   * concurrently for this read.
   *
   * ## Never deployed yet: three independent short-circuits, no Pulumi call
   *
   * A mere outputs *read* should never need to take the extra `listStacks()`
   * round-trip {@link PulumiWorkspaceService.getOrCreateStack} performs for a
   * genuinely-new stack — that round-trip exists to protect passphrase
   * generation, and a read has no reason to pay
   * for it when the store already makes "nothing has ever been deployed"
   * obvious locally. So this method checks, in order, for evidence that a
   * stack could possibly exist BEFORE ever calling into Pulumi, returning
   * `null` immediately if any check fails:
   *
   * 1. `bootstrap.stateBucket` is configured — no backend has even been
   *    bootstrapped otherwise (mirrors `PulumiBackendNotBootstrappedError`'s
   *    condition, checked here directly so the "not deployed" path never
   *    even constructs a `PulumiWorkspaceInput`).
   * 2. A secrets passphrase is already stored
   *    (`store.get('pulumi')?.passphrase !== undefined`) — this is exactly
   *    the same local-record check
   *    {@link PulumiWorkspaceService.getOrCreateStack} itself uses to decide
   *    whether it can skip its own `listStacks()` probe (see
   *    `PulumiWorkspaceService.resolveStoredPassphrase`'s doc comment): a
   *    passphrase is only ever persisted the first time a stack is genuinely
   *    created. Its absence means either nothing has ever been deployed from
   *    this install, or a stack exists remotely with no local passphrase
   *    record (`PulumiPassphraseUnavailableError`'s
   *    `'existing-stack-no-local-record'` case, which
   *    {@link PulumiWorkspaceService.getOrCreateStack} would now correctly
   *    detect and refuse rather than misgenerate a passphrase for) — either
   *    way, this method degrades to "not deployed" rather than pay for the
   *    round-trip on a mere read.
   * 3. `aws.region` is configured — needed to build the backend URL; absent
   *    only if the wizard's credentials step was never completed, which
   *    implies nothing was ever deployed either.
   *
   * **These three checks are a proxy for "a stack might exist", not a
   * proof.** A destroyed stack, or a passphrase persisted by a failed/
   * abandoned create attempt, both leave the store looking exactly like
   * "existing stack" when the remote stack may not actually be there — this
   * is a best-effort no-create guarantee, not a proven one; but the WORST
   * case if it's ever wrong is an extra `getOrCreateStack` round-trip (which
   * safely determines the truth itself via `listStacks()`), never a
   * corrupted passphrase, since {@link PulumiWorkspaceService.getOrCreateStack}
   * itself never trusts any caller's belief about stack existence at all.
   *
   * Only once all three checks pass does this call
   * {@link PulumiWorkspaceService.getOrCreateStack} (with `backendReady: true`
   * and a no-op `program` — reading `stack.outputs()` never invokes the
   * program; see below) and `stack.outputs()`, inside a
   * catch-all: ANY failure from either call — `PulumiBackendNotBootstrappedError`,
   * `PulumiPassphraseUnavailableError`, `PulumiCredentialsNotConfiguredError`,
   * engine-resolution failures, or a `CommandError` from the underlying
   * `pulumi stack output` invocation — is logged and degraded to `null`.
   * This is a deliberate, blunt catch-all rather than a nuanced per-error
   * classification: callers cannot tell "genuinely not deployed" apart from
   * "deployed, but this read failed" from the return value alone, which is
   * an acceptable trade against the alternative (an unhandled rejection
   * reaching code that assumed synchronous-style read semantics never
   * throw). A future change that wants callers to distinguish those cases
   * should do so deliberately, call-site by call-site, not by loosening this
   * method's contract back open.
   *
   * ## Why a no-op `program` is safe here
   *
   * `LocalWorkspace.createOrSelectStack`'s `program` option is only ever
   * invoked by `stack.preview()`/`.up()`/`.refresh()` — `stack.outputs()`
   * reads the already-persisted checkpoint/state, never re-running the
   * program (confirmed against `@pulumi/pulumi/automation/stack.js`). This
   * method is read-only, so it passes a trivial `async () => ({})` rather
   * than importing `@hyveon/infra`'s real `createInfraProgram` (which needs
   * a full `DeploymentConfig` this read has no reason to assemble) — keeping
   * this read path decoupled from the `@hyveon/infra` package entirely.
   *
   * ## "Empty outputs" also degrades to `null`
   *
   * A stack that exists but has never had a successful `up()` (e.g. only
   * `preview()` has ever run) reports `stack.outputs()` as `{}` — treated as
   * "not deployed" here too: an empty outputs map means infra isn't yet
   * deployed.
   */
  async getStackOutputs(): Promise<StackOutputs | null> {
    logger.debug('PulumiService.getStackOutputs: reading stack outputs');
    if (this.stackInitInFlight || this.operationInFlight) {
      logger.warn('PulumiService.getStackOutputs: an operation is in flight, treating as not deployed', {
        stackInitInFlight: this.stackInitInFlight,
        operationInFlight: this.operationInFlight,
      });
      return null;
    }

    const stateBucket = this.store.get('bootstrap')?.stateBucket;
    if (!stateBucket) {
      return null;
    }

    const hasStoredPassphrase = this.store.get('pulumi')?.passphrase !== undefined;
    if (!hasStoredPassphrase) {
      return null;
    }

    const stateBucketRegion = this.store.get('aws')?.region;
    if (!stateBucketRegion) {
      return null;
    }

    let outputs: OutputMap;
    try {
      const stack = await this.workspace.getOrCreateStack({
        program: async () => ({}),
        stateBucket,
        stateBucketRegion,
        backendReady: true,
      });
      outputs = await stack.outputs();
    } catch (err) {
      // See this method's doc comment for why every kind of failure here
      // (not just a missing backend) degrades to `null` rather than
      // propagating — the never-throw contract every call site relies on.
      logger.warn('PulumiService.getStackOutputs: failed to read stack outputs, treating as not deployed', {
        err,
      });
      return null;
    }

    if (Object.keys(outputs).length === 0) {
      logger.warn('Pulumi stack has no outputs — infra not yet deployed');
      return null;
    }

    return PulumiService.projectStackOutputs(outputs);
  }

  /**
   * Projects a raw Automation API {@link OutputMap} into {@link StackOutputs}.
   * NO key translation happens here: `@hyveon/infra`'s `buildStackOutputs`
   * already returns an object keyed by the exact `StackOutputs` field names,
   * and the Automation API registers whatever the program returns as-is as
   * the stack's output keys — so `outputs[key].value` reads directly for
   * every field. Per-field fallbacks apply the field's default for a key
   * that's absent (e.g. state predates that output).
   */
  private static projectStackOutputs(outputs: OutputMap): StackOutputs {
    const get = <T>(key: keyof StackOutputs, fallback: T): T =>
      key in outputs ? (outputs[key]!.value as T) : fallback;

    return {
      awsRegion: get('awsRegion', 'us-east-1'),
      ecsClusterName: get('ecsClusterName', ''),
      ecsClusterArn: get('ecsClusterArn', ''),
      subnetIds: get('subnetIds', []),
      securityGroupId: get('securityGroupId', ''),
      fileManagerSecurityGroupId: get('fileManagerSecurityGroupId', ''),
      efsFileSystemId: get('efsFileSystemId', ''),
      efsAccessPoints: get('efsAccessPoints', {}),
      domainName: get('domainName', ''),
      gameNames: get('gameNames', []),
      discordTableName: get('discordTableName', ''),
      auditTableName: get('auditTableName', ''),
      runsTableName: get('runsTableName', ''),
      discordBotTokenSecretArn: get('discordBotTokenSecretArn', ''),
      discordPublicKeySecretArn: get('discordPublicKeySecretArn', ''),
      fileBrowserCredentialSecretArn: get('fileBrowserCredentialSecretArn', ''),
      fileBrowserSchedulerRoleArn: get('fileBrowserSchedulerRoleArn', ''),
      interactionsInvokeUrl: get('interactionsInvokeUrl', null),
      discordInteractionsUrl: get('discordInteractionsUrl', null),
      appliedGameServers: get('appliedGameServers', null),
    };
  }

  /**
   * The wizard's stack-initialization step (`IacController.init` is a
   * permanent, documented-dead rejection stub — see that method's own
   * TSDoc for the full history). Initializes — or, on a retry, re-verifies — the one Pulumi
   * stack this app manages end to end: resolves the engine, constructs (or
   * selects) the Automation API workspace/stack against the operator's S3
   * backend via {@link PulumiWorkspaceService.getOrCreateStack} (generating
   * a fresh secrets passphrase the first time this stack is ever created,
   * verified against the real backend rather than any caller-supplied
   * belief — see that method's own doc comment, "Call order"), explicitly
   * installs the pinned `@pulumi/aws`
   * provider plugin, then runs a real (if inert) `pulumi refresh` against
   * the brand-new, zero-resource stack to prove the whole round trip —
   * engine, backend, credentials, and plugin — actually works.
   *
   * ## Why this exists, and why its `program` is inert
   *
   * The wizard's final step needs something to run and report live progress
   * on before "Finish setup" can enable — this is that something. Unlike
   * every other stack-touching method on this class (`preview`/`apply`/
   * `destroy`), this one runs before any `DeploymentConfig` has ever been
   * written to the configuration bucket — the wizard's bootstrap step only
   * provisions the S3 buckets themselves; game servers are configured later,
   * from the dashboard. So `program` here is {@link noOpProgram}, an inert,
   * zero-resource {@link PulumiFn}, never `createInfraProgram(deploymentConfig, ...)`.
   * That has a real consequence for the 'plugins' phase below.
   *
   * ## The three phases, and why 'plugins' needs an explicit step here
   *
   * `PulumiEngineService.resolve`'s own TSDoc ("What 4.6 could not complete
   * now") expected a future caller to report `'plugins'`/`'operation'` by
   * approximating them around an *implicit* provider-plugin download that
   * happens lazily the first time a real resource is registered during
   * `preview()`/`up()`/`destroy()`. That approximation cannot work here:
   * {@link noOpProgram} registers zero resources, so nothing would ever
   * implicitly trigger an `aws` provider plugin download — `stack.refresh()`
   * against an empty program and empty state genuinely never touches the
   * `aws` plugin at all. So 'plugins' here is a real, explicit
   * `workspace.installPlugin(...)` call (the equivalent of running
   * `pulumi plugin install resource aws <version>` directly) rather than
   * an approximation — a stronger, more literal signal than `preview`/`apply`/
   * `destroy` get, not a weaker one. The exact version installed is read
   * from `@pulumi/aws`'s own installed `package.json` (see
   * {@link resolveAwsProviderVersion}) so it
   * can never drift from the version `createInfraProgram`'s real resource
   * declarations would themselves request once a real deployment config
   * exists (both `@hyveon/infra` and this package pin the identical
   * `@pulumi/aws` version today — confirmed by reading both `package.json`s
   * — and `@pulumi/aws`'s own `resourceOptsDefaults()` resolves every real
   * resource's provider version from that same installed `package.json`).
   *
   * 'engine' is reported by {@link PulumiWorkspaceService.getOrCreateStack}
   * itself (threaded through to `PulumiEngineService.resolve`) —
   * this method does not fire it directly, only forwards `onPhase` into that
   * call. 'operation' wraps the `stack.refresh()` call: with zero resources
   * in state, this is trivially a no-op change-wise (and, as the spike
   * demonstrated against its `file://` backend — it does not exercise the DIY
   * S3 backend — `LocalWorkspace.createOrSelectStack`'s own stack-init
   * path already durably writes the stack's empty checkpoint to the backend
   * as part of the 'engine' step above — this call is not literally the
   * moment the stack first becomes durable) — but it still exercises the
   * full engine-execution path end to end (spawns the CLI, connects the
   * in-process language runtime, reads/writes against the real S3 backend)
   * — the closest thing to "prove this stack actually works" available
   * before any real infrastructure is configured, which is what the
   * renderer's UI frames this phase as ("stack creation" / "verifying
   * stack").
   *
   * `onPhase` receives a `'start'`/`'end'` pair for every phase this method
   * actually reaches, in order. `'end'` fires whether that phase succeeded
   * or failed — mirrors `PulumiPhaseStatus`'s own documented meaning
   * ("beginning or has settled, success or failure alike"). A phase never
   * reached (because an earlier one failed) never fires at all — a caller
   * can treat "no `'start'` ever received" as "still pending" for that
   * phase.
   *
   * ## Error attribution
   *
   * Rethrows every failure as {@link PulumiStackInitializationError}, tagging
   * exactly which of the three phases failed:
   *  - `'engine'` for anything {@link classifyGetOrCreateStackFailure}
   *    identifies as happening at or before `engine.resolve()` settles —
   *    covers a missing state bucket/region (checked directly by this
   *    method, before `getOrCreateStack` is ever called), a genuine engine
   *    provisioning failure (`PulumiEngineNetworkError`/
   *    `PulumiEngineIntegrityError`/`PulumiEngineCacheWriteError`), and
   *    anything thrown strictly before `engine.resolve()` runs
   *    (`PulumiPassphraseUnavailableError`, `PulumiCredentialsNotConfiguredError`)
   *    — none of the pre-engine cases has its own phase slot in this
   *    method's 3-phase model, so they bucket into
   *    'engine' as the closest fit.
   *  - `'operation'` if `getOrCreateStack` fails AFTER `engine.resolve()`
   *    already succeeded — i.e. the underlying `LocalWorkspace.createOrSelectStack`
   *    (`stack init`/`stack select`) call itself failed for some other
   *    reason (a bad backend URL, a stale bucket) — since that call's whole
   *    purpose IS creating/selecting the stack, which is what the
   *    'operation' phase represents in this method's UI framing, even
   *    though the failure surfaces from inside the same `getOrCreateStack`
   *    call that also resolves the engine. See
   *    {@link classifyGetOrCreateStackFailure}'s own TSDoc for exactly how
   *    this is determined — deliberately by the thrown error's own type,
   *    NOT by whether `onPhase` already reported `('engine', 'end')` (fixed
   *    in review — `PulumiEngineService.resolve` fires `'end'` on both its
   *    success and failure paths, so that signal alone can't tell them
   *    apart).
   *  - `'plugins'` / `'operation'` for a failure inside the respective step
   *    directly.
   *
   * ## Workspace mutual exclusion
   *
   * Refuses to start while {@link operationInFlight} is set, exactly like
   * `preview`/`apply`/`destroy`/`confirmRollback` — this method touches the
   * same shared local `workDir`/`Pulumi.<stack>.yaml` they do (via
   * `getOrCreateStack`), so two operations racing that shared state would be
   * just as unsafe here as anywhere else on this class. See
   * {@link stackInitInFlight}'s own doc comment for why THIS method's own
   * busy state is a separate flag rather than a fifth {@link operationInFlight}
   * value, and for the accepted, documented scope cut that follows from that
   * choice (preview/apply/destroy do not refuse while `initializeStack` is
   * running) — the DIY S3 backend's own distributed lock (surfaced elsewhere
   * on this class as `PulumiUnrecognizedLockError`) is the backstop for that
   * gap if it is ever actually hit, not a substitute for closing it properly
   * should a real need for symmetric protection show up later.
   *
   * @param onPhase - Optional progress callback; see above for exactly which
   *   events it receives and when.
   * @throws {@link PulumiOperationInFlightError} if `preview`/`apply`/
   *   `destroy`/`confirmRollback` is already running.
   * @throws `Error` if this method is already running (reentrancy guard).
   * @throws `Error` if the state bucket / AWS region has not been configured
   *   yet (wrapped as {@link PulumiStackInitializationError} with
   *   `phase: 'engine'`).
   * @throws {@link PulumiStackInitializationError} for every other failure —
   *   see "Error attribution" above.
   */
  async initializeStack(onPhase?: PulumiPhaseCallback): Promise<void> {
    logger.debug('PulumiService.initializeStack: initializing pulumi stack');
    if (this.operationInFlight) {
      throw new PulumiOperationInFlightError(this.operationInFlight);
    }
    if (this.stackInitInFlight) {
      throw new Error(
        'PulumiService.initializeStack() is already running; wait for it to finish before calling it again.',
      );
    }
    this.stackInitInFlight = true;
    try {
      const stateBucket = this.store.get('bootstrap')?.stateBucket;
      const stateBucketRegion = this.store.get('aws')?.region;
      if (!stateBucket || !stateBucketRegion) {
        throw new PulumiStackInitializationError(
          'engine',
          new Error(
            'Cannot initialize the Pulumi stack: the state bucket / AWS region has not been ' +
              'configured yet. Complete the bootstrap step before continuing.',
          ),
        );
      }
      let stack: Stack;
      try {
        stack = await this.workspace.getOrCreateStack({
          program: PulumiService.noOpProgram,
          stateBucket,
          stateBucketRegion,
          backendReady: true,
          onPhase,
        });
      } catch (err) {
        logger.error('PulumiService.initializeStack: getOrCreateStack failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw new PulumiStackInitializationError(PulumiService.classifyGetOrCreateStackFailure(err), err);
      }

      onPhase?.('plugins', 'start');
      try {
        await stack.workspace.installPlugin('aws', PulumiService.resolveAwsProviderVersion(), 'resource');
      } catch (err) {
        logger.error('PulumiService.initializeStack: installPlugin("aws") failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw new PulumiStackInitializationError('plugins', err);
      } finally {
        onPhase?.('plugins', 'end');
      }

      onPhase?.('operation', 'start');
      // Lock-recovery bookkeeping — recorded
      // immediately before the call that can actually take the DIY
      // backend lock, mirroring `apply()`/`destroy()`'s identical
      // "recorded immediately before, cleared on every normal settlement"
      // pattern (see either method's own "Lock-recovery wiring" TSDoc
      // section). `stack.refresh()`, unlike `stack.preview()` (which
      // `preview()`'s own TSDoc documents never takes this lock at all),
      // does take it — so a force-quit mid-refresh needs the same
      // ownership record `apply`/`destroy` leave behind, or a later
      // `PulumiUnrecognizedLockError` can never be proven this
      // installation's own orphan. Deliberately does NOT also wire the
      // full retry-on-reclaimable-orphan / `PulumiUnrecognizedLockError`
      // classification `apply`/`destroy` build around their own
      // lock-taking call — this records ownership for accountability
      // only, not the full recovery apparatus: against a
      // brand-new, zero-resource stack, the wizard's own Retry button is
      // already a strictly simpler, always-available recovery path than
      // reproducing that machinery here would add.
      const lockAttemptId = this.store.recordPulumiLockAttempt(PULUMI_STACK_NAME);
      try {
        await stack.refresh();
      } catch (err) {
        logger.error('PulumiService.initializeStack: stack.refresh() failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw new PulumiStackInitializationError('operation', err);
      } finally {
        this.store.clearPulumiLockAttempt(lockAttemptId);
        onPhase?.('operation', 'end');
      }
    } finally {
      this.stackInitInFlight = false;
    }
  }

  /**
   * Inert, zero-resource {@link PulumiFn} {@link initializeStack} passes to
   * `getOrCreateStack` — see that method's own TSDoc ("Why this exists, and
   * why its `program` is inert") for why a real
   * `createInfraProgram(deploymentConfig, ...)` program cannot be built yet
   * at the point in the first-run wizard this method runs. Registers zero
   * resources and returns no outputs; never actually invoked by anything
   * `initializeStack` calls (`getOrCreateStack`'s stack-init/stack-select
   * path never runs the program, and neither does `workspace.installPlugin`)
   * — `stack.refresh()` is the one call in this
   * method that WOULD invoke it, and does, but against an empty checkpoint
   * evaluating this program is a no-op.
   */
  private static readonly noOpProgram: PulumiFn = async () => {};

  /**
   * Resolves the exact `@pulumi/aws` provider version {@link initializeStack}
   * explicitly installs for its 'plugins' phase — read directly from
   * `@pulumi/aws`'s own installed `package.json` (via `createRequire`,
   * mirroring `PulumiWorkspaceService.resolveUserDataPath`'s identical
   * externalized-CJS-import pattern — `@pulumi/aws` is externalized in
   * `electron.vite.config.ts` exactly like `@pulumi/pulumi`, so it is always
   * loaded from `node_modules` at runtime, never bundled) rather than a
   * hand-maintained literal, so a future `@pulumi/aws` version bump in
   * `package.json` can never drift out of sync with what this install
   * targets. This is the SAME version `createInfraProgram`'s real resource
   * declarations resolve via `@pulumi/aws`'s own `resourceOptsDefaults()`
   * (`utilities.js`), so the plugin this explicitly installs is the plugin a
   * genuine `preview()`/`up()` against a populated `DeploymentConfig` would
   * themselves lazily request anyway.
   */
  private static resolveAwsProviderVersion(): string {
    const _require = createRequire(import.meta.url);
    const { version } = _require('@pulumi/aws/package.json') as { version: string };
    return version;
  }

  /**
   * Classifies a failure thrown by `getOrCreateStack` inside
   * {@link initializeStack} as either the `'engine'` or `'operation'` phase
   * — see that method's own TSDoc, "Error attribution", for the two cases
   * this distinguishes.
   *
   * Deliberately does NOT infer this from the `onPhase` callback's own
   * `('engine', 'end')` event: `PulumiEngineService.resolve` fires
   * `('engine', 'end')` on BOTH its success and rejection paths (see that
   * method's own TSDoc, "reporting is per-call... whether it settles by
   * resolving... or by rejecting"), so "engine reported `'end'`" is not the
   * same as "engine resolution succeeded" — inferring the phase from that
   * event would mis-tag a genuine engine-download failure as `'operation'`,
   * directly contradicting the phase checklist the renderer shows alongside
   * the error (which correctly marks 'engine' as the one that failed, since
   * it derives its own attribution from
   * which phase's `'start'` never got a matching successful `'end'`).
   *
   * Classifies by the THROWN ERROR'S OWN TYPE instead, which is unambiguous
   * regardless of event timing — verified against
   * `PulumiWorkspaceService.getOrCreateStack`'s actual control flow
   * (`PulumiWorkspaceService.ts`): every pre-engine-or-engine failure is one
   * of exactly six typed errors — {@link PulumiPassphraseUnavailableError},
   * `PulumiCredentialsNotConfiguredError`, and
   * `AwsPastedCredentialDecryptError` (all resolved/thrown before or without
   * ever needing a genuine `LocalWorkspace.createOrSelectStack`/
   * `Stack.createOrSelect` round-trip against the backend — see below), or
   * one of `PulumiEngineNetworkError`/`PulumiEngineIntegrityError`/
   * `PulumiEngineCacheWriteError` (thrown BY `engine.resolve()` itself,
   * propagated unwrapped — `getOrCreateStack` does not try/catch that
   * call). Anything else can only have come from the LATER
   * `Stack.createOrSelect` call (a bad backend URL, a stale bucket, or that
   * call's own `PulumiBackendNotBootstrappedError` backstop-reclassification)
   * — i.e. `engine.resolve()` already succeeded by the time the failure
   * happened, so it's an `'operation'` failure in this method's 3-phase UI
   * framing.
   *
   * `AwsPastedCredentialDecryptError` belongs in this pre-engine list too:
   * `resolveCredentialEnvVars` → `resolveAwsCredentialSource` →
   * `ElectronStoreService.getPastedCredentials` → `SafeStorageService.decrypt`
   * can throw Electron's own raw decrypt error on a corrupt/foreign
   * pasted-credentials ciphertext blob, and `awsCredentialSource.ts` wraps
   * that in this typed class — credential resolution happens strictly
   * before `engine.resolve()` (see `getOrCreateStack`'s own body), so it is
   * genuinely a pre-engine failure.
   *
   * `PulumiPassphraseUnavailableError`'s `'existing-stack-no-local-record'`
   * and `'new-stack-keychain-unavailable'` reasons can be thrown after
   * `engine.resolve()` succeeds, once a genuine `LocalWorkspace` exists to
   * probe (see {@link PulumiWorkspaceService.getOrCreateStack}'s "Call
   * order" doc section) — irrelevant here, since this classifier keys on
   * the thrown error's TYPE, never on which phase happened to be running
   * when it was thrown.
   */
  private static classifyGetOrCreateStackFailure(err: unknown): 'engine' | 'operation' {
    const isPreEngineOrEngineFailure =
      err instanceof PulumiPassphraseUnavailableError ||
      err instanceof PulumiCredentialsNotConfiguredError ||
      err instanceof AwsPastedCredentialDecryptError ||
      err instanceof PulumiEngineNetworkError ||
      err instanceof PulumiEngineIntegrityError ||
      err instanceof PulumiEngineCacheWriteError;
    return isPreEngineOrEngineFailure ? 'engine' : 'operation';
  }

  /**
   * Collects every operator-set game-server environment variable value out
   * of `deploymentConfig.gameServers`, for scrubbing from Pulumi's streamed
   * stdout/stderr before it is logged (see {@link redactEnvironmentValues}).
   *
   * @remarks
   * Values shorter than {@link MIN_REDACTABLE_ENV_VALUE_LENGTH} are dropped
   * from the set — a 1-3 character value (e.g. `"1"`, `"true"`'s prefix, an
   * empty string) is common in unrelated engine output and would produce
   * false-positive redactions that mangle the log rather than protect
   * anything.
   * @param deploymentConfig - The deployment configuration the in-flight
   *   `preview`/`up` operation was built from.
   * @returns The set of distinct, sufficiently long environment values to
   *   redact.
   */
  private static buildEnvironmentRedactionSet(deploymentConfig: DeploymentConfig): Set<string> {
    return new Set(
      Object.values(deploymentConfig.gameServers)
        .flatMap((game) => game.environment ?? [])
        .map((entry) => entry.value)
        .filter((value) => value.length >= MIN_REDACTABLE_ENV_VALUE_LENGTH),
    );
  }

  /**
   * Replaces every occurrence of every value in `redactedValues` within
   * `line` with {@link ENV_REDACTION_PLACEHOLDER}.
   *
   * @remarks
   * This is the only guard between an operator's plaintext container
   * environment values (e.g. an RCON password or API key set on a game
   * server) and the persisted `pulumi.log` / streamed run output — Pulumi's
   * own console output legitimately prints stack outputs, which include
   * {@link DeploymentConfig.gameServers}' `environment` values verbatim via
   * `appliedGameServers` (`program.ts`). This deliberately redacts ALL
   * values unconditionally rather than only ones an operator marks
   * sensitive — `GameServerConfig` has no per-key sensitivity marker today.
   * @remarks
   * Values are applied longest-first so that a shorter value which happens
   * to be a substring of a longer one (e.g. `abcd` inside `abcd-secret`)
   * cannot redact the longer value's prefix and leave its suffix exposed in
   * the output.
   * @param line - A single streamed line of Pulumi stdout/stderr.
   * @param redactedValues - The value set built by
   *   {@link buildEnvironmentRedactionSet}.
   * @returns `line` with every redacted value replaced.
   */
  private static redactEnvironmentValues(line: string, redactedValues: Set<string>): string {
    let redacted = line;
    for (const value of [...redactedValues].sort((a, b) => b.length - a.length)) {
      redacted = redacted.split(value).join(ENV_REDACTION_PLACEHOLDER);
    }
    return redacted;
  }

  /**
   * Runs `pulumi preview` against the current deployment configuration,
   * yielding a {@link PulumiRunChunk} per line of stdout/stderr as the
   * operation produces it, and resolving to a {@link PulumiPreviewResult}
   * once it settles. A generator (positional args, `runId`/`startedAt`
   * hoisted above the `try` so a force-closed generator's outer `finally`
   * can still persist a cancelled record, an operation-in-flight guard,
   * `beginActiveRun` registered before the pre-spawn awaits so an early
   * `streamRunOutput` subscriber never falls through to "unknown run").
   *
   * ## This method is a thin lock-owning wrapper around {@link previewCore}
   *
   * Everything this doc comment describes about the actual plan operation
   * (streaming, hashing, persistence, cancellation, …) lives in
   * {@link previewCore} — this method itself does exactly two things: refuse
   * if {@link operationInFlight} is already set, then set it to `'preview'`
   * for the duration of the delegated call. This split exists so
   * {@link confirmRollback} can run the SAME plan logic under a
   * lock it already acquired itself (`'rollback'`, not `'preview'`) —
   * without it, `confirmRollback` calling this method directly would either
   * refuse itself (this method's own busy check seeing the lock
   * `confirmRollback` is already holding) or, if this method's guard were
   * bypassed some other way, leave two independent owners of
   * {@link operationInFlight} racing to clear it. See {@link previewCore}'s
   * own doc comment and {@link confirmRollback}'s "Lock acquisition" section
   * for the full design.
   *
   * ## Does `preview` take the DIY backend lock?
   *
   * **No — verified against the Pulumi CLI's Go source.** `pkg/backend/diy/backend.go`
   * (fetched from the `pulumi/pulumi` GitHub repo, `master` branch)
   * shows `diyBackend.Preview` calling `b.apply`
   * directly:
   *
   * ```go
   * func (b *diyBackend) Preview(...) (*deploy.Plan, sdkDisplay.ResourceChanges, error) {
   *     // We can skip PreviewThenPromptThenExecute and just go straight to Execute.
   *     opts := backend.ApplierOptions{DryRun: true, ShowLink: true}
   *     return b.apply(ctx, apitype.PreviewUpdate, stack, op, opts, events)
   * }
   * ```
   *
   * — with **no** `b.Lock`/`b.Unlock` call anywhere in that path. Contrast
   * `diyBackend.Update` (the `up` path), which wraps its own
   * call in `err := b.Lock(ctx, stack.Ref()); defer b.Unlock(ctx, stack.Ref())`
   * before proceeding — same for `Import`/`Refresh`/`Destroy`. `Lock` itself
   * calls `checkForLock` (`pkg/backend/diy/lock.go`), which is what produces
   * the `"the stack is currently locked by"` conflict text
   * `PulumiLockRecovery.ts` classifies — since `Preview` never calls `Lock`,
   * it can never observe or report a conflicting lock at all; it reads
   * whatever state snapshot is on disk at the moment it runs, unlocked and
   * unsynchronized with any concurrent `up`/`destroy`. **Conclusion: this
   * method deliberately does NOT wire `ElectronStoreService.recordPulumiLockAttempt`/
   * `clearPulumiLockAttempt` or `PulumiLockRecovery`'s classification** —
   * there is nothing for them to guard here. `up` needs this wiring, since
   * `Update` genuinely takes the lock — see {@link apply}'s own
   * lock-recovery wiring.
   *
   * ## Leaked-promise `recoverResult`
   *
   * Confirmed against the SDK's own `PreviewResult` shape (`stack.d.ts`):
   * `{ stdout, stderr, changeSummary }` — nothing this method doesn't
   * already have in hand by the time a leak could occur. `stack.js`'s
   * `preview()` computes `changeSummary` from the exact same `summaryEvent`
   * this method's own `onEvent` callback (below) already captures — the SDK
   * only loses access to it because the leak-check throw replaces the
   * `return` statement, not because the data itself is unavailable. The
   * saved plan artifact (`--save-plan`) is written by the CLI subprocess
   * *before* it exits — i.e. before `runPulumiCmd` resolves and the SDK's
   * `finally`-block leak check even runs — so it's already on disk
   * regardless of which path (clean success or leak-recovery) is taken.
   * **Conclusion: `recoverResult` needs to re-read nothing** — it
   * synthesizes `{ stdout: '', stderr: '', changeSummary }` from the
   * `changeSummary` this method already captured via `onEvent`. `stdout`/
   * `stderr` are left empty in the synthetic result because this method
   * never reads `PreviewResult.stdout`/`.stderr` anyway (the chunk-streaming
   * loop below already captured and yielded every line via `onOutput`/
   * `onError` as it streamed, independent of the SDK's own buffered
   * `stdout`/`stderr` strings).
   *
   * ## Engine-version stamping
   *
   * The saved plan artifact's own `manifest.version` field (e.g.
   * `"v3.255.0"`, WITH a `v` prefix) is read by
   * {@link readEngineVersionFromPlanArtifact}, which strips the prefix
   * before returning — so {@link PulumiPreviewResult.engineVersion} is
   * stored un-prefixed (`"3.255.0"`), directly comparable via a bare string
   * equality against `PulumiEngineService.getResolvedVersion()`'s own
   * un-prefixed shape (`SemVer.toString()` never includes one). Normalizing
   * once here, at write time, means apply's later comparison is a
   * plain `===` with no format trap to rediscover.
   *
   * `engineVersion` is persisted as a field *separate from* {@link planHash}
   * rather than folded into it. Folding it into the hash would make an
   * apply-time mismatch unable to tell "the plan or config changed"
   * apart from "only the engine was upgraded" — the `iac-plan-apply-page`
   * spec's "Engine upgraded between plan and apply" scenario requires an
   * error that *names the version change* specifically, which needs the two
   * failure causes distinguishable. A separate field lets `apply` check
   * independently: hash mismatch → generic staleness error; hash match but
   * `engineVersion` differs from `PulumiEngineService.getResolvedVersion()`
   * → the specific "engine upgraded" error.
   *
   * ## Structured `changeSummary`, not scraped stdout
   *
   * `onEvent` captures `event.summaryEvent.resourceChanges` into a local
   * variable exactly the way the SDK's own internal `onEvent` wrapper does
   * (`stack.js`'s `preview()`) — this method's own capture exists
   * specifically so the leaked-promise recovery path above still has it
   * (the SDK's internal capture is not exposed to a caller once the throw
   * replaces its `return`). On every other path, this method's captured
   * value and `PreviewResult.changeSummary` are identical (same
   * `summaryEvent`), so `previewResult.changeSummary` is used directly for
   * the returned result — see {@link ChangeSummary}'s doc comment for the
   * `{}`-means-"summary missed" sharp edge every reader must respect.
   *
   * ## Chunk streaming (ported from `spawnAndStream`'s algorithm)
   *
   * `onOutput`/`onError` deliver **unbounded chunks, not lines** — the exact same shape
   * `spawnAndStream`'s `child.stdout`/`.stderr` `'data'` handlers received.
   * The line-splitting algorithm is ported verbatim: accumulate a per-stream
   * buffer, `split(/\r?\n/)`, hold back the trailing partial line, flush any
   * remainder once the operation settles. What's ported *differently* is the
   * production side: `spawnAndStream` drives its queue from `child.on('data'/'close')`
   * event-emitter callbacks; this method has no child-process handle to
   * listen on (the Automation API's `onOutput`/`onError` are plain callbacks
   * passed into `stack.preview()`), so the same queue/wake/notify consumer
   * loop is instead fed by those callbacks directly, and "closed" is
   * signalled by the wrapped `stack.preview()` promise settling (success or
   * error alike) rather than a `child.on('close', ...)` event.
   *
   * ## Cancellation
   *
   * The whole `stack.preview()` call (wrapped in the leaked-promise
   * recovery above) is wrapped again in {@link runWithEscalatingCancellation},
   * which forwards a signal into `PreviewOptions.signal` and
   * escalates to a logical forced-termination if the operation doesn't
   * settle within the bounded window after that signal aborts — see that
   * function's own TSDoc for the three distinct settlement shapes
   * ({@link PulumiOperationNotStartedError}/{@link PulumiOperationAbortedError}/
   * {@link PulumiOperationEscalatedError}) this method treats as "aborted"
   * (ending the generator cleanly, resolving `undefined`) rather than a
   * genuine {@link PulumiPreviewError} failure. No `onEscalate` hook is
   * supplied — `preview` has no backend lock to forcefully clear (see
   * above), so there is nothing for this extension point to do here;
   * `apply`'s `up` path is the more likely place for one.
   *
   * The signal actually forwarded is an internal `AbortController` this
   * method owns (mirroring `signal` when the caller supplies one — abort
   * events are chained one-way, caller → internal), NOT `signal` directly.
   * This exists so a **force-closed generator** (a consumer calling
   * `break`/`.return()`/`.throw()` on the generator itself, independent of
   * whether `signal` was ever provided or aborted) still has something to
   * cancel: the outer `finally` below aborts this internal controller and
   * AWAITS the resulting settlement before clearing {@link operationInFlight},
   * so a torn-down consumer can never leave the CLI subprocess (and the
   * shared workspace directory it's still writing to) running unsupervised
   * while this instance reports itself free for a new operation — see the
   * outer `finally`'s own comment for the full rationale.
   *
   * ## Persistence
   *
   * Once the operation settles (success, failure, or abort), this method
   * writes the accumulated transcript (`writeRunLog`), settles the active-run buffer
   * (`endActiveRun`), writes the local `<runsDir>/<runId>/run.json`
   * (`writeRunRecord`), and persists the same record to the cloud-agnostic
   * run-history store (`persistRunRecord`, via {@link RunRecordPersister}) —
   * on every exit path, including the force-closed-generator path handled
   * by the outer `finally` below. A persistence failure is wrapped in
   * {@link PulumiRunPersistError} (carrying the already-computed outcome)
   * rather than discarding it.
   *
   * @param configVersionId - The deployment-config object's S3 version id
   *   this preview is expected to run against, if the caller has one (e.g.
   *   re-running a preview after a prior stale one). When supplied and it no
   *   longer matches the configuration object's current head version, throws
   *   before any Pulumi call is made — an inline staleness check unrelated
   *   to {@link planHash}'s hash mechanism, which always covers whatever
   *   version id was actually observed. Ignored entirely when omitted —
   *   there is no prior expectation to compare against.
   * @param signal - Optional cancellation signal — see "Cancellation" above.
   * @param preMintedRunId - Optional caller-minted `runId` — must match
   *   {@link RUN_ID_PATTERN}.
   * @param rolledBackFrom - The `runId` of the `apply` run this preview is
   *   re-planning after a rollback — passed
   *   through to the persisted run record unchanged.
   * @throws A descriptive `Error` if another `preview`/`up`/`destroy` is
   *   already in flight on this instance, or if `preMintedRunId` doesn't
   *   match {@link RUN_ID_PATTERN} — checked at the very top of the method
   *   body, so the throw happens the instant the generator is first driven
   *   (its first `.next()` call), before any `await`; note this is NOT the
   *   same as "synchronously from the `preview(...)` call itself" — like any
   *   async generator, calling `preview(...)` only constructs the generator
   *   object and runs none of this method's body until iteration begins.
   * @throws A descriptive `Error` if no configuration bucket is configured,
   *   the configuration object doesn't exist, or `configVersionId` is stale
   *   (see above).
   * @throws {@link PulumiPreviewError} if `stack.preview()` itself fails (not
   *   an abort).
   * @throws {@link PulumiPlanHashError} if the operation succeeded but the
   *   saved plan artifact couldn't be hashed or its `manifest.version`
   *   couldn't be read afterward.
   * @throws {@link PulumiRunPersistError} if the operation settled but the
   *   run record couldn't be persisted afterward.
   */
  async *preview(
    configVersionId?: string,
    signal?: AbortSignal,
    preMintedRunId?: string,
    rolledBackFrom?: string,
  ): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult | undefined> {
    logger.debug('PulumiService.preview: starting pulumi preview', { preMintedRunId });
    if (this.operationInFlight) {
      throw new Error(
        `PulumiService.preview() cannot run while ${this.operationInFlight}() is already ` +
          'running; wait for it to finish before calling preview() again.',
      );
    }
    this.assertStackInitNotInFlight('preview');
    if (preMintedRunId !== undefined) {
      PulumiService.assertValidRunId(preMintedRunId);
    }
    this.operationInFlight = 'preview';
    try {
      return yield* this.previewCore(configVersionId, signal, preMintedRunId, rolledBackFrom);
    } finally {
      this.operationInFlight = null;
    }
  }

  /**
   * The actual `pulumi preview` operation {@link preview} runs — every
   * behavior preview's own TSDoc documents (streaming, plan-hash
   * computation, cancellation, persistence, the force-closed-generator
   * safety net) lives here unchanged. Split out from {@link preview} by task
   * 7.6 for exactly one reason: {@link confirmRollback} needs to run this
   * SAME logic while it, not this method, owns {@link operationInFlight}
   * (acquired as `'rollback'` before the historic configuration is
   * restored, and held across the restore AND this call — see
   * {@link confirmRollback}'s TSDoc). This method therefore does NOT touch
   * {@link operationInFlight} at all — neither the busy check nor the
   * set/clear — trusting whichever caller invoked it ({@link preview} or
   * {@link confirmRollback}) to have already claimed it and to release it
   * once this generator (and, for {@link confirmRollback}, whatever runs
   * after it) has fully settled. Never call this method without
   * {@link operationInFlight} already set by the caller — it has no guard of
   * its own against two concurrent invocations racing the shared local
   * workspace directory.
   *
   * `preMintedRunId` validation also moved to each caller's own top-of-
   * function guard (mirroring `apply()`/`destroy()`'s identical pattern)
   * rather than living here, so both {@link preview} and
   * {@link confirmRollback} reject a malformed id before either one ever
   * touches {@link operationInFlight} — this method trusts it's already
   * valid by the time it's called.
   */
  private async *previewCore(
    configVersionId?: string,
    signal?: AbortSignal,
    preMintedRunId?: string,
    rolledBackFrom?: string,
  ): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult | undefined> {
    // Hoisted above the try block: a force-closed generator (consumer
    // break/.return()/.throw()) unwinds straight from `yield chunk` below,
    // past the writeRunRecord call further down, to the outer finally,
    // which needs to see these.
    let runId: string | undefined;
    let startedAt: string | undefined;
    let runRecordWritten = false;
    // Accumulates every yielded chunk's `line` so the full transcript can be
    // written to `<runsDir>/<runId>/pulumi.log` in a single `writeFileSync`
    // once the operation has settled.
    const logLines: string[] = [];
    // `internalController`/`operationPromise`/`operationSettled` are hoisted
    // (not declared inside the try block) so the outer `finally` can abort
    // AND await a still-running `stack.preview()` call if this generator is
    // force-closed (consumer `break`/`.return()`/`.throw()`) while the
    // operation is in flight — see the outer `finally`'s own comment for why
    // this is required, not optional. This generator has no inner
    // sub-generator to delegate cancellation to (the Automation API's
    // `onOutput`/`onError` are plain callbacks, not a stream this code owns
    // the lifecycle of) — the `internalController`/`operationPromise` pair
    // below is a hand-built equivalent: on force-close, it aborts the
    // in-flight `stack.preview()` call and awaits its settlement before this
    // generator's own outer finally proceeds to clear `operationInFlight`.
    //
    // `internalController` is ALWAYS the signal actually forwarded to
    // `stack.preview()` (via `runWithEscalatingCancellation`) — never the
    // caller-supplied `signal` directly. When `signal` is supplied, this
    // controller mirrors it (aborting the instant `signal` does); when the
    // generator is force-closed, the outer `finally` aborts THIS controller
    // directly, regardless of whether the caller ever supplied a `signal` at
    // all — otherwise a caller that never passes `signal` would have no
    // cancellation path at all on a force-close, leaving the CLI subprocess
    // to run to completion ungoverned while `operationInFlight` is already
    // cleared for a new call.
    // `onAbort` is named (not an inline anonymous handler) with
    // `{ once: true }`, plus an unconditional `removeEventListener` in the
    // outer `finally` below — this method (not `preview()` itself, which
    // just delegates to it) owns this cancellation shape, mirroring
    // apply()/destroy()'s identical fix (see either method's own TSDoc,
    // "Cancellation and abort-listener leak"). Without the explicit
    // detach, a caller reusing one long-lived `AbortSignal` across many
    // `preview()`/`confirmRollback()` calls would accumulate one listener
    // per call.
    const internalController = new AbortController();
    const onAbort = (): void => internalController.abort();
    if (signal) {
      if (signal.aborted) {
        internalController.abort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    // Set once `stack.preview()` has actually been invoked (via
    // `runWithEscalatingCancellation`) — `undefined` for the whole method if
    // an early guard (bucket not configured, stale config version, etc.)
    // returns/throws before ever reaching that point, in which case the
    // outer `finally` has nothing to abort/await.
    let operationPromise: Promise<PreviewResult> | undefined;
    // Flips to `true` once `operationPromise` has genuinely settled (success,
    // failure, or the bounded escalation timeout `runWithEscalatingCancellation`
    // itself enforces — see that function's own TSDoc for why awaiting
    // `operationPromise` in the outer `finally` below is still a BOUNDED
    // wait, not an indefinite one, even for a wedged engine). Doubles as the
    // chunk-drain loop's own "operation is done" signal further down.
    let operationSettled = false;
    try {
      if (internalController.signal.aborted) {
        // Already aborted before we even started — end the generator
        // cleanly without touching Pulumi at all, mirroring plan()'s
        // identical pre-spawn guard.
        return undefined;
      }

      // Mint (or adopt the pre-minted) runId and register its active-run
      // buffer *here* — before the pre-spawn awaits below (the config
      // fetch, then `getOrCreateStack`'s engine resolution) — so a
      // `streamRunOutput()` subscriber that arrives before those awaits
      // settle still finds the run already in flight.
      runId = preMintedRunId ?? randomUUID();
      this.beginActiveRun(runId);

      const bucket = this.getConfigurationBucket();
      if (!bucket) {
        throw new Error(
          'Cannot read deployment configuration for pulumi preview: no configuration bucket is configured. ' +
            'Finish the setup wizard before previewing.',
        );
      }

      const key = CONFIGURATION_OBJECT_KEY;
      const versions = await this.getRemoteFileStore().listVersions(key);
      const head = versions[0];
      if (!head) {
        throw new Error(`Configuration object "${key}" not found in S3 bucket "${bucket}".`);
      }
      if (configVersionId && head.versionId !== configVersionId) {
        throw new Error(
          `Configuration object "${key}" in S3 bucket "${bucket}" is stale for this preview: expected version ` +
            `"${configVersionId}" to still be the current head, but the head version is now ` +
            `"${head.versionId}". Refresh the configuration before previewing.`,
        );
      }
      const obj = await this.getRemoteFileStore().get(key);
      if (!obj) {
        throw new Error(`Configuration object "${key}" not found in S3 bucket "${bucket}".`);
      }
      // The version this run actually ran against — either the caller's
      // expectation (just confirmed to still be the head above) or, when no
      // expectation was supplied, whatever the head happened to be. Always
      // defined by the time `startedAt` is set below, so it's safe to record
      // on every outcome (success/failure/abort) — mirrors how `pullVarFile`
      // always resolves a var-file path before `plan()`'s own `startedAt` is set.
      const observedConfigVersionId = head.versionId;
      const deploymentConfig = JSON.parse(new TextDecoder().decode(obj.body)) as DeploymentConfig;
      const redactedEnvironmentValues = PulumiService.buildEnvironmentRedactionSet(deploymentConfig);

      if (internalController.signal.aborted) {
        // Aborted while reading the configuration — end cleanly before ever
        // touching Pulumi.
        return undefined;
      }

      const stateBucket = this.store.get('bootstrap')?.stateBucket;
      const stateBucketRegion = this.store.get('aws')?.region;
      if (!stateBucket || !stateBucketRegion) {
        throw new Error(
          'Cannot run pulumi preview: the state bucket / AWS region has not been configured yet. ' +
            'Complete the bootstrap step before previewing.',
        );
      }
      const stack = await this.workspace.getOrCreateStack({
        program: createInfraProgram(deploymentConfig, { lambdaBundlesDir: this.getLambdaBundlesDir() }),
        stateBucket,
        stateBucketRegion,
        backendReady: true,
      });

      if (internalController.signal.aborted) {
        // Aborted while resolving the workspace/engine — end cleanly before
        // calling stack.preview().
        return undefined;
      }

      const runDir = join(this.getRunsDir(), runId);
      mkdirSync(runDir, { recursive: true });
      const artifactPath = join(runDir, `${runId}.plan.json`);

      // --- Chunk-streaming setup (ported from spawnAndStream's algorithm — see this method's TSDoc) ---
      const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
      const queue: PulumiRunChunk[] = [];
      let wake: (() => void) | null = null;

      const notify = (): void => {
        wake?.();
        wake = null;
      };
      const push = (chunk: PulumiRunChunk): void => {
        // Redact operator-set environment values before this chunk reaches
        // any sink (recordRunChunk, the persisted pulumi.log, or a live
        // streamRunOutput subscriber) — see redactEnvironmentValues's TSDoc.
        queue.push({ ...chunk, line: PulumiService.redactEnvironmentValues(chunk.line, redactedEnvironmentValues) });
        notify();
      };
      const handleData = (stream: 'stdout' | 'stderr', data: string): void => {
        buffers[stream] += data;
        const lines = buffers[stream].split(/\r?\n/);
        buffers[stream] = lines.pop() ?? '';
        for (const line of lines) {
          push({ stream, line });
        }
      };

      let capturedChangeSummary: ChangeSummary = {};
      const onOutput = (out: string): void => handleData('stdout', out);
      const onError = (err: string): void => handleData('stderr', err);
      const onEvent = (event: EngineEvent): void => {
        if (event.summaryEvent) {
          // See this method's TSDoc "Structured changeSummary" section for
          // why this is captured independently of PreviewResult.changeSummary.
          capturedChangeSummary = event.summaryEvent.resourceChanges;
        }
      };

      // Captured immediately before the operation is invoked, mirroring
      // plan()'s `startedAt = new Date().toISOString()` placement — the
      // active-run buffer was already registered above, ahead of the
      // pre-spawn awaits.
      startedAt = new Date().toISOString();

      operationPromise = runWithEscalatingCancellation(
        (innerSignal) =>
          runTreatingLeakedPromiseAsSuccess(
            () => stack.preview({ plan: artifactPath, onOutput, onError, onEvent, signal: innerSignal }),
            // See this method's TSDoc "Leaked-promise recoverResult" section
            // for why nothing needs re-reading here.
            () => Promise.resolve<PreviewResult>({ stdout: '', stderr: '', changeSummary: capturedChangeSummary }),
          ),
        internalController.signal,
      );

      // Mirrors spawnAndStream's `child.on('close', ...)` handler: flush any
      // trailing partial line from both buffers, then mark settled — done
      // from the SAME handler (attached to both the resolve and reject
      // paths) so the drain loop below needs no special-casing between them.
      // Also the outer `finally`'s signal that a force-close has nothing
      // left to await — see that block's comment.
      const onOperationSettled = (): void => {
        for (const stream of ['stdout', 'stderr'] as const) {
          if (buffers[stream].length > 0) {
            push({ stream, line: buffers[stream] });
            buffers[stream] = '';
          }
        }
        operationSettled = true;
        notify();
      };
      operationPromise.then(onOperationSettled, onOperationSettled);

      // Drain loop — identical shape to spawnAndStream's, driven by
      // `operationSettled` instead of `closed`.
      while (true) {
        if (queue.length > 0) {
          const chunk = queue.shift()!;
          logLines.push(chunk.line);
          this.recordRunChunk(runId, chunk);
          yield chunk;
          continue;
        }
        if (operationSettled) {
          break;
        }
        await new Promise<void>((resolveWait) => {
          wake = resolveWait;
        });
      }

      let previewResult: PreviewResult | undefined;
      let previewError: unknown;
      try {
        previewResult = await operationPromise;
      } catch (err) {
        previewError = err;
      }

      const wasAborted =
        previewError instanceof PulumiOperationNotStartedError ||
        previewError instanceof PulumiOperationAbortedError ||
        previewError instanceof PulumiOperationEscalatedError;

      // Read the saved plan artifact back off disk once the operation has
      // genuinely succeeded — mirrors plan()'s `computePlanHash` call site
      // exactly, including catching a post-success read failure into a
      // typed error rather than letting it propagate raw.
      let planHash: string | undefined;
      let engineVersion: string | undefined;
      let planHashError: PulumiPlanHashError | undefined;
      if (!wasAborted && !previewError) {
        try {
          engineVersion = this.readEngineVersionFromPlanArtifact(artifactPath);
          planHash = this.computePlanHash(artifactPath, observedConfigVersionId);
        } catch (err) {
          planHashError = new PulumiPlanHashError(runId, artifactPath, err);
        }
      }

      const outcome: PulumiPreviewOutcome = wasAborted
        ? { kind: 'aborted' }
        : previewError
          ? { kind: 'failed', error: new PulumiPreviewError(previewError) }
          : planHashError
            ? { kind: 'failed', error: planHashError }
            : {
                kind: 'success',
                result: {
                  runId,
                  artifactPath,
                  changeSummary: previewResult!.changeSummary,
                  planHash: planHash!,
                  engineVersion: engineVersion!,
                },
              };

      if (outcome.kind === 'failed') {
        logger.error('pulumi preview: operation failed', {
          runId,
          error: outcome.error.message,
        });
      }

      runRecordWritten = true;
      this.writeRunLog(runId, logLines);
      this.endActiveRun(runId);

      const completedAt = new Date().toISOString();
      const exitCode = outcome.kind === 'aborted' ? null : outcome.kind === 'success' ? 0 : 1;
      const resultChangeSummary = outcome.kind === 'success' ? outcome.result.changeSummary : undefined;
      const resultPlanHash = outcome.kind === 'success' ? outcome.result.planHash : undefined;
      const resultEngineVersion = outcome.kind === 'success' ? outcome.result.engineVersion : undefined;

      try {
        this.writeRunRecord(
          runId,
          'plan',
          startedAt,
          completedAt,
          exitCode,
          observedConfigVersionId,
          resultPlanHash,
          rolledBackFrom,
          resultChangeSummary,
          resultEngineVersion,
        );
      } catch (err) {
        throw new PulumiRunPersistError(runId, PulumiService.toOperationOutcome(outcome), err);
      }
      await this.persistRunRecord(
        runId,
        'plan',
        startedAt,
        completedAt,
        exitCode,
        observedConfigVersionId,
        resultPlanHash,
        rolledBackFrom,
        resultChangeSummary,
        resultEngineVersion,
      );

      if (outcome.kind === 'aborted') {
        return undefined;
      }
      if (outcome.kind === 'success') {
        return outcome.result;
      }
      throw outcome.error;
    } finally {
      // Unconditionally detach the internal-controller abort listener —
      // `{ once: true }` alone only removes it
      // once `signal` itself fires; on the overwhelmingly common path (the
      // caller's signal never aborts across a normal completion), it would
      // otherwise stay attached for the signal's whole lifetime, so a caller
      // reusing one long-lived `AbortSignal` across many `preview()`/
      // `confirmRollback()` calls (both of which delegate here) would
      // accumulate one listener per call. Mirrors apply()/destroy()'s
      // identical fix (see either method's own TSDoc, "Cancellation and
      // abort-listener leak") — safe/idempotent to call even when the
      // listener already detached itself (a `{ once: true }` listener that
      // already fired).
      signal?.removeEventListener('abort', onAbort);

      // Covers the force-closed generator case (consumer `break`/`.return()`/
      // `.throw()`): if `stack.preview()` was actually invoked and hasn't
      // settled yet, this generator was torn down while the CLI subprocess
      // was still genuinely running. Abort it — `internalController.abort()`
      // fires the SAME signal already forwarded into `stack.preview({ signal })`,
      // triggering the SDK's own `SIGINT` handling — and AWAIT the resulting
      // settlement before doing anything else, most importantly before
      // `this.operationInFlight = null` below. Without this await,
      // `operationInFlight` would be cleared while the subprocess (and the
      // shared `workDir`/`Pulumi.<stack>.yaml` it's still writing to) is
      // still live, letting a new `preview()`/`up()`/`destroy()` call start
      // immediately and race against it on that shared local state — exactly
      // what `operationInFlight`'s own doc comment says this guard exists to
      // prevent. This generator has no inner sub-generator to delegate
      // cancellation to (the Automation API's `onOutput`/`onError` are plain
      // callbacks, not a stream), so the `internalController`/`operationPromise`
      // pair is a hand-built equivalent. The wait is still BOUNDED, not indefinite:
      // `runWithEscalatingCancellation` (already wrapping `operationPromise`)
      // gives up waiting on a genuinely wedged operation after its own
      // escalation timeout and settles anyway — see that function's TSDoc.
      if (operationPromise && !operationSettled) {
        internalController.abort();
        await operationPromise.catch(() => {
          // Only here to observe settlement — the actual outcome (success,
          // `PulumiOperationAbortedError`, `PulumiOperationEscalatedError`,
          // or a genuine failure) is irrelevant to a generator that's
          // already being torn down for an unrelated reason; the point is
          // only that the underlying call has now genuinely finished.
        });
      }

      if (runId !== undefined) {
        this.endActiveRun(runId);
      }
      if (runId !== undefined && startedAt !== undefined && !runRecordWritten) {
        logger.warn('pulumi preview cancelled — generator force-closed while running', { runId });
        this.writeRunLog(runId, logLines);
        const completedAt = new Date().toISOString();
        // `configVersionId` (the caller's original expectation, in scope
        // from the function signature) is threaded through here rather than
        // `observedConfigVersionId` (the version this run actually resolved
        // to reading the configuration object) — that variable is
        // block-scoped inside the `try` above and unreachable here; the
        // caller-supplied `configVersionId` is the best available fallback
        // for this force-killed path.
        try {
          this.writeRunRecord(runId, 'plan', startedAt, completedAt, null, configVersionId, undefined, rolledBackFrom);
        } catch {
          // Nothing meaningful to do with a persistence failure while the
          // generator is already tearing down for an unrelated reason.
        }
        await this.persistRunRecord(runId, 'plan', startedAt, completedAt, null, configVersionId, undefined, rolledBackFrom);
      }
      // NOTE: `operationInFlight` is deliberately NOT cleared here — this
      // method never sets it either. See this method's own doc comment,
      // "split out from preview()": the caller ({@link preview}
      // or {@link confirmRollback}) owns the full set/clear lifecycle in its
      // OWN `finally`, which only runs once this generator (including this
      // very `finally` block) has fully completed.
    }
  }

  /**
   * Runs `pulumi up` constrained by a previously approved, unexpired plan,
   * behind a **self-contained** gate this method owns end-to-end — there is
   * no `PulumiController` yet, and this method needs none.
   *
   * ## The 8-step gate, in the exact order the `iac-plan-apply-page` spec
   * requires ("The gate MUST verify, in order: ...")
   *
   * 1. `RunRecordPersister.getByRunId(planRunId)` — a record exists at all.
   *    Throws {@link PulumiPlanRunNotFoundError} otherwise.
   * 2. `record.kind === 'plan'`. Throws {@link PulumiPlanRunWrongKindError}
   *    otherwise.
   * 3. `record.approvedBy && record.approvedAt` are both set. Throws
   *    {@link PulumiPlanNotApprovedError} otherwise.
   * 4. `!isApprovalExpired(record.approvedAt)` (the fixed 15-minute
   *    `APPROVAL_WINDOW_MS` window, `@hyveon/shared/runs.js`). Throws
   *    {@link PulumiApprovalExpiredError} otherwise.
   * 5. `record.planHash === planHash` — the caller-supplied hash matches the
   *    record's own stored hash. Throws {@link PulumiPlanHashMismatchError}
   *    otherwise (a forged or stale hash can never reach `stack.up()`).
   * 6. Re-verifies the record's hash against reality, in two parts, NEITHER
   *    of which ever parses the on-disk plan artifact as JSON — satisfying
   *    the spec's "the configuration check MUST NOT depend on the plan file
   *    being parseable":
   *    - 6a. The configuration object's CURRENT head version id
   *      (`RemoteFileStore.listVersions`) is compared directly against
   *      `record.configVersionId` (the version the plan actually ran
   *      against). A mismatch means the configuration has been written
   *      again since the plan was reviewed — throws {@link StalePlanError}
   *      (reused, not reinvented: this is exactly the condition that class
   *      already exists to describe — the same staleness check
   *      {@link preview}'s own `configVersionId` guard performs).
   *    - 6b. The on-disk plan artifact is re-hashed
   *      (`computePlanHash(artifactPath, currentConfigVersionId)` — raw
   *      bytes only, never `JSON.parse`d) and compared against
   *      `record.planHash`. Since 6a already proved the config version is
   *      unchanged, a mismatch here can only mean the artifact's *bytes*
   *      differ from what was hashed at plan time — i.e. the file was
   *      swapped or tampered with since review. Throws
   *      {@link PulumiPlanArtifactStaleError} — a NEW class (7.9's 13 didn't
   *      anticipate this specific byte-tamper case; `StalePlanError`'s shape
   *      is about S3 config-object versions, not artifact bytes, so it does
   *      not fit here) — also thrown, wrapping the read/hash failure as
   *      `cause`, if the artifact can't be read/hashed at all.
   * 7. The plan's stamped `record.engineVersion` (already normalized,
   *    no `v` prefix, by `preview()`/`readEngineVersionFromPlanArtifact`)
   *    is compared against `PulumiEngineService.getResolvedVersion()` —
   *    `this.engine.resolve()` is awaited first to guarantee that accessor
   *    is populated even on a fresh app session where no prior
   *    `preview()`/`up()` call has resolved the engine yet (its own
   *    memoization makes this a no-op, not a re-provision, once already
   *    resolved — e.g. by an earlier `preview()` in the same process).
   *    A mismatch throws {@link PulumiEngineVersionMismatchError}, naming
   *    both versions, satisfying the spec's "an error that names the
   *    version change".
   * 8. **THEN, AND ONLY THEN**: `RunLockService.createRun('apply', initiator, planRunId)`
   *    — the atomic compare-and-set, the FINAL and
   *    AUTHORITATIVE step. Steps 1-7 above are pure reads (no
   *    `getWorkspaceInFlight()`-style "is it free" pre-check is performed
   *    anywhere in this method, deliberately — that is exactly the
   *    anti-pattern this gate step exists to eliminate); two concurrent `apply()`
   *    calls for the same plan race through steps 1-7 harmlessly and only
   *    ONE of them wins this step's atomic reservation
   *    (`RunService.createRun`'s in-memory check-then-set is synchronous,
   *    before its own first `await`; its DynamoDB layer is a genuine
   *    conditional `PutItem` — both confirmed already atomic, not
   *    reinvented here). The loser's `createRun` call rejects with
   *    `RunLockHeldError` (`@hyveon/shared`), which this method does not
   *    catch or reclassify — it propagates raw, carrying the winning lock's
   *    detail, for a future controller to map onto an ack shaped like
   *    `{ started: false, conflict: 'apply' }`.
   *
   * ## `operationInFlight` is checked, but never set, before gate step 8
   *
   * Setting `operationInFlight` at the top of the method, before gate step 1
   * ran, would itself be the forbidden "preceding workspace-is-free
   * observation" the `iac-plan-apply-page` spec forbids as part of the gate
   * — it would let two `apply()` calls in the same process (the only
   * concurrency case that matters for a single desktop app) never both reach
   * step 8: the second would be refused immediately, before reading
   * anything, with a generic `Error` rather than `RunLockHeldError`.
   *
   * `operationInFlight` is instead only ever SET once — synchronously,
   * immediately after `createRun` above resolves (see the re-check
   * immediately below), never at the top. The top-of-function check still
   * exists, but for a narrower purpose: refusing an `apply()` call that
   * arrives while a `preview`/`destroy` call, or an `apply` that has
   * ALREADY won its lock and is actively running the engine, is genuinely
   * using the shared local workspace directory (`operationInFlight`'s own
   * doc comment — a concern entirely independent of the durable apply lock,
   * since two Automation API invocations against the same
   * `workDir`/`Pulumi.<stack>.yaml` would corrupt local state regardless of
   * what `RunService` thinks). Two `apply()` calls both racing through steps
   * 1-7 never observe each other via this field — only `createRun`'s own
   * atomicity orders them.
   *
   * `initiator` is resolved internally via {@link resolveInitiator}
   * (`os.userInfo().username`) rather than taken as a parameter — this
   * method is self-contained per the ruling above, and there is no
   * controller yet to resolve it instead.
   *
   * `runId` is always `planRunId` itself (never a fresh `randomUUID()`) —
   * the applied plan and its apply run record share the same
   * `<runsDir>/<runId>/` lineage: the plan's own `runId` is reused so the
   * plan artifact, the plan's `run.json`, and the apply's `run.json` all
   * live under one `<runsDir>/<planRunId>/` directory, and so `RunLockService.createRun`'s
   * `runId` parameter *is* the atomic reservation key both the gate
   * and the plan/apply lineage need to agree on.
   *
   * ## Nothing is reserved before step 8 — verified, not just asserted
   *
   * `this.beginActiveRun(runId)`, `this.operationInFlight = 'up'`, and
   * `this.store.recordPulumiLockAttempt(...)` (the
   * DIY-lock ownership record, see below) are ALL called only after step 8's
   * `createRun` has already resolved successfully AND the post-`createRun`
   * local-workspace re-check immediately below has itself passed — reading
   * this method top-to-bottom confirms no side effect precedes the atomic
   * reservation, satisfying the gate's "nothing before this point may
   * reserve anything" requirement. Gate step 8 is immediately followed by exactly one
   * more check before anything is actually reserved: a re-read of
   * `operationInFlight`, closing the residual TOCTOU gap between the
   * top-of-function check and this point (a `preview`/`destroy` call could
   * have started and set the field during the `await`s gate steps 1-7 took;
   * a concurrent plan/init could have reserved the workspace during that
   * gap, so this re-check closes it). If that re-check finds the field already set, the durable lock this call
   * just won is released (`RunLockService.releaseRun`) and the call is
   * refused — nothing was ever reserved from the operator's point of view
   * (no run record, no active-run buffer), so releasing here is simply
   * undoing gate step 8, not a failure-recovery backstop. This re-check can
   * only ever observe `'preview'`/`'destroy'` in practice, never `'up'` from
   * a sibling `apply` — `RunService`'s lock is a single global slot, so two
   * `createRun` calls can never both succeed while either is still held.
   *
   * ## Does `up()` take the DIY backend lock?
   *
   * **Yes.** {@link preview}'s own TSDoc ("Does `preview` take the DIY
   * backend lock?") already verified `diyBackend.Preview` calls `b.apply`
   * directly, with no `Lock`/`Unlock` anywhere in that path. The SAME Go
   * source (`pkg/backend/diy/backend.go`) shows `diyBackend.Update` — the
   * path `stack.up()` reaches — wraps its call in
   * `err := b.Lock(ctx, stack.Ref()); defer b.Unlock(ctx, stack.Ref())`
   * before proceeding. This confirms `up` genuinely takes and releases the
   * DIY backend lock around the whole update, and is why (unlike `preview`)
   * this method wires the lock-recovery primitives below.
   *
   * ## Lock-recovery wiring
   *
   * Immediately before calling `stack.up()` (never earlier — see "Nothing
   * is reserved before step 8" above), this method records a lock-ownership
   * attempt via `ElectronStoreService.recordPulumiLockAttempt(PULUMI_STACK_NAME)`,
   * keeping the returned attempt id in scope. On every settlement of the
   * wrapped `stack.up()` call EXCEPT {@link PulumiOperationEscalatedError},
   * the attempt is cleared via `clearPulumiLockAttempt` — a normal CLI exit
   * (success, a genuine failure, or a cancellation the CLI itself
   * acknowledged via `SIGINT`) releases its own DIY lock via the backend's
   * own `Unlock()`, so the record is no longer needed as reclaim evidence
   * (mirrors `recordPulumiLockAttempt`'s own doc comment: "Never call
   * [`clearPulumiLockAttempt`] when the operation was forcefully
   * terminated"). An {@link PulumiOperationEscalatedError} settlement is
   * exactly that forceful-termination case — see "Force-close safety net"
   * below for why the record is deliberately left behind on that path.
   *
   * If `stack.up()` itself rejects with a lock conflict
   * (`isStackLockConflict` — `instanceof ConcurrentUpdateError`, or the
   * DIY-backend message pattern as a backstop), the rejection is classified
   * via `PulumiLockRecovery.classifyStackLockConflict`:
   * - `'reclaimable-own-orphan'` — every lock present is provably this
   *   installation's own dead orphan (identity + liveness + time-consistency,
   *   per that function's own TSDoc). Per `PulumiLockRecovery.ts`'s own doc
   *   comment ("the caller acts on that classification directly —
   *   calling `stack.cancel()` and retrying — without ever constructing or
   *   throwing an error for it"), this method clears the lock via
   *   `stack.cancel()` and retries `stack.up()` exactly once with the same
   *   options/signal. No operator confirmation is involved — the spec's
   *   "The app MAY reclaim it without prompting" — and this is the FIRST
   *   real exercise of that classification anywhere in the codebase.
   * - `'requires-confirmation'` (anything not provably an own orphan,
   *   including "no locks could even be parsed") — throws
   *   {@link PulumiUnrecognizedLockError} (holder + age already carried on
   *   `locks`, per spec), and this method does NOT clear anything — clearing
   *   an unrecognized lock needs explicit operator confirmation, a later
   *   phase's UI concern.
   *
   * ## Force-close safety net for a wedged engine (a residual gap,
   * now higher-stakes since `up()` holds the real backend lock)
   *
   * `preview()`'s outer `finally` — mirrored here — aborts and awaits its
   * internal operation on a force-closed generator, but that `finally` can
   * only run once the generator's CURRENT suspension point resolves. If the
   * generator is parked mid-drain-loop on its own internal
   * `await new Promise((resolveWait) => { wake = resolveWait })` (not a
   * `yield`) waiting for `stack.up()` to settle, and `stack.up()` is
   * genuinely wedged (ignores `SIGINT`, or is stuck between signal checks in
   * a cloud-provider API call) — `runWithEscalatingCancellation`'s own
   * escalation timer NEVER ARMS, because arming it requires `internalController.abort()`
   * to have already fired, and the only thing that calls that (absent a
   * caller-supplied `signal` that itself aborts) is this method's own outer
   * `finally`. That `finally` cannot run until the pending internal `await`
   * resolves; that `await` cannot resolve until the escalation timer fires;
   * the escalation timer cannot arm until `finally` calls `abort()`. This is
   * a genuine circular dependency — a wedged engine with no caller-supplied
   * `signal` can leave this generator (and its outer `finally`) suspended
   * indefinitely, with the DIY backend lock still held by the CLI
   * subprocess. Fully closing this gap (an unconditional watchdog
   * independent of `.return()` ever being called, or the "unofficial `run`
   * override" `PulumiCancellation.ts`'s TSDoc floats for a real killable
   * process handle) is out of scope here — this section documents the
   * finding rather than silently leaving it unstated.
   *
   * **The lock-ownership record recorded above IS a sufficient backstop for
   * this exact gap.** `ElectronStoreService.recordPulumiLockAttempt` is a
   * synchronous, already-completed write to `electron-store` made BEFORE
   * `stack.up()` is ever invoked — entirely unaffected by any later hang
   * inside that call. Whether this run's own generator ever gets a chance
   * to run its `finally` again or not, the record survives (in
   * `userData`'s persisted store, on disk) for
   * `PULUMI_LOCK_OWNERSHIP_RECORD_MAX_AGE_MS` (2 hours) as evidence: once
   * the wedged CLI process eventually exits — by any means: the OS finally
   * delivers `SIGINT`, the operator kills it manually, the app or machine
   * restarts — its PID becomes provably dead, and the NEXT `preview`/`up`/
   * `destroy` attempt against this stack that hits the same DIY lock
   * conflict will have `classifyStackLockConflict` find this run's record,
   * confirm identity (same username/hostname) + liveness (PID now dead) +
   * time-consistency (`startedAt` at or before the stale lock's
   * `lockedAt`), and classify it `'reclaimable-own-orphan'` — reclaiming and
   * proceeding automatically, exactly the same path a fresh `up()` call
   * exercises above. **Yes: the recorded evidence is sufficient for a LATER
   * operation to recognize and reclaim the orphan even when THIS run cannot
   * clean up after itself.**
   *
   * ## Partial-apply detection (this task's headline requirement)
   *
   * `UpResult` itself carries no "was this partial" signal (confirmed
   * against `@pulumi/pulumi/automation/stack.d.ts`'s
   * `{ stdout, stderr, outputs, summary }` shape — `summary.resourceChanges`,
   * when present, is a final tally, not a partial/complete distinction) — this must be
   * inferred from the `onEvent` stream, as the brief's own research
   * anticipated. `onEvent`'s `resOutputsEvent` fires once per resource
   * "finished being provisioned" (confirmed against `events.d.ts` — distinct
   * from `resourcePreEvent`, which fires BEFORE a resource is touched and
   * would over-count in-flight-but-not-yet-complete steps as "applied").
   * Every `resOutputsEvent` whose `metadata.op` is in {@link MUTATING_OP_TYPES}
   * (excludes `'same'`/read/refresh/discard-family no-ops) is accumulated
   * into `completedSteps` as it streams. If `stack.up()` ultimately fails
   * (not aborted, not a leaked-promise-recovered success) and
   * `completedSteps.length > 0`, the failure is wrapped in
   * {@link PulumiPartialApplyError} (carrying `completedSteps`) instead of
   * {@link PulumiUpError} — a clean failure (nothing mutated yet) still gets
   * {@link PulumiUpError}. `PulumiUnrecognizedLockError` is a distinct third
   * shape (the update never even started against the backend — see above)
   * and is thrown as-is, never wrapped in either.
   *
   * ## Terminal-state representation
   *
   * `RunRecord.status`/`PulumiRunRecord.exitCode` stay a closed
   * success/failed/aborted (0/1/null) triple, per the additive
   * `partialApply: true` boolean field (see {@link PulumiRunRecord.partialApply}'s
   * doc comment for why an additive field was chosen over a fourth
   * `RunStatus` value: `RunStatus` is the `status-index` DynamoDB GSI's hash
   * key, and widening a GSI key's value set is a materially bigger,
   * infra-affecting change that is not attempted here without
   * explicit sign-off).
   *
   * **`partialApply` is independent of which non-`'success'` `status` the
   * run settled with.** A resource step can have
   * already been applied whether the run subsequently *failed*
   * (`exitCode: 1` → `status: 'failed'`) OR was *aborted* (`exitCode: null`
   * → `status: 'aborted'`, e.g. the operator pressing Cancel mid-`up()` —
   * arguably the single most likely real-world way this system ends up
   * partway through). `partialApply` is computed from whether
   * `completedSteps` is non-empty, gated only on `outcome.kind !== 'success'`
   * (see {@link apply}'s implementation) — never on `status === 'failed'`
   * specifically. **Any
   * consumer (the UI, a future controller, run-history rendering) MUST check
   * `partialApply` directly and MUST NOT gate that check behind
   * `status === 'failed'` first** — doing so silently drops the aborted-
   * cancel case, exactly the scenario the spec's
   * "the UI MUST direct the operator to re-plan rather than retry blindly
   * after a partial failure" requirement most needs to catch. The correct
   * check is simply `record.partialApply` on its own — re-plan, don't retry
   * blindly, whenever it's `true` — independent of `record.status`.
   *
   * ## Leaked-promise `recoverResult`
   *
   * Unlike `preview` — where nothing needed re-reading — `up`'s recovery
   * does need to re-read state. If `stack.up()` rejects with the SDK's leaked-promise message
   * (`isLeakedPromiseError`), `PulumiLeakedPromise.ts`'s own TSDoc proves
   * this can only happen after the actual update already succeeded — the
   * update landed in the backend, but the synthetic `UpResult` the SDK would
   * have returned is unrecoverable from the rejected promise itself.
   * `recoverResult` re-reads `stack.outputs()` and `stack.info()` — fresh,
   * independent, read-only calls, per that file's own guidance — to
   * reconstruct a well-typed `UpResult`. `stack.info()`'s `result` field
   * (`UpdateResult`) is checked and a mismatch from `'succeeded'` is logged
   * as a sanity-check WARN, but does not override the recovery — trusting
   * `isLeakedPromiseError`'s proven-sufficient classification, not a second
   * heuristic, per that file's "provably sufficient" section. What does NOT
   * need re-reading: `changeSummary` — the `capturedChangeSummary` this
   * method's own `onEvent` closure already captured (the same mechanism
   * `preview()` uses) survives the leak untouched, since it lives in this
   * method's own local state, not inside the SDK's rejected promise.
   *
   * ## Cache invalidation
   *
   * On a successful apply — and ONLY then; a failed/aborted/partial apply
   * did not durably change what a fresh `getStackOutputs()` read would
   * report — `ConfigCacheInvalidator.invalidateCache()` (the real
   * `ConfigService.invalidateCache()`, resolved lazily via
   * {@link getConfigCacheInvalidator}) is called. Best-effort: a failure to
   * resolve or call it is logged and swallowed, mirroring
   * `persistRunRecord`'s "never let a side-effect write mask an otherwise-
   * successful apply" policy — nothing else in production calls this after a
   * deploy, so without it the dashboard would show "not deployed"
   * indefinitely after the first real apply.
   *
   * Called BEFORE `persistRunRecord`, not after — `persistRunRecord` →
   * `RunRecordService.persist` reads `runsTableName` off
   * `ConfigService.getStackOutputs()`, a cache this same
   * `invalidateCache()` call clears. Invalidating afterward would let this
   * apply's own run-record write resolve `runsTableName` against PRE-apply
   * cached outputs — wrong for any apply that itself changes the runs table.
   *
   * ## Cancellation and abort-listener leak
   *
   * Mirrors {@link preview}'s `internalController`/`operationPromise`
   * cancellation shape exactly (see that method's TSDoc for the full
   * rationale). The `signal.addEventListener('abort', ...)`
   * call below passes `{ once: true }`, so a caller that reuses the same
   * `AbortSignal` across repeated calls (or whose signal fires more than
   * once for any reason) never accumulates more than one live listener per
   * `apply()` invocation. The escalation timer arms on
   * every force-close, even with no caller-supplied `signal`.
   *
   * ## Persistence
   *
   * Once gate step 8 succeeds, every settlement (success, failure, partial
   * failure, or abort) goes through the same
   * `writeRunLog`/`endActiveRun`/`writeRunRecord`/`persistRunRecord`
   * sequence {@link preview} uses — `kind: 'apply'`, `configVersionId`/
   * `planHash`/`engineVersion` passed through from the validated plan
   * record (not re-derived), plus the new `partialApply` indicator. As
   * documented on {@link persistRunRecord}, `RunRecordService.persist`'s own
   * `finally` releases the durable apply lock gate step 8 acquired — no
   * separate `RunLockService.releaseRun` call is made by this method itself,
   * relying on that release happening one layer down. A gate failure (steps 1-7) never
   * reaches this point at all — `runId` is only ever assigned after step 8
   * succeeds, so a rejected gate call writes no run record and holds no
   * lock to release.
   *
   * ## Pre-flight durable marker (issue #399)
   *
   * Immediately after gate step 8 acquires the lock — and BEFORE `stack.up()`
   * is ever called — `RunRecordService.writePreflightMarker` writes a
   * durable, in-doubt placeholder `RunRecord` (`kind: 'apply'`,
   * `partialApply: true`) for `runId`, sharing the same `sk` the eventual
   * settlement write below uses (so a normal settlement overwrites it in
   * place, leaving exactly one record for the attempt). This closes the gap
   * where a partial apply whose FINAL settlement write itself fails to
   * persist would otherwise leave the original approved `plan` record as the
   * only observable record for `runId`, passing every gate check above all
   * over again on a subsequent call and permitting a blind retry against
   * infrastructure this very attempt may have already mutated. This write is
   * deliberately NOT best-effort — see {@link PulumiPreflightMarkerError}'s
   * doc comment for the fail-closed behavior when it itself fails.
   *
   * @param planRunId - The `runId` of the approved `plan` run to apply — also
   *   reused, unchanged, as this apply run's own `runId` (see "run id"
   *   above).
   * @param planHash - The plan hash the caller expects this plan run to
   *   still carry (gate step 5) — normally the same value the originating
   *   `preview()` call returned.
   * @param signal - Optional cancellation signal — see "Cancellation" above.
   * @throws {@link PulumiOperationInFlightError} if another `preview`/`up`/
   *   `destroy`/`rollback` is already in flight on this instance (the
   *   top-of-function busy check, before gate step 1).
   * @throws {@link PulumiPlanRunNotFoundError}, {@link PulumiPlanRunWrongKindError},
   *   {@link PulumiPlanNotApprovedError}, {@link PulumiApprovalExpiredError},
   *   {@link PulumiPlanHashMismatchError}, {@link StalePlanError}, or
   *   {@link PulumiPlanArtifactStaleError} if the corresponding gate step
   *   (1-6) fails.
   * @throws {@link PulumiPartialApplyRetryBlockedError} if gate step 2 finds
   *   an `apply`-kind record for `planRunId` with `partialApply: true` — a
   *   prior attempt against this same plan either diverged partway through,
   *   or never confirmed that it didn't (issue #399).
   * @throws {@link PulumiEngineVersionMismatchError} if gate step 7 fails.
   * @throws `RunLockHeldError` (`@hyveon/shared`, unwrapped) if gate step 8
   *   loses the atomic race for the apply lock.
   * @throws {@link PulumiPreflightMarkerError} if the durable pre-flight
   *   marker `RunRecordService.writePreflightMarker` writes immediately
   *   after gate step 8 (before `stack.up()` is ever called) itself fails —
   *   `apply` fails closed on this: `stack.up()` is never reached, and the
   *   durable apply lock is released explicitly in this same path.
   * @throws {@link PulumiUnrecognizedLockError} if `stack.up()` hits a
   *   backend lock conflict that cannot be proven this installation's own
   *   orphan.
   * @throws {@link PulumiPartialApplyError} if `stack.up()` fails after at
   *   least one resource step already applied.
   * @throws {@link PulumiUpError} if `stack.up()` fails cleanly (no resource
   *   step applied).
   * @throws {@link PulumiRunPersistError} if the operation settled but the
   *   run record couldn't be persisted afterward.
   */
  async *apply(
    planRunId: string,
    planHash: string,
    signal?: AbortSignal,
  ): AsyncGenerator<PulumiRunChunk, PulumiUpResult | undefined> {
    logger.debug('PulumiService.apply: starting pulumi apply', { planRunId });
    // Checked (never SET here — see "Nothing is reserved before step 8"
    // below) so an `apply()` call arriving while a `preview`/
    // `destroy`/already-lock-won `apply` is genuinely running the engine is
    // refused immediately, without wasting a gate read that would lose
    // anyway. Deliberately does NOT gate two applies racing for the SAME
    // (or different) plan: those must both reach gate step 8 and be ordered
    // by `RunLockService.createRun`'s own atomicity, never by this
    // observation — see this method's TSDoc, "Nothing is reserved before
    // step 8": setting this field here would be exactly the forbidden
    // "preceding workspace-is-free observation" the `iac-plan-apply-page`
    // spec explicitly rules out as the gate.
    if (this.operationInFlight) {
      throw new PulumiOperationInFlightError(this.operationInFlight);
    }
    this.assertStackInitNotInFlight('apply');
    PulumiService.assertValidRunId(planRunId);
    // Hoisted above the try block — mirrors preview()'s identical hoist and
    // rationale: a force-closed generator unwinds straight to the outer
    // `finally`, which needs to see these regardless of how far the gate/
    // operation got.
    let runId: string | undefined;
    let startedAt: string | undefined;
    let runRecordWritten = false;
    // `true` only once THIS invocation has itself set `operationInFlight`
    // (post gate-step-8, see below) — gates the outer `finally`'s reset so a
    // gate failure that never touched the field can never null out some
    // OTHER concurrently-running operation's own flag: since the top check
    // above only reads the field, never sets it, a failing gate call
    // can reach the outer `finally` having never touched `operationInFlight`
    // at all, while a genuinely unrelated `preview`/`destroy` call is live.
    let ownsOperationInFlight = false;
    // `true` once a call that genuinely attempted to release the durable
    // apply lock has completed — set after the NORMAL-path `persistRunRecord`
    // call (whose own `RunRecordService.persist` releases the lock in its
    // own `finally`) and after the force-close fallback's equivalent call.
    // Gates the outer `finally`'s unconditional backstop
    // `releaseRun` call (see below) so it does NOT also fire on every
    // ordinary successful apply — `RunService.releaseRun` awaits
    // `ConfigService.getStackOutputs()`, which the just-run
    // `invalidateCache()` call (on the success path) guarantees will MISS
    // its cache and re-invoke `PulumiService.getStackOutputs()` — two more
    // real `pulumi` CLI subprocess spawns (`stack select` + `stack output`)
    // on the hot path of every successful apply, delaying the generator's
    // final settlement for no reason (the lock was already correctly
    // released moments earlier). The backstop is only ever actually needed
    // on the ONE path this flag stays `false` for: `writeRunRecord` itself
    // throwing, which skips `persistRunRecord` entirely (see the backstop's
    // own comment).
    let lockReleased = false;
    // The gate-validated configVersionId/engineVersion, hoisted the instant
    // the plan record is fetched (well before the lock is acquired) so the
    // outer `finally`'s force-closed fallback can still thread them through
    // its own best-effort run-record write — mirrors why `runId`/`startedAt`
    // are hoisted, just for record-persistence completeness rather than
    // control flow.
    let configVersionId: string | undefined;
    let engineVersion: string | undefined;
    // Hoisted so the outer `finally`'s force-closed fallback
    // can persist real changeSummary/partial-apply data instead of nothing —
    // see this method's TSDoc, "Partial-apply detection", for why this must
    // be visible on every settlement path, not only a clean `outcome.kind
    // === 'failed'`.
    let capturedChangeSummary: ChangeSummary = {};
    const completedSteps: PulumiPartialApplyStep[] = [];
    // The id `ElectronStoreService.recordPulumiLockAttempt` returns, kept in
    // scope so both the normal-completion path and the outer `finally`'s
    // force-close path can clear it — see the TSDoc's "Lock-recovery wiring"
    // section for exactly when each does and does not clear it.
    let lockAttemptId: string | undefined;
    const logLines: string[] = [];
    // Same internal-controller pattern as preview() — see that method's
    // TSDoc for the full rationale. Named (rather than inline) `onAbort` so
    // the outer `finally` can unconditionally `removeEventListener` it on
    // every exit path, not only once it fires: `{ once: true }`
    // alone only detaches the listener once `signal` itself
    // aborts; on the overwhelmingly common path (the caller's signal never
    // aborts at all), the listener would otherwise stay attached for the
    // signal's entire lifetime, so a caller reusing one long-lived
    // `AbortSignal` across many `apply()` calls would accumulate one
    // listener per call.
    const internalController = new AbortController();
    const onAbort = (): void => internalController.abort();
    if (signal) {
      if (signal.aborted) {
        internalController.abort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    let operationPromise: Promise<UpResult> | undefined;
    let operationSettled = false;
    try {
      if (internalController.signal.aborted) {
        return undefined;
      }

      // --- Gate steps 1-5: pure record comparisons, no I/O beyond the lookup itself ---
      const record = await this.getRunRecordPersister().getByRunId(planRunId);
      if (!record) {
        throw new PulumiPlanRunNotFoundError(planRunId);
      }
      if (record.kind !== 'plan') {
        // Refined check FIRST (see PulumiPartialApplyRetryBlockedError's own
        // doc comment): a record found here with `kind !== 'plan'` means
        // SOME prior attempt already reached gate step 8 for this exact
        // `planRunId` — either it settled normally (persisted via
        // `persist()`) or it's still the durable pre-flight marker
        // `writePreflightMarker` wrote before `stack.up()` ran (issue #399,
        // the settlement write having failed to overwrite it). Either way,
        // `partialApply: true` means retry safety cannot be assumed —
        // checked directly, never gated behind `record.status === 'failed'`
        // first (see `RunRecord.partialApply`'s own doc comment for why that
        // would silently miss the cancelled-mid-apply case).
        if (record.kind === 'apply' && record.partialApply === true) {
          throw new PulumiPartialApplyRetryBlockedError(planRunId, record.status);
        }
        throw new PulumiPlanRunWrongKindError(planRunId, record.kind);
      }
      if (!record.approvedBy || !record.approvedAt) {
        throw new PulumiPlanNotApprovedError(planRunId);
      }
      if (isApprovalExpired(record.approvedAt)) {
        throw new PulumiApprovalExpiredError(planRunId, record.approvedAt);
      }
      if (!record.planHash || record.planHash !== planHash) {
        throw new PulumiPlanHashMismatchError(planRunId, record.planHash, planHash);
      }
      configVersionId = record.configVersionId;
      engineVersion = record.engineVersion;

      if (internalController.signal.aborted) {
        return undefined;
      }

      // --- Gate step 6: re-verify against reality — see TSDoc for the 6a/6b split ---
      const bucket = this.getConfigurationBucket();
      if (!bucket) {
        throw new Error(
          'Cannot apply pulumi plan: no configuration bucket is configured. Finish the setup wizard before applying.',
        );
      }
      const key = CONFIGURATION_OBJECT_KEY;
      const versions = await this.getRemoteFileStore().listVersions(key);
      const currentConfigVersionId = versions[0]?.versionId;

      if (configVersionId !== undefined && currentConfigVersionId !== configVersionId) {
        throw new StalePlanError(key, bucket, configVersionId, currentConfigVersionId);
      }

      const artifactPath = join(this.getRunsDir(), planRunId, `${planRunId}.plan.json`);
      let recomputedHash: string;
      try {
        recomputedHash = this.computePlanHash(artifactPath, currentConfigVersionId ?? '');
      } catch (err) {
        throw new PulumiPlanArtifactStaleError(planRunId, artifactPath, err);
      }
      if (recomputedHash !== record.planHash) {
        throw new PulumiPlanArtifactStaleError(planRunId, artifactPath);
      }

      if (internalController.signal.aborted) {
        return undefined;
      }

      // --- Gate step 7: engine version ---
      await this.engine.resolve();
      const currentEngineVersion = this.engine.getResolvedVersion();
      if (!currentEngineVersion || engineVersion !== currentEngineVersion) {
        throw new PulumiEngineVersionMismatchError(planRunId, engineVersion, currentEngineVersion ?? undefined);
      }

      if (internalController.signal.aborted) {
        return undefined;
      }

      // --- Gate step 8: THE atomic, authoritative reservation ---
      // No "is the workspace free" pre-check precedes this call — see this
      // method's TSDoc for why that would reintroduce exactly the
      // TOCTOU race this gate step exists to eliminate. A losing race rejects with
      // RunLockHeldError, propagated unwrapped.
      const initiator = PulumiService.resolveInitiator();
      await this.getRunLockService().createRun('apply', initiator, planRunId);

      // Re-check the shared local-workspace guard now that this call has
      // crossed the only genuinely async gap since the top-of-function
      // check — a concurrent plan/init could have reserved the workspace
      // during that gap, so this re-check closes it. This closes the
      // apply-vs-`preview`/`destroy` race that the
      // top-of-function check alone cannot close by itself, since
      // it only reads the field, never sets it — `preview`/`destroy` never touch
      // `RunLockService` at all, so only this in-process flag can order them
      // against an apply that has already won the durable lock. Apply-vs-
      // apply is NEVER decided here — that race is already fully resolved by
      // `createRun`'s own atomicity above; this check can only ever observe
      // `'preview'`/`'destroy'` (never `'up'` from a sibling apply, since
      // `RunService`'s lock is a single global slot — two `createRun` calls
      // can never both succeed while either is still held).
      // Also re-checks `stackInitInFlight` here, not just `operationInFlight`
      // (which `initializeStack()` never touches — see that flag's own doc
      // comment). The reachable race this closes: `apply()` passes its ENTRY check
      // (both flags clear) → awaits this gate's multi-step async work →
      // `initializeStack()` starts concurrently (both flags still clear at
      // that moment) → `stack.refresh()` is now genuinely running → without
      // this check, `apply()` would sail through to `stack.up()`, running
      // concurrently with that live `refresh()` against the SAME shared
      // workDir — a `ConcurrentUpdateError` whose lock-conflict
      // classification then finds a LIVE, legitimate PID and surfaces to the
      // operator as a clearable "stale" lock, inviting them to cancel their
      // own in-progress stack initialization.
      if (this.operationInFlight || this.stackInitInFlight) {
        const inFlight = this.operationInFlight ?? 'initializeStack()';
        // Release the durable lock this call just won — nothing has been
        // reserved from the operator's point of view yet (no run record, no
        // active-run buffer, no `startedAt`), so releasing here is the
        // correct undo of gate step 8, not a backstop for a later failure.
        // Wrapped in try/catch, consistent with the outer
        // `finally`'s own backstop `releaseRun` call — `RunService.releaseRun`
        // is documented to never throw (low severity either way), but a
        // rejection here must not replace this method's own descriptive
        // refusal error (and skip the durable-lock delete this branch exists
        // to guarantee) with whatever `releaseRun` itself rejected with.
        try {
          await this.getRunLockService().releaseRun(planRunId);
        } catch (err) {
          logger.warn('pulumi apply: failed to release the durable apply lock after the local-workspace re-check refused', {
            planRunId,
            inFlight,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw new Error(
          `pulumi apply refused: ${inFlight} is already in flight against the shared workspace; wait for it ` +
            'to finish before retrying. (The durable apply lock this call just acquired has been released.)',
        );
      }
      // Only THIS invocation may ever clear `operationInFlight` back to
      // `null` (see `ownsOperationInFlight`'s own doc comment) — set
      // together, synchronously, with no `await` between them and the
      // re-check above, so no concurrent `preview`/`destroy`/`apply` call
      // can observe a window where the recheck passed but the field is not
      // yet set.
      this.operationInFlight = 'up';
      ownsOperationInFlight = true;

      // Lock genuinely held from here on — this run owns planRunId. Nothing
      // above this line has reserved anything.
      runId = planRunId;
      this.beginActiveRun(runId);
      // Captured here (immediately after the lock is acquired), NOT right
      // before `stack.up()` the way `preview()` captures its own
      // `startedAt` right before `stack.preview()` — unlike `preview()`,
      // ANY failure from this point on (config read, workspace construction,
      // or the update itself) must still produce a persisted run record to
      // release the just-acquired lock (see the comment below), so
      // `startedAt` must already be set before any of that fallible work
      // begins, not only once `stack.up()` is actually about to be called.
      startedAt = new Date().toISOString();

      // --- Pre-flight durable marker (issue #399) — written BEFORE stack.up() ---
      // Closes the retry-safety gap: without this, a partial apply whose
      // FINAL settlement write (`persistRunRecord`, far below) itself fails
      // to persist leaves the original approved `plan` record as the only
      // observable record for `runId` — passing every gate check above all
      // over again and permitting a blind retry against infrastructure this
      // very attempt may be about to partially mutate. Writing a durable
      // `kind: 'apply', partialApply: true` marker here, before `stack.up()`
      // is ever called, means an apply-kind record for `runId` already
      // exists no matter how this attempt ends — this gate's own
      // `record.kind !== 'plan'` / `PulumiPartialApplyRetryBlockedError`
      // checks (above) catch it on any subsequent call. Shares `startedAt`
      // (and therefore `sk`) with the eventual settlement write below, so a
      // successful settlement safely overwrites this marker in place rather
      // than leaving two records behind for one attempt (see
      // `RunRecordService.writePreflightMarker`'s own doc comment).
      //
      // Deliberately NOT best-effort: if this write itself fails, `apply`
      // fails closed — abort BEFORE `stack.up()` (no infrastructure is
      // touched) and release the durable lock gate step 8 just acquired
      // explicitly, right here, rather than falling through to the ordinary
      // post-settlement release path below (which this failure never
      // reaches). `runRecordWritten` is set `true` before throwing so the
      // outer `finally`'s force-closed-generator fallback (gated on
      // `!runRecordWritten`) does NOT also fire for this — genuinely
      // thrown, not force-closed — exit path. `lockReleased` is set `true`
      // only once `releaseRun` above actually resolves, so a failed release
      // here still leaves the outer `finally`'s `!lockReleased` backstop
      // free to retry rather than leaking the lock until TTL expiry.
      try {
        await this.getRunRecordPersister().writePreflightMarker({
          runId,
          startedAt,
          configVersionId,
          planHash: record.planHash,
          engineVersion,
        });
      } catch (err) {
        logger.warn(
          'pulumi apply: failed to write the durable pre-flight marker; aborting before stack.up() to fail closed',
          { planRunId, runId, error: err instanceof Error ? err.message : String(err) },
        );
        try {
          await this.getRunLockService().releaseRun(runId);
          lockReleased = true;
        } catch (releaseErr) {
          logger.warn(
            'pulumi apply: failed to release the durable apply lock after aborting on a pre-flight marker failure',
            { planRunId, runId, error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr) },
          );
        }
        runRecordWritten = true;
        throw new PulumiPreflightMarkerError(planRunId, err);
      }

      // Everything from here through `operationPromise` settling is wrapped
      // in one try/catch so ANY failure after the lock is acquired —
      // reading the configuration, constructing the workspace, or the
      // update itself — still flows through the SAME persistence path
      // below (which is what actually releases the just-acquired lock, via
      // RunRecordService.persist's own finally). Letting a config-read
      // failure propagate raw here would leak the lock for the full
      // DEFAULT_LOCK_TTL_MS TTL instead of releasing it immediately.
      // Unlike `preview()`, the resolved `UpResult` itself is never read —
      // `capturedChangeSummary` (this method's own `onEvent` capture, below)
      // is used directly for the returned result on every path, INCLUDING
      // the normal-completion path, so the leaked-promise-recovery path and
      // the normal path can never disagree about where `changeSummary` came
      // from (mirrors `preview()`'s design intent — see that method's TSDoc
      // "Structured changeSummary" — applied slightly differently here since
      // `UpResult.summary.resourceChanges` is optional and its exact
      // population semantics from the CLI have not been independently
      // verified, unlike `PreviewResult.changeSummary`).
      // `completedSteps`/`capturedChangeSummary` themselves are hoisted
      // above the outer `try` (see there for why) — only `upError` is local
      // to this inner try/catch.
      let upError: unknown;

      try {
        const obj = await this.getRemoteFileStore().get(key);
        if (!obj) {
          throw new Error(`Configuration object "${key}" not found in S3 bucket "${bucket}".`);
        }
        const deploymentConfig = JSON.parse(new TextDecoder().decode(obj.body)) as DeploymentConfig;
        const redactedEnvironmentValues = PulumiService.buildEnvironmentRedactionSet(deploymentConfig);

        const stateBucket = this.store.get('bootstrap')?.stateBucket;
        const stateBucketRegion = this.store.get('aws')?.region;
        if (!stateBucket || !stateBucketRegion) {
          throw new Error(
            'Cannot run pulumi apply: the state bucket / AWS region has not been configured yet. ' +
              'Complete the bootstrap step before applying.',
          );
        }
        const stack = await this.workspace.getOrCreateStack({
          program: createInfraProgram(deploymentConfig, { lambdaBundlesDir: this.getLambdaBundlesDir() }),
          stateBucket,
          stateBucketRegion,
          backendReady: true,
        });

        // --- Chunk-streaming setup — identical algorithm to preview() (see that method's TSDoc) ---
        const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
        const queue: PulumiRunChunk[] = [];
        let wake: (() => void) | null = null;
        const notify = (): void => {
          wake?.();
          wake = null;
        };
        const push = (chunk: PulumiRunChunk): void => {
          // Redact operator-set environment values before this chunk reaches
          // any sink (recordRunChunk, the persisted pulumi.log, or a live
          // streamRunOutput subscriber) — see redactEnvironmentValues's TSDoc.
          queue.push({ ...chunk, line: PulumiService.redactEnvironmentValues(chunk.line, redactedEnvironmentValues) });
          notify();
        };
        const handleData = (stream: 'stdout' | 'stderr', data: string): void => {
          buffers[stream] += data;
          const lines = buffers[stream].split(/\r?\n/);
          buffers[stream] = lines.pop() ?? '';
          for (const line of lines) {
            push({ stream, line });
          }
        };
        const onOutput = (out: string): void => handleData('stdout', out);
        const onError = (err: string): void => handleData('stderr', err);
        const onEvent = (event: EngineEvent): void => {
          if (event.summaryEvent) {
            capturedChangeSummary = event.summaryEvent.resourceChanges;
          }
          if (event.resOutputsEvent && MUTATING_OP_TYPES.has(event.resOutputsEvent.metadata.op)) {
            const { urn, type, op } = event.resOutputsEvent.metadata;
            completedSteps.push({ urn, type, op });
          }
        };

        // Lock-recovery wiring — recorded immediately before the call that can
        // actually take the DIY backend lock, never earlier. See TSDoc
        // "Lock-recovery wiring" / "Force-close safety net" sections.
        lockAttemptId = this.store.recordPulumiLockAttempt(PULUMI_STACK_NAME);

        const attemptUp = async (innerSignal: AbortSignal): Promise<UpResult> => {
          try {
            return await stack.up({ plan: artifactPath, onOutput, onError, onEvent, signal: innerSignal });
          } catch (err) {
            if (!isStackLockConflict(err)) {
              throw err;
            }
            const classification = classifyStackLockConflict(err, this.store, PULUMI_STACK_NAME);
            if (classification.kind === 'reclaimable-own-orphan') {
              logger.warn(
                'pulumi apply: backend lock is a provable orphan of this installation\'s own prior run — ' +
                  'clearing it via stack.cancel() and retrying the update once',
                { planRunId, runId, locks: classification.locks },
              );
              await stack.cancel();
              return await stack.up({ plan: artifactPath, onOutput, onError, onEvent, signal: innerSignal });
            }
            throw new PulumiUnrecognizedLockError(
              PULUMI_STACK_NAME,
              classification.kind === 'requires-confirmation' ? classification.locks : [],
            );
          }
        };

        const recoverResult = async (): Promise<UpResult> => {
          const [outputs, summary] = await Promise.all([stack.outputs(), stack.info()]);
          if (summary && summary.result !== 'succeeded') {
            logger.warn(
              'pulumi apply leaked-promise recovery: stack.info() does not report "succeeded" — trusting the ' +
                'SDK-verified leak-check proof anyway (see PulumiLeakedPromise.ts, "provably sufficient")',
              { planRunId, runId, result: summary.result },
            );
          }
          return {
            stdout: '',
            stderr: '',
            outputs,
            summary: summary ?? {
              kind: 'update',
              startTime: new Date(),
              endTime: new Date(),
              message: '',
              environment: {},
              config: {},
              result: 'succeeded',
              version: 0,
            },
          };
        };

        operationPromise = runWithEscalatingCancellation(
          (innerSignal) => runTreatingLeakedPromiseAsSuccess(() => attemptUp(innerSignal), recoverResult),
          internalController.signal,
        );

        const onOperationSettled = (): void => {
          for (const stream of ['stdout', 'stderr'] as const) {
            if (buffers[stream].length > 0) {
              push({ stream, line: buffers[stream] });
              buffers[stream] = '';
            }
          }
          operationSettled = true;
          notify();
        };
        operationPromise.then(onOperationSettled, onOperationSettled);

        while (true) {
          if (queue.length > 0) {
            const chunk = queue.shift()!;
            logLines.push(chunk.line);
            this.recordRunChunk(runId, chunk);
            yield chunk;
            continue;
          }
          if (operationSettled) {
            break;
          }
          await new Promise<void>((resolveWait) => {
            wake = resolveWait;
          });
        }

        await operationPromise;
      } catch (err) {
        upError = err;
      }

      // Clear the lock-ownership record on every settlement EXCEPT a
      // forceful escalation — see TSDoc "Force-close safety net" for why an
      // escalated (possibly still-running) operation must leave its record
      // behind as reclaim evidence for a later run.
      if (lockAttemptId !== undefined && !(upError instanceof PulumiOperationEscalatedError)) {
        this.store.clearPulumiLockAttempt(lockAttemptId);
        lockAttemptId = undefined;
      }

      const wasAborted =
        upError instanceof PulumiOperationNotStartedError ||
        upError instanceof PulumiOperationAbortedError ||
        upError instanceof PulumiOperationEscalatedError;

      const outcome: PulumiApplyOutcome = wasAborted
        ? { kind: 'aborted' }
        : upError
          ? upError instanceof PulumiUnrecognizedLockError
            ? { kind: 'failed', error: upError, partialApply: false }
            : completedSteps.length > 0
              ? { kind: 'failed', error: new PulumiPartialApplyError(completedSteps, upError), partialApply: true }
              : { kind: 'failed', error: new PulumiUpError(upError), partialApply: false }
          : { kind: 'success', result: { runId, changeSummary: capturedChangeSummary } };

      if (outcome.kind === 'failed') {
        logger.error('pulumi apply: operation failed', {
          runId,
          planRunId,
          partialApply: outcome.partialApply,
          error: outcome.error.message,
        });
      }

      runRecordWritten = true;
      this.writeRunLog(runId, logLines);
      this.endActiveRun(runId);

      const completedAt = new Date().toISOString();
      const exitCode = outcome.kind === 'aborted' ? null : outcome.kind === 'success' ? 0 : 1;
      const resultChangeSummary = outcome.kind === 'success' ? outcome.result.changeSummary : capturedChangeSummary;
      // Computed directly from `completedSteps`, independent of
      // `outcome.kind === 'failed'` specifically, so an ABORTED apply (the
      // operator pressing Cancel mid-`up()` — arguably the single most
      // likely real-world way this system ends up partway through) also
      // reports partial-apply correctly, not only a clean failure.
      // `outcome.kind === 'success'` is excluded deliberately, not
      // an oversight: a fully successful apply that created/updated real
      // resources also has `completedSteps.length > 0`, but that is
      // completion, not partial-ness — `PulumiRunRecord.partialApply`'s own
      // doc comment defines it only in terms of a failed/aborted engine
      // invocation, and marking every ordinary successful apply as "partial"
      // would defeat the whole distinction the spec's "re-plan, don't retry
      // blindly" requirement exists to carry.
      const resultPartialApply = outcome.kind !== 'success' && completedSteps.length > 0 ? true : undefined;

      try {
        this.writeRunRecord(
          runId,
          'apply',
          startedAt,
          completedAt,
          exitCode,
          configVersionId,
          record.planHash,
          undefined,
          resultChangeSummary,
          engineVersion,
          resultPartialApply,
        );
      } catch (err) {
        throw new PulumiRunPersistError(runId, PulumiService.toApplyOperationOutcome(outcome), err);
      }

      if (outcome.kind === 'success') {
        // Cache invalidation (see TSDoc). Best-effort: never let this mask an
        // otherwise-successful apply.
        //
        // Runs BEFORE `persistRunRecord` below, not after: `persistRunRecord`
        // calls `RunRecordService.persist`, which reads `runsTableName` off
        // `ConfigService.getStackOutputs()` — a MEMOISED delegate to this
        // class's own `getStackOutputs()`, cleared only by this same
        // `invalidateCache()` call. Calling it after `persistRunRecord` would
        // let this apply's own run-record write resolve `runsTableName`
        // against whatever was cached BEFORE this apply ran — for any apply
        // that itself changes the runs table (including the first apply
        // after a stack recovers from some edge case), that could silently
        // misdirect or drop the apply's own run-record write. Invalidating
        // first makes `persistRunRecord`'s read a cache MISS, forcing a
        // fresh `PulumiService.getStackOutputs()` call that reflects what
        // THIS apply just deployed.
        try {
          this.getConfigCacheInvalidator().invalidateCache();
        } catch (err) {
          logger.warn('pulumi apply: failed to invalidate the stack-outputs cache after a successful apply', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await this.persistRunRecord(
        runId,
        'apply',
        startedAt,
        completedAt,
        exitCode,
        configVersionId,
        record.planHash,
        undefined,
        resultChangeSummary,
        engineVersion,
        resultPartialApply,
      );
      // `persistRunRecord` (via `RunRecordService.persist`'s own `finally`)
      // has now attempted to release the durable apply lock — the outer
      // `finally`'s backstop below must not redundantly do it again on
      // every ordinary successful apply. See `lockReleased`'s own doc
      // comment for the liveness bug this specifically
      // avoids.
      lockReleased = true;

      if (outcome.kind === 'aborted') {
        return undefined;
      }
      if (outcome.kind === 'success') {
        return outcome.result;
      }
      throw outcome.error;
    } finally {
      // Unconditionally detach the internal-controller abort
      // listener — `{ once: true }` alone only removes it once `signal`
      // itself fires; on the overwhelmingly common path (the caller's
      // signal never aborts across a normal completion), it would otherwise
      // stay attached for the signal's whole lifetime, so a caller reusing
      // one long-lived `AbortSignal` across many `apply()` calls would
      // accumulate one listener per call. Safe/idempotent to call even when the listener already
      // detached itself (a `{ once: true }` listener that already fired).
      signal?.removeEventListener('abort', onAbort);

      // Covers the force-closed generator case — see preview()'s identical
      // block for the full rationale; mirrored here verbatim except for the
      // added lock-attempt-clearing decision below.
      if (operationPromise && !operationSettled) {
        internalController.abort();
        let forceCloseSettlement: unknown;
        await operationPromise.then(
          () => {
            forceCloseSettlement = undefined;
          },
          (err: unknown) => {
            forceCloseSettlement = err;
          },
        );
        if (lockAttemptId !== undefined && !(forceCloseSettlement instanceof PulumiOperationEscalatedError)) {
          this.store.clearPulumiLockAttempt(lockAttemptId);
          lockAttemptId = undefined;
        }
      }

      if (runId !== undefined) {
        this.endActiveRun(runId);
      }
      if (runId !== undefined && startedAt !== undefined && !runRecordWritten) {
        logger.warn('pulumi apply cancelled — generator force-closed while running', { runId });
        this.writeRunLog(runId, logLines);
        const completedAt = new Date().toISOString();
        // Threads `capturedChangeSummary`/a `completedSteps`-derived
        // `partialApply` through this fallback write too (both hoisted
        // above the outer `try` for exactly this reason) — a force-closed
        // apply that had already applied a mutating resource step is just as
        // much a partial apply as one that settled through the normal path
        // below; the fallback write previously discarded both signals
        // entirely. `planHash` (the parameter, not `record.planHash` — `record`
        // is block-scoped to the gate above and unreachable here) is threaded
        // too since it costs nothing and completes the record.
        const forceCloseResultPartialApply = completedSteps.length > 0 ? true : undefined;
        try {
          this.writeRunRecord(
            runId,
            'apply',
            startedAt,
            completedAt,
            null,
            configVersionId,
            planHash,
            undefined,
            capturedChangeSummary,
            engineVersion,
            forceCloseResultPartialApply,
          );
        } catch {
          // Nothing meaningful to do with a persistence failure while the
          // generator is already tearing down for an unrelated reason.
        }
        await this.persistRunRecord(
          runId,
          'apply',
          startedAt,
          completedAt,
          null,
          configVersionId,
          planHash,
          undefined,
          capturedChangeSummary,
          engineVersion,
          forceCloseResultPartialApply,
        );
        // See `lockReleased`'s own doc comment — this fallback's own
        // `persistRunRecord` call has now attempted the release too.
        lockReleased = true;
      }

      // Reset the LOCAL in-process mutex BEFORE the (rare, best-effort)
      // durable-lock backstop below, not after: the
      // backstop's own `await` (a real network round-trip through
      // `RunService.releaseRun` → `ConfigService.getStackOutputs()`) has no
      // bearing on the shared workspace directory this flag actually guards
      // (nothing further touches `workDir` after this point on any path),
      // so there is no reason a slow or wedged backstop call should also
      // block a brand-new `preview`/`apply`/`destroy` call on this same
      // instance from starting. Gated on `ownsOperationInFlight` rather than
      // unconditional — see that variable's own doc comment for why an
      // unconditional reset here would risk nulling out a concurrently
      // running, unrelated `preview`/`destroy` call's own flag on a path
      // where THIS `apply()` call's gate failed before ever touching the
      // field itself (the top-of-function check only reads it — see
      // "Nothing is reserved before step 8").
      if (ownsOperationInFlight) {
        this.operationInFlight = null;
      }

      // Skipped entirely once `lockReleased` is already `true`
      // — the overwhelmingly common case, since every ordinary successful or
      // cleanly-failed apply already released the lock via `persistRunRecord`
      // (or its force-close-fallback equivalent) moments earlier. Firing
      // this UNCONDITIONALLY on every apply would be a regression:
      // `RunService.releaseRun` awaits
      // `ConfigService.getStackOutputs()`, and on the success path the
      // `invalidateCache()` call above guarantees that read MISSES its cache
      // and re-invokes `PulumiService.getStackOutputs()` — two more real
      // `pulumi` CLI subprocess spawns (`stack select` + `stack output`)
      // delaying the generator's final settlement on every single successful
      // apply, for a release that had already happened moments before.
      // Reserved now for the ONE path it's actually needed — `writeRunRecord`
      // itself throwing, which skips `persistRunRecord` on the NORMAL
      // (non-force-closed) path entirely (`runRecordWritten` is set `true`
      // right before that call, so a throw there also skips this block's own
      // force-close fallback above, which is gated on `!runRecordWritten`) —
      // and would otherwise leak the durable lock for the full
      // `DEFAULT_LOCK_TTL_MS` (1 hour) with nothing in-app to clear it.
      // `apply` is self-contained, so it owns this unconditional
      // `RunService.releaseRun` backstop itself rather than leaving it to a
      // controller that doesn't exist yet. Wrapped in try/catch (matching the re-check's own
      // `releaseRun` call above) even though `RunService.releaseRun` is
      // documented to never throw — defensive, since this method depends on
      // it only through the narrower `RunLockService` interface.
      if (runId !== undefined && !lockReleased) {
        try {
          await this.getRunLockService().releaseRun(runId);
        } catch (err) {
          logger.warn('pulumi apply: failed to release the durable apply lock as a backstop', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  /**
   * Mints a fresh, single-use confirmation token for a subsequent
   * {@link destroy} call, valid for {@link DESTROY_CONFIRMATION_TTL_MS},
   * bound to the CURRENT destroy target — see
   * {@link PulumiPendingDestroyConfirmation}'s doc comment for the full
   * target-binding design. Intended to
   * be called the moment the renderer shows its destroy-confirmation modal,
   * so the token's lifetime brackets the window the operator actually has
   * that modal open.
   *
   * Minting a new token immediately supersedes any previously minted (and not
   * yet consumed) token — only the most recently minted token is ever
   * accepted by {@link destroy}. A token is consumed (and can never be
   * reused) the moment a `destroy()` call validates it, whether or not that
   * run ultimately succeeds — a second destroy attempt requires minting a new
   * token.
   */
  mintDestroyConfirmationToken(): string {
    this.pendingDestroyConfirmation = {
      token: randomUUID(),
      expiresAt: Date.now() + DESTROY_CONFIRMATION_TTL_MS,
      stateBucket: this.store.get('bootstrap')?.stateBucket,
      stateBucketRegion: this.store.get('aws')?.region,
      stackName: PULUMI_STACK_NAME,
      projectName: PULUMI_PROJECT_NAME,
    };
    return this.pendingDestroyConfirmation.token;
  }

  /**
   * Mints a fresh, single-use confirmation token for a subsequent
   * {@link clearStaleLock} call, valid for {@link LOCK_CLEAR_CONFIRMATION_TTL_MS},
   * bound to the CURRENT lock-clear target — mirrors
   * {@link mintDestroyConfirmationToken} exactly. Intended to be called the
   * moment the renderer shows its stale-lock confirmation dialog.
   */
  mintLockClearConfirmationToken(): string {
    this.pendingLockClearConfirmation = {
      token: randomUUID(),
      expiresAt: Date.now() + LOCK_CLEAR_CONFIRMATION_TTL_MS,
      stateBucket: this.store.get('bootstrap')?.stateBucket,
      stateBucketRegion: this.store.get('aws')?.region,
      stackName: PULUMI_STACK_NAME,
      projectName: PULUMI_PROJECT_NAME,
    };
    return this.pendingLockClearConfirmation.token;
  }

  /**
   * Runs `pulumi destroy` against the deployed stack, yielding a
   * {@link PulumiRunChunk} per line of stdout/stderr as the operation
   * produces it, and resolving to a {@link PulumiDestroyResult} once it
   * settles, gated behind a confirmation-token mechanism that is genuinely
   * target-bound (see {@link PulumiPendingDestroyConfirmation}'s doc comment).
   *
   * ## No plan-hash gate — the token IS the gate
   *
   * Unlike {@link apply}, `destroy` has no preceding `preview()` plan to
   * validate against: there is no saved artifact, no `planHash`, no approval
   * lineage. Destroy cannot be plan-constrained the way apply is — the destroy
   * path therefore relies ENTIRELY on the confirmation-token gate for its
   * safety, with no plan artifact behind it — the token gate is load-bearing
   * in a way the apply path's is not. Every design decision below treats the
   * token check as THE safety-critical
   * step of this method, not one of several redundant checks.
   *
   * ## Gate structure (simpler than `apply`'s, and
   * ordered differently, not just shorter)
   *
   * `apply`'s 8-step gate exists because two independent things must be true
   * before `stack.up()` runs: the plan is still valid (steps 1-7, all
   * idempotent reads — safe to repeat on a retry, so they're free to run
   * BEFORE the one non-idempotent step) AND no other run is allowed to start
   * (step 8, the atomic reservation, placed last). `destroy` has no analogue
   * to steps 1-7 at all — there is no plan to re-validate. What it has
   * instead is the confirmation token, which is NOT an idempotent read: it
   * is a single-use credential, and the `orchestrator-integration-coverage`
   * spec's "Concurrent submissions cannot share one token" scenario is
   * explicit that the LOSER of a same-token race must observe
   * `DestroyNotConfirmedError` specifically — not `RunLockHeldError`, not a
   * generic "busy" refusal.
   *
   * **Only ONE ordering constraint below is actually forced by that spec
   * requirement — everything else is a deliberate choice, and this section
   * is explicit about which is which**, since generalizing "the token must
   * precede the one genuinely-forced boundary" into "the token must precede
   * everything else" would needlessly burn tokens on refusals that have
   * nothing to do with the race the ordering is protecting against:
   *
   * - **Forced**: the token MUST be consumed before {@link RunLockService.createRun}
   *   (gate step 4 below) — `createRun` is this method's first genuine
   *   `await` boundary (a DynamoDB round trip when the runs table is
   *   deployed), so any ordering that reaches it before the token is
   *   consumed would let a same-token race be decided by `createRun`'s own
   *   atomicity instead — the loser would observe `RunLockHeldError`, not
   *   `DestroyNotConfirmedError`, violating the spec scenario outright.
   * - **NOT forced**: whether the pure, synchronous config-presence checks
   *   (gate step 2 below — state bucket/region configured, a stack has
   *   actually been created) run before or after the token. Both orderings
   *   are equally synchronous (neither has an `await` in it), so EITHER
   *   ordering decides a same-token race identically — at the token check,
   *   with nothing async above it, with `RunLockService` never touched by
   *   the loser. These checks are placed BEFORE the token: a call that was
   *   always going to fail an ordinary "is anything even deployed yet" check
   *   should not additionally burn the operator's single-use confirmation on
   *   top of that failure, and nothing about the spec requires it to.
   *
   * 1. {@link operationInFlight} busy check (top, cheap, no reservation,
   *    still synchronous) — mirrors `apply`'s identical top-of-function
   *    check: refuses immediately if `preview`/`up`/an already-running
   *    `destroy` (from an EARLIER, already-committed call) is using the
   *    shared local workspace, before the token is ever even read.
   * 2. Pure, synchronous config-presence checks — state bucket/region
   *    configured, a stack has actually been created (passphrase on
   *    record). NOT forced to precede the token (see above) — ordered here
   *    as a deliberate choice, not a spec requirement.
   * 3. **THE authoritative safety gate, consumed here — still synchronously,
   *    with nothing async above it (steps 1-2 are also synchronous, so this
   *    property holds regardless of their relative order)**:
   *    {@link assertFreshDestroyConfirmation}. Two calls sharing the same
   *    token, driven "concurrently" (their `.next()` calls issued
   *    back-to-back before either has awaited anything), are strictly
   *    ordered by JS itself — whichever call's `.next()` executes first
   *    runs this whole gate step, including the token's synchronous clear,
   *    to completion before the other call's `.next()` begins at all. The
   *    loser observes the token already consumed and throws
   *    {@link DestroyNotConfirmedError} — exactly the spec's required
   *    outcome, decided without ever touching `RunLockService`. Nothing has
   *    been reserved anywhere by the time this step could throw (no lock,
   *    no `operationInFlight`, no active-run buffer), so a rejection here is
   *    a clean, zero-side-effect unwind.
   * 4. **THEN, and only then — this ordering IS forced (see above)**:
   *    `RunLockService.createRun()` (called with `'destroy'`, the resolved
   *    initiator, and this run's `runId`) — the SAME atomic
   *    compare-and-set `apply`'s gate step 8 uses, reserving this app's
   *    single durable run slot for `runId`. A losing race rejects with
   *    `RunLockHeldError`, propagated unwrapped, exactly like `apply`.
   * 5. The SAME post-`createRun` {@link operationInFlight} TOCTOU re-check
   *    `apply` performs (closing the gap a concurrent `preview`/already-
   *    winning `up` could have opened during that `await`) — on a loss, the
   *    just-acquired durable lock is released and the call refused, mirroring
   *    `apply`'s identical branch byte-for-byte.
   * 6. **Commit**: `operationInFlight = 'destroy'`, `beginActiveRun(runId)`,
   *    `startedAt` captured. Nothing above this line has reserved anything
   *    that survives a refusal EXCEPT the token itself (step 3 — spec-
   *    mandated to be spent regardless of what happens afterward; there is
   *    no "un-consume") — every other branch that throws before this point
   *    either reserved nothing at all, or explicitly released what it
   *    reserved (the durable lock) before throwing.
   *
   * **Residual, genuinely-forced trade-off, stated explicitly**: because
   * step 4 (the ONE ordering the spec actually forces after the token) can
   * still lose its race — a DIFFERENT process already holding the durable
   * lock — a destroy can still spend its token on a call that was always
   * going to be refused with `RunLockHeldError`. There is no synchronous way
   * to know whether `createRun` will win BEFORE calling it (the durable lock
   * is only observable via that same async round trip), so this one case
   * cannot be moved earlier the way the config checks were. It is rare in
   * this single-desktop-app context (this app never runs two instances
   * against the same stack under normal operation) and, per the destroy
   * gate's own governing spec, burning a token here is the fail-safe
   * outcome, not an unsafe one — a spent token only forces re-confirmation,
   * never a silent no-op. Step 1's {@link operationInFlight} check fully
   * protects the actually-common conflict case (a second click, or a second
   * IPC submission, while THIS process's own destroy/apply/preview is
   * already running) without spending anything, and step 2 now fully
   * protects the "nothing is configured yet" case too. Checking the token
   * strictly last is not a viable alternative ordering: it cannot satisfy the
   * spec's concurrent-shared-token scenario at all (see the "Forced" bullet
   * above).
   *
   * `operationInFlight` is, exactly like `apply`, only ever SET once —
   * immediately after commit (step 6) — never at the top-of-function check
   * (step 1), for the identical reason `apply`'s TSDoc documents: setting it
   * early would be the forbidden "preceding workspace-is-free observation"
   * that prevents two genuinely-concurrent calls from both reaching the
   * atomic reservation at all.
   *
   * ## Does `stack.destroy()` take the DIY backend lock?
   *
   * **Yes.** `pkg/backend/diy/backend.go`'s `diyBackend.Destroy` (fetched
   * from the `pulumi/pulumi` GitHub repo, `master` branch):
   *
   * ```go
   * func (b *diyBackend) Destroy(...) (sdkDisplay.ResourceChanges, error) {
   *     if op.Opts.PreviewOnly { ... }  // this method never sets PreviewOnly
   *     err := b.Lock(ctx, stack.Ref())
   *     if err != nil { return nil, err }
   *     defer b.Unlock(ctx, stack.Ref())
   *     return backend.PreviewThenPromptThenExecute(ctx, apitype.DestroyUpdate, stack, op, b.apply, nil, nil)
   * }
   * ```
   *
   * — identical shape to `diyBackend.Update` (`apply`'s own path): `Lock`
   * before, deferred `Unlock` after. This method never sets
   * `DestroyOptions.previewOnly`, so it always takes the real (non-preview)
   * path shown above. Confirms the SAME lock-recording +
   * `ConcurrentUpdateError` classification + auto-reclaim-of-provable-own-
   * orphan mechanism `apply` established applies here unchanged — wired below via the identical
   * `ElectronStoreService.recordPulumiLockAttempt`/`clearPulumiLockAttempt`/
   * `PulumiLockRecovery.classifyStackLockConflict` calls `apply` uses, not a
   * rederived variant.
   *
   * ## No-op inline program
   *
   * Unlike `preview`/`apply`, this method passes a trivial
   * `async () => ({})` program to {@link PulumiWorkspaceService.getOrCreateStack}
   * — the SAME no-op {@link getStackOutputs} already established is safe for
   * an operation that doesn't need the program's actual resource graph.
   * Verified against `stack.js`'s own `destroy()` implementation: the CLI
   * args it builds only ever include `--run-program=<bool>` when
   * `DestroyOptions.runProgram` is explicitly set
   * (`if (opts.runProgram !== undefined)`); this method never sets it, so the
   * CLI's own default applies — a plain `pulumi destroy` does NOT run the
   * program, it deletes whatever the existing state checkpoint says exists,
   * using each resource's own provider. The inline program's role in an
   * Automation API call is to stand up the gRPC language-server handshake
   * `LocalWorkspace.createOrSelectStack` requires — not to redescribe the
   * resources being destroyed. Using a no-op program also means this method
   * never needs to read the deployment configuration object from S3 at all:
   * `destroy` can tear down a stack even if the current configuration object
   * is missing, malformed, or describing a different game-server layout than
   * what's actually deployed — an operationally important property (you must
   * be able to destroy broken infrastructure) this method would otherwise
   * accidentally lose by depending on `createInfraProgram(deploymentConfig, ...)`
   * succeeding first.
   *
   * ## `changeSummary`
   *
   * `DestroyResult` (`stack.d.ts`) is `{ stdout, stderr, summary: UpdateSummary }`
   * — structurally identical to `UpResult`'s shape (`apply`'s own result),
   * NOT `PreviewResult`'s flatter `{ stdout, stderr, changeSummary }`.
   * `UpdateSummary.resourceChanges` is optional and, per `apply`'s own TSDoc,
   * its exact population semantics from the CLI were never independently
   * verified. This method therefore handles it exactly like `apply` does —
   * NOT `preview` — capturing `capturedChangeSummary` from `onEvent`'s
   * `summaryEvent` and using that captured value directly for the returned
   * result on every path, never reading `DestroyResult.summary.resourceChanges`.
   * This also means the leaked-promise-recovery path and the normal-
   * completion path can never disagree about where `changeSummary` came
   * from, for the identical reason `apply`'s TSDoc gives.
   *
   * ## No partial-destroy concept (investigated, per the brief's explicit
   * instruction not to invent one unprompted)
   *
   * `DestroyResult` carries no partial/complete distinction beyond the
   * generic `summary.result` (`UpdateResult`) — nothing analogous to
   * `apply`'s `resOutputsEvent`-derived `completedSteps` tracking exists here,
   * because the brief's own instruction was explicit: don't build a parallel
   * mechanism unless evidence in `DestroyResult`'s actual shape calls for it.
   * It doesn't — {@link PulumiDestroyOutcome} is a plain three-way
   * success/aborted/failed union, with no `partialApply`-style fourth signal,
   * mirroring {@link PulumiPreviewOutcome}'s shape rather than
   * {@link PulumiApplyOutcome}'s.
   *
   * ## Leaked-promise `recoverResult`
   *
   * Mirrors `apply`'s real (re-reading) implementation, not `preview`'s
   * "nothing to re-read" one: `stack.info()` is re-read (a fresh, independent,
   * read-only call) purely as a sanity-check WARN log if its `result` isn't
   * `'succeeded'` — it does not gate or override the recovery, trusting
   * `isLeakedPromiseError`'s proven-sufficient classification per
   * `PulumiLeakedPromise.ts`'s "provably sufficient" section. Unlike `apply`,
   * `stack.outputs()` is NOT re-read — {@link PulumiDestroyResult} carries no
   * outputs (there is nothing meaningful to report post-destroy), and a
   * destroyed stack's outputs read would itself be racing the very teardown
   * this recovery path exists to confirm succeeded.
   *
   * ## Cancellation, chunk streaming, force-close safety net
   *
   * All THREE mirror `apply`'s shapes byte-for-byte: the named
   * `onAbort` handler with unconditional `removeEventListener` in the outer
   * `finally`, the `internalController`/`operationPromise`/
   * `operationSettled` triple for a force-closed generator's bounded
   * abort-and-await, and the identical queue/wake/notify chunk-streaming
   * consumer loop. See {@link apply}'s TSDoc for the full rationale of each;
   * nothing about the engine swap or the simpler gate changes any of it.
   *
   * ## Cache invalidation
   *
   * On a successful destroy — and ONLY then — {@link getConfigCacheInvalidator}'s
   * `invalidateCache()` is called, best-effort, mirroring `apply`'s identical
   * requirement: a destroyed stack's `getStackOutputs()` must stop reporting
   * stale "deployed" data immediately, not after the next unrelated cache
   * expiry. Called BEFORE `persistRunRecord`, not after — see `apply()`'s
   * own "Cache invalidation" TSDoc section for the full
   * `runsTableName`-staleness reasoning, identical here.
   *
   * ## Persistence
   *
   * `kind: 'destroy'`, same `writeRunLog`/`endActiveRun`/`writeRunRecord`/
   * `persistRunRecord` sequence `preview`/`apply` use. No `configVersionId`,
   * `planHash`, or `engineVersion` is recorded — all three are left
   * `undefined` (there
   * is no configuration version or plan artifact this run ran against — see
   * "No-op inline program" above for why this method never even reads the
   * configuration object). `persistRunRecord`'s own `RunRecordService.persist`
   * releases the durable lock step 3 acquired, in its own `finally` — no
   * separate `RunLockService.releaseRun` call is made on that path, mirroring
   * `apply`'s identical reliance; the outer `finally`'s `lockReleased`-gated
   * backstop below exists for the one path that skips it (`writeRunRecord`
   * itself throwing), for the identical reason `apply`'s TSDoc documents.
   *
   * @param confirmationToken - The token returned by a prior
   *   {@link mintDestroyConfirmationToken} call. See "Gate structure" above
   *   for exactly when this is validated relative to the durable lock.
   * @param signal - Optional cancellation signal — see "Cancellation, chunk
   *   streaming, force-close safety net" above.
   * @param preMintedRunId - Optional caller-minted `runId` — must match
   *   {@link RUN_ID_PATTERN}.
   * @throws {@link PulumiOperationInFlightError} if another `preview`/`up`/
   *   `destroy`/`rollback` is already in flight on this instance (the
   *   top-of-function busy check).
   * @throws A descriptive `Error` if `preMintedRunId` doesn't match
   *   {@link RUN_ID_PATTERN}, if the state bucket/region aren't configured, or
   *   if no stack has ever been created (no passphrase on record).
   * @throws `RunLockHeldError` (`@hyveon/shared`, unwrapped) if the durable
   *   lock reservation loses its atomic race.
   * @throws {@link DestroyNotConfirmedError} if `confirmationToken` is
   *   missing, unknown, expired, already consumed, or bound to a different
   *   target (see {@link PulumiPendingDestroyConfirmation}'s doc comment,
   *   "Target binding").
   * @throws {@link PulumiUnrecognizedLockError} if `stack.destroy()` hits a
   *   backend lock conflict that cannot be proven this installation's own
   *   orphan.
   * @throws {@link PulumiDestroyError} if `stack.destroy()` fails (not
   *   aborted, not a leaked-promise-recovered success).
   * @throws {@link PulumiRunPersistError} if the operation settled but the
   *   run record couldn't be persisted afterward.
   */
  async *destroy(
    confirmationToken: string,
    signal?: AbortSignal,
    preMintedRunId?: string,
  ): AsyncGenerator<PulumiRunChunk, PulumiDestroyResult | undefined> {
    logger.debug('PulumiService.destroy: starting pulumi destroy');
    if (this.operationInFlight) {
      throw new PulumiOperationInFlightError(this.operationInFlight);
    }
    this.assertStackInitNotInFlight('destroy');
    if (preMintedRunId !== undefined) {
      PulumiService.assertValidRunId(preMintedRunId);
    }

    // Hoisted for the same reason as preview()/apply()'s equivalents — a
    // force-closed generator unwinds straight to the outer finally, which
    // needs to see these.
    let runId: string | undefined;
    let startedAt: string | undefined;
    let runRecordWritten = false;
    // `true` only once THIS invocation has itself set operationInFlight
    // (post-commit, see "Gate structure" above) — mirrors apply()'s
    // identically-named, identically-reasoned flag.
    let ownsOperationInFlight = false;
    // `true` once a call that genuinely attempted to release the durable lock
    // has completed — mirrors apply()'s identically-named flag and its exact
    // rationale (avoid a redundant RunService.releaseRun round-trip on the
    // overwhelmingly common already-released-via-persistRunRecord path).
    let lockReleased = false;
    let capturedChangeSummary: ChangeSummary = {};
    // The id ElectronStoreService.recordPulumiLockAttempt returns — mirrors
    // apply()'s identically-named field and its exact clear/leave-behind
    // rules (see "Does stack.destroy() take the DIY backend lock?" above).
    let lockAttemptId: string | undefined;
    const logLines: string[] = [];

    // Same internal-controller pattern as preview()/apply() — see apply()'s
    // TSDoc for the full rationale, including the named-`onAbort`-
    // with-unconditional-removal handling.
    const internalController = new AbortController();
    const onAbort = (): void => internalController.abort();
    if (signal) {
      if (signal.aborted) {
        internalController.abort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    let operationPromise: Promise<DestroyResult> | undefined;
    let operationSettled = false;

    try {
      // Single abort check for this method's whole synchronous prologue
      // (gate steps 2-3 below — the config-presence checks and the token
      // consumption) — nothing yields between here and the createRun()
      // `await` further down, so a second check partway through that
      // prologue could never observe a state change (nothing else runs on
      // this thread in between) and would be dead code — deliberately not
      // duplicated here, unlike preview()/apply(), where each such check
      // sits after a genuine `await` and is therefore live.
      if (internalController.signal.aborted) {
        return undefined;
      }

      // --- Gate step 2: pure, synchronous config-presence checks — state
      // bucket/region configured, a stack has actually been created. NOT
      // forced to precede the token by the governing spec (unlike gate step
      // 4's ordering relative to step 3, below) — placed here as a
      // deliberate choice so a call that was always going to fail an
      // ordinary "is anything even deployed yet" check doesn't also burn
      // the operator's single-use confirmation token. See this method's
      // TSDoc, "Gate structure", for the full forced-vs-chosen breakdown. ---
      const stateBucket = this.store.get('bootstrap')?.stateBucket;
      const stateBucketRegion = this.store.get('aws')?.region;
      if (!stateBucket || !stateBucketRegion) {
        throw new Error(
          'Cannot run pulumi destroy: the state bucket / AWS region has not been configured yet. ' +
            'Complete the bootstrap step before destroying.',
        );
      }
      const stackExists = this.store.get('pulumi')?.passphrase !== undefined;
      if (!stackExists) {
        throw new Error(
          'Cannot run pulumi destroy: no Pulumi stack has ever been created for this installation ' +
            '(no secrets passphrase on record) — nothing to destroy.',
        );
      }

      // --- Gate step 3: THE authoritative safety gate — still fully
      // synchronous, still with nothing async above it (step 2 above is
      // also synchronous, so this property holds regardless of their
      // relative order), so token consumption remains atomic for two calls
      // racing on the SAME token: JS's own run-to-completion semantics mean
      // whichever call's `.next()` runs first executes this whole line
      // (and the synchronous clear inside assertFreshDestroyConfirmation)
      // to completion before the other call's `.next()` is even invoked.
      // THIS is the check that is genuinely forced to precede gate step 4
      // (createRun) — see this method's TSDoc, "Gate structure". ---
      this.assertFreshDestroyConfirmation(confirmationToken, stateBucket, stateBucketRegion);

      // --- Gate step 4: THE atomic, authoritative durable-lock reservation
      // (mirrors apply()'s gate step 8 exactly) — this is the ordering
      // constraint gate step 3 above is genuinely forced to precede. ---
      const initiator = PulumiService.resolveInitiator();
      const reservedRunId = preMintedRunId ?? randomUUID();
      await this.getRunLockService().createRun('destroy', initiator, reservedRunId);

      if (internalController.signal.aborted) {
        // Aborted while acquiring the durable lock — nothing else was ever
        // reserved (operationInFlight untouched, no active-run buffer), so
        // releasing the lock is the entire undo.
        try {
          await this.getRunLockService().releaseRun(reservedRunId);
        } catch (err) {
          logger.warn('pulumi destroy: failed to release the durable lock after an early abort', {
            reservedRunId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return undefined;
      }

      // --- Gate step 5: the SAME post-createRun operationInFlight TOCTOU
      // re-check apply() performs — see this method's TSDoc, "Gate structure".
      // Also re-checks `stackInitInFlight`, mirroring apply()'s identical
      // check and for the identical reason — `initializeStack()` never
      // touches `operationInFlight`, so this recheck would otherwise have no
      // way to see a concurrently-running stack initialization at all. ---
      if (this.operationInFlight || this.stackInitInFlight) {
        const inFlight = this.operationInFlight ?? 'initializeStack()';
        try {
          await this.getRunLockService().releaseRun(reservedRunId);
        } catch (err) {
          logger.warn(
            'pulumi destroy: failed to release the durable lock after the local-workspace re-check refused',
            {
              reservedRunId,
              inFlight,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
        throw new Error(
          `pulumi destroy refused: ${inFlight} is already in flight against the shared workspace; wait for it ` +
            'to finish before retrying. (The durable lock this call just acquired has been released.)',
        );
      }

      // --- Gate step 6: commit. Nothing above this line has left anything
      // reserved that survives a refusal (see "Gate structure" above): the
      // token is the only non-idempotent thing consumed before this point,
      // and it is spec-mandated to be spent regardless of what happens
      // afterward — there is no "un-consume" for a refusal that follows it. ---
      this.operationInFlight = 'destroy';
      ownsOperationInFlight = true;
      runId = reservedRunId;
      this.beginActiveRun(runId);
      startedAt = new Date().toISOString();

      let destroyError: unknown;
      try {
        const stack = await this.workspace.getOrCreateStack({
          // See this method's TSDoc, "No-op inline program", for why destroy
          // never reads the deployment configuration object at all.
          program: async () => ({}),
          stateBucket,
          stateBucketRegion,
          backendReady: true,
        });

        // --- Chunk-streaming setup — identical algorithm to preview()/apply() ---
        const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
        const queue: PulumiRunChunk[] = [];
        let wake: (() => void) | null = null;
        const notify = (): void => {
          wake?.();
          wake = null;
        };
        const push = (chunk: PulumiRunChunk): void => {
          queue.push(chunk);
          notify();
        };
        const handleData = (stream: 'stdout' | 'stderr', data: string): void => {
          buffers[stream] += data;
          const lines = buffers[stream].split(/\r?\n/);
          buffers[stream] = lines.pop() ?? '';
          for (const line of lines) {
            push({ stream, line });
          }
        };
        const onOutput = (out: string): void => handleData('stdout', out);
        const onError = (err: string): void => handleData('stderr', err);
        const onEvent = (event: EngineEvent): void => {
          if (event.summaryEvent) {
            // See this method's TSDoc, "changeSummary", for why this is
            // handled like apply(), not preview().
            capturedChangeSummary = event.summaryEvent.resourceChanges;
          }
        };

        // Lock-recovery wiring — the identical mechanism apply() established,
        // reused verbatim; see this method's TSDoc, "Does
        // stack.destroy() take the DIY backend lock?".
        lockAttemptId = this.store.recordPulumiLockAttempt(PULUMI_STACK_NAME);

        const attemptDestroy = async (innerSignal: AbortSignal): Promise<DestroyResult> => {
          try {
            return await stack.destroy({ onOutput, onError, onEvent, signal: innerSignal });
          } catch (err) {
            if (!isStackLockConflict(err)) {
              throw err;
            }
            const classification = classifyStackLockConflict(err, this.store, PULUMI_STACK_NAME);
            if (classification.kind === 'reclaimable-own-orphan') {
              logger.warn(
                'pulumi destroy: backend lock is a provable orphan of this installation\'s own prior run — ' +
                  'clearing it via stack.cancel() and retrying the destroy once',
                { runId, locks: classification.locks },
              );
              await stack.cancel();
              return await stack.destroy({ onOutput, onError, onEvent, signal: innerSignal });
            }
            throw new PulumiUnrecognizedLockError(
              PULUMI_STACK_NAME,
              classification.kind === 'requires-confirmation' ? classification.locks : [],
            );
          }
        };

        const recoverResult = async (): Promise<DestroyResult> => {
          const summary = await stack.info();
          if (summary && summary.result !== 'succeeded') {
            logger.warn(
              'pulumi destroy leaked-promise recovery: stack.info() does not report "succeeded" — trusting the ' +
                'SDK-verified leak-check proof anyway (see PulumiLeakedPromise.ts, "provably sufficient")',
              { runId, result: summary.result },
            );
          }
          return {
            stdout: '',
            stderr: '',
            summary: summary ?? {
              kind: 'destroy',
              startTime: new Date(),
              endTime: new Date(),
              message: '',
              environment: {},
              config: {},
              result: 'succeeded',
              version: 0,
            },
          };
        };

        operationPromise = runWithEscalatingCancellation(
          (innerSignal) => runTreatingLeakedPromiseAsSuccess(() => attemptDestroy(innerSignal), recoverResult),
          internalController.signal,
        );

        const onOperationSettled = (): void => {
          for (const stream of ['stdout', 'stderr'] as const) {
            if (buffers[stream].length > 0) {
              push({ stream, line: buffers[stream] });
              buffers[stream] = '';
            }
          }
          operationSettled = true;
          notify();
        };
        operationPromise.then(onOperationSettled, onOperationSettled);

        while (true) {
          if (queue.length > 0) {
            const chunk = queue.shift()!;
            logLines.push(chunk.line);
            this.recordRunChunk(runId, chunk);
            yield chunk;
            continue;
          }
          if (operationSettled) {
            break;
          }
          await new Promise<void>((resolveWait) => {
            wake = resolveWait;
          });
        }

        await operationPromise;
      } catch (err) {
        destroyError = err;
      }

      // Clear the lock-ownership record on every settlement EXCEPT a forceful
      // escalation — mirrors apply()'s identical rationale ("Force-close
      // safety net").
      if (lockAttemptId !== undefined && !(destroyError instanceof PulumiOperationEscalatedError)) {
        this.store.clearPulumiLockAttempt(lockAttemptId);
        lockAttemptId = undefined;
      }

      const wasAborted =
        destroyError instanceof PulumiOperationNotStartedError ||
        destroyError instanceof PulumiOperationAbortedError ||
        destroyError instanceof PulumiOperationEscalatedError;

      const outcome: PulumiDestroyOutcome = wasAborted
        ? { kind: 'aborted' }
        : destroyError
          ? {
              kind: 'failed',
              error:
                destroyError instanceof PulumiUnrecognizedLockError
                  ? destroyError
                  : new PulumiDestroyError(destroyError),
            }
          : { kind: 'success', result: { runId, changeSummary: capturedChangeSummary } };

      if (outcome.kind === 'failed') {
        logger.error('pulumi destroy: operation failed', {
          runId,
          error: outcome.error.message,
        });
      }

      runRecordWritten = true;
      this.writeRunLog(runId, logLines);
      this.endActiveRun(runId);

      const completedAt = new Date().toISOString();
      const exitCode = outcome.kind === 'aborted' ? null : outcome.kind === 'success' ? 0 : 1;
      const resultChangeSummary = outcome.kind === 'success' ? outcome.result.changeSummary : capturedChangeSummary;

      try {
        this.writeRunRecord(
          runId,
          'destroy',
          startedAt,
          completedAt,
          exitCode,
          undefined,
          undefined,
          undefined,
          resultChangeSummary,
        );
      } catch (err) {
        throw new PulumiRunPersistError(runId, PulumiService.toDestroyOperationOutcome(outcome), err);
      }

      if (outcome.kind === 'success') {
        // Cache invalidation (see this method's TSDoc, "Cache invalidation").
        //
        // Runs BEFORE `persistRunRecord` below, not after — mirrors apply()'s
        // identical reasoning (see that method's own TSDoc, "Cache
        // invalidation"): `persistRunRecord` reads `runsTableName` off a
        // cache this same call clears, so invalidating afterward would let
        // this destroy's own run-record write resolve against PRE-destroy
        // cached outputs.
        try {
          this.getConfigCacheInvalidator().invalidateCache();
        } catch (err) {
          logger.warn('pulumi destroy: failed to invalidate the stack-outputs cache after a successful destroy', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await this.persistRunRecord(
        runId,
        'destroy',
        startedAt,
        completedAt,
        exitCode,
        undefined,
        undefined,
        undefined,
        resultChangeSummary,
      );
      // See lockReleased's own doc comment — persistRunRecord's own
      // RunRecordService.persist has now attempted the release too.
      lockReleased = true;

      if (outcome.kind === 'aborted') {
        return undefined;
      }
      if (outcome.kind === 'success') {
        return outcome.result;
      }
      throw outcome.error;
    } finally {
      // Mirrors apply()'s abort-listener cleanup — see apply()'s TSDoc.
      signal?.removeEventListener('abort', onAbort);

      // Covers the force-closed generator case — see apply()'s identical
      // block for the full rationale; mirrored here verbatim except for the
      // Pulumi-operation-specific types.
      if (operationPromise && !operationSettled) {
        internalController.abort();
        let forceCloseSettlement: unknown;
        await operationPromise.then(
          () => {
            forceCloseSettlement = undefined;
          },
          (err: unknown) => {
            forceCloseSettlement = err;
          },
        );
        if (lockAttemptId !== undefined && !(forceCloseSettlement instanceof PulumiOperationEscalatedError)) {
          this.store.clearPulumiLockAttempt(lockAttemptId);
          lockAttemptId = undefined;
        }
      }

      if (runId !== undefined) {
        this.endActiveRun(runId);
      }
      if (runId !== undefined && startedAt !== undefined && !runRecordWritten) {
        logger.warn('pulumi destroy cancelled — generator force-closed while running', { runId });
        this.writeRunLog(runId, logLines);
        const completedAt = new Date().toISOString();
        try {
          this.writeRunRecord(
            runId,
            'destroy',
            startedAt,
            completedAt,
            null,
            undefined,
            undefined,
            undefined,
            capturedChangeSummary,
          );
        } catch {
          // Nothing meaningful to do with a persistence failure while the
          // generator is already tearing down for an unrelated reason.
        }
        await this.persistRunRecord(
          runId,
          'destroy',
          startedAt,
          completedAt,
          null,
          undefined,
          undefined,
          undefined,
          capturedChangeSummary,
        );
        // See lockReleased's own doc comment — this fallback's own
        // persistRunRecord call has now attempted the release too.
        lockReleased = true;
      }

      // Reset the LOCAL in-process mutex BEFORE the (rare, best-effort)
      // durable-lock backstop below — mirrors apply()'s identical
      // hardening and rationale.
      if (ownsOperationInFlight) {
        this.operationInFlight = null;
      }

      // Mirrors apply()'s backstop verbatim — skipped entirely once
      // lockReleased is already true (the overwhelmingly common case); see
      // apply()'s TSDoc for the full rationale of why this exists at all
      // (the one path that skips persistRunRecord entirely: writeRunRecord
      // itself throwing).
      if (runId !== undefined && !lockReleased) {
        try {
          await this.getRunLockService().releaseRun(runId);
        } catch (err) {
          logger.warn('pulumi destroy: failed to release the durable lock as a backstop', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  /**
   * Resolves the configuration-object version that was live immediately
   * before the given `apply` run — the target {@link confirmRollback} would
   * restore. Read-only: performs no write.
   * Safe to call twice for the same `applyRunId`: once to preview the
   * rollback target for an operator's confirmation dialog, and again,
   * immediately before the actual restore write, inside
   * {@link confirmRollback} — so a version that expires in the window
   * between the two calls is still caught before anything is written.
   *
   * Looks up `applyRunId` via {@link getRunRecordPersister}, validates it's
   * an `apply` run with a recorded `configVersionId`, then walks the
   * complete `listVersions` history for the configuration object: since
   * {@link RemoteFileStore.listVersions} returns versions newest-first, the
   * version "live before" the apply run is the entry immediately *after*
   * the apply's own `configVersionId` in that array (one step further back
   * in time).
   *
   * @param applyRunId - The `runId` of the `apply` run to resolve a rollback target for.
   * @throws {@link RollbackTargetNotFoundError} when no run record exists for `applyRunId`.
   * @throws {@link RollbackNotApplyRunError} when the record isn't an `apply` run.
   * @throws {@link RollbackNoConfigVersionError} when the apply run has no recorded configuration version id.
   * @throws {@link RollbackVersionMissingError} when no earlier configuration version exists in the version history.
   */
  async resolveRollbackTarget(applyRunId: string): Promise<{ versionId: string; lastModified: Date }> {
    logger.debug('PulumiService.resolveRollbackTarget: resolving rollback target', { applyRunId });
    const record = await this.getRunRecordPersister().getByRunId(applyRunId);
    if (!record) {
      throw new RollbackTargetNotFoundError(applyRunId);
    }
    if (record.kind !== 'apply') {
      throw new RollbackNotApplyRunError(applyRunId, record.kind);
    }
    if (!record.configVersionId) {
      throw new RollbackNoConfigVersionError(applyRunId);
    }

    const key = CONFIGURATION_OBJECT_KEY;
    const versions = await this.getRemoteFileStore().listVersions(key);
    const index = versions.findIndex((v) => v.versionId === record.configVersionId);
    const prior = index === -1 ? undefined : versions[index + 1];
    if (!prior) {
      throw new RollbackVersionMissingError(record.configVersionId);
    }
    return prior;
  }

  /**
   * Best-effort parse of a raw configuration-object JSON document into a
   * {@link DeploymentConfig}. Mirrors `DeploymentConfigService.parseConfigContents`'s
   * body exactly (`JSON.parse` plus an object-shape check — HCL parsing was
   * dropped entirely, see `deploymentConfig.ts`'s file doc) but returns
   * `undefined` instead of throwing on either a malformed-JSON or
   * wrong-shape document, so its only caller, {@link computeRollbackDiff},
   * can degrade to "no diff" with a single `undefined` check rather than a
   * `try`/`catch` per parse. Not shared with `DeploymentConfigService` — see
   * {@link computeRollbackDiff}'s own TSDoc for why this class doesn't take
   * a `DeploymentConfigService` dependency just for this.
   */
  private static parseDeploymentConfigOrUndefined(raw: string): DeploymentConfig | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn('PulumiService: failed to parse configuration JSON for a rollback diff', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      logger.warn('PulumiService: configuration JSON did not decode to an object for a rollback diff', {});
      return undefined;
    }
    return parsed as DeploymentConfig;
  }

  /**
   * Best-effort computation of how `targetVersionId` (a rollback target
   * identified by {@link resolveRollbackTarget}) differs from the current
   * configuration head — the `iac-rollback` spec's SHOULD-level "summarize
   * how the target configuration differs from the current one" enhancement,
   * layered on top of the already-working, spec-MUST
   * "identify the target version" behavior {@link resolveRollbackTarget}
   * provides on its own.
   *
   * ## Why a separate method rather than folding this into
   * `resolveRollbackTarget` itself
   *
   * `resolveRollbackTarget` is called twice per rollback: once by
   * `IacController.resolveRollback` to populate the operator's confirmation
   * dialog (where a diff is genuinely useful), and again by
   * {@link confirmRollback} to re-resolve the target immediately before the
   * restore write (where a diff would only add two unnecessary
   * `RemoteFileStore` reads to the write-guarded critical path, for a value
   * `confirmRollback` never uses). Keeping diff computation in its own
   * method means `confirmRollback`'s behavior is untouched: it still calls
   * the exact same `resolveRollbackTarget` it always has.
   *
   * ## Degradation
   *
   * Never throws. Any failure — the target version's bytes no longer
   * readable, the current head missing entirely, either document failing to
   * parse or decode to an object — is caught here, logged at `warn`, and
   * reported as `undefined`, so a diff-computation failure can never prevent
   * the operator from seeing the already-resolved target version. Callers
   * must treat `undefined` as "no diff available", not as an error.
   *
   * @param targetVersionId - The rollback target's `versionId`, as resolved
   *   by {@link resolveRollbackTarget}.
   * @returns A {@link DeploymentConfigDiff} comparing the target version
   *   against the current head, or `undefined` if it could not be computed.
   */
  async computeRollbackDiff(targetVersionId: string): Promise<DeploymentConfigDiff | undefined> {
    logger.debug('PulumiService.computeRollbackDiff: computing rollback diff', { targetVersionId });
    try {
      const key = CONFIGURATION_OBJECT_KEY;
      const remoteFileStore = this.getRemoteFileStore();
      const [historic, head] = await Promise.all([
        remoteFileStore.getVersion(key, targetVersionId),
        remoteFileStore.get(key),
      ]);
      if (!historic || !head) {
        logger.warn('PulumiService.computeRollbackDiff: target or current configuration bytes unavailable', {
          targetVersionId,
          historicFound: !!historic,
          headFound: !!head,
        });
        return undefined;
      }

      const target = PulumiService.parseDeploymentConfigOrUndefined(new TextDecoder().decode(historic.body));
      const current = PulumiService.parseDeploymentConfigOrUndefined(new TextDecoder().decode(head.body));
      if (!target || !current) {
        return undefined;
      }

      return diffDeploymentConfig(target, current);
    } catch (err) {
      logger.warn('PulumiService.computeRollbackDiff: best-effort diff computation failed — omitting diff', {
        targetVersionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * Confirms a rollback of `applyRunId`: re-resolves the rollback target
   * (catching a late expiry before any write), restores its exact historic
   * bytes as the configuration object's new head version, then runs a plan
   * against that restored version — tagged `rolledBackFrom: applyRunId` —
   * reusing {@link previewCore} directly rather than duplicating its logic.
   *
   * ## Why restore and plan are one guarded unit
   *
   * A naive implementation could write the restore and return, trusting the
   * caller to invoke `preview()` next. Nothing would hold any lock across
   * those two calls — a `destroy()` (or a second, racing rollback)
   * could interleave between them, and if the caller's follow-up preview
   * call simply never happened (a crashed controller, a dropped IPC
   * response), the restored configuration would be left as the head with no
   * plan describing it, silently. The `iac-rollback` spec requires closing
   * exactly this gap: "The restore and the
   * plan's creation SHALL be performed as one guarded unit... so no other
   * operation can interleave between the two." This method is that guarded
   * unit — restore and plan-record persistence both happen inside a single
   * `try`/`finally` that owns {@link operationInFlight} for its entire
   * duration.
   *
   * ## Lock acquisition
   *
   * {@link operationInFlight} is set to `'rollback'` — a state DISTINCT from
   * `'preview'` (see that field's own doc comment) — before
   * {@link resolveRollbackTarget} is even re-invoked, i.e. before ANY work
   * this method does, not merely before the restore write. This is stronger
   * than the spec's literal "acquired before the restore is written"
   * requirement, deliberately: holding the lock across the re-resolve too
   * closes a race the spec's wording alone wouldn't — a concurrent
   * `preview`/`up`/`destroy` starting between the re-resolve and the write
   * could otherwise still change the configuration object's head in that
   * window. The lock is released in this method's own `finally`, covering
   * every exit path (a pre-write rejection, a post-write compensating
   * failure, a clean success, or a force-closed generator) — mirroring
   * `apply`/`destroy`'s established lock-releasing `finally` discipline.
   *
   * This method never calls `RunLockService.createRun()` — the DURABLE,
   * cross-process lock `apply`/`destroy` take. Neither does the
   * {@link previewCore} call this method delegates into (see `preview`'s own
   * TSDoc, "Does preview take the DIY backend lock?": no, the underlying
   * `stack.preview()` call never does). The "shared operation lock" the
   * governing spec requires is this file's existing IN-PROCESS
   * {@link operationInFlight} guard, not the durable one — consistent with
   * every other plan-shaped operation in this class.
   *
   * ## Why `previewCore`, not `preview()`
   *
   * `preview()` itself checks and sets {@link operationInFlight} — calling
   * it here would either throw immediately (seeing the `'rollback'` state
   * this method already set) or, if that guard were somehow bypassed, race
   * this method's own clear of the field in its `finally`. {@link previewCore}
   * is `preview()`'s method body with that concern removed entirely (task
   * 7.6's refactor — see its own TSDoc), letting this method reuse the
   * identical streaming/hashing/persistence/cancellation logic while
   * keeping sole ownership of the lock for the combined restore+plan unit.
   *
   * ## Compensating semantics: record-and-surface, not restore-previous-head
   *
   * Once {@link DeploymentConfigRestorer.restoreRawConfig} has resolved successfully,
   * anything that fails afterward — a missing `versionId` in its result, or
   * {@link previewCore} itself throwing (engine provisioning, network, or
   * local/cloud run-record persistence — the spec's own enumerated causes)
   * — is caught by the inner `try`/`catch` below and handled by:
   *
   * 1. `ElectronStoreService.recordOrphanedRollback` — a durable marker
   *    (survives an app restart) naming `applyRunId`, the now-orphaned
   *    `restoredVersionId`, and the underlying failure, so a controller/UI
   *    can discover and present it even if the operator
   *    closed the app before seeing this call's own error.
   * 2. Throwing {@link PulumiRollbackPlanFailedError} — surfacing the SAME
   *    failure synchronously to whatever is driving this generator, so a
   *    caller doesn't have to separately poll the store to learn the
   *    rollback didn't fully complete.
   *
   * The spec also permits restoring the PREVIOUS head as a second
   * corrective write, but that write can ALSO fail (a transient S3/network
   * issue is exactly the kind of failure already in play here), compounding
   * the problem into a state that's not just orphaned but has an unverified
   * "undo" attempt layered on top. Record-and-surface never risks a second
   * failure: it only ever WRITES a plain-object marker to a local file
   * ({@link ElectronStoreService}, already proven reliable elsewhere in this
   * class — `recordPulumiLockAttempt`'s identical pattern is never wrapped
   * in its own try/catch either) and throws, both effectively infallible
   * compared to a second remote write. "Surfaces it to the operator"
   * concretely means exactly these two things: the durable store marker
   * plus the thrown, richly-typed error — no polling mechanism, no IPC
   * channel, no auto-retry.
   *
   * Failures BEFORE `restoreRawConfig` resolves (a stale/missing rollback
   * target, a missing historic version, or `restoreRawConfig` itself
   * throwing) are NOT treated as compensating-semantics cases — nothing was
   * written in any of those cases, so the current head is untouched and the
   * pre-existing typed errors ({@link RollbackTargetNotFoundError} etc.)
   * propagate unwrapped, exactly like {@link resolveRollbackTarget}'s own
   * contract.
   *
   * ## Return shape: a generator, mirroring `preview()`
   *
   * `confirmRollback`'s ultimate effect — "restore, then start a plan
   * against the restored version" — produces a plan run that streams output
   * exactly like an ordinary `preview()` call (log pane, chunks,
   * `changeSummary`). Returning the same `AsyncGenerator` shape `preview()`
   * itself returns (rather than a `Promise` that drives a preview to
   * completion internally and discards the stream) lets a caller watch that
   * queued plan's output directly, the same way it would for a plan started
   * via `preview()` — there is no reason a rollback's plan should be a
   * second-class, unobservable operation compared to an ordinary one, and
   * `preview()`'s own pre-existing `rolledBackFrom` parameter already
   * assumed a generator-shaped caller.
   *
   * @param applyRunId - The `runId` of the `apply` run to roll back.
   * @param signal - Optional cancellation signal, forwarded to
   *   {@link previewCore} — see `preview()`'s own "Cancellation" doc section.
   * @param preMintedRunId - Optional caller-minted `runId` for the resulting
   *   plan run (mirrors `preview()`'s identically-named parameter) — must
   *   match {@link RUN_ID_PATTERN}, validated here before this method
   *   touches {@link operationInFlight}, mirroring `preview()`/`apply()`/
   *   `destroy()`'s identical top-of-function pattern.
   * @throws A descriptive `Error` if another `preview`/`up`/`destroy`/
   *   rollback is already in flight on this instance, or if `preMintedRunId`
   *   doesn't match {@link RUN_ID_PATTERN}.
   * @throws Same as {@link resolveRollbackTarget} — thrown before any write.
   * @throws {@link RollbackVersionMissingError} (reused) if the resolved
   *   version's bytes can no longer be read — the write never happens in
   *   that case either.
   * @throws {@link PulumiRollbackPlanFailedError} if the restore succeeded
   *   but the follow-up plan could not be completed — see "Compensating
   *   semantics" above.
   */
  async *confirmRollback(
    applyRunId: string,
    signal?: AbortSignal,
    preMintedRunId?: string,
  ): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult | undefined> {
    logger.debug('PulumiService.confirmRollback: confirming rollback', { applyRunId });
    if (this.operationInFlight) {
      throw new Error(
        `PulumiService.confirmRollback() cannot run while ${this.operationInFlight}() is already ` +
          'running; wait for it to finish before calling confirmRollback() again.',
      );
    }
    this.assertStackInitNotInFlight('confirmRollback');
    if (preMintedRunId !== undefined) {
      PulumiService.assertValidRunId(preMintedRunId);
    }
    this.operationInFlight = 'rollback';
    try {
      // Re-resolved here (not trusting a caller-cached result from an
      // earlier confirmation-dialog call to resolveRollbackTarget) so a
      // version that expired in the window between the two calls is still
      // caught before anything is written — see this method's TSDoc,
      // "Lock acquisition", for why this happens AFTER the lock is already
      // held rather than before.
      const target = await this.resolveRollbackTarget(applyRunId);
      const key = CONFIGURATION_OBJECT_KEY;
      const historic = await this.getRemoteFileStore().getVersion(key, target.versionId);
      if (!historic) {
        throw new RollbackVersionMissingError(target.versionId);
      }
      const rawConfig = new TextDecoder().decode(historic.body);

      // The restore write itself. Nothing above this line needs
      // compensating semantics on failure — the head is still whatever it
      // was before this call started. Everything below, once this resolves,
      // is inside the compensating-semantics boundary — see this method's
      // TSDoc, "Compensating semantics".
      const restored = await this.getDeploymentConfigService().restoreRawConfig(rawConfig);

      try {
        if (!restored.versionId) {
          throw new Error(
            'PulumiService.confirmRollback: DeploymentConfigService.restoreRawConfig did not return a versionId — ' +
              'is the configuration bucket versioned?',
          );
        }
        // Delegates into preview()'s core body directly — see this method's
        // TSDoc, "Why previewCore, not preview()". Passing `restored.versionId`
        // as the expected configVersionId means previewCore's own staleness
        // check doubles as this method's own guard against the head having
        // somehow changed out from under the lock this method is holding.
        return yield* this.previewCore(restored.versionId, signal, preMintedRunId, applyRunId);
      } catch (err) {
        const restoredVersionId = restored.versionId ?? target.versionId;
        logger.error('PulumiService.confirmRollback: rollback plan failed after the configuration was restored', {
          applyRunId,
          restoredVersionId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.store.recordOrphanedRollback({
          applyRunId,
          restoredVersionId,
          failedAt: new Date().toISOString(),
          failureMessage: err instanceof Error ? err.message : String(err),
        });
        throw new PulumiRollbackPlanFailedError(applyRunId, restoredVersionId, err);
      }
    } finally {
      this.operationInFlight = null;
    }
  }

  /**
   * Clears an UNRECOGNIZED Pulumi backend lock
   * after an operator has explicitly confirmed they believe it's genuinely
   * stale — the human-confirmed counterpart to `apply()`/`destroy()`'s own
   * internal auto-reclaim of a *provable* own-orphan lock (see
   * `PulumiLockRecovery.ts`, `classifyStackLockConflict`'s
   * `'reclaimable-own-orphan'` branch, wired into `apply()`/`destroy()`
   * already). This method makes NO attempt to classify or prove anything
   * about the lock it clears — by the time a caller reaches this method,
   * `PulumiUnrecognizedLockError` has already told them the lock could NOT be
   * proven this installation's own, and the confirmation UI (`iac.page.tsx`'s
   * stale-lock banner) has already required an explicit, separately-worded
   * confirmation specifically because clearing a genuinely still-active lock
   * elsewhere would risk corrupting a real concurrent deployment. This method
   * is the mechanical "do it" step once that human judgment call has already
   * been made — it does not, and cannot, re-derive or re-check the judgment
   * itself.
   *
   * ## Why refuse under `operationInFlight` and `stackInitInFlight`
   *
   * If THIS app instance already has `preview`/`up`/`destroy`/`rollback`
   * running, the backend lock the operator is looking at is (almost
   * certainly) the one that same in-flight operation is correctly holding —
   * it is not stale, and clearing it out from under a legitimately-running
   * operation would let a second, uncoordinated `pulumi` invocation touch the
   * same state concurrently, exactly the corruption this whole recovery flow
   * exists to avoid causing. Reuses {@link PulumiOperationInFlightError}
   * rather than introducing a new error class — the shape
   * (`inFlight: 'preview' | 'up' | 'destroy' | 'rollback'`) and meaning
   * ("cannot run this operation while X is already running") are identical
   * to every other caller of that class in this file; a bespoke class here
   * would only duplicate it for no behavioral gain.
   *
   * The identical reasoning applies to `initializeStack()`, which takes the
   * SAME durable backend lock around its own `stack.refresh()` call but
   * never touches {@link operationInFlight} (see {@link stackInitInFlight}'s
   * own doc comment) — without a separate check, an operator hitting
   * `PulumiUnrecognizedLockError` while a legitimate stack-init refresh was
   * still in flight could confirm-clear that lock and cancel their own live,
   * correct work. Checked via {@link assertStackInitNotInFlight} immediately
   * after the `operationInFlight` check above.
   *
   * This is a synchronous, top-of-function check only — unlike `apply()`/
   * `destroy()`, this method never itself sets {@link operationInFlight}
   * (there is no multi-step gate here for a second call to race against), so
   * a narrow window still exists where a fresh `preview`/`up`/`destroy`/
   * `initializeStack` legitimately starts and re-takes the lock between this
   * check and `stack.cancel()` actually running. That risk is inherent to
   * clearing a lock at all — including the manual "delete the S3 lock object
   * by hand" recovery this feature replaces — and is not something a single
   * synchronous flag check can fully close; the meaningful safety property
   * this method (and the confirmation dialog in front of it) provides is
   * refusing the *common* case (an operation already running in THIS
   * instance), not eliminating every theoretically possible race with some
   * *other* instance or CLI invocation.
   *
   * ## No-op inline program
   *
   * Mirrors `destroy()`'s "No-op inline program" decision exactly (see that
   * method's own TSDoc) — an `async () => ({})` program passed to
   * {@link PulumiWorkspaceService.getOrCreateStack} only stands up the
   * Automation API's gRPC handshake; `stack.cancel()` never runs the program
   * or reads the deployment configuration object, so this method doesn't
   * either. That also means clearing a lock never depends on the current
   * configuration object being present or well-formed — operationally
   * important, since a lock left behind by a crashed run is exactly the kind
   * of situation where the configuration object might also be in a
   * questionable state.
   *
   * ## Does not retry
   *
   * This method only clears the lock — it never re-attempts the
   * plan/apply/destroy that originally hit the conflict. The operator
   * retries by resubmitting through the normal plan/apply/destroy button
   * afterward — a fresh, separate operator
   * action, not an automatic one-more-attempt inside this call the way
   * `apply()`/`destroy()`'s own reclaim-and-retry path works.
   *
   * @param token - The single-use confirmation token minted by
   *   {@link mintLockClearConfirmationToken} — validated by
   *   {@link assertFreshLockClearConfirmation} before anything else runs.
   * @throws {@link PulumiOperationInFlightError} if another `preview`/`up`/
   *   `destroy`/`rollback` is already running against this shared workspace.
   * @throws A plain `Error` (via {@link assertStackInitNotInFlight}) if
   *   `initializeStack()` is currently running against this shared
   *   workspace: this method's whole purpose is clearing a lock an operator
   *   has judged stale, and a genuinely in-progress `initializeStack()`
   *   refresh is never that, exactly like a genuinely in-progress
   *   `preview`/`apply`/`destroy` isn't.
   * @throws A descriptive `Error` if the state bucket/region isn't configured
   *   yet, or no Pulumi stack has ever been created for this installation —
   *   mirrors `destroy()`'s identical config-presence checks.
   * @throws {@link LockClearNotConfirmedError} if `token` is missing, wrong,
   *   expired, or bound to a different target.
   * @throws {@link PulumiLockClearError} if `stack.cancel()` itself fails —
   *   the lock is still standing afterward exactly as it was before the
   *   attempt; never swallowed silently.
   */
  async clearStaleLock(token: string): Promise<void> {
    logger.debug('PulumiService.clearStaleLock: clearing confirmed-stale pulumi backend lock');
    if (this.operationInFlight) {
      throw new PulumiOperationInFlightError(this.operationInFlight);
    }
    this.assertStackInitNotInFlight('clearStaleLock');

    const stateBucket = this.store.get('bootstrap')?.stateBucket;
    const stateBucketRegion = this.store.get('aws')?.region;
    if (!stateBucket || !stateBucketRegion) {
      throw new Error(
        'Cannot clear the Pulumi backend lock: the state bucket / AWS region has not been configured yet. ' +
          'Complete the bootstrap step first.',
      );
    }
    const stackExists = this.store.get('pulumi')?.passphrase !== undefined;
    if (!stackExists) {
      throw new Error(
        'Cannot clear the Pulumi backend lock: no Pulumi stack has ever been created for this installation ' +
          '(no secrets passphrase on record) — nothing to clear.',
      );
    }

    this.assertFreshLockClearConfirmation(token, stateBucket, stateBucketRegion);

    const stack = await this.workspace.getOrCreateStack({
      // See this method's TSDoc, "No-op inline program" — mirrors destroy()'s
      // identical reasoning for not depending on the deployment configuration
      // object.
      program: async () => ({}),
      stateBucket,
      stateBucketRegion,
      backendReady: true,
    });

    try {
      await stack.cancel();
    } catch (err) {
      logger.error('PulumiService.clearStaleLock: stack.cancel() failed', {
        stackName: PULUMI_STACK_NAME,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new PulumiLockClearError(err);
    }

    logger.warn('pulumi backend lock cleared by explicit operator confirmation (unrecognized-lock recovery)', {
      stackName: PULUMI_STACK_NAME,
      // Reuses the same `os.userInfo().username` accessor `destroy()` already
      // logs with for accountability — this is a
      // state-mutating recovery action; the log line naming only the stack,
      // not who cleared it, would be a weaker forensic trail than the one
      // `destroy()` already leaves.
      initiator: PulumiService.resolveInitiator(),
    });
  }

  /**
   * Throws {@link DestroyNotConfirmedError} unless `token` matches the most
   * recently minted, not-yet-expired, not-yet-consumed confirmation token AND
   * `currentStateBucket`/`currentStateBucketRegion` match the target the
   * token was minted against — see {@link PulumiPendingDestroyConfirmation}'s
   * doc comment for the full target-binding design. On success, consumes the
   * token (clears {@link pendingDestroyConfirmation}) so it can never be
   * replayed against a second `destroy()` call.
   *
   * Fully synchronous — no `await` anywhere in this method — which is what
   * makes token consumption atomic: two "concurrent" calls (in the
   * single-threaded JS sense — interleaved via Promise scheduling, never
   * truly parallel) that both reach this method are strictly ordered by
   * JS's own run-to-completion semantics, exactly like
   * `RunService.createRun`'s in-memory compare-and-set. Whichever call's
   * synchronous body runs first observes {@link pendingDestroyConfirmation}
   * as still set and clears it; the second, whenever it runs, observes it
   * already `null` (or already superseded by a newer mint) and throws. The
   * two extra equality comparisons for target binding are added before the
   * same single synchronous clear, so they don't introduce any `await`
   * either.
   *
   * Does NOT clear {@link pendingDestroyConfirmation} on failure (wrong
   * token, expired, wrong target) — a genuinely correct, still-valid token remains usable by a
   * subsequent call even if an earlier call supplied a wrong one first (e.g.
   * a stale IPC retry racing a fresh one).
   *
   * Logs a `logger.warn` naming the SPECIFIC rejection reason (no token ever
   * minted, token mismatch, expired, or target mismatch) before throwing on
   * every failure branch — this gate is the ONLY thing
   * standing between an accidental invocation and destroying all managed
   * infrastructure, and `AuditService` only records ACCEPTED submissions
   * (the `iac-destroy-flow` spec's audit requirement is scoped to those), so
   * a rejected destroy attempt would otherwise leave no forensic record at
   * all beyond the bare `DestroyNotConfirmedError` message reaching
   * whichever caller invoked this method. This is especially load-bearing
   * for the target-mismatch case (a Reconfigure completed between mint and
   * confirm): without a distinguishing log line, that rejection is
   * indistinguishable after the fact from an operator simply re-submitting
   * a stale token.
   */
  private assertFreshDestroyConfirmation(
    token: string,
    currentStateBucket: string | undefined,
    currentStateBucketRegion: string | undefined,
  ): void {
    const pending = this.pendingDestroyConfirmation;
    if (!pending) {
      logger.warn('pulumi destroy confirmation rejected: no confirmation token has ever been minted');
      throw new DestroyNotConfirmedError();
    }
    if (pending.token !== token) {
      logger.warn('pulumi destroy confirmation rejected: supplied token does not match the most recently minted token');
      throw new DestroyNotConfirmedError();
    }
    if (Date.now() > pending.expiresAt) {
      logger.warn('pulumi destroy confirmation rejected: the most recently minted token has expired', {
        expiresAt: pending.expiresAt,
      });
      throw new DestroyNotConfirmedError();
    }
    if (
      pending.stateBucket !== currentStateBucket ||
      pending.stateBucketRegion !== currentStateBucketRegion ||
      pending.stackName !== PULUMI_STACK_NAME ||
      pending.projectName !== PULUMI_PROJECT_NAME
    ) {
      logger.warn(
        'pulumi destroy confirmation rejected: token is bound to a different target — the state bucket/region ' +
          '(or project/stack) changed since the token was minted, most likely via a Reconfigure completing in ' +
          'between',
        {
          mintedStateBucket: pending.stateBucket,
          currentStateBucket,
          mintedStateBucketRegion: pending.stateBucketRegion,
          currentStateBucketRegion,
        },
      );
      throw new DestroyNotConfirmedError();
    }
    this.pendingDestroyConfirmation = null;
  }

  /**
   * Throws {@link LockClearNotConfirmedError} unless `token` matches the most
   * recently minted, not-yet-expired, not-yet-consumed lock-clear
   * confirmation token AND `currentStateBucket`/`currentStateBucketRegion`
   * match the target the token was minted against — mirrors
   * {@link assertFreshDestroyConfirmation} exactly. Fully synchronous, so
   * token consumption is atomic the same way that method's is. Does NOT
   * clear {@link pendingLockClearConfirmation} on failure — a still-valid
   * token remains usable by a subsequent call.
   */
  private assertFreshLockClearConfirmation(
    token: string,
    currentStateBucket: string | undefined,
    currentStateBucketRegion: string | undefined,
  ): void {
    const pending = this.pendingLockClearConfirmation;
    if (!pending) {
      logger.warn('pulumi lock clear confirmation rejected: no confirmation token has ever been minted');
      throw new LockClearNotConfirmedError();
    }
    if (pending.token !== token) {
      logger.warn(
        'pulumi lock clear confirmation rejected: supplied token does not match the most recently minted token',
      );
      throw new LockClearNotConfirmedError();
    }
    if (Date.now() > pending.expiresAt) {
      logger.warn('pulumi lock clear confirmation rejected: the most recently minted token has expired', {
        expiresAt: pending.expiresAt,
      });
      throw new LockClearNotConfirmedError();
    }
    if (
      pending.stateBucket !== currentStateBucket ||
      pending.stateBucketRegion !== currentStateBucketRegion ||
      pending.stackName !== PULUMI_STACK_NAME ||
      pending.projectName !== PULUMI_PROJECT_NAME
    ) {
      logger.warn(
        'pulumi lock clear confirmation rejected: token is bound to a different target — the state bucket/region ' +
          '(or project/stack) changed since the token was minted, most likely via a Reconfigure completing in ' +
          'between',
        {
          mintedStateBucket: pending.stateBucket,
          currentStateBucket,
          mintedStateBucketRegion: pending.stateBucketRegion,
          currentStateBucketRegion,
        },
      );
      throw new LockClearNotConfirmedError();
    }
    this.pendingLockClearConfirmation = null;
  }

  /**
   * Resolves the OS-level identity recorded as {@link RunLock.initiator} for
   * an apply — a plain `os.userInfo().username` lookup rather than
   * depending on a controller (none exists yet for Pulumi operations, and
   * {@link apply} is self-contained — see {@link getConfigurationBucket}'s
   * doc comment for the established precedent of duplicating a small
   * OS-level accessor rather than adding a dependency this class has no
   * other reason for).
   */
  private static resolveInitiator(): string {
    return userInfo().username;
  }

  /**
   * Reduces a {@link PulumiApplyOutcome} to the minimal
   * {@link PulumiOperationOutcome} shape {@link PulumiRunPersistError}
   * carries — mirrors {@link toOperationOutcome} exactly, for `apply`'s own
   * outcome type.
   */
  private static toApplyOperationOutcome(outcome: PulumiApplyOutcome): PulumiOperationOutcome {
    switch (outcome.kind) {
      case 'success':
        return { kind: 'success' };
      case 'aborted':
        return { kind: 'aborted' };
      case 'failed':
        return { kind: 'failed', error: outcome.error };
    }
  }

  /**
   * Reduces a {@link PulumiDestroyOutcome} to the minimal
   * {@link PulumiOperationOutcome} shape {@link PulumiRunPersistError}
   * carries — mirrors {@link toOperationOutcome}/{@link toApplyOperationOutcome}
   * exactly, for `destroy`'s own outcome type.
   */
  private static toDestroyOperationOutcome(outcome: PulumiDestroyOutcome): PulumiOperationOutcome {
    switch (outcome.kind) {
      case 'success':
        return { kind: 'success' };
      case 'aborted':
        return { kind: 'aborted' };
      case 'failed':
        return { kind: 'failed', error: outcome.error };
    }
  }

  /**
   * Reads and parses the persisted plan artifact's top-level `manifest.version`
   * field (e.g. `"v3.255.0"`) and strips a leading `v`, if present, before
   * returning — see {@link preview}'s TSDoc, "Engine-version stamping", for
   * why normalizing here (once, at write time) rather than leaving the
   * caller-facing format mismatch against `PulumiEngineService.getResolvedVersion()`'s
   * own un-prefixed shape for `apply`'s comparison to rediscover.
   */
  private readEngineVersionFromPlanArtifact(artifactPath: string): string {
    const parsed = JSON.parse(readFileSync(artifactPath, 'utf8')) as { manifest?: { version?: unknown } };
    const version = parsed.manifest?.version;
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error(`Pulumi plan artifact "${artifactPath}" has no readable "manifest.version" field.`);
    }
    return version.replace(/^v/, '');
  }

  /**
   * Computes the SHA-256 hex digest covering both the persisted plan
   * artifact's bytes AND the deployment-config object's S3 version id the
   * plan ran against (the full staleness-refusal logic that re-derives and
   * compares this hash lives in {@link apply}).
   *
   * ## Exact algorithm
   *
   * `sha256(artifactBytes ++ utf8(configVersionId))` — the raw bytes of the
   * plan artifact at `artifactPath`, followed immediately (byte-for-byte
   * concatenation, no separator) by the UTF-8 encoding of `configVersionId`,
   * fed through a single SHA-256 digest pass:
   *
   * ```ts
   * createHash('sha256')
   *   .update(Buffer.concat([readFileSync(artifactPath), Buffer.from(configVersionId, 'utf8')]))
   *   .digest('hex')
   * ```
   *
   * A concatenation (rather than a hash-of-hashes, e.g.
   * `sha256(sha256(artifact) + sha256(configVersionId))`) was chosen because
   * it needs no second hash primitive and is trivially re-derivable by
   * `apply`'s apply-time verification: read the artifact bytes off disk, append
   * the UTF-8 bytes of the config version id the run record has on file,
   * hash once — exactly what this method does. No separator byte is
   * inserted between the two parts; this is safe (does not introduce an
   * ambiguity where two different `(artifact, versionId)` pairs could
   * collide on the same concatenated input) because neither input is
   * attacker- or operator-influenced in a way that matters here: the
   * artifact is a JSON file this app itself just wrote, and `configVersionId`
   * is an opaque S3-assigned version id — there is no scenario where varying
   * the split point between the two produces a meaningful second
   * interpretation of the same bytes.
   *
   * The engine version does NOT participate in this hash — see
   * {@link preview}'s TSDoc, "Engine-version stamping", for why it's a
   * separate stored field instead.
   *
   * Public (rather than `private`) so `apply`'s gate step 6
   * apply-time re-verification can re-read and re-hash the on-disk artifact
   * directly, rather than trusting the stored `planHash` alone to prove the
   * artifact on disk hasn't been swapped or tampered with.
   *
   * @throws Whatever `readFileSync` throws if `artifactPath` can't be read —
   *   wrapped by {@link preview} into {@link PulumiPlanHashError}.
   */
  computePlanHash(artifactPath: string, configVersionId: string): string {
    return createHash('sha256')
      .update(Buffer.concat([readFileSync(artifactPath), Buffer.from(configVersionId, 'utf8')]))
      .digest('hex');
  }

  /**
   * Reads and parses the persisted {@link PulumiRunRecord} for `runId` from
   * `<runsDir>/<runId>/run.json` (see {@link writeRunRecord}) — the
   * run-detail counterpart to {@link streamRunOutput}'s output feed. Returns
   * `null` (rather than throwing) when no `run.json` exists for `runId` yet
   * — e.g. the run is still in flight and hasn't settled, or `runId`
   * doesn't exist at all. Callers that need to distinguish "still running"
   * from "unknown run" should also consult `RunService.getCurrentLock()`
   * (the durable apply lock) or attempt a live {@link streamRunOutput}
   * subscription — exactly like `IacRunsController.get()` already does.
   *
   * @throws A plain `Error` synchronously if `runId` isn't a bare path
   *   segment matching {@link RUN_ID_PATTERN} (via {@link assertValidRunId}).
   */
  readRunRecord(runId: string): PulumiRunRecord | null {
    PulumiService.assertValidRunId(runId);
    const recordPath = join(this.getRunsDir(), runId, 'run.json');
    if (!existsSync(recordPath)) {
      return null;
    }
    return JSON.parse(readFileSync(recordPath, 'utf8')) as PulumiRunRecord;
  }

  /**
   * Reports whether {@link previewCore}'s persisted plan artifact exists on
   * disk for `runId` — `<runsDir>/<runId>/<runId>.plan.json`, the exact path
   * {@link apply}'s gate step 6 re-hashes (see that method's own "Gate
   * structure" doc section; this is Pulumi's `--save-plan` JSON artifact).
   * Used by `IacRunsController.get()` to distinguish a `plan` record that's
   * still applyable from one whose artifact has since been cleaned up.
   *
   * @throws A plain `Error` synchronously if `runId` isn't a bare path
   *   segment matching {@link RUN_ID_PATTERN} (via {@link assertValidRunId}).
   */
  hasPlanArtifact(runId: string): boolean {
    PulumiService.assertValidRunId(runId);
    return existsSync(join(this.getRunsDir(), runId, `${runId}.plan.json`));
  }

  /**
   * Reduces a {@link PulumiPreviewOutcome} (which carries the full
   * {@link PulumiPreviewResult} on success) to the minimal
   * {@link PulumiOperationOutcome} shape {@link PulumiRunPersistError}
   * carries — this method exists because `PulumiPreviewOutcome`
   * has richer per-operation shapes than the single cross-operation
   * `PulumiOperationOutcome` union `PulumiRunPersistError` is deliberately
   * kept to — see that type's own doc comment for why.
   */
  private static toOperationOutcome(outcome: PulumiPreviewOutcome): PulumiOperationOutcome {
    switch (outcome.kind) {
      case 'success':
        return { kind: 'success' };
      case 'aborted':
        return { kind: 'aborted' };
      case 'failed':
        return { kind: 'failed', error: outcome.error };
    }
  }

  /**
   * Registers a fresh, empty {@link PulumiActiveRunBuffer} for `runId`.
   */
  private beginActiveRun(runId: string): void {
    this.activeRuns.set(runId, {
      chunks: [],
      listeners: new Set(),
      settled: false,
      settledListeners: new Set(),
    });
  }

  /**
   * Appends `chunk` to `runId`'s {@link PulumiActiveRunBuffer} (a no-op if
   * no buffer is registered) and synchronously notifies every subscriber.
   */
  private recordRunChunk(runId: string, chunk: PulumiRunChunk): void {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.chunks.push(chunk);
    for (const listener of active.listeners) {
      listener(chunk);
    }
  }

  /**
   * Marks `runId`'s {@link PulumiActiveRunBuffer} as settled and removes it
   * from {@link activeRuns}.
   */
  private endActiveRun(runId: string): void {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.settled = true;
    for (const listener of active.settledListeners) {
      listener();
    }
    active.settledListeners.clear();
    this.activeRuns.delete(runId);
  }

  /**
   * Returns the single filesystem path every operation ({@link preview},
   * and later `up`/`destroy`) writes its captured stdout/stderr transcript
   * to — `<runsDir>/<runId>/pulumi.log`.
   */
  private getRunLogPath(runId: string): string {
    return join(this.getRunsDir(), runId, 'pulumi.log');
  }

  /**
   * Writes `lines` to `<runsDir>/<runId>/pulumi.log` in a single
   * `writeFileSync` call. Logs a WARN and swallows any failure — never
   * throws.
   */
  private writeRunLog(runId: string, lines: string[]): void {
    const runDir = join(this.getRunsDir(), runId);
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(this.getRunLogPath(runId), lines.map((line) => `${line}\n`).join(''));
    } catch (err) {
      logger.warn('failed to write pulumi run log', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Replays a finished run's persisted `pulumi.log` line-by-line as
   * `stdout`-tagged {@link PulumiRunChunk} values — the fallback path
   * {@link streamRunOutput} takes once `runId` is no longer in flight.
   *
   * @throws A plain `Error` when no `pulumi.log` exists for `runId`.
   */
  private async *replayRunLog(runId: string): AsyncGenerator<PulumiRunChunk, void> {
    const logPath = this.getRunLogPath(runId);
    if (!existsSync(logPath)) {
      throw new Error(`PulumiService.streamRunOutput(): no run found for runId "${runId}".`);
    }
    const contents = readFileSync(logPath, 'utf8');
    const lines = contents.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    for (const line of lines) {
      yield { stream: 'stdout', line };
    }
  }

  /**
   * Streams a run's output — live if `runId` is still in flight (replaying
   * every chunk buffered so far, then following live chunks until the run
   * settles), or by replaying the persisted `pulumi.log` if it's already
   * finished.
   *
   * @throws A plain `Error` (via {@link replayRunLog}) if `runId` is neither
   *   currently in flight nor has a persisted log on disk.
   */
  async *streamRunOutput(runId: string, signal?: AbortSignal): AsyncGenerator<PulumiRunChunk, void> {
    const active = this.activeRuns.get(runId);
    if (!active) {
      yield* this.replayRunLog(runId);
      return;
    }

    for (const chunk of active.chunks) {
      yield chunk;
    }
    if (active.settled) {
      return;
    }

    const queue: PulumiRunChunk[] = [];
    let wake: (() => void) | null = null;
    let done = false;

    const onChunk = (chunk: PulumiRunChunk): void => {
      queue.push(chunk);
      wake?.();
      wake = null;
    };
    const onSettled = (): void => {
      done = true;
      wake?.();
      wake = null;
    };
    const onAbort = (): void => {
      done = true;
      wake?.();
      wake = null;
    };

    active.listeners.add(onChunk);
    active.settledListeners.add(onSettled);
    signal?.addEventListener('abort', onAbort);

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done || signal?.aborted) {
          return;
        }
        await new Promise<void>((resolveWait) => {
          wake = resolveWait;
        });
      }
    } finally {
      active.listeners.delete(onChunk);
      active.settledListeners.delete(onSettled);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Writes a {@link PulumiRunRecord} to `<runsDir>/<runId>/run.json` once a
   * `preview`/`up`/`destroy` run has settled, including the
   * `changeSummary`/`engineVersion` parameters and `partialApply` (see
   * {@link PulumiRunRecord.partialApply}'s doc comment).
   *
   * @throws A descriptive `Error` (wrapping the underlying filesystem error
   *   as `cause`) if `mkdirSync`/`writeFileSync` fails.
   */
  private writeRunRecord(
    runId: string,
    kind: RunKind,
    startedAt: string,
    completedAt: string,
    exitCode: number | null,
    configVersionId: string | undefined,
    planHash: string | undefined = undefined,
    rolledBackFrom: string | undefined = undefined,
    changeSummary: ChangeSummary | undefined = undefined,
    engineVersion: string | undefined = undefined,
    partialApply: boolean | undefined = undefined,
  ): void {
    PulumiService.assertValidRunId(runId);
    const runDir = join(this.getRunsDir(), runId);
    const record: PulumiRunRecord = {
      runId,
      kind,
      startedAt,
      completedAt,
      exitCode,
      configVersionId,
      planHash,
      rolledBackFrom,
      changeSummary,
      engineVersion,
      partialApply,
    };
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run.json'), JSON.stringify(record, null, 2));
    } catch (err) {
      logger.error('PulumiService.writeRunRecord: failed to write run record to disk', {
        runId,
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(
        `Failed to write pulumi run record to "${join(runDir, 'run.json')}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  /**
   * Persists the cloud-agnostic run-history counterpart of
   * {@link writeRunRecord}'s local `run.json` write, via
   * {@link RunRecordPersister} (the real `RunRecordService` singleton,
   * resolved lazily via {@link getRunRecordPersister}). Best-effort: never
   * throws, logged and swallowed on failure. As a side
   * effect (via `RunRecordService.persist`'s own `finally`), this also
   * releases the durable apply lock {@link apply}'s gate step 8 acquired for
   * `runId` — see that method's TSDoc for why no separate release call is
   * needed here.
   */
  private async persistRunRecord(
    runId: string,
    kind: RunKind,
    startedAt: string,
    completedAt: string,
    exitCode: number | null,
    configVersionId: string | undefined,
    planHash: string | undefined = undefined,
    rolledBackFrom: string | undefined = undefined,
    changeSummary: ChangeSummary | undefined = undefined,
    engineVersion: string | undefined = undefined,
    partialApply: boolean | undefined = undefined,
  ): Promise<void> {
    try {
      await this.getRunRecordPersister().persist(
        {
          runId,
          kind,
          startedAt,
          completedAt,
          exitCode,
          configVersionId,
          planHash,
          rolledBackFrom,
          changeSummary,
          engineVersion,
          partialApply,
        },
        this.getRunLogPath(runId),
      );
    } catch (err) {
      logger.warn('failed to persist pulumi run record to RunRecordStore', {
        runId,
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Resolve the configured S3 configuration bucket name. Duplicates
   * `ConfigService.getConfigurationBucket()`'s exact resolution order
   * (env override, then `ElectronStoreService`'s `bootstrap.configurationBucket`)
   * rather than injecting `ConfigService` — `PulumiService` cannot depend on
   * `ConfigService` at all: `ConfigService.getStackOutputs()`
   * already depends on `PulumiService`, so the reverse dependency would be a
   * genuine circular import between the two service *class* files (not just
   * a `forwardRef()`-able Nest module cycle — see `RUN_RECORD_PERSISTER`'s
   * doc comment for the same reasoning applied to `RunRecordService`).
   * Duplicating this one small accessor mirrors the established precedent
   * `PulumiWorkspaceService`/`PulumiEngineService` already set for
   * `resolveUserDataPath()` (see either class's own doc comment for the
   * identical rationale).
   */
  private getConfigurationBucket(): string | null {
    const envOverride = process.env['HYVEON_CONFIG_BUCKET'];
    if (envOverride) return envOverride;
    return this.store.get('bootstrap')?.configurationBucket ?? null;
  }

  /**
   * Resolve the absolute path to the directory `preview()` (and later
   * `up`/`destroy`) writes per-run artifacts into —
   * `<runsDir>/<runId>/...`, holding a `.plan.json`/`pulumi.log`/`run.json`
   * trio. Duplicates `ConfigService.getRunsDir()`'s exact resolution
   * order (env override `RUNS_DIR_PATH`, then `<userData>/runs`, then
   * `<tmpdir>/hyveon-runs`) — see {@link getConfigurationBucket}'s doc
   * comment for why this can't inject `ConfigService` to reuse it directly.
   * Resolving to the SAME path `ConfigService.getRunsDir()` does (identical
   * env var, identical `userData` subdirectory) is deliberate, not
   * incidental — a run-history reader keyed only on `runId` must find it
   * regardless of which service resolved the path.
   */
  private getRunsDir(): string {
    const envOverride = process.env['RUNS_DIR_PATH'];
    if (envOverride) return resolve(envOverride);

    const userData = this.resolveUserDataPath();
    if (userData) {
      return join(userData, 'runs');
    }

    return join(tmpdir(), 'hyveon-runs');
  }

  /**
   * Resolve the directory `preview()`'s `createInfraProgram` call passes as
   * `InfraProgramOptions.lambdaBundlesDir` — `<lambdaBundlesDir>/<lambda-dir-name>/dist/handler.cjs`
   * is where `@hyveon/infra`'s `defineLambdas` expects each `@hyveon/lambda-*`
   * package's prebuilt bundle. Mirrors the three-tier resolution
   * `lambdas.ts`'s own "The lambda-bundle path contract" doc comment
   * prescribes for this exact call site (`app/packages/infra/src/lambdas.ts`,
   * search that phrase):
   *
   *  1. `HYVEON_LAMBDA_BUNDLES_DIR` env var — wins when set (dev/CI
   *     convenience, mirrors `getConfigurationBucket`'s `HYVEON_CONFIG_BUCKET`
   *     override).
   *  2. Electron packaged app (`app.isPackaged`) — `<resourcesPath>/lambda`.
   *  3. Dev/test fallback — `<repo>/app/packages/lambda` (each
   *     `@hyveon/lambda-*` package's own directory, one level below its
   *     `dist/handler.cjs`).
   *
   * **Known gap:** per `lambdas.ts`'s own doc
   * comment, the packaged-app branch above is NOT actually satisfiable
   * today — `app/packages/lambda/*\/dist/**` is not in `electron-builder.yml`'s
   * `files:`/`extraResources:` list (only `out/**` and the pinned
   * `node_modules/**` closures are). Making the packaged build actually find
   * a file there is a packaging/build-config change, tracked separately from
   * this method, which resolves the path faithfully either way.
   */
  private getLambdaBundlesDir(): string {
    const envOverride = process.env['HYVEON_LAMBDA_BUNDLES_DIR'];
    if (envOverride) return resolve(envOverride);

    if (this.readIsPackaged()) {
      const resourcesPath = this.readResourcesPath();
      if (resourcesPath) return join(resourcesPath, 'lambda');
    }

    return join(_APP_ROOT, 'packages', 'lambda');
  }

  /**
   * Whether the app is running as a packaged Electron build. Duplicates
   * `ConfigService.readIsPackaged()`'s exact seam — see
   * {@link getConfigurationBucket}'s doc comment for why this can't inject
   * `ConfigService` to reuse it directly.
   */
  private readIsPackaged(): boolean {
    if (!process.versions['electron']) return false;
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { isPackaged: boolean } };
      return electron.app.isPackaged;
    } catch {
      return false;
    }
  }

  /**
   * `process.resourcesPath` when running inside a packaged Electron app, or
   * `undefined` otherwise. Duplicates `ConfigService.readResourcesPath()`'s
   * exact seam — see {@link getConfigurationBucket}'s doc comment for why.
   */
  private readResourcesPath(): string | undefined {
    return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  }

  /**
   * Returns the Electron `userData` directory when running inside an
   * Electron process, or `null` otherwise. Duplicates
   * `PulumiWorkspaceService.resolveUserDataPath()`'s (itself duplicated from
   * `ConfigService.readUserDataPath()`) exact seam — see
   * {@link getConfigurationBucket}'s doc comment for why `PulumiService`
   * can't inject `ConfigService` to reuse this instead.
   */
  private resolveUserDataPath(): string | null {
    if (!process.versions['electron']) return null;
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { getPath(name: string): string } };
      return electron.app.getPath('userData');
    } catch {
      return null;
    }
  }

  /**
   * Throws a descriptive `Error` unless `runId` is a bare path segment
   * matching {@link RUN_ID_PATTERN}.
   */
  private static assertValidRunId(runId: string): void {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error(`PulumiService: runId "${runId}" is not a valid run id.`);
    }
  }
}

/**
 * Thrown by `PulumiService.apply`/`.destroy`'s top-of-function
 * `operationInFlight` busy check when another operation is already running
 * against the shared workspace. A typed error (rather than a plain `Error`)
 * lets a controller map {@link inFlight} straight onto
 * `IacPlanAck.conflict` (which `iac.page.tsx` reads to drive
 * the renderer's busy-banner UX) without parsing a message string.
 */
export class PulumiOperationInFlightError extends Error {
  constructor(public readonly inFlight: 'preview' | 'up' | 'destroy' | 'rollback') {
    super(
      `PulumiService cannot run this operation while ${inFlight}() is already running; wait for ` +
        'it to finish before submitting another.',
    );
    this.name = 'PulumiOperationInFlightError';
  }
}

/**
 * Thrown by `PulumiService.initializeStack` for every failure —
 * tags exactly which of the three provisioning phases (`'engine'` /
 * `'plugins'` / `'operation'`) it happened during, so a caller (the
 * `iac.stack.initialize` IPC channel, then the wizard's stack-initialization
 * step) can show a specific, actionable error against the right step of its
 * 3-phase progress UI instead of a generic failure. See
 * {@link PulumiService.initializeStack}'s own TSDoc ("Error attribution") for
 * exactly how each underlying failure gets mapped to a phase.
 */
export class PulumiStackInitializationError extends Error {
  constructor(
    public readonly phase: PulumiProvisioningPhase,
    public readonly cause: unknown,
  ) {
    super(
      `Pulumi stack initialization failed during the "${phase}" phase: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PulumiStackInitializationError';
  }
}

/**
 * Thrown by `PulumiService.preview` when the Automation
 * API's `stack.preview()` call throws. Automation API failures are a thrown
 * `CommandError` (or a subclass, e.g. `ConcurrentUpdateError`), not a
 * process exit code, so this carries the SDK's own error as `cause` instead
 * of an `exitCode`.
 */
export class PulumiPreviewError extends Error {
  constructor(public readonly cause: unknown) {
    super(`pulumi preview failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PulumiPreviewError';
  }
}

/**
 * Thrown by `PulumiService.apply` when the Automation API's `stack.up()`
 * call throws and the failure is a clean (non-partial) failure — see
 * {@link PulumiPreviewError}'s doc comment for why `cause` carries the
 * underlying failure. Distinct from {@link PulumiPartialApplyError},
 * which is thrown instead when the divergence happened partway
 * through applying resources rather than before any resource was touched.
 */
export class PulumiUpError extends Error {
  constructor(public readonly cause: unknown) {
    super(`pulumi up failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PulumiUpError';
  }
}

/**
 * Thrown by `PulumiService.destroy` when the Automation API's
 * `stack.destroy()` call throws — see {@link PulumiPreviewError}'s doc
 * comment for why `cause` carries the underlying failure instead of an
 * `exitCode`.
 */
export class PulumiDestroyError extends Error {
  constructor(public readonly cause: unknown) {
    super(`pulumi destroy failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PulumiDestroyError';
  }
}

/**
 * Thrown by `PulumiService.clearStaleLock` when the Automation
 * API's `stack.cancel()` call itself fails while attempting to clear an
 * operator-confirmed stale backend lock. Reshaped the same way as
 * {@link PulumiPreviewError}/{@link PulumiUpError}/{@link PulumiDestroyError}
 * — see {@link PulumiPreviewError}'s doc comment for why `cause` replaces an
 * `exitCode`. Distinct from those three in what the failure means: this is
 * never "some engine operation diverged partway through" — it means the
 * CLEAR ITSELF didn't work, so the lock the operator was trying to recover
 * from is still standing afterward exactly as it was before the attempt, and
 * `clearStaleLock`'s caller must not treat this as "the lock is now clear".
 */
export class PulumiLockClearError extends Error {
  constructor(public readonly cause: unknown) {
    super(
      `pulumi stack.cancel() failed while clearing the stale backend lock: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PulumiLockClearError';
  }
}

/**
 * A single resource-level step the Automation API's `onEvent` stream
 * reported completing (via a `ResOutputsEvent`/`ResourcePreEvent` pair, per
 * `@pulumi/pulumi/automation/events.js`'s `StepEventMetadata`) before a
 * `stack.up()` call diverged partway through. Carried on
 * {@link PulumiPartialApplyError} so a caller (or the run-history UI)
 * can show exactly what already changed before the failure, rather than
 * only "the apply failed".
 */
export interface PulumiPartialApplyStep {
  /** The resource's URN, as reported by the engine event. */
  urn: string;
  /** The resource's Pulumi type token (e.g. `aws:ecs/cluster:Cluster`). */
  type: string;
  /** The operation the engine performed on this resource before the divergence. */
  op: OpType;
}

/**
 * Thrown by `PulumiService.apply` when `stack.up()` fails AFTER at
 * least one resource step has already been applied — i.e. the stack is now
 * in a state between its old and new desired states, distinct from a clean
 * failure ({@link PulumiUpError}) where nothing was touched before the
 * divergence. The Automation API's `onEvent` stream is what makes this
 * distinguishable at all: it reports each resource step as it completes, so
 * a failure partway through is directly observable rather than something a
 * caller would have to infer by re-reading state afterward.
 *
 * `completedSteps` is populated from whatever `StepEventMetadata` the
 * `onEvent` callback observed before the failure (see
 * {@link PulumiPartialApplyStep}) — this is the full per-resource fidelity
 * the SDK's event stream exposes (confirmed against
 * `@pulumi/pulumi/automation/events.js`), so `apply` populates it fully
 * rather than falling back to an empty array; an empty
 * array here would still be a truthful (if less useful) "apply failed
 * partway through, no completed-step detail available" signal if a future
 * caller ever constructs one without wiring up the event listener.
 */
export class PulumiPartialApplyError extends Error {
  constructor(
    public readonly completedSteps: PulumiPartialApplyStep[],
    public readonly cause: unknown,
  ) {
    super(
      `pulumi up failed partway through (${completedSteps.length} resource step(s) already applied): ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PulumiPartialApplyError';
  }
}

/**
 * Thrown by {@link PulumiService.apply} before spawning the update
 * when the caller supplied a config-object version id (the version the
 * saved plan was generated against) and the S3 configuration object's
 * current head version no longer matches it.
 */
export class StalePlanError extends Error {
  constructor(key: string, bucket: string, expectedVersionId: string, actualVersionId: string | undefined) {
    super(
      `configuration object "${key}" in S3 bucket "${bucket}" is stale for this plan: expected version ` +
        `"${expectedVersionId}" to still be the current head, but the head version is now ` +
        `${actualVersionId ? `"${actualVersionId}"` : 'missing'}. Re-run preview() before applying.`,
    );
    this.name = 'StalePlanError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 1) when no run record
 * exists at all for the supplied `planRunId`. `RunRecordService`'s own
 * `RunRecordNotFoundError` exists but is scoped to `approveRun`'s call
 * site, not `apply`'s gate, so a distinct class is added here following
 * this file's `Pulumi*Error` house style.
 */
export class PulumiPlanRunNotFoundError extends Error {
  constructor(public readonly planRunId: string) {
    super(`No plan run found for planRunId "${planRunId}" — cannot apply.`);
    this.name = 'PulumiPlanRunNotFoundError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 2) when the run record
 * found for `planRunId` is not a `'plan'`-kind record — see
 * {@link PulumiPlanRunNotFoundError}'s doc comment for why this is its own
 * class rather than reusing `RunRecordService`'s `RunRecordNotPlanError`.
 */
export class PulumiPlanRunWrongKindError extends Error {
  constructor(
    public readonly planRunId: string,
    public readonly kind: RunKind,
  ) {
    super(`Run "${planRunId}" is a "${kind}" run, not a "plan" run, and cannot be applied.`);
    this.name = 'PulumiPlanRunWrongKindError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 2, a refinement of the
 * {@link PulumiPlanRunWrongKindError} check) when the record found for
 * `planRunId` is an `apply`-kind record with `partialApply: true` — i.e. a
 * PRIOR attempt on this same plan either genuinely diverged partway through
 * `stack.up()`, or never got to confirm it didn't (see
 * `RunRecordService.writePreflightMarker`'s doc comment and issue #399):
 * either way, whether `stack.up()` already mutated real infrastructure for
 * this `planRunId` is unknown or affirmatively partial, so a second `apply()`
 * call for the SAME plan must be refused rather than silently retried.
 * `record.partialApply` is checked directly (never gated behind
 * `record.status === 'failed'` — see {@link RunRecord.partialApply}'s own
 * doc comment for why that would silently miss the cancelled-mid-apply
 * case), finally implementing the check this gate step's own long-standing
 * doc comment already described as correct. Distinct from the plain
 * {@link PulumiPlanRunWrongKindError} thrown for every OTHER non-`'plan'`
 * record (a clean success or a clean failure, neither of which is a
 * "was this actually partial?" case), so a caller/operator sees a message
 * that names the real reason a retry is refused instead of the generic
 * "wrong kind" wording.
 */
export class PulumiPartialApplyRetryBlockedError extends Error {
  constructor(
    public readonly planRunId: string,
    public readonly status: RunStatus,
  ) {
    super(
      `Apply refused for plan run "${planRunId}": a prior apply attempt against this plan did not confirm a ` +
        `clean completion (status "${status}", partialApply: true) — the deployed infrastructure may not match ` +
        'this plan anymore. Re-run preview() against current state instead of retrying this plan.',
    );
    this.name = 'PulumiPartialApplyRetryBlockedError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 3) when the plan run's
 * `approvedBy`/`approvedAt` are not both set — a typed error rather than a
 * bare string, since `apply` is self-contained and has no controller to
 * compose the message at the call site instead.
 */
export class PulumiPlanNotApprovedError extends Error {
  constructor(public readonly planRunId: string) {
    super(`Plan run "${planRunId}" has not been approved — approve it before applying.`);
    this.name = 'PulumiPlanNotApprovedError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 4) when the plan run's
 * approval is no longer within `APPROVAL_WINDOW_MS`
 * (`@hyveon/shared/runs.js`, `isApprovalExpired`) of `approvedAt` — see
 * {@link PulumiPlanNotApprovedError}'s doc comment for why this is a typed
 * class rather than a bare string.
 */
export class PulumiApprovalExpiredError extends Error {
  constructor(
    public readonly planRunId: string,
    public readonly approvedAt: string,
  ) {
    super(`Approval for plan run "${planRunId}" (approved at ${approvedAt}) has expired; re-approve before applying.`);
    this.name = 'PulumiApprovalExpiredError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 5) when the
 * caller-supplied `planHash` does not match the plan record's own stored
 * `planHash` — stops a forged or stale hash from ever reaching `stack.up()`.
 * See {@link PulumiPlanNotApprovedError}'s doc comment for why this is a
 * typed class rather than a bare string.
 */
export class PulumiPlanHashMismatchError extends Error {
  constructor(
    public readonly planRunId: string,
    public readonly recordPlanHash: string | undefined,
    public readonly suppliedPlanHash: string,
  ) {
    super(`Plan hash mismatch for run "${planRunId}": the supplied planHash does not match the approved plan's stored hash.`);
    this.name = 'PulumiPlanHashMismatchError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 6b) when the on-disk
 * plan artifact, re-hashed against the current configuration-object version
 * (`PulumiService.computePlanHash`), no longer matches the plan record's
 * stored `planHash` — even though gate step 6a already confirmed the
 * configuration-object version itself has NOT moved (that condition throws
 * {@link StalePlanError} instead, reusing that existing class). Since the
 * config version is provably unchanged by the time this check runs, a
 * mismatch here can only mean the artifact's own bytes differ from what was
 * hashed at plan time — the file was swapped or modified on disk since the
 * plan was reviewed. Also thrown, wrapping the underlying failure as
 * `cause`, if the artifact can't even be read/hashed. This is a distinct
 * class from {@link StalePlanError} because its shape
 * (`key`/`bucket`/`expectedVersionId`/`actualVersionId`) describes an S3
 * config-object version mismatch, not an artifact-bytes mismatch, so
 * reusing it here would misdescribe the failure.
 */
export class PulumiPlanArtifactStaleError extends Error {
  constructor(
    public readonly planRunId: string,
    public readonly artifactPath: string,
    public readonly cause?: unknown,
  ) {
    super(
      cause !== undefined
        ? `Failed to re-verify plan artifact "${artifactPath}" for run "${planRunId}" before apply: ` +
            `${cause instanceof Error ? cause.message : String(cause)}`
        : `Plan artifact "${artifactPath}" for run "${planRunId}" no longer matches its approved hash — it may ` +
            'have been modified since the plan was reviewed. Re-run preview() before applying.',
    );
    this.name = 'PulumiPlanArtifactStaleError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 7) when the plan
 * record's stamped `engineVersion` no longer matches
 * `PulumiEngineService.getResolvedVersion()` — the `iac-plan-apply-page`
 * spec's "Engine upgraded between plan and apply" scenario requires an
 * error that *names the version change*, which is why both versions are
 * carried and included in the message, following this file's
 * `Pulumi*Error` house style.
 */
export class PulumiEngineVersionMismatchError extends Error {
  constructor(
    public readonly planRunId: string,
    public readonly planEngineVersion: string | undefined,
    public readonly currentEngineVersion: string | undefined,
  ) {
    super(
      `Plan run "${planRunId}" was produced by Pulumi engine version "${planEngineVersion ?? 'unknown'}", but the ` +
        `currently resolved engine is "${currentEngineVersion ?? 'unknown'}" — an engine upgrade between plan and ` +
        'apply invalidates the plan. Re-run preview() before applying.',
    );
    this.name = 'PulumiEngineVersionMismatchError';
  }
}

/**
 * Thrown by `PulumiService.preview` when the saved plan artifact can't be
 * hashed (or its `manifest.version` read — see {@link PulumiService.readEngineVersionFromPlanArtifact})
 * after a successful `stack.preview()` call. Hashes the saved Pulumi
 * update-plan JSON file.
 */
export class PulumiPlanHashError extends Error {
  constructor(
    public readonly runId: string,
    public readonly artifactPath: string,
    public readonly cause: unknown,
  ) {
    super(
      `Failed to compute SHA-256 hash of plan artifact "${artifactPath}" for run "${runId}": ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PulumiPlanHashError';
  }
}

/**
 * Generic terminal outcome shape for a Pulumi operation (`preview`/`up`/
 * `destroy`), carried by {@link PulumiRunPersistError}. Deliberately minimal
 * (no operation-specific `result` payload) — this only carries what
 * {@link PulumiRunPersistError.describeOutcome} actually needs to render a
 * message (`kind`, and the failure's `error` when `kind === 'failed'`).
 */
export type PulumiOperationOutcome =
  | { kind: 'success' }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: Error };

/**
 * Thrown when persisting a run record (local artifact plus the
 * `RunRecordStore` write) fails after a `preview`/`up`/`destroy` operation
 * has already settled. Its `outcome` field is
 * {@link PulumiOperationOutcome} — there's no `exitCode` to branch on for a
 * Pulumi failure, so `describeOutcome` doesn't need a special case for an
 * `exitCode` property on `outcome.error`.
 */
export class PulumiRunPersistError extends Error {
  constructor(
    public readonly runId: string,
    public readonly outcome: PulumiOperationOutcome,
    public readonly cause: unknown,
  ) {
    super(
      `Failed to persist run record for run "${runId}" (outcome: ` +
        `${PulumiRunPersistError.describeOutcome(outcome)}): ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PulumiRunPersistError';
  }

  /** Renders a {@link PulumiOperationOutcome} as a short phrase for the error message above. */
  private static describeOutcome(outcome: PulumiOperationOutcome): string {
    switch (outcome.kind) {
      case 'success':
        return 'succeeded';
      case 'aborted':
        return 'aborted';
      case 'failed':
        return `failed (${outcome.error.message})`;
    }
  }
}

/**
 * Thrown by {@link PulumiService.apply} when
 * `RunRecordService.writePreflightMarker` — the durable, in-doubt placeholder
 * record it writes immediately after gate step 8 acquires the apply lock, but
 * BEFORE `stack.up()` is ever called (issue #399) — itself fails. `apply`
 * fails closed on this: `stack.up()` is never reached, and the durable apply
 * lock gate step 8 just acquired is released explicitly in this same failure
 * path (NOT the ordinary post-settlement release {@link PulumiRunPersistError}'s
 * doc comment describes), since no infrastructure mutation has happened yet
 * and holding the lock for a run that never started would only wedge the
 * workspace for no reason. Distinct from {@link PulumiRunPersistError}, which
 * describes a persistence failure AFTER the operation has already settled —
 * this one is entirely pre-engine-call.
 */
export class PulumiPreflightMarkerError extends Error {
  constructor(
    public readonly planRunId: string,
    public readonly cause: unknown,
  ) {
    super(
      `pulumi apply refused: failed to write the durable pre-flight marker for plan run "${planRunId}" — aborting ` +
        `before stack.up() to fail closed (no infrastructure was touched): ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PulumiPreflightMarkerError';
  }
}

/**
 * Thrown by {@link PulumiService.destroy} when it's called without
 * a fresh, valid confirmation token — call
 * `PulumiService.mintDestroyConfirmationToken()` first.
 */
export class DestroyNotConfirmedError extends Error {
  constructor() {
    super(
      'pulumi destroy refused: no fresh confirmation token was supplied. Call ' +
        'PulumiService.mintDestroyConfirmationToken() and pass the returned token to ' +
        'destroy() before it expires.',
    );
    this.name = 'DestroyNotConfirmedError';
  }
}

/**
 * Thrown by `PulumiService.clearStaleLock` when it's called without a
 * fresh, valid confirmation token — mirrors {@link DestroyNotConfirmedError}
 * exactly, for the lock-clear confirmation gate.
 */
export class LockClearNotConfirmedError extends Error {
  constructor() {
    super(
      'pulumi lock clear refused: no fresh confirmation token was supplied. Call ' +
        'PulumiService.mintLockClearConfirmationToken() and pass the returned token to ' +
        'clearStaleLock() before it expires.',
    );
    this.name = 'LockClearNotConfirmedError';
  }
}

/**
 * Thrown by the rollback flow when no run record
 * exists for the given `applyRunId`.
 */
export class RollbackTargetNotFoundError extends Error {
  constructor(public readonly applyRunId: string) {
    super(`No run record found for apply run "${applyRunId}" — cannot roll it back.`);
    this.name = 'RollbackTargetNotFoundError';
  }
}

/**
 * Thrown by the rollback flow when the run record
 * found for `applyRunId` isn't an `apply` run.
 */
export class RollbackNotApplyRunError extends Error {
  constructor(
    public readonly applyRunId: string,
    public readonly kind: RunKind,
  ) {
    super(`Run "${applyRunId}" is a "${kind}" run, not an "apply" run — only apply runs can be rolled back.`);
    this.name = 'RollbackNotApplyRunError';
  }
}

/**
 * Thrown by the rollback flow when the target apply
 * run has no recorded configuration-object version id — there's no version
 * history to roll back against.
 */
export class RollbackNoConfigVersionError extends Error {
  constructor(public readonly applyRunId: string) {
    super(`Apply run "${applyRunId}" has no recorded configuration version id — nothing to roll back.`);
    this.name = 'RollbackNoConfigVersionError';
  }
}

/**
 * Thrown by the rollback flow when the historic
 * configuration version a rollback would restore no longer exists.
 */
export class RollbackVersionMissingError extends Error {
  constructor(public readonly versionId: string) {
    super(
      `Historic configuration version "${versionId}" no longer exists — it may have expired. Nothing was written.`,
    );
    this.name = 'RollbackVersionMissingError';
  }
}

/**
 * Thrown by {@link PulumiService.confirmRollback} when the
 * historic configuration was successfully restored as the configuration
 * object's new head, but the follow-up plan {@link PulumiService.previewCore}
 * runs against it could not be completed — the `iac-rollback` spec's
 * "MUST NOT leave the restored configuration as the head with no plan
 * attached... silently" clause (see `confirmRollback`'s TSDoc, "Why restore
 * and plan are one guarded unit").
 *
 * This is the "record-and-surface" half of the chosen compensating-
 * semantics strategy (see `confirmRollback`'s TSDoc for why restore-the-
 * previous-head was rejected): by the time this is thrown,
 * `ElectronStoreService.recordOrphanedRollback` has already durably
 * recorded {@link restoredVersionId} against {@link applyRunId} — this
 * error is the SAME failure surfaced synchronously to whatever is driving
 * `confirmRollback`'s generator, so a caller doesn't need to separately poll
 * the store to learn the rollback didn't fully complete.
 */
export class PulumiRollbackPlanFailedError extends Error {
  constructor(
    public readonly applyRunId: string,
    public readonly restoredVersionId: string,
    public readonly cause: unknown,
  ) {
    super(
      `Rollback of apply run "${applyRunId}" restored configuration version "${restoredVersionId}" as the new ` +
        `head, but the follow-up plan could not be completed: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. The restored configuration is now the head ` +
        'with no completed plan attached — this has been durably recorded via ' +
        'ElectronStoreService.recordOrphanedRollback() (readable via getOrphanedRollback()) for a later ' +
        'operator-facing surface to present. Retry the rollback, or restore a different version, to resolve it.',
      { cause },
    );
    this.name = 'PulumiRollbackPlanFailedError';
  }
}
