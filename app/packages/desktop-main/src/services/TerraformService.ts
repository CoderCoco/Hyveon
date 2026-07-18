import { execFile } from 'node:child_process';
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
 * Lazily resolves and caches the system `terraform` binary's absolute path
 * and semver version. This is the seam every later
 * `init`/`plan`/`apply`/`destroy`/`output` orchestration method (added in
 * later child issues of Epic D) will spawn against — see the "Terraform
 * orchestrator" section of the electron-desktop-pivot design spec.
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
   * `config` isn't consumed yet — it's the seam a later child issue of Epic D
   * will use to resolve the terraform working directory for
   * `init`/`plan`/`apply`/`destroy`/`output`. The `void` below is a
   * deliberate no-op read so `noUnusedLocals` doesn't flag the property
   * before that consumer exists; remove it once `this.config` is used for
   * real.
   */
  constructor(private readonly config: ConfigService) {
    void this.config;
  }

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
