import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { EC2Client, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';
import { AwsCloudProvider, type AwsCloudProviderConfig } from './AwsCloudProvider.js';

/** Typed stand-in for the AWS ECS SDK client. */
const ecsMock = mockClient(ECSClient);
/** Typed stand-in for the AWS EC2 SDK client. */
const ec2Mock = mockClient(EC2Client);

/**
 * A canonical set of provider configuration used by most tests. Individual
 * tests spread over this to tweak specific fields (e.g. clearing `domainName`).
 */
const DEFAULT_CONFIG: AwsCloudProviderConfig = {
  region: 'us-east-1',
  ecsClusterName: 'game-cluster',
  subnetIds: 'subnet-a, subnet-b',
  securityGroupId: 'sg-game',
  domainName: 'example.com',
};

/**
 * Build an {@link AwsCloudProvider} whose `getConfig` callback resolves to the
 * given configuration. Pass `null` to simulate "terraform apply hasn't been
 * run yet".
 */
function makeProvider(config: AwsCloudProviderConfig | null = DEFAULT_CONFIG): AwsCloudProvider {
  return new AwsCloudProvider(() => config);
}

describe('AwsCloudProvider', () => {
  beforeEach(() => {
    ecsMock.reset();
    ec2Mock.reset();
  });

  describe('startWorkload', () => {
    it('should throw a "Terraform not applied" error when no config is available', async () => {
      const provider = makeProvider(null);
      await expect(provider.startWorkload('minecraft', {})).rejects.toThrow(
        "Terraform not applied. Run 'terraform apply' first.",
      );
    });

    it('should throw an "already running" error when a task is already running', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'RUNNING' }],
      });
      const provider = makeProvider();
      await expect(provider.startWorkload('minecraft', {})).rejects.toThrow(
        'minecraft is already running.',
      );
    });

    it('should launch a task with the correct cluster, family, trimmed subnets, and SG', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: 'arn-new' }] });

      const provider = makeProvider();
      const handle = await provider.startWorkload('minecraft', {});

      expect(handle).toEqual({ workloadId: 'arn-new' });
      const input = ecsMock.commandCalls(RunTaskCommand)[0]!.args[0].input;
      expect(input.cluster).toBe('game-cluster');
      expect(input.taskDefinition).toBe('minecraft-server');
      expect(input.count).toBe(1);
      expect(input.launchType).toBe('FARGATE');
      expect(input.networkConfiguration?.awsvpcConfiguration?.subnets).toEqual([
        'subnet-a',
        'subnet-b',
      ]);
      expect(input.networkConfiguration?.awsvpcConfiguration?.securityGroups).toEqual(['sg-game']);
      expect(input.networkConfiguration?.awsvpcConfiguration?.assignPublicIp).toBe('ENABLED');
    });

    it('should throw with the failure reason when RunTask reports failures', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      ecsMock.on(RunTaskCommand).resolves({
        tasks: [],
        failures: [{ reason: 'CAPACITY' }],
      });
      const provider = makeProvider();
      await expect(provider.startWorkload('minecraft', {})).rejects.toThrow(
        'Failed to start minecraft: CAPACITY',
      );
    });

    it('should throw with an "unknown" reason when RunTask returns no tasks and no failure reason', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      ecsMock.on(RunTaskCommand).resolves({ tasks: [], failures: [] });
      const provider = makeProvider();
      await expect(provider.startWorkload('minecraft', {})).rejects.toThrow(
        'Failed to start minecraft: unknown',
      );
    });

    it('should rethrow the original Error instance when RunTask throws', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      ecsMock.on(RunTaskCommand).rejects(new Error('throttled'));
      const provider = makeProvider();
      await expect(provider.startWorkload('minecraft', {})).rejects.toThrow('throttled');
    });

    it('should wrap a non-Error throw from RunTask in a new Error', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      ecsMock.on(RunTaskCommand).callsFake(() => {
        throw 'raw-string-failure';
      });
      const provider = makeProvider();
      await expect(provider.startWorkload('minecraft', {})).rejects.toThrow('raw-string-failure');
    });
  });

  describe('stopWorkload', () => {
    it('should throw a "Terraform not applied" error when no config is available', async () => {
      const provider = makeProvider(null);
      await expect(provider.stopWorkload('minecraft')).rejects.toThrow('Terraform not applied.');
    });

    it('should throw a "not currently running" error when no task is found', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      const provider = makeProvider();
      await expect(provider.stopWorkload('minecraft')).rejects.toThrow(
        'minecraft is not currently running.',
      );
    });

    it('should stop the running task with the correct cluster, task, and reason', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'RUNNING' }],
      });
      ecsMock.on(StopTaskCommand).resolves({});

      const provider = makeProvider();
      await provider.stopWorkload('minecraft');

      const input = ecsMock.commandCalls(StopTaskCommand)[0]!.args[0].input;
      expect(input.cluster).toBe('game-cluster');
      expect(input.task).toBe('arn1');
      expect(input.reason).toBe('Stopped via management app');
    });

    it('should rethrow the original Error instance when StopTask throws', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'RUNNING' }],
      });
      ecsMock.on(StopTaskCommand).rejects(new Error('stop-error'));
      const provider = makeProvider();
      await expect(provider.stopWorkload('minecraft')).rejects.toThrow('stop-error');
    });

    it('should wrap a non-Error throw from StopTask in a new Error', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'RUNNING' }],
      });
      ecsMock.on(StopTaskCommand).callsFake(() => {
        throw 'raw-stop-failure';
      });
      const provider = makeProvider();
      await expect(provider.stopWorkload('minecraft')).rejects.toThrow('raw-stop-failure');
    });
  });

  describe('getWorkloadStatus', () => {
    it('should return not_deployed when no config is available', async () => {
      const provider = makeProvider(null);
      await expect(provider.getWorkloadStatus('minecraft')).resolves.toEqual({
        state: 'not_deployed',
        message: 'Run terraform apply first.',
      });
    });

    it('should return running with resolved public IP and hostname for a RUNNING task', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [
          {
            taskArn: 'arn1',
            lastStatus: 'RUNNING',
            attachments: [
              {
                type: 'ElasticNetworkInterface',
                details: [{ name: 'networkInterfaceId', value: 'eni-xyz' }],
              },
            ],
          },
        ],
      });
      ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
        NetworkInterfaces: [{ Association: { PublicIp: '9.9.9.9' } }],
      });

      const provider = makeProvider();
      const status = await provider.getWorkloadStatus('minecraft');

      expect(status).toEqual({
        state: 'running',
        workloadId: 'arn1',
        publicIp: '9.9.9.9',
        hostname: 'minecraft.example.com',
      });
    });

    it('should omit publicIp when the running task has no ENI attachment', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'RUNNING', attachments: [] }],
      });

      const provider = makeProvider();
      const status = await provider.getWorkloadStatus('minecraft');

      expect(status.state).toBe('running');
      expect(status.publicIp).toBeUndefined();
      expect(ec2Mock.commandCalls(DescribeNetworkInterfacesCommand)).toHaveLength(0);
    });

    it('should omit hostname when no domainName is configured', async () => {
      const provider = makeProvider({ ...DEFAULT_CONFIG, domainName: undefined });
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'RUNNING', attachments: [] }],
      });

      const status = await provider.getWorkloadStatus('minecraft');

      expect(status.state).toBe('running');
      expect(status.hostname).toBeUndefined();
    });

    it('should return starting with the task ARN when the task is not yet RUNNING', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'PROVISIONING' }],
      });

      const provider = makeProvider();
      const status = await provider.getWorkloadStatus('minecraft');

      expect(status).toEqual({ state: 'starting', workloadId: 'arn1' });
    });

    it('should return stopped when no running task is found', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      const provider = makeProvider();
      const status = await provider.getWorkloadStatus('minecraft');
      expect(status).toEqual({ state: 'stopped' });
    });

    it('should return error with the stringified failure when an unexpected exception occurs', async () => {
      const provider = makeProvider();
      // `findRunningTask` swallows ECS/EC2 SDK errors internally (returning
      // `null` so callers fall back to the "stopped" branch), so the only way
      // to exercise `getWorkloadStatus`'s `error` branch is to force the
      // private helper itself to reject.
      vi.spyOn(provider as unknown as { findRunningTask: () => Promise<never> }, 'findRunningTask').mockRejectedValue(
        new Error('unexpected failure'),
      );

      const status = await provider.getWorkloadStatus('minecraft');

      expect(status).toEqual({ state: 'error', message: 'Error: unexpected failure' });
    });
  });
});
