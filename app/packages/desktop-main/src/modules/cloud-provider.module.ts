import { Module } from '@nestjs/common';
import { AwsSecretsStore, AwsRemoteFileStore, AwsDiscordEventReceiver } from '@hyveon/cloud-aws';
import type { CloudProvider, SecretsStore, RemoteFileStore, DiscordEventReceiver } from '@hyveon/shared';
import { ConfigModule } from './config.module.js';
import { ConfigService } from '../services/ConfigService.js';
import { createAwsCloudProvider } from '../services/EcsService.js';
import {
  CLOUD_PROVIDER,
  SECRETS_STORE,
  REMOTE_FILE_STORE,
  DISCORD_RECEIVER,
} from './cloud-provider.tokens.js';

/**
 * Per-cloud factories for the four cloud-agnostic contracts (`CloudProvider`,
 * `SecretsStore`, `RemoteFileStore`, `DiscordEventReceiver` — all from
 * `@hyveon/shared/cloud.js`). Keyed by the `ActiveCloud` value `ConfigService`
 * reports; each `CloudBindings` entry supplies one factory per token so
 * {@link resolveCloudBindings} (and, in turn, `CloudProviderModule`'s
 * `useFactory` providers) can look up the right implementation without
 * duplicating the cloud switch four times.
 */
export interface CloudBindings {
  cloudProvider: (config: ConfigService) => CloudProvider;
  secretsStore: (config: ConfigService) => SecretsStore;
  remoteFileStore: (config: ConfigService) => RemoteFileStore;
  discordReceiver: (config: ConfigService) => DiscordEventReceiver;
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
    remoteFileStore: () => new AwsRemoteFileStore(),
    discordReceiver: () => new AwsDiscordEventReceiver(),
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
 * Binds the four cloud-agnostic contracts to concrete implementations for
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
  ],
  exports: [CLOUD_PROVIDER, SECRETS_STORE, REMOTE_FILE_STORE, DISCORD_RECEIVER],
})
export class CloudProviderModule {}
