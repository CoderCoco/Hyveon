/**
 * Unit tests for `resolveAwsCredentialSource` — the single decision
 * `BootstrapService` and `IamCheckService` would otherwise each duplicate
 * privately. `BootstrapService.test.ts`/`IamCheckService.test.ts` already
 * cover this decision indirectly (via `store.getPastedCredentials` call
 * assertions); this file tests it directly, once, as its own unit.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AwsPastedCredentialDecryptError,
  resolveAwsCredentialSource,
  resolveAwsClientCredentialsWithSignature,
} from './awsCredentialSource.js';
import type { ElectronStoreService } from './ElectronStoreService.js';

/** Builds an `ElectronStoreService` stub whose `aws.profile` and pasted-credentials lookup are controlled directly. */
function makeStore(
  profile: string | undefined,
  pastedCredentials?: { accessKeyId: string; secretAccessKey: string; region?: string },
): ElectronStoreService {
  return {
    get: vi.fn().mockImplementation((key: string) => (key === 'aws' ? { profile } : undefined)),
    getPastedCredentials: vi.fn().mockReturnValue(pastedCredentials),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

/**
 * Builds an `ElectronStoreService` stub whose `getPastedCredentials` throws —
 * simulating Electron's own raw `safeStorage.decryptString` failure on a
 * corrupt/foreign ciphertext blob (see `SafeStorageService.decrypt`'s own
 * remarks).
 */
function makeStoreWithUndecryptableCredentials(profile: string, cause: unknown): ElectronStoreService {
  return {
    get: vi.fn().mockImplementation((key: string) => (key === 'aws' ? { profile } : undefined)),
    getPastedCredentials: vi.fn().mockImplementation(() => {
      throw cause;
    }),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

describe('resolveAwsCredentialSource', () => {
  it('should resolve kind "none" when no profile is stored', () => {
    const store = makeStore(undefined);

    const source = resolveAwsCredentialSource(store);

    expect(source).toEqual({ kind: 'none' });
    expect(store.getPastedCredentials).not.toHaveBeenCalled();
  });

  it('should resolve kind "pasted" with decrypted keys when the profile matches a pasted-credentials entry', () => {
    const store = makeStore('hyveon-pasted', { accessKeyId: 'AKID', secretAccessKey: 'SECRET' });

    const source = resolveAwsCredentialSource(store);

    expect(source).toEqual({ kind: 'pasted', profile: 'hyveon-pasted', accessKeyId: 'AKID', secretAccessKey: 'SECRET' });
    expect(store.getPastedCredentials).toHaveBeenCalledWith('hyveon-pasted');
  });

  it('should resolve kind "profile" when the stored profile has no pasted-credentials entry', () => {
    const store = makeStore('default', undefined);

    const source = resolveAwsCredentialSource(store);

    expect(source).toEqual({ kind: 'profile', profile: 'default' });
  });

  it('should prefer the pasted-credentials entry over treating the same name as a real CLI profile', () => {
    // Same name could in principle collide with a real ~/.aws profile — the
    // pasted lookup must win, matching Bootstrap/IamCheckService's pre-existing behaviour.
    const store = makeStore('default', { accessKeyId: 'AKID', secretAccessKey: 'SECRET' });

    const source = resolveAwsCredentialSource(store);

    expect(source.kind).toBe('pasted');
  });

  /**
   * Regression tests for Finding 4 (final whole-branch review):
   * `ElectronStoreService.getPastedCredentials` → `SafeStorageService.decrypt`
   * can throw Electron's own raw, untyped decrypt error on a corrupt/foreign
   * ciphertext blob. Before this fix, that raw error propagated unwrapped out
   * of `resolveAwsCredentialSource`, giving
   * `PulumiService.classifyGetOrCreateStackFailure` no way to distinguish it
   * from an unrelated mid-operation failure — it fell through to
   * `'operation'` even though it's genuinely a pre-engine failure.
   */
  it('should throw AwsPastedCredentialDecryptError (wrapping the cause) when getPastedCredentials throws', () => {
    const cause = new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    const store = makeStoreWithUndecryptableCredentials('hyveon-pasted', cause);

    let caught: unknown;
    try {
      resolveAwsCredentialSource(store);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AwsPastedCredentialDecryptError);
    expect((caught as AwsPastedCredentialDecryptError).cause).toBe(cause);
    expect((caught as AwsPastedCredentialDecryptError).profile).toBe('hyveon-pasted');
  });

  it('should name the profile in the AwsPastedCredentialDecryptError message', () => {
    const store = makeStoreWithUndecryptableCredentials('hyveon-pasted', new Error('decrypt failed'));

    expect(() => resolveAwsCredentialSource(store)).toThrow(/hyveon-pasted/);
  });
});

/**
 * Regression coverage for the stale-AWS-client-cache defect flagged in
 * review of #452: `EcsService`/`Ec2Service`/`LogsService`/`SchedulerService`
 * and every `@hyveon/cloud-aws` store cache their SDK client keyed on a
 * signature derived from this function's output. A signature that doesn't
 * actually change when the underlying credentials do would silently
 * reintroduce that bug, so these tests assert the signature both stays
 * stable for an unchanged source and changes for every kind of rotation.
 */
describe('resolveAwsClientCredentialsWithSignature', () => {
  it('should resolve credentials undefined and signature "none" when no profile is stored', () => {
    const store = makeStore(undefined);

    const resolved = resolveAwsClientCredentialsWithSignature(store);

    expect(resolved.credentials).toBeUndefined();
    expect(resolved.signature).toBe('none');
  });

  it('should resolve static keys and a signature derived from the profile and access key for a pasted entry', () => {
    const store = makeStore('hyveon-pasted', { accessKeyId: 'AKID', secretAccessKey: 'SECRET' });

    const resolved = resolveAwsClientCredentialsWithSignature(store);

    expect(resolved.credentials).toEqual({ accessKeyId: 'AKID', secretAccessKey: 'SECRET' });
    expect(resolved.signature).toBe('pasted:hyveon-pasted:AKID');
  });

  it('should resolve a fromIni provider function and a signature derived from the profile name for a real CLI profile', () => {
    const store = makeStore('default', undefined);

    const resolved = resolveAwsClientCredentialsWithSignature(store);

    expect(typeof resolved.credentials).toBe('function');
    expect(resolved.signature).toBe('profile:default');
  });

  it('should produce the same signature across repeated calls when the stored profile is unchanged', () => {
    const store = makeStore('hyveon-pasted', { accessKeyId: 'AKID', secretAccessKey: 'SECRET' });

    const first = resolveAwsClientCredentialsWithSignature(store);
    const second = resolveAwsClientCredentialsWithSignature(store);

    expect(second.signature).toBe(first.signature);
  });

  it('should change the signature when the pasted access key rotates under the same profile name', () => {
    const before = resolveAwsClientCredentialsWithSignature(
      makeStore('hyveon-pasted', { accessKeyId: 'AKID-OLD', secretAccessKey: 'SECRET-OLD' }),
    );
    const after = resolveAwsClientCredentialsWithSignature(
      makeStore('hyveon-pasted', { accessKeyId: 'AKID-NEW', secretAccessKey: 'SECRET-NEW' }),
    );

    expect(after.signature).not.toBe(before.signature);
  });

  it('should change the signature when switching from a pasted entry to a real CLI profile', () => {
    const pasted = resolveAwsClientCredentialsWithSignature(
      makeStore('default', { accessKeyId: 'AKID', secretAccessKey: 'SECRET' }),
    );
    const profile = resolveAwsClientCredentialsWithSignature(makeStore('default', undefined));

    expect(profile.signature).not.toBe(pasted.signature);
  });

  it('should throw AwsPastedCredentialDecryptError when the underlying source can\'t be resolved', () => {
    const store = makeStoreWithUndecryptableCredentials('hyveon-pasted', new Error('decrypt failed'));

    expect(() => resolveAwsClientCredentialsWithSignature(store)).toThrow(AwsPastedCredentialDecryptError);
  });
});
