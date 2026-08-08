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

import { EcsService, createAwsCloudProvider, buildProviderConfig } from './EcsService.js';
import type { ConfigService } from './ConfigService.js';
import type { Ec2Service } from './Ec2Service.js';
import type { ElectronStoreService } from './ElectronStoreService.js';
import type { StackOutputs } from '@hyveon/shared';

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
 * A canonical set of stack outputs used by most tests. Individual tests
 * spread over this to tweak specific fields (e.g. clearing `domainName`).
 */
const DEFAULT_OUTPUTS: StackOutputs = {
  awsRegion: 'us-east-1',
  ecsClusterName: 'game-cluster',
  ecsClusterArn: 'arn:aws:ecs:us-east-1:123:cluster/game-cluster',
  subnetIds: ['subnet-a', 'subnet-b'],
  securityGroupId: 'sg-game',
  fileManagerSecurityGroupId: 'sg-files',
  efsFileSystemId: 'fs-1',
  efsAccessPoints: { minecraft: 'fsap-1' },
  domainName: 'example.com',
  gameNames: ['minecraft'],
  discordTableName: 'discord-table',
  auditTableName: 'audit-table',
  runsTableName: 'runs-table',
  discordBotTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:bot-token',
  discordPublicKeySecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:public-key',
  fileBrowserCredentialSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:filebrowser-credential',
  fileBrowserSchedulerRoleArn: 'arn:aws:iam::123:role/filebrowser-scheduler',
  interactionsInvokeUrl: null,
  discordInteractionsUrl: null,
  appliedGameServers: null,
};

/**
 * Build a minimal ConfigService stub with just the methods EcsService reads.
 * Pass `null` to simulate "nothing has been deployed yet".
 */
function makeConfig(outputs: StackOutputs | null = DEFAULT_OUTPUTS): ConfigService {
  const stub: Partial<ConfigService> = {
    getRegion: () => 'us-east-1',
    getStackOutputs: async () => outputs,
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

/**
 * Build a minimal `ElectronStoreService` stub reporting no wizard-configured
 * AWS profile — `resolveAwsClientCredentials` resolves this to `undefined`
 * credentials, letting the globally-patched `ecsMock`/`ec2Mock` clients
 * intercept calls regardless of what `credentials` the client was
 * constructed with.
 */
function makeStore(): ElectronStoreService {
  const stub: Partial<ElectronStoreService> = {
    get: vi.fn().mockReturnValue(undefined),
  };
  return stub as ElectronStoreService;
}

/**
 * Constructs an `EcsService` for tests, standing in for the constructor
 * default `EcsService` used before the `CLOUD_PROVIDER` token replaced it —
 * the service now requires its `CloudProvider` to be passed explicitly (as
 * Nest's DI does via the token in production), so tests wire a real
 * `AwsCloudProvider` built from the same `config` stub. Its internal AWS SDK
 * calls are still covered by the globally-patched `ecsMock` / `ec2Mock`
 * clients, so `getStatus` / `start` / `stop` behave exactly as before.
 */
function makeService(config: ConfigService, ec2: Ec2Service): EcsService {
  const store = makeStore();
  return new EcsService(config, ec2, createAwsCloudProvider(config, store), store);
}

describe('EcsService', () => {
  beforeEach(() => {
    ecsMock.reset();
    ec2Mock.reset();
  });

  describe('extractEniId', () => {
    it('should return the ENI id from an ElasticNetworkInterface attachment', () => {
      const service = makeService(makeConfig(), makeEc2());
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
      const service = makeService(makeConfig(), makeEc2());
      expect(service.extractEniId({ attachments: [] })).toBeNull();
      expect(service.extractEniId({})).toBeNull();
    });

    it('should ignore non-ENI attachment types', () => {
      const service = makeService(makeConfig(), makeEc2());
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
      const service = makeService(makeConfig(), makeEc2());
      expect(await service.findRunningTask('cluster', 'minecraft')).toBeNull();
    });

    it('should scope the list call to {game}-server family and RUNNING desired status', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      const service = makeService(makeConfig(), makeEc2());
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
      const service = makeService(makeConfig(), makeEc2());
      const task = await service.findRunningTask('c', 'g');
      expect(task?.taskArn).toBe('arn2');
    });

    it('should return null on API errors', async () => {
      ecsMock.on(ListTasksCommand).rejects(new Error('api-fail'));
      const service = makeService(makeConfig(), makeEc2());
      expect(await service.findRunningTask('c', 'g')).toBeNull();
    });
  });

  describe('getStatus', () => {
    it('should return not_deployed when stack outputs are missing', async () => {
      const service = makeService(makeConfig(null), makeEc2());
      const status = await service.getStatus('minecraft');
      expect(status.state).toBe('not_deployed');
      expect(status.message).toMatch(/run apply/i);
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
      const service = makeService(makeConfig(), makeEc2());
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
      const service = makeService(makeConfig(), makeEc2());
      const status = await service.getStatus('minecraft');
      expect(status.state).toBe('starting');
      expect(status.taskArn).toBe('arn1');
    });

    it('should return stopped when no running task is found', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      const service = makeService(makeConfig(), makeEc2());
      const status = await service.getStatus('minecraft');
      expect(status.state).toBe('stopped');
    });

    it('should omit hostname when no domain_name is configured', async () => {
      const outputs: StackOutputs = { ...DEFAULT_OUTPUTS, domainName: '' };
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'RUNNING', attachments: [] }],
      });
      const service = makeService(makeConfig(outputs), makeEc2(null));
      const status = await service.getStatus('minecraft');
      expect(status.state).toBe('running');
      expect(status.hostname).toBeUndefined();
    });
  });

  describe('start', () => {
    it('should return failure if stack outputs are missing', async () => {
      const service = makeService(makeConfig(null), makeEc2());
      const result = await service.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/run apply/i);
    });

    it('should refuse to start if a task is already running', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'RUNNING' }],
      });
      const service = makeService(makeConfig(), makeEc2());
      const result = await service.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/already running/i);
    });

    it('should launch a task with the correct cluster, family, subnets, and SG', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: 'arn-new' }] });

      const service = makeService(makeConfig(), makeEc2());
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
      const service = makeService(makeConfig(), makeEc2());
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
      const service = makeService(makeConfig(), makeEc2());
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
      const service = makeService(makeConfig(), makeEc2());
      const result = await service.start('minecraft');
      expect(result.success).toBe(false);
      expect(result.message).toContain('AccessDeniedException');
    });
  });

  describe('stop', () => {
    it('should return failure if stack outputs are missing', async () => {
      const service = makeService(makeConfig(null), makeEc2());
      const result = await service.stop('minecraft');
      expect(result.success).toBe(false);
    });

    it('should return failure when nothing is running', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      const service = makeService(makeConfig(), makeEc2());
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
      const service = makeService(makeConfig(), makeEc2());
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
      const service = makeService(makeConfig(), makeEc2());
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
      const service = makeService(makeConfig(), makeEc2());
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
      const service = makeService(makeConfig(), makeEc2());
      const td = await service.getTaskDefinition('minecraft');
      expect(td?.cpu).toBe(1024);
      expect(td?.memory).toBe(2048);
    });

    it('should return null when no taskDefinition is returned', async () => {
      ecsMock.on(DescribeTaskDefinitionCommand).resolves({});
      const service = makeService(makeConfig(), makeEc2());
      expect(await service.getTaskDefinition('minecraft')).toBeNull();
    });

    it('should return null on API error', async () => {
      ecsMock.on(DescribeTaskDefinitionCommand).rejects(new Error('bad'));
      const service = makeService(makeConfig(), makeEc2());
      expect(await service.getTaskDefinition('minecraft')).toBeNull();
    });
  });

  describe('registerTaskDefinition', () => {
    it('should return the ARN on success', async () => {
      ecsMock.on(RegisterTaskDefinitionCommand).resolves({
        taskDefinition: { taskDefinitionArn: 'arn:aws:ecs:::task-definition/foo:1' },
      });
      const service = makeService(makeConfig(), makeEc2());
      const arn = await service.registerTaskDefinition({ family: 'foo' });
      expect(arn).toBe('arn:aws:ecs:::task-definition/foo:1');
    });

    it('should return null on API error', async () => {
      ecsMock.on(RegisterTaskDefinitionCommand).rejects(new Error('nope'));
      const service = makeService(makeConfig(), makeEc2());
      expect(await service.registerTaskDefinition({ family: 'foo' })).toBeNull();
    });
  });

  describe('runTask', () => {
    it('should return taskArn when the launch succeeds', async () => {
      ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: 'arn-x' }] });
      const service = makeService(makeConfig(), makeEc2());
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
      const service = makeService(makeConfig(), makeEc2());
      expect(
        await service.runTask({ cluster: 'c', taskDefinition: 'td' }),
      ).toBeNull();
    });

    it('should return null on API error', async () => {
      ecsMock.on(RunTaskCommand).rejects(new Error('boom'));
      const service = makeService(makeConfig(), makeEc2());
      expect(await service.runTask({ cluster: 'c', taskDefinition: 'td' })).toBeNull();
    });
  });

  describe('listTasksByStartedBy', () => {
    it('should return empty when no task ARNs match', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      const service = makeService(makeConfig(), makeEc2());
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
      const service = makeService(makeConfig(), makeEc2());
      const tasks = await service.listTasksByStartedBy('cluster', 'key');
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.taskArn).toBe('a');
    });

    it('should return an empty array on error', async () => {
      ecsMock.on(ListTasksCommand).rejects(new Error('err'));
      const service = makeService(makeConfig(), makeEc2());
      expect(await service.listTasksByStartedBy('c', 'k')).toEqual([]);
    });
  });

  describe('stopTask', () => {
    it('should send StopTaskCommand with the provided args', async () => {
      ecsMock.on(StopTaskCommand).resolves({});
      const service = makeService(makeConfig(), makeEc2());
      await service.stopTask('cluster', 'arn', 'because');
      const input = ecsMock.commandCalls(StopTaskCommand)[0]!.args[0].input;
      expect(input.cluster).toBe('cluster');
      expect(input.task).toBe('arn');
      expect(input.reason).toBe('because');
    });
  });

  describe('credentials resolution', () => {
    it('should build the raw ECS client with the credentials resolveAwsClientCredentials(store) resolves', async () => {
      const store: Partial<ElectronStoreService> = {
        get: vi.fn().mockReturnValue({ profile: 'my-profile' }),
        getPastedCredentials: vi.fn().mockReturnValue({ accessKeyId: 'AKIA-test', secretAccessKey: 'secret-test' }),
      };
      const credentialedService = new EcsService(
        makeConfig(),
        makeEc2(),
        createAwsCloudProvider(makeConfig(), store as ElectronStoreService),
        store as ElectronStoreService,
      );

      let observedCredentials: unknown;
      ecsMock.on(StopTaskCommand).callsFake(async (_input, getClient) => {
        observedCredentials = await getClient().config.credentials();
        return {};
      });
      await credentialedService.stopTask('cluster', 'arn', 'because');

      expect(observedCredentials).toMatchObject({ accessKeyId: 'AKIA-test', secretAccessKey: 'secret-test' });
    });

    /**
     * Regression test for the stale-client-cache defect flagged in review of
     * #452: `getClient()` used to cache the `ECSClient` forever after first
     * construction (`if (!this.client)`), so a credentials rotation mid-session
     * (e.g. the operator replacing a pasted key via Settings) kept every
     * subsequent call signed with the original credentials until the app
     * restarted. `getClient()` now keys its cache on region + a credentials
     * signature so a rotation is picked up on the very next call.
     */
    it('should rebuild the raw ECS client when the stored credentials rotate between calls', async () => {
      const store: Partial<ElectronStoreService> = {
        get: vi.fn().mockReturnValue({ profile: 'hyveon-pasted' }),
        getPastedCredentials: vi
          .fn()
          .mockReturnValueOnce({ accessKeyId: 'AKIA-old', secretAccessKey: 'secret-old' })
          .mockReturnValueOnce({ accessKeyId: 'AKIA-new', secretAccessKey: 'secret-new' }),
      };
      const config = makeConfig();
      const service = new EcsService(
        config,
        makeEc2(),
        createAwsCloudProvider(config, store as ElectronStoreService),
        store as ElectronStoreService,
      );

      const observed: unknown[] = [];
      ecsMock.on(StopTaskCommand).callsFake(async (_input, getClient) => {
        observed.push(await getClient().config.credentials());
        return {};
      });

      await service.stopTask('cluster', 'arn-1', 'first call');
      await service.stopTask('cluster', 'arn-2', 'second call, after rotation');

      expect(observed[0]).toMatchObject({ accessKeyId: 'AKIA-old', secretAccessKey: 'secret-old' });
      expect(observed[1]).toMatchObject({ accessKeyId: 'AKIA-new', secretAccessKey: 'secret-new' });
    });
  });
});

describe('buildProviderConfig', () => {
  it('should return null before anything has been deployed', async () => {
    await expect(buildProviderConfig(makeConfig(null), makeStore())).resolves.toBeNull();
  });

  it('should prefer the deployed stack outputs awsRegion over ConfigService.getRegion() once deployed', async () => {
    const config = makeConfig({ ...DEFAULT_OUTPUTS, awsRegion: 'eu-central-1' });
    // getRegion() stays 'us-east-1' (the makeConfig stub default) — proving
    // the resolved config prefers the stack's own deployed region, not the
    // wizard-configured fallback, once a stack actually exists.
    await expect(buildProviderConfig(config, makeStore())).resolves.toMatchObject({ region: 'eu-central-1' });
  });
});
