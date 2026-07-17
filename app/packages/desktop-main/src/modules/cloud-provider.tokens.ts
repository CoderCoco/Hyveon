/**
 * Nest DI injection tokens for the cloud-agnostic provider contracts defined
 * in `@hyveon/shared/cloud.js`. `CloudProviderModule` binds each token to a
 * concrete implementation (e.g. from `@hyveon/cloud-aws`) via a `useFactory`
 * provider driven off `ConfigService.getActiveCloud()`. Consuming services
 * depend only on the token + the cloud-agnostic interface, so swapping the
 * active cloud routes to a different provider package without touching
 * call sites.
 */

/** Injection token for the `CloudProvider` implementation bound by `CloudProviderModule`. */
export const CLOUD_PROVIDER = Symbol('CLOUD_PROVIDER');

/** Injection token for the `SecretsStore` implementation bound by `CloudProviderModule`. */
export const SECRETS_STORE = Symbol('SECRETS_STORE');

/** Injection token for the `RemoteFileStore` implementation bound by `CloudProviderModule`. */
export const REMOTE_FILE_STORE = Symbol('REMOTE_FILE_STORE');

/** Injection token for the `DiscordEventReceiver` implementation bound by `CloudProviderModule`. */
export const DISCORD_RECEIVER = Symbol('DISCORD_RECEIVER');

/** Injection token for the `AuditLogStore` implementation bound by `CloudProviderModule`. */
export const AUDIT_LOG_STORE = Symbol('AUDIT_LOG_STORE');
