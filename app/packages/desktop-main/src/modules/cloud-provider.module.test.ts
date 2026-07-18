import 'reflect-metadata';
import { describe, it, expect, afterEach } from 'vitest';
import {
  AwsSecretsStore,
  AwsRemoteFileStore,
  AwsDiscordEventReceiver,
  AwsCloudProvider,
  AwsAuditLogStore,
} from '@hyveon/cloud-aws';
import type {
  CloudProvider,
  SecretsStore,
  RemoteFileStore,
  DiscordEventReceiver,
  AuditLogStore,
  StartOpts,
  WorkloadHandle,
  WorkloadStatus,
  LogChunk,
  CostBreakdown,
  DateRange,
  AuditEntry,
  AuditPageResult,
} from '@hyveon/shared';
import {
  CLOUD_BINDINGS,
  resolveCloudBindings,
  resolveTfvarsFileStoreConfig,
  resolveAuditLogStoreConfig,
  type CloudBindings,
} from './cloud-provider.module.js';
import type { ConfigService, ActiveCloud, TfOutputs } from '../services/ConfigService.js';

/**
 * Build a minimal `ConfigService` stub reporting the given cloud as active.
 * `resolveCloudBindings` only reads `getActiveCloud()`, so nothing else needs
 * to be stubbed. The cast lets tests exercise an unregistered/fake cloud
 * value without widening `ActiveCloud` itself.
 */
function makeConfig(
  activeCloud: ActiveCloud,
  tfvarsBucket: string | null = 'test-tfvars-bucket',
  auditTableName = 'test-audit-table',
): ConfigService {
  const stub: Partial<ConfigService> = {
    getActiveCloud: () => activeCloud,
    getRegion: () => 'us-east-1',
    getTfvarsBucket: () => tfvarsBucket,
    getTfOutputs: () => ({ audit_table_name: auditTableName } as TfOutputs),
  };
  return stub as ConfigService;
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
  getActualCosts(_range: DateRange): Promise<CostBreakdown> {
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

/** Registered `CLOUD_BINDINGS` key used to exercise the fake-cloud routing case. */
const FAKE_CLOUD = 'fake-test-cloud';

/** Bindings pointing at the hand-rolled fakes above, keyed under {@link FAKE_CLOUD}. */
const FAKE_BINDINGS: CloudBindings = {
  cloudProvider: () => new FakeCloudProvider(),
  secretsStore: () => new FakeSecretsStore(),
  remoteFileStore: () => new FakeRemoteFileStore(),
  discordReceiver: () => new FakeDiscordEventReceiver(),
  auditLogStore: () => new FakeAuditLogStore(),
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
      expect(bindings.cloudProvider(config)).toBeInstanceOf(AwsCloudProvider);
    });

    it('should produce an AwsSecretsStore from the aws secretsStore factory', () => {
      const config = makeConfig('aws');
      const bindings = resolveCloudBindings(config);
      expect(bindings.secretsStore(config)).toBeInstanceOf(AwsSecretsStore);
    });

    it('should produce an AwsRemoteFileStore from the aws remoteFileStore factory', () => {
      const config = makeConfig('aws');
      const bindings = resolveCloudBindings(config);
      expect(bindings.remoteFileStore(config)).toBeInstanceOf(AwsRemoteFileStore);
    });

    it('should resolve the tfvars file store bucket from ConfigService.getTfvarsBucket() and region from getRegion()', () => {
      const config = makeConfig('aws', 'my-tfvars-bucket');
      expect(resolveTfvarsFileStoreConfig(config)).toEqual({ bucket: 'my-tfvars-bucket', region: 'us-east-1' });
    });

    it('should fall back to an empty bucket name when getTfvarsBucket() reports no bucket configured', () => {
      const config = makeConfig('aws', null);
      expect(resolveTfvarsFileStoreConfig(config)).toEqual({ bucket: '', region: 'us-east-1' });
    });

    it('should produce an AwsDiscordEventReceiver from the aws discordReceiver factory', () => {
      const config = makeConfig('aws');
      const bindings = resolveCloudBindings(config);
      expect(bindings.discordReceiver(config)).toBeInstanceOf(AwsDiscordEventReceiver);
    });

    it('should produce an AwsAuditLogStore from the aws auditLogStore factory', () => {
      const config = makeConfig('aws');
      const bindings = resolveCloudBindings(config);
      expect(bindings.auditLogStore(config)).toBeInstanceOf(AwsAuditLogStore);
    });

    it('should resolve the audit log store table from ConfigService.getTfOutputs().audit_table_name and region from getRegion()', () => {
      const config = makeConfig('aws', 'test-tfvars-bucket', 'my-audit-table');
      expect(resolveAuditLogStoreConfig(config)).toEqual({ tableName: 'my-audit-table', region: 'us-east-1' });
    });

    it('should fall back to an empty table name when getTfOutputs() reports no audit table name', () => {
      const config: ConfigService = {
        ...makeConfig('aws'),
        getTfOutputs: () => null,
      } as ConfigService;
      expect(resolveAuditLogStoreConfig(config)).toEqual({ tableName: '', region: 'us-east-1' });
    });
  });

  describe('fake-impl routing', () => {
    it('should route to a newly registered cloud binding instead of aws', () => {
      CLOUD_BINDINGS[FAKE_CLOUD] = FAKE_BINDINGS;
      const config = makeConfig(FAKE_CLOUD as ActiveCloud);

      const bindings = resolveCloudBindings(config);

      expect(bindings).toBe(FAKE_BINDINGS);
      expect(bindings.cloudProvider(config)).toBeInstanceOf(FakeCloudProvider);
      expect(bindings.secretsStore(config)).toBeInstanceOf(FakeSecretsStore);
      expect(bindings.remoteFileStore(config)).toBeInstanceOf(FakeRemoteFileStore);
      expect(bindings.discordReceiver(config)).toBeInstanceOf(FakeDiscordEventReceiver);
      expect(bindings.auditLogStore(config)).toBeInstanceOf(FakeAuditLogStore);
    });

    it('should not resolve to the aws bindings once a fake cloud is registered', () => {
      CLOUD_BINDINGS[FAKE_CLOUD] = FAKE_BINDINGS;
      const config = makeConfig(FAKE_CLOUD as ActiveCloud);

      const bindings = resolveCloudBindings(config);

      expect(bindings).not.toBe(CLOUD_BINDINGS.aws);
      expect(bindings.cloudProvider(config)).not.toBeInstanceOf(AwsCloudProvider);
    });
  });

  describe('unsupported cloud', () => {
    it('should throw when the active cloud has no registered bindings', () => {
      const config = makeConfig('does-not-exist' as ActiveCloud);
      expect(() => resolveCloudBindings(config)).toThrow('Unsupported cloud provider: does-not-exist');
    });
  });
});
