/**
 * Reads and parses `terraform.tfvars` into the `GameServer[]` shape declared
 * by `@hyveon/shared/tfvars.js` (which mirrors `terraform/variables.tf`'s
 * `game_servers` map).
 *
 * Source resolution mirrors the local-vs-S3 tradeoff documented in
 * `docs/docs/guides/s3-tfvars.md`:
 *  - When `ConfigService.getTfvarsBucket()` resolves to a bucket name, the
 *    raw tfvars text is fetched from that bucket via the injected
 *    `RemoteFileStore` ("S3 mode").
 *  - Otherwise the local file at `ConfigService.getTfvarsPath()` is read
 *    directly ("local mode").
 *
 * The raw HCL text is converted to JSON via `@cdktf/hcl2json`'s `parse()`
 * (a WASM-backed port of Terraform's own HCL parser), then the `game_servers`
 * map is flattened into a `GameServer[]` with the map key attached as `name`.
 *
 * Parsed results are cached in-memory for `ConfigService.readEnvTfvarsCacheTtlMs()`
 * milliseconds so frequent callers (e.g. polling endpoints) don't re-parse the
 * file/re-fetch from S3 on every call. Call `invalidateCache()` to force a
 * fresh read before the TTL elapses (e.g. after a tfvars edit). The cache
 * mirrors `ConfigService.tfCache`'s tri-state approach: `undefined` means
 * "never loaded" (always a miss), while a set `CachedGameServers` entry
 * covers *both* a successful parse and a negatively-cached failed load (the
 * `failed` flag distinguishes the two) — either way the entry's `cachedAt`
 * governs the TTL, so a broken source isn't re-hit on every call within the
 * TTL window.
 *
 * `getGameServers()` never rejects — a missing file/object, a missing
 * `game_servers` key, or a malformed-HCL parse error are all logged via the
 * shared Winston `logger` and resolve to `[]`, mirroring `ConfigService`'s
 * graceful degradation for polling callers.
 */
import { Inject, Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { parse as parseHcl } from '@cdktf/hcl2json';
import type { GameServer, RemoteFileStore } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { REMOTE_FILE_STORE } from '../modules/cloud-provider.tokens.js';

/**
 * Raw JSON-decoded shape of a single `game_servers` map entry as produced by
 * `@cdktf/hcl2json`, before the map key is flattened onto it as `name`.
 * Structurally identical to `GameServer` minus the `name` field.
 */
type RawGameServerEntry = Omit<GameServer, 'name'>;

/**
 * In-memory cache entry: the resolved value (empty on failure), the
 * timestamp it was resolved at, and whether that resolution was a failure
 * (negatively cached) rather than a genuine successful parse.
 */
interface CachedGameServers {
  value: GameServer[];
  cachedAt: number;
  failed: boolean;
}

/**
 * Local-vs-S3 tfvars reader/parser — see the file-level doc comment above for
 * source resolution, parsing, and caching behaviour.
 */
@Injectable()
export class TfvarsService {
  private cache: CachedGameServers | null = null;

  /**
   * Monotonically incremented by {@link invalidateCache}. `getGameServers()`
   * snapshots this value before starting a fetch and only commits the result
   * to `this.cache` if the counter is unchanged when the fetch resolves —
   * this stops a late-resolving fetch that was already in flight when
   * `invalidateCache()` was called from resurrecting a stale, pre-invalidation
   * parse with a fresh `cachedAt` (which would otherwise serve stale data for
   * a full TTL window despite the explicit invalidation).
   */
  private cacheGeneration = 0;

  /**
   * `remoteFileStore` is typed against the cloud-agnostic `RemoteFileStore`
   * contract (not a concrete AWS class) so this service depends only on the
   * interface; `@Inject(REMOTE_FILE_STORE)` tells Nest which concrete
   * provider (bound by `CloudProviderModule` for whichever cloud is active)
   * to resolve for that parameter.
   */
  constructor(
    private readonly config: ConfigService,
    @Inject(REMOTE_FILE_STORE) private readonly remoteFileStore: RemoteFileStore,
  ) {}

  /**
   * Current time in milliseconds, extracted so tests can stub it via
   * `vi.spyOn` to simulate TTL expiry without real timers (mirrors
   * `ConfigService`'s protected `read*` accessors).
   */
  protected now(): number {
    return Date.now();
  }

  /**
   * Drop the in-memory cache so the next `getGameServers()` call re-reads
   * from disk/S3 instead of returning a stale parse. Called after a tfvars
   * write (e.g. via `scripts/tfvars-sync.ts pull`) and by tests between
   * scenarios.
   */
  invalidateCache(): void {
    this.cache = null;
    this.cacheGeneration += 1;
  }

  /**
   * Returns the `game_servers` map from `terraform.tfvars`, parsed into a
   * `GameServer[]` (the map key is flattened onto each entry as `name`).
   *
   * Returns a cached result when the last resolution (success *or* failure)
   * is younger than `ConfigService.readEnvTfvarsCacheTtlMs()`; otherwise
   * reads/parses fresh (see the class doc for local-vs-S3 source resolution)
   * and re-caches. Never rejects: a missing file/object, a missing
   * `game_servers` key, or a malformed-HCL parse error are logged and
   * resolved to `[]` (and negatively cached for the TTL window) rather than
   * thrown, so polling callers degrade gracefully instead of crashing.
   */
  async getGameServers(): Promise<GameServer[]> {
    const ttl = this.config.readEnvTfvarsCacheTtlMs();
    if (this.cache && this.now() - this.cache.cachedAt < ttl) {
      logger.debug('tfvars cache hit', { failed: this.cache.failed, cachedAt: this.cache.cachedAt });
      return this.cache.value;
    }

    logger.debug('tfvars cache miss — loading terraform.tfvars', {});

    const generation = this.cacheGeneration;

    try {
      const { hcl } = await this.fetchRawTfvars();
      const value = this.parseGameServers(await this.parseHclContents(hcl));
      if (generation === this.cacheGeneration) {
        this.cache = { value, cachedAt: this.now(), failed: false };
      }
      logger.info('Loaded terraform.tfvars game_servers', { count: value.length });
      return value;
    } catch (err) {
      logger.error('Failed to load terraform.tfvars game_servers — returning empty list', { err });
      if (generation === this.cacheGeneration) {
        this.cache = { value: [], cachedAt: this.now(), failed: true };
      }
      return [];
    }
  }

  /**
   * Returns the raw, unparsed `terraform.tfvars` HCL text plus a source
   * integrity marker: in S3 mode, the `RemoteFileStore.get()` etag (as
   * `etag`) — the same value `RemoteFileStore.put()` expects as its
   * `ifMatch` guard, so callers can round-trip a conditional write; in local
   * mode, `etag` is omitted since the local filesystem has no equivalent
   * concept. This is distinct from `RemoteFileStore.listVersions()`'s
   * `versionId`, which identifies a specific S3 object version rather than
   * an etag — the two are not comparable. Unlike {@link getGameServers},
   * this bypasses the in-memory cache and rejects (rather than swallowing) a
   * missing file/object — callers that need the raw text (e.g. an editor)
   * want to know immediately if the source is unreadable rather than
   * silently getting stale/empty data.
   */
  async getRawHcl(): Promise<{ hcl: string; etag?: string }> {
    return this.fetchRawTfvars();
  }

  /**
   * Reads the raw tfvars text, preferring the S3 backend
   * (`ConfigService.getTfvarsBucket()`) when configured, otherwise falling
   * back to the local file at `ConfigService.getTfvarsPath()`. Throws a clear
   * error when the source is configured but the file/object doesn't exist.
   * Shared by {@link getGameServers} (which catches and swallows the error)
   * and {@link getRawHcl} (which lets it propagate).
   */
  private async fetchRawTfvars(): Promise<{ hcl: string; etag?: string }> {
    const bucket = this.config.getTfvarsBucket();
    const path = this.config.getTfvarsPath();

    if (bucket) {
      const key = basename(path);
      const obj = await this.remoteFileStore.get(key);
      if (!obj) {
        throw new Error(`tfvars object "${key}" not found in S3 bucket "${bucket}".`);
      }
      return { hcl: new TextDecoder().decode(obj.body), etag: obj.etag };
    }

    if (!existsSync(path)) {
      throw new Error(`tfvars file not found at "${path}".`);
    }
    return { hcl: readFileSync(path, 'utf-8') };
  }

  /**
   * Converts raw HCL tfvars text to JSON via `@cdktf/hcl2json`. Wraps parse
   * failures (malformed HCL) in a clear, contextualized error rather than
   * letting the library's raw error surface directly.
   */
  private async parseHclContents(contents: string): Promise<Record<string, unknown>> {
    try {
      return await parseHcl('terraform.tfvars', contents);
    } catch (err) {
      logger.error('Failed to parse terraform.tfvars', { err });
      throw new Error(
        `Failed to parse terraform.tfvars: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Flattens the `game_servers` map (if present) from the JSON-decoded
   * tfvars payload into a `GameServer[]`. Returns `[]` (after logging a
   * warning) when the key is absent or not an object, e.g. an
   * empty/placeholder tfvars file.
   */
  private parseGameServers(parsed: Record<string, unknown>): GameServer[] {
    const gameServers = parsed['game_servers'];
    if (!gameServers || typeof gameServers !== 'object') {
      logger.warn('terraform.tfvars has no game_servers map', {});
      return [];
    }

    return Object.entries(gameServers as Record<string, RawGameServerEntry>).map(([name, entry]) => ({
      name,
      ...entry,
    }));
  }
}
