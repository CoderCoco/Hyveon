import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * Spy variables must be hoisted before vi.mock() factories run, because
 * vi.mock() calls are lifted to the top of the compiled output above regular
 * declarations.
 */
const { execFileMock } = vi.hoisted(() => {
  const execFileMock = vi.fn();
  return { execFileMock };
});

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: vi.fn(),
}));

import { TerraformService } from './TerraformService.js';
import { projectTfOutputs, type ConfigService, type RawTfState, type TfOutputs } from './ConfigService.js';
import type { RemoteFileStore } from '@hyveon/shared';

/** Error-first callback shape `util.promisify` invokes the mocked `execFile` with. */
type ExecFileCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

/**
 * Extracts the error-first callback from an `execFile` call's arguments,
 * regardless of whether `util.promisify` invoked it with or without an
 * `options` object.
 */
function lastArgAsCallback(args: unknown[]): ExecFileCallback {
  return args[args.length - 1] as ExecFileCallback;
}

/** Queues a successful `execFile` invocation (stdout/stderr) for the next call. */
function queueExecFileSuccess(stdout: string, stderr = ''): void {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    lastArgAsCallback(args)(null, { stdout, stderr });
  });
}

/** Queues a failing `execFile` invocation (e.g. a non-zero `terraform output` exit). */
function queueExecFileFailure(error: Error = new Error('exit status 1')): void {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    lastArgAsCallback(args)(error);
  });
}

/** Queues a successful binary lookup followed by a successful `-json` version response. */
function queueSuccessfulResolution(binaryPath = '/usr/local/bin/terraform', version = '1.7.0'): void {
  queueExecFileSuccess(`${binaryPath}\n`);
  queueExecFileSuccess(JSON.stringify({ terraform_version: version }));
}

/**
 * Minimal `ConfigService` stub sufficient for `output()`: only
 * `getTerraformDir()` is read (as the spawned process's `cwd`).
 */
function stubOutputConfigService(terraformDir = '/repo/terraform'): ConfigService {
  return { getTerraformDir: () => terraformDir } as ConfigService;
}

/**
 * Minimal `RemoteFileStore` stub sufficient to satisfy `TerraformService`'s
 * constructor dependency — `output()` never touches it.
 */
function stubRemoteFileStore(): RemoteFileStore {
  return {} as RemoteFileStore;
}

/** A minimal, well-formed `terraform output -json` payload for one output key. */
const SAMPLE_STDOUT = JSON.stringify({
  aws_region: { value: 'us-east-1' },
  ecs_cluster_name: { value: 'hyveon-cluster' },
  game_names: { value: ['minecraft'] },
});

beforeEach(() => {
  execFileMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TerraformService.output first call', () => {
  it('should spawn terraform output -json and resolve to the exact TfOutputs shape projectTfOutputs produces', async () => {
    queueSuccessfulResolution('/usr/local/bin/terraform', '1.7.0');
    queueExecFileSuccess(SAMPLE_STDOUT);

    const service = new TerraformService(stubOutputConfigService('/repo/terraform'), stubRemoteFileStore());

    const result = await service.output();

    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/local/bin/terraform',
      ['output', '-json'],
      { cwd: '/repo/terraform' },
      expect.any(Function),
    );
    const expected: TfOutputs | null = projectTfOutputs({
      outputs: JSON.parse(SAMPLE_STDOUT) as RawTfState['outputs'],
    });
    expect(result).toEqual(expected);
  });
});

describe('TerraformService.output caching', () => {
  it('should serve a second non-force call within the 60s TTL window from cache without spawning again', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockReturnValue(1_000_000);

    queueSuccessfulResolution();
    queueExecFileSuccess(SAMPLE_STDOUT);

    const service = new TerraformService(stubOutputConfigService(), stubRemoteFileStore());

    const first = await service.output();
    expect(execFileMock).toHaveBeenCalledTimes(3); // lookup + version + output

    // Still within the 60s TTL window.
    dateNowSpy.mockReturnValue(1_000_000 + 59_000);

    const second = await service.output();

    expect(execFileMock).toHaveBeenCalledTimes(3); // no additional spawn
    expect(second).toEqual(first);
  });

  it('should re-spawn a non-force call once the 60s TTL has elapsed', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockReturnValue(1_000_000);

    queueSuccessfulResolution();
    queueExecFileSuccess(SAMPLE_STDOUT);

    const service = new TerraformService(stubOutputConfigService(), stubRemoteFileStore());
    await service.output();
    expect(execFileMock).toHaveBeenCalledTimes(3);

    // Past the 60s TTL window.
    dateNowSpy.mockReturnValue(1_000_000 + 60_001);
    const otherStdout = JSON.stringify({ aws_region: { value: 'eu-west-1' } });
    queueExecFileSuccess(otherStdout);

    const result = await service.output();

    // Binary/version resolution is memoized on the instance regardless of the
    // output cache, so only one additional execFile call (the re-spawned
    // `output -json`) is expected here.
    expect(execFileMock).toHaveBeenCalledTimes(4);
    expect(result).toEqual(
      projectTfOutputs({ outputs: JSON.parse(otherStdout) as RawTfState['outputs'] }),
    );
  });

  it('should bypass a still-fresh cache and unconditionally re-spawn when force is true', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockReturnValue(1_000_000);

    queueSuccessfulResolution();
    queueExecFileSuccess(SAMPLE_STDOUT);

    const service = new TerraformService(stubOutputConfigService(), stubRemoteFileStore());
    await service.output();
    expect(execFileMock).toHaveBeenCalledTimes(3);

    // Still well within the 60s TTL window — a non-force call would be served
    // from cache, but force=true must bypass that.
    dateNowSpy.mockReturnValue(1_000_000 + 1_000);
    const otherStdout = JSON.stringify({ aws_region: { value: 'ap-southeast-2' } });
    queueExecFileSuccess(otherStdout);

    const result = await service.output(true);

    expect(execFileMock).toHaveBeenCalledTimes(4);
    expect(result).toEqual(
      projectTfOutputs({ outputs: JSON.parse(otherStdout) as RawTfState['outputs'] }),
    );
  });
});

describe('TerraformService.output failure handling', () => {
  it('should leave outputCache untouched and retry on the next call when the spawned process fails', async () => {
    queueSuccessfulResolution();
    queueExecFileFailure(new Error('terraform output exited with code 1'));

    const service = new TerraformService(stubOutputConfigService(), stubRemoteFileStore());

    await expect(service.output()).rejects.toThrow('terraform output exited with code 1');

    // The failed attempt must not have poisoned the cache — the next call
    // (non-force, since there was never a successful cache entry) retries
    // rather than throwing again or serving a broken value.
    queueExecFileSuccess(SAMPLE_STDOUT);
    const result = await service.output();

    expect(result).toEqual(
      projectTfOutputs({ outputs: JSON.parse(SAMPLE_STDOUT) as RawTfState['outputs'] }),
    );
  });

  it('should leave outputCache untouched and retry on the next call when the stdout is not valid JSON', async () => {
    queueSuccessfulResolution();
    queueExecFileSuccess('not valid json');

    const service = new TerraformService(stubOutputConfigService(), stubRemoteFileStore());

    await expect(service.output()).rejects.toThrow();

    queueExecFileSuccess(SAMPLE_STDOUT);
    const result = await service.output();

    expect(result).toEqual(
      projectTfOutputs({ outputs: JSON.parse(SAMPLE_STDOUT) as RawTfState['outputs'] }),
    );
  });

  it('should leave a prior successful cache entry intact when a later force call fails', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockReturnValue(1_000_000);

    queueSuccessfulResolution();
    queueExecFileSuccess(SAMPLE_STDOUT);

    const service = new TerraformService(stubOutputConfigService(), stubRemoteFileStore());
    const first = await service.output();

    dateNowSpy.mockReturnValue(1_000_000 + 1_000);
    queueExecFileFailure(new Error('terraform output exited with code 1'));
    await expect(service.output(true)).rejects.toThrow('terraform output exited with code 1');

    // A subsequent non-force call, still within the TTL window measured from
    // the original successful resolution, is served from the untouched cache
    // rather than the failed attempt having cleared/corrupted it.
    dateNowSpy.mockReturnValue(1_000_000 + 2_000);
    const second = await service.output();

    expect(second).toEqual(first);
    expect(execFileMock).toHaveBeenCalledTimes(4); // resolution(2) + first output(1) + failed force call(1)
  });
});

describe('TerraformService.output null-outputs case', () => {
  it('should cache and return null when terraform output -json reports no outputs', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockReturnValue(1_000_000);

    queueSuccessfulResolution();
    // JSON.parse('null') resolves to `null`, so `projectTfOutputs({ outputs: null })`
    // hits its "no outputs map at all" branch and returns `null`.
    queueExecFileSuccess('null');

    const service = new TerraformService(stubOutputConfigService(), stubRemoteFileStore());

    const first = await service.output();
    expect(first).toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(3);

    // A second non-force call within the TTL must be served from cache
    // (proving `null` itself is a valid cached value, not treated the same
    // as "no cache entry yet").
    dateNowSpy.mockReturnValue(1_000_000 + 1_000);
    const second = await service.output();

    expect(second).toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });
});
