import { Module } from '@nestjs/common';
import {
  AwsSecretsStore,
  AwsRemoteFileStore,
  AwsDiscordEventReceiver,
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
} from '@hyveon/shared';
import { ConfigModule } from './config.module.js';
import { ConfigService } from '../services/ConfigService.js';
import { createAwsCloudProvider } from '../services/EcsService.js';
import {
  CLOUD_PROVIDER,
  SECRETS_STORE,
  REMOTE_FILE_STORE,
  DISCORD_RECEIVER,
  AUDIT_LOG_STORE,
  RUN_RECORD_STORE,
} from './cloud-provider.tokens.js';

/**
 * Per-cloud factories for the six cloud-agnostic contracts (`CloudProvider`,
 * `SecretsStore`, `RemoteFileStore`, `DiscordEventReceiver`, `AuditLogStore`,
 * `RunRecordStore` — all from `@hyveon/shared/cloud.js`). Keyed by the
 * `ActiveCloud` value `ConfigService` reports; each `CloudBindings` entry
 * supplies one factory per token so {@link resolveCloudBindings} (and, in
 * turn, `CloudProviderModule`'s `useFactory` providers) can look up the right
 * implementation without duplicating the cloud switch six times.
 */
export interface CloudBindings {
  cloudProvider: (config: ConfigService) => CloudProvider;
  secretsStore: (config: ConfigService) => SecretsStore;
  remoteFileStore: (config: ConfigService) => RemoteFileStore;
  discordReceiver: (config: ConfigService) => DiscordEventReceiver;
  auditLogStore: (config: ConfigService) => AuditLogStore;
  runRecordStore: (config: ConfigService) => RunRecordStore;
}

/**
 * Resolves the `{ bucket, region }` config the AWS `RemoteFileStore`'s
 * `getConfig` callback needs to target the tfvars bucket: the bucket comes
 * from `ConfigService.getTfvarsBucket()` (falling back to `''` — an empty
 * bucket name — when tfvars sync isn't configured, so `AwsRemoteFileStore`
 * surfaces its own "bucket not configured" error rather than this factory
 * silently defaulting somewhere), and the region from `getRegion()`.
 * Exported as a standalone function (rather than inlined in
 * {@link CLOUD_BINDINGS}) so a unit test can exercise the resolution logic
 * directly without constructing an `@aws-sdk/client-s3`-backed store, which
 * `@hyveon/desktop-main` tests aren't permitted to import.
 */
export function resolveTfvarsFileStoreConfig(config: ConfigService): { bucket: string; region: string } {
  return { bucket: config.getTfvarsBucket() ?? '', region: config.getRegion() };
}

/**
 * Resolves the `{ tableName, region }` config the AWS `AuditLogStore`'s
 * `getConfig` callback needs to target the audit DynamoDB table: the table
 * name comes from `ConfigService.getTfOutputs()?.audit_table_name` (falling
 * back to `''` when the tfstate hasn't been applied yet, so `AwsAuditLogStore`
 * surfaces its own "table not configured" error rather than this factory
 * silently defaulting somewhere), and the region from `getRegion()`. Exported
 * as a standalone function — see {@link resolveTfvarsFileStoreConfig} for why.
 */
export function resolveAuditLogStoreConfig(config: ConfigService): { tableName: string; region: string } {
  return { tableName: config.getTfOutputs()?.audit_table_name ?? '', region: config.getRegion() };
}

/**
 * Resolves the `{ tableName, bucket, region }` config the AWS `RunRecordStore`'s
 * `getConfig` callback needs to target the runs DynamoDB table and the tfvars
 * S3 bucket used for offloaded run logs: the table name comes from
 * `ConfigService.getTfOutputs()?.runs_table_name` (falling back to `''` when
 * the tfstate hasn't been applied yet), the bucket from
 * `ConfigService.getTfvarsBucket()` (falling back to `''` when tfvars sync
 * isn't configured), and the region from `getRegion()` — so `AwsRunRecordStore`
 * surfaces its own "not configured" errors rather than this factory silently
 * defaulting somewhere. Exported as a standalone function — see
 * {@link resolveTfvarsFileStoreConfig} for why.
 */
export function resolveRunRecordStoreConfig(
  config: ConfigService,
): { tableName: string; bucket: string; region: string } {
  return {
    tableName: config.getTfOutputs()?.runs_table_name ?? '',
    bucket: config.getTfvarsBucket() ?? '',
    region: config.getRegion(),
  };
}

/**
 * Registry of per-cloud bindings, keyed by `ActiveCloud` (or any future cloud
 * string). Today only `'aws'` is populated; adding a new cloud provider
 * package means adding an entry here rather than touching the module's
 * provider definitions. This is the seam a unit test can exercise directly
 * (via {@link resolveCloudBindings}) without bootstrapping Nest.
 */
export const CLOUD_BINDINGS: Record<string, CloudBindings> = {
  aws: {
    cloudProvider: (config) => createAwsCloudProvider(config),
    secretsStore: (config) => new AwsSecretsStore(() => config.getRegion()),
    remoteFileStore: (config) => new AwsRemoteFileStore(() => resolveTfvarsFileStoreConfig(config)),
    discordReceiver: () => new AwsDiscordEventReceiver(),
    auditLogStore: (config) => new AwsAuditLogStore(() => resolveAuditLogStoreConfig(config)),
    runRecordStore: (config) => new AwsRunRecordStore(() => resolveRunRecordStoreConfig(config)),
  },
};

/**
 * Pure resolver mapping `config.getActiveCloud()` to its {@link CloudBindings}
 * entry in {@link CLOUD_BINDINGS}, throwing for any cloud with no registered
 * bindings. Exported (rather than inlined per-factory) so it can be called
 * directly from tests without going through Nest's DI container.
 */
export function resolveCloudBindings(config: ConfigService): CloudBindings {
  const activeCloud = config.getActiveCloud();
  const bindings = CLOUD_BINDINGS[activeCloud];
  if (!bindings) {
    throw new Error(`Unsupported cloud provider: ${String(activeCloud)}`);
  }
  return bindings;
}

/**
 * Binds the six cloud-agnostic contracts to concrete implementations for
 * whichever cloud `ConfigService.getActiveCloud()` reports as active, via
 * {@link resolveCloudBindings} and the {@link CLOUD_BINDINGS} registry. Today
 * that's always `'aws'`, so every token resolves to a `@hyveon/cloud-aws`
 * class; adding a non-AWS provider means adding an entry to `CLOUD_BINDINGS`,
 * not editing this module.
 *
 * Consuming services should inject via the token (e.g. `@Inject(CLOUD_PROVIDER)`)
 * and depend only on the corresponding `@hyveon/shared` interface, never on the
 * concrete AWS class — that's what keeps swapping the active cloud a one-module
 * change instead of a call-site hunt.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: CLOUD_PROVIDER,
      useFactory: (config: ConfigService) => resolveCloudBindings(config).cloudProvider(config),
      inject: [ConfigService],
    },
    {
      provide: SECRETS_STORE,
      useFactory: (config: ConfigService) => resolveCloudBindings(config).secretsStore(config),
      inject: [ConfigService],
    },
    {
      provide: REMOTE_FILE_STORE,
      useFactory: (config: ConfigService) => resolveCloudBindings(config).remoteFileStore(config),
      inject: [ConfigService],
    },
    {
      provide: DISCORD_RECEIVER,
      useFactory: (config: ConfigService) => resolveCloudBindings(config).discordReceiver(config),
      inject: [ConfigService],
    },
    {
      provide: AUDIT_LOG_STORE,
      useFactory: (config: ConfigService) => resolveCloudBindings(config).auditLogStore(config),
      inject: [ConfigService],
    },
    {
      provide: RUN_RECORD_STORE,
      useFactory: (config: ConfigService) => resolveCloudBindings(config).runRecordStore(config),
      inject: [ConfigService],
    },
  ],
  exports: [
    CLOUD_PROVIDER,
    SECRETS_STORE,
    REMOTE_FILE_STORE,
    DISCORD_RECEIVER,
    AUDIT_LOG_STORE,
    RUN_RECORD_STORE,
  ],
})
export class CloudProviderModule {}
