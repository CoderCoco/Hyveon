import { Module } from '@nestjs/common';
import {
  AwsSecretsStore,
  AwsRemoteFileStore,
  AwsDiscordEventReceiver,
  AwsAuditLogStore,
  AwsRunRecordStore,
} from '@hyveon/cloud-aws';
import { resolvePreApplyRunsTableName } from '@hyveon/shared';
import type {
  CloudProvider,
  SecretsStore,
  RemoteFileStore,
  DiscordEventReceiver,
  AuditLogStore,
  RunRecordStore,
} from '@hyveon/shared';
import { ConfigModule } from './config.module.js';
import { ElectronStoreModule } from './electron-store.module.js';
import { ConfigService } from '../services/ConfigService.js';
import { ElectronStoreService } from '../services/ElectronStoreService.js';
import { resolveAwsClientCredentialsWithSignature } from '../services/awsCredentialSource.js';
import type { AwsClientCredentials } from '../services/awsCredentialSource.js';
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
  cloudProvider: (config: ConfigService, store: ElectronStoreService) => CloudProvider;
  secretsStore: (config: ConfigService, store: ElectronStoreService) => SecretsStore;
  remoteFileStore: (config: ConfigService, store: ElectronStoreService) => RemoteFileStore;
  discordReceiver: (config: ConfigService) => DiscordEventReceiver;
  auditLogStore: (config: ConfigService, store: ElectronStoreService) => AuditLogStore;
  /**
   * Takes `remoteFileStore` as a second argument (unlike every other
   * `CloudBindings` factory) because {@link resolveRunRecordStoreConfig}'s
   * pre-apply fallback needs it to read the persisted `DeploymentConfig`
   * directly — see that function's own doc comment.
   */
  runRecordStore: (config: ConfigService, remoteFileStore: RemoteFileStore, store: ElectronStoreService) => RunRecordStore;
}

/**
 * Resolves the `{ bucket, region }` config the AWS `RemoteFileStore`'s
 * `getConfig` callback needs to target the configuration bucket: the bucket
 * comes from `ConfigService.getConfigurationBucket()` (falling back to `''`
 * — an empty bucket name — when no bucket is configured, so
 * `AwsRemoteFileStore` surfaces its own "bucket not configured" error rather
 * than this factory silently defaulting somewhere), and the region from
 * `getRegion()`. `credentials` comes from `resolveAwsClientCredentials(store)`
 * — omitting it left `AwsRemoteFileStore`'s `S3Client` falling back to the
 * SDK's default provider chain, which resolves nothing in a GUI-launched
 * Electron process. Exported as a standalone function (rather than inlined in
 * {@link CLOUD_BINDINGS}) so a unit test can exercise the resolution logic
 * directly without constructing an `@aws-sdk/client-s3`-backed store, which
 * `@hyveon/desktop-main` tests aren't permitted to import.
 */
export function resolveDeploymentConfigFileStoreConfig(
  config: ConfigService,
  store: ElectronStoreService,
): { bucket: string; region: string; credentials: AwsClientCredentials; credentialsSignature: string } {
  const { credentials, signature } = resolveAwsClientCredentialsWithSignature(store);
  return {
    bucket: config.getConfigurationBucket() ?? '',
    region: config.getRegion(),
    credentials,
    credentialsSignature: signature,
  };
}

/**
 * Resolves the `{ tableName, region }` config the AWS `AuditLogStore`'s
 * `getConfig` callback needs to target the audit DynamoDB table: the table
 * name comes from `ConfigService.getStackOutputs()`'s `auditTableName`
 * (falling back to `''` when nothing has been deployed yet, so
 * `AwsAuditLogStore` surfaces its own "table not configured" error rather
 * than this factory silently defaulting somewhere), and the region from the
 * SAME resolved `outputs.awsRegion` when a stack is deployed (falling back
 * to `getRegion()`'s wizard-configured value only when nothing is deployed
 * yet). Exported as a standalone function — see
 * {@link resolveDeploymentConfigFileStoreConfig} for why.
 *
 * Region source, revisited: `ConfigService.getRegion()` reads the
 * wizard-configured `aws.region` rather than the deployed stack's own
 * `awsRegion` output (see that method's doc comment for why it can't
 * synchronously read stack outputs). But this function is already async and
 * already resolves `outputs` — so once a stack IS deployed, preferring
 * `outputs.awsRegion` here restores the old self-correcting behavior
 * (`DeploymentConfig.awsRegion`, operator-edited, is the value actually
 * provisioned into; nothing enforces it staying in sync with the wizard's
 * credentials-step region) for these DynamoDB clients specifically, at zero
 * extra cost.
 *
 * Async because `getStackOutputs()` is an async read. This is not a
 * DI-factory async hazard: `CLOUD_BINDINGS.aws.auditLogStore` below passes
 * `() => resolveAuditLogStoreConfig(config)` as `AwsAuditLogStore`'s lazy
 * `getConfig` closure, not as something the (synchronous) `useFactory`
 * provider below awaits itself; the closure is only ever invoked later, from
 * inside `AwsAuditLogStore`'s own already-`async` methods, where awaiting a
 * `Promise`-returning closure costs nothing extra. See `AwsAuditLogStore`'s
 * constructor doc comment for the same reasoning spelled out at the
 * consumer end.
 *
 * `credentials` comes from `resolveAwsClientCredentials(store)` — see
 * {@link resolveDeploymentConfigFileStoreConfig}'s doc comment for why this
 * field is required.
 */
export async function resolveAuditLogStoreConfig(
  config: ConfigService,
  store: ElectronStoreService,
): Promise<{ tableName: string; region: string; credentials: AwsClientCredentials; credentialsSignature: string }> {
  const outputs = await config.getStackOutputs();
  const { credentials, signature } = resolveAwsClientCredentialsWithSignature(store);
  return {
    tableName: outputs?.auditTableName ?? '',
    region: outputs?.awsRegion ?? config.getRegion(),
    credentials,
    credentialsSignature: signature,
  };
}

/**
 * Resolves the `{ tableName, bucket, region }` config the AWS `RunRecordStore`'s
 * `getConfig` callback needs to target the runs DynamoDB table and the
 * configuration S3 bucket used for offloaded run logs: the bucket from
 * `ConfigService.getConfigurationBucket()` (falling back to `''` when no
 * bucket is configured), the region from the same resolved
 * `outputs.awsRegion` when a stack is deployed (falling back to
 * `getRegion()`'s wizard-configured value otherwise), and the table name from
 * `ConfigService.getStackOutputs()`'s `runsTableName` — falling back, when
 * that's empty, to `resolvePreApplyRunsTableName(remoteFileStore)`
 * (`@hyveon/shared`), which reads the persisted `DeploymentConfig` directly
 * to compute the table's deterministic name without ever touching Pulumi.
 *
 * This fallback is the fix for a Critical bootstrap deadlock (see
 * `BootstrapService.ensureRunsTable`'s own doc for the full story):
 * `getStackOutputs()` only reports a value after a stack's first successful
 * `apply`, but the runs table is now created via the AWS SDK at
 * wizard-bootstrap time, before any apply has ever run — without this
 * fallback, `AwsRunRecordStore` would resolve an empty table name and throw
 * "not configured" on every plan/apply of a fresh install, even though the
 * table itself already exists. Only reached when `outputs?.runsTableName` is
 * falsy (short-circuited by `||` otherwise), so a deployed stack's report is
 * always preferred and this never costs an extra read once one exists.
 *
 * `remoteFileStore` is a second parameter (not resolved via `config`, unlike
 * every other field here) because it must be the SAME `RemoteFileStore`
 * singleton the caller already has bound to the configuration bucket — see
 * `CloudProviderModule`'s `RUN_RECORD_STORE` provider, which injects
 * `REMOTE_FILE_STORE` alongside `ConfigService` for exactly this purpose (an
 * intra-module provider dependency, not a new module `imports:` edge — both
 * tokens are already provided by this same module).
 *
 * Exported as a standalone function — see {@link resolveDeploymentConfigFileStoreConfig}
 * for why. Async for the same reason, and with the same "not a DI-factory
 * hazard" and "prefer `outputs.awsRegion` once deployed" reasoning, as
 * {@link resolveAuditLogStoreConfig} — see its doc comment. `credentials`
 * comes from `resolveAwsClientCredentials(store)` for the same reason too.
 */
export async function resolveRunRecordStoreConfig(
  config: ConfigService,
  remoteFileStore: RemoteFileStore,
  store: ElectronStoreService,
): Promise<{
  tableName: string;
  bucket: string;
  region: string;
  credentials: AwsClientCredentials;
  credentialsSignature: string;
}> {
  const outputs = await config.getStackOutputs();
  const tableName = outputs?.runsTableName || (await resolvePreApplyRunsTableName(remoteFileStore));
  const { credentials, signature } = resolveAwsClientCredentialsWithSignature(store);
  return {
    tableName: tableName ?? '',
    bucket: config.getConfigurationBucket() ?? '',
    region: outputs?.awsRegion ?? config.getRegion(),
    credentials,
    credentialsSignature: signature,
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
    cloudProvider: (config, store) => createAwsCloudProvider(config, store),
    secretsStore: (config, store) =>
      new AwsSecretsStore(
        () => config.getRegion(),
        () => resolveAwsClientCredentialsWithSignature(store).credentials,
        () => resolveAwsClientCredentialsWithSignature(store).signature,
      ),
    remoteFileStore: (config, store) =>
      new AwsRemoteFileStore(() => resolveDeploymentConfigFileStoreConfig(config, store)),
    discordReceiver: () => new AwsDiscordEventReceiver(),
    auditLogStore: (config, store) => new AwsAuditLogStore(() => resolveAuditLogStoreConfig(config, store)),
    runRecordStore: (config, remoteFileStore, store) =>
      new AwsRunRecordStore(() => resolveRunRecordStoreConfig(config, remoteFileStore, store)),
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
 *
 * `PulumiService.preview` resolves `REMOTE_FILE_STORE` from this module
 * lazily via a `ModuleRef.get()` strict-false lookup rather than a
 * constructor dependency: a static `imports:` edge from `PulumiServiceModule`
 * back to this module (reachable from `ConfigModule`, which imports
 * `PulumiServiceModule`) would deadlock the module graph even with every
 * cycle edge `forwardRef()`-wrapped (see `run-record.module.ts`'s doc
 * comment). This module's own `ConfigModule` import therefore stays the
 * plain, non-circular import it always was.
 */
@Module({
  imports: [ConfigModule, ElectronStoreModule],
  providers: [
    {
      provide: CLOUD_PROVIDER,
      useFactory: (config: ConfigService, store: ElectronStoreService) =>
        resolveCloudBindings(config).cloudProvider(config, store),
      inject: [ConfigService, ElectronStoreService],
    },
    {
      provide: SECRETS_STORE,
      useFactory: (config: ConfigService, store: ElectronStoreService) =>
        resolveCloudBindings(config).secretsStore(config, store),
      inject: [ConfigService, ElectronStoreService],
    },
    {
      provide: REMOTE_FILE_STORE,
      useFactory: (config: ConfigService, store: ElectronStoreService) =>
        resolveCloudBindings(config).remoteFileStore(config, store),
      inject: [ConfigService, ElectronStoreService],
    },
    {
      provide: DISCORD_RECEIVER,
      useFactory: (config: ConfigService) => resolveCloudBindings(config).discordReceiver(config),
      inject: [ConfigService],
    },
    {
      provide: AUDIT_LOG_STORE,
      useFactory: (config: ConfigService, store: ElectronStoreService) =>
        resolveCloudBindings(config).auditLogStore(config, store),
      inject: [ConfigService, ElectronStoreService],
    },
    {
      provide: RUN_RECORD_STORE,
      // Injects `REMOTE_FILE_STORE` too (an intra-module provider dependency
      // — both tokens are declared in THIS module's own `providers:`, so
      // this needs no `imports:` edge) for `resolveRunRecordStoreConfig`'s
      // pre-apply table-name fallback — see that function's own doc comment.
      useFactory: (config: ConfigService, remoteFileStore: RemoteFileStore, store: ElectronStoreService) =>
        resolveCloudBindings(config).runRecordStore(config, remoteFileStore, store),
      inject: [ConfigService, REMOTE_FILE_STORE, ElectronStoreService],
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
