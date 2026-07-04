import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import { SECRET_PLACEHOLDER, type SecretsStore } from '@hyveon/shared';

/** Length of time a successfully-resolved secret is served from the
 * in-process cache before {@link AwsSecretsStore.get} re-fetches it. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** A single cached secret value plus the time at which it expires. */
interface SecretCacheEntry {
  value: string;
  expiresAt: number;
}

/**
 * AWS implementation of the cloud-agnostic {@link SecretsStore} contract,
 * backed by AWS Secrets Manager.
 *
 * `name` is passed straight through to Secrets Manager as `SecretId` — it
 * may be a secret name or ARN, matching `GetSecretValueCommand`/
 * `PutSecretValueCommand`'s own acceptance of either. No `@aws-sdk/*` shapes
 * appear outside this class's private fields/method bodies, so callers
 * depend only on {@link SecretsStore}.
 */
export class AwsSecretsStore implements SecretsStore {
  private client: SecretsManagerClient | null = null;
  private clientRegion: string | null = null;

  /**
   * Per-name cache of resolved secret values, populated by {@link get} and
   * invalidated by {@link put}. Keeps repeated reads (e.g. permission checks
   * on every Discord interaction) from hammering Secrets Manager.
   */
  private readonly cache = new Map<string, SecretCacheEntry>();

  /**
   * @param getRegion - Resolves the AWS region the Secrets Manager client
   *   should target, on every call. Falls back to `AWS_REGION_` (Lambda's
   *   reserved-name workaround, see CLAUDE.md), then `AWS_REGION`, then
   *   `AWS_DEFAULT_REGION`, then `us-east-1` when omitted. Mirrors
   *   `AwsCloudProvider`'s `getConfig` callback pattern so a region change
   *   picked up between calls rebuilds the client instead of being stuck
   *   with whatever region was resolved first.
   */
  constructor(private readonly getRegion?: () => string) {}

  /**
   * Lazily constructs the Secrets Manager client, recreating it whenever the
   * freshly-resolved region differs from the region the cached client was
   * built with — mirrors `AwsCloudProvider.getEcsClient`'s rebuild-on-region-
   * change pattern.
   */
  private getClient(): SecretsManagerClient {
    const region =
      this.getRegion?.() ??
      process.env['AWS_REGION_'] ??
      process.env['AWS_REGION'] ??
      process.env['AWS_DEFAULT_REGION'] ??
      'us-east-1';

    if (!this.client || this.clientRegion !== region) {
      this.client = new SecretsManagerClient({ region });
      this.clientRegion = region;
    }
    return this.client;
  }

  /**
   * Retrieves the value of a secret by name.
   *
   * Returns `undefined` (rather than throwing) when the secret doesn't
   * exist, its value is empty/whitespace-only, or it's still on the
   * Terraform-seeded {@link SECRET_PLACEHOLDER} — all three mean "not
   * configured" from the caller's perspective. Successful lookups are cached
   * for 5 minutes so repeated calls for the same name don't round-trip to
   * AWS.
   *
   * @param name - The name (identifier) of the secret to retrieve.
   */
  async get(name: string): Promise<string | undefined> {
    const now = Date.now();
    const hit = this.cache.get(name);
    if (hit && hit.expiresAt > now) return hit.value;

    let raw: string | undefined;
    try {
      const resp = await this.getClient().send(new GetSecretValueCommand({ SecretId: name }));
      raw = resp.SecretString;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }

    const value = raw?.trim();
    if (!value || value === SECRET_PLACEHOLDER) return undefined;

    this.cache.set(name, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  }

  /**
   * Stores a secret value under the given name, trimming surrounding
   * whitespace before writing and invalidating that name's cache entry so
   * the next {@link get} call re-fetches the freshly-written value instead
   * of serving a stale cached one.
   *
   * @param name  - The name (identifier) to store the secret under.
   * @param value - The plaintext value to store.
   */
  async put(name: string, value: string): Promise<void> {
    await this.getClient().send(
      new PutSecretValueCommand({ SecretId: name, SecretString: value.trim() }),
    );
    this.cache.delete(name);
  }

  /**
   * Checks whether a secret with the given name exists in the store.
   * Defined in terms of {@link get} so the two never disagree: a name
   * "exists" exactly when `get` would resolve it to a value.
   *
   * @param name - The name (identifier) to look up.
   */
  async exists(name: string): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }
}
