import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  type Task,
} from '@aws-sdk/client-ecs';
import { EC2Client, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';
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
 * `streamWorkloadLogs`, `getCostEstimate` and `getActualCosts` remain stubs
 * until their own follow-up tasks (#172, #174, #176) land.
 */
export class AwsCloudProvider implements CloudProvider {
  private ecsClient: ECSClient | null = null;
  private ec2Client: EC2Client | null = null;

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

  private getEcsClient(region: string): ECSClient {
    if (!this.ecsClient) {
      this.ecsClient = new ECSClient({ region });
    }
    return this.ecsClient;
  }

  private getEc2Client(region: string): EC2Client {
    if (!this.ec2Client) {
      this.ec2Client = new EC2Client({ region });
    }
    return this.ec2Client;
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
    const task = await this.findRunningTask(config.region, cluster, game);
    if (!task) throw new WorkloadGuardError(`${game} is not currently running.`);

    // Deliberately no try/catch here — see the matching comment in
    // `startWorkload`: StopTask failures propagate unchanged.
    await this.getEcsClient(config.region).send(
      new StopTaskCommand({ cluster, task: task.taskArn, reason: 'Stopped via management app' }),
    );
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
