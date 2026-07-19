import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import type { RemoteFileStore } from '@hyveon/shared';
import { ConfigService } from './ConfigService.js';
import { REMOTE_FILE_STORE } from '../modules/cloud-provider.tokens.js';

const execFileAsync = promisify(execFile);

/**
 * Returns the platform-appropriate binary-lookup command: `where.exe` on
 * Windows, `which` everywhere else. Extracted as a pure function (rather than
 * an inline ternary on `process.platform`) so the platform branching is
 * unit-testable without having to stub `process.platform` itself.
 */
export function lookupCommandFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'where.exe' : 'which';
}

/**
 * Thrown when the system `terraform` binary cannot be located on `PATH` via
 * the platform's lookup command (`which`/`where.exe`). Surfaced to the
 * first-run wizard's prerequisite check so the operator gets install
 * instructions instead of an opaque `ENOENT`.
 */
export class TerraformNotFoundError extends Error {
  constructor(lookupCommand: string = lookupCommandFor(process.platform)) {
    super(
      `terraform binary not found on PATH (lookup via \`${lookupCommand}\` failed). ` +
        'Install Terraform and ensure it is on PATH: https://developer.hashicorp.com/terraform/install',
    );
    this.name = 'TerraformNotFoundError';
  }
}

/** Binary path + semver version resolved on first use and memoized thereafter. */
interface TerraformResolution {
  binaryPath: string;
  version: string;
}

/**
 * Backend configuration values passed to `terraform init -backend-config=...`
 * for the S3 remote state backend bootstrapped by the First-Run Wizard (see
 * the "Terraform orchestrator" section of the electron-desktop-pivot design
 * spec). Maps 1:1 onto the `-backend-config=bucket=...` /
 * `-backend-config=region=...` / `-backend-config=dynamodb_table=...` CLI
 * flags {@link TerraformService.init} passes to `terraform init`.
 */
export interface TerraformInitConfig {
  bucket: string;
  region: string;
  dynamodbTable: string;
}

/**
 * A single line of output from a streamed `terraform` subcommand run, tagged
 * with the stream it came from. Yielded by {@link TerraformService.init} (and,
 * later, `plan`/`apply`/`destroy`/`output`) as the spawned process produces
 * output, rather than being buffered until the process exits — this is the
 * shape the future `terraform.init.chunk` / `terraform.init.end` IPC bridge
 * consumes directly from the async generator.
 */
export interface TerraformRunChunk {
  stream: 'stdout' | 'stderr';
  line: string;
}

/**
 * Thrown when the spawned `terraform init` process exits with a non-zero
 * status code. Distinct from {@link TerraformNotFoundError}, which is thrown
 * when the binary itself can't be located before the process is even
 * spawned.
 */
export class TerraformInitError extends Error {
  constructor(public readonly exitCode: number | null) {
    super(`terraform init exited with code ${exitCode ?? 'null'}`);
    this.name = 'TerraformInitError';
  }
}

/**
 * Outcome of {@link TerraformService.spawnAndStream} once the spawned process
 * has closed (or been aborted). Consumed via `yield*` delegation from
 * subcommand runners like {@link TerraformService.init}, which decide what a
 * given exit code means for their own subcommand — `spawnAndStream` itself
 * has no opinion on success/failure beyond surfacing the raw exit code.
 */
type SpawnStreamResult =
  | { aborted: true }
  | {
      aborted: false;
      exitCode: number | null;
    };

/**
 * Thrown when the spawned `terraform plan` process exits with a non-zero
 * status code. Distinct from {@link TerraformNotFoundError} (binary can't be
 * resolved) and {@link TerraformInitError} (an `init` run's own failure).
 */
export class TerraformPlanError extends Error {
  constructor(public readonly exitCode: number | null) {
    super(`terraform plan exited with code ${exitCode ?? 'null'}`);
    this.name = 'TerraformPlanError';
  }
}

/**
 * Outcome of a successful {@link TerraformService.plan} run, resolved via the
 * async generator's return value once the spawned `terraform plan` process
 * exits `0` and the run wasn't aborted.
 */
export interface TerraformPlanResult {
  /** The `runId` minted for this run — the parent directory (`<runsDir>/<runId>/`) of both {@link artifactPath} and {@link varFilePath}. */
  runId: string;
  /** Absolute path to the persisted `.tfplan` binary artifact — what a future `apply()` passes to `terraform apply <artifactPath>`. */
  artifactPath: string;
  /** Absolute path to the pulled tfvars snapshot this plan was run against. */
  varFilePath: string;
  /** Number of resources Terraform plans to add. */
  add: number;
  /** Number of resources Terraform plans to change in place. */
  change: number;
  /** Number of resources Terraform plans to destroy. */
  destroy: number;
}

/**
 * Matches Terraform's plan-summary stdout line, e.g.
 * `Plan: 3 to add, 1 to change, 0 to destroy.` — scanned for while streaming
 * {@link TerraformService.plan}'s output to extract the resource change
 * counts returned in the generator's return value. A "no changes" plan (this
 * pattern never matches) resolves all three counts to `0`.
 */
const PLAN_SUMMARY_PATTERN = /Plan:\s*(\d+) to add,\s*(\d+) to change,\s*(\d+) to destroy\./;

/**
 * Matches a bare, single-segment run identifier — letters, digits,
 * underscores, and hyphens only, with no path separators (`/`, `\`), no `.`/`..`
 * traversal segments, and no empty string. `runId` is normally a `randomUUID()`
 * value (which satisfies this pattern), but this is intentionally looser than
 * a strict UUID check so it doesn't reject the non-UUID run ids exercised by
 * `TerraformService.apply.test.ts`'s fixtures. This is the only shape
 * {@link TerraformService.apply} accepts for a caller-supplied `runId`, since
 * it's joined directly into filesystem paths under `ConfigService.getRunsDir()`;
 * rejecting anything else (e.g. `../..`, absolute paths, embedded separators)
 * closes off path traversal via `runId`.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Thrown by {@link TerraformService.apply} before spawning `terraform apply`
 * when the caller supplied a `tfvarsVersionId` (the version the plan being
 * applied was generated against) and the S3 tfvars object's current head
 * version no longer matches it — the remote tfvars changed underneath the
 * caller since the plan was produced, so applying the stale `.tfplan`
 * artifact could deploy against configuration nobody actually planned.
 * Distinct from the plain `Error` {@link TerraformService.pullVarFile} throws
 * for the equivalent staleness check ahead of `plan()`, so callers can branch
 * on `instanceof StalePlanError` to prompt "re-plan before applying" flows
 * specifically.
 */
export class StalePlanError extends Error {
  constructor(key: string, bucket: string, expectedVersionId: string, actualVersionId: string | undefined) {
    super(
      `tfvars object "${key}" in S3 bucket "${bucket}" is stale for this plan: expected version ` +
        `"${expectedVersionId}" to still be the current head, but the head version is now ` +
        `${actualVersionId ? `"${actualVersionId}"` : 'missing'}. Re-run plan() before applying.`,
    );
    this.name = 'StalePlanError';
  }
}

/**
 * Thrown when the spawned `terraform apply` process exits with a non-zero
 * status code. Distinct from {@link TerraformNotFoundError} (binary can't be
 * resolved) and {@link StalePlanError} (the pre-spawn staleness guard).
 */
export class TerraformApplyError extends Error {
  constructor(public readonly exitCode: number | null) {
    super(`terraform apply exited with code ${exitCode ?? 'null'}`);
    this.name = 'TerraformApplyError';
  }
}

/**
 * Outcome of a successful {@link TerraformService.apply} run, resolved via the
 * async generator's return value once the spawned `terraform apply` process
 * exits `0` and the run wasn't aborted.
 */
export interface TerraformApplyResult {
  /** The `runId` this apply run was invoked with — matches the directory `run.json` is written into. */
  runId: string;
  /** Number of resources Terraform reported adding. */
  added: number;
  /** Number of resources Terraform reported changing in place. */
  changed: number;
  /** Number of resources Terraform reported destroying. */
  destroyed: number;
}

/**
 * Matches Terraform's apply-summary stdout line, e.g.
 * `Apply complete! Resources: 3 added, 1 changed, 0 destroyed.` — scanned for
 * while streaming {@link TerraformService.apply}'s output to extract the
 * resource change counts returned in the generator's return value. Mirrors
 * {@link PLAN_SUMMARY_PATTERN} for the equivalent `plan()` summary line.
 */
const APPLY_SUMMARY_PATTERN =
  /Apply complete!\s*Resources:\s*(\d+) added,\s*(\d+) changed,\s*(\d+) destroyed\./;

/**
 * Persisted to `<runsDir>/<runId>/run.json` once a {@link TerraformService.apply}
 * run's spawned process has closed (whether it exited cleanly, non-zero, or
 * was killed via an abort signal) — a lightweight local run history so a
 * future Apply-history UI can list past runs without a database. `kind` is
 * currently always `'apply'`; the union leaves room for `plan`/`destroy`
 * records to reuse the same shape without a breaking change later.
 */
export interface TerraformRunRecord {
  /** The `runId` this record describes — matches the directory it's written into. */
  runId: string;
  /** Which subcommand produced this record. */
  kind: 'apply';
  /** ISO-8601 timestamp captured immediately before the process was spawned. */
  startedAt: string;
  /** ISO-8601 timestamp captured immediately after the process closed. */
  completedAt: string;
  /** The process's exit code, or `null` if it never reported one (e.g. killed via abort signal). */
  exitCode: number | null;
  /** The tfvars version id the applied plan was generated against, if the caller supplied one. */
  tfvarsVersionId?: string;
}

/**
 * Describes what {@link TerraformService.apply} was about to return/throw the
 * moment its spawned process closed — captured before
 * {@link TerraformService.writeRunRecord} is attempted so a persistence
 * failure (see {@link TerraformRunPersistError}) doesn't discard the real
 * outcome of the apply run.
 */
export type TerraformApplyOutcome =
  | { kind: 'success'; result: TerraformApplyResult }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: TerraformApplyError };

/**
 * Thrown by {@link TerraformService.apply} when persisting the
 * {@link TerraformRunRecord} to `<runsDir>/<runId>/run.json` fails (e.g. a
 * filesystem error surfaced from `mkdirSync`/`writeFileSync` inside
 * {@link TerraformService.writeRunRecord}) — distinct from a failure of
 * `terraform apply` itself. Carries the {@link TerraformApplyOutcome} that had
 * already been computed before the persistence attempt (success, abort, or a
 * {@link TerraformApplyError}) so callers can recover the real apply result
 * instead of only seeing an unrelated filesystem exception, plus `cause` — the
 * underlying error `writeRunRecord` raised.
 */
export class TerraformRunPersistError extends Error {
  constructor(
    public readonly runId: string,
    public readonly outcome: TerraformApplyOutcome,
    public readonly cause: unknown,
  ) {
    super(
      `Failed to persist run record for run "${runId}" (apply outcome: ` +
        `${TerraformRunPersistError.describeOutcome(outcome)}): ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'TerraformRunPersistError';
  }

  /** Renders {@link TerraformApplyOutcome} as a short phrase for the error message above. */
  private static describeOutcome(outcome: TerraformApplyOutcome): string {
    switch (outcome.kind) {
      case 'success':
        return 'succeeded';
      case 'aborted':
        return 'aborted';
      case 'failed':
        return `failed (exit code ${outcome.error.exitCode ?? 'null'})`;
    }
  }
}

/**
 * Lazily resolves and caches the system `terraform` binary's absolute path
 * and semver version, and orchestrates `terraform` subcommands against it:
 * {@link TerraformService.init}, the streaming/idempotent `terraform init`
 * runner; {@link TerraformService.plan}, the streaming `terraform plan`
 * runner that persists its `.tfplan` artifact and the pulled tfvars snapshot
 * under `ConfigService.getRunsDir()`; and {@link TerraformService.apply}, the
 * streaming `terraform apply <planFile>` runner that persists a
 * {@link TerraformRunRecord} to the same per-run directory once the process
 * closes. Later child issues of Epic D add `destroy`/`output` — see the
 * "Terraform orchestrator" section of the electron-desktop-pivot design spec.
 *
 * Construction is synchronous and never throws — the binary lookup +
 * `terraform version` shell-outs are deferred until {@link getBinaryPath} or
 * {@link getVersion} is first called, so `TerraformModule` can be imported by
 * `AppModule` unconditionally even on machines without `terraform` on PATH.
 * The resolution (or its rejection) is memoized on the instance, so the
 * lookup/version commands only ever run once per instance regardless of how
 * many times the accessors are called.
 */
@Injectable()
export class TerraformService {
  private resolution: Promise<TerraformResolution> | null = null;

  /**
   * Backend config the most recent successful {@link init} call completed
   * with. Compared field-by-field against the `config` of a subsequent
   * `init()` call to make repeat calls with an identical backend a no-op —
   * see {@link init}'s TSDoc.
   */
  private lastInitConfig: TerraformInitConfig | null = null;

  /**
   * Name of whichever subcommand ({@link init}, {@link plan}, or
   * {@link apply}) is actively running against `getTerraformDir()`, or `null`
   * when none is. A single shared lock (rather than separate
   * `initInFlight`/`planInFlight`/`applyInFlight` flags) is required because
   * `init` mutates the `backend/.terraform` state that `plan`/`apply` read,
   * and `apply` itself mutates the state that a concurrent `plan` would read
   * — letting any two of these subcommands run concurrently against the same
   * workspace would race one against the other's writes/reads. Set the
   * moment a generator body starts executing (i.e. the first `.next()` call)
   * until it completes or throws.
   */
  private workspaceInFlight: 'init' | 'plan' | 'apply' | null = null;

  /**
   * `config` resolves the terraform working directory (`getTerraformDir()`)
   * and the per-run artifacts directory (`getRunsDir()`) for
   * `init`/`plan`/`apply`/`destroy`/`output`. `remoteFileStore` is typed
   * against the cloud-agnostic `RemoteFileStore` contract (not a concrete AWS
   * class) so this service depends only on the interface; `@Inject(REMOTE_FILE_STORE)`
   * tells Nest which concrete provider (bound by `CloudProviderModule` for
   * whichever cloud is active) to resolve for that parameter. Used by
   * {@link plan} to pull the current tfvars snapshot when S3 tfvars sync is
   * configured (mirrors `TfvarsService`'s local-vs-S3 read).
   */
  constructor(
    private readonly config: ConfigService,
    @Inject(REMOTE_FILE_STORE) private readonly remoteFileStore: RemoteFileStore,
  ) {}

  /**
   * Resolves the system `terraform` binary via `which` (POSIX) / `where.exe`
   * (Windows), then queries `terraform version` for the semver string,
   * memoizing the result (or rejection) so subsequent calls don't re-run the
   * shell-outs. Rejects with {@link TerraformNotFoundError} when the lookup
   * fails.
   */
  private resolve(): Promise<TerraformResolution> {
    if (!this.resolution) {
      this.resolution = TerraformService.resolveBinaryPath().then(async (binaryPath) => {
        const version = await TerraformService.resolveVersion(binaryPath);
        return { binaryPath, version };
      });
    }
    return this.resolution;
  }

  /**
   * Returns the absolute path to the resolved `terraform` binary, resolving
   * (and memoizing) it on first call. Rejects with
   * {@link TerraformNotFoundError} when the binary can't be found on PATH.
   */
  async getBinaryPath(): Promise<string> {
    const { binaryPath } = await this.resolve();
    return binaryPath;
  }

  /**
   * Returns the semver version string parsed from `terraform version`,
   * resolving (and memoizing) it on first call. Rejects with
   * {@link TerraformNotFoundError} when the binary can't be found on PATH.
   */
  async getVersion(): Promise<string> {
    const { version } = await this.resolve();
    return version;
  }

  /**
   * Runs `terraform init` with `-backend-config=bucket=<bucket>`,
   * `-backend-config=region=<region>`, and
   * `-backend-config=dynamodb_table=<dynamodbTable>` flags derived from
   * `config`, inside the Terraform composer root
   * (`ConfigService.getTerraformDir()`), yielding a {@link TerraformRunChunk}
   * per line of output as the process produces it.
   *
   * Uses `child_process.spawn` (rather than the buffered `execFile` helper
   * used for binary/version detection above) so stdout/stderr can be
   * streamed line-by-line as the process produces them, instead of only
   * becoming available once the whole command finishes. The async-generator
   * shape is the seam the `terraform.init.chunk` / `terraform.init.end` IPC
   * bridge (a later child issue of Epic D) consumes directly to forward
   * chunks to the renderer.
   *
   * Idempotent: if the last successful `init()` call completed with a
   * field-identical `config`, this yields a single informational stdout
   * chunk and returns without spawning a second `terraform init` process —
   * the First-Run Wizard's "Reconfigure" flow (and any accidental
   * double-invoke) can safely call `init` again with the same backend
   * without doing redundant work.
   *
   * `signal`, if provided, aborts the run: the spawned child process is
   * killed and the generator ends cleanly (no further chunks, no throw)
   * rather than rejecting with {@link TerraformInitError}.
   *
   * Throws a descriptive `Error` synchronously (on the first `.next()` call)
   * if another `init()` *or* `plan()` call is already in flight on this
   * instance — both subcommands share a single {@link workspaceInFlight} lock
   * because `init` mutates the `backend/.terraform` state that `plan` reads;
   * overlapping runs against the same working directory would race.
   *
   * Throws {@link TerraformNotFoundError} if the `terraform` binary can't be
   * resolved, or {@link TerraformInitError} if the spawned process exits with
   * a non-zero status code (and the run wasn't aborted). Neither failure is
   * memoized, so a subsequent call (even with the same `config`) retries.
   */
  async *init(
    config: TerraformInitConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<TerraformRunChunk, void> {
    if (this.workspaceInFlight) {
      throw new Error(
        `TerraformService.init() cannot run while ${this.workspaceInFlight}() is already ` +
          'running; wait for it to finish before calling init() again.',
      );
    }
    this.workspaceInFlight = 'init';
    try {
      if (this.lastInitConfig && TerraformService.sameBackendConfig(this.lastInitConfig, config)) {
        yield {
          stream: 'stdout',
          line: 'terraform init skipped: backend config unchanged since the last successful init',
        };
        return;
      }

      if (signal?.aborted) {
        // Already aborted before we even started resolving the binary path —
        // end the generator cleanly without spawning anything.
        return;
      }

      const binaryPath = await this.getBinaryPath();

      if (signal?.aborted) {
        // Aborted while resolving the binary path — end cleanly before spawn.
        return;
      }

      const cwd = this.config.getTerraformDir();
      const args = [
        'init',
        '-input=false',
        '-no-color',
        `-backend-config=bucket=${config.bucket}`,
        `-backend-config=region=${config.region}`,
        `-backend-config=dynamodb_table=${config.dynamodbTable}`,
      ];

      const result = yield* this.spawnAndStream(binaryPath, args, cwd, signal);

      if (result.aborted) {
        // Aborted mid-run: the child was killed inside spawnAndStream. End
        // the generator cleanly rather than surfacing the resulting
        // error/exit code.
        return;
      }
      if (result.exitCode === 0) {
        this.lastInitConfig = config;
        return;
      }
      throw new TerraformInitError(result.exitCode);
    } finally {
      this.workspaceInFlight = null;
    }
  }

  /**
   * Runs `terraform plan` with `-input=false`, `-no-color`,
   * `-out=<runDir>/<runId>.tfplan`, and `-var-file=<pulled tfvars>` flags
   * inside the Terraform composer root (`ConfigService.getTerraformDir()`),
   * yielding a {@link TerraformRunChunk} per line of output as the process
   * produces it — mirrors {@link init}'s streaming shape.
   *
   * Before spawning: mints a fresh `runId` (`randomUUID()`), creates its
   * per-run directory `<runsDir>/<runId>/` (`ConfigService.getRunsDir()`),
   * and pulls a snapshot of the current tfvars into that directory via
   * {@link pullVarFile} — so the persisted plan artifact and the exact tfvars
   * it was planned against are captured together for a later `apply()` to
   * consume (see the "Terraform run cache" row of the electron-desktop-pivot
   * design spec).
   *
   * `tfvarsVersionId`, when provided and the tfvars source is S3-backed
   * (`ConfigService.getTfvarsBucket()` resolves one), is enforced as a
   * pre-spawn staleness assertion: {@link pullVarFile} calls
   * `remoteFileStore.listVersions(key)` and compares `tfvarsVersionId`
   * against the head (most recent) entry, throwing a descriptive `Error`
   * before `terraform` is ever spawned when they no longer match — i.e. the
   * remote tfvars changed underneath the caller since they last read a
   * version id (e.g. from `TfvarsService`). `RemoteFileStore` has no
   * version-specific `get`, so this is a staleness check rather than a
   * pinned/versioned download; the plan is always run against the current
   * head object once the check passes. Ignored entirely in local-file mode
   * or when omitted.
   *
   * While streaming, stdout lines are scanned via {@link PLAN_SUMMARY_PATTERN}
   * for Terraform's summary line (`Plan: N to add, N to change, N to destroy.`)
   * to extract the resource change counts returned in the generator's return
   * value alongside `runId`, `artifactPath`, and `varFilePath`. A "no changes"
   * plan (no summary line present) resolves all three counts to `0`.
   *
   * `signal`, if provided, aborts the run the same way {@link init} does: the
   * spawned child process is killed and the generator ends cleanly — no
   * further chunks, no throw, and the generator resolves to `undefined`
   * rather than a {@link TerraformPlanResult} or a thrown
   * {@link TerraformPlanError}.
   *
   * Throws a descriptive `Error` synchronously (on the first `.next()` call)
   * if another `plan()` *or* `init()` call is already in flight on this
   * instance — both subcommands share a single {@link workspaceInFlight} lock
   * because `plan` reads the `backend/.terraform` state that `init` mutates;
   * overlapping runs against the same working directory would race.
   *
   * Throws {@link TerraformNotFoundError} if the `terraform` binary can't be
   * resolved, a plain `Error` if the configured tfvars source can't be read
   * or `tfvarsVersionId` is stale (see {@link pullVarFile}), or
   * {@link TerraformPlanError} if the spawned process exits with a non-zero
   * status code (and the run wasn't aborted).
   */
  async *plan(
    tfvarsVersionId?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TerraformRunChunk, TerraformPlanResult | undefined> {
    if (this.workspaceInFlight) {
      throw new Error(
        `TerraformService.plan() cannot run while ${this.workspaceInFlight}() is already ` +
          'running; wait for it to finish before calling plan() again.',
      );
    }
    this.workspaceInFlight = 'plan';
    try {
      if (signal?.aborted) {
        // Already aborted before we even started resolving the binary path —
        // end the generator cleanly without spawning anything.
        return undefined;
      }

      const binaryPath = await this.getBinaryPath();

      if (signal?.aborted) {
        // Aborted while resolving the binary path — end cleanly before spawn.
        return undefined;
      }

      const runId = randomUUID();
      const runDir = join(this.config.getRunsDir(), runId);
      mkdirSync(runDir, { recursive: true });

      const varFilePath = await this.pullVarFile(runDir, tfvarsVersionId);

      if (signal?.aborted) {
        // Aborted while pulling the tfvars snapshot — end cleanly before spawn.
        return undefined;
      }

      const artifactPath = join(runDir, `${runId}.tfplan`);
      const cwd = this.config.getTerraformDir();
      const args = [
        'plan',
        '-input=false',
        '-no-color',
        `-out=${artifactPath}`,
        `-var-file=${varFilePath}`,
      ];

      let add = 0;
      let change = 0;
      let destroy = 0;

      // Driven manually (rather than `yield*`) so each stdout line can be
      // scanned for the plan summary as it streams through, in addition to
      // being forwarded to the caller unmodified.
      const stream = this.spawnAndStream(binaryPath, args, cwd, signal);
      let next = await stream.next();
      try {
        while (!next.done) {
          const chunk = next.value;
          if (chunk.stream === 'stdout') {
            const match = PLAN_SUMMARY_PATTERN.exec(chunk.line);
            if (match) {
              add = Number(match[1]);
              change = Number(match[2]);
              destroy = Number(match[3]);
            }
          }
          yield chunk;
          next = await stream.next();
        }
      } finally {
        // If plan()'s own generator is terminated early (consumer break /
        // .return() / .throw()), the `yield chunk` above unwinds through
        // this finally without `next` ever reaching `done`. Explicitly
        // finalize the inner generator so its own finally (abort-listener
        // removal in spawnAndStream) still runs — mirrors what `yield*`
        // gives `init()` for free.
        if (!next.done) {
          // The forced value here is never observed by any caller (plan()
          // is already unwinding for its own reasons) — it only needs to be
          // a well-typed `SpawnStreamResult` so `.return()` can drive
          // `spawnAndStream`'s try/finally to completion.
          await stream.return({ aborted: true });
        }
      }

      const result = next.value;
      if (result.aborted) {
        // Aborted mid-run: the child was killed inside spawnAndStream. End
        // the generator cleanly rather than surfacing the resulting
        // error/exit code.
        return undefined;
      }
      if (result.exitCode === 0) {
        return { runId, artifactPath, varFilePath, add, change, destroy };
      }
      throw new TerraformPlanError(result.exitCode);
    } finally {
      this.workspaceInFlight = null;
    }
  }

  /**
   * Runs `terraform apply -input=false -no-color <planFile>` inside the
   * Terraform composer root (`ConfigService.getTerraformDir()`), yielding a
   * {@link TerraformRunChunk} per line of output as the process produces it —
   * mirrors {@link init}/{@link plan}'s streaming shape. `runId` and
   * `planFile` are expected to be the values a prior {@link plan} call
   * returned (`runId`/`artifactPath`), so the applied plan and its run record
   * live under the same `<runsDir>/<runId>/` directory.
   *
   * Before spawning: throws a descriptive `Error` synchronously (mirroring
   * the {@link workspaceInFlight} lock check below) if `runId` isn't a bare
   * path segment (see {@link RUN_ID_PATTERN} — no path separators or `.`/`..`
   * traversal segments), if `planFile` doesn't resolve exactly to
   * `<runsDir>/<runId>/<runId>.tfplan` (the only artifact path {@link plan}
   * ever produces for that `runId`), or if `planFile` doesn't exist on disk —
   * these three checks close off path traversal and applying an unrelated
   * plan artifact via caller-supplied `runId`/`planFile` values. Then, once
   * the abort signal has been checked (see below) and if `tfvarsVersionId` is
   * provided and the tfvars source is S3-backed
   * (`ConfigService.getTfvarsBucket()` resolves one), asserts that it still
   * matches the head (most recent) version of the tfvars object via
   * `remoteFileStore.listVersions(key)`, throwing {@link StalePlanError}
   * *before* `terraform` is ever spawned when they no longer match — the
   * plan being applied was generated against tfvars that have since changed
   * underneath the caller. Ignored entirely in local-file mode or when
   * `tfvarsVersionId` is omitted.
   *
   * While streaming, stdout lines are scanned via {@link APPLY_SUMMARY_PATTERN}
   * for Terraform's summary line (`Apply complete! Resources: N added, N changed, N destroyed.`)
   * to extract the resource change counts returned in the generator's return
   * value alongside `runId`. A run that never reaches the summary line (e.g.
   * it errors out first) resolves all three counts to `0`, but in that case
   * the generator throws {@link TerraformApplyError} instead of returning.
   *
   * `signal`, if provided, aborts the run the same way {@link init}/{@link plan}
   * do: the spawned child process is killed and the generator ends cleanly —
   * no further chunks, no throw.
   *
   * Once the spawned process has closed — whether it exited cleanly,
   * non-zero, or was killed via `signal` — writes a {@link TerraformRunRecord}
   * to `<runsDir>/<runId>/run.json` capturing `runId`, `kind: 'apply'`,
   * `startedAt`/`completedAt` timestamps, the process's `exitCode` (`null`
   * when killed via abort), and `tfvarsVersionId`. No record is written if
   * the process never spawned (stale-plan guard rejected, or `signal` was
   * already aborted before `getBinaryPath()`/spawn). If persisting that
   * record fails (e.g. a filesystem error), the already-computed apply
   * outcome (success/abort/{@link TerraformApplyError}) is wrapped in
   * {@link TerraformRunPersistError} and thrown instead of being discarded
   * behind the persistence failure.
   *
   * The same record is also written (with a `null` `exitCode`, mirroring the
   * abort outcome) if this generator itself is force-closed by its consumer
   * (`break`/`.return()`/`.throw()`) while the spawned `terraform apply`
   * process is still genuinely running — the finalization above lives inside
   * the generator's own body and is skipped when a forced completion unwinds
   * straight past it, so an outer `finally` persists a cancelled record on
   * that path instead, ensuring a still-running `terraform apply` killed by
   * forced cleanup is never left unrecorded. This is narrower than "a
   * process was spawned and no record was written yet": that condition alone
   * is also true when `spawnAndStream` itself throws (e.g. a spawn `error`
   * event/ENOENT, which only happens once the process has already closed) or
   * some unrelated exception fires after the child already finished — those
   * paths must let the real error/outcome propagate instead of being
   * mislabeled as cancelled, so the outer `finally` also gates on a
   * `forceKilled` flag that's only set when a genuinely still-live child was
   * force-killed.
   *
   * Throws a descriptive `Error` synchronously (on the first `.next()` call)
   * if another `apply()`, `plan()`, or `init()` call is already in flight on
   * this instance — all three subcommands share a single
   * {@link workspaceInFlight} lock because they read/write the same
   * `backend/.terraform` workspace state; overlapping runs would race — or
   * if `runId` isn't a bare path segment, `planFile` doesn't match the
   * expected `<runsDir>/<runId>/<runId>.tfplan` path, or `planFile` doesn't
   * exist on disk.
   *
   * Throws {@link TerraformNotFoundError} if the `terraform` binary can't be
   * resolved, {@link StalePlanError} if `tfvarsVersionId` no longer matches
   * the S3 tfvars head version, {@link TerraformApplyError} if the spawned
   * process exits with a non-zero status code (and the run wasn't aborted),
   * or {@link TerraformRunPersistError} if the process closed successfully
   * (or was aborted) but the run record couldn't be persisted afterward.
   */
  async *apply(
    runId: string,
    tfvarsVersionId: string | undefined,
    planFile: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TerraformRunChunk, TerraformApplyResult | undefined> {
    if (this.workspaceInFlight) {
      throw new Error(
        `TerraformService.apply() cannot run while ${this.workspaceInFlight}() is already ` +
          'running; wait for it to finish before calling apply() again.',
      );
    }
    TerraformService.assertValidRunId(runId);
    const expectedPlanFile = TerraformService.expectedPlanFilePath(this.config.getRunsDir(), runId);
    if (planFile !== expectedPlanFile) {
      throw new Error(
        `TerraformService.apply() cannot run: planFile "${planFile}" does not match the expected ` +
          `artifact path "${expectedPlanFile}" for runId "${runId}".`,
      );
    }
    if (!existsSync(planFile)) {
      throw new Error(`TerraformService.apply() cannot run: plan file "${planFile}" does not exist on disk.`);
    }
    this.workspaceInFlight = 'apply';
    // Hoisted above the try block (rather than declared where they're first
    // assigned) so the outer `finally` below can see them even when this
    // generator is force-closed (consumer `break`/`.return()`/`.throw()`):
    // a forced completion unwinds straight from the `yield chunk` below to
    // the nearest enclosing `finally`, skipping every statement that would
    // otherwise run after the inner try/finally — including the
    // `writeRunRecord` call further down. `startedAt` doubles as the "did we
    // ever spawn a process" flag (undefined until just before `spawn`), and
    // `runRecordWritten` prevents the outer `finally` from double-writing on
    // the normal completion path.
    let startedAt: string | undefined;
    let runRecordWritten = false;
    // Set to `true` only from the `onForceKill` callback passed to
    // `spawnAndStream` below, which that method invokes exclusively from its
    // own finally's "the child is still live — kill it" branch. This is
    // deliberately *not* inferred from `startedAt !== undefined &&
    // !runRecordWritten` alone — that pair is also true when `spawnAndStream`
    // throws its own spawn error (e.g. a child `error` event/ENOENT, which
    // only fires once the process has already closed) or some unrelated
    // exception occurs after the child already finished successfully or
    // failed, and neither of those is an actual cancellation.
    let forceKilled = false;
    try {
      if (signal?.aborted) {
        // Already aborted before we even started the stale-plan guard — end
        // the generator cleanly without spawning anything (and without
        // writing a run record, since no process ever ran). Checked before
        // assertPlanTfvarsNotStale so an already-aborted signal short-circuits
        // ahead of that S3 round-trip, matching plan()'s established pattern
        // of checking abort status before any expensive async work.
        return undefined;
      }

      await this.assertPlanTfvarsNotStale(tfvarsVersionId);

      if (signal?.aborted) {
        // Aborted while the stale-plan guard was checking listVersions — end
        // the generator cleanly before resolving the binary path / spawning.
        return undefined;
      }

      const binaryPath = await this.getBinaryPath();

      if (signal?.aborted) {
        // Aborted while resolving the binary path — end cleanly before spawn.
        return undefined;
      }

      const cwd = this.config.getTerraformDir();
      const args = ['apply', '-input=false', '-no-color', planFile];
      startedAt = new Date().toISOString();

      let added = 0;
      let changed = 0;
      let destroyed = 0;

      // Driven manually (rather than `yield*`) so each stdout line can be
      // scanned for the apply summary as it streams through, in addition to
      // being forwarded to the caller unmodified — mirrors plan()'s approach.
      const stream = this.spawnAndStream(binaryPath, args, cwd, signal, () => {
        forceKilled = true;
      });
      let next = await stream.next();
      try {
        while (!next.done) {
          const chunk = next.value;
          if (chunk.stream === 'stdout') {
            const match = APPLY_SUMMARY_PATTERN.exec(chunk.line);
            if (match) {
              added = Number(match[1]);
              changed = Number(match[2]);
              destroyed = Number(match[3]);
            }
          }
          yield chunk;
          next = await stream.next();
        }
      } finally {
        // If apply()'s own generator is terminated early (consumer break /
        // .return() / .throw()), the `yield chunk` above unwinds through
        // this finally without `next` ever reaching `done`. Explicitly
        // finalize the inner generator so its own finally (abort-listener
        // removal in spawnAndStream) still runs — mirrors what `yield*`
        // gives `init()` for free, and what `plan()` does above.
        if (!next.done) {
          // The forced value here is never observed by any caller (apply()
          // is already unwinding for its own reasons) — it only needs to be
          // a well-typed `SpawnStreamResult` so `.return()` can drive
          // `spawnAndStream`'s try/finally to completion.
          await stream.return({ aborted: true });
        }
      }

      const result = next.value;

      // Compute the outcome the generator would return/throw *before*
      // attempting to persist the run record, so a persistence failure below
      // can still report the real apply outcome instead of losing it behind
      // an unrelated filesystem exception.
      const outcome: TerraformApplyOutcome = result.aborted
        ? { kind: 'aborted' }
        : result.exitCode === 0
          ? { kind: 'success', result: { runId, added, changed, destroyed } }
          : { kind: 'failed', error: new TerraformApplyError(result.exitCode) };

      // The process has closed by this point regardless of `aborted` — even
      // the abort path in `spawnAndStream` only resolves once `close` (or
      // `error`) has fired — so a run record is always written here. Its own
      // exitCode is discarded by `spawnAndStream` when aborted (the caller is
      // expected to treat the run as cancelled rather than pass/fail), so
      // `null` is recorded in that case.
      //
      // `runRecordWritten` is flipped *before* the write is attempted (not
      // only on success) so the outer `finally` below never re-attempts a
      // write this block already tried — whether it succeeded or threw.
      runRecordWritten = true;
      try {
        this.writeRunRecord(runId, startedAt, result.aborted ? null : result.exitCode, tfvarsVersionId);
      } catch (err) {
        throw new TerraformRunPersistError(runId, outcome, err);
      }

      if (outcome.kind === 'aborted') {
        // Aborted mid-run: the child was killed inside spawnAndStream. End
        // the generator cleanly rather than surfacing the resulting
        // error/exit code.
        return undefined;
      }
      if (outcome.kind === 'success') {
        return outcome.result;
      }
      throw outcome.error;
    } finally {
      // Covers the force-closed generator case (consumer `break` /
      // `.return()` / `.throw()`): a forced completion unwinds straight from
      // `yield chunk` above to the inner finally (which drains
      // `spawnAndStream`, killing the child and waiting for it to actually
      // close), then continues unwinding *past* the `writeRunRecord` call
      // above — that statement is never reached — straight to this outer
      // `finally`.
      //
      // Gated on `forceKilled` (not merely `startedAt !== undefined &&
      // !runRecordWritten`) — that pair alone can't tell "the consumer
      // force-closed us while terraform was genuinely still running" apart
      // from every other way this `finally` can be reached before
      // `writeRunRecord` runs, e.g. `spawnAndStream` itself throwing (a
      // spawn `error` event/ENOENT, which only happens once the process has
      // already closed — nothing was actually killed here) or an unrelated
      // exception after the child already finished successfully or failed.
      // Those paths must let the real error/outcome propagate unmasked
      // rather than being mislabeled as a cancelled run. If a process was
      // genuinely still running and got force-killed (`forceKilled` true),
      // persist a cancelled (`exitCode: null`) run record here so the run is
      // never silently lost. Best-effort: a failure here doesn't override
      // whatever completion the generator was already unwinding for.
      if (startedAt !== undefined && !runRecordWritten && forceKilled) {
        try {
          this.writeRunRecord(runId, startedAt, null, tfvarsVersionId);
        } catch {
          // Nothing meaningful to do with a persistence failure while the
          // generator is already tearing down for an unrelated reason.
        }
      }
      this.workspaceInFlight = null;
    }
  }

  /**
   * Pre-spawn staleness guard for {@link apply}: when `tfvarsVersionId` is
   * provided and the tfvars source is S3-backed
   * (`ConfigService.getTfvarsBucket()` resolves one), asserts it still
   * matches the head (most recent) version of the tfvars object via
   * `remoteFileStore.listVersions(key)`. A no-op in local-file mode or when
   * `tfvarsVersionId` is omitted — there's no version history to compare
   * against.
   *
   * @throws {@link StalePlanError} when the head version no longer matches.
   */
  private async assertPlanTfvarsNotStale(tfvarsVersionId?: string): Promise<void> {
    if (!tfvarsVersionId) return;

    const bucket = this.config.getTfvarsBucket();
    if (!bucket) return;

    const key = basename(this.config.getTfvarsPath());
    const versions = await this.remoteFileStore.listVersions(key);
    const head = versions[0];
    if (!head || head.versionId !== tfvarsVersionId) {
      throw new StalePlanError(key, bucket, tfvarsVersionId, head?.versionId);
    }
  }

  /**
   * Writes a {@link TerraformRunRecord} to `<runsDir>/<runId>/run.json` once
   * an {@link apply} run's spawned process has closed. Creates the run
   * directory if it doesn't already exist (defensive — {@link plan} normally
   * creates it ahead of `apply`, but nothing prevents a caller from applying
   * a plan file whose directory was cleaned up in between).
   *
   * `mkdirSync`/`writeFileSync` are wrapped in a try/catch so a filesystem
   * error here (e.g. permissions, disk full, cleaned-up parent directory)
   * surfaces as a plain descriptive `Error` rather than an opaque `ENOENT`/
   * `EACCES` — {@link apply} catches it and re-throws it wrapped in
   * {@link TerraformRunPersistError} alongside the already-computed apply
   * outcome, so callers can tell a persistence failure apart from the apply
   * itself failing.
   *
   * Re-validates `runId` via {@link assertValidRunId} before joining it into
   * `runDir` — `apply()` already validates `runId` before this is called,
   * but this guard is repeated here defensively so a future caller can never
   * bypass it by skipping `apply()`'s own pre-spawn check.
   */
  private writeRunRecord(
    runId: string,
    startedAt: string,
    exitCode: number | null,
    tfvarsVersionId: string | undefined,
  ): void {
    TerraformService.assertValidRunId(runId);
    const runDir = join(this.config.getRunsDir(), runId);
    const record: TerraformRunRecord = {
      runId,
      kind: 'apply',
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode,
      tfvarsVersionId,
    };
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run.json'), JSON.stringify(record, null, 2));
    } catch (err) {
      throw new Error(
        `Failed to write terraform run record to "${join(runDir, 'run.json')}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  /**
   * Pulls the current `terraform.tfvars` — from the S3 tfvars bucket via the
   * injected `RemoteFileStore` when `ConfigService.getTfvarsBucket()`
   * resolves one (mirrors `TfvarsService.fetchRawTfvars`'s S3-mode read),
   * otherwise from the local file at `ConfigService.getTfvarsPath()` — and
   * writes a snapshot copy into `runDir` under the source file's own
   * basename, so {@link plan} runs against the exact bytes captured for this
   * run regardless of concurrent edits to the canonical source afterward.
   *
   * In S3 mode, when `tfvarsVersionId` is provided, this first calls
   * `remoteFileStore.listVersions(key)` and asserts that `tfvarsVersionId`
   * matches the head (most recent) entry *before* reading the object —
   * `RemoteFileStore.get` has no version-specific overload, so this is a
   * staleness assertion rather than a pinned/versioned read: it guards
   * against planning against tfvars that changed underneath the caller since
   * they last observed a version id, without actually downloading that
   * specific historical version.
   *
   * @returns The absolute path to the written snapshot, which {@link plan}
   *   passes to `terraform plan` as `-var-file=<path>`.
   * @throws A descriptive `Error` when the configured source (S3 object or
   *   local file) doesn't exist, or when `tfvarsVersionId` no longer matches
   *   the head version of the S3 object — a `plan()` run with no tfvars to
   *   plan against, or against tfvars known to be stale, isn't meaningful.
   */
  private async pullVarFile(runDir: string, tfvarsVersionId?: string): Promise<string> {
    const bucket = this.config.getTfvarsBucket();
    const sourcePath = this.config.getTfvarsPath();
    const destPath = join(runDir, basename(sourcePath));

    if (bucket) {
      const key = basename(sourcePath);

      if (tfvarsVersionId) {
        const versions = await this.remoteFileStore.listVersions(key);
        const head = versions[0];
        if (!head || head.versionId !== tfvarsVersionId) {
          throw new Error(
            `tfvars object "${key}" in S3 bucket "${bucket}" is stale: expected version ` +
              `"${tfvarsVersionId}" to be the current head, but the head version is ` +
              `${head ? `"${head.versionId}"` : 'missing'}. Refresh the tfvars before planning.`,
          );
        }
      }

      const obj = await this.remoteFileStore.get(key);
      if (!obj) {
        throw new Error(`tfvars object "${key}" not found in S3 bucket "${bucket}".`);
      }
      writeFileSync(destPath, obj.body);
      return destPath;
    }

    if (!existsSync(sourcePath)) {
      throw new Error(`tfvars file not found at "${sourcePath}".`);
    }
    copyFileSync(sourcePath, destPath);
    return destPath;
  }

  /**
   * Spawns `binaryPath` with `args` inside `cwd` and streams its stdout/stderr
   * as {@link TerraformRunChunk} values line-by-line as the process produces
   * them, rather than buffering until it exits. Shared by every streaming
   * subcommand runner — currently {@link init} and {@link plan}, with
   * `apply`/`destroy`/`output` expected to reuse it as they're added — so the
   * buffering/queue/wake plumbing lives in exactly one place.
   *
   * If `signal` fires while the process is still running, the child is
   * killed and the generator's return value resolves to `{ aborted: true }`
   * once the process actually closes, rather than surfacing the resulting
   * error/exit code — callers should end their own generator cleanly in that
   * case instead of throwing. Otherwise resolves to
   * `{ aborted: false, exitCode }`; callers decide what a given exit code
   * means for their own subcommand (e.g. {@link init} maps non-zero to
   * {@link TerraformInitError}).
   *
   * Throws whatever error the spawned process itself raised (e.g. `ENOENT`)
   * verbatim — that failure mode isn't subcommand-specific, so it isn't left
   * to the caller to interpret.
   *
   * `onForceKill`, if provided, is invoked synchronously — and only — from
   * this generator's own `finally` block when it force-kills a child that is
   * still genuinely running (i.e. this generator itself was force-closed by
   * its consumer, via `break`/`.return()`/`.throw()`, before the process had
   * closed on its own). It is never invoked for a spawn error (`ENOENT`
   * etc., surfaced via the thrown `closeError` above) or an abort-signal
   * kill, both of which reach `closed === true` through the normal
   * `child.on('error'/'close', ...)` handlers rather than this fallback path
   * — {@link apply} uses this distinction to tell "the process was actually
   * live and we just killed it" apart from every other reason its own outer
   * `finally` might run before it's written a run record.
   */
  private async *spawnAndStream(
    binaryPath: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    onForceKill?: () => void,
  ): AsyncGenerator<TerraformRunChunk, SpawnStreamResult> {
    const child = spawn(binaryPath, args, { cwd });
    const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };

    const queue: TerraformRunChunk[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let closeError: Error | null = null;
    let exitCode: number | null = null;
    // Latched the instant the abort listener fires (while the child is still
    // live), rather than read from `signal.aborted` after the loop below
    // exits — an abort that fires after the process has already closed
    // cleanly would otherwise race a post-hoc `signal.aborted` read and
    // misclassify a successful run as aborted.
    let aborted = false;

    const notify = (): void => {
      wake?.();
      wake = null;
    };

    const push = (chunk: TerraformRunChunk): void => {
      queue.push(chunk);
      notify();
    };

    const handleData = (stream: 'stdout' | 'stderr', data: Buffer | string): void => {
      buffers[stream] += data.toString();
      const lines = buffers[stream].split(/\r?\n/);
      // The last element is either an empty string (data ended on a
      // newline) or an incomplete trailing line — hold it back until more
      // data (or `close`) completes it.
      buffers[stream] = lines.pop() ?? '';
      for (const line of lines) {
        push({ stream, line });
      }
    };

    child.stdout?.on('data', (data: Buffer) => handleData('stdout', data));
    child.stderr?.on('data', (data: Buffer) => handleData('stderr', data));

    child.on('error', (err: Error) => {
      closeError = err;
      closed = true;
      notify();
    });

    child.on('close', (code: number | null) => {
      for (const stream of ['stdout', 'stderr'] as const) {
        if (buffers[stream].length > 0) {
          push({ stream, line: buffers[stream] });
          buffers[stream] = '';
        }
      }
      exitCode = code;
      closed = true;
      notify();
    });

    const onAbort = (): void => {
      // Guard against an abort event that fires after the child has already
      // closed (success or failure) — without this, a late-firing signal
      // would retroactively misclassify an already-completed run as
      // aborted.
      if (closed) {
        return;
      }
      aborted = true;
      child.kill();
    };
    signal?.addEventListener('abort', onAbort);

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (closed) {
          break;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }

      if (aborted) {
        return { aborted: true };
      }
      if (closeError) {
        throw closeError;
      }
      return { aborted: false, exitCode };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (!closed) {
        // The generator was force-closed early (e.g. plan()'s own finally
        // calling `stream.return()` when its consumer breaks/throws) before
        // the child process actually exited. Removing the abort listener
        // alone leaves Terraform (and its stdout/stderr listeners) running
        // in the background — explicitly kill the child and wait for it to
        // actually close before this generator resolves, so forced cleanup
        // terminates the underlying process instead of orphaning it.
        //
        // The child is genuinely still live at this point (its `close`/
        // `error` handlers never fired, or `closed` would already be
        // `true`) — notify the caller via `onForceKill` so it can
        // distinguish this from every other way its own cleanup logic might
        // run.
        onForceKill?.();
        child.kill();
        await new Promise<void>((resolve) => {
          if (closed) {
            resolve();
            return;
          }
          child.once('close', () => resolve());
          child.once('error', () => resolve());
        });
      }
    }
  }

  /**
   * Field-by-field equality check between two {@link TerraformInitConfig}
   * values, used by {@link init} to decide whether a repeat call is a no-op.
   */
  private static sameBackendConfig(a: TerraformInitConfig, b: TerraformInitConfig): boolean {
    return a.bucket === b.bucket && a.region === b.region && a.dynamodbTable === b.dynamodbTable;
  }

  /**
   * Throws a descriptive `Error` unless `runId` is a bare path segment
   * matching {@link RUN_ID_PATTERN}. Guards every place `runId` is joined
   * into a filesystem path — {@link apply}'s pre-spawn checks and
   * {@link writeRunRecord} — against path traversal (`../`, absolute paths,
   * embedded separators) via a caller-supplied `runId`.
   */
  private static assertValidRunId(runId: string): void {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error(`TerraformService: runId "${runId}" is not a valid run id.`);
    }
  }

  /**
   * Returns the single filesystem path {@link apply} accepts as `planFile`
   * for a given `runId` — `<runsDir>/<runId>/<runId>.tfplan`, matching where
   * {@link plan} persists its `.tfplan` artifact. Centralizing this lets
   * `apply` reject any `planFile` that doesn't resolve exactly to it, rather
   * than trusting a caller-supplied path that could point at an unrelated
   * plan artifact.
   */
  private static expectedPlanFilePath(runsDir: string, runId: string): string {
    return join(runsDir, runId, `${runId}.tfplan`);
  }

  /**
   * Shells out to `which terraform` (POSIX) or `where.exe terraform`
   * (Windows) and returns the first non-empty line of stdout as the
   * absolute binary path. Any failure (binary missing, lookup command
   * missing, empty output) is normalized to {@link TerraformNotFoundError}.
   */
  private static async resolveBinaryPath(): Promise<string> {
    const lookupCommand = lookupCommandFor(process.platform);
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(lookupCommand, ['terraform']));
    } catch {
      throw new TerraformNotFoundError(lookupCommand);
    }
    const firstLine = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) {
      throw new TerraformNotFoundError(lookupCommand);
    }
    return firstLine;
  }

  /**
   * Runs `terraform version -json` against the resolved binary and extracts
   * `terraform_version` from the parsed JSON output. Falls back to parsing
   * the plain-text `terraform version` output (matching the
   * `Terraform v<version>` line) if the `-json` output isn't valid JSON —
   * older terraform releases predate the `-json` flag. The binary itself has
   * already been located at this point, so a failure to parse its version
   * output is a plain descriptive `Error`, not a {@link TerraformNotFoundError}.
   */
  private static async resolveVersion(binaryPath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(binaryPath, ['version', '-json']);
      const parsed = JSON.parse(stdout) as { terraform_version?: unknown };
      if (typeof parsed.terraform_version === 'string' && parsed.terraform_version.length > 0) {
        return parsed.terraform_version;
      }
    } catch {
      // `-json` output missing/unparseable (e.g. an older terraform release
      // that predates the flag) — fall back to plain-text parsing below.
    }
    const { stdout } = await execFileAsync(binaryPath, ['version']);
    const match = /Terraform\s+v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(stdout);
    if (!match) {
      throw new Error(`Unable to parse terraform version from output: ${stdout}`);
    }
    return match[1];
  }
}
