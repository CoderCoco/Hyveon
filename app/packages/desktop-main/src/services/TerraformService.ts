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
 * Lazily resolves and caches the system `terraform` binary's absolute path
 * and semver version, and orchestrates `terraform` subcommands against it:
 * {@link TerraformService.init}, the streaming/idempotent `terraform init`
 * runner, and {@link TerraformService.plan}, the streaming `terraform plan`
 * runner that persists its `.tfplan` artifact and the pulled tfvars snapshot
 * under `ConfigService.getRunsDir()`. Later child issues of Epic D add
 * `apply`/`destroy`/`output` — see the "Terraform orchestrator" section of
 * the electron-desktop-pivot design spec.
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
   * `true` while an {@link init} call is actively running (from the moment
   * its generator body starts executing, i.e. the first `.next()` call, until
   * it completes or throws). Guards against a second concurrent `init()` call
   * racing the first against the same `terraform` working directory.
   */
  private initInFlight = false;

  /**
   * `true` while a {@link plan} call is actively running (from the moment its
   * generator body starts executing until it completes or throws). Guards
   * against a second concurrent `plan()` call racing the first against the
   * same working directory/runs directory. Tracked separately from
   * {@link initInFlight} since `init` and `plan` are distinct subcommands.
   */
  private planInFlight = false;

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
   * if another `init()` call is already in flight on this instance — overlapping
   * `terraform init` runs against the same working directory would race.
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
    if (this.initInFlight) {
      throw new Error(
        'TerraformService.init() is already running; wait for it to finish before calling init() again.',
      );
    }
    this.initInFlight = true;
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
      this.initInFlight = false;
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
   * if another `plan()` call is already in flight on this instance.
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
    if (this.planInFlight) {
      throw new Error(
        'TerraformService.plan() is already running; wait for it to finish before calling plan() again.',
      );
    }
    this.planInFlight = true;
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
      this.planInFlight = false;
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
   */
  private async *spawnAndStream(
    binaryPath: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TerraformRunChunk, SpawnStreamResult> {
    const child = spawn(binaryPath, args, { cwd });
    const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };

    const queue: TerraformRunChunk[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let closeError: Error | null = null;
    let exitCode: number | null = null;

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

      if (signal?.aborted) {
        return { aborted: true };
      }
      if (closeError) {
        throw closeError;
      }
      return { aborted: false, exitCode };
    } finally {
      signal?.removeEventListener('abort', onAbort);
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
