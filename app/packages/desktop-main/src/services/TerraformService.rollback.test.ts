import { describe, it, expect, vi } from 'vitest';
import type { RemoteFileStore, RunRecord } from '@hyveon/shared';
import {
  TerraformService,
  RollbackTargetNotFoundError,
  RollbackNotApplyRunError,
  RollbackNoTfvarsVersionError,
  RollbackVersionMissingError,
} from './TerraformService.js';
import type { ConfigService } from './ConfigService.js';
import type { RunRecordService } from './RunRecordService.js';
import type { TfvarsService } from './TfvarsService.js';

/** Builds a `ConfigService` stub exposing only what rollback resolution reads. */
function stubConfigService(opts: { tfvarsPath?: string } = {}): ConfigService {
  return {
    getTfvarsPath: () => opts.tfvarsPath ?? '/repo/terraform/terraform.tfvars',
  } as ConfigService;
}

/** Builds a `RemoteFileStore` stub whose `listVersions`/`getVersion` are directly-controllable mocks. */
function stubRemoteFileStore(): RemoteFileStore & {
  listVersions: ReturnType<typeof vi.fn>;
  getVersion: ReturnType<typeof vi.fn>;
} {
  const store: Partial<RemoteFileStore> = {
    get: vi.fn(),
    put: vi.fn(),
    listVersions: vi.fn(),
    getVersion: vi.fn(),
  };
  return store as RemoteFileStore & {
    listVersions: ReturnType<typeof vi.fn>;
    getVersion: ReturnType<typeof vi.fn>;
  };
}

/** Builds a `RunRecordService` stub whose `getByRunId` is a directly-controllable mock. */
function stubRunRecordService(): RunRecordService & { getByRunId: ReturnType<typeof vi.fn> } {
  const stub: Partial<RunRecordService> = { getByRunId: vi.fn() };
  return stub as RunRecordService & { getByRunId: ReturnType<typeof vi.fn> };
}

/** Builds a `TfvarsService` stub whose `restoreRawTfvars` is a directly-controllable mock. */
function stubTfvarsService(): TfvarsService & { restoreRawTfvars: ReturnType<typeof vi.fn> } {
  const stub: Partial<TfvarsService> = { restoreRawTfvars: vi.fn() };
  return stub as TfvarsService & { restoreRawTfvars: ReturnType<typeof vi.fn> };
}

/** Builds a sample apply {@link RunRecord}, overridable per-test. */
function makeApplyRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    sk: '2026-07-20T00:00:00.000Z#apply-run-1',
    runId: 'apply-run-1',
    kind: 'apply',
    status: 'success',
    startedAt: '2026-07-20T00:00:00.000Z',
    completedAt: '2026-07-20T00:05:00.000Z',
    exitCode: 0,
    tfvarsVersionId: 'v-current',
    ...overrides,
  };
}

describe('TerraformService.resolveRollbackTarget', () => {
  it('should throw RollbackTargetNotFoundError when no run record exists for applyRunId', async () => {
    const runRecordService = stubRunRecordService();
    runRecordService.getByRunId.mockResolvedValue(undefined);
    const service = new TerraformService(stubConfigService(), stubRemoteFileStore(), runRecordService);

    await expect(service.resolveRollbackTarget('apply-run-1')).rejects.toBeInstanceOf(
      RollbackTargetNotFoundError,
    );
  });

  it('should throw RollbackNotApplyRunError when the run record is not an apply run', async () => {
    const runRecordService = stubRunRecordService();
    runRecordService.getByRunId.mockResolvedValue(makeApplyRecord({ kind: 'plan' }));
    const service = new TerraformService(stubConfigService(), stubRemoteFileStore(), runRecordService);

    await expect(service.resolveRollbackTarget('apply-run-1')).rejects.toBeInstanceOf(
      RollbackNotApplyRunError,
    );
  });

  it('should throw RollbackNoTfvarsVersionError when the apply run has no recorded tfvarsVersionId', async () => {
    const runRecordService = stubRunRecordService();
    runRecordService.getByRunId.mockResolvedValue(makeApplyRecord({ tfvarsVersionId: undefined }));
    const service = new TerraformService(stubConfigService(), stubRemoteFileStore(), runRecordService);

    await expect(service.resolveRollbackTarget('apply-run-1')).rejects.toBeInstanceOf(
      RollbackNoTfvarsVersionError,
    );
  });

  it('should resolve the version immediately after the apply run\'s own version in the newest-first history', async () => {
    const runRecordService = stubRunRecordService();
    runRecordService.getByRunId.mockResolvedValue(makeApplyRecord({ tfvarsVersionId: 'v-current' }));
    const remoteFileStore = stubRemoteFileStore();
    const priorLastModified = new Date('2026-07-18T00:00:00.000Z');
    remoteFileStore.listVersions.mockResolvedValue([
      { versionId: 'v-current', lastModified: new Date('2026-07-19T00:00:00.000Z') },
      { versionId: 'v-prior', lastModified: priorLastModified },
      { versionId: 'v-oldest', lastModified: new Date('2026-07-01T00:00:00.000Z') },
    ]);
    const service = new TerraformService(stubConfigService(), remoteFileStore, runRecordService);

    await expect(service.resolveRollbackTarget('apply-run-1')).resolves.toEqual({
      versionId: 'v-prior',
      lastModified: priorLastModified,
    });
    expect(remoteFileStore.listVersions).toHaveBeenCalledWith('terraform.tfvars');
  });

  it('should throw RollbackVersionMissingError when the apply run\'s own version is the oldest in history (no earlier version exists)', async () => {
    const runRecordService = stubRunRecordService();
    runRecordService.getByRunId.mockResolvedValue(makeApplyRecord({ tfvarsVersionId: 'v-oldest' }));
    const remoteFileStore = stubRemoteFileStore();
    remoteFileStore.listVersions.mockResolvedValue([
      { versionId: 'v-current', lastModified: new Date('2026-07-19T00:00:00.000Z') },
      { versionId: 'v-oldest', lastModified: new Date('2026-07-01T00:00:00.000Z') },
    ]);
    const service = new TerraformService(stubConfigService(), remoteFileStore, runRecordService);

    await expect(service.resolveRollbackTarget('apply-run-1')).rejects.toBeInstanceOf(
      RollbackVersionMissingError,
    );
  });

  it('should throw RollbackVersionMissingError when the apply run\'s own version is no longer present in history at all', async () => {
    const runRecordService = stubRunRecordService();
    runRecordService.getByRunId.mockResolvedValue(makeApplyRecord({ tfvarsVersionId: 'v-vanished' }));
    const remoteFileStore = stubRemoteFileStore();
    remoteFileStore.listVersions.mockResolvedValue([
      { versionId: 'v-current', lastModified: new Date('2026-07-19T00:00:00.000Z') },
    ]);
    const service = new TerraformService(stubConfigService(), remoteFileStore, runRecordService);

    await expect(service.resolveRollbackTarget('apply-run-1')).rejects.toBeInstanceOf(
      RollbackVersionMissingError,
    );
  });
});

describe('TerraformService.confirmRollback', () => {
  it('should throw a clear error and write nothing when constructed without a TfvarsService', async () => {
    const runRecordService = stubRunRecordService();
    runRecordService.getByRunId.mockResolvedValue(makeApplyRecord());
    const remoteFileStore = stubRemoteFileStore();
    const service = new TerraformService(stubConfigService(), remoteFileStore, runRecordService);

    await expect(service.confirmRollback('apply-run-1')).rejects.toThrow(/no TfvarsService/);
    expect(remoteFileStore.getVersion).not.toHaveBeenCalled();
  });

  it('should restore the resolved version\'s bytes as the new head and return the fresh versionId', async () => {
    const runRecordService = stubRunRecordService();
    runRecordService.getByRunId.mockResolvedValue(makeApplyRecord({ tfvarsVersionId: 'v-current' }));
    const remoteFileStore = stubRemoteFileStore();
    remoteFileStore.listVersions.mockResolvedValue([
      { versionId: 'v-current', lastModified: new Date('2026-07-19T00:00:00.000Z') },
      { versionId: 'v-prior', lastModified: new Date('2026-07-18T00:00:00.000Z') },
    ]);
    const priorHcl = 'game_servers = { palworld = {} }';
    remoteFileStore.getVersion.mockResolvedValue({ body: new TextEncoder().encode(priorHcl) });
    const tfvarsService = stubTfvarsService();
    tfvarsService.restoreRawTfvars.mockResolvedValue({ etag: 'etag-new', versionId: 'v-new-head' });

    const service = new TerraformService(stubConfigService(), remoteFileStore, runRecordService, tfvarsService);

    await expect(service.confirmRollback('apply-run-1')).resolves.toEqual({ versionId: 'v-new-head' });
    expect(remoteFileStore.getVersion).toHaveBeenCalledWith('terraform.tfvars', 'v-prior');
    expect(tfvarsService.restoreRawTfvars).toHaveBeenCalledWith(priorHcl);
  });

  it('should throw RollbackVersionMissingError and never write when the resolved version\'s bytes can no longer be read', async () => {
    const runRecordService = stubRunRecordService();
    runRecordService.getByRunId.mockResolvedValue(makeApplyRecord({ tfvarsVersionId: 'v-current' }));
    const remoteFileStore = stubRemoteFileStore();
    remoteFileStore.listVersions.mockResolvedValue([
      { versionId: 'v-current', lastModified: new Date('2026-07-19T00:00:00.000Z') },
      { versionId: 'v-prior', lastModified: new Date('2026-07-18T00:00:00.000Z') },
    ]);
    remoteFileStore.getVersion.mockResolvedValue(undefined);
    const tfvarsService = stubTfvarsService();

    const service = new TerraformService(stubConfigService(), remoteFileStore, runRecordService, tfvarsService);

    await expect(service.confirmRollback('apply-run-1')).rejects.toBeInstanceOf(RollbackVersionMissingError);
    expect(tfvarsService.restoreRawTfvars).not.toHaveBeenCalled();
  });

  it('should propagate resolveRollbackTarget\'s rejection (e.g. no run record) without attempting a write', async () => {
    const runRecordService = stubRunRecordService();
    runRecordService.getByRunId.mockResolvedValue(undefined);
    const remoteFileStore = stubRemoteFileStore();
    const tfvarsService = stubTfvarsService();

    const service = new TerraformService(stubConfigService(), remoteFileStore, runRecordService, tfvarsService);

    await expect(service.confirmRollback('apply-run-1')).rejects.toBeInstanceOf(RollbackTargetNotFoundError);
    expect(remoteFileStore.getVersion).not.toHaveBeenCalled();
    expect(tfvarsService.restoreRawTfvars).not.toHaveBeenCalled();
  });
});
