import { Injectable } from '@nestjs/common';
import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTaskDefinitionCommand,
  type Task,
} from '@aws-sdk/client-ecs';
import {
  AwsCloudProvider,
  WorkloadGuardError,
  WorkloadLaunchError,
  type AwsCloudProviderConfig,
  type AwsCloudProviderLogger,
} from '@hyveon/cloud-aws';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { Ec2Service } from './Ec2Service.js';

/**
 * Maps `ConfigService`'s Terraform-outputs shape onto the narrow config
 * {@link AwsCloudProvider} expects. Returns `null` before `terraform apply`
 * has run, mirroring `ConfigService.getTfOutputs()` returning `null`.
 * Exported so `AwsModule` can reuse it when constructing the shared
 * `AwsCloudProvider` provider via `useFactory`.
 */
export function buildProviderConfig(config: ConfigService): AwsCloudProviderConfig | null {
  const outputs = config.getTfOutputs();
  if (!outputs) return null;
  return {
    region: config.getRegion(),
    ecsClusterName: outputs.ecs_cluster_name,
    subnetIds: outputs.subnet_ids,
    securityGroupId: outputs.security_group_id,
    domainName: outputs.domain_name,
  };
}

/**
 * Adapts the module-level Winston {@link logger} to the minimal
 * {@link AwsCloudProviderLogger} seam `AwsCloudProvider` accepts, so
 * ListTasks/DescribeTasks/DescribeNetworkInterfaces failures swallowed inside
 * `findRunningTask` / `getPublicIp` still land in the app's log files instead
 * of masquerading silently as "stopped" / "no IP". Exported so `AwsModule`'s
 * `useFactory` provider can wire the same adapter into the shared
 * `AwsCloudProvider` instance.
 */
export const awsCloudProviderLogger: AwsCloudProviderLogger = {
  error: (message: string, err: unknown) => logger.error(message, { err }),
};

/**
 * Builds the single shared {@link AwsCloudProvider} instance, wiring
 * {@link buildProviderConfig} and {@link awsCloudProviderLogger} to the given
 * `ConfigService`. Extracted so `EcsService`'s constructor default and
 * `AwsModule`'s `useFactory` provider construct the exact same thing rather
 * than duplicating the `new AwsCloudProvider(...)` call in two places.
 */
export function createAwsCloudProvider(config: ConfigService): AwsCloudProvider {
  return new AwsCloudProvider(() => buildProviderConfig(config), awsCloudProviderLogger);
}

/**
 * Renders a caught error for a caller-visible {@link StartResult.message}.
 * `AwsCloudProvider`'s guard clauses throw a {@link WorkloadGuardError} with
 * the exact string the app should surface (e.g. "minecraft is already
 * running."), and `startWorkload` throws a {@link WorkloadLaunchError} with
 * the exact `Failed to start {game}: {reason}` string when ECS's `RunTask`
 * reports a failure reason — for both, we return `err.message` unprefixed to
 * preserve the original message contract `EcsService.start`/`stop` used to
 * return directly before delegating to `AwsCloudProvider`. Any other error
 * (AWS SDK exceptions, plain unnamed `Error`s, or non-`Error` throws) falls
 * through to `String(err)`, which renders as "<name>: <message>" for `Error`
 * instances (e.g. "AccessDeniedException: ...", or "Error: throttled" for a
 * generic `Error`).
 */
function describeError(err: unknown): string {
  if (err instanceof WorkloadGuardError || err instanceof WorkloadLaunchError) return err.message;
  return String(err);
}

/**
 * True if `err` is a {@link WorkloadGuardError} — the type
 * {@link AwsCloudProvider.startWorkload} / {@link AwsCloudProvider.stopWorkload}
 * throw for expected precondition refusals (a task is already running,
 * nothing is running to stop, Terraform hasn't been applied yet) rather than
 * a genuine AWS/SDK failure. `start()` / `stop()` check this so refusals log
 * at `warn` instead of `error` — they're normal operator situations, not
 * exceptions worth alerting on. Using `instanceof` instead of message-pattern
 * matching means a wording change to a guard message can't silently
 * misclassify a refusal as an unexpected exception (or vice versa).
 */
function isGuardRefusal(err: unknown): boolean {
  return err instanceof WorkloadGuardError;
}

/**
 * Snapshot of a game's current state as surfaced to the UI/Discord. The
 * `state` distinguishes "running" (task `RUNNING`, IP resolved) from
 * "starting" (task exists but still provisioning) so the UI can show a
 * spinner rather than an unreachable hostname.
 */
export interface GameStatus {
  game: string;
  state: 'running' | 'starting' | 'stopped' | 'not_deployed' | 'error';
  publicIp?: string;
  hostname?: string;
  taskArn?: string;
  message?: string;
}

/**
 * Result shape for start/stop operations. Reused for both because the UI
 * treats them symmetrically (success toast on happy path, error toast on the
 * `message` otherwise).
 */
export interface StartResult {
  success: boolean;
  message: string;
  taskArn?: string;
}

/**
 * ECS facade for the management app. Wraps `RunTask` / `StopTask` /
 * `DescribeTasks` plus the FileBrowser-specific helpers used by
 * {@link FileManagerService}. There is intentionally no long-running ECS
 * Service here — the core cost-saving design is "run a one-off task only
 * when the user clicks Start, stop it when the watchdog or user decides".
 *
 * `getStatus` / `start` / `stop` delegate to {@link AwsCloudProvider}
 * (provided by `AwsModule`) rather than issuing `RunTaskCommand` /
 * `StopTaskCommand` or assembling status themselves — this class is a thin
 * translation layer between the cloud-agnostic `CloudProvider` contract and
 * the app's `GameStatus` / `StartResult` response shapes. The remaining
 * methods (task-definition lookups, the FileBrowser task helpers) stay on
 * the raw ECS SDK client since they're outside `CloudProvider`'s scope.
 */
@Injectable()
export class EcsService {
  private client: ECSClient | null = null;

  constructor(
    private readonly config: ConfigService,
    // Retained (unused) purely for constructor-signature/DI compatibility —
    // ENI-to-public-IP resolution now happens inside `AwsCloudProvider`
    // itself, so `getStatus` no longer needs to call through to `Ec2Service`.
    _ec2: Ec2Service,
    private readonly provider: AwsCloudProvider = createAwsCloudProvider(config),
  ) {}

  private getClient(): ECSClient {
    if (!this.client) {
      this.client = new ECSClient({ region: this.config.getRegion() });
    }
    return this.client;
  }

  /**
   * Dig the ENI ID out of a task's `attachments` array. Needed because the
   * public IP isn't on the task itself — it has to be looked up via EC2
   * using this ENI. Returns `null` if the task has no ENI attachment yet
   * (common while a task is still provisioning).
   */
  extractEniId(task: Task): string | null {
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
  async findRunningTask(cluster: string, game: string): Promise<Task | null> {
    try {
      const listResp = await this.getClient().send(
        new ListTasksCommand({ cluster, family: `${game}-server`, desiredStatus: 'RUNNING' }),
      );
      if (!listResp.taskArns?.length) return null;

      const descResp = await this.getClient().send(
        new DescribeTasksCommand({ cluster, tasks: listResp.taskArns }),
      );
      return (
        descResp.tasks?.find(
          (t) => t.lastStatus !== 'STOPPED' && t.lastStatus !== 'DEPROVISIONING',
        ) ?? null
      );
    } catch (err) {
      logger.error('Failed to find running task', { err, game });
      return null;
    }
  }

  /**
   * Assemble the full status (state + IP + hostname) for a single game.
   * Delegates to {@link AwsCloudProvider.getWorkloadStatus} and maps its
   * cloud-agnostic `WorkloadStatus` onto the app's `GameStatus` response
   * shape so controllers see no change.
   */
  async getStatus(game: string): Promise<GameStatus> {
    const status = await this.provider.getWorkloadStatus(game);
    return {
      game,
      state: status.state,
      publicIp: status.publicIp,
      hostname: status.hostname,
      taskArn: status.workloadId,
      message: status.message,
    };
  }

  /**
   * Launch a one-off Fargate task from the game's `{game}-server` task
   * definition. Delegates to {@link AwsCloudProvider.startWorkload}, which
   * refuses to start a second task when one is already running and throws
   * the same message strings this method used to return directly. The DNS
   * record is created asynchronously by the update-dns Lambda when the task
   * reaches RUNNING.
   */
  async start(game: string): Promise<StartResult> {
    logger.info('Starting game server', { game });
    try {
      const handle = await this.provider.startWorkload(game, {});
      logger.info('Game server started', { game, taskArn: handle.workloadId });
      return {
        success: true,
        message: `${game} is starting. It may take 2–5 minutes.`,
        taskArn: handle.workloadId,
      };
    } catch (err) {
      if (isGuardRefusal(err)) {
        logger.warn('Refused to start game server', { game, message: describeError(err) });
      } else {
        logger.error('Exception starting game server', { err, game });
      }
      return { success: false, message: describeError(err) };
    }
  }

  /**
   * Stop the active task for `game`. Delegates to
   * {@link AwsCloudProvider.stopWorkload}, which throws the same message
   * strings this method used to return directly. The STOPPED state-change
   * event fires the update-dns Lambda which deletes the Route 53 record —
   * no DNS cleanup needed here.
   */
  async stop(game: string): Promise<StartResult> {
    try {
      await this.provider.stopWorkload(game);
      return { success: true, message: `${game} is stopping.` };
    } catch (err) {
      if (isGuardRefusal(err)) {
        logger.warn('Refused to stop game server', { game, message: describeError(err) });
      } else {
        logger.error('Exception stopping game server', { err, game });
      }
      return { success: false, message: describeError(err) };
    }
  }

  /**
   * Fetch the latest revision of `{game}-server` to read its CPU/memory (for
   * cost estimates) and execution role (reused when the FileBrowser task
   * definition is registered on the fly).
   */
  async getTaskDefinition(game: string): Promise<{ cpu: number; memory: number; executionRoleArn: string } | null> {
    try {
      const resp = await this.getClient().send(
        new DescribeTaskDefinitionCommand({ taskDefinition: `${game}-server` }),
      );
      const td = resp.taskDefinition;
      if (!td) return null;
      return {
        cpu: parseInt(td.cpu ?? '1024', 10),
        memory: parseInt(td.memory ?? '2048', 10),
        executionRoleArn: td.executionRoleArn ?? '',
      };
    } catch (err) {
      logger.error('Failed to describe task definition', { err, game });
      return null;
    }
  }

  /**
   * Register a new task-definition revision on the fly. Used exclusively by
   * {@link FileManagerService.start} to build the FileBrowser task def per
   * game — game-server task definitions themselves are Terraform-managed.
   */
  async registerTaskDefinition(params: Parameters<ECSClient['send']>[0] extends import('@aws-sdk/client-ecs').RegisterTaskDefinitionCommand ? never : import('@aws-sdk/client-ecs').RegisterTaskDefinitionCommandInput): Promise<string | null> {
    const { RegisterTaskDefinitionCommand } = await import('@aws-sdk/client-ecs');
    try {
      const resp = await this.getClient().send(new RegisterTaskDefinitionCommand(params));
      const arn = resp.taskDefinition?.taskDefinitionArn ?? null;
      logger.info('Registered task definition', { family: params.family, arn });
      return arn;
    } catch (err) {
      logger.error('Failed to register task definition', { err, family: params.family });
      return null;
    }
  }

  /**
   * Low-level `RunTask` passthrough for callers that need to set their own
   * `startedBy` tag or networking (notably the FileBrowser launcher).
   * {@link EcsService.start} is the preferred entry point for game servers.
   */
  async runTask(params: import('@aws-sdk/client-ecs').RunTaskCommandInput): Promise<{ taskArn: string } | null> {
    try {
      const resp = await this.getClient().send(new RunTaskCommand(params));
      if (resp.tasks?.length) {
        const taskArn = resp.tasks[0]!.taskArn!;
        logger.info('Task started', { taskArn, startedBy: params.startedBy });
        return { taskArn };
      }
      const reason = resp.failures?.[0]?.reason ?? 'unknown';
      logger.error('RunTask failed', { reason, failures: resp.failures, params });
      return null;
    } catch (err) {
      logger.error('Exception running task', { err });
      return null;
    }
  }

  /**
   * Find active tasks tagged with a given `startedBy` value — the marker
   * the FileBrowser launcher uses (`filemgr-{game}`) to locate its own
   * tasks without relying on a bespoke task-definition family.
   */
  async listTasksByStartedBy(cluster: string, startedBy: string): Promise<Task[]> {
    try {
      const listResp = await this.getClient().send(
        new ListTasksCommand({ cluster, startedBy, desiredStatus: 'RUNNING' }),
      );
      if (!listResp.taskArns?.length) return [];
      const descResp = await this.getClient().send(
        new DescribeTasksCommand({ cluster, tasks: listResp.taskArns }),
      );
      return (
        descResp.tasks?.filter(
          (t) => t.lastStatus !== 'STOPPED' && t.lastStatus !== 'DEPROVISIONING',
        ) ?? []
      );
    } catch (err) {
      logger.error('Failed to list tasks by startedBy', { err, startedBy });
      return [];
    }
  }

  /**
   * Raw `StopTask` wrapper for callers that already hold an ARN (FileBrowser
   * and similar) and don't want the family-based lookup {@link EcsService.stop}
   * performs.
   */
  async stopTask(cluster: string, taskArn: string, reason: string): Promise<void> {
    await this.getClient().send(new StopTaskCommand({ cluster, task: taskArn, reason }));
  }
}
