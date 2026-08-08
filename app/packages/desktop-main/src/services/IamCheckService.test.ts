import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '../logger.js';
import { IamCheckService } from './IamCheckService.js';
import { GUIDED_PROFILE_NAME } from './GuidedIamService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';
import type { AwsCredentialSource } from './awsCredentialSource.js';

/** Typed stand-in for the AWS STS SDK client, shared across the tests below. */
const stsMock = mockClient(STSClient);

/** Typed stand-in for the AWS IAM SDK client, shared across the tests below. */
const iamMock = mockClient(IAMClient);

/** Build an `ElectronStoreService` stub whose `get('aws')` resolves to the given choice. */
function makeStore(
  aws: { profile?: string; region?: string } | undefined,
  pastedCredentials?: { accessKeyId: string; secretAccessKey: string; region?: string },
): ElectronStoreService {
  return {
    get: vi.fn().mockImplementation((key: string) => (key === 'aws' ? aws : undefined)),
    getPastedCredentials: vi.fn().mockReturnValue(pastedCredentials),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

/** Subclass exposing a fixed, arbitrary-length action list, so batching can be tested independent of the real policy's size. */
class TestableIamCheckService extends IamCheckService {
  constructor(
    store: ElectronStoreService,
    private readonly actions: string[],
  ) {
    super(store);
  }
  protected override actionsToCheck(): readonly string[] {
    return this.actions;
  }
}

/** Subclass stashing the most recently built IAM client, so a test can inspect which credentials it was actually constructed with. */
class ClientCapturingIamCheckService extends IamCheckService {
  lastIamClient?: IAMClient;
  protected override createIamClient(region: string, source: AwsCredentialSource): IAMClient {
    const client = super.createIamClient(region, source);
    this.lastIamClient = client;
    return client;
  }
}

/**
 * Resolves an AWS SDK v3 client's `config.credentials` provider function to
 * the plain `{ accessKeyId, secretAccessKey }` it was constructed with —
 * static credentials are normalized into a memoized async provider rather
 * than kept as the original plain object.
 */
async function resolveCredentials(client: IAMClient): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  const resolved = await client.config.credentials();
  return { accessKeyId: resolved.accessKeyId, secretAccessKey: resolved.secretAccessKey };
}

beforeEach(() => {
  stsMock.reset();
  iamMock.reset();
});

describe('IamCheckService', () => {
  describe('checkPermissions', () => {
    it('should return passed when every simulated action is allowed', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({
        EvaluationResults: [
          { EvalActionName: 'ecs:*', EvalDecision: 'allowed' },
          { EvalActionName: 's3:*', EvalDecision: 'allowed' },
        ],
      });
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      const result = await service.checkPermissions();

      expect(result).toEqual({ status: 'passed', origin: 'none', blocking: false });
    });

    it('should return missing with a minimal pasteable policy JSON when some actions are denied', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({
        EvaluationResults: [
          { EvalActionName: 'ecs:*', EvalDecision: 'allowed' },
          { EvalActionName: 's3:*', EvalDecision: 'explicitDeny' },
          { EvalActionName: 'iam:*', EvalDecision: 'implicitDeny' },
        ],
      });
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      const result = await service.checkPermissions();

      expect(result.status).toBe('missing');
      const policy = JSON.parse(result.policyJson!);
      expect(policy).toEqual({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: ['s3:*', 'iam:*'], Resource: '*' }],
      });
    });

    it('should batch SimulatePrincipalPolicy calls at 50 actions per request', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const actions = Array.from({ length: 120 }, (_, i) => `service${i}:Action`);
      const service = new TestableIamCheckService(makeStore({ region: 'us-west-2' }), actions);

      await service.checkPermissions();

      const calls = iamMock.commandCalls(SimulatePrincipalPolicyCommand);
      expect(calls).toHaveLength(3);
      expect(calls[0]!.args[0].input.ActionNames).toHaveLength(50);
      expect(calls[1]!.args[0].input.ActionNames).toHaveLength(50);
      expect(calls[2]!.args[0].input.ActionNames).toHaveLength(20);
    });

    it('should pass the caller ARN from GetCallerIdentity as the PolicySourceArn', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:role/hyveon-role' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      await service.checkPermissions();

      expect(iamMock.commandCalls(SimulatePrincipalPolicyCommand)[0]!.args[0].input.PolicySourceArn).toBe(
        'arn:aws:iam::123456789012:role/hyveon-role',
      );
    });

    it('should normalize an STS assumed-role session ARN to the underlying IAM role ARN', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({
        Arn: 'arn:aws:sts::123456789012:assumed-role/hyveon-role/hyveon-session',
      });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      await service.checkPermissions();

      expect(iamMock.commandCalls(SimulatePrincipalPolicyCommand)[0]!.args[0].input.PolicySourceArn).toBe(
        'arn:aws:iam::123456789012:role/hyveon-role',
      );
    });

    it('should preserve the partition and full role path when normalizing a GovCloud path-based-role ARN', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({
        Arn: 'arn:aws-us-gov:sts::123456789012:assumed-role/engineering/hyveon-role/hyveon-session',
      });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const service = new IamCheckService(makeStore({ region: 'us-gov-west-1' }));

      await service.checkPermissions();

      expect(iamMock.commandCalls(SimulatePrincipalPolicyCommand)[0]!.args[0].input.PolicySourceArn).toBe(
        'arn:aws-us-gov:iam::123456789012:role/engineering/hyveon-role',
      );
    });

    it('should degrade to a warning when GetCallerIdentity fails', async () => {
      stsMock.on(GetCallerIdentityCommand).rejects(new Error('access denied'));
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      const result = await service.checkPermissions();

      expect(result).toEqual({ status: 'warning', message: 'access denied', origin: 'none', blocking: false });
      expect(iamMock.commandCalls(SimulatePrincipalPolicyCommand)).toHaveLength(0);
    });

    it('should log a warning when GetCallerIdentity fails', async () => {
      stsMock.on(GetCallerIdentityCommand).rejects(new Error('access denied'));
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      await service.checkPermissions();

      expect(logger.warn).toHaveBeenCalledWith(
        'IamCheckService.checkPermissions: sts:GetCallerIdentity failed — degrading to a warning',
        { origin: 'none', error: 'access denied' },
      );
    });

    it('should degrade to a warning when SimulatePrincipalPolicy itself is not permitted', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).rejects(new Error('User is not authorized to perform iam:SimulatePrincipalPolicy'));
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      const result = await service.checkPermissions();

      expect(result.status).toBe('warning');
      expect(result.message).toMatch(/not authorized/i);
    });

    it('should log a warning when SimulatePrincipalPolicy fails', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).rejects(new Error('User is not authorized to perform iam:SimulatePrincipalPolicy'));
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      await service.checkPermissions();

      expect(logger.warn).toHaveBeenCalledWith(
        'IamCheckService.checkPermissions: iam:SimulatePrincipalPolicy failed — degrading to a warning',
        { origin: 'none', error: 'User is not authorized to perform iam:SimulatePrincipalPolicy' },
      );
    });

    it('should log a debug entry line when running the permission dry-run', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      await service.checkPermissions();

      expect(logger.debug).toHaveBeenCalledWith('IamCheckService.checkPermissions: running IAM permission dry-run');
    });

    it('should degrade to a warning when no region is configured, rather than throwing', async () => {
      const service = new IamCheckService(makeStore(undefined));

      const result = await service.checkPermissions();

      expect(result.status).toBe('warning');
      expect(result.message).toMatch(/no region is configured/i);
    });

    it('should build the STS/IAM clients with static credentials when the profile resolves to pasted credentials', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const store = makeStore({ profile: 'hyveon-pasted', region: 'us-west-2' }, {
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      });
      const service = new IamCheckService(store);

      const result = await service.checkPermissions();

      expect(result).toEqual({ status: 'passed', origin: 'pasted', blocking: false });
      expect(store.getPastedCredentials).toHaveBeenCalledWith('hyveon-pasted');
    });

    it('should build the IAM client and resolve origin from the same snapshot as the STS call, even if the store changes in between', async () => {
      const ORIGINAL_CREDS = { accessKeyId: 'AKID-ORIGINAL', secretAccessKey: 'SECRET-ORIGINAL' };
      const ROTATED_CREDS = { accessKeyId: 'AKID-ROTATED', secretAccessKey: 'SECRET-ROTATED' };
      let activePastedCredentials = ORIGINAL_CREDS;
      const store = {
        get: vi.fn().mockImplementation((key: string) => (key === 'aws' ? { profile: 'hyveon-pasted', region: 'us-west-2' } : undefined)),
        getPastedCredentials: vi.fn().mockImplementation(() => activePastedCredentials),
      } as Partial<ElectronStoreService> as ElectronStoreService;

      stsMock.on(GetCallerIdentityCommand).callsFake(() => {
        // Simulate a concurrent AwsProfileService.rotateActiveCredentials()
        // completing while this STS call is in flight — the store's pasted
        // entry for the same profile is now a different key pair.
        activePastedCredentials = ROTATED_CREDS;
        return { Arn: 'arn:aws:iam::123456789012:user/hyveon' };
      });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const service = new ClientCapturingIamCheckService(store);

      const result = await service.checkPermissions();

      expect(result).toEqual({ status: 'passed', origin: 'pasted', blocking: false });
      const iamCredentials = await resolveCredentials(service.lastIamClient!);
      expect(iamCredentials).toEqual(ORIGINAL_CREDS);
    });
  });

  describe('origin and blocking', () => {
    it('should resolve origin as none and blocking as false when no credential source is configured', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      const result = await service.checkPermissions();

      expect(result).toEqual({ status: 'passed', origin: 'none', blocking: false });
    });

    it('should resolve origin as profile when the stored profile does not resolve to a pasted entry', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const service = new IamCheckService(makeStore({ profile: 'default', region: 'us-west-2' }));

      const result = await service.checkPermissions();

      expect(result).toEqual({ status: 'passed', origin: 'profile', blocking: false });
    });

    it('should resolve origin as pasted when the profile resolves to a manually pasted entry', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const store = makeStore({ profile: 'hyveon-pasted', region: 'us-west-2' }, {
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      });
      const service = new IamCheckService(store);

      const result = await service.checkPermissions();

      expect(result).toEqual({ status: 'passed', origin: 'pasted', blocking: false });
    });

    it('should resolve origin as guided when the profile is the guided-provisioned profile name', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const store = makeStore({ profile: GUIDED_PROFILE_NAME, region: 'us-west-2' }, {
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      });
      const service = new IamCheckService(store);

      const result = await service.checkPermissions();

      expect(result).toEqual({ status: 'passed', origin: 'guided', blocking: false });
    });

    it('should set blocking to true when status is missing and origin is guided', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({
        EvaluationResults: [{ EvalActionName: 's3:*', EvalDecision: 'explicitDeny' }],
      });
      const store = makeStore({ profile: GUIDED_PROFILE_NAME, region: 'us-west-2' }, {
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      });
      const service = new IamCheckService(store);

      const result = await service.checkPermissions();

      expect(result.status).toBe('missing');
      expect(result.origin).toBe('guided');
      expect(result.blocking).toBe(true);
    });

    it('should keep blocking false when status is missing but origin is pasted (a manually pasted key)', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({
        EvaluationResults: [{ EvalActionName: 's3:*', EvalDecision: 'explicitDeny' }],
      });
      const store = makeStore({ profile: 'hyveon-pasted', region: 'us-west-2' }, {
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      });
      const service = new IamCheckService(store);

      const result = await service.checkPermissions();

      expect(result.status).toBe('missing');
      expect(result.origin).toBe('pasted');
      expect(result.blocking).toBe(false);
    });

    it('should keep blocking false when status is missing but origin is profile', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({
        EvaluationResults: [{ EvalActionName: 's3:*', EvalDecision: 'explicitDeny' }],
      });
      const service = new IamCheckService(makeStore({ profile: 'default', region: 'us-west-2' }));

      const result = await service.checkPermissions();

      expect(result.status).toBe('missing');
      expect(result.origin).toBe('profile');
      expect(result.blocking).toBe(false);
    });

    it('should keep blocking false for a warning result even when origin is guided', async () => {
      stsMock.on(GetCallerIdentityCommand).rejects(new Error('access denied'));
      const store = makeStore({ profile: GUIDED_PROFILE_NAME, region: 'us-west-2' }, {
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      });
      const service = new IamCheckService(store);

      const result = await service.checkPermissions();

      expect(result.status).toBe('warning');
      expect(result.origin).toBe('guided');
      expect(result.blocking).toBe(false);
    });

    it('should keep blocking false for a warning result when origin is pasted (a manually pasted key)', async () => {
      stsMock.on(GetCallerIdentityCommand).rejects(new Error('access denied'));
      const store = makeStore({ profile: 'hyveon-pasted', region: 'us-west-2' }, {
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      });
      const service = new IamCheckService(store);

      const result = await service.checkPermissions();

      expect(result.status).toBe('warning');
      expect(result.origin).toBe('pasted');
      expect(result.blocking).toBe(false);
    });

    it('should keep blocking false for a warning result when origin is profile', async () => {
      stsMock.on(GetCallerIdentityCommand).rejects(new Error('access denied'));
      const service = new IamCheckService(makeStore({ profile: 'default', region: 'us-west-2' }));

      const result = await service.checkPermissions();

      expect(result.status).toBe('warning');
      expect(result.origin).toBe('profile');
      expect(result.blocking).toBe(false);
    });

    it('should keep blocking false when status is missing and origin is none (no credential source configured)', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({
        EvaluationResults: [{ EvalActionName: 's3:*', EvalDecision: 'explicitDeny' }],
      });
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      const result = await service.checkPermissions();

      expect(result.status).toBe('missing');
      expect(result.origin).toBe('none');
      expect(result.blocking).toBe(false);
    });
  });
});
