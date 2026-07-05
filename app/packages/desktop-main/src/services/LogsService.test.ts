import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  FilterLogEventsCommand,
  GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { LogsService } from './LogsService.js';
import { createAwsCloudProvider } from './EcsService.js';
import type { ConfigService, TfOutputs } from './ConfigService.js';

/** Typed stand-in for the AWS CloudWatch Logs SDK client. */
const cwMock = mockClient(CloudWatchLogsClient);

/**
 * A minimal set of Terraform outputs satisfying `AwsCloudProvider`'s
 * `getConfig` callback. `streamLogs` only reads `region` off the resolved
 * config, but `buildProviderConfig` (shared with `EcsService`) always maps
 * the full `TfOutputs` shape, so every field needs a value here.
 */
const TF_OUTPUTS: TfOutputs = {
  aws_region: 'us-east-1',
  ecs_cluster_name: 'game-cluster',
  ecs_cluster_arn: 'arn:aws:ecs:us-east-1:123:cluster/game-cluster',
  subnet_ids: 'subnet-a',
  security_group_id: 'sg-game',
  file_manager_security_group_id: 'sg-files',
  efs_file_system_id: 'fs-1',
  efs_access_points: {},
  domain_name: 'example.com',
  game_names: ['minecraft'],
  alb_dns_name: null,
  acm_certificate_arn: null,
  discord_table_name: 'discord-table',
  discord_bot_token_secret_arn: 'arn:aws:secretsmanager:us-east-1:123:secret:bot-token',
  discord_public_key_secret_arn: 'arn:aws:secretsmanager:us-east-1:123:secret:public-key',
  interactions_invoke_url: null,
  discord_interactions_url: null,
};

/**
 * Build a minimal ConfigService stub exposing only the members LogsService
 * (and, transitively, the `AwsCloudProvider` it delegates `streamLogs` to)
 * actually read at runtime.
 */
function makeConfig(): ConfigService {
  const stub: Partial<ConfigService> = {
    getRegion: () => 'us-east-1',
    getTfOutputs: () => TF_OUTPUTS,
  };
  return stub as ConfigService;
}

/**
 * Constructs a `LogsService` for tests, standing in for the constructor
 * default that used to build an `AwsCloudProvider` internally — the service
 * now requires its `CloudProvider` to be passed explicitly (as Nest's DI
 * does via the `CLOUD_PROVIDER` token in production), so tests wire a real
 * `AwsCloudProvider` built from the same `config` stub. Its internal AWS SDK
 * calls (`FilterLogEventsCommand` for `streamLogs`) are still covered by the
 * globally-patched `cwMock` client, so behaviour is unchanged.
 */
function makeService(config: ConfigService): LogsService {
  return new LogsService(config, createAwsCloudProvider(config));
}

describe('LogsService', () => {
  /** Service under test, freshly constructed per test. */
  let service: LogsService;

  beforeEach(() => {
    cwMock.reset();
    service = makeService(makeConfig());
  });

  it('should return a "no streams" message when the log group has no streams', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [] });
    const lines = await service.getRecentLogs('minecraft');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/no log streams/i);
  });

  it('should query the /ecs/{game}-server log group and fetch the newest stream', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({
      logStreams: [{ logStreamName: 'ecs/stream1' }],
    });
    cwMock.on(GetLogEventsCommand).resolves({
      events: [{ message: 'line1' }, { message: 'line2' }],
    });

    const lines = await service.getRecentLogs('minecraft', 25);
    expect(lines).toEqual(['line1', 'line2']);

    const descInput = cwMock.commandCalls(DescribeLogStreamsCommand)[0]!.args[0].input;
    expect(descInput.logGroupName).toBe('/ecs/minecraft-server');
    expect(descInput.orderBy).toBe('LastEventTime');
    expect(descInput.descending).toBe(true);
    expect(descInput.limit).toBe(1);

    const getInput = cwMock.commandCalls(GetLogEventsCommand)[0]!.args[0].input;
    expect(getInput.logGroupName).toBe('/ecs/minecraft-server');
    expect(getInput.logStreamName).toBe('ecs/stream1');
    expect(getInput.limit).toBe(25);
    expect(getInput.startFromHead).toBe(false);
  });

  it('should default the event limit to 50', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({
      logStreams: [{ logStreamName: 's' }],
    });
    cwMock.on(GetLogEventsCommand).resolves({ events: [] });
    await service.getRecentLogs('minecraft');
    const input = cwMock.commandCalls(GetLogEventsCommand)[0]!.args[0].input;
    expect(input.limit).toBe(50);
  });

  it('should return an empty array when events are undefined', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({
      logStreams: [{ logStreamName: 's' }],
    });
    cwMock.on(GetLogEventsCommand).resolves({});
    const lines = await service.getRecentLogs('minecraft');
    expect(lines).toEqual([]);
  });

  it('should map a missing event.message to an empty string', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({
      logStreams: [{ logStreamName: 's' }],
    });
    cwMock.on(GetLogEventsCommand).resolves({
      events: [{ message: 'a' }, {}],
    });
    const lines = await service.getRecentLogs('minecraft');
    expect(lines).toEqual(['a', '']);
  });

  it('should return an error message when the API throws', async () => {
    cwMock.on(DescribeLogStreamsCommand).rejects(new Error('denied'));
    const lines = await service.getRecentLogs('minecraft');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/error fetching logs for minecraft/i);
    expect(lines[0]).toContain('denied');
  });
});

describe('LogsService.streamLogs', () => {
  /** Service under test, freshly constructed per test. */
  let service: LogsService;

  beforeEach(() => {
    cwMock.reset();
    service = makeService(makeConfig());
  });

  it('should terminate immediately when signal is already aborted before the first poll', async () => {
    const ac = new AbortController();
    ac.abort();

    const lines: string[] = [];
    for await (const line of service.streamLogs('minecraft', ac.signal, 0)) {
      lines.push(line);
    }

    expect(lines).toEqual([]);
    expect(cwMock.commandCalls(FilterLogEventsCommand)).toHaveLength(0);
  });

  it('should yield log lines from the first poll and terminate on abort', async () => {
    cwMock.on(FilterLogEventsCommand).resolves({
      events: [
        { eventId: 'e1', timestamp: 1000, message: 'line1' },
        { eventId: 'e2', timestamp: 2000, message: 'line2' },
      ],
    });

    const ac = new AbortController();
    const gen = service.streamLogs('minecraft', ac.signal, 0);

    const { value: l1 } = await gen.next();
    const { value: l2 } = await gen.next();
    ac.abort();
    const { done } = await gen.next();

    expect(l1).toBe('line1');
    expect(l2).toBe('line2');
    expect(done).toBe(true);
  });

  it('should yield new events from successive polls', async () => {
    cwMock
      .on(FilterLogEventsCommand)
      .resolvesOnce({ events: [{ eventId: 'e1', timestamp: 1000, message: 'first' }] })
      .resolves({ events: [{ eventId: 'e2', timestamp: 2000, message: 'second' }] });

    const ac = new AbortController();
    const gen = service.streamLogs('minecraft', ac.signal, 0);

    const { value: l1 } = await gen.next();
    const { value: l2 } = await gen.next();
    ac.abort();
    await gen.return(undefined);

    expect(l1).toBe('first');
    expect(l2).toBe('second');
  });

  it('should de-duplicate events with the same eventId across polls', async () => {
    cwMock
      .on(FilterLogEventsCommand)
      .resolvesOnce({ events: [{ eventId: 'e1', timestamp: 1000, message: 'line1' }] })
      .resolvesOnce({
        events: [
          { eventId: 'e1', timestamp: 1000, message: 'line1' }, // already seen
          { eventId: 'e2', timestamp: 2000, message: 'line2' }, // new
        ],
      });

    const ac = new AbortController();
    const gen = service.streamLogs('minecraft', ac.signal, 0);

    const { value: l1 } = await gen.next(); // first poll yields 'line1'
    const { value: l2 } = await gen.next(); // second poll skips duplicate, yields 'line2'
    ac.abort();
    await gen.return(undefined);

    expect(l1).toBe('line1');
    expect(l2).toBe('line2');
  });

  it('should query the /ecs/{game}-server log group', async () => {
    cwMock.on(FilterLogEventsCommand).resolves({
      events: [{ eventId: 'e1', timestamp: 1000, message: 'hello' }],
    });

    const ac = new AbortController();
    const gen = service.streamLogs('valheim', ac.signal, 0);

    await gen.next(); // first poll runs and yields 'hello'
    ac.abort();
    await gen.return(undefined);

    const calls = cwMock.commandCalls(FilterLogEventsCommand);
    expect(calls[0]!.args[0].input.logGroupName).toBe('/ecs/valheim-server');
  });

  it('should yield a stream-error sentinel and continue when a poll throws', async () => {
    cwMock
      .on(FilterLogEventsCommand)
      .rejectsOnce(new Error('throttled'))
      .resolves({ events: [{ eventId: 'e1', timestamp: 1000, message: 'recovered' }] });

    const ac = new AbortController();
    const gen = service.streamLogs('minecraft', ac.signal, 0);

    const { value: errLine } = await gen.next(); // first poll throws
    const { value: okLine } = await gen.next(); // second poll succeeds
    ac.abort();
    await gen.return(undefined);

    expect(errLine).toMatch(/\[stream error\].*throttled/);
    expect(okLine).toBe('recovered');
  });

  it('should map a missing event.message to an empty string', async () => {
    cwMock.on(FilterLogEventsCommand).resolves({
      events: [{ eventId: 'e1', timestamp: 1000 }], // no message field
    });

    const ac = new AbortController();
    const gen = service.streamLogs('minecraft', ac.signal, 0);

    const { value: line } = await gen.next();
    ac.abort();
    await gen.return(undefined);

    expect(line).toBe('');
  });
});
