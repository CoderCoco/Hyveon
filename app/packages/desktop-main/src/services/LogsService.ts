import { Inject, Injectable } from '@nestjs/common';
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { CloudProvider, LogChunk } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { CLOUD_PROVIDER } from '../modules/cloud-provider.tokens.js';

/**
 * Local widening of the cloud-agnostic `CloudProvider` contract's
 * `streamWorkloadLogs` signature to accept the optional `pollInterval`
 * parameter that concrete implementations (e.g. `@hyveon/cloud-aws`'s
 * `AwsCloudProvider`) support, without changing the shared interface itself
 * (which stays intentionally cloud-agnostic and free of polling-cadence
 * concerns other providers may not expose).
 */
type CloudProviderWithPollInterval = CloudProvider & {
  streamWorkloadLogs(
    game: string,
    signal: AbortSignal,
    pollInterval?: number,
  ): AsyncIterable<LogChunk>;
};

/**
 * Fetches recent CloudWatch Logs lines for a game's ECS task so the UI can
 * render a tail. Assumes the Terraform-provisioned log group naming
 * convention `/ecs/{game}-server`.
 */
@Injectable()
export class LogsService {
  private client: CloudWatchLogsClient | null = null;

  constructor(
    private readonly config: ConfigService,
    // Shares the same `CloudProvider` instance bound by `CloudProviderModule`
    // (via the `CLOUD_PROVIDER` token) so `streamLogs` delegates to
    // `CloudProvider.streamWorkloadLogs` instead of duplicating its polling
    // logic. Depending only on the cloud-agnostic `CloudProvider` interface
    // (rather than the concrete `AwsCloudProvider` class) keeps this service
    // swappable to another cloud without a call-site change.
    @Inject(CLOUD_PROVIDER)
    private readonly provider: CloudProviderWithPollInterval,
  ) {}

  private getClient(): CloudWatchLogsClient {
    if (!this.client) {
      this.client = new CloudWatchLogsClient({ region: this.config.getRegion() });
    }
    return this.client;
  }

  /**
   * Async generator that yields new log lines as they arrive for `game`.
   * Delegates to the injected `CloudProvider`'s `streamWorkloadLogs` (bound
   * by `CloudProviderModule` via the `CLOUD_PROVIDER` token), which polls
   * `FilterLogEvents` every `pollInterval` ms (de-duplicated by `eventId`,
   * exiting cleanly when `signal` is aborted) — see
   * `AwsCloudProvider.streamWorkloadLogs`'s TSDoc for the full behaviour this
   * preserves for the AWS implementation. Only the `message` of each yielded
   * `LogChunk` is surfaced here, matching this method's pre-existing
   * `AsyncGenerator<string>` contract.
   */
  async *streamLogs(
    game: string,
    signal: AbortSignal,
    pollInterval = 2000,
  ): AsyncGenerator<string> {
    for await (const chunk of this.provider.streamWorkloadLogs(game, signal, pollInterval)) {
      yield chunk.message;
    }
  }

  /**
   * Return up to `limit` recent messages from the most recently written log
   * stream in `/ecs/{game}-server`. Errors are folded into a single-element
   * array so the caller always renders *something* — failures in the logs
   * tab shouldn't take the rest of the dashboard down.
   */
  async getRecentLogs(game: string, limit = 50): Promise<string[]> {
    const logGroup = `/ecs/${game}-server`;
    try {
      const streams = await this.getClient().send(
        new DescribeLogStreamsCommand({
          logGroupName: logGroup,
          orderBy: 'LastEventTime',
          descending: true,
          limit: 1,
        }),
      );
      if (!streams.logStreams?.length) {
        return [`No log streams found for ${game}.`];
      }
      const streamName = streams.logStreams[0]!.logStreamName!;
      const events = await this.getClient().send(
        new GetLogEventsCommand({
          logGroupName: logGroup,
          logStreamName: streamName,
          limit,
          startFromHead: false,
        }),
      );
      return events.events?.map((e) => e.message ?? '') ?? [];
    } catch (err) {
      logger.error('Failed to fetch logs', { err, game, logGroup });
      return [`Error fetching logs for ${game}: ${String(err)}`];
    }
  }
}
