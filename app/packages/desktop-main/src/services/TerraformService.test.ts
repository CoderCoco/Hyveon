import { describe, it, expect, vi, beforeEach } from 'vitest';

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
}));

import { TerraformService, TerraformNotFoundError, lookupCommandFor } from './TerraformService.js';
import type { ConfigService } from './ConfigService.js';

/**
 * Minimal `ConfigService` stub sufficient to satisfy `TerraformService`'s
 * constructor dependency. `TerraformService` doesn't call any `ConfigService`
 * methods yet, so an empty object cast is enough — this keeps the stub
 * trivially in sync as `ConfigService`'s surface grows.
 */
function stubConfigService(): ConfigService {
  return {} as ConfigService;
}

/** Error-first callback shape `util.promisify` invokes the mocked `execFile` with. */
type ExecFileCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

/**
 * Extracts the error-first callback from an `execFile` call's arguments,
 * regardless of whether `util.promisify` invoked it with or without an
 * `options` object (i.e. `(file, args, callback)` or
 * `(file, args, options, callback)`) — the production code now always passes
 * a `{ timeout }` options object, so the mock must tolerate both shapes.
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

/** Queues a failing `execFile` invocation (e.g. binary not found) for the next call. */
function queueExecFileFailure(error: Error = new Error('spawn ENOENT')): void {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    lastArgAsCallback(args)(error);
  });
}

/** Queues a successful binary lookup followed by a successful `-json` version response. */
function queueSuccessfulResolution(binaryPath = '/usr/local/bin/terraform', version = '1.7.0'): void {
  queueExecFileSuccess(`${binaryPath}\n`);
  queueExecFileSuccess(JSON.stringify({ terraform_version: version }));
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe('lookupCommandFor', () => {
  it('should return where.exe for the win32 platform', () => {
    expect(lookupCommandFor('win32')).toBe('where.exe');
  });

  it('should return which for the darwin platform', () => {
    expect(lookupCommandFor('darwin')).toBe('which');
  });

  it('should return which for the linux platform', () => {
    expect(lookupCommandFor('linux')).toBe('which');
  });
});

describe('TerraformNotFoundError', () => {
  it('should set its name to TerraformNotFoundError', () => {
    const error = new TerraformNotFoundError('which');
    expect(error.name).toBe('TerraformNotFoundError');
  });

  it('should include the provided lookup command in its message', () => {
    const error = new TerraformNotFoundError('where.exe');
    expect(error.message).toContain('where.exe');
  });

  it('should default the lookup command to the current platform lookup command when none is provided', () => {
    const error = new TerraformNotFoundError();
    expect(error.message).toContain(lookupCommandFor(process.platform));
  });
});

describe('TerraformService construction', () => {
  it('should never throw when constructing the service, even without any execFile mocks queued', () => {
    expect(() => new TerraformService(stubConfigService())).not.toThrow();
  });

  it('should not shell out to resolve the binary until an accessor is called', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const service = new TerraformService(stubConfigService());
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('TerraformService binary detection', () => {
  it('should resolve the binary path from the which/where.exe output', async () => {
    queueSuccessfulResolution('/usr/local/bin/terraform', '1.7.0');

    const service = new TerraformService(stubConfigService());

    await expect(service.getBinaryPath()).resolves.toBe('/usr/local/bin/terraform');
  });

  it('should use the first non-empty trimmed line when the lookup command returns multiple lines', async () => {
    queueExecFileSuccess('\n  /opt/homebrew/bin/terraform  \nsome-other-line\n');
    queueExecFileSuccess(JSON.stringify({ terraform_version: '1.7.0' }));

    const service = new TerraformService(stubConfigService());

    await expect(service.getBinaryPath()).resolves.toBe('/opt/homebrew/bin/terraform');
  });

  it('should reject getBinaryPath with a TerraformNotFoundError instance on first use when the lookup command fails', async () => {
    queueExecFileFailure();

    const service = new TerraformService(stubConfigService());

    await expect(service.getBinaryPath()).rejects.toBeInstanceOf(TerraformNotFoundError);
  });

  it('should reject getVersion with a TerraformNotFoundError instance on first use when the lookup command fails', async () => {
    queueExecFileFailure();

    const service = new TerraformService(stubConfigService());

    await expect(service.getVersion()).rejects.toBeInstanceOf(TerraformNotFoundError);
  });

  it('should reject with a TerraformNotFoundError instance when the lookup command produces no output', async () => {
    queueExecFileSuccess('');

    const service = new TerraformService(stubConfigService());

    await expect(service.getBinaryPath()).rejects.toBeInstanceOf(TerraformNotFoundError);
  });

  it('should reject with a TerraformNotFoundError instance when the lookup command output is only whitespace', async () => {
    queueExecFileSuccess('   \n  \n');

    const service = new TerraformService(stubConfigService());

    await expect(service.getBinaryPath()).rejects.toBeInstanceOf(TerraformNotFoundError);
  });
});

describe('TerraformService version parsing', () => {
  it('should parse the terraform_version field from terraform version -json output', async () => {
    queueSuccessfulResolution('/usr/local/bin/terraform', '1.7.5');

    const service = new TerraformService(stubConfigService());

    await expect(service.getVersion()).resolves.toBe('1.7.5');
  });

  it('should fall back to parsing plain-text output when the -json output is not valid JSON', async () => {
    queueExecFileSuccess('/usr/local/bin/terraform\n');
    queueExecFileSuccess('not json');
    queueExecFileSuccess('Terraform v1.6.2\non linux_amd64\n');

    const service = new TerraformService(stubConfigService());

    await expect(service.getVersion()).resolves.toBe('1.6.2');
  });

  it('should fall back to parsing plain-text output when terraform_version is missing from the json output', async () => {
    queueExecFileSuccess('/usr/local/bin/terraform\n');
    queueExecFileSuccess(JSON.stringify({ some_other_field: true }));
    queueExecFileSuccess('Terraform v1.5.0\n');

    const service = new TerraformService(stubConfigService());

    await expect(service.getVersion()).resolves.toBe('1.5.0');
  });

  it('should parse a pre-release version suffix from the plain-text fallback output', async () => {
    queueExecFileSuccess('/usr/local/bin/terraform\n');
    queueExecFileSuccess('not json');
    queueExecFileSuccess('Terraform v1.9.0-beta1\n');

    const service = new TerraformService(stubConfigService());

    await expect(service.getVersion()).resolves.toBe('1.9.0-beta1');
  });

  it('should throw a plain Error, not a TerraformNotFoundError, when the plain-text output cannot be parsed', async () => {
    queueExecFileSuccess('/usr/local/bin/terraform\n');
    queueExecFileSuccess('not json');
    queueExecFileSuccess('garbage output with no version');

    const service = new TerraformService(stubConfigService());
    const result = service.getVersion();

    await expect(result).rejects.toThrow('Unable to parse terraform version');
    await expect(result).rejects.not.toBeInstanceOf(TerraformNotFoundError);
  });
});

describe('TerraformService instance accessors', () => {
  it('should expose the resolved binary path via getBinaryPath', async () => {
    queueSuccessfulResolution('/usr/bin/terraform', '1.8.1');

    const service = new TerraformService(stubConfigService());

    await expect(service.getBinaryPath()).resolves.toBe('/usr/bin/terraform');
  });

  it('should expose the resolved version via getVersion', async () => {
    queueSuccessfulResolution('/usr/bin/terraform', '1.8.1');

    const service = new TerraformService(stubConfigService());

    await expect(service.getVersion()).resolves.toBe('1.8.1');
  });
});

describe('TerraformService resolution memoization', () => {
  it('should only shell out once across multiple getBinaryPath calls', async () => {
    queueSuccessfulResolution('/usr/bin/terraform', '1.8.1');

    const service = new TerraformService(stubConfigService());

    await service.getBinaryPath();
    await service.getBinaryPath();

    expect(execFileMock).toHaveBeenCalledTimes(2); // one lookup call + one version call
  });

  it('should reuse the memoized resolution between getBinaryPath and getVersion', async () => {
    queueSuccessfulResolution('/usr/bin/terraform', '1.8.1');

    const service = new TerraformService(stubConfigService());

    await service.getBinaryPath();
    await service.getVersion();

    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('should resolve concurrent getBinaryPath calls to the same memoized result with a single lookup', async () => {
    queueSuccessfulResolution('/usr/bin/terraform', '1.8.1');

    const service = new TerraformService(stubConfigService());

    const [first, second] = await Promise.all([service.getBinaryPath(), service.getBinaryPath()]);

    expect(first).toBe('/usr/bin/terraform');
    expect(second).toBe('/usr/bin/terraform');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('should memoize a TerraformNotFoundError rejection so a second call does not re-invoke execFile', async () => {
    queueExecFileFailure();

    const service = new TerraformService(stubConfigService());

    await expect(service.getBinaryPath()).rejects.toBeInstanceOf(TerraformNotFoundError);
    await expect(service.getBinaryPath()).rejects.toBeInstanceOf(TerraformNotFoundError);

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
