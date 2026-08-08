import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  EC2Client,
  DescribeNetworkInterfacesCommand,
} from '@aws-sdk/client-ec2';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { Ec2Service } from './Ec2Service.js';
import type { ConfigService } from './ConfigService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';

/** Typed stand-in for the AWS EC2 SDK client. */
const ec2Mock = mockClient(EC2Client);

/**
 * Build a minimal ConfigService stub exposing only the members Ec2Service
 * actually reads at runtime.
 */
function makeConfig(): ConfigService {
  const stub: Partial<ConfigService> = { getRegion: () => 'us-east-1' };
  return stub as ConfigService;
}

/**
 * Build a minimal `ElectronStoreService` stub reporting no wizard-configured
 * AWS profile — `resolveAwsClientCredentials` resolves this to `undefined`
 * credentials, letting the globally-patched `ec2Mock` client intercept calls
 * regardless of what `credentials` the client was constructed with.
 */
function makeStore(): ElectronStoreService {
  const stub: Partial<ElectronStoreService> = { get: vi.fn().mockReturnValue(undefined) };
  return stub as ElectronStoreService;
}

describe('Ec2Service', () => {
  /** Service under test, freshly constructed per test. */
  let service: Ec2Service;

  beforeEach(() => {
    ec2Mock.reset();
    service = new Ec2Service(makeConfig(), makeStore());
  });

  describe('getPublicIp', () => {
    it('should return the public IP when attached', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
        NetworkInterfaces: [{ Association: { PublicIp: '54.1.2.3' } }],
      });
      expect(await service.getPublicIp('eni-abc')).toBe('54.1.2.3');
    });

    it('should return null when there is no association or public IP', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
        NetworkInterfaces: [{}],
      });
      expect(await service.getPublicIp('eni-abc')).toBeNull();
    });

    it('should return null when no interfaces are returned', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({ NetworkInterfaces: [] });
      expect(await service.getPublicIp('eni-abc')).toBeNull();
    });

    it('should return null on API error', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).rejects(new Error('boom'));
      expect(await service.getPublicIp('eni-abc')).toBeNull();
    });

    it('should pass the ENI id through to the SDK command', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({ NetworkInterfaces: [] });
      await service.getPublicIp('eni-123');
      const input = ec2Mock.commandCalls(DescribeNetworkInterfacesCommand)[0]!.args[0].input;
      expect(input.NetworkInterfaceIds).toEqual(['eni-123']);
    });
  });

  describe('getPrivateIp', () => {
    it('should return the private IP when present', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
        NetworkInterfaces: [{ PrivateIpAddress: '10.0.1.5' }],
      });
      expect(await service.getPrivateIp('eni-abc')).toBe('10.0.1.5');
    });

    it('should return null when the private IP is absent', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({ NetworkInterfaces: [{}] });
      expect(await service.getPrivateIp('eni-abc')).toBeNull();
    });

    it('should return null on API error', async () => {
      ec2Mock.on(DescribeNetworkInterfacesCommand).rejects(new Error('nope'));
      expect(await service.getPrivateIp('eni-abc')).toBeNull();
    });
  });

  describe('credentials resolution', () => {
    it('should build the EC2 client with the credentials resolveAwsClientCredentials(store) resolves', async () => {
      const store: Partial<ElectronStoreService> = {
        get: vi.fn().mockReturnValue({ profile: 'my-profile' }),
        getPastedCredentials: vi.fn().mockReturnValue({ accessKeyId: 'AKIA-test', secretAccessKey: 'secret-test' }),
      };
      const credentialedService = new Ec2Service(makeConfig(), store as ElectronStoreService);

      let observedCredentials: unknown;
      ec2Mock.on(DescribeNetworkInterfacesCommand).callsFake(async (_input, getClient) => {
        observedCredentials = await getClient().config.credentials();
        return { NetworkInterfaces: [] };
      });
      await credentialedService.getPublicIp('eni-abc');

      expect(observedCredentials).toMatchObject({ accessKeyId: 'AKIA-test', secretAccessKey: 'secret-test' });
    });
  });
});
