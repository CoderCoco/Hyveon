import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Absolute path to the script under test. */
const SCRIPT_PATH = join(__dirname, 'fake-terraform.mjs');

/** Directories created by {@link writeFixture} during the current test, removed in `afterEach`. */
const tempDirs: string[] = [];

/**
 * Writes the given fixture object to a fresh temp file and returns its path.
 * The containing temp directory is tracked so it can be cleaned up after
 * the test that created it finishes.
 *
 * @param fixture - The fixture object to serialize as JSON, or a raw string
 *   to write verbatim (used to exercise the invalid-JSON error path).
 * @returns The absolute path to the written fixture file.
 */
function writeFixture(fixture: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-terraform-test-'));
  tempDirs.push(dir);
  const fixturePath = join(dir, 'fixture.json');
  const contents = typeof fixture === 'string' ? fixture : JSON.stringify(fixture);
  writeFileSync(fixturePath, contents, 'utf8');
  return fixturePath;
}

/**
 * Spawns `fake-terraform.mjs` synchronously with the given CLI args and
 * `FAKE_TERRAFORM_SCRIPT` env var, returning its captured stdout/stderr and
 * exit code once the process has finished.
 *
 * @param args - CLI arguments to pass, e.g. `['plan', '-out=tfplan']`.
 * @param scriptPath - Value for `FAKE_TERRAFORM_SCRIPT`, or `undefined` to
 *   leave it unset (exercising the missing-env-var error path).
 * @returns The spawned process's stdout, stderr, and exit code.
 */
function runFakeTerraform(args: string[], scriptPath: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (scriptPath === undefined) {
    delete env.FAKE_TERRAFORM_SCRIPT;
  } else {
    env.FAKE_TERRAFORM_SCRIPT = scriptPath;
  }

  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    env,
    encoding: 'utf8',
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('fake-terraform.mjs', () => {
  it('should exit 1 and report a stderr message when FAKE_TERRAFORM_SCRIPT is unset', () => {
    const { exitCode, stderr } = runFakeTerraform(['plan'], undefined);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('fake-terraform: FAKE_TERRAFORM_SCRIPT env var is not set');
  });

  it('should exit 1 and report a stderr message when the fixture file cannot be read', () => {
    const missingPath = join(tmpdir(), 'fake-terraform-test-does-not-exist.json');

    const { exitCode, stderr } = runFakeTerraform(['plan'], missingPath);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`could not read fixture file at "${missingPath}"`);
  });

  it('should exit 1 and report a stderr message when the fixture file is not valid JSON', () => {
    const fixturePath = writeFixture('{ not valid json');

    const { exitCode, stderr } = runFakeTerraform(['plan'], fixturePath);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`fixture file at "${fixturePath}" is not valid JSON`);
  });

  it('should exit 1 and report a stderr message when the fixture is not a JSON object', () => {
    const fixturePath = writeFixture(['plan', 'apply']);

    const { exitCode, stderr } = runFakeTerraform(['plan'], fixturePath);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      `fixture file at "${fixturePath}" must contain a JSON object keyed by subcommand.`,
    );
  });

  it('should exit 1 and report a stderr message when no subcommand is provided', () => {
    const fixturePath = writeFixture({ plan: { exitCode: 0, lines: [] } });

    const { exitCode, stderr } = runFakeTerraform([], fixturePath);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('no subcommand provided. Expected one of: init, plan, apply, destroy, output');
  });

  it('should exit 1 and list scripted subcommands when the fixture has no entry for the given subcommand', () => {
    const fixturePath = writeFixture({ plan: { exitCode: 0, lines: [] } });

    const { exitCode, stderr } = runFakeTerraform(['destroy'], fixturePath);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      `no scripted response for subcommand "destroy" in fixture "${fixturePath}"`,
    );
    expect(stderr).toContain('Scripted subcommands: plan');
  });

  it('should emit scripted lines to their target streams in array order and exit 0 by default', () => {
    const fixturePath = writeFixture({
      plan: {
        lines: [
          { stream: 'stdout', text: 'Refreshing state...' },
          { stream: 'stderr', text: 'Warning: deprecated argument' },
          { stream: 'stdout', text: 'Plan: 1 to add, 0 to change, 0 to destroy.' },
        ],
      },
    });

    const { exitCode, stdout, stderr } = runFakeTerraform(['plan', '-out=tfplan'], fixturePath);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('Refreshing state...\nPlan: 1 to add, 0 to change, 0 to destroy.\n');
    expect(stderr).toBe('Warning: deprecated argument\n');
  });

  it('should exit with the scripted exit code', () => {
    const fixturePath = writeFixture({
      destroy: {
        exitCode: 2,
        lines: [{ stream: 'stderr', text: 'Error: destroy failed' }],
      },
    });

    const { exitCode, stderr } = runFakeTerraform(['destroy'], fixturePath);

    expect(exitCode).toBe(2);
    expect(stderr).toBe('Error: destroy failed\n');
  });

  it('should honor per-line delayMs while still emitting lines in array order', () => {
    // Large enough to dominate spawnSync's process-startup overhead
    // (~30-35ms locally, often higher on loaded CI). A smaller delayMs would
    // let the lower-bound assertion below pass on process-startup time alone
    // even if delayMs handling were removed entirely.
    const scriptedDelayMs = 300;
    const fixturePath = writeFixture({
      apply: {
        lines: [
          { stream: 'stdout', text: 'first', delayMs: scriptedDelayMs },
          { stream: 'stdout', text: 'second' },
        ],
      },
    });

    // performance.now() is monotonic (unlike Date.now(), which tracks wall-clock
    // time and can jump backwards under NTP/VM clock adjustments — observed as a
    // negative elapsedMs under coverage-run parallel worker load).
    const startedAt = performance.now();
    const { exitCode, stdout } = runFakeTerraform(['apply'], fixturePath);
    const elapsedMs = performance.now() - startedAt;

    expect(exitCode).toBe(0);
    expect(stdout).toBe('first\nsecond\n');
    // Lower-bound only: proves the script actually awaited delayMs rather
    // than emitting both lines immediately (which would make this a no-op
    // assertion on delay behaviour despite the test name).
    expect(elapsedMs).toBeGreaterThanOrEqual(scriptedDelayMs);
  });
});
