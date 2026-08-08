import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { mockClient } from 'aws-sdk-client-mock';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, CreateAccessKeyCommand, DeleteAccessKeyCommand } from '@aws-sdk/client-iam';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

/** Spy for `resolveCloudFormationTemplatePath`, driving whether a template "exists" per test. */
const mockResolveTemplatePath = vi.hoisted(() => vi.fn());
vi.mock('../cloudformationTemplate.js', () => ({
  resolveCloudFormationTemplatePath: mockResolveTemplatePath,
}));

import { readFileSync, writeFileSync } from 'fs';
import { generateHyveonDeployAllPolicy, generateHyveonSelfRotatePolicy } from '@hyveon/shared';
import { logger } from '../logger.js';
import { GuidedIamService, GUIDED_PROFILE_NAME } from './GuidedIamService.js';
import { SafeStorageUnavailableError } from './AwsProfileService.js';
import type { AppStoreSchema, ElectronStoreService } from './ElectronStoreService.js';
import type { SafeStorageService } from './SafeStorageService.js';

/** Typed stand-in for the AWS STS SDK client, shared across the `intakeBootstrapKey`/`rotate` tests below. */
const stsMock = mockClient(STSClient);

/** Typed stand-in for the AWS IAM SDK client, shared across the `rotate` tests below. */
const iamMock = mockClient(IAMClient);

/** Strongly-typed mock handles for the `fs` module. */
const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);

/**
 * Build an `ElectronStoreService` stub whose `get('aws')` resolves to
 * `existingAws` and whose `setPastedCredentials`/`set` calls are spies —
 * used by `rotate` tests to assert exact call ordering and arguments.
 */
function makeStore(existingAws?: AppStoreSchema['aws']): ElectronStoreService {
  return {
    get: vi.fn().mockImplementation((key: string) => (key === 'aws' ? existingAws : undefined)),
    set: vi.fn(),
    setPastedCredentials: vi.fn(),
    deletePastedCredentials: vi.fn(),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

/** Build a `SafeStorageService` stub whose `isAvailable()` returns `available`. */
function makeSafeStorage(available: boolean): SafeStorageService {
  return { isAvailable: vi.fn().mockReturnValue(available) } as Partial<SafeStorageService> as SafeStorageService;
}

/**
 * Minimal CloudFormation template fixture standing in for the real
 * `iam-bootstrap.yaml`: both literal placeholder tokens `renderTemplate()`
 * must substitute, plus a `!Ref UserName` line that must survive untouched
 * (the CFN parameter is operator-editable in the console, never baked in by
 * this service).
 */
const FIXTURE_TEMPLATE = [
  'Parameters:',
  '  UserName:',
  '    Type: String',
  '    Default: hyveon',
  'Resources:',
  '  HyveonDeployAllPolicy:',
  '    Properties:',
  '      PolicyDocument: __HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__',
  '  HyveonSelfRotatePolicy:',
  '    Properties:',
  '      PolicyDocument: __HYVEON_SELF_ROTATE_POLICY_DOCUMENT__',
  '  HyveonDeployUser:',
  '    Properties:',
  '      UserName: !Ref UserName',
].join('\n');

/**
 * Test-only subclass that re-exposes `GuidedIamService`'s protected
 * environment-probing / path-resolution seams as public members so
 * `vi.spyOn` can target them directly, mirroring `ConfigService.test.ts`'s
 * `TestableConfigService` pattern — avoids `as unknown as` casts.
 */
class TestableGuidedIamService extends GuidedIamService {
  public override readIsPackaged(): boolean {
    return super.readIsPackaged();
  }

  public override readUserDataPath(): string | null {
    return super.readUserDataPath();
  }

  public override getRenderedTemplatePath(): string {
    return super.getRenderedTemplatePath();
  }

  public override readIsElectron(): boolean {
    return super.readIsElectron();
  }

  public override openExternalUrl(url: string): Promise<void> {
    return super.openExternalUrl(url);
  }

  public override createStsClient(creds: { accessKeyId: string; secretAccessKey: string; region: string }): STSClient {
    return super.createStsClient(creds);
  }

  public override createIamClient(creds: { accessKeyId: string; secretAccessKey: string; region: string }): IAMClient {
    return super.createIamClient(creds);
  }

  public override sleep(ms: number): Promise<void> {
    return super.sleep(ms);
  }
}

describe('GuidedIamService', () => {
  let service: TestableGuidedIamService;
  let store: ElectronStoreService;
  let safeStorage: SafeStorageService;

  beforeEach(() => {
    store = makeStore();
    safeStorage = makeSafeStorage(true);
    service = new TestableGuidedIamService(store, safeStorage);
    mockResolveTemplatePath.mockReset();
    mockRead.mockReset();
    mockWrite.mockReset();
    stsMock.reset();
    iamMock.reset();
    // Zero-delay by default so `rotate`'s retry loop never adds real
    // elapsed wall-clock time to tests that don't specifically assert on it.
    vi.spyOn(TestableGuidedIamService.prototype, 'sleep').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (process.versions as Record<string, string | undefined>)['electron'];
  });

  describe('buildCloudFormationConsoleUrl', () => {
    it('should construct the exact AWS CloudFormation console URL for us-east-1', () => {
      const url = service.buildCloudFormationConsoleUrl('us-east-1');
      expect(url).toBe('https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create');
    });

    it('should construct the exact AWS CloudFormation console URL for eu-west-2', () => {
      const url = service.buildCloudFormationConsoleUrl('eu-west-2');
      expect(url).toBe('https://eu-west-2.console.aws.amazon.com/cloudformation/home?region=eu-west-2#/stacks/create');
    });

    it('should include the region in both the subdomain and query parameter', () => {
      const testRegion = 'ap-southeast-1';
      const url = service.buildCloudFormationConsoleUrl(testRegion);
      // Verify region appears exactly twice: once in subdomain, once in query string.
      const regionMatches = url.match(/ap-southeast-1/g);
      expect(regionMatches).toHaveLength(2);
      expect(url).toContain(`${testRegion}.console.aws.amazon.com`);
      expect(url).toContain(`?region=${testRegion}`);
    });

    it('should not include a templateURL parameter', () => {
      const url = service.buildCloudFormationConsoleUrl('us-west-2');
      expect(url).not.toContain('templateURL');
      expect(url).not.toContain('TemplateURL');
    });
  });

  describe('renderTemplate', () => {
    it('should throw a clear error when the template cannot be located', () => {
      mockResolveTemplatePath.mockReturnValue(undefined);

      expect(() => service.renderTemplate()).toThrow(/iam-bootstrap\.yaml/);
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('should substitute both placeholder tokens with single-line JSON and leave UserName untouched', () => {
      mockResolveTemplatePath.mockReturnValue('/fake/iam-bootstrap.yaml');
      mockRead.mockReturnValue(FIXTURE_TEMPLATE);
      vi.spyOn(service, 'readIsPackaged').mockReturnValue(false);

      const result = service.renderTemplate();

      expect(mockRead).toHaveBeenCalledWith('/fake/iam-bootstrap.yaml', 'utf-8');
      expect(mockWrite).toHaveBeenCalledTimes(1);
      const [writtenPath, content] = mockWrite.mock.calls[0]!;
      expect(writtenPath).toBe(result.path);

      const rendered = content as string;
      expect(rendered).not.toContain('__HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__');
      expect(rendered).not.toContain('__HYVEON_SELF_ROTATE_POLICY_DOCUMENT__');
      expect(rendered).toContain(`PolicyDocument: ${JSON.stringify(generateHyveonDeployAllPolicy())}`);
      expect(rendered).toContain(`PolicyDocument: ${JSON.stringify(generateHyveonSelfRotatePolicy())}`);
      // UserName stays a real CloudFormation parameter reference — never substituted.
      expect(rendered).toContain('UserName: !Ref UserName');
      // Single-line JSON.stringify output (no `null, 2` pretty-print): the
      // substitution must not introduce any new line breaks.
      expect(rendered.split('\n')).toHaveLength(FIXTURE_TEMPLATE.split('\n').length);
    });
  });

  describe('openConsole', () => {
    const CONSOLE_URL = 'https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create';

    it('should return opened: true when shell.openExternal resolves', async () => {
      (process.versions as Record<string, string | undefined>)['electron'] = '30.0.0';
      vi.spyOn(service, 'openExternalUrl').mockResolvedValue(undefined);

      const result = await service.openConsole(CONSOLE_URL);

      expect(result).toEqual({ opened: true });
      expect(service.openExternalUrl).toHaveBeenCalledWith(CONSOLE_URL);
    });

    it('should return opened: false with the console URL and not throw when shell.openExternal rejects', async () => {
      (process.versions as Record<string, string | undefined>)['electron'] = '30.0.0';
      vi.spyOn(service, 'openExternalUrl').mockRejectedValue(new Error('no registered browser handler'));

      await expect(service.openConsole(CONSOLE_URL)).resolves.toEqual({ opened: false, url: CONSOLE_URL });
    });

    it('should return opened: false with the console URL and never call openExternalUrl when process.versions.electron is unset', async () => {
      const openExternalSpy = vi.spyOn(service, 'openExternalUrl');

      const result = await service.openConsole(CONSOLE_URL);

      expect(result).toEqual({ opened: false, url: CONSOLE_URL });
      expect(openExternalSpy).not.toHaveBeenCalled();
    });

    describe('readIsElectron', () => {
      it('should return false when process.versions.electron is unset', () => {
        expect(service.readIsElectron()).toBe(false);
      });

      it('should return true when process.versions.electron is set', () => {
        (process.versions as Record<string, string | undefined>)['electron'] = '30.0.0';
        expect(service.readIsElectron()).toBe(true);
      });
    });
  });

  describe('getRenderedTemplatePath', () => {
    it('should return <userData>/iam-bootstrap-rendered.yaml when packaged', () => {
      vi.spyOn(service, 'readIsPackaged').mockReturnValue(true);
      vi.spyOn(service, 'readUserDataPath').mockReturnValue('/fake/userData');

      expect(service.getRenderedTemplatePath()).toBe(path.join('/fake/userData', 'iam-bootstrap-rendered.yaml'));
    });

    it('should fall back to the repo-relative dev path when not packaged', () => {
      vi.spyOn(service, 'readIsPackaged').mockReturnValue(false);

      const result = service.getRenderedTemplatePath();
      expect(result).toMatch(/\.iam-bootstrap-dev$/);
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('should fall back to the repo-relative dev path when packaged but readUserDataPath returns null', () => {
      vi.spyOn(service, 'readIsPackaged').mockReturnValue(true);
      vi.spyOn(service, 'readUserDataPath').mockReturnValue(null);

      const result = service.getRenderedTemplatePath();
      expect(result).toMatch(/\.iam-bootstrap-dev$/);
      expect(result).not.toContain('userData');
    });

    describe('outside an Electron process', () => {
      it('should return false from readIsPackaged when process.versions.electron is unset', () => {
        expect(service.readIsPackaged()).toBe(false);
      });

      it('should return null from readUserDataPath when process.versions.electron is unset', () => {
        expect(service.readUserDataPath()).toBeNull();
      });
    });

    describe('with process.versions.electron set but the electron module unusable (matches a plain Node test process)', () => {
      it('should return false from readIsPackaged when requiring "electron" does not yield a usable app object', () => {
        (process.versions as Record<string, string | undefined>)['electron'] = '30.0.0';
        expect(service.readIsPackaged()).toBe(false);
      });

      it('should return null from readUserDataPath when requiring "electron" does not yield a usable app object', () => {
        (process.versions as Record<string, string | undefined>)['electron'] = '30.0.0';
        expect(service.readUserDataPath()).toBeNull();
      });
    });
  });

  describe('intakeBootstrapKey', () => {
    const BOOTSTRAP_INPUT = {
      accessKeyId: 'AKIABOOTSTRAPKEY',
      secretAccessKey: 'super-secret-bootstrap-value',
      region: 'us-west-2',
    };

    it('should return the resolved account ID for a valid bootstrap key pair', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/hyveon-bootstrap',
      });

      const result = await service.intakeBootstrapKey(BOOTSTRAP_INPUT);

      expect(result).toEqual({ accountId: '123456789012' });
      const calls = stsMock.commandCalls(GetCallerIdentityCommand);
      expect(calls).toHaveLength(1);
    });

    it('should build the STS client directly from the submitted credentials and region, not from ElectronStoreService', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
      const createStsClientSpy = vi.spyOn(service, 'createStsClient');

      await service.intakeBootstrapKey(BOOTSTRAP_INPUT);

      expect(createStsClientSpy).toHaveBeenCalledWith(BOOTSTRAP_INPUT);
    });

    it('should propagate the original AWS error unchanged when the bootstrap key is invalid', async () => {
      const awsError = new Error('The security token included in the request is invalid');
      awsError.name = 'InvalidClientTokenId';
      stsMock.on(GetCallerIdentityCommand).rejects(awsError);

      await expect(service.intakeBootstrapKey(BOOTSTRAP_INPUT)).rejects.toMatchObject({
        name: 'InvalidClientTokenId',
        message: 'The security token included in the request is invalid',
      });
    });

    it('should log a warning (never the secret access key) when the bootstrap key is invalid', async () => {
      const awsError = new Error('The security token included in the request is invalid');
      awsError.name = 'InvalidClientTokenId';
      stsMock.on(GetCallerIdentityCommand).rejects(awsError);
      const loggerWarnSpy = vi.spyOn(logger, 'warn');

      await expect(service.intakeBootstrapKey(BOOTSTRAP_INPUT)).rejects.toThrow();

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        'GuidedIamService.intakeBootstrapKey: failed to validate the pasted bootstrap key',
        { region: BOOTSTRAP_INPUT.region, error: awsError.message },
      );
      const loggedPayload = loggerWarnSpy.mock.calls[0]?.[1];
      expect(JSON.stringify(loggedPayload)).not.toContain(BOOTSTRAP_INPUT.secretAccessKey);
    });

    it('should throw a clear error when a successful response is missing the Account field', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon-bootstrap' });

      await expect(service.intakeBootstrapKey(BOOTSTRAP_INPUT)).rejects.toThrow(/did not return an Account/);
    });
  });

  describe('rotate', () => {
    const BOOTSTRAP_ACCESS_KEY_ID = 'AKIABOOTSTRAPKEY';
    const BOOTSTRAP_SECRET = 'bootstrap-secret-value-xyz';
    const NEW_ACCESS_KEY_ID = 'AKIANEWLYMINTEDKEY';
    const NEW_SECRET = 'newly-minted-secret-value-abc';
    const REGION = 'us-west-2';

    const ROTATION_INPUT = {
      bootstrapAccessKeyId: BOOTSTRAP_ACCESS_KEY_ID,
      bootstrapSecretAccessKey: BOOTSTRAP_SECRET,
      region: REGION,
    };

    /** Resolves `iam:CreateAccessKey` with a fresh key pair using the fixture values above. */
    function stubCreateAccessKeySuccess(): void {
      iamMock.on(CreateAccessKeyCommand).resolves({
        AccessKey: {
          UserName: 'hyveon-bootstrap',
          AccessKeyId: NEW_ACCESS_KEY_ID,
          SecretAccessKey: NEW_SECRET,
          Status: 'Active',
        },
      });
    }

    it('should throw SafeStorageUnavailableError and never call iam:CreateAccessKey when the keychain is unavailable', async () => {
      safeStorage = makeSafeStorage(false);
      service = new TestableGuidedIamService(store, safeStorage);

      await expect(service.rotate(ROTATION_INPUT)).rejects.toThrow(SafeStorageUnavailableError);
      expect(iamMock.commandCalls(CreateAccessKeyCommand)).toHaveLength(0);
      expect(store.setPastedCredentials).not.toHaveBeenCalled();
    });

    it('should log a debug entry line (never the bootstrap secret) when starting rotation', async () => {
      stubCreateAccessKeySuccess();
      stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
      iamMock.on(DeleteAccessKeyCommand).resolves({});
      const loggerDebugSpy = vi.spyOn(logger, 'debug');

      await service.rotate(ROTATION_INPUT);

      expect(loggerDebugSpy).toHaveBeenCalledWith('GuidedIamService.rotate: starting bootstrap key rotation', {
        region: REGION,
      });
      const loggedPayload = loggerDebugSpy.mock.calls.find(
        (call) => call[0] === 'GuidedIamService.rotate: starting bootstrap key rotation',
      )?.[1];
      expect(JSON.stringify(loggedPayload)).not.toContain(BOOTSTRAP_SECRET);
    });

    it('should perform CreateAccessKey -> setPastedCredentials -> GetCallerIdentity(new key) -> store.set(aws) -> DeleteAccessKey(bootstrap key, new client) in exact order on success', async () => {
      const order: string[] = [];
      iamMock.on(CreateAccessKeyCommand).callsFake(() => {
        order.push('CreateAccessKey');
        return {
          AccessKey: {
            UserName: 'hyveon-bootstrap',
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
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn().mockImplementation(() => order.push('store.set(aws)')),
        setPastedCredentials: vi.fn().mockImplementation(() => order.push('setPastedCredentials')),
      } as Partial<ElectronStoreService> as ElectronStoreService;
      service = new TestableGuidedIamService(store, safeStorage);
      const createIamClientSpy = vi.spyOn(service, 'createIamClient');
      const createStsClientSpy = vi.spyOn(service, 'createStsClient');

      const result = await service.rotate(ROTATION_INPUT);

      expect(result).toEqual({ status: 'complete' });
      expect(order).toEqual([
        'CreateAccessKey',
        'setPastedCredentials',
        'GetCallerIdentity',
        'store.set(aws)',
        'DeleteAccessKey',
      ]);

      // Step 1: IAM client for CreateAccessKey built from the bootstrap key.
      expect(createIamClientSpy).toHaveBeenNthCalledWith(1, {
        accessKeyId: BOOTSTRAP_ACCESS_KEY_ID,
        secretAccessKey: BOOTSTRAP_SECRET,
        region: REGION,
      });
      // Step 2: new key pair staged under GUIDED_PROFILE_NAME.
      expect(store.setPastedCredentials).toHaveBeenCalledWith(GUIDED_PROFILE_NAME, {
        accessKeyId: NEW_ACCESS_KEY_ID,
        secretAccessKey: NEW_SECRET,
        region: REGION,
      });
      // Step 3: STS client for verification built from the NEW key, not the bootstrap key.
      expect(createStsClientSpy).toHaveBeenCalledWith({
        accessKeyId: NEW_ACCESS_KEY_ID,
        secretAccessKey: NEW_SECRET,
        region: REGION,
      });
      // Step 4: activation merges with the existing aws object and sets profile/region.
      expect(store.set).toHaveBeenCalledWith('aws', { profile: GUIDED_PROFILE_NAME, region: REGION });
      // Step 5: IAM client for DeleteAccessKey built from the NEW key, targeting the bootstrap key's AccessKeyId.
      expect(createIamClientSpy).toHaveBeenNthCalledWith(2, {
        accessKeyId: NEW_ACCESS_KEY_ID,
        secretAccessKey: NEW_SECRET,
        region: REGION,
      });
      const deleteCalls = iamMock.commandCalls(DeleteAccessKeyCommand);
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0]!.args[0].input).toEqual({ AccessKeyId: BOOTSTRAP_ACCESS_KEY_ID });
    });

    it('should preserve other existing aws fields when activating the rotated key', async () => {
      stubCreateAccessKeySuccess();
      stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
      iamMock.on(DeleteAccessKeyCommand).resolves({});
      // `accessKeyId` is a field `rotate()` never touches (only `profile`/
      // `region` are overwritten) — seeding it here means this test actually
      // fails if the `...currentAws` spread in step 4 were removed, unlike
      // seeding only `profile`/`region`, both of which `rotate()` overwrites
      // anyway.
      store = makeStore({ profile: 'some-old-profile', region: 'eu-west-1', accessKeyId: 'encrypted-old-access-key-blob' });
      service = new TestableGuidedIamService(store, safeStorage);

      await service.rotate(ROTATION_INPUT);

      expect(store.set).toHaveBeenCalledWith('aws', {
        accessKeyId: 'encrypted-old-access-key-blob',
        profile: GUIDED_PROFILE_NAME,
        region: REGION,
      });
    });

    it('should return verification-failed and leave nothing active or the bootstrap key deleted when GetCallerIdentity fails for the new key', async () => {
      stubCreateAccessKeySuccess();
      const verifyError = new Error('The security token included in the request is invalid');
      verifyError.name = 'InvalidClientTokenId';
      stsMock.on(GetCallerIdentityCommand).rejects(verifyError);
      iamMock.on(DeleteAccessKeyCommand).resolves({});

      const result = await service.rotate(ROTATION_INPUT);

      expect(result).toEqual({ status: 'verification-failed', error: verifyError.message });
      expect(store.set).not.toHaveBeenCalled();
      // Staging (step 2) still happened — retrying is safe since it just overwrites the same entry.
      expect(store.setPastedCredentials).toHaveBeenCalledTimes(1);
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

      const result = await service.rotate(ROTATION_INPUT);

      expect(result).toEqual({ status: 'complete' });
      expect(stsMock.commandCalls(GetCallerIdentityCommand)).toHaveLength(3);
      // No orphan cleanup — verification eventually succeeded.
      expect(iamMock.commandCalls(DeleteAccessKeyCommand)[0]!.args[0].input).toEqual({
        AccessKeyId: BOOTSTRAP_ACCESS_KEY_ID,
      });
    });

    it('should attempt verification up to 6 times total before returning verification-failed when GetCallerIdentity fails every time', async () => {
      stubCreateAccessKeySuccess();
      const verifyError = new Error('The security token included in the request is invalid');
      verifyError.name = 'InvalidClientTokenId';
      stsMock.on(GetCallerIdentityCommand).rejects(verifyError);
      iamMock.on(DeleteAccessKeyCommand).resolves({});

      const result = await service.rotate(ROTATION_INPUT);

      expect(result).toEqual({ status: 'verification-failed', error: verifyError.message });
      expect(stsMock.commandCalls(GetCallerIdentityCommand)).toHaveLength(6);
    });

    it('should sleep with the exact backoff schedule between failed verification attempts', async () => {
      stubCreateAccessKeySuccess();
      const verifyError = new Error('The security token included in the request is invalid');
      verifyError.name = 'InvalidClientTokenId';
      stsMock.on(GetCallerIdentityCommand).rejects(verifyError);
      iamMock.on(DeleteAccessKeyCommand).resolves({});
      const sleepSpy = vi.spyOn(TestableGuidedIamService.prototype, 'sleep').mockResolvedValue(undefined);

      await service.rotate(ROTATION_INPUT);

      expect(sleepSpy.mock.calls.map((call) => call[0])).toEqual([1000, 2000, 4000, 8000, 8000]);
    });

    it('should stop sleeping once verification succeeds on a retry', async () => {
      stubCreateAccessKeySuccess();
      const verifyError = new Error('The security token included in the request is invalid');
      verifyError.name = 'InvalidClientTokenId';
      stsMock.on(GetCallerIdentityCommand).rejectsOnce(verifyError).rejectsOnce(verifyError).resolves({ Account: '123456789012' });
      const sleepSpy = vi.spyOn(TestableGuidedIamService.prototype, 'sleep').mockResolvedValue(undefined);

      await service.rotate(ROTATION_INPUT);

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

      await service.rotate(ROTATION_INPUT);

      const perAttemptWarnings = warnSpy.mock.calls.filter((call) => /verification attempt failed/.test(String(call[0])));
      const exhaustedErrors = errorSpy.mock.calls.filter((call) => /exhausting all retry attempts/.test(String(call[0])));
      expect(perAttemptWarnings).toHaveLength(6);
      expect(exhaustedErrors).toHaveLength(1);
    });

    it('should clean up the orphaned new key (not the bootstrap key) using the bootstrap key client when verification fails', async () => {
      stubCreateAccessKeySuccess();
      const verifyError = new Error('The security token included in the request is invalid');
      verifyError.name = 'InvalidClientTokenId';
      stsMock.on(GetCallerIdentityCommand).rejects(verifyError);
      iamMock.on(DeleteAccessKeyCommand).resolves({});
      const createIamClientSpy = vi.spyOn(service, 'createIamClient');

      const result = await service.rotate(ROTATION_INPUT);

      expect(result).toEqual({ status: 'verification-failed', error: verifyError.message });
      const deleteCalls = iamMock.commandCalls(DeleteAccessKeyCommand);
      expect(deleteCalls).toHaveLength(1);
      // Targets the orphaned NEW key, never the bootstrap key.
      expect(deleteCalls[0]!.args[0].input).toEqual({ AccessKeyId: NEW_ACCESS_KEY_ID });
      // Only one IAM client was ever built (step 1's bootstrap client) — the
      // cleanup delete reuses it rather than building a second one.
      expect(createIamClientSpy).toHaveBeenCalledTimes(1);
      expect(createIamClientSpy).toHaveBeenCalledWith({
        accessKeyId: BOOTSTRAP_ACCESS_KEY_ID,
        secretAccessKey: BOOTSTRAP_SECRET,
        region: REGION,
      });
    });

    it('should clear the staged pasted-credentials entry once the orphaned-key cleanup delete succeeds', async () => {
      stubCreateAccessKeySuccess();
      const verifyError = new Error('The security token included in the request is invalid');
      verifyError.name = 'InvalidClientTokenId';
      stsMock.on(GetCallerIdentityCommand).rejects(verifyError);
      iamMock.on(DeleteAccessKeyCommand).resolves({});

      await service.rotate(ROTATION_INPUT);

      expect(store.deletePastedCredentials).toHaveBeenCalledWith(GUIDED_PROFILE_NAME);
    });

    it('should still return verification-failed (not a new status) and not throw when the orphaned-key cleanup delete also fails', async () => {
      stubCreateAccessKeySuccess();
      const verifyError = new Error('The security token included in the request is invalid');
      verifyError.name = 'InvalidClientTokenId';
      stsMock.on(GetCallerIdentityCommand).rejects(verifyError);
      const cleanupError = new Error('User is not authorized to perform iam:DeleteAccessKey');
      cleanupError.name = 'AccessDenied';
      iamMock.on(DeleteAccessKeyCommand).rejects(cleanupError);

      const result = await service.rotate(ROTATION_INPUT);

      expect(result).toEqual({ status: 'verification-failed', error: verifyError.message });
      expect(store.set).not.toHaveBeenCalled();
      expect(store.deletePastedCredentials).not.toHaveBeenCalled();
    });

    it('should return delete-failed with a console URL and leave the new key active when DeleteAccessKey fails', async () => {
      stubCreateAccessKeySuccess();
      stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
      const deleteError = new Error('User is not authorized to perform iam:DeleteAccessKey');
      deleteError.name = 'AccessDenied';
      iamMock.on(DeleteAccessKeyCommand).rejects(deleteError);

      const result = await service.rotate(ROTATION_INPUT);

      expect(result).toEqual({
        status: 'delete-failed',
        consoleUrl: expect.stringContaining('security_credentials'),
      });
      // The new key was already activated in step 4 and that is NOT rolled back.
      expect(store.set).toHaveBeenCalledTimes(1);
      expect(store.set).toHaveBeenCalledWith('aws', { profile: GUIDED_PROFILE_NAME, region: REGION });
    });

    it('should throw a clear error when CreateAccessKey does not return a usable key pair', async () => {
      iamMock.on(CreateAccessKeyCommand).resolves({ AccessKey: undefined });

      await expect(service.rotate(ROTATION_INPUT)).rejects.toThrow(/did not return a new access key pair/);
      expect(store.setPastedCredentials).not.toHaveBeenCalled();
    });

    it('should never log the bootstrap or newly minted secret access key across a full successful rotation', async () => {
      stubCreateAccessKeySuccess();
      stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
      iamMock.on(DeleteAccessKeyCommand).resolves({});
      const debugSpy = vi.spyOn(logger, 'debug');
      const infoSpy = vi.spyOn(logger, 'info');
      const warnSpy = vi.spyOn(logger, 'warn');
      const errorSpy = vi.spyOn(logger, 'error');

      const result = await service.rotate(ROTATION_INPUT);

      expect(result).toEqual({ status: 'complete' });
      const allCalls = [...debugSpy.mock.calls, ...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
      expect(allCalls.length).toBeGreaterThan(0);
      for (const call of allCalls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(BOOTSTRAP_SECRET);
        expect(serialized).not.toContain(NEW_SECRET);
      }
    });

    it('should never log the bootstrap or newly minted secret access key when verification fails', async () => {
      stubCreateAccessKeySuccess();
      const verifyError = new Error('InvalidClientTokenId');
      stsMock.on(GetCallerIdentityCommand).rejects(verifyError);
      const debugSpy = vi.spyOn(logger, 'debug');
      const infoSpy = vi.spyOn(logger, 'info');
      const warnSpy = vi.spyOn(logger, 'warn');
      const errorSpy = vi.spyOn(logger, 'error');

      await service.rotate(ROTATION_INPUT);

      const allCalls = [...debugSpy.mock.calls, ...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
      expect(allCalls.length).toBeGreaterThan(0);
      for (const call of allCalls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(BOOTSTRAP_SECRET);
        expect(serialized).not.toContain(NEW_SECRET);
      }
    });

    it('should never log the bootstrap or newly minted secret access key when DeleteAccessKey fails', async () => {
      stubCreateAccessKeySuccess();
      stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
      iamMock.on(DeleteAccessKeyCommand).rejects(new Error('AccessDenied'));
      const debugSpy = vi.spyOn(logger, 'debug');
      const infoSpy = vi.spyOn(logger, 'info');
      const warnSpy = vi.spyOn(logger, 'warn');
      const errorSpy = vi.spyOn(logger, 'error');

      await service.rotate(ROTATION_INPUT);

      const allCalls = [...debugSpy.mock.calls, ...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
      expect(allCalls.length).toBeGreaterThan(0);
      for (const call of allCalls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(BOOTSTRAP_SECRET);
        expect(serialized).not.toContain(NEW_SECRET);
      }
    });
  });

  describe('revokeBootstrapKey', () => {
    const REVOKE_INPUT = { bootstrapAccessKeyId: 'AKIABOOTSTRAPKEY', region: 'us-west-2' };
    const ROTATED_ACCESS_KEY_ID = 'AKIAROTATEDKEY';
    const ROTATED_SECRET = 'rotated-secret-value-xyz';

    /**
     * Store stub whose `aws.profile` resolves to a pasted-credentials
     * entry — the shape `rotate()` step 4 always leaves behind, matching
     * `revokeBootstrapKey`'s one intended call site (the `delete-failed`
     * manual retry).
     */
    function makePastedStore(): ElectronStoreService {
      return {
        get: vi
          .fn()
          .mockImplementation((key: string) =>
            key === 'aws' ? { profile: GUIDED_PROFILE_NAME, region: REVOKE_INPUT.region } : undefined,
          ),
        set: vi.fn(),
        setPastedCredentials: vi.fn(),
        getPastedCredentials: vi
          .fn()
          .mockReturnValue({ accessKeyId: ROTATED_ACCESS_KEY_ID, secretAccessKey: ROTATED_SECRET, region: REVOKE_INPUT.region }),
      } as Partial<ElectronStoreService> as ElectronStoreService;
    }

    it('should refuse without throwing when no active credential source is configured', async () => {
      store = makeStore(); // get('aws') -> undefined, resolves to kind: 'none'
      service = new TestableGuidedIamService(store, safeStorage);

      const result = await service.revokeBootstrapKey(REVOKE_INPUT);

      expect(result.revoked).toBe(false);
      expect(result.message).toMatch(/No active AWS credential source/);
      expect(iamMock.commandCalls(DeleteAccessKeyCommand)).toHaveLength(0);
    });

    it('should refuse without throwing when the active source is a CLI profile rather than the rotated key pair', async () => {
      store = {
        get: vi
          .fn()
          .mockImplementation((key: string) => (key === 'aws' ? { profile: 'some-cli-profile', region: REVOKE_INPUT.region } : undefined)),
        set: vi.fn(),
        setPastedCredentials: vi.fn(),
        getPastedCredentials: vi.fn().mockReturnValue(undefined),
      } as Partial<ElectronStoreService> as ElectronStoreService;
      service = new TestableGuidedIamService(store, safeStorage);

      const result = await service.revokeBootstrapKey(REVOKE_INPUT);

      expect(result.revoked).toBe(false);
      expect(result.message).toMatch(/CLI profile/);
      expect(iamMock.commandCalls(DeleteAccessKeyCommand)).toHaveLength(0);
    });

    it('should refuse without throwing when the active source is a pasted profile other than the guided one, and never call any IAM command', async () => {
      store = {
        get: vi
          .fn()
          .mockImplementation((key: string) =>
            key === 'aws' ? { profile: 'hyveon-pasted', region: REVOKE_INPUT.region } : undefined,
          ),
        set: vi.fn(),
        setPastedCredentials: vi.fn(),
        getPastedCredentials: vi.fn().mockReturnValue({ accessKeyId: 'AKIAUNRELATED', secretAccessKey: 'unrelated-secret' }),
      } as Partial<ElectronStoreService> as ElectronStoreService;
      service = new TestableGuidedIamService(store, safeStorage);
      const createIamClientSpy = vi.spyOn(service, 'createIamClient');

      const result = await service.revokeBootstrapKey(REVOKE_INPUT);

      expect(result.revoked).toBe(false);
      expect(result.message).toMatch(/not the rotated guided-provisioning key pair/);
      expect(createIamClientSpy).not.toHaveBeenCalled();
      expect(iamMock.commandCalls(DeleteAccessKeyCommand)).toHaveLength(0);
    });

    it('should refuse without throwing when the stored pasted-credentials entry cannot be decrypted', async () => {
      const decryptError = new Error('bad ciphertext');
      store = {
        get: vi
          .fn()
          .mockImplementation((key: string) =>
            key === 'aws' ? { profile: GUIDED_PROFILE_NAME, region: REVOKE_INPUT.region } : undefined,
          ),
        set: vi.fn(),
        setPastedCredentials: vi.fn(),
        getPastedCredentials: vi.fn().mockImplementation(() => {
          throw decryptError;
        }),
      } as Partial<ElectronStoreService> as ElectronStoreService;
      service = new TestableGuidedIamService(store, safeStorage);

      const result = await service.revokeBootstrapKey(REVOKE_INPUT);

      expect(result.revoked).toBe(false);
      expect(result.message).toMatch(/Cannot decrypt the stored pasted-credentials entry/);
      expect(iamMock.commandCalls(DeleteAccessKeyCommand)).toHaveLength(0);
    });

    it('should return revoked: true after calling iam:DeleteAccessKey with the bootstrap key ID, using an IAM client built from the active (rotated) credentials', async () => {
      store = makePastedStore();
      service = new TestableGuidedIamService(store, safeStorage);
      iamMock.on(DeleteAccessKeyCommand).resolves({});
      const createIamClientSpy = vi.spyOn(service, 'createIamClient');

      const result = await service.revokeBootstrapKey(REVOKE_INPUT);

      expect(result).toEqual({ revoked: true });
      expect(createIamClientSpy).toHaveBeenCalledWith({
        accessKeyId: ROTATED_ACCESS_KEY_ID,
        secretAccessKey: ROTATED_SECRET,
        region: REVOKE_INPUT.region,
      });
      const calls = iamMock.commandCalls(DeleteAccessKeyCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input).toEqual({ AccessKeyId: REVOKE_INPUT.bootstrapAccessKeyId });
    });

    it('should return revoked: false with the AWS error message unmodified when iam:DeleteAccessKey fails', async () => {
      store = makePastedStore();
      service = new TestableGuidedIamService(store, safeStorage);
      const awsError = new Error('User is not authorized to perform iam:DeleteAccessKey');
      awsError.name = 'AccessDenied';
      iamMock.on(DeleteAccessKeyCommand).rejects(awsError);

      const result = await service.revokeBootstrapKey(REVOKE_INPUT);

      expect(result).toEqual({ revoked: false, message: awsError.message });
    });

    it('should log a warning when iam:DeleteAccessKey fails', async () => {
      store = makePastedStore();
      service = new TestableGuidedIamService(store, safeStorage);
      const awsError = new Error('User is not authorized to perform iam:DeleteAccessKey');
      awsError.name = 'AccessDenied';
      iamMock.on(DeleteAccessKeyCommand).rejects(awsError);
      const loggerWarnSpy = vi.spyOn(logger, 'warn');

      await service.revokeBootstrapKey(REVOKE_INPUT);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        'GuidedIamService.revokeBootstrapKey: iam:DeleteAccessKey failed for the bootstrap key',
        { bootstrapAccessKeyId: REVOKE_INPUT.bootstrapAccessKeyId, error: awsError.message },
      );
    });

    it('should log a debug entry line naming the bootstrap key being revoked', async () => {
      store = makePastedStore();
      service = new TestableGuidedIamService(store, safeStorage);
      iamMock.on(DeleteAccessKeyCommand).resolves({});
      const loggerDebugSpy = vi.spyOn(logger, 'debug');

      await service.revokeBootstrapKey(REVOKE_INPUT);

      expect(loggerDebugSpy).toHaveBeenCalledWith(
        'GuidedIamService.revokeBootstrapKey: revoking still-live bootstrap key',
        { bootstrapAccessKeyId: REVOKE_INPUT.bootstrapAccessKeyId },
      );
    });
  });
});
