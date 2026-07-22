import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { RunLock } from '@hyveon/shared';
import { TerraformRunsController } from './terraform-runs.controller.js';
import type { TerraformService, TerraformRunRecord } from '../services/TerraformService.js';
import type { RunService } from '../services/RunService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Build a `TerraformService` stub. `record` seeds what `readRunRecord`
 * resolves for any `runId` (defaults to `null`, i.e. no persisted run);
 * `planArtifactExists` seeds `hasPlanArtifact`'s return value.
 */
function makeTerraform(
  record: TerraformRunRecord | null = null,
  planArtifactExists = false,
): TerraformService {
  return {
    readRunRecord: vi.fn().mockReturnValue(record),
    hasPlanArtifact: vi.fn().mockReturnValue(planArtifactExists),
  } as unknown as TerraformService;
}

/** Build a `RunService` stub whose `getCurrentLock()` returns `lock` (defaults to `undefined`, i.e. no run in flight). */
function makeRunService(lock: RunLock | undefined = undefined): RunService {
  return {
    getCurrentLock: vi.fn().mockReturnValue(lock),
  } as unknown as RunService;
}

/** A `TerraformRunRecord` fixture for a successful `plan` run. */
function buildRecord(overrides: Partial<TerraformRunRecord> = {}): TerraformRunRecord {
  return {
    runId: 'run-1',
    kind: 'plan',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    exitCode: 0,
    ...overrides,
  };
}

/** A `RunLock` fixture for a run currently holding the apply lock. */
function buildLock(overrides: Partial<RunLock> = {}): RunLock {
  return {
    runId: 'run-1',
    kind: 'plan',
    initiator: 'operator',
    acquiredAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T01:00:00.000Z',
    ...overrides,
  };
}

describe('TerraformRunsController.get', () => {
  it('should return found: true, status: running for the runId currently holding the apply lock', async () => {
    const runService = makeRunService(buildLock({ runId: 'run-live' }));
    const terraform = makeTerraform();
    const controller = new TerraformRunsController(terraform, runService);

    const result = await controller.get({ runId: 'run-live' });

    expect(result).toEqual({ found: true, status: 'running' });
    expect(terraform.readRunRecord).not.toHaveBeenCalled();
  });

  it('should return found: true, status: success plus the record for a finished apply run', async () => {
    const record = buildRecord({ runId: 'run-apply', kind: 'apply', exitCode: 0 });
    const terraform = makeTerraform(record);
    const runService = makeRunService();
    const controller = new TerraformRunsController(terraform, runService);

    const result = await controller.get({ runId: 'run-apply' });

    expect(result).toEqual({ found: true, status: 'success', record });
  });

  it('should return found: true, status: failed plus the record for a plan run that exited non-zero', async () => {
    const record = buildRecord({ runId: 'run-failed', kind: 'plan', exitCode: 1 });
    const terraform = makeTerraform(record, false);
    const runService = makeRunService();
    const controller = new TerraformRunsController(terraform, runService);

    const result = await controller.get({ runId: 'run-failed' });

    expect(result).toEqual({ found: true, status: 'failed', record });
  });

  it('should return found: true, status: aborted plus the record for a run with no exit code', async () => {
    const record = buildRecord({ runId: 'run-aborted', kind: 'destroy', exitCode: null });
    const terraform = makeTerraform(record);
    const runService = makeRunService();
    const controller = new TerraformRunsController(terraform, runService);

    const result = await controller.get({ runId: 'run-aborted' });

    expect(result).toEqual({ found: true, status: 'aborted', record });
  });

  it('should return found: true, status: awaiting_approval plus the record for a successful plan run whose .tfplan artifact still exists', async () => {
    const record = buildRecord({ runId: 'run-plan', kind: 'plan', exitCode: 0 });
    const terraform = makeTerraform(record, true);
    const runService = makeRunService();
    const controller = new TerraformRunsController(terraform, runService);

    const result = await controller.get({ runId: 'run-plan' });

    expect(result).toEqual({ found: true, status: 'awaiting_approval', record });
    expect(terraform.hasPlanArtifact).toHaveBeenCalledWith('run-plan');
  });

  it('should return found: false when runId is neither the held lock nor a persisted run', async () => {
    const terraform = makeTerraform(null);
    const runService = makeRunService();
    const controller = new TerraformRunsController(terraform, runService);

    const result = await controller.get({ runId: 'does-not-exist' });

    expect(result).toEqual({ found: false });
  });

  it('should reject a payload with a missing runId', async () => {
    const controller = new TerraformRunsController(makeTerraform(), makeRunService());

    await expect(
      controller.get({} as unknown as { runId: string }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('should reject a payload with a non-string runId', async () => {
    const controller = new TerraformRunsController(makeTerraform(), makeRunService());

    await expect(
      controller.get({ runId: 42 } as unknown as { runId: string }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('should reject a payload with an empty-string runId', async () => {
    const controller = new TerraformRunsController(makeTerraform(), makeRunService());

    await expect(controller.get({ runId: '' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
