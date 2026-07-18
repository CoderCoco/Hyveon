import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { ConfigService } from './ConfigService.js';

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
 * Lazily resolves and caches the system `terraform` binary's absolute path
 * and semver version, and orchestrates `terraform` subcommands against it —
 * starting with {@link TerraformService.init}, the streaming/idempotent
 * `terraform init` runner. Later child issues of Epic D add
 * `plan`/`apply`/`destroy`/`output` — see the "Terraform orchestrator"
 * section of the electron-desktop-pivot design spec.
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

  /** `config` resolves the terraform working directory (`getTerraformDir()`) for `init`/`plan`/`apply`/`destroy`/`output`. */
  constructor(private readonly config: ConfigService) {}

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

      const binaryPath = await this.getBinaryPath();
      const cwd = this.config.getTerraformDir();
      const args = [
        'init',
        '-input=false',
        '-no-color',
        `-backend-config=bucket=${config.bucket}`,
        `-backend-config=region=${config.region}`,
        `-backend-config=dynamodb_table=${config.dynamodbTable}`,
      ];

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
          // Aborted mid-run: the child was killed above. End the generator
          // cleanly rather than surfacing the resulting error/exit code.
          return;
        }
        if (closeError) {
          throw closeError;
        }
        if (exitCode === 0) {
          this.lastInitConfig = config;
          return;
        }
        throw new TerraformInitError(exitCode);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    } finally {
      this.initInFlight = false;
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
