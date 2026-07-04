import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { EC2Client, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import type { DateRange } from '@hyveon/shared';
import {
  AwsCloudProvider,
  WorkloadGuardError,
  WorkloadLaunchError,
  type AwsCloudProviderConfig,
} from './AwsCloudProvider.js';

/** Typed stand-in for the AWS ECS SDK client. */
const ecsMock = mockClient(ECSClient);
/** Typed stand-in for the AWS EC2 SDK client. */
const ec2Mock = mockClient(EC2Client);
/** Typed stand-in for the AWS CloudWatch Logs SDK client. */
const logsMock = mockClient(CloudWatchLogsClient);
/** Typed stand-in for the AWS Cost Explorer SDK client. */
const costExplorerMock = mockClient(CostExplorerClient);

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
    logsMock.reset();
    costExplorerMock.reset();
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
      // Must be a WorkloadLaunchError (not a plain Error) so callers like
      // EcsService's describeError() surface `message` unprefixed instead of
      // falling through to String(err), which would render the wrong
      // 'Error: Failed to start minecraft: CAPACITY' shape.
      await expect(provider.startWorkload('minecraft', {})).rejects.toThrow(WorkloadLaunchError);
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

    it('should rethrow a non-Error throw from RunTask unchanged', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      // `Promise.reject(...)` (rather than a synchronous `throw`) is used
      // here because `aws-sdk-client-mock`'s `callsFake` wrapper normalizes
      // any *synchronously thrown* non-Error value into an `Error` before it
      // ever reaches our code (see `CommandBehavior.normalizeError`) — that
      // would mask the exact bug this test guards against. Returning a
      // rejected promise bypasses that normalization so the raw string
      // reaches `AwsCloudProvider`'s catch block unchanged, same as a
      // genuine non-Error rejection from the underlying SDK would.
      ecsMock.on(RunTaskCommand).callsFake(() => Promise.reject('raw-string-failure'));
      const provider = makeProvider();
      // Asserts the exact raw value survives (not wrapped in an `Error`), so
      // `EcsService`'s `describeError` `String(err)` fallback still renders
      // the unprefixed string instead of `'Error: raw-string-failure'`.
      await expect(provider.startWorkload('minecraft', {})).rejects.toBe('raw-string-failure');
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

    it('should rethrow a non-Error throw from StopTask unchanged', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn1'] });
      ecsMock.on(DescribeTasksCommand).resolves({
        tasks: [{ taskArn: 'arn1', lastStatus: 'RUNNING' }],
      });
      // See the matching comment in the `startWorkload` non-Error-throw test
      // for why `Promise.reject(...)` is used instead of a synchronous `throw`.
      ecsMock.on(StopTaskCommand).callsFake(() => Promise.reject('raw-stop-failure'));
      const provider = makeProvider();
      // Asserts the exact raw value survives (not wrapped in an `Error`), so
      // `EcsService`'s `describeError` `String(err)` fallback still renders
      // the unprefixed string instead of `'Error: raw-stop-failure'`.
      await expect(provider.stopWorkload('minecraft')).rejects.toBe('raw-stop-failure');
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
      type ProviderWithPrivates = { findRunningTask: () => Promise<never> };
      vi.spyOn(provider as ProviderWithPrivates, 'findRunningTask').mockRejectedValue(new Error('unexpected failure'));

      const status = await provider.getWorkloadStatus('minecraft');

      expect(status).toEqual({ state: 'error', message: 'Error: unexpected failure' });
    });
  });

  describe('streamWorkloadLogs', () => {
    it('should throw a WorkloadGuardError when no config is available', async () => {
      const provider = makeProvider(null);
      const ac = new AbortController();
      await expect(
        (async () => {
          for await (const _chunk of provider.streamWorkloadLogs('minecraft', ac.signal, 0)) {
            // no config means the generator should throw before yielding anything
          }
        })(),
      ).rejects.toThrow(WorkloadGuardError);
    });

    it('should terminate immediately when signal is already aborted before the first poll', async () => {
      const ac = new AbortController();
      ac.abort();

      const provider = makeProvider();
      const chunks: unknown[] = [];
      for await (const chunk of provider.streamWorkloadLogs('minecraft', ac.signal, 0)) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([]);
      expect(logsMock.commandCalls(FilterLogEventsCommand)).toHaveLength(0);
    });

    it('should yield log chunks from the first poll and terminate on abort', async () => {
      logsMock.on(FilterLogEventsCommand).resolves({
        events: [
          { eventId: 'e1', timestamp: 1000, message: 'line1' },
          { eventId: 'e2', timestamp: 2000, message: 'line2' },
        ],
      });

      const provider = makeProvider();
      const ac = new AbortController();
      const gen = provider.streamWorkloadLogs('minecraft', ac.signal, 0);

      const { value: c1 } = await gen.next();
      const { value: c2 } = await gen.next();
      ac.abort();
      const { done } = await gen.next();

      expect(c1).toEqual({ message: 'line1', timestamp: new Date(1000) });
      expect(c2).toEqual({ message: 'line2', timestamp: new Date(2000) });
      expect(done).toBe(true);
    });

    it('should yield new events from successive polls', async () => {
      logsMock
        .on(FilterLogEventsCommand)
        .resolvesOnce({ events: [{ eventId: 'e1', timestamp: 1000, message: 'first' }] })
        .resolves({ events: [{ eventId: 'e2', timestamp: 2000, message: 'second' }] });

      const provider = makeProvider();
      const ac = new AbortController();
      const gen = provider.streamWorkloadLogs('minecraft', ac.signal, 0);

      const { value: c1 } = await gen.next();
      const { value: c2 } = await gen.next();
      ac.abort();
      await gen.return(undefined);

      expect(c1).toEqual({ message: 'first', timestamp: new Date(1000) });
      expect(c2).toEqual({ message: 'second', timestamp: new Date(2000) });
    });

    it('should de-duplicate events with the same eventId across polls', async () => {
      logsMock
        .on(FilterLogEventsCommand)
        .resolvesOnce({ events: [{ eventId: 'e1', timestamp: 1000, message: 'line1' }] })
        .resolvesOnce({
          events: [
            { eventId: 'e1', timestamp: 1000, message: 'line1' }, // already seen
            { eventId: 'e2', timestamp: 2000, message: 'line2' }, // new
          ],
        });

      const provider = makeProvider();
      const ac = new AbortController();
      const gen = provider.streamWorkloadLogs('minecraft', ac.signal, 0);

      const { value: c1 } = await gen.next(); // first poll yields 'line1'
      const { value: c2 } = await gen.next(); // second poll skips duplicate, yields 'line2'
      ac.abort();
      await gen.return(undefined);

      expect(c1).toEqual({ message: 'line1', timestamp: new Date(1000) });
      expect(c2).toEqual({ message: 'line2', timestamp: new Date(2000) });
    });

    it('should query the /ecs/{game}-server log group', async () => {
      logsMock.on(FilterLogEventsCommand).resolves({
        events: [{ eventId: 'e1', timestamp: 1000, message: 'hello' }],
      });

      const provider = makeProvider();
      const ac = new AbortController();
      const gen = provider.streamWorkloadLogs('valheim', ac.signal, 0);

      await gen.next(); // first poll runs and yields 'hello'
      ac.abort();
      await gen.return(undefined);

      const calls = logsMock.commandCalls(FilterLogEventsCommand);
      expect(calls[0]!.args[0].input.logGroupName).toBe('/ecs/valheim-server');
    });

    it('should yield a stream-error sentinel and continue when a poll throws', async () => {
      logsMock
        .on(FilterLogEventsCommand)
        .rejectsOnce(new Error('throttled'))
        .resolves({ events: [{ eventId: 'e1', timestamp: 1000, message: 'recovered' }] });

      const provider = makeProvider();
      const ac = new AbortController();
      const gen = provider.streamWorkloadLogs('minecraft', ac.signal, 0);

      const { value: errChunk } = (await gen.next()) as { value: { message: string } };
      const { value: okChunk } = await gen.next();
      ac.abort();
      await gen.return(undefined);

      expect(errChunk.message).toMatch(/\[stream error\].*throttled/);
      expect(okChunk).toEqual({ message: 'recovered', timestamp: new Date(1000) });
    });

    it('should map a missing event.message to an empty string', async () => {
      logsMock.on(FilterLogEventsCommand).resolves({
        events: [{ eventId: 'e1', timestamp: 1000 }], // no message field
      });

      const provider = makeProvider();
      const ac = new AbortController();
      const gen = provider.streamWorkloadLogs('minecraft', ac.signal, 0);

      const { value: chunk } = await gen.next();
      ac.abort();
      await gen.return(undefined);

      expect(chunk).toEqual({ message: '', timestamp: new Date(1000) });
    });

    it('should default the poll cadence to 2000ms when pollInterval is not specified', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        // Second poll must return a *new* eventId — a duplicate would be
        // deduped without yielding, so the generator would keep polling
        // (and sleeping) indefinitely instead of settling `nextPromise`
        // right after the second poll's sleep completes.
        logsMock
          .on(FilterLogEventsCommand)
          .resolvesOnce({ events: [{ eventId: 'e1', timestamp: 1000, message: 'line1' }] })
          .resolves({ events: [{ eventId: 'e2', timestamp: 2000, message: 'line2' }] });

        const provider = makeProvider();
        const ac = new AbortController();
        const gen = provider.streamWorkloadLogs('minecraft', ac.signal); // default pollInterval

        await gen.next(); // consumes the first poll's single yielded chunk

        let secondPollSettled = false;
        const nextPromise = gen.next().then((result) => {
          secondPollSettled = true;
          return result;
        });

        await vi.advanceTimersByTimeAsync(1999);
        expect(secondPollSettled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await nextPromise;
        expect(secondPollSettled).toBe(true);

        ac.abort();
        await gen.return(undefined);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('getCostEstimate', () => {
    it('should return a zeroed breakdown when no config is available', async () => {
      const provider = makeProvider(null);
      await expect(provider.getCostEstimate()).resolves.toEqual({
        total: 0,
        currency: 'USD',
        breakdown: {},
      });
    });

    it('should return a zeroed breakdown when config.gameNames is missing', async () => {
      const provider = makeProvider({ ...DEFAULT_CONFIG, gameNames: undefined });
      await expect(provider.getCostEstimate()).resolves.toEqual({
        total: 0,
        currency: 'USD',
        breakdown: {},
      });
    });

    it('should return a zeroed breakdown when config.gameNames is empty', async () => {
      const provider = makeProvider({ ...DEFAULT_CONFIG, gameNames: [] });
      await expect(provider.getCostEstimate()).resolves.toEqual({
        total: 0,
        currency: 'USD',
        breakdown: {},
      });
    });

    it('should key the breakdown by game name using each game\'s task definition CPU/memory', async () => {
      ecsMock
        .on(DescribeTaskDefinitionCommand, { taskDefinition: 'minecraft-server' })
        .resolves({ taskDefinition: { cpu: '1024', memory: '2048' } });
      ecsMock
        .on(DescribeTaskDefinitionCommand, { taskDefinition: 'valheim-server' })
        .resolves({ taskDefinition: { cpu: '2048', memory: '4096' } });

      const provider = makeProvider({ ...DEFAULT_CONFIG, gameNames: ['minecraft', 'valheim'] });
      const result = await provider.getCostEstimate();

      // minecraft: 1 vcpu * 0.04048 + 2 GiB * 0.004445 = 0.04937 -> rounds to 0.0494
      expect(result.breakdown['minecraft']).toBeCloseTo(0.0494, 4);
      // valheim: 2 vcpu * 0.04048 + 4 GiB * 0.004445 = 0.09874 -> rounds to 0.0987
      expect(result.breakdown['valheim']).toBeCloseTo(0.0987, 4);
      expect(result.currency).toBe('USD');
      expect(result.total).toBeCloseTo(0.1481, 4);
    });

    it('should fall back to 2048 cpu / 8192 memory when DescribeTaskDefinition fails', async () => {
      ecsMock.on(DescribeTaskDefinitionCommand).rejects(new Error('task definition not found'));

      const provider = makeProvider({ ...DEFAULT_CONFIG, gameNames: ['minecraft'] });
      const result = await provider.getCostEstimate();

      // fallback 2 vcpu * 0.04048 + 8 GiB * 0.004445 = 0.11652 -> rounds to 0.1165
      expect(result.breakdown['minecraft']).toBeCloseTo(0.1165, 4);
      expect(result.total).toBeCloseTo(0.1165, 4);
    });

    it('should fall back to 2048 cpu / 8192 memory when DescribeTaskDefinition resolves with no cpu/memory', async () => {
      ecsMock.on(DescribeTaskDefinitionCommand).resolves({ taskDefinition: {} });

      const provider = makeProvider({ ...DEFAULT_CONFIG, gameNames: ['minecraft'] });
      const result = await provider.getCostEstimate();

      // fallback 2 vcpu * 0.04048 + 8 GiB * 0.004445 = 0.11652 -> rounds to 0.1165
      expect(result.breakdown['minecraft']).toBeCloseTo(0.1165, 4);
      expect(result.total).toBeCloseTo(0.1165, 4);
    });

    it('should log the swallowed error via the injected logger when DescribeTaskDefinition fails', async () => {
      const describeError = new Error('task definition not found');
      ecsMock.on(DescribeTaskDefinitionCommand).rejects(describeError);
      const logger = { error: vi.fn() };

      const provider = new AwsCloudProvider(
        () => ({ ...DEFAULT_CONFIG, gameNames: ['minecraft'] }),
        logger,
      );
      await provider.getCostEstimate();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('minecraft'),
        describeError,
      );
    });

    it('should round the total to at most 4 decimal places', async () => {
      ecsMock
        .on(DescribeTaskDefinitionCommand)
        .resolves({ taskDefinition: { cpu: '256', memory: '512' } });

      const provider = makeProvider({
        ...DEFAULT_CONFIG,
        gameNames: ['minecraft', 'valheim', 'terraria'],
      });
      const result = await provider.getCostEstimate();

      const decimals = result.total.toString().split('.')[1] ?? '';
      expect(decimals.length).toBeLessThanOrEqual(4);
    });
  });

  describe('getActualCosts', () => {
    /** A representative two-day range used across most `getActualCosts` specs. */
    const range: DateRange = {
      start: new Date('2026-04-10T12:00:00Z'),
      end: new Date('2026-04-12T00:00:00Z'),
    };

    it('should query Cost Explorer pinned to us-east-1 regardless of config.region', async () => {
      let observedRegion: string | undefined;
      costExplorerMock.on(GetCostAndUsageCommand).callsFake(async (_input, getClient) => {
        observedRegion = await getClient().config.region();
        return { ResultsByTime: [] };
      });

      const provider = makeProvider({ ...DEFAULT_CONFIG, region: 'eu-west-1' });
      await provider.getActualCosts(range);

      expect(observedRegion).toBe('us-east-1');
    });

    it('should format the query TimePeriod as ISO dates and filter to ECS/Fargate', async () => {
      costExplorerMock.on(GetCostAndUsageCommand).resolves({ ResultsByTime: [] });

      const provider = makeProvider();
      await provider.getActualCosts(range);

      const input = costExplorerMock.commandCalls(GetCostAndUsageCommand)[0]!.args[0].input;
      expect(input.TimePeriod).toEqual({ Start: '2026-04-10', End: '2026-04-12' });
      expect(input.Granularity).toBe('DAILY');
      expect(input.Filter?.Dimensions?.Key).toBe('SERVICE');
      expect(input.Filter?.Dimensions?.Values).toEqual([
        'Amazon Elastic Container Service',
        'AWS Fargate',
      ]);
      expect(input.Metrics).toEqual(['UnblendedCost']);
    });

    it('should key the breakdown by each result\'s ISO start date', async () => {
      costExplorerMock.on(GetCostAndUsageCommand).resolves({
        ResultsByTime: [
          {
            TimePeriod: { Start: '2026-04-10', End: '2026-04-11' },
            Total: { UnblendedCost: { Amount: '1.23456' } },
          },
          {
            TimePeriod: { Start: '2026-04-11', End: '2026-04-12' },
            Total: { UnblendedCost: { Amount: '2.5' } },
          },
        ],
      });

      const provider = makeProvider();
      const result = await provider.getActualCosts(range);

      expect(result.breakdown).toEqual({ '2026-04-10': 1.2346, '2026-04-11': 2.5 });
      expect(result.currency).toBe('USD');
    });

    it('should round each day\'s cost to 4 decimals and the total to 2 decimals', async () => {
      costExplorerMock.on(GetCostAndUsageCommand).resolves({
        ResultsByTime: [
          { TimePeriod: { Start: '2026-04-10' }, Total: { UnblendedCost: { Amount: '1.23456' } } },
          { TimePeriod: { Start: '2026-04-11' }, Total: { UnblendedCost: { Amount: '2.50001' } } },
        ],
      });

      const provider = makeProvider();
      const result = await provider.getActualCosts(range);

      expect(result.breakdown['2026-04-10']).toBe(1.2346);
      expect(result.breakdown['2026-04-11']).toBe(2.5);
      // 1.23456 + 2.50001 = 3.73457 -> rounds to 3.73
      expect(result.total).toBe(3.73);
    });

    it('should default a missing UnblendedCost amount to zero', async () => {
      costExplorerMock.on(GetCostAndUsageCommand).resolves({
        ResultsByTime: [{ TimePeriod: { Start: '2026-04-10' }, Total: {} }],
      });

      const provider = makeProvider();
      const result = await provider.getActualCosts(range);

      expect(result.breakdown).toEqual({ '2026-04-10': 0 });
      expect(result.total).toBe(0);
    });

    it('should propagate the original Error instance when Cost Explorer throws', async () => {
      costExplorerMock.on(GetCostAndUsageCommand).rejects(new Error('AccessDeniedException'));

      const provider = makeProvider();
      await expect(provider.getActualCosts(range)).rejects.toThrow('AccessDeniedException');
    });

    it('should propagate a non-Error throw from Cost Explorer unchanged', async () => {
      // See the matching comment in the `startWorkload` non-Error-throw test
      // for why `Promise.reject(...)` is used instead of a synchronous `throw`.
      costExplorerMock
        .on(GetCostAndUsageCommand)
        .callsFake(() => Promise.reject('raw-cost-failure'));

      const provider = makeProvider();
      await expect(provider.getActualCosts(range)).rejects.toBe('raw-cost-failure');
    });
  });
});
