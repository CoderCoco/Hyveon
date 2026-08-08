import { Injectable } from '@nestjs/common';
import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-scheduler';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveAwsClientCredentialsWithSignature } from './awsCredentialSource.js';

/**
 * The universal-target ARN EventBridge Scheduler recognizes as "call the ECS
 * `StopTask` API directly", per AWS's universal-target format
 * `arn:aws:scheduler:::aws-sdk:{service}:{apiAction}` — no Lambda
 * intermediary needed. `{service}` must match ECS's AWS SDK service
 * identifier (`ecs`), and `{apiAction}` the camelCase operation name
 * (`stopTask`).
 */
const ECS_STOP_TASK_TARGET_ARN = 'arn:aws:scheduler:::aws-sdk:ecs:stopTask';

/** Parameters for {@link SchedulerService.createStopSchedule}. */
export interface CreateStopScheduleParams {
  /**
   * Schedule name, unique within the account/region. Callers should derive
   * this deterministically from what the schedule stops (e.g.
   * `filemgr-stop-{game}`) so a later {@link SchedulerService.deleteSchedule}
   * call can recompute it without persisting extra state.
   */
  name: string;
  /** The ECS cluster ARN or name the target task runs in. */
  cluster: string;
  /** The ECS task ARN to stop when the schedule fires. */
  taskArn: string;
  /** IAM role ARN EventBridge Scheduler assumes to call `ecs:StopTask` — must trust `scheduler.amazonaws.com` and grant that action. */
  roleArn: string;
  /** The instant the schedule should fire. Must be in the future. */
  at: Date;
}

/**
 * Thin wrapper around EventBridge Scheduler, used solely to auto-stop the
 * FileBrowser helper task a fixed duration after launch so a forgotten
 * session doesn't run (and bill) indefinitely. Every schedule created here
 * targets `ecs:StopTask` directly via a "universal target" — no Lambda
 * intermediary — per AWS's universal-target contract (see
 * {@link ECS_STOP_TASK_TARGET_ARN}'s doc). Mirrors {@link Ec2Service}'s
 * client-construction pattern: a single lazily-constructed client, region
 * from `ConfigService.getRegion()`, every AWS call wrapped in try/catch that
 * logs and returns a sentinel rather than throwing.
 */
@Injectable()
export class SchedulerService {
  private client: SchedulerClient | null = null;
  private clientCacheKey: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly store: ElectronStoreService,
  ) {}

  /**
   * Lazily constructs the client, recreating it whenever the
   * freshly-resolved region or credentials signature differs from what the
   * cached client was built with — see `EcsService.getClient`'s matching doc
   * comment for why both matter.
   */
  private getClient(): SchedulerClient {
    const region = this.config.getRegion();
    const { credentials, signature } = resolveAwsClientCredentialsWithSignature(this.store);
    const cacheKey = `${region}::${signature}`;
    if (!this.client || this.clientCacheKey !== cacheKey) {
      this.client = new SchedulerClient({ region, credentials });
      this.clientCacheKey = cacheKey;
    }
    return this.client;
  }

  /**
   * Formats a `Date` as the local (UTC) timestamp EventBridge Scheduler's
   * `at(yyyy-mm-ddThh:mm:ss)` expression expects — no fractional seconds, no
   * trailing `Z` (the schedule's default `ScheduleExpressionTimezone` is
   * UTC, which `toISOString()` already reflects).
   */
  private static atExpression(when: Date): string {
    return `at(${when.toISOString().slice(0, 19)})`;
  }

  /**
   * Creates a one-time schedule that calls `ecs:StopTask` on `params.taskArn`
   * at `params.at`, then deletes itself once it fires
   * (`actionAfterCompletion: 'DELETE'`) so a fired schedule never lingers as
   * a stale object. Any existing schedule with the same name is deleted
   * first (best-effort) so a start-after-crash doesn't collide with a
   * schedule the previous launch never got to clean up.
   *
   * @param params - See {@link CreateStopScheduleParams}.
   * @returns `true` if the schedule was created, `false` on any failure
   *   (logged, never thrown — callers treat this as best-effort: a failed
   *   auto-stop schedule should not fail the FileBrowser launch itself).
   */
  async createStopSchedule(params: CreateStopScheduleParams): Promise<boolean> {
    await this.deleteSchedule(params.name);
    try {
      await this.getClient().send(
        new CreateScheduleCommand({
          Name: params.name,
          ScheduleExpression: SchedulerService.atExpression(params.at),
          FlexibleTimeWindow: { Mode: 'OFF' },
          ActionAfterCompletion: 'DELETE',
          Target: {
            Arn: ECS_STOP_TASK_TARGET_ARN,
            RoleArn: params.roleArn,
            Input: JSON.stringify({
              cluster: params.cluster,
              task: params.taskArn,
              reason: 'Auto-stopped: FileBrowser helper TTL expired',
            }),
          },
        }),
      );
      logger.info('Created FileBrowser auto-stop schedule', { name: params.name, at: params.at.toISOString() });
      return true;
    } catch (err) {
      logger.error('Failed to create FileBrowser auto-stop schedule', { err, name: params.name });
      return false;
    }
  }

  /**
   * Deletes a schedule by name — best-effort: a schedule that already fired
   * (and self-deleted via `actionAfterCompletion: 'DELETE'`) or never existed
   * both resolve as a no-op rather than an error. Called both defensively
   * before creating a new schedule and when the operator manually stops the
   * FileBrowser task early.
   *
   * @param name - The schedule name to delete.
   */
  async deleteSchedule(name: string): Promise<void> {
    try {
      await this.getClient().send(new DeleteScheduleCommand({ Name: name }));
      logger.debug('Deleted FileBrowser auto-stop schedule', { name });
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return;
      logger.error('Failed to delete FileBrowser auto-stop schedule', { err, name });
    }
  }
}
