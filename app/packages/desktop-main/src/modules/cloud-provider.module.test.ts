import 'reflect-metadata';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  AwsSecretsStore,
  AwsRemoteFileStore,
  AwsDiscordEventReceiver,
  AwsCloudProvider,
  AwsAuditLogStore,
  AwsRunRecordStore,
} from '@hyveon/cloud-aws';
import type {
  CloudProvider,
  SecretsStore,
  RemoteFileStore,
  DiscordEventReceiver,
  AuditLogStore,
  RunRecordStore,
  StartOpts,
  WorkloadHandle,
  WorkloadStatus,
  LogChunk,
  CostBreakdown,
  AuditEntry,
  AuditPageResult,
  RunRecord,
} from '@hyveon/shared';
import {
  CLOUD_BINDINGS,
  resolveCloudBindings,
  resolveDeploymentConfigFileStoreConfig,
  resolveAuditLogStoreConfig,
  resolveRunRecordStoreConfig,
  type CloudBindings,
} from './cloud-provider.module.js';
import type { ConfigService, ActiveCloud } from '../services/ConfigService.js';
import type { ElectronStoreService } from '../services/ElectronStoreService.js';
import type { StackOutputs } from '@hyveon/shared';

/**
 * Build a minimal `ConfigService` stub reporting the given cloud as active.
 * `resolveCloudBindings` only reads `getActiveCloud()`, so nothing else needs
 * to be stubbed. The cast lets tests exercise an unregistered/fake cloud
 * value without widening `ActiveCloud` itself.
 */
function makeConfig(
  activeCloud: ActiveCloud,
  configBucket: string | null = 'test-config-bucket',
  auditTableName = 'test-audit-table',
  runsTableName = 'test-runs-table',
  awsRegion = 'us-east-1',
): ConfigService {
  const stub: Partial<ConfigService> = {
    getActiveCloud: () => activeCloud,
    getRegion: () => 'us-east-1',
    getConfigurationBucket: () => configBucket,
    getStackOutputs: async () => ({ auditTableName, runsTableName, awsRegion } as StackOutputs),
  };
  return stub as ConfigService;
}

/**
 * Build a minimal `ElectronStoreService` stub reporting no wizard-configured
 * AWS profile — `resolveAwsClientCredentials` resolves this to `undefined`
 * credentials, matching a store nothing has been written to yet.
 */
function makeStore(): ElectronStoreService {
  const stub: Partial<ElectronStoreService> = { get: vi.fn().mockReturnValue(undefined) };
  return stub as ElectronStoreService;
}

/**
 * Hand-rolled fake `CloudProvider` used to prove that `resolveCloudBindings`
 * routes to whatever package is registered under the active cloud key,
 * rather than being hardwired to `@hyveon/cloud-aws`.
 */
class FakeCloudProvider implements CloudProvider {
  startWorkload(_game: string, _opts: StartOpts): Promise<WorkloadHandle> {
    throw new Error('not implemented in fake');
  }
  stopWorkload(_game: string): Promise<void> {
    throw new Error('not implemented in fake');
  }
  getWorkloadStatus(_game: string): Promise<WorkloadStatus> {
    throw new Error('not implemented in fake');
  }
  streamWorkloadLogs(_game: string, _signal: AbortSignal): AsyncIterable<LogChunk> {
    throw new Error('not implemented in fake');
  }
  getCostEstimate(): Promise<CostBreakdown> {
    throw new Error('not implemented in fake');
  }
}

/** Hand-rolled fake `SecretsStore` — see {@link FakeCloudProvider}. */
class FakeSecretsStore implements SecretsStore {
  get(_name: string): Promise<string | undefined> {
    throw new Error('not implemented in fake');
  }
  put(_name: string, _value: string): Promise<void> {
    throw new Error('not implemented in fake');
  }
  exists(_name: string): Promise<boolean> {
    throw new Error('not implemented in fake');
  }
}

/** Hand-rolled fake `RemoteFileStore` — see {@link FakeCloudProvider}. */
class FakeRemoteFileStore implements RemoteFileStore {
  get(_path: string): Promise<{ body: Uint8Array; etag: string } | undefined> {
    throw new Error('not implemented in fake');
  }
  getVersion(_path: string, _versionId: string): Promise<{ body: Uint8Array } | undefined> {
    throw new Error('not implemented in fake');
  }
  put(
    _path: string,
    _body: Uint8Array,
    _opts?: { ifMatch?: string },
  ): Promise<{ etag: string }> {
    throw new Error('not implemented in fake');
  }
  listVersions(_path: string): Promise<Array<{ versionId: string; lastModified: Date }>> {
    throw new Error('not implemented in fake');
  }
}

/** Hand-rolled fake `DiscordEventReceiver` — see {@link FakeCloudProvider}. */
class FakeDiscordEventReceiver implements DiscordEventReceiver {
  getInteractionEndpointUrl(): Promise<string | null> {
    throw new Error('not implemented in fake');
  }
}

/** Hand-rolled fake `AuditLogStore` — see {@link FakeCloudProvider}. */
class FakeAuditLogStore implements AuditLogStore {
  putEntry(_entry: AuditEntry): Promise<void> {
    throw new Error('not implemented in fake');
  }
  listEntries(_limit: number, _before?: string): Promise<AuditPageResult> {
    throw new Error('not implemented in fake');
  }
}

/** Hand-rolled fake `RunRecordStore` — see {@link FakeCloudProvider}. */
class FakeRunRecordStore implements RunRecordStore {
  putRecord(_record: RunRecord): Promise<void> {
    throw new Error('not implemented in fake');
  }
  putLog(_runId: string, _body: Uint8Array): Promise<string> {
    throw new Error('not implemented in fake');
  }
  getLogUrl(_logKey: string, _expiresInSeconds?: number): Promise<string> {
    throw new Error('not implemented in fake');
  }
}

/**
 * `RemoteFileStore` stub for `resolveRunRecordStoreConfig`'s second
 * parameter — every existing test below has `getStackOutputs()` report a
 * non-empty `runsTableName`, so the `||` short-circuit in
 * `resolveRunRecordStoreConfig` never actually calls `get()` on this;
 * throwing here proves that short-circuit, not just asserts around it.
 */
const throwingRemoteFileStore: RemoteFileStore = {
  get: () => {
    throw new Error('should not be called: a deployed stack output was expected to short-circuit this');
  },
  getVersion: () => Promise.reject(new Error('not implemented in fake')),
  put: () => Promise.reject(new Error('not implemented in fake')),
  listVersions: () => Promise.reject(new Error('not implemented in fake')),
};

/** Builds a minimal `RemoteFileStore` stub whose `get()` resolves to the given `DeploymentConfig`-shaped body (or `undefined`, simulating no configuration object written yet). */
function makeConfigRemoteFileStore(config?: Partial<{ projectName: string; runsTableName: string }>): RemoteFileStore {
  return {
    get: async () =>
      config === undefined
        ? undefined
        : { body: new TextEncoder().encode(JSON.stringify(config)), etag: 'etag-1' },
    getVersion: () => Promise.reject(new Error('not implemented in fake')),
    put: () => Promise.reject(new Error('not implemented in fake')),
    listVersions: () => Promise.reject(new Error('not implemented in fake')),
  };
}

/** Registered `CLOUD_BINDINGS` key used to exercise the fake-cloud routing case. */
const FAKE_CLOUD = 'fake-test-cloud';

/** Bindings pointing at the hand-rolled fakes above, keyed under {@link FAKE_CLOUD}. */
const FAKE_BINDINGS: CloudBindings = {
  cloudProvider: () => new FakeCloudProvider(),
  secretsStore: () => new FakeSecretsStore(),
  remoteFileStore: () => new FakeRemoteFileStore(),
  discordReceiver: () => new FakeDiscordEventReceiver(),
  auditLogStore: () => new FakeAuditLogStore(),
  runRecordStore: () => new FakeRunRecordStore(),
};

describe('resolveCloudBindings', () => {
  afterEach(() => {
    delete CLOUD_BINDINGS[FAKE_CLOUD];
  });

  describe('aws routing', () => {
    it('should resolve the aws bindings when the active cloud is aws', () => {
      const bindings = resolveCloudBindings(makeConfig('aws'));
      expect(bindings).toBe(CLOUD_BINDINGS.aws);
    });

    it('should produce an AwsCloudProvider from the aws cloudProvider factory', () => {
      const config = makeConfig('aws');
      const bindings = resolveCloudBindings(config);
      expect(bindings.cloudProvider(config, makeStore())).toBeInstanceOf(AwsCloudProvider);
    });

    it('should produce an AwsSecretsStore from the aws secretsStore factory', () => {
      const config = makeConfig('aws');
      const bindings = resolveCloudBindings(config);
      expect(bindings.secretsStore(config, makeStore())).toBeInstanceOf(AwsSecretsStore);
    });

    it('should produce an AwsRemoteFileStore from the aws remoteFileStore factory', () => {
      const config = makeConfig('aws');
      const bindings = resolveCloudBindings(config);
      expect(bindings.remoteFileStore(config, makeStore())).toBeInstanceOf(AwsRemoteFileStore);
    });

    it('should resolve the deployment config file store bucket from ConfigService.getConfigurationBucket() and region from getRegion()', () => {
      const config = makeConfig('aws', 'my-config-bucket');
      expect(resolveDeploymentConfigFileStoreConfig(config, makeStore())).toEqual({
        bucket: 'my-config-bucket',
        region: 'us-east-1',
        credentials: undefined,
        credentialsSignature: 'none',
      });
    });

    it('should fall back to an empty bucket name when getConfigurationBucket() reports no bucket configured', () => {
      const config = makeConfig('aws', null);
      expect(resolveDeploymentConfigFileStoreConfig(config, makeStore())).toEqual({
        bucket: '',
        region: 'us-east-1',
        credentials: undefined,
        credentialsSignature: 'none',
      });
    });

    it('should produce an AwsDiscordEventReceiver from the aws discordReceiver factory', () => {
      const config = makeConfig('aws');
      const bindings = resolveCloudBindings(config);
      expect(bindings.discordReceiver(config)).toBeInstanceOf(AwsDiscordEventReceiver);
    });

    it('should produce an AwsAuditLogStore from the aws auditLogStore factory', () => {
      const config = makeConfig('aws');
      const bindings = resolveCloudBindings(config);
      expect(bindings.auditLogStore(config, makeStore())).toBeInstanceOf(AwsAuditLogStore);
    });

    it('should resolve the audit log store table from ConfigService.getStackOutputs().auditTableName and region from getRegion()', async () => {
      const config = makeConfig('aws', 'test-config-bucket', 'my-audit-table');
      await expect(resolveAuditLogStoreConfig(config, makeStore())).resolves.toEqual({
        tableName: 'my-audit-table',
        region: 'us-east-1',
        credentials: undefined,
        credentialsSignature: 'none',
      });
    });

    it('should fall back to an empty table name when getStackOutputs() reports no audit table name', async () => {
      const config: ConfigService = {
        ...makeConfig('aws'),
        getStackOutputs: async () => null,
      } as ConfigService;
      await expect(resolveAuditLogStoreConfig(config, makeStore())).resolves.toEqual({
        tableName: '',
        region: 'us-east-1',
        credentials: undefined,
        credentialsSignature: 'none',
      });
    });

    it('should prefer the deployed stack outputs awsRegion over getRegion() once a stack is deployed', async () => {
      const config = makeConfig('aws', 'test-config-bucket', 'my-audit-table', 'test-runs-table', 'eu-west-1');
      await expect(resolveAuditLogStoreConfig(config, makeStore())).resolves.toEqual({
        tableName: 'my-audit-table',
        region: 'eu-west-1',
        credentials: undefined,
        credentialsSignature: 'none',
      });
    });

    it('should fall back to getRegion() for the audit log store region when nothing is deployed yet', async () => {
      const config: ConfigService = {
        ...makeConfig('aws'),
        getStackOutputs: async () => null,
      } as ConfigService;
      await expect(resolveAuditLogStoreConfig(config, makeStore())).resolves.toEqual({
        tableName: '',
        region: 'us-east-1',
        credentials: undefined,
        credentialsSignature: 'none',
      });
    });

    it('should produce an AwsRunRecordStore from the aws runRecordStore factory', () => {
      const config = makeConfig('aws');
      const bindings = resolveCloudBindings(config);
      expect(bindings.runRecordStore(config, throwingRemoteFileStore, makeStore())).toBeInstanceOf(AwsRunRecordStore);
    });

    it('should resolve the run record store table from ConfigService.getStackOutputs().runsTableName, bucket from getConfigurationBucket(), and region from getRegion()', async () => {
      const config = makeConfig('aws', 'my-config-bucket', 'test-audit-table', 'my-runs-table');
      await expect(resolveRunRecordStoreConfig(config, throwingRemoteFileStore, makeStore())).resolves.toEqual({
        tableName: 'my-runs-table',
        bucket: 'my-config-bucket',
        region: 'us-east-1',
        credentials: undefined,
        credentialsSignature: 'none',
      });
    });

    it('should fall back to empty table/bucket names when getStackOutputs() and getConfigurationBucket() report nothing configured, and no DeploymentConfig is persisted yet either', async () => {
      const config: ConfigService = {
        ...makeConfig('aws', null),
        getStackOutputs: async () => null,
      } as ConfigService;
      await expect(resolveRunRecordStoreConfig(config, makeConfigRemoteFileStore(undefined), makeStore())).resolves.toEqual({
        tableName: '',
        bucket: '',
        region: 'us-east-1',
        credentials: undefined,
        credentialsSignature: 'none',
      });
    });

    it('should prefer the deployed stack outputs awsRegion over getRegion() once a stack is deployed', async () => {
      const config = makeConfig('aws', 'my-config-bucket', 'test-audit-table', 'my-runs-table', 'ap-southeast-2');
      await expect(resolveRunRecordStoreConfig(config, throwingRemoteFileStore, makeStore())).resolves.toEqual({
        tableName: 'my-runs-table',
        bucket: 'my-config-bucket',
        region: 'ap-southeast-2',
        credentials: undefined,
        credentialsSignature: 'none',
      });
    });

    describe('pre-apply runsTableName fallback (bootstrap-deadlock fix)', () => {
      it("should compute the deterministic runs table name from the persisted DeploymentConfig when getStackOutputs() has no runsTableName yet (no apply has ever run)", async () => {
        // Mirrors the exact deadlock scenario: a fresh install has bootstrapped
        // the runs table via `BootstrapService.ensureRunsTable` and has a
        // `DeploymentConfig` persisted (game servers configured), but has
        // never run a successful Pulumi apply — `getStackOutputs()` is `null`,
        // exactly like a never-deployed stack.
        const config: ConfigService = {
          ...makeConfig('aws', 'my-config-bucket'),
          getStackOutputs: async () => null,
        } as ConfigService;
        const remoteFileStore = makeConfigRemoteFileStore({ projectName: 'hyveon', runsTableName: '' });

        await expect(resolveRunRecordStoreConfig(config, remoteFileStore, makeStore())).resolves.toEqual({
          tableName: 'hyveon-runs',
          bucket: 'my-config-bucket',
          region: 'us-east-1',
          credentials: undefined,
          credentialsSignature: 'none',
        });
      });

      it('should resolve the configured runsTableName override from DeploymentConfig, not the project-prefixed default, in the pre-apply fallback', async () => {
        const config: ConfigService = {
          ...makeConfig('aws', 'my-config-bucket'),
          getStackOutputs: async () => null,
        } as ConfigService;
        const remoteFileStore = makeConfigRemoteFileStore({ projectName: 'hyveon', runsTableName: 'custom-runs-table' });

        await expect(resolveRunRecordStoreConfig(config, remoteFileStore, makeStore())).resolves.toEqual({
          tableName: 'custom-runs-table',
          bucket: 'my-config-bucket',
          region: 'us-east-1',
          credentials: undefined,
          credentialsSignature: 'none',
        });
      });

      it('should prefer getStackOutputs().runsTableName over the pre-apply fallback once a stack has actually been applied', async () => {
        const config = makeConfig('aws', 'my-config-bucket', 'test-audit-table', 'deployed-runs-table');
        // A remote file store whose DeploymentConfig would resolve to a
        // DIFFERENT name than the deployed stack reports — proving the
        // deployed value wins, not just that the fallback is reachable.
        const remoteFileStore = makeConfigRemoteFileStore({ projectName: 'stale-project', runsTableName: '' });

        await expect(resolveRunRecordStoreConfig(config, remoteFileStore, makeStore())).resolves.toEqual({
          tableName: 'deployed-runs-table',
          bucket: 'my-config-bucket',
          region: 'us-east-1',
          credentials: undefined,
          credentialsSignature: 'none',
        });
      });

      it('should fall back to an empty table name when no DeploymentConfig has been persisted yet either', async () => {
        const config: ConfigService = {
          ...makeConfig('aws', 'my-config-bucket'),
          getStackOutputs: async () => null,
        } as ConfigService;

        await expect(resolveRunRecordStoreConfig(config, makeConfigRemoteFileStore(undefined), makeStore())).resolves.toEqual({
          tableName: '',
          bucket: 'my-config-bucket',
          region: 'us-east-1',
          credentials: undefined,
          credentialsSignature: 'none',
        });
      });
    });
  });

  describe('fake-impl routing', () => {
    it('should route to a newly registered cloud binding instead of aws', () => {
      CLOUD_BINDINGS[FAKE_CLOUD] = FAKE_BINDINGS;
      const config = makeConfig(FAKE_CLOUD as ActiveCloud);

      const bindings = resolveCloudBindings(config);

      expect(bindings).toBe(FAKE_BINDINGS);
      expect(bindings.cloudProvider(config, makeStore())).toBeInstanceOf(FakeCloudProvider);
      expect(bindings.secretsStore(config, makeStore())).toBeInstanceOf(FakeSecretsStore);
      expect(bindings.remoteFileStore(config, makeStore())).toBeInstanceOf(FakeRemoteFileStore);
      expect(bindings.discordReceiver(config)).toBeInstanceOf(FakeDiscordEventReceiver);
      expect(bindings.auditLogStore(config, makeStore())).toBeInstanceOf(FakeAuditLogStore);
      expect(bindings.runRecordStore(config, throwingRemoteFileStore, makeStore())).toBeInstanceOf(FakeRunRecordStore);
    });

    it('should not resolve to the aws bindings once a fake cloud is registered', () => {
      CLOUD_BINDINGS[FAKE_CLOUD] = FAKE_BINDINGS;
      const config = makeConfig(FAKE_CLOUD as ActiveCloud);

      const bindings = resolveCloudBindings(config);

      expect(bindings).not.toBe(CLOUD_BINDINGS.aws);
      expect(bindings.cloudProvider(config, makeStore())).not.toBeInstanceOf(AwsCloudProvider);
    });
  });

  describe('unsupported cloud', () => {
    it('should throw when the active cloud has no registered bindings', () => {
      const config = makeConfig('does-not-exist' as ActiveCloud);
      expect(() => resolveCloudBindings(config)).toThrow('Unsupported cloud provider: does-not-exist');
    });
  });
});
