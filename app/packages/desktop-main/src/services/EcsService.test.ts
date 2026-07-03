import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
  type Task,
} from '@aws-sdk/client-ecs';
import { EC2Client, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { EcsService } from './EcsService.js';
import type { ConfigService, TfOutputs } from './ConfigService.js';
import type { Ec2Service } from './Ec2Service.js';

/** Typed stand-in for the AWS ECS SDK client. */
const ecsMock = mockClient(ECSClient);

/**
 * Typed stand-in for the AWS EC2 SDK client. `getStatus` now delegates public
 * IP resolution to `AwsCloudProvider`, which instantiates its own internal
 * `EC2Client` — mocking the class here (rather than the removed `Ec2Service`
 * plumbing) covers that internal client too, since `mockClient` patches the
 * `EC2Client` prototype globally.
 */
const ec2Mock = mockClient(EC2Client);

/**
 * A canonical set of Terraform outputs used by most tests. Individual tests
 * spread over this to tweak specific fields (e.g. clearing `domain_name`).
 */
const DEFAULT_OUTPUTS: TfOutputs = {
  aws_region: 'us-east-1',
  ecs_cluster_name: 'game-cluster',
  ecs_cluster_arn: 'arn:aws:ecs:us-east-1:123:cluster/game-cluster',
  subnet_ids: 'subnet-a, subnet-b',
  security_group_id: 'sg-game',
  file_manager_security_group_id: 'sg-files',
  efs_file_system_id: 'fs-1',
  efs_access_points: { minecraft: 'fsap-1' },
  domain_name: 'example.com',
  game_names: ['minecraft'],
  alb_dns_name: null,
  acm_certificate_arn: null,
};

/**
 * Build a minimal ConfigService stub with just the methods EcsService reads.
 * Pass `null` to simulate "terraform apply hasn't been run yet".
 */
function makeConfig(outputs: TfOutputs | null = DEFAULT_OUTPUTS): ConfigService {
  const stub: Partial<ConfigService> = {
    getRegion: () => 'us-east-1',
    getTfOutputs: () => outputs,
  };
  return stub as ConfigService;
}

/**
 * Build an Ec2Service stub whose `getPublicIp` resolves to the given value.
 * Defaults to a non-null placeholder so tests don't have to pass it in.
 */
function makeEc2(ip: string | null = '1.2.3.4'): Ec2Service {
  const stub: Partial<Ec2Service> = {
    getPublicIp: vi.fn().mockResolvedValue(ip),
  };
  return stub as Ec2Service;
}

describe('EcsService', () => {
  beforeEach(() => {
    ecsMock.reset();
    ec2Mock.reset();
  });

  describe('extractEniId', () => {
    it('should return the ENI id from an ElasticNetworkInterface attachment', () => {
      const service = new EcsService(makeConfig(), makeEc2());
      const task: Task = {
        attachments: [
          {
            type: 'ElasticNetworkInterface',
            details: [
              { name: 'subnetId', value: 'subnet-a' },
              { name: 'networkInterfaceId', value: 'eni-abc' },
            ],
          },
        ],
      };
      expect(service.extractEniId(task)).toBe('eni-abc');
    });

    it('should return null when no ENI attachment is present', () => {
      const service = new EcsService(makeConfig(), makeEc2());
      expect(service.extractEniId({ attachments: [] })).toBeNull();
      expect(service.extractEniId({})).toBeNull();
    });

    it('should ignore non-ENI attachment types', () => {
      const service = new EcsService(makeConfig(), makeEc2());
      const task: Task = {
        attachments: [
          {
            type: 'SomethingElse',
            details: [{ name: 'networkInterfaceId', value: 'eni-wrong' }],
          },
        ],
      };
      expect(service.extractEniId(task)).toBeNull();
    });
  });

  describe('findRunningTask', () => {
    it('should return null when no tasks are listed', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      const service = new EcsService(makeConfig(), makeEc2());
      expect(await service.findRunningTask('cluster', 'minecraft')).toBeNull();
    });

    it('should scope the list call to {game}-server family and RUNNING desired status', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      const service = new EcsService(makeConfig(), makeEc2());
      await service.findRunningTask('my-cluster', 'factorio');
      const input = ecsMock.commandCalls(ListTasksCommand)[0]!.args[0].input;
      expect(input.family).toBe('factorio-server');
      expect(input.desiredStatus).toBe('RUNNING');
      expect(input.cluster).toBe('my-cluster');
    });

    it('should filter out STOPPED and DEPROVISIONING tasks', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1', 'arn2'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [
          { taskArn: 'arn1', lastStatus: 'STOPPED' },
          { taskArn: 'arn2', lastStatus: 'RUNNING' },
        ],
      });
      const service = new EcsService(makeConfig(), makeEc2());
      const task = await service.findRunningTask('c', 'g');
      expect(task?.taskArn).toBe('arn2');
    });

    it('should return null on API errors', async () => {
      ecsMock.on(ListTasksCommand).rejects(new Error('api-fail'));
      const service = new EcsService(makeConfig(), makeEc2());
      expect(await service.findRunningTask('c', 'g')).toBeNull();
    });
  });

  describe('getStatus', () => {
    it('should return not_deployed when terraform outputs are missing', async () => {
      const service = new EcsService(makeConfig(null), makeEc2());
      const status = await service.getStatus('minecraft');
      expect(status.state).toBe('not_deployed');
      expect(status.message).toMatch(/terraform apply/i);
    });

    it('should return running with public IP and hostname for a RUNNING task', async () => {
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
      const service = new EcsService(makeConfig(), makeEc2());
      const status = await service.getStatus('minecraft');
      expect(status.state).toBe('running');
      expect(status.publicIp).toBe('9.9.9.9');
      expect(status.hostname).toBe('minecraft.example.com');
      expect(ec2Mock.commandCalls(DescribeNetworkInterfacesCommand)[0]!.args[0].input.NetworkInterfaceIds).toEqual([
        'eni-xyz',
      ]);
    });

    it('should return starting when the task is not yet RUNNING', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'PROVISIONING' }],
      });
      const service = new EcsService(makeConfig(), makeEc2());
      const status = await service.getStatus('minecraft');
      expect(status.state).toBe('starting');
      expect(status.taskArn).toBe('arn1');
    });

    it('should return stopped when no running task is found', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      const service = new EcsService(makeConfig(), makeEc2());
      const status = await service.getStatus('minecraft');
      expect(status.state).toBe('stopped');
    });

    it('should omit hostname when no domain_name is configured', async () => {
      const outputs: TfOutputs = { ...DEFAULT_OUTPUTS, domain_name: '' };
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'RUNNING', attachments: [] }],
      });
      const service = new EcsService(makeConfig(outputs), makeEc2(null));
      const status = await service.getStatus('minecraft');
      expect(status.state).toBe('running');
      expect(status.hostname).toBeUndefined();
    });
  });

  describe('start', () => {
    it('should return failure if terraform outputs are missing', async () => {
      const service = new EcsService(makeConfig(null), makeEc2());
      const result = await service.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/terraform apply/i);
    });

    it('should refuse to start if a task is already running', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'RUNNING' }],
      });
      const service = new EcsService(makeConfig(), makeEc2());
      const result = await service.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/already running/i);
    });

    it('should launch a task with the correct cluster, family, subnets, and SG', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: 'arn-new' }] });

      const service = new EcsService(makeConfig(), makeEc2());
      const result = await service.start('minecraft');

      expect(result.success).toBe(true);
      expect(result.taskArn).toBe('arn-new');
      const input = ecsMock.commandCalls(RunTaskCommand)[0]!.args[0].input;
      expect(input.cluster).toBe('game-cluster');
      expect(input.taskDefinition).toBe('minecraft-server');
      expect(input.launchType).toBe('FARGATE');
      expect(input.networkConfiguration?.awsvpcConfiguration?.subnets).toEqual(['subnet-a', 'subnet-b']);
      expect(input.networkConfiguration?.awsvpcConfiguration?.securityGroups).toEqual(['sg-game']);
      expect(input.networkConfiguration?.awsvpcConfiguration?.assignPublicIp).toBe('ENABLED');
    });

    it('should return failure with reason when RunTask reports failures', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      ecsMock.on(RunTaskCommand).resolves({
        tasks: [],
        failures: [{ reason: 'CAPACITY' }],
      });
      const service = new EcsService(makeConfig(), makeEc2());
      const result = await service.start('minecraft');
      expect(result.success).toBe(false);
      // Exact match (not toContain): this is a WorkloadLaunchError, whose
      // message must surface unprefixed — the same string EcsService.start
      // returned directly before delegating to AwsCloudProvider. A loose
      // toContain('CAPACITY') would still pass on the regressed
      // 'Error: Failed to start minecraft: CAPACITY' shape.
      expect(result.message).toBe('Failed to start minecraft: CAPACITY');
    });

    it('should return failure when RunTask throws', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      ecsMock.on(RunTaskCommand).rejects(new Error('throttled'));
      const service = new EcsService(makeConfig(), makeEc2());
      const result = await service.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toContain('throttled');
    });

    it('should surface AWS SDK exception name in the failure message', async () => {
      // Mirrors the shape thrown by the real AWS SDK — `name` is set to the
      // exception code (e.g. 'AccessDeniedException') so that `String(err)`
      // yields "<name>: <message>", which is what the catch block returns.
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      const awsError = Object.assign(new Error('User is not authorized to perform ecs:RunTask'), {
        name: 'AccessDeniedException',
      });
      ecsMock.on(RunTaskCommand).rejects(awsError);
      const service = new EcsService(makeConfig(), makeEc2());
      const result = await service.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toContain('AccessDeniedException');
    });
  });

  describe('stop', () => {
    it('should return failure if terraform outputs are missing', async () => {
      const service = new EcsService(makeConfig(null), makeEc2());
      const result = await service.stop('minecraft');
      expect(result.success).toBe(false);
    });

    it('should return failure when nothing is running', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      const service = new EcsService(makeConfig(), makeEc2());
      const result = await service.stop('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not currently running/i);
    });

    it('should stop the task when one is found', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'RUNNING' }],
      });
      ecsMock.on(StopTaskCommand).resolves({});
      const service = new EcsService(makeConfig(), makeEc2());
      const result = await service.stop('minecraft');
      expect(result.success).toBe(true);
      const input = ecsMock.commandCalls(StopTaskCommand)[0]!.args[0].input;
      expect(input.task).toBe('arn1');
      expect(input.cluster).toBe('game-cluster');
    });

    it('should return failure when StopTask throws', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'RUNNING' }],
      });
      ecsMock.on(StopTaskCommand).rejects(new Error('stop-error'));
      const service = new EcsService(makeConfig(), makeEc2());
      const result = await service.stop('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toContain('stop-error');
    });
  });

  describe('getTaskDefinition', () => {
    it('should parse cpu, memory, and executionRoleArn from the task definition', async () => {
      ecsMock.on(DescribeTaskDefinitionCommand).resolves({
        taskDefinition: {
          cpu: '512',
          memory: '1024',
          executionRoleArn: 'arn:aws:iam::123:role/exec',
        },
      });
      const service = new EcsService(makeConfig(), makeEc2());
      const td = await service.getTaskDefinition('minecraft');
      expect(td).toEqual({
        cpu: 512,
        memory: 1024,
        executionRoleArn: 'arn:aws:iam::123:role/exec',
      });
    });

    it('should apply default cpu and memory when fields are absent', async () => {
      ecsMock.on(DescribeTaskDefinitionCommand).resolves({
        taskDefinition: { executionRoleArn: 'arn:...' },
      });
      const service = new EcsService(makeConfig(), makeEc2());
      const td = await service.getTaskDefinition('minecraft');
      expect(td?.cpu).toBe(1024);
      expect(td?.memory).toBe(2048);
    });

    it('should return null when no taskDefinition is returned', async () => {
      ecsMock.on(DescribeTaskDefinitionCommand).resolves({});
      const service = new EcsService(makeConfig(), makeEc2());
      expect(await service.getTaskDefinition('minecraft')).toBeNull();
    });

    it('should return null on API error', async () => {
      ecsMock.on(DescribeTaskDefinitionCommand).rejects(new Error('bad'));
      const service = new EcsService(makeConfig(), makeEc2());
      expect(await service.getTaskDefinition('minecraft')).toBeNull();
    });
  });

  describe('registerTaskDefinition', () => {
    it('should return the ARN on success', async () => {
      ecsMock.on(RegisterTaskDefinitionCommand).resolves({
        taskDefinition: { taskDefinitionArn: 'arn:aws:ecs:::task-definition/foo:1' },
      });
      const service = new EcsService(makeConfig(), makeEc2());
      const arn = await service.registerTaskDefinition({ family: 'foo' });
      expect(arn).toBe('arn:aws:ecs:::task-definition/foo:1');
    });

    it('should return null on API error', async () => {
      ecsMock.on(RegisterTaskDefinitionCommand).rejects(new Error('nope'));
      const service = new EcsService(makeConfig(), makeEc2());
      expect(await service.registerTaskDefinition({ family: 'foo' })).toBeNull();
    });
  });

  describe('runTask', () => {
    it('should return taskArn when the launch succeeds', async () => {
      ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: 'arn-x' }] });
      const service = new EcsService(makeConfig(), makeEc2());
      const result = await service.runTask({
        cluster: 'c',
        taskDefinition: 'td',
        launchType: 'FARGATE',
      });
      expect(result).toEqual({ taskArn: 'arn-x' });
    });

    it('should return null when RunTask reports failures', async () => {
      ecsMock.on(RunTaskCommand).resolves({
        tasks: [],
        failures: [{ reason: 'CAPACITY' }],
      });
      const service = new EcsService(makeConfig(), makeEc2());
      expect(
        await service.runTask({ cluster: 'c', taskDefinition: 'td' }),
      ).toBeNull();
    });

    it('should return null on API error', async () => {
      ecsMock.on(RunTaskCommand).rejects(new Error('boom'));
      const service = new EcsService(makeConfig(), makeEc2());
      expect(await service.runTask({ cluster: 'c', taskDefinition: 'td' })).toBeNull();
    });
  });

  describe('listTasksByStartedBy', () => {
    it('should return empty when no task ARNs match', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      const service = new EcsService(makeConfig(), makeEc2());
      expect(await service.listTasksByStartedBy('c', 'filemgr-minecraft')).toEqual([]);
    });

    it('should filter out STOPPED and DEPROVISIONING tasks', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['a', 'b', 'c'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [
          { taskArn: 'a', lastStatus: 'RUNNING' },
          { taskArn: 'b', lastStatus: 'STOPPED' },
          { taskArn: 'c', lastStatus: 'DEPROVISIONING' },
        ],
      });
      const service = new EcsService(makeConfig(), makeEc2());
      const tasks = await service.listTasksByStartedBy('cluster', 'key');
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.taskArn).toBe('a');
    });

    it('should return an empty array on error', async () => {
      ecsMock.on(ListTasksCommand).rejects(new Error('err'));
      const service = new EcsService(makeConfig(), makeEc2());
      expect(await service.listTasksByStartedBy('c', 'k')).toEqual([]);
    });
  });

  describe('stopTask', () => {
    it('should send StopTaskCommand with the provided args', async () => {
      ecsMock.on(StopTaskCommand).resolves({});
      const service = new EcsService(makeConfig(), makeEc2());
      await service.stopTask('cluster', 'arn', 'because');
      const input = ecsMock.commandCalls(StopTaskCommand)[0]!.args[0].input;
      expect(input.cluster).toBe('cluster');
      expect(input.task).toBe('arn');
      expect(input.reason).toBe('because');
    });
  });
});
