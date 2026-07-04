import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  type Task,
} from '@aws-sdk/client-ecs';
import { EC2Client, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
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
 * Fargate on-demand price per vCPU-hour (us-east-1). Exported so
 * `CostService.estimateForSpec` (`app/packages/desktop-main/src/services/CostService.ts`)
 * imports this single copy instead of hardcoding its own — keep both call
 * sites in sync by only ever editing the value here.
 */
export const FARGATE_VCPU_PER_HOUR = 0.04048;
/** Fargate on-demand price per GB-hour (us-east-1), see {@link FARGATE_VCPU_PER_HOUR}. */
export const FARGATE_GB_PER_HOUR = 0.004445;

/**
 * Sleep for `ms` milliseconds, but reject immediately if `signal` is aborted.
 * Mirrors `LogsService`'s `sleepInterruptible` helper so `streamWorkloadLogs`'s
 * poll loop exits promptly when the caller aborts, rather than waiting out a
 * full cadence after the last poll.
 */
function sleepInterruptible(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort);
  });
}

/**
 * Thrown by {@link AwsCloudProvider.startWorkload} / {@link
 * AwsCloudProvider.stopWorkload} for expected precondition refusals — a task
 * is already running, nothing is running to stop, or Terraform hasn't been
 * applied yet — as opposed to a genuine AWS/SDK failure. Callers (e.g.
 * `EcsService`) can `instanceof`-check for this type to route these refusals
 * to `warn`-level logging instead of `error`, without relying on message
 * string matching that would silently break if the message wording changes.
 */
export class WorkloadGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkloadGuardError';
  }
}

/**
 * Thrown by {@link AwsCloudProvider.startWorkload} when ECS's `RunTask`
 * response comes back with zero launched tasks and an explicit failure
 * reason (e.g. `CAPACITY`, `RESOURCE:FARGATE`) — a genuine AWS-side launch
 * failure, as opposed to a precondition refusal ({@link WorkloadGuardError}).
 * Kept as a distinct, separately-`instanceof`-checkable type instead of
 * reusing `WorkloadGuardError` so callers (e.g. `EcsService`) can still
 * surface `err.message` unprefixed — matching the exact string the previous,
 * pre-`AwsCloudProvider` `EcsService.start` returned in its `StartResult.message`
 * field — while continuing to log this at `error` level (not `warn`), since
 * this is not an expected/normal operator situation the way a guard refusal
 * is.
 */
export class WorkloadLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkloadLaunchError';
  }
}

/**
 * Narrow, Terraform-outputs-shaped subset of configuration
 * {@link AwsCloudProvider} needs to drive ECS + EC2 for the workload methods.
 * Kept local to this package (not imported from desktop-main's
 * `ConfigService`) so `@hyveon/cloud-aws` has zero dependency on the desktop
 * app — callers are responsible for resolving these fields from wherever
 * they live (`terraform.tfstate` today) and handing them to
 * {@link AwsCloudProvider} via its constructor.
 */
export interface AwsCloudProviderConfig {
  /** AWS region the ECS/EC2 clients should target. */
  region: string;
  /** Name of the ECS cluster game-server tasks run in. */
  ecsClusterName: string;
  /** Comma-separated subnet IDs used for the Fargate network configuration. */
  subnetIds: string;
  /** Security group ID attached to game-server tasks. */
  securityGroupId: string;
  /** Root domain used to build a game's public hostname (`{game}.{domain}`). */
  domainName?: string;
  /**
   * Names of the games to include in {@link AwsCloudProvider.getCostEstimate}'s
   * per-game breakdown (mirrors `terraform.tfstate`'s `game_names` output).
   * Optional so the class remains constructible without it; `getCostEstimate`
   * returns a zeroed {@link CostBreakdown} when it's missing or empty.
   */
  gameNames?: string[];
}

/**
 * Minimal logging seam {@link AwsCloudProvider} accepts so swallowed
 * ListTasks/DescribeTasks/DescribeNetworkInterfaces failures remain
 * diagnosable without pulling `@hyveon/desktop-main`'s Winston logger (or any
 * other logging dependency) into this package. Callers wire in whatever
 * logger they already have (e.g. by adapting Winston's `.error`, as
 * `EcsService.ts`'s `awsCloudProviderLogger` and `AwsModule`'s `useFactory`
 * provider both do) — the previous `EcsService.findRunningTask` /
 * `Ec2Service.getPublicIp` this class replaces both called `logger.error` on
 * these same failures, so omitting this seam would be a regression, not a
 * return to prior behaviour; it exists precisely so callers preserve that
 * logging instead of losing it.
 */
export interface AwsCloudProviderLogger {
  /**
   * Logs a caught error at error level.
   *
   * @param message - Human-readable description of what failed.
   * @param err - The caught error/value.
   */
  error(message: string, err: unknown): void;
}

/**
 * AWS implementation of the cloud-agnostic {@link CloudProvider} contract.
 *
 * `startWorkload` / `stopWorkload` / `getWorkloadStatus` reproduce the
 * behaviour of the management app's `EcsService` (task-definition lookup via
 * the `{game}-server` family, ENI-based public IP resolution via EC2, and
 * per-game "already running" / "not running" gating) without depending on
 * `@hyveon/desktop-main` — configuration is supplied via the constructor's
 * `getConfig` callback instead of `ConfigService`.
 *
 * `streamWorkloadLogs` reproduces `LogsService.streamLogs`'s CloudWatch Logs
 * polling behaviour (see the method for details). `getCostEstimate` and
 * `getActualCosts` reproduce the previous `CostService`'s Fargate-pricing
 * estimate and Cost Explorer billed-actuals lookup respectively.
 */
export class AwsCloudProvider implements CloudProvider {
  private ecsClient: ECSClient | null = null;
  private ecsClientRegion: string | null = null;
  private ec2Client: EC2Client | null = null;
  private ec2ClientRegion: string | null = null;
  private logsClient: CloudWatchLogsClient | null = null;
  private logsClientRegion: string | null = null;
  private costExplorerClient: CostExplorerClient | null = null;

  /**
   * Per-game tail of the in-flight critical-section chain, used by {@link
   * withGameLock} to serialize `startWorkload`/`stopWorkload` calls for the
   * same game. Without this, two overlapping requests for the same game
   * could both pass the "already running" / "not currently running" guard
   * check before either call's `RunTask`/`StopTask` lands, letting duplicate
   * tasks start or a stop race a start.
   */
  private readonly gameLocks = new Map<string, Promise<unknown>>();

  /**
   * @param getConfig - Resolves the current Terraform-derived configuration
   *   on every call. Returns `null`/`undefined` before `terraform apply` has
   *   run — mirrors `ConfigService.getTfOutputs()` returning `null`. Optional
   *   so the class remains constructible with no arguments while the
   *   cost/logs methods are still stubs.
   * @param logger - Optional sink for errors swallowed by `findRunningTask`
   *   and `getPublicIp` so operators can diagnose ECS/EC2 SDK failures
   *   instead of them silently masquerading as "stopped" / "no IP".
   */
  constructor(
    private readonly getConfig?: () => AwsCloudProviderConfig | null | undefined,
    private readonly logger?: AwsCloudProviderLogger,
  ) {}

  /**
   * Lazily constructs the ECS client, recreating it whenever `region` differs
   * from the region the cached client was built with — otherwise a stale
   * client (e.g. left over from a Terraform re-apply that changed regions)
   * would keep targeting the old region indefinitely.
   */
  private getEcsClient(region: string): ECSClient {
    if (!this.ecsClient || this.ecsClientRegion !== region) {
      this.ecsClient = new ECSClient({ region });
      this.ecsClientRegion = region;
    }
    return this.ecsClient;
  }

  /**
   * Lazily constructs the EC2 client, recreating it whenever `region` differs
   * from the region the cached client was built with — see {@link
   * getEcsClient} for why this matters.
   */
  private getEc2Client(region: string): EC2Client {
    if (!this.ec2Client || this.ec2ClientRegion !== region) {
      this.ec2Client = new EC2Client({ region });
      this.ec2ClientRegion = region;
    }
    return this.ec2Client;
  }

  /**
   * Lazily constructs the CloudWatch Logs client, recreating it whenever
   * `region` differs from the region the cached client was built with — see
   * {@link getEcsClient} for why this matters.
   */
  private getLogsClient(region: string): CloudWatchLogsClient {
    if (!this.logsClient || this.logsClientRegion !== region) {
      this.logsClient = new CloudWatchLogsClient({ region });
      this.logsClientRegion = region;
    }
    return this.logsClient;
  }

  /**
   * Lazily constructs the Cost Explorer client, always pinned to `us-east-1`
   * regardless of `config.region` — Cost Explorer is only available in that
   * region, matching the previous `CostService.getClient`'s hardcoded region.
   */
  private getCostExplorerClient(): CostExplorerClient {
    if (!this.costExplorerClient) {
      this.costExplorerClient = new CostExplorerClient({ region: 'us-east-1' });
    }
    return this.costExplorerClient;
  }

  /**
   * Resolve a game's Fargate CPU/memory spec from its `{game}-server` task
   * definition. Falls back to `2048` cpu / `8192` MiB (mirroring the previous
   * `CostsController.estimate`'s fallback) when the task definition can't be
   * resolved, so a single undeployed/misconfigured game doesn't blow up the
   * whole cost estimate.
   */
  private async getTaskDefinitionSpec(
    region: string,
    game: string,
  ): Promise<{ cpu: number; memory: number }> {
    try {
      const resp = await this.getEcsClient(region).send(
        new DescribeTaskDefinitionCommand({ taskDefinition: `${game}-server` }),
      );
      const td = resp.taskDefinition;
      return {
        cpu: parseInt(td?.cpu ?? '2048', 10),
        memory: parseInt(td?.memory ?? '8192', 10),
      };
    } catch (err) {
      this.logger?.error(`Failed to describe task definition for game=${game}`, err);
      return { cpu: 2048, memory: 8192 };
    }
  }

  /**
   * Convert a Fargate task's raw `cpu` (1024 = 1 vCPU) and `memory` (MiB) into
   * a projected hourly dollar cost, using the same exported pricing constants
   * and rounding that `CostService.estimateForSpec` uses for its
   * `costPerHour` field.
   */
  private estimateHourlyCost(cpuUnits: number, memoryMib: number): number {
    const vcpu = cpuUnits / 1024;
    const memGb = memoryMib / 1024;
    const hourly = vcpu * FARGATE_VCPU_PER_HOUR + memGb * FARGATE_GB_PER_HOUR;
    return Math.round(hourly * 10000) / 10000;
  }

  /**
   * Serializes calls for the same `game` so overlapping `startWorkload`/
   * `stopWorkload` requests can't both pass their guard check before either
   * one's AWS call lands. Chains `fn` onto the previous in-flight promise
   * for `game` (if any), so calls for the same game run one at a time in
   * call order, while calls for *different* games remain fully concurrent.
   * A rejected/thrown `fn` still unblocks the next queued call for that
   * game — only the caller that triggered it observes the rejection.
   */
  private async withGameLock<T>(game: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.gameLocks.get(game) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.gameLocks.set(
      game,
      run.catch(() => undefined),
    );
    return run;
  }

  /**
   * Dig the ENI ID out of a task's `attachments` array. Needed because the
   * public IP isn't on the task itself — it has to be looked up via EC2
   * using this ENI. Returns `null` if the task has no ENI attachment yet
   * (common while a task is still provisioning).
   */
  private extractEniId(task: Task): string | null {
    for (const att of task.attachments ?? []) {
      if (att.type !== 'ElasticNetworkInterface') continue;
      for (const detail of att.details ?? []) {
        if (detail.name === 'networkInterfaceId') return detail.value ?? null;
      }
    }
    return null;
  }

  /**
   * Locate the current non-stopped task for a game, keyed by the `{game}-server`
   * task-definition family Terraform provisions. `ListTasks` is filtered to
   * `desiredStatus: RUNNING` and STOPPED/DEPROVISIONING tasks are filtered
   * out of the describe result — leaving the single active task, if any.
   */
  private async findRunningTask(region: string, cluster: string, game: string): Promise<Task | null> {
    try {
      const client = this.getEcsClient(region);
      const listResp = await client.send(
        new ListTasksCommand({ cluster, family: `${game}-server`, desiredStatus: 'RUNNING' }),
      );
      if (!listResp.taskArns?.length) return null;

      const descResp = await client.send(
        new DescribeTasksCommand({ cluster, tasks: listResp.taskArns }),
      );
      return (
        descResp.tasks?.find(
          (t) => t.lastStatus !== 'STOPPED' && t.lastStatus !== 'DEPROVISIONING',
        ) ?? null
      );
    } catch (err) {
      this.logger?.error('Failed to find running task', err);
      return null;
    }
  }

  /**
   * Resolve the public IPv4 of a task's ENI. Returns `null` when the ENI has
   * no public association (e.g. `assignPublicIp: DISABLED`) or the describe
   * call fails — callers then show "starting" / "no IP" instead of an error.
   */
  private async getPublicIp(region: string, eniId: string): Promise<string | null> {
    try {
      const resp = await this.getEc2Client(region).send(
        new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] }),
      );
      return resp.NetworkInterfaces?.[0]?.Association?.PublicIp ?? null;
    } catch (err) {
      this.logger?.error('Failed to resolve public IP', err);
      return null;
    }
  }

  /**
   * Launches a game workload on AWS.
   *
   * Refuses to start a second task when one is already running (ECS would
   * happily run duplicates otherwise) and throws with the same message
   * strings `EcsService.start` used to return in its `StartResult.message`
   * field. The DNS record is created asynchronously by the update-dns
   * Lambda when the task reaches RUNNING.
   *
   * @param game - The game identifier to start.
   * @param _opts - Provider-specific launch options (currently unused).
   * @returns A handle whose `workloadId` is the launched task's ARN.
   */
  async startWorkload(game: string, _opts: StartOpts): Promise<WorkloadHandle> {
    const config = this.getConfig?.() ?? null;
    if (!config) throw new WorkloadGuardError("Terraform not applied. Run 'terraform apply' first.");

    const { region, ecsClusterName: cluster, subnetIds, securityGroupId: sg } = config;
    const subnets = subnetIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    return this.withGameLock(game, async () => {
      const existing = await this.findRunningTask(region, cluster, game);
      if (existing) throw new WorkloadGuardError(`${game} is already running.`);

      // Deliberately no try/catch here: RunTask failures (including non-`Error`
      // throws from the SDK) propagate to the caller unchanged, so
      // `EcsService`'s `describeError`'s `String(err)` fallback renders
      // identically to the pre-migration `EcsService.start` (a raw string
      // throw must surface unprefixed, not wrapped as `'Error: <string>'`).
      const resp = await this.getEcsClient(region).send(
        new RunTaskCommand({
          cluster,
          taskDefinition: `${game}-server`,
          count: 1,
          launchType: 'FARGATE',
          networkConfiguration: {
            awsvpcConfiguration: { subnets, securityGroups: [sg], assignPublicIp: 'ENABLED' },
          },
        }),
      );
      if (resp.tasks?.length) {
        const taskArn = resp.tasks[0]!.taskArn!;
        return { workloadId: taskArn };
      }
      const reason = resp.failures?.[0]?.reason ?? 'unknown';
      throw new WorkloadLaunchError(`Failed to start ${game}: ${reason}`);
    });
  }

  /**
   * Stops a running game workload on AWS.
   *
   * Throws with the same message strings `EcsService.stop` used to return in
   * its `StartResult.message` field. The STOPPED state-change event fires
   * the update-dns Lambda which deletes the Route 53 record — no DNS
   * cleanup needed here.
   *
   * @param game - The game identifier to stop.
   */
  async stopWorkload(game: string): Promise<void> {
    const config = this.getConfig?.() ?? null;
    if (!config) throw new WorkloadGuardError('Terraform not applied.');

    const cluster = config.ecsClusterName;

    await this.withGameLock(game, async () => {
      const task = await this.findRunningTask(config.region, cluster, game);
      if (!task) throw new WorkloadGuardError(`${game} is not currently running.`);

      // Deliberately no try/catch here — see the matching comment in
      // `startWorkload`: StopTask failures propagate unchanged.
      await this.getEcsClient(config.region).send(
        new StopTaskCommand({ cluster, task: task.taskArn, reason: 'Stopped via management app' }),
      );
    });
  }

  /**
   * Retrieves the current status of a game workload on AWS.
   *
   * Mirrors `EcsService.getStatus`'s state transitions exactly: `not_deployed`
   * when Terraform hasn't been applied, `running` with resolved IP/hostname
   * once the task's ENI is up, `starting` while the task is still
   * provisioning, `stopped` when no task is found, and `error` on failure.
   *
   * @param game - The game identifier to query.
   */
  async getWorkloadStatus(game: string): Promise<WorkloadStatus> {
    const config = this.getConfig?.() ?? null;
    if (!config) return { state: 'not_deployed', message: 'Run terraform apply first.' };

    const { region, ecsClusterName: cluster, domainName: domain } = config;

    try {
      const task = await this.findRunningTask(region, cluster, game);
      if (task) {
        if (task.lastStatus === 'RUNNING') {
          const eniId = this.extractEniId(task);
          const publicIp = eniId ? await this.getPublicIp(region, eniId) : null;
          return {
            state: 'running',
            workloadId: task.taskArn,
            publicIp: publicIp ?? undefined,
            hostname: domain ? `${game}.${domain}` : undefined,
          };
        }
        return { state: 'starting', workloadId: task.taskArn };
      }
      return { state: 'stopped' };
    } catch (err) {
      return { state: 'error', message: String(err) };
    }
  }

  /**
   * Streams log chunks for a running game workload on AWS.
   *
   * Reproduces `LogsService.streamLogs`'s polling behaviour: polls
   * `FilterLogEvents` against the Terraform-provisioned `/ecs/{game}-server`
   * log group every `pollInterval` ms (default 2000, matching the SSE
   * client's expected cadence), de-duplicates by `eventId` (falling back to
   * `{timestamp}-{message}` when a CloudWatch event has no `eventId`) so
   * overlapping `startTime` windows never yield the same line twice, and
   * exits cleanly once `signal` is aborted. A poll failure yields a single
   * `[stream error] ...` sentinel chunk instead of terminating the generator,
   * so a transient CloudWatch/SDK hiccup doesn't kill the whole stream —
   * matching `LogsService.streamLogs`'s resiliency.
   *
   * @param game - The game identifier to stream logs for.
   * @param signal - Aborts the stream when triggered.
   * @param pollInterval - Milliseconds between polls. Defaults to 2000.
   */
  async *streamWorkloadLogs(
    game: string,
    signal: AbortSignal,
    pollInterval = 2000,
  ): AsyncGenerator<LogChunk> {
    const config = this.getConfig?.() ?? null;
    if (!config) throw new WorkloadGuardError("Terraform not applied. Run 'terraform apply' first.");

    const { region } = config;
    const logGroup = `/ecs/${game}-server`;
    let startTime = Date.now();
    const seen = new Set<string>();

    while (!signal.aborted) {
      try {
        const resp = await this.getLogsClient(region).send(
          new FilterLogEventsCommand({ logGroupName: logGroup, startTime, limit: 100 }),
          { abortSignal: signal },
        );
        for (const e of resp.events ?? []) {
          const id = e.eventId ?? `${e.timestamp}-${e.message}`;
          if (!seen.has(id)) {
            seen.add(id);
            yield { message: e.message ?? '', timestamp: new Date(e.timestamp ?? Date.now()) };
          }
          if ((e.timestamp ?? 0) >= startTime) {
            startTime = (e.timestamp ?? startTime) + 1;
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') break;
        this.logger?.error(`Log stream poll error for game=${game} logGroup=${logGroup}`, err);
        yield { message: `[stream error] ${String(err)}`, timestamp: new Date() };
      }

      try {
        await sleepInterruptible(pollInterval, signal);
      } catch {
        break;
      }
    }
  }

  /**
   * Retrieves a forward-looking cost estimate across all workloads.
   *
   * Estimates each configured game's hourly Fargate cost from its
   * `{game}-server` task definition's CPU/memory (via {@link
   * getTaskDefinitionSpec} / {@link estimateHourlyCost}, reproducing the
   * previous `CostsController.estimate` + `CostService.estimateForSpec`
   * behaviour), keyed by game name in `breakdown`, with `total` set to the
   * sum-if-everything-were-running-simultaneously. Returns a zeroed {@link
   * CostBreakdown} when Terraform hasn't been applied (`getConfig` returns
   * nothing) or `config.gameNames` is missing/empty.
   */
  async getCostEstimate(): Promise<CostBreakdown> {
    const config = this.getConfig?.() ?? null;
    const gameNames = config?.gameNames;
    if (!config || !gameNames?.length) {
      return { total: 0, currency: 'USD', breakdown: {} };
    }

    const breakdown: Record<string, number> = {};
    for (const game of gameNames) {
      const spec = await this.getTaskDefinitionSpec(config.region, game);
      breakdown[game] = this.estimateHourlyCost(spec.cpu, spec.memory);
    }

    const total = Object.values(breakdown).reduce((sum, cost) => sum + cost, 0);
    return { total: Math.round(total * 10000) / 10000, currency: 'USD', breakdown };
  }

  /**
   * Retrieves billed actual costs over a given date range.
   *
   * Reproduces the previous `CostService.getActualCosts`'s Cost Explorer
   * query (`GetCostAndUsageCommand` filtered to ECS + Fargate,
   * `Granularity: 'DAILY'`), with `breakdown` keyed by ISO date
   * (`r.TimePeriod?.Start`) and each entry set to that day's
   * `UnblendedCost`, rounded to 4 decimal places — matching the previous
   * `CostService.getActualCosts`'s per-day breakdown exactly. `total` is the
   * sum across the whole range. Unlike the previous service, this method
   * does **not** swallow failures — Cost Explorer/SDK errors propagate to the
   * caller unchanged so provider-agnostic callers can decide how to surface
   * them.
   *
   * @param range - The date range to scope the billing query.
   */
  async getActualCosts(range: DateRange): Promise<CostBreakdown> {
    const fmt = (d: Date) => d.toISOString().split('T')[0]!;

    const resp = await this.getCostExplorerClient().send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: fmt(range.start), End: fmt(range.end) },
        Granularity: 'DAILY',
        Filter: {
          Dimensions: {
            Key: 'SERVICE',
            Values: ['Amazon Elastic Container Service', 'AWS Fargate'],
          },
        },
        Metrics: ['UnblendedCost'],
      }),
    );

    const breakdown: Record<string, number> = {};
    let total = 0;
    for (const r of resp.ResultsByTime ?? []) {
      const day = r.TimePeriod?.Start ?? '';
      const cost = parseFloat(r.Total?.['UnblendedCost']?.Amount ?? '0');
      breakdown[day] = Math.round(cost * 10000) / 10000;
      total += cost;
    }

    return {
      total: Math.round(total * 100) / 100,
      currency: 'USD',
      breakdown,
    };
  }
}
