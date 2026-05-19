/** Options for launching a game workload. Intentionally open/opaque for v1; implementations may accept provider-specific keys or refine this via intersection. */
export interface StartOpts {
  [key: string]: unknown;
}

/** Opaque handle returned by startWorkload — uniquely identifies the launched workload within the provider. */
export interface WorkloadHandle {
  workloadId: string;
}

/** Cloud-agnostic status of a game workload. */
export interface WorkloadStatus {
  state: 'running' | 'starting' | 'stopped' | 'not_deployed' | 'error';
  /** Provider-assigned workload identifier (replaces cloud-specific IDs such as task ARNs). */
  workloadId?: string;
  publicIp?: string;
  hostname?: string;
  message?: string;
}

/** A single timestamped log entry streamed from a running workload. */
export interface LogChunk {
  message: string;
  timestamp: Date;
}

/**
 * Cloud-agnostic cost snapshot. Shared return type for both forward-looking
 * estimates (getCostEstimate) and billed actuals (getActualCosts).
 */
export interface CostBreakdown {
  /** Total cost across all items in the breakdown. */
  total: number;
  currency: string;
  /** Per-game or per-service cost keyed by name. */
  breakdown: Record<string, number>;
}

/** Closed date interval used by getActualCosts to scope the billing query. */
export interface DateRange {
  start: Date;
  end: Date;
}

/**
 * Cloud-provider abstraction. No `@aws-sdk/*` shapes appear in this interface
 * or its parameter/return types. Concrete implementations live in provider
 * packages (e.g. `@hyveon/cloud-aws`).
 */
export interface CloudProvider {
  startWorkload(game: string, opts: StartOpts): Promise<WorkloadHandle>;
  stopWorkload(game: string): Promise<void>;
  getWorkloadStatus(game: string): Promise<WorkloadStatus>;
  streamWorkloadLogs(game: string, signal: AbortSignal): AsyncIterable<LogChunk>;
  getCostEstimate(): Promise<CostBreakdown>;
  getActualCosts(range: DateRange): Promise<CostBreakdown>;
}
