import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { SemVer } from 'semver';
import { PULUMI_ENGINE_VERSION } from '@hyveon/shared';

/*
 * Spy variables must be hoisted before vi.mock() factories run, because
 * vi.mock() calls are lifted to the top of the compiled output above regular
 * declarations.
 */
const {
  getMock,
  installMock,
  existsSyncMock,
  mkdirSyncMock,
  readdirSyncMock,
  renameSyncMock,
  rmSyncMock,
  loggerMock,
} = vi.hoisted(() => ({
  getMock: vi.fn(),
  installMock: vi.fn(),
  existsSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  readdirSyncMock: vi.fn(),
  renameSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  PulumiCommand: {
    get: getMock,
    install: installMock,
  },
}));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  readdirSync: readdirSyncMock,
  renameSync: renameSyncMock,
  rmSync: rmSyncMock,
}));

vi.mock('../logger.js', () => ({ logger: loggerMock }));

import { PulumiEngineService, PulumiEngineNetworkError, PulumiEngineIntegrityError, PulumiEngineCacheWriteError } from './PulumiEngineService.js';

/** Minimal `PulumiCommand`-shaped object the mocked SDK resolves with. */
interface FakeCommand {
  command: string;
  version: SemVer | null;
}

function fakeCommand(root: string, version: string): FakeCommand {
  return { command: `${root}/bin/pulumi`, version: new SemVer(version) };
}

/**
 * Test-only subclass that re-exposes `PulumiEngineService`'s protected
 * `userData` seam as public so `vi.spyOn` can target it directly, mirroring
 * `ConfigService.test.ts`'s `TestableConfigService`.
 */
class TestablePulumiEngineService extends PulumiEngineService {
  public override resolveUserDataPath(): string | null {
    return super.resolveUserDataPath();
  }
}

/** Builds a service with a fixed, fake `userData` path so cache paths are deterministic. */
function makeService(userDataPath: string | null = '/fake/userData'): TestablePulumiEngineService {
  const service = new TestablePulumiEngineService();
  vi.spyOn(service, 'resolveUserDataPath').mockReturnValue(userDataPath);
  return service;
}

/** Absolute path to the `versions/` directory under the fake `userData`'s engine cache root. */
const VERSIONS_DIR = '/fake/userData/pulumi/versions';

/** Absolute path to the pinned version's install directory under the fake `userData`. */
const PIN_ROOT = join(VERSIONS_DIR, PULUMI_ENGINE_VERSION);

beforeEach(() => {
  getMock.mockReset();
  installMock.mockReset();
  existsSyncMock.mockReset();
  mkdirSyncMock.mockReset();
  readdirSyncMock.mockReset();
  renameSyncMock.mockReset();
  rmSyncMock.mockReset();
  loggerMock.debug.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();

  // Default: empty cache, install succeeds first try, final re-resolve
  // succeeds, pruning finds nothing else to sweep.
  existsSyncMock.mockReturnValue(false);
  installMock.mockResolvedValue(fakeCommand('/staging', PULUMI_ENGINE_VERSION));
  getMock.mockResolvedValue(fakeCommand(PIN_ROOT, PULUMI_ENGINE_VERSION));
  readdirSyncMock.mockReturnValue([]);
});

describe('PulumiEngineService construction', () => {
  it('should not throw when constructed on a machine with no network and no engine', () => {
    // Nothing has been stubbed to succeed yet — installMock/getMock still
    // reject by default outside beforeEach's happy-path stubs. Construction
    // must not touch either.
    installMock.mockReset();
    getMock.mockReset();
    installMock.mockRejectedValue(new Error('should never be called by the constructor'));
    getMock.mockRejectedValue(new Error('should never be called by the constructor'));

    expect(() => new PulumiEngineService()).not.toThrow();
    expect(installMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('should not throw even when resolving the userData path would itself throw', () => {
    // Adversarial: userData resolution blows up. Construction never calls it
    // (deferred to first resolve()), so this must still not throw.
    class ThrowingUserDataService extends PulumiEngineService {
      protected override resolveUserDataPath(): string | null {
        throw new Error('electron not ready yet');
      }
    }
    expect(() => new ThrowingUserDataService()).not.toThrow();
  });

  it('should report null for getResolvedVersion before resolve() has ever been called', () => {
    const service = makeService();
    expect(service.getResolvedVersion()).toBeNull();
  });

  it('should report the pinned version from getPinnedVersion regardless of resolution state', () => {
    const service = makeService();
    expect(service.getPinnedVersion()).toBe(PULUMI_ENGINE_VERSION);
  });
});

describe('PulumiEngineService.resolve — memoization and concurrency', () => {
  it('should call PulumiCommand.install exactly once across two concurrent resolve() calls', async () => {
    const service = makeService();

    // Gate installMock behind a manually-controlled promise so both
    // resolve() calls are guaranteed to be in flight simultaneously before
    // either the install call itself, or the whole attempt, ever settles —
    // this is what makes the assertion below prove a *shared* in-flight
    // promise rather than two calls that merely happen to interleave.
    let releaseInstall!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      releaseInstall = resolvePromise;
    });
    installMock.mockImplementationOnce(async () => {
      await gate;
      return fakeCommand('/staging', PULUMI_ENGINE_VERSION);
    });

    const first = service.resolve();
    const second = service.resolve();

    // Flush pending microtasks (tryReuseCached's early return, provision()'s
    // await chain) so installMock has actually been invoked by the time it's
    // asserted below — the assignment of `this.resolution` that guarantees a
    // *shared* promise across `first`/`second` already happened synchronously
    // above, before either `resolve()` call returned.
    await new Promise((r) => setTimeout(r, 0));
    expect(installMock).toHaveBeenCalledTimes(1);

    releaseInstall();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(installMock).toHaveBeenCalledTimes(1);
    expect(firstResult).toBe(secondResult);
  });

  it('should call PulumiCommand.install exactly once across two concurrent resolve() calls that both end up rejecting', async () => {
    // The highest-risk variant of the concurrency guarantee: it's easy to
    // accidentally get "one install call" right for the success path (a
    // resolved value is trivially shared) while a naive implementation
    // still double-triggers on failure (e.g. if each caller raced its own
    // fallback attempt). This proves the *rejection* is shared too, and that
    // sharing a rejection doesn't itself double-invoke install.
    const service = makeService();

    let rejectInstall!: (err: Error) => void;
    const gate = new Promise<never>((_resolvePromise, rejectPromise) => {
      rejectInstall = rejectPromise;
    });
    installMock.mockImplementationOnce(() => gate);

    const first = service.resolve();
    const second = service.resolve();

    await new Promise((r) => setTimeout(r, 0));
    expect(installMock).toHaveBeenCalledTimes(1);

    rejectInstall(new Error('Failed to download https://get.pulumi.com/install.sh: network unreachable'));

    await expect(first).rejects.toThrow(PulumiEngineNetworkError);
    await expect(second).rejects.toThrow(PulumiEngineNetworkError);
    expect(installMock).toHaveBeenCalledTimes(1);
  });

  it('should memoize a successful resolution so a later call does not reprovision', async () => {
    const service = makeService();

    await service.resolve();
    await service.resolve();

    expect(installMock).toHaveBeenCalledTimes(1);
  });

  it('should not memoize a failed attempt, so the next resolve() call retries', async () => {
    const service = makeService();
    installMock.mockRejectedValueOnce(new Error('Failed to download https://get.pulumi.com/install.sh: no network'));

    await expect(service.resolve()).rejects.toThrow(PulumiEngineNetworkError);
    expect(installMock).toHaveBeenCalledTimes(1);

    // Second call, network back — must actually retry, not replay the
    // memoized rejection.
    installMock.mockResolvedValueOnce(fakeCommand('/staging', PULUMI_ENGINE_VERSION));
    await expect(service.resolve()).resolves.toBeDefined();
    expect(installMock).toHaveBeenCalledTimes(2);
  });
});

describe('PulumiEngineService.resolve — cache reuse and version pinning', () => {
  it('should reuse a verified cache entry without calling install', async () => {
    const service = makeService();
    existsSyncMock.mockReturnValue(true);
    getMock.mockResolvedValue(fakeCommand(PIN_ROOT, PULUMI_ENGINE_VERSION));

    const command = await service.resolve();

    expect(installMock).not.toHaveBeenCalled();
    expect(getMock).toHaveBeenCalledWith({ root: PIN_ROOT, version: new SemVer(PULUMI_ENGINE_VERSION), skipVersionCheck: false });
    expect(String(command.version)).toBe(PULUMI_ENGINE_VERSION);
    expect(service.getResolvedVersion()).toBe(PULUMI_ENGINE_VERSION);
  });

  it('should discard and reprovision when the cache holds a different version than the pin', async () => {
    const service = makeService();
    existsSyncMock.mockReturnValue(true);
    // The pin's own directory reports a stale/mismatched version — a
    // defensive scenario since PulumiCommand.get()'s own check is a
    // minimum-version check, not exact-match (see the service's TSDoc). A
    // confirmed version mismatch is *provable* evidence of a bad entry, so
    // it's deleted outright rather than left for the swap-aside path.
    getMock.mockResolvedValueOnce(fakeCommand(PIN_ROOT, '3.200.0'));
    installMock.mockResolvedValueOnce(fakeCommand('/staging', PULUMI_ENGINE_VERSION));
    getMock.mockResolvedValueOnce(fakeCommand(PIN_ROOT, PULUMI_ENGINE_VERSION));

    const command = await service.resolve();

    // Stale entry removed, not reused.
    expect(rmSyncMock).toHaveBeenCalledWith(PIN_ROOT, { recursive: true, force: true });
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(String(command.version)).toBe(PULUMI_ENGINE_VERSION);
    expect(service.getResolvedVersion()).toBe(PULUMI_ENGINE_VERSION);
  });

  it('should discard a cache entry whose binary is genuinely missing (ENOENT)', async () => {
    const service = makeService();
    existsSyncMock.mockReturnValue(true);
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('spawn pulumi ENOENT'), { code: 'ENOENT' });
    getMock.mockRejectedValueOnce(enoent);
    installMock.mockResolvedValueOnce(fakeCommand('/staging', PULUMI_ENGINE_VERSION));
    getMock.mockResolvedValueOnce(fakeCommand(PIN_ROOT, PULUMI_ENGINE_VERSION));

    await service.resolve();

    // ENOENT is provable evidence (the binary isn't there at all) — deleted outright.
    expect(rmSyncMock).toHaveBeenCalledWith(PIN_ROOT, { recursive: true, force: true });
    expect(installMock).toHaveBeenCalledTimes(1);
  });

  it('should reject with an integrity error when a freshly installed engine reports the wrong version', async () => {
    const service = makeService();
    installMock.mockResolvedValueOnce(fakeCommand('/staging', '9.9.9'));

    await expect(service.resolve()).rejects.toThrow(PulumiEngineIntegrityError);
    // A mismatched fresh install must never be renamed into the final path.
    expect(renameSyncMock).not.toHaveBeenCalled();
  });
});

describe('PulumiEngineService.resolve — ambiguous cache failures are not deleted', () => {
  it('should leave an ambiguous cache entry in place and swap it aside once a fresh install is verified', async () => {
    const service = makeService();
    // Only PIN_ROOT "exists" — nothing else on disk yet.
    existsSyncMock.mockImplementation((path: unknown) => path === PIN_ROOT);
    const ebusy: NodeJS.ErrnoException = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    getMock.mockRejectedValueOnce(ebusy); // tryReuseCached's check fails ambiguously
    installMock.mockResolvedValueOnce(fakeCommand('/staging', PULUMI_ENGINE_VERSION));
    getMock.mockResolvedValueOnce(fakeCommand(PIN_ROOT, PULUMI_ENGINE_VERSION)); // final re-resolve after swap

    const command = await service.resolve();

    // Never deleted outright — an ambiguous exec failure is not proof it's bad.
    expect(rmSyncMock).not.toHaveBeenCalledWith(PIN_ROOT, expect.anything());

    // Swapped aside, then the verified staging install took its place.
    const renameCalls = renameSyncMock.mock.calls as [string, string][];
    expect(renameCalls).toHaveLength(2);
    const [swapAside, swapIn] = renameCalls;
    expect(swapAside?.[0]).toBe(PIN_ROOT);
    expect(swapAside?.[1]).toMatch(/\.trash-/);
    expect(swapIn?.[0]).toMatch(/\.staging-/);
    expect(swapIn?.[1]).toBe(PIN_ROOT);

    // The superseded (swapped-aside) entry is cleaned up afterward.
    expect(rmSyncMock).toHaveBeenCalledWith(swapAside?.[1], { recursive: true, force: true });

    expect(String(command.version)).toBe(PULUMI_ENGINE_VERSION);
  });

  it('should leave an ambiguous cache entry fully untouched when the reprovisioning attempt itself fails', async () => {
    const service = makeService();
    existsSyncMock.mockImplementation((path: unknown) => path === PIN_ROOT);
    const etxtbsy: NodeJS.ErrnoException = Object.assign(new Error('text file busy'), { code: 'ETXTBSY' });
    getMock.mockRejectedValueOnce(etxtbsy);
    installMock.mockRejectedValueOnce(new Error('install.sh exited 1: interrupted'));

    await expect(service.resolve()).rejects.toThrow();

    // The swap-aside logic only runs once a fresh install is already
    // verified — since the fresh install itself failed here, `root` (and
    // whatever ambiguous entry occupies it) must never be touched at all:
    // no rename, and no delete of PIN_ROOT.
    expect(renameSyncMock).not.toHaveBeenCalled();
    expect(rmSyncMock).not.toHaveBeenCalledWith(PIN_ROOT, expect.anything());
  });

  it('should restore the prior install from the trash directory when post-rename verification fails after a successful swap-aside', async () => {
    // An ambiguous entry gets swapped aside, the fresh install passes its own
    // pre-rename verification, but the *separate* post-rename get()
    // re-check then fails (a transient exec flake right after the move).
    // The trashed prior install must survive that failure — it was never
    // proven bad, and deleting it here would leave the app with no engine
    // at all, worse off than before this call started.
    const service = makeService();
    // Only PIN_ROOT "exists" before the swap.
    existsSyncMock.mockImplementation((path: unknown) => path === PIN_ROOT);
    const ebusy: NodeJS.ErrnoException = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    getMock.mockRejectedValueOnce(ebusy); // tryReuseCached's ambiguous check
    installMock.mockResolvedValueOnce(fakeCommand('/staging', PULUMI_ENGINE_VERSION));
    const eacces: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    getMock.mockRejectedValueOnce(eacces); // the post-rename re-verification, after the swap already completed

    await expect(service.resolve()).rejects.toThrow(PulumiEngineCacheWriteError);

    // Swap-aside completed (two renames), then a third rename restores the
    // trashed prior install back to PIN_ROOT once verification failed.
    const renameCalls = renameSyncMock.mock.calls as [string, string][];
    expect(renameCalls).toHaveLength(3);
    const [swapAside, swapIn, restore] = renameCalls;
    expect(swapAside?.[0]).toBe(PIN_ROOT);
    expect(swapAside?.[1]).toMatch(/\.trash-/);
    expect(swapIn?.[0]).toMatch(/\.staging-/);
    expect(swapIn?.[1]).toBe(PIN_ROOT);
    expect(restore?.[0]).toBe(swapAside?.[1]);
    expect(restore?.[1]).toBe(PIN_ROOT);

    // The unverifiable new content swapped into PIN_ROOT is cleaned up
    // before the restore, but the trashed prior install itself is never
    // rmSync'd — it's recovered via rename, not deleted.
    expect(rmSyncMock).toHaveBeenCalledWith(PIN_ROOT, { recursive: true, force: true });
    expect(rmSyncMock).not.toHaveBeenCalledWith(swapAside?.[1], expect.anything());
  });
});

describe('PulumiEngineService.resolve — no partial-install reuse', () => {
  it('should not rename a failed install into place and must reprovision fully on the next call', async () => {
    const service = makeService();
    installMock.mockRejectedValueOnce(new Error('install.sh exited 1: interrupted'));

    await expect(service.resolve()).rejects.toThrow();
    expect(renameSyncMock).not.toHaveBeenCalled();
    // Staging debris is cleaned up best-effort.
    expect(rmSyncMock).toHaveBeenCalled();
    const cleanedPath = rmSyncMock.mock.calls[0]?.[0] as string;
    expect(cleanedPath).toMatch(/\.staging-/);

    // Cache still empty (existsSync keeps returning false) — the retry must
    // go through installFresh again, not find anything reusable.
    installMock.mockResolvedValueOnce(fakeCommand('/staging-2', PULUMI_ENGINE_VERSION));
    const command = await service.resolve();

    expect(installMock).toHaveBeenCalledTimes(2);
    expect(String(command.version)).toBe(PULUMI_ENGINE_VERSION);
  });

  it('should install into a staging directory and only rename it into the final path after verification', async () => {
    const service = makeService();

    await service.resolve();

    expect(installMock).toHaveBeenCalledTimes(1);
    const installArgs = installMock.mock.calls[0]?.[0] as { root: string };
    expect(installArgs.root).not.toBe(PIN_ROOT);
    expect(installArgs.root).toMatch(/\.staging-/);
    expect(renameSyncMock).toHaveBeenCalledWith(installArgs.root, PIN_ROOT);
  });

  it('should clean up and throw a classified error when the post-rename verification get() fails', async () => {
    const service = makeService();
    installMock.mockResolvedValueOnce(fakeCommand('/staging', PULUMI_ENGINE_VERSION));
    const eacces: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    getMock.mockRejectedValueOnce(eacces); // the final re-resolve, not the (skipped) cache check

    await expect(service.resolve()).rejects.toThrow(PulumiEngineCacheWriteError);

    // The just-renamed, now-unverifiable directory is cleaned up rather than
    // left at the final path for a later tryReuseCached to stumble on.
    expect(rmSyncMock).toHaveBeenCalledWith(PIN_ROOT, { recursive: true, force: true });
  });

  it('should log an error before rejecting when the post-rename verification get() fails', async () => {
    const service = makeService();
    installMock.mockResolvedValueOnce(fakeCommand('/staging', PULUMI_ENGINE_VERSION));
    const eacces: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    getMock.mockRejectedValueOnce(eacces);

    await expect(service.resolve()).rejects.toThrow(PulumiEngineCacheWriteError);

    expect(loggerMock.error).toHaveBeenCalledWith(
      'PulumiEngineService: post-rename verification of the installed Pulumi engine failed',
      expect.objectContaining({ root: PIN_ROOT }),
    );
  });
});

describe('PulumiEngineService.resolve — pruning superseded versions', () => {
  it('should best-effort remove sibling version directories other than the current pin after a successful install', async () => {
    const service = makeService();
    readdirSyncMock.mockReturnValue(['3.200.0', PULUMI_ENGINE_VERSION, '.staging-leftover', '.trash-leftover']);

    await service.resolve();

    expect(readdirSyncMock).toHaveBeenCalledWith(VERSIONS_DIR);
    expect(rmSyncMock).toHaveBeenCalledWith(join(VERSIONS_DIR, '3.200.0'), { recursive: true, force: true });
    expect(rmSyncMock).not.toHaveBeenCalledWith(join(VERSIONS_DIR, '.staging-leftover'), expect.anything());
    expect(rmSyncMock).not.toHaveBeenCalledWith(join(VERSIONS_DIR, '.trash-leftover'), expect.anything());
    expect(rmSyncMock).not.toHaveBeenCalledWith(PIN_ROOT, expect.anything());
  });

  it('should not fail provisioning if listing the versions directory for pruning fails', async () => {
    const service = makeService();
    readdirSyncMock.mockImplementationOnce(() => {
      throw new Error('EIO');
    });

    await expect(service.resolve()).resolves.toBeDefined();
  });
});

describe('PulumiEngineService.resolve — typed provisioning errors', () => {
  it('should reject with PulumiEngineNetworkError when the install-script fetch itself fails', async () => {
    const service = makeService();
    installMock.mockRejectedValueOnce(
      new Error('Failed to download https://get.pulumi.com/install.sh: getaddrinfo ENOTFOUND get.pulumi.com'),
    );

    await expect(service.resolve()).rejects.toThrow(PulumiEngineNetworkError);
  });

  it('should reject with PulumiEngineIntegrityError, not a network error, when the download fails with an HTTP status', async () => {
    // The SDK's download() uses the same "Failed to download <url>: ..."
    // prefix for both a true network failure and a reachable server
    // responding non-2xx — a 404 means the server *was* reached.
    const service = makeService();
    installMock.mockRejectedValueOnce(
      new Error('Failed to download https://get.pulumi.com/install.sh: 404 Not Found'),
    );

    await expect(service.resolve()).rejects.toThrow(PulumiEngineIntegrityError);
  });

  it('should reject with PulumiEngineIntegrityError when the install script exits non-zero for an unrecognised reason', async () => {
    const service = makeService();
    installMock.mockRejectedValueOnce(new Error('command failed with exit code 1: checksum mismatch'));

    await expect(service.resolve()).rejects.toThrow(PulumiEngineIntegrityError);
  });

  it('should reject with PulumiEngineCacheWriteError when the cache root cannot be created', async () => {
    const service = makeService();
    const eacces: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mkdirSyncMock.mockImplementationOnce(() => {
      throw eacces;
    });

    await expect(service.resolve()).rejects.toThrow(PulumiEngineCacheWriteError);
    expect(installMock).not.toHaveBeenCalled();
  });

  it('should log an error before rejecting when the cache root cannot be created', async () => {
    const service = makeService();
    const eacces: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mkdirSyncMock.mockImplementationOnce(() => {
      throw eacces;
    });

    await expect(service.resolve()).rejects.toThrow(PulumiEngineCacheWriteError);

    expect(loggerMock.error).toHaveBeenCalledWith(
      'PulumiEngineService: failed to create the Pulumi engine versions directory',
      expect.objectContaining({ error: 'permission denied' }),
    );
  });

  it('should reject with PulumiEngineCacheWriteError when a verified install cannot be renamed into place', async () => {
    const service = makeService();
    const erofs: NodeJS.ErrnoException = Object.assign(new Error('read-only file system'), { code: 'EROFS' });
    renameSyncMock.mockImplementationOnce(() => {
      throw erofs;
    });

    await expect(service.resolve()).rejects.toThrow(PulumiEngineCacheWriteError);
  });

  it('should log an error before rejecting when a verified install cannot be renamed into place', async () => {
    const service = makeService();
    const erofs: NodeJS.ErrnoException = Object.assign(new Error('read-only file system'), { code: 'EROFS' });
    renameSyncMock.mockImplementationOnce(() => {
      throw erofs;
    });

    await expect(service.resolve()).rejects.toThrow(PulumiEngineCacheWriteError);

    expect(loggerMock.error).toHaveBeenCalledWith(
      'PulumiEngineService: failed to swap the verified Pulumi engine install into place',
      expect.objectContaining({ error: 'read-only file system' }),
    );
  });

  it('should classify an install failure carrying an EACCES code as a cache-write error even mid-install', async () => {
    const service = makeService();
    const eacces: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    installMock.mockRejectedValueOnce(eacces);

    await expect(service.resolve()).rejects.toThrow(PulumiEngineCacheWriteError);
  });

  it('should log an error before rejecting when installing the pinned engine fails', async () => {
    const service = makeService();
    const eacces: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    installMock.mockRejectedValueOnce(eacces);

    await expect(service.resolve()).rejects.toThrow(PulumiEngineCacheWriteError);

    expect(loggerMock.error).toHaveBeenCalledWith(
      'PulumiEngineService: failed to install the pinned Pulumi engine',
      expect.objectContaining({ stagingDir: expect.any(String) }),
    );
  });
});

describe('PulumiEngineService.resolve — elapsed-time logging', () => {
  it('should log info with elapsedMs and cacheHit: false on the fresh-install path', async () => {
    const service = makeService();

    await service.resolve();

    expect(loggerMock.info).toHaveBeenCalledWith(
      'PulumiEngineService: Pulumi engine resolved',
      expect.objectContaining({ cacheHit: false, elapsedMs: expect.any(Number) }),
    );
  });

  it('should log info with elapsedMs and cacheHit: true on the cache-reuse path', async () => {
    const service = makeService();
    existsSyncMock.mockReturnValue(true);
    getMock.mockResolvedValue(fakeCommand(PIN_ROOT, PULUMI_ENGINE_VERSION));

    await service.resolve();

    expect(loggerMock.info).toHaveBeenCalledWith(
      'PulumiEngineService: Pulumi engine resolved',
      expect.objectContaining({ cacheHit: true, elapsedMs: expect.any(Number) }),
    );
    expect(installMock).not.toHaveBeenCalled();
  });
});

describe('PulumiEngineService — engine cache root resolution', () => {
  const originalEnv = process.env['HYVEON_PULUMI_ENGINE_DIR'];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['HYVEON_PULUMI_ENGINE_DIR'];
    else process.env['HYVEON_PULUMI_ENGINE_DIR'] = originalEnv;
  });

  it('should install under an env override when HYVEON_PULUMI_ENGINE_DIR is set', async () => {
    process.env['HYVEON_PULUMI_ENGINE_DIR'] = '/env/override';
    const service = makeService('/fake/userData');
    await service.resolve();

    const installArgs = installMock.mock.calls[0]?.[0] as { root: string };
    expect(installArgs.root.startsWith('/env/override/versions')).toBe(true);
  });

  it('should fall back to the OS temp directory when no userData path is available', async () => {
    const service = makeService(null);
    await service.resolve();

    const installArgs = installMock.mock.calls[0]?.[0] as { root: string };
    expect(installArgs.root).toContain('hyveon-pulumi-engine');
  });
});

describe('PulumiEngineService.resolve — phase reporting', () => {
  it('should report ("engine", "start") synchronously before provisioning does any work, then ("engine", "end") once resolution settles', async () => {
    const service = makeService();
    const calls: Array<['engine', 'start' | 'end']> = [];
    const onPhase = vi.fn((phase: 'engine' | 'plugins' | 'operation', status: 'start' | 'end') => {
      calls.push([phase as 'engine', status]);
    });

    const resultPromise = service.resolve(onPhase);
    // 'start' fires synchronously — before the returned promise has even had
    // a chance to settle, let alone before any microtask has run.
    expect(calls).toEqual([['engine', 'start']]);

    await resultPromise;

    expect(calls).toEqual([
      ['engine', 'start'],
      ['engine', 'end'],
    ]);
  });

  it('should report ("engine", "end") on a rejection too, not only on success', async () => {
    const service = makeService();
    installMock.mockRejectedValueOnce(new Error('Failed to download https://get.pulumi.com/install.sh: no network'));
    const onPhase = vi.fn();

    await expect(service.resolve(onPhase)).rejects.toThrow(PulumiEngineNetworkError);

    expect(onPhase).toHaveBeenNthCalledWith(1, 'engine', 'start');
    expect(onPhase).toHaveBeenNthCalledWith(2, 'engine', 'end');
  });

  it('should report a start/end pair per call, even for a caller that only joins an already in-flight or already-settled resolution', async () => {
    const service = makeService();
    const firstOnPhase = vi.fn();
    const secondOnPhase = vi.fn();

    await service.resolve(firstOnPhase);
    await service.resolve(secondOnPhase);

    expect(firstOnPhase.mock.calls).toEqual([
      ['engine', 'start'],
      ['engine', 'end'],
    ]);
    // The second call reuses the memoized resolution (installMock still only
    // called once — see the memoization describe block above) but still
    // reports its own start/end pair, since from *this* caller's point of
    // view it genuinely was waiting on the engine phase.
    expect(secondOnPhase.mock.calls).toEqual([
      ['engine', 'start'],
      ['engine', 'end'],
    ]);
    expect(installMock).toHaveBeenCalledTimes(1);
  });

  it('should not require onPhase — omitting it must not throw', async () => {
    const service = makeService();

    await expect(service.resolve()).resolves.toBeDefined();
  });

  it('should never report a "plugins" or "operation" phase from resolve', async () => {
    const service = makeService();
    const onPhase = vi.fn();

    await service.resolve(onPhase);

    for (const call of onPhase.mock.calls) {
      expect(call[0]).toBe('engine');
    }
  });
});
