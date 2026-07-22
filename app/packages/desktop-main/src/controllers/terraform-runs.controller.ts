import { BadRequestException, Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { computeRunDetailStatus, type RunDetailStatus } from '@hyveon/shared';
import { TerraformService, type TerraformRunRecord } from '../services/TerraformService.js';
import { RunService } from '../services/RunService.js';

/** Payload accepted by {@link TerraformRunsController.get}. */
export interface TerraformRunsGetPayload {
  runId: string;
}

/**
 * Result of {@link TerraformRunsController.get}: `found: false` when `runId`
 * is neither the currently held apply lock nor a persisted
 * `TerraformRunRecord` on disk. `found: true` always carries the derived
 * {@link RunDetailStatus}; `record` is present only once the run has produced
 * a persisted `TerraformRunRecord` (i.e. every status except `running`, since
 * a run in flight hasn't closed its process yet — see
 * `TerraformRunRecord`'s file-level doc comment).
 */
export type TerraformRunsGetResult =
  | { found: false }
  | { found: true; status: RunDetailStatus; record?: TerraformRunRecord };

/**
 * IPC-only controller for reading the status/detail of a single `terraform`
 * plan/apply/destroy run (issue #108) — no HTTP routes are registered here.
 *
 * `get()` combines two data sources to derive the run's
 * {@link RunDetailStatus} via the shared, pure `computeRunDetailStatus`
 * helper: `RunService.getCurrentLock()` (the in-flight apply lock, #106) for
 * a still-running run, and `TerraformService.readRunRecord()` /
 * `TerraformService.hasPlanArtifact()` (the local `<runsDir>/<runId>/run.json`
 * + `.tfplan` artifact, #108's `TerraformService` half) for a finished one.
 */
@Controller()
export class TerraformRunsController {
  constructor(
    private readonly terraform: TerraformService,
    private readonly runService: RunService,
  ) {}

  /**
   * Looks up a single run by `runId` and returns its current
   * {@link RunDetailStatus}:
   *
   * - `{ found: true, status: 'running' }` when `runId` matches the run
   *   currently holding the apply lock (`RunService.getCurrentLock()`) — no
   *   `record` is attached, since a {@link TerraformRunRecord} is only ever
   *   persisted once the run's process has closed.
   * - `{ found: true, status, record }` when a persisted
   *   {@link TerraformRunRecord} exists for `runId` — `status` is derived via
   *   `computeRunDetailStatus`, checking `TerraformService.hasPlanArtifact()`
   *   for `plan` records to distinguish `awaiting_approval` from a terminal
   *   `success`/`failed`/`aborted`.
   * - `{ found: false }` when `runId` is neither in flight nor has a
   *   persisted record.
   *
   * @throws `BadRequestException` when `payload.runId` isn't a non-empty
   *   string.
   *
   * Reachable via the Electron IPC transport (`terraform.runs.get`).
   */
  @MessagePattern('terraform.runs.get')
  async get(@Payload() payload: TerraformRunsGetPayload): Promise<TerraformRunsGetResult> {
    const runId = payload?.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new BadRequestException({
        success: false,
        error: 'terraform.runs.get requires a non-empty runId string',
      });
    }

    const currentLock = this.runService.getCurrentLock();
    if (currentLock?.runId === runId) {
      return { found: true, status: 'running' };
    }

    const record = this.terraform.readRunRecord(runId);
    if (!record) {
      return { found: false };
    }

    const planArtifactExists = record.kind === 'plan' ? this.terraform.hasPlanArtifact(runId) : false;
    const status = computeRunDetailStatus({
      isInFlight: false,
      kind: record.kind,
      exitCode: record.exitCode,
      planArtifactExists,
    });

    return { found: true, status, record };
  }
}
