import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, CreateAccessKeyCommand, DeleteAccessKeyCommand } from '@aws-sdk/client-iam';
import type { ParsedIniData } from '@smithy/types';
import {
  AwsProfileService,
  DEFAULT_PASTED_PROFILE_NAME,
  SafeStorageUnavailableError,
  InvalidPastedCredentialsError,
  UnsupportedCredentialSourceError,
} from './AwsProfileService.js';
import { logger } from '../logger.js';
import type { SafeStorageService } from './SafeStorageService.js';
import type { AppStoreSchema, ElectronStoreService } from './ElectronStoreService.js';

/**
 * Fixture "home directory" containing `.aws/credentials` and `.aws/config`
 * with a mix of profiles: `default` and `dev` in both files (region agrees
 * in both), `prod` defined only via a config-file `[profile prod]` section
 * (no credentials entry) — this exercises the config-file `profile <name>` →
 * `<name>` normalization real `aws configure list-profiles` output relies
 * on — and `noregion`, a credentials-only profile with no region anywhere.
 */
const FIXTURE_HOME = fileURLToPath(new URL('./__fixtures__/aws-profile', import.meta.url));

/**
 * The parent of {@link FIXTURE_HOME} has no `.aws` directory of its own —
 * used to exercise the missing-files path without needing a second,
 * otherwise-empty fixture directory.
 */
const EMPTY_HOME = dirname(FIXTURE_HOME);

/** Builds a `SafeStorageService` stub whose `isAvailable()` returns `available`. */
function stubSafeStorage(available = true): SafeStorageService {
  return {
    isAvailable: vi.fn().mockReturnValue(available),
    encrypt: vi.fn((v: string) => `enc-${v}`),
    decrypt: vi.fn((v: string) => v),
  } as Partial<SafeStorageService> as SafeStorageService;
}

/** Builds an `ElectronStoreService` stub with a spy-able `setPastedCredentials`. */
function stubStore(): ElectronStoreService {
  return {
    setPastedCredentials: vi.fn(),
    getPastedCredentials: vi.fn(),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

/**
 * Fixture-specific `AwsProfileService` subclass overriding the protected
 * `homeDir()` seam to return a fixed directory, avoiding a `vi.spyOn` +
 * `as unknown as` cast to reach a protected method.
 */
class FixtureAwsProfileService extends AwsProfileService {
  constructor(
    private readonly home: string,
    safeStorage: SafeStorageService,
    store: ElectronStoreService,
  ) {
    super(safeStorage, store);
  }

  protected override homeDir(): string {
    return this.home;
  }
}

/** Builds an `AwsProfileService` whose `homeDir()` seam returns `home`. */
function makeService(home: string): AwsProfileService {
  return new FixtureAwsProfileService(home, stubSafeStorage(), stubStore());
}

/**
 * Test-only subclass whose `parseFiles()` seam always rejects — exercises
 * `listProfiles()`'s failure path (log-and-rethrow-a-plain-Error) without
 * needing a real unreadable `~/.aws` file on disk.
 */
class FailingParseAwsProfileService extends AwsProfileService {
  protected override async parseFiles(): Promise<ParsedIniData> {
    throw new Error('EACCES: permission denied');
  }
}

describe('AwsProfileService.listProfiles', () => {
  it('should list profiles merged from both credentials and config files, sorted by name', async () => {
    const profiles = await makeService(FIXTURE_HOME).listProfiles();
    expect(profiles.map((p) => p.profileName)).toEqual(['default', 'dev', 'noregion', 'prod']);
  });

  it('should pick up region from the merged profile data', async () => {
    const profiles = await makeService(FIXTURE_HOME).listProfiles();
    const byName = Object.fromEntries(profiles.map((p) => [p.profileName, p]));
    expect(byName['default']?.region).toBe('us-east-1');
    expect(byName['dev']?.region).toBe('us-west-2');
  });

  it('should normalize a config-file "[profile <name>]" section to just "<name>"', async () => {
    const profiles = await makeService(FIXTURE_HOME).listProfiles();
    const prod = profiles.find((p) => p.profileName === 'prod');
    expect(prod).toEqual({ profileName: 'prod', region: 'eu-west-1' });
  });

  it('should include a profile defined only in the config file (no credentials entry)', async () => {
    const profiles = await makeService(FIXTURE_HOME).listProfiles();
    expect(profiles.some((p) => p.profileName === 'prod')).toBe(true);
  });

  it('should never expose aws_access_key_id/aws_secret_access_key or other non-region fields', async () => {
    const profiles = await makeService(FIXTURE_HOME).listProfiles();
    for (const profile of profiles) {
      expect(Object.keys(profile).every((key) => key === 'profileName' || key === 'region')).toBe(true);
    }
  });

  it('should return an empty array when neither credentials nor config files exist', async () => {
    const profiles = await makeService(EMPTY_HOME).listProfiles();
    expect(profiles).toEqual([]);
  });

  it('should omit the region property entirely when a profile has none set', async () => {
    const profiles = await makeService(FIXTURE_HOME).listProfiles();
    const noregion = profiles.find((p) => p.profileName === 'noregion');
    expect(noregion).toEqual({ profileName: 'noregion' });
    expect(noregion).not.toHaveProperty('region');
  });

  it('should log a debug line on entry before reading the AWS CLI files', async () => {
    const debugSpy = vi.spyOn(logger, 'debug');

    await makeService(FIXTURE_HOME).listProfiles();

    expect(debugSpy).toHaveBeenCalledWith('AwsProfileService.listProfiles: reading AWS CLI profiles from disk');
  });

  it('should log a warning and rethrow a plain Error (never the raw error object) when parsing the AWS CLI files fails', async () => {
    const service = new FailingParseAwsProfileService(stubSafeStorage(), stubStore());
    const warnSpy = vi.spyOn(logger, 'warn');

    await expect(service.listProfiles()).rejects.toThrow('EACCES: permission denied');

    expect(warnSpy).toHaveBeenCalledWith(
      'AwsProfileService.listProfiles: failed to parse ~/.aws/credentials or ~/.aws/config',
      expect.objectContaining({ error: 'EACCES: permission denied' }),
    );
  });
});

describe('AwsProfileService.savePastedCredentials', () => {
  it('should throw SafeStorageUnavailableError and write nothing when safeStorage is unavailable', () => {
    const safeStorage = stubSafeStorage(false);
    const store = stubStore();
    const service = new AwsProfileService(safeStorage, store);

    expect(() =>
      service.savePastedCredentials({ accessKeyId: 'AKID', secretAccessKey: 'SECRET' }),
    ).toThrow(SafeStorageUnavailableError);
    expect(store.setPastedCredentials).not.toHaveBeenCalled();
  });

  it('should default the profile name to hyveon-pasted when none is supplied', () => {
    const store = stubStore();
    const service = new AwsProfileService(stubSafeStorage(true), store);

    const result = service.savePastedCredentials({ accessKeyId: 'AKID', secretAccessKey: 'SECRET' });

    expect(result).toEqual({ profileName: DEFAULT_PASTED_PROFILE_NAME });
    expect(store.setPastedCredentials).toHaveBeenCalledWith(
      DEFAULT_PASTED_PROFILE_NAME,
      { accessKeyId: 'AKID', secretAccessKey: 'SECRET', region: undefined },
    );
  });

  it('should use the supplied profile name when given', () => {
    const store = stubStore();
    const service = new AwsProfileService(stubSafeStorage(true), store);

    const result = service.savePastedCredentials({
      profileName: 'my-profile',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      region: 'eu-west-1',
    });

    expect(result).toEqual({ profileName: 'my-profile' });
    expect(store.setPastedCredentials).toHaveBeenCalledWith('my-profile', {
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      region: 'eu-west-1',
    });
  });

  it('should fall back to the default profile name when profileName is blank or whitespace-only', () => {
    const store = stubStore();
    const service = new AwsProfileService(stubSafeStorage(true), store);

    const result = service.savePastedCredentials({
      profileName: '   ',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
    });

    expect(result).toEqual({ profileName: DEFAULT_PASTED_PROFILE_NAME });
    expect(store.setPastedCredentials).toHaveBeenCalledWith(
      DEFAULT_PASTED_PROFILE_NAME,
      expect.anything(),
    );
  });

  it('should throw InvalidPastedCredentialsError and write nothing when accessKeyId is blank', () => {
    const store = stubStore();
    const service = new AwsProfileService(stubSafeStorage(true), store);

    expect(() =>
      service.savePastedCredentials({ accessKeyId: '  ', secretAccessKey: 'SECRET' }),
    ).toThrow(InvalidPastedCredentialsError);
    expect(store.setPastedCredentials).not.toHaveBeenCalled();
  });

  it('should throw InvalidPastedCredentialsError and write nothing when secretAccessKey is blank', () => {
    const store = stubStore();
    const service = new AwsProfileService(stubSafeStorage(true), store);

    expect(() =>
      service.savePastedCredentials({ accessKeyId: 'AKID', secretAccessKey: '' }),
    ).toThrow(InvalidPastedCredentialsError);
    expect(store.setPastedCredentials).not.toHaveBeenCalled();
  });
});

/**
 * Test-only subclass that re-exposes `AwsProfileService`'s protected AWS
 * client construction seams as public overrides so `vi.spyOn` can target
 * them directly, mirroring `GuidedIamService.test.ts`'s
 * `TestableGuidedIamService` pattern — avoids `as unknown as` casts.
 */
class TestableAwsProfileService extends AwsProfileService {
  public override createStsClient(creds: { accessKeyId: string; secretAccessKey: string; region: string }): STSClient {
    return super.createStsClient(creds);
  }

  public override createIamClient(creds: { accessKeyId: string; secretAccessKey: string; region: string }): IAMClient {
    return super.createIamClient(creds);
  }

  public override buildIamSecurityCredentialsConsoleUrl(): string {
    return super.buildIamSecurityCredentialsConsoleUrl();
  }

  public override sleep(ms: number): Promise<void> {
    return super.sleep(ms);
  }
}

/**
 * Build an `ElectronStoreService` stub for `rotateActiveCredentials` tests.
 * `get('aws')` resolves to `aws`; `get('creds')` resolves to a
 * `creds.aws.<profile>.region` map built from `credsRegionByProfile` (the
 * plaintext fallback `rotateActiveCredentials` reads when `aws.region` is
 * missing/empty); `getPastedCredentials` resolves to `pastedCredentials` for
 * any profile name (matching `resolveAwsCredentialSource`'s
 * single-active-profile assumption); `setPastedCredentials` is a spy.
 */
function makeRotationStore(options: {
  aws?: AppStoreSchema['aws'];
  pastedCredentials?: { accessKeyId: string; secretAccessKey: string; region?: string };
  credsRegionByProfile?: Record<string, string>;
} = {}): ElectronStoreService {
  const creds = options.credsRegionByProfile
    ? { aws: Object.fromEntries(Object.entries(options.credsRegionByProfile).map(([profile, region]) => [profile, { region }])) }
    : undefined;
  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'aws') return options.aws;
      if (key === 'creds') return creds;
      return undefined;
    }),
    getPastedCredentials: vi.fn().mockReturnValue(options.pastedCredentials),
    setPastedCredentials: vi.fn(),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

describe('AwsProfileService.rotateActiveCredentials', () => {
  const PROFILE = 'hyveon-pasted';
  const REGION = 'us-west-2';
  const CURRENT_ACCESS_KEY_ID = 'AKIACURRENTKEY';
  const CURRENT_SECRET = 'current-secret-value-xyz';
  const NEW_ACCESS_KEY_ID = 'AKIANEWLYMINTEDKEY';
  const NEW_SECRET = 'newly-minted-secret-value-abc';

  /** Typed stand-in for the AWS STS SDK client, shared across every test below. */
  const stsMock = mockClient(STSClient);

  /** Typed stand-in for the AWS IAM SDK client, shared across every test below. */
  const iamMock = mockClient(IAMClient);

  let service: TestableAwsProfileService;
  let store: ElectronStoreService;

  /** Store fixture with a `kind: 'pasted'` active source under {@link PROFILE}. */
  function makePastedStore(): ElectronStoreService {
    return makeRotationStore({
      aws: { profile: PROFILE, region: REGION },
      pastedCredentials: { accessKeyId: CURRENT_ACCESS_KEY_ID, secretAccessKey: CURRENT_SECRET },
    });
  }

  /** Resolves `iam:CreateAccessKey` with a fresh key pair using the fixture values above. */
  function stubCreateAccessKeySuccess(): void {
    iamMock.on(CreateAccessKeyCommand).resolves({
      AccessKey: {
        UserName: 'hyveon-user',
        AccessKeyId: NEW_ACCESS_KEY_ID,
        SecretAccessKey: NEW_SECRET,
        Status: 'Active',
      },
    });
  }

  beforeEach(() => {
    store = makePastedStore();
    service = new TestableAwsProfileService(stubSafeStorage(true), store);
    stsMock.reset();
    iamMock.reset();
    // Zero-delay by default so the retry loop never adds real elapsed
    // wall-clock time to tests that don't specifically assert on it.
    vi.spyOn(TestableAwsProfileService.prototype, 'sleep').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should throw SafeStorageUnavailableError and never call any AWS API when the keychain is unavailable', async () => {
    service = new TestableAwsProfileService(stubSafeStorage(false), store);

    await expect(service.rotateActiveCredentials()).rejects.toThrow(SafeStorageUnavailableError);
    expect(iamMock.commandCalls(CreateAccessKeyCommand)).toHaveLength(0);
    expect(store.setPastedCredentials).not.toHaveBeenCalled();
  });

  it('should throw UnsupportedCredentialSourceError and never call any AWS API when the active source is kind: profile', async () => {
    store = makeRotationStore({ aws: { profile: 'my-cli-profile', region: REGION } }); // getPastedCredentials -> undefined
    service = new TestableAwsProfileService(stubSafeStorage(true), store);

    await expect(service.rotateActiveCredentials()).rejects.toThrow(UnsupportedCredentialSourceError);
    expect(iamMock.commandCalls(CreateAccessKeyCommand)).toHaveLength(0);
    expect(store.setPastedCredentials).not.toHaveBeenCalled();
  });

  it('should throw UnsupportedCredentialSourceError and never call any AWS API when the active source is kind: none', async () => {
    store = makeRotationStore(); // no aws.profile at all
    service = new TestableAwsProfileService(stubSafeStorage(true), store);

    await expect(service.rotateActiveCredentials()).rejects.toThrow(UnsupportedCredentialSourceError);
    expect(iamMock.commandCalls(CreateAccessKeyCommand)).toHaveLength(0);
    expect(store.setPastedCredentials).not.toHaveBeenCalled();
  });

  it('should throw and never call any AWS API when neither aws.region nor the pasted entry has a region', async () => {
    store = makeRotationStore({
      aws: { profile: PROFILE },
      pastedCredentials: { accessKeyId: CURRENT_ACCESS_KEY_ID, secretAccessKey: CURRENT_SECRET },
    });
    service = new TestableAwsProfileService(stubSafeStorage(true), store);

    await expect(service.rotateActiveCredentials()).rejects.toThrow(/no region is configured/);
    expect(iamMock.commandCalls(CreateAccessKeyCommand)).toHaveLength(0);
    expect(store.setPastedCredentials).not.toHaveBeenCalled();
  });

  it('should fall back to the pasted entry region and succeed when aws.region is missing', async () => {
    stubCreateAccessKeySuccess();
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    iamMock.on(DeleteAccessKeyCommand).resolves({});
    store = makeRotationStore({
      aws: { profile: PROFILE },
      pastedCredentials: { accessKeyId: CURRENT_ACCESS_KEY_ID, secretAccessKey: CURRENT_SECRET },
      credsRegionByProfile: { [PROFILE]: REGION },
    });
    service = new TestableAwsProfileService(stubSafeStorage(true), store);

    const result = await service.rotateActiveCredentials();

    expect(result).toEqual({ status: 'complete' });
    expect(store.setPastedCredentials).toHaveBeenCalledWith(PROFILE, {
      accessKeyId: NEW_ACCESS_KEY_ID,
      secretAccessKey: NEW_SECRET,
      region: REGION,
    });
  });

  it('should fall back to the pasted entry region and succeed when aws.region is an empty string', async () => {
    stubCreateAccessKeySuccess();
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    iamMock.on(DeleteAccessKeyCommand).resolves({});
    store = makeRotationStore({
      aws: { profile: PROFILE, region: '' },
      pastedCredentials: { accessKeyId: CURRENT_ACCESS_KEY_ID, secretAccessKey: CURRENT_SECRET },
      credsRegionByProfile: { [PROFILE]: REGION },
    });
    service = new TestableAwsProfileService(stubSafeStorage(true), store);

    const result = await service.rotateActiveCredentials();

    expect(result).toEqual({ status: 'complete' });
    expect(store.setPastedCredentials).toHaveBeenCalledWith(PROFILE, {
      accessKeyId: NEW_ACCESS_KEY_ID,
      secretAccessKey: NEW_SECRET,
      region: REGION,
    });
  });

  it('should perform CreateAccessKey(current client) -> GetCallerIdentity(new client) -> setPastedCredentials -> DeleteAccessKey(old key, new client) in exact order on success', async () => {
    const order: string[] = [];
    iamMock.on(CreateAccessKeyCommand).callsFake(() => {
      order.push('CreateAccessKey');
      return {
        AccessKey: {
          UserName: 'hyveon-user',
          AccessKeyId: NEW_ACCESS_KEY_ID,
          SecretAccessKey: NEW_SECRET,
          Status: 'Active',
        },
      };
    });
    stsMock.on(GetCallerIdentityCommand).callsFake(() => {
      order.push('GetCallerIdentity');
      return { Account: '123456789012' };
    });
    iamMock.on(DeleteAccessKeyCommand).callsFake(() => {
      order.push('DeleteAccessKey');
      return {};
    });
    store = {
      get: vi.fn().mockReturnValue({ profile: PROFILE, region: REGION }),
      getPastedCredentials: vi.fn().mockReturnValue({ accessKeyId: CURRENT_ACCESS_KEY_ID, secretAccessKey: CURRENT_SECRET }),
      setPastedCredentials: vi.fn().mockImplementation(() => order.push('setPastedCredentials')),
    } as Partial<ElectronStoreService> as ElectronStoreService;
    service = new TestableAwsProfileService(stubSafeStorage(true), store);
    const createIamClientSpy = vi.spyOn(service, 'createIamClient');
    const createStsClientSpy = vi.spyOn(service, 'createStsClient');

    const result = await service.rotateActiveCredentials();

    expect(result).toEqual({ status: 'complete' });
    expect(order).toEqual(['CreateAccessKey', 'GetCallerIdentity', 'setPastedCredentials', 'DeleteAccessKey']);

    // Step 1: IAM client for CreateAccessKey built from the CURRENT key.
    expect(createIamClientSpy).toHaveBeenNthCalledWith(1, {
      accessKeyId: CURRENT_ACCESS_KEY_ID,
      secretAccessKey: CURRENT_SECRET,
      region: REGION,
    });
    // Step 2: STS client for verification built from the NEW key, not the current key.
    expect(createStsClientSpy).toHaveBeenCalledWith({
      accessKeyId: NEW_ACCESS_KEY_ID,
      secretAccessKey: NEW_SECRET,
      region: REGION,
    });
    // Step 3: rotated credentials stored under the SAME profile name (in-place).
    expect(store.setPastedCredentials).toHaveBeenCalledWith(PROFILE, {
      accessKeyId: NEW_ACCESS_KEY_ID,
      secretAccessKey: NEW_SECRET,
      region: REGION,
    });
    // Step 4: IAM client for DeleteAccessKey built from the NEW key, targeting the OLD key's AccessKeyId.
    expect(createIamClientSpy).toHaveBeenNthCalledWith(2, {
      accessKeyId: NEW_ACCESS_KEY_ID,
      secretAccessKey: NEW_SECRET,
      region: REGION,
    });
    const deleteCalls = iamMock.commandCalls(DeleteAccessKeyCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]!.args[0].input).toEqual({ AccessKeyId: CURRENT_ACCESS_KEY_ID });
  });

  it('should return verification-failed and leave the stored credentials untouched when GetCallerIdentity fails for the new key', async () => {
    stubCreateAccessKeySuccess();
    const verifyError = new Error('The security token included in the request is invalid');
    verifyError.name = 'InvalidClientTokenId';
    stsMock.on(GetCallerIdentityCommand).rejects(verifyError);
    iamMock.on(DeleteAccessKeyCommand).resolves({});

    const result = await service.rotateActiveCredentials();

    expect(result).toEqual({ status: 'verification-failed', error: verifyError.message });
    // The OLD credentials remain active — the store is never overwritten.
    expect(store.setPastedCredentials).not.toHaveBeenCalled();
  });

  it('should retry verification and succeed once GetCallerIdentity succeeds within the retry window', async () => {
    stubCreateAccessKeySuccess();
    const verifyError = new Error('The security token included in the request is invalid');
    verifyError.name = 'InvalidClientTokenId';
    stsMock
      .on(GetCallerIdentityCommand)
      .rejectsOnce(verifyError)
      .rejectsOnce(verifyError)
      .resolves({ Account: '123456789012' });
    iamMock.on(DeleteAccessKeyCommand).resolves({});

    const result = await service.rotateActiveCredentials();

    expect(result).toEqual({ status: 'complete' });
    expect(stsMock.commandCalls(GetCallerIdentityCommand)).toHaveLength(3);
    // No orphan cleanup of the NEW key — verification eventually succeeded.
    expect(iamMock.commandCalls(DeleteAccessKeyCommand)[0]!.args[0].input).toEqual({
      AccessKeyId: CURRENT_ACCESS_KEY_ID,
    });
  });

  it('should attempt verification up to 6 times total before returning verification-failed when GetCallerIdentity fails every time', async () => {
    stubCreateAccessKeySuccess();
    const verifyError = new Error('The security token included in the request is invalid');
    verifyError.name = 'InvalidClientTokenId';
    stsMock.on(GetCallerIdentityCommand).rejects(verifyError);
    iamMock.on(DeleteAccessKeyCommand).resolves({});

    const result = await service.rotateActiveCredentials();

    expect(result).toEqual({ status: 'verification-failed', error: verifyError.message });
    expect(stsMock.commandCalls(GetCallerIdentityCommand)).toHaveLength(6);
  });

  it('should sleep with the exact backoff schedule between failed verification attempts', async () => {
    stubCreateAccessKeySuccess();
    const verifyError = new Error('The security token included in the request is invalid');
    verifyError.name = 'InvalidClientTokenId';
    stsMock.on(GetCallerIdentityCommand).rejects(verifyError);
    iamMock.on(DeleteAccessKeyCommand).resolves({});
    const sleepSpy = vi.spyOn(TestableAwsProfileService.prototype, 'sleep').mockResolvedValue(undefined);

    await service.rotateActiveCredentials();

    expect(sleepSpy.mock.calls.map((call) => call[0])).toEqual([1000, 2000, 4000, 8000, 8000]);
  });

  it('should stop sleeping once verification succeeds on a retry', async () => {
    stubCreateAccessKeySuccess();
    const verifyError = new Error('The security token included in the request is invalid');
    verifyError.name = 'InvalidClientTokenId';
    stsMock.on(GetCallerIdentityCommand).rejectsOnce(verifyError).rejectsOnce(verifyError).resolves({ Account: '123456789012' });
    iamMock.on(DeleteAccessKeyCommand).resolves({});
    const sleepSpy = vi.spyOn(TestableAwsProfileService.prototype, 'sleep').mockResolvedValue(undefined);

    await service.rotateActiveCredentials();

    expect(sleepSpy.mock.calls.map((call) => call[0])).toEqual([1000, 2000]);
  });

  it('should log one warning per failed verification attempt plus one final error once all attempts are exhausted', async () => {
    stubCreateAccessKeySuccess();
    const verifyError = new Error('The security token included in the request is invalid');
    verifyError.name = 'InvalidClientTokenId';
    stsMock.on(GetCallerIdentityCommand).rejects(verifyError);
    iamMock.on(DeleteAccessKeyCommand).resolves({});
    const warnSpy = vi.spyOn(logger, 'warn');
    const errorSpy = vi.spyOn(logger, 'error');

    await service.rotateActiveCredentials();

    const perAttemptWarnings = warnSpy.mock.calls.filter((call) => /verification attempt failed/.test(String(call[0])));
    const exhaustedErrors = errorSpy.mock.calls.filter((call) => /exhausting all retry attempts/.test(String(call[0])));
    expect(perAttemptWarnings).toHaveLength(6);
    expect(exhaustedErrors).toHaveLength(1);
  });

  it('should clean up the orphaned new key (not the old key) using the CURRENT key client when verification fails', async () => {
    stubCreateAccessKeySuccess();
    const verifyError = new Error('The security token included in the request is invalid');
    verifyError.name = 'InvalidClientTokenId';
    stsMock.on(GetCallerIdentityCommand).rejects(verifyError);
    iamMock.on(DeleteAccessKeyCommand).resolves({});
    const createIamClientSpy = vi.spyOn(service, 'createIamClient');

    const result = await service.rotateActiveCredentials();

    expect(result).toEqual({ status: 'verification-failed', error: verifyError.message });
    const deleteCalls = iamMock.commandCalls(DeleteAccessKeyCommand);
    expect(deleteCalls).toHaveLength(1);
    // Targets the orphaned NEW key, never the current (still-active) key.
    expect(deleteCalls[0]!.args[0].input).toEqual({ AccessKeyId: NEW_ACCESS_KEY_ID });
    // Only one IAM client was ever built (step 1's current-key client) — the
    // cleanup delete reuses it rather than building a second one.
    expect(createIamClientSpy).toHaveBeenCalledTimes(1);
    expect(createIamClientSpy).toHaveBeenCalledWith({
      accessKeyId: CURRENT_ACCESS_KEY_ID,
      secretAccessKey: CURRENT_SECRET,
      region: REGION,
    });
    expect(store.setPastedCredentials).not.toHaveBeenCalled();
  });

  it('should still return verification-failed (not a new status) and not throw when the orphaned-key cleanup delete also fails', async () => {
    stubCreateAccessKeySuccess();
    const verifyError = new Error('The security token included in the request is invalid');
    verifyError.name = 'InvalidClientTokenId';
    stsMock.on(GetCallerIdentityCommand).rejects(verifyError);
    const cleanupError = new Error('User is not authorized to perform iam:DeleteAccessKey');
    cleanupError.name = 'AccessDenied';
    iamMock.on(DeleteAccessKeyCommand).rejects(cleanupError);

    const result = await service.rotateActiveCredentials();

    expect(result).toEqual({ status: 'verification-failed', error: verifyError.message });
    expect(store.setPastedCredentials).not.toHaveBeenCalled();
  });

  it('should return delete-failed with a console URL and leave the new key stored/active when DeleteAccessKey fails for the old key', async () => {
    stubCreateAccessKeySuccess();
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    const deleteError = new Error('User is not authorized to perform iam:DeleteAccessKey');
    deleteError.name = 'AccessDenied';
    iamMock.on(DeleteAccessKeyCommand).rejects(deleteError);

    const result = await service.rotateActiveCredentials();

    expect(result).toEqual({
      status: 'delete-failed',
      consoleUrl: expect.stringContaining('security_credentials'),
    });
    // The new key was already stored in step 3 and that is NOT rolled back.
    expect(store.setPastedCredentials).toHaveBeenCalledTimes(1);
    expect(store.setPastedCredentials).toHaveBeenCalledWith(PROFILE, {
      accessKeyId: NEW_ACCESS_KEY_ID,
      secretAccessKey: NEW_SECRET,
      region: REGION,
    });
  });

  it('should throw a clear error when CreateAccessKey does not return a usable key pair', async () => {
    iamMock.on(CreateAccessKeyCommand).resolves({ AccessKey: undefined });

    await expect(service.rotateActiveCredentials()).rejects.toThrow(/did not return a new access key pair/);
    expect(store.setPastedCredentials).not.toHaveBeenCalled();
  });

  it('should log a debug line on entry before the keychain gate or any AWS call', async () => {
    const debugSpy = vi.spyOn(logger, 'debug');
    service = new TestableAwsProfileService(stubSafeStorage(false), store);

    await expect(service.rotateActiveCredentials()).rejects.toThrow(SafeStorageUnavailableError);

    expect(debugSpy).toHaveBeenCalledWith('AwsProfileService.rotateActiveCredentials: starting active credential rotation');
  });

  it('should never log the current or newly minted secret access key across a full successful rotation', async () => {
    stubCreateAccessKeySuccess();
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    iamMock.on(DeleteAccessKeyCommand).resolves({});
    const debugSpy = vi.spyOn(logger, 'debug');
    const infoSpy = vi.spyOn(logger, 'info');
    const warnSpy = vi.spyOn(logger, 'warn');
    const errorSpy = vi.spyOn(logger, 'error');

    const result = await service.rotateActiveCredentials();

    expect(result).toEqual({ status: 'complete' });
    const allCalls = [...debugSpy.mock.calls, ...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    expect(allCalls.length).toBeGreaterThan(0);
    for (const call of allCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(CURRENT_SECRET);
      expect(serialized).not.toContain(NEW_SECRET);
    }
  });

  it('should never log the current or newly minted secret access key when verification fails', async () => {
    stubCreateAccessKeySuccess();
    const verifyError = new Error('InvalidClientTokenId');
    stsMock.on(GetCallerIdentityCommand).rejects(verifyError);
    const debugSpy = vi.spyOn(logger, 'debug');
    const infoSpy = vi.spyOn(logger, 'info');
    const warnSpy = vi.spyOn(logger, 'warn');
    const errorSpy = vi.spyOn(logger, 'error');

    await service.rotateActiveCredentials();

    const allCalls = [...debugSpy.mock.calls, ...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    // Guards against this assertion passing vacuously if logging were
    // removed from the method entirely — the verification-failure branch
    // must still emit at least a warn call.
    expect(allCalls.length).toBeGreaterThan(0);
    for (const call of allCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(CURRENT_SECRET);
      expect(serialized).not.toContain(NEW_SECRET);
    }
  });

  it('should never log the current or newly minted secret access key when DeleteAccessKey fails', async () => {
    stubCreateAccessKeySuccess();
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    iamMock.on(DeleteAccessKeyCommand).rejects(new Error('AccessDenied'));
    const debugSpy = vi.spyOn(logger, 'debug');
    const infoSpy = vi.spyOn(logger, 'info');
    const warnSpy = vi.spyOn(logger, 'warn');
    const errorSpy = vi.spyOn(logger, 'error');

    await service.rotateActiveCredentials();

    const allCalls = [...debugSpy.mock.calls, ...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    // Guards against this assertion passing vacuously if logging were
    // removed from the method entirely — the delete-failure branch must
    // still emit at least a warn call.
    expect(allCalls.length).toBeGreaterThan(0);
    for (const call of allCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(CURRENT_SECRET);
      expect(serialized).not.toContain(NEW_SECRET);
    }
  });
});
