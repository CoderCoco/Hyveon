import type {
  CloudProvider,
  CostBreakdown,
  DateRange,
  LogChunk,
  StartOpts,
  WorkloadHandle,
  WorkloadStatus,
} from '@hyveon/shared';

/**
 * AWS implementation of the cloud-agnostic {@link CloudProvider} contract.
 *
 * This is currently a stub — every method throws until the AWS SDK-backed
 * logic (ECS, CloudWatch Logs, Cost Explorer) lands in follow-up tasks
 * (#170, #172, #174, #176). The class exists so the shape of the provider is
 * fixed early and downstream wiring (DI, module registration) can be built
 * against a real type.
 */
export class AwsCloudProvider implements CloudProvider {
  /**
   * Launches a game workload on AWS.
   *
   * @param _game - The game identifier to start.
   * @param _opts - Provider-specific launch options.
   * @returns Never resolves — stub throws until implemented.
   */
  startWorkload(_game: string, _opts: StartOpts): Promise<WorkloadHandle> {
    throw new Error('Not implemented: startWorkload — see Epic #137');
  }

  /**
   * Stops a running game workload on AWS.
   *
   * @param _game - The game identifier to stop.
   * @returns Never resolves — stub throws until implemented.
   */
  stopWorkload(_game: string): Promise<void> {
    throw new Error('Not implemented: stopWorkload — see Epic #137');
  }

  /**
   * Retrieves the current status of a game workload on AWS.
   *
   * @param _game - The game identifier to query.
   * @returns Never resolves — stub throws until implemented.
   */
  getWorkloadStatus(_game: string): Promise<WorkloadStatus> {
    throw new Error('Not implemented: getWorkloadStatus — see Epic #137');
  }

  /**
   * Streams log chunks for a running game workload on AWS.
   *
   * @param _game - The game identifier to stream logs for.
   * @param _signal - Aborts the stream when triggered.
   * @returns Never yields — stub throws until implemented.
   */
  streamWorkloadLogs(_game: string, _signal: AbortSignal): AsyncIterable<LogChunk> {
    throw new Error('Not implemented: streamWorkloadLogs — see Epic #137');
  }

  /**
   * Retrieves a forward-looking cost estimate across all workloads.
   *
   * @returns Never resolves — stub throws until implemented.
   */
  getCostEstimate(): Promise<CostBreakdown> {
    throw new Error('Not implemented: getCostEstimate — see Epic #137');
  }

  /**
   * Retrieves billed actual costs over a given date range.
   *
   * @param _range - The date range to scope the billing query.
   * @returns Never resolves — stub throws until implemented.
   */
  getActualCosts(_range: DateRange): Promise<CostBreakdown> {
    throw new Error('Not implemented: getActualCosts — see Epic #137');
  }
}
