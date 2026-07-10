/**
 * Vitest CLI spec for init-parent.ts's `bootstrap --s3-tfvars` flag and both
 * `migrate --to-s3` / `migrate --to-local` directions (issue #89). Covers CLI
 * argument parsing plus the actual file-system effects of each flow.
 *
 * `node:readline/promises` and `node:child_process`'s `spawnSync` are mocked
 * so no real interactive prompts or `make` invocations happen; the S3 client
 * is mocked via `aws-sdk-client-mock`, the same approach `tfvars-sync.test.ts`
 * uses. `renderMakefile`/`renderTfvars`/etc.'s own render-shape checks live in
 * `init-parent.test.ts` — this spec only asserts the CLI dispatch + IO
 * behaviour layered on top of them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Interface } from 'node:readline/promises';

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));
// Preserves every other `node:process` export (cwd, stdin, stdout, argv, ...)
// but replaces `exit` with a no-op mock, so the drift-abort / make-setup-failure
// branches in init-parent.ts (which call `exit(1)` then `return;`) can be
// exercised without actually killing the Vitest worker process.
vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:process')>();
  return { ...actual, exit: vi.fn() };
});

import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { exit } from 'node:process';
import { CliUsageError, parseCliArgs, runBootstrap, runMigrate } from './init-parent.ts';

/** Typed stand-in for the AWS S3 SDK client — patches every `new S3Client()` instance (shared by tfvars-sync.ts's pull/diff calls). */
const s3Mock = mockClient(S3Client);

/** Builds a fake `GetObjectCommand` `Body` whose `transformToString()` resolves to `content`. */
function fakeBody(content: string): { transformToString: () => Promise<string> } {
  return { transformToString: async () => content };
}

/**
 * Wires the mocked `node:readline/promises` `createInterface` to hand back
 * `answers` in order, one per `question()` call — mirroring the sequence of
 * prompts `runBootstrap` asks. Throws if more questions are asked than
 * answers were queued, so a spec fails loudly (instead of silently reading
 * `undefined`) if a code change adds an unexpected prompt.
 */
function queueReadlineAnswers(answers: string[]): void {
  const queue = [...answers];
  const stub: Partial<Interface> = {
    question: vi.fn(async () => {
      if (queue.length === 0) throw new Error('queueReadlineAnswers: ran out of queued answers');
      return queue.shift() as string;
    }),
    close: vi.fn(),
  };
  vi.mocked(createInterface).mockReturnValue(stub as Interface);
}

describe('parseCliArgs', () => {
  it('should default to bootstrap with s3Tfvars false when no flags are given', () => {
    expect(parseCliArgs([])).toEqual({ command: 'bootstrap', force: false, s3Tfvars: false, yes: false });
  });

  it('should set s3Tfvars true for "bootstrap --s3-tfvars"', () => {
    expect(parseCliArgs(['--s3-tfvars'])).toEqual({ command: 'bootstrap', force: false, s3Tfvars: true, yes: false });
  });

  it('should set direction "to-s3" for "migrate --to-s3"', () => {
    expect(parseCliArgs(['migrate', '--to-s3'])).toEqual({
      command: 'migrate',
      force: false,
      s3Tfvars: false,
      yes: false,
      direction: 'to-s3',
    });
  });

  it('should set direction "to-local" for "migrate --to-local"', () => {
    expect(parseCliArgs(['migrate', '--to-local'])).toEqual({
      command: 'migrate',
      force: false,
      s3Tfvars: false,
      yes: false,
      direction: 'to-local',
    });
  });

  it('should throw CliUsageError when migrate is given neither --to-s3 nor --to-local', () => {
    expect(() => parseCliArgs(['migrate'])).toThrow(CliUsageError);
    expect(() => parseCliArgs(['migrate'])).toThrow('migrate requires exactly one of --to-s3 | --to-local.');
  });

  it('should throw CliUsageError when migrate is given both --to-s3 and --to-local', () => {
    expect(() => parseCliArgs(['migrate', '--to-s3', '--to-local'])).toThrow(CliUsageError);
  });
});

describe('runBootstrap --s3-tfvars', () => {
  let parentDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), 'init-parent-cli-test-')));
    parentDir = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('should write the .gsd/tfvars-bucket marker (and the rest of the scaffold) when --s3-tfvars is passed', async () => {
    queueReadlineAnswers([
      parentDir, // Parent repo path
      'Hyveon', // Submodule path
      'test-parent', // Project name
      'us-east-1', // AWS region
      'example.com', // Route 53 hosted zone
      '', // API_TOKEN (accept generated)
      'n', // Seed Discord credentials?
    ]);

    const { s3Tfvars } = parseCliArgs(['--s3-tfvars']);
    expect(s3Tfvars).toBe(true);

    await runBootstrap({ s3Tfvars, yes: false });

    const markerPath = join(parentDir, '.gsd', 'tfvars-bucket');
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, 'utf8')).toBe('test-parent-tfvars\n');

    const makefile = readFileSync(join(parentDir, 'Makefile'), 'utf8');
    expect(makefile).toContain('PARENT_TFVARS_MARKER := $(REPO_ROOT)/.gsd/tfvars-bucket');
    expect(existsSync(join(parentDir, 'terraform.tfvars'))).toBe(true);
    expect(existsSync(join(parentDir, '.env'))).toBe(true);
  });

  it('should NOT write the .gsd/tfvars-bucket marker when --s3-tfvars is omitted and --yes defaults the prompt to no', async () => {
    queueReadlineAnswers([
      parentDir, // Parent repo path
      'Hyveon', // Submodule path
      'test-parent', // Project name
      'us-east-1', // AWS region
      'example.com', // Route 53 hosted zone
      '', // API_TOKEN (accept generated)
      'n', // Seed Discord credentials?
      // No S3-tfvars prompt answer needed — `yes: true` without `s3Tfvars` skips it, defaulting to no.
    ]);

    const { s3Tfvars, yes } = parseCliArgs(['--yes']);
    expect(s3Tfvars).toBe(false);

    await runBootstrap({ s3Tfvars, yes });

    expect(existsSync(join(parentDir, '.gsd', 'tfvars-bucket'))).toBe(false);
  });
});

describe('runMigrate --to-s3', () => {
  let parentDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), 'init-parent-cli-test-')));
    parentDir = process.cwd();

    // Minimal already-scaffolded parent repo: a Makefile with just the
    // SUBMODULE line readExistingParent()/locateExistingParent() parse, and a
    // terraform.tfvars carrying project_name.
    writeFileSync(join(parentDir, 'Makefile'), 'SUBMODULE   := $(REPO_ROOT)/Hyveon\n');
    writeFileSync(join(parentDir, 'terraform.tfvars'), 'project_name = "test-parent"\n');

    const success: Partial<ReturnType<typeof spawnSync>> = { status: 0, error: undefined };
    vi.mocked(spawnSync).mockReturnValue(success as ReturnType<typeof spawnSync>);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('should write the tfvars-bucket marker, rewrite the Makefile with s3-aware targets, and run `make setup` with GSD_TFVARS_BACKEND=s3', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { direction } = parseCliArgs(['migrate', '--to-s3']);
    expect(direction).toBe('to-s3');

    await runMigrate('to-s3', { yes: true });

    const markerPath = join(parentDir, '.gsd', 'tfvars-bucket');
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, 'utf8')).toBe('test-parent-tfvars\n');

    const makefile = readFileSync(join(parentDir, 'Makefile'), 'utf8');
    expect(makefile).toContain('PARENT_TFVARS_MARKER := $(REPO_ROOT)/.gsd/tfvars-bucket');
    // terraform.tfvars itself is left untouched by migrate --to-s3.
    expect(readFileSync(join(parentDir, 'terraform.tfvars'), 'utf8')).toBe('project_name = "test-parent"\n');

    expect(spawnSync).toHaveBeenCalledWith(
      'make',
      ['setup'],
      expect.objectContaining({ cwd: parentDir, env: expect.objectContaining({ GSD_TFVARS_BACKEND: 's3' }) }),
    );

    // One-time note pointing operators at `make tfvars-pull` to fetch
    // terraform.tfvars back down, since migrate --to-s3 never writes it itself.
    const written = writeSpy.mock.calls.map((args) => String(args[0])).join('');
    expect(written).toContain('make tfvars-pull');
  });

  it('should make no changes and never call spawnSync when the confirmation prompt is declined', async () => {
    queueReadlineAnswers(['n']); // Declines the "Proceed?" prompt.

    await runMigrate('to-s3', { yes: false });

    expect(existsSync(join(parentDir, '.gsd', 'tfvars-bucket'))).toBe(false);
    expect(readFileSync(join(parentDir, 'Makefile'), 'utf8')).toBe('SUBMODULE   := $(REPO_ROOT)/Hyveon\n');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('should exit 1 without rolling back the marker/Makefile when `make setup` fails', async () => {
    const failure: Partial<ReturnType<typeof spawnSync>> = { status: 1, error: undefined };
    vi.mocked(spawnSync).mockReturnValue(failure as ReturnType<typeof spawnSync>);

    await runMigrate('to-s3', { yes: true });

    expect(vi.mocked(exit)).toHaveBeenCalledWith(1);
    // Marker + Makefile are written before `make setup` runs — a failed
    // `make setup` doesn't roll them back, so a re-run only needs to retry it.
    expect(existsSync(join(parentDir, '.gsd', 'tfvars-bucket'))).toBe(true);
    expect(readFileSync(join(parentDir, 'Makefile'), 'utf8')).toContain('PARENT_TFVARS_MARKER := $(REPO_ROOT)/.gsd/tfvars-bucket');
  });
});

describe('runMigrate --to-local', () => {
  let parentDir: string;
  let originalCwd: string;
  const tfvarsContent = 'project_name = "test-parent"\n';

  beforeEach(() => {
    originalCwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), 'init-parent-cli-test-')));
    parentDir = process.cwd();
    s3Mock.reset();

    writeFileSync(join(parentDir, 'Makefile'), 'SUBMODULE   := $(REPO_ROOT)/Hyveon\n');
    writeFileSync(join(parentDir, 'terraform.tfvars'), tfvarsContent);
    mkdirSync(join(parentDir, '.gsd'), { recursive: true });
    writeFileSync(join(parentDir, '.gsd', 'tfvars-bucket'), 'test-parent-tfvars\n');
    writeFileSync(join(parentDir, 'terraform.tfvars.lock'), '{}\n');

    // Remote object exists (lockStatus()'s HeadObjectCommand check) and its
    // content matches local, so diffTfvars() reports no drift and the
    // migration is allowed to delete the markers.
    s3Mock.on(HeadObjectCommand).resolves({ VersionId: 'v1', ETag: '"etag-1"' });
    s3Mock.on(GetObjectCommand).resolves({ Body: fakeBody(tfvarsContent) as never });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('should delete the tfvars-bucket marker and lock sidecar, leaving terraform.tfvars untouched, when local and remote match', async () => {
    const { direction } = parseCliArgs(['migrate', '--to-local']);
    expect(direction).toBe('to-local');

    await runMigrate('to-local', { yes: true });

    expect(existsSync(join(parentDir, '.gsd', 'tfvars-bucket'))).toBe(false);
    expect(existsSync(join(parentDir, 'terraform.tfvars.lock'))).toBe(false);
    expect(readFileSync(join(parentDir, 'terraform.tfvars'), 'utf8')).toBe(tfvarsContent);
  });
});

describe('runMigrate --to-local (terraform.tfvars missing locally)', () => {
  let parentDir: string;
  let originalCwd: string;
  const remoteContent = 'project_name = "test-parent"\n';

  beforeEach(() => {
    originalCwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), 'init-parent-cli-test-')));
    parentDir = process.cwd();
    s3Mock.reset();

    writeFileSync(join(parentDir, 'Makefile'), 'SUBMODULE   := $(REPO_ROOT)/Hyveon\n');
    mkdirSync(join(parentDir, '.gsd'), { recursive: true });
    writeFileSync(join(parentDir, '.gsd', 'tfvars-bucket'), 'test-parent-tfvars\n');
    // Deliberately no terraform.tfvars written — this parent repo is currently
    // sourcing it purely from S3, so runMigrateToLocal must pull one down
    // first (before the drift check can even run).

    s3Mock.on(HeadObjectCommand).resolves({ VersionId: 'v1', ETag: '"etag-1"' });
    s3Mock.on(GetObjectCommand).resolves({ Body: fakeBody(remoteContent) as never });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('should pull terraform.tfvars from S3 before the drift check runs when it is missing locally', async () => {
    await runMigrate('to-local', { yes: true });

    // pullTfvars() wrote the local file before diffTfvars() compared it —
    // proven by the migration completing cleanly (markers deleted): if the
    // pull hadn't happened first, diffTfvars would have compared against a
    // missing/empty local file and aborted instead.
    expect(readFileSync(join(parentDir, 'terraform.tfvars'), 'utf8')).toBe(remoteContent);
    expect(existsSync(join(parentDir, '.gsd', 'tfvars-bucket'))).toBe(false);
    // pullTfvars() also writes terraform.tfvars.lock as a side effect of the
    // pull-if-missing step — the migration must still delete it, not just the
    // lock that existed (or didn't) before the pull ran.
    expect(existsSync(join(parentDir, 'terraform.tfvars.lock'))).toBe(false);
  });
});

describe('runMigrate --to-local (drift abort)', () => {
  let parentDir: string;
  let originalCwd: string;
  const localContent = 'project_name = "test-parent"\n';
  const remoteContent = 'project_name = "test-parent-DRIFTED"\n';

  beforeEach(() => {
    originalCwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), 'init-parent-cli-test-')));
    parentDir = process.cwd();
    s3Mock.reset();

    writeFileSync(join(parentDir, 'Makefile'), 'SUBMODULE   := $(REPO_ROOT)/Hyveon\n');
    writeFileSync(join(parentDir, 'terraform.tfvars'), localContent);
    mkdirSync(join(parentDir, '.gsd'), { recursive: true });
    writeFileSync(join(parentDir, '.gsd', 'tfvars-bucket'), 'test-parent-tfvars\n');
    writeFileSync(join(parentDir, 'terraform.tfvars.lock'), '{}\n');

    // Remote object exists but its content differs from local, so
    // diffTfvars() reports drift and the migration must abort without
    // touching any files.
    s3Mock.on(HeadObjectCommand).resolves({ VersionId: 'v1', ETag: '"etag-1"' });
    s3Mock.on(GetObjectCommand).resolves({ Body: fakeBody(remoteContent) as never });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('should abort without deleting markers/lock or touching terraform.tfvars when local and remote have drifted', async () => {
    await runMigrate('to-local', { yes: true });

    expect(vi.mocked(exit)).toHaveBeenCalledWith(1);
    expect(existsSync(join(parentDir, '.gsd', 'tfvars-bucket'))).toBe(true);
    expect(existsSync(join(parentDir, 'terraform.tfvars.lock'))).toBe(true);
    expect(readFileSync(join(parentDir, 'terraform.tfvars'), 'utf8')).toBe(localContent);
  });
});

describe('runMigrate --to-local (bucket never seeded)', () => {
  let parentDir: string;
  let originalCwd: string;
  const tfvarsContent = 'project_name = "test-parent"\n';

  beforeEach(() => {
    originalCwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), 'init-parent-cli-test-')));
    parentDir = process.cwd();
    s3Mock.reset();

    writeFileSync(join(parentDir, 'Makefile'), 'SUBMODULE   := $(REPO_ROOT)/Hyveon\n');
    writeFileSync(join(parentDir, 'terraform.tfvars'), tfvarsContent);
    mkdirSync(join(parentDir, '.gsd'), { recursive: true });
    writeFileSync(join(parentDir, '.gsd', 'tfvars-bucket'), 'test-parent-tfvars\n');
    writeFileSync(join(parentDir, 'terraform.tfvars.lock'), '{}\n');

    // The bucket marker exists (e.g. `bootstrap --s3-tfvars` ran) but the
    // remote object was never seeded (the initial `make tfvars-push`/pull
    // step was skipped) — lockStatus()'s HeadObjectCommand check reports the
    // object missing, so there is nothing remote to diff against or strand.
    s3Mock.on(HeadObjectCommand).rejects({ name: 'NotFound', $metadata: { httpStatusCode: 404 } });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('should proceed with the migration instead of reporting drift when the remote object was never seeded', async () => {
    await runMigrate('to-local', { yes: true });

    expect(vi.mocked(exit)).not.toHaveBeenCalled();
    expect(existsSync(join(parentDir, '.gsd', 'tfvars-bucket'))).toBe(false);
    expect(existsSync(join(parentDir, 'terraform.tfvars.lock'))).toBe(false);
    expect(readFileSync(join(parentDir, 'terraform.tfvars'), 'utf8')).toBe(tfvarsContent);
  });
});
