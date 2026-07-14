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
 *
 * `addGameServer()`, `updateGameServer()`, and `removeGameServer()` (see
 * issue #96) are the write-side counterpart: they mutate the raw HCL text
 * directly via `hclSurgeon` (locate/cut/replace, byte-preserving outside the
 * touched entry) and `hclEmit` (serializing a `GameServer` back to HCL),
 * rather than going through the lossy `@cdktf/hcl2json` round-trip used for
 * reads. In S3 mode, the write is a conditional `RemoteFileStore.put()`
 * guarded by an `ifMatch` etag; a stale etag is translated from the store's
 * `RemoteFileConflictError` into a `OptimisticLockError` so callers only
 * ever need to handle one conflict type regardless of cloud provider. Local
 * mode writes the file directly with no conditional guard.
 */
import { Inject, Injectable } from '@nestjs/common';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';
import { parse as parseHcl } from '@cdktf/hcl2json';
import type { GameServer, RemoteFileStore } from '@hyveon/shared';
import { OptimisticLockError, RemoteFileConflictError } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { REMOTE_FILE_STORE } from '../modules/cloud-provider.tokens.js';
import { HclSurgeonError, cutEntry, locateEntry, locateMapBody, replaceEntry } from './hclSurgeon.js';
import { emitGameServerEntry } from './hclEmit.js';

/**
 * Raw JSON-decoded shape of a single `game_servers` map entry as produced by
 * `@cdktf/hcl2json`, before the map key is flattened onto it as `name`.
 * Structurally identical to `GameServer` minus the `name` field. Also doubles
 * as the write-side "config" parameter shape for {@link TfvarsService.addGameServer}
 * and {@link TfvarsService.updateGameServer}, since `name` is supplied
 * separately as the `game_servers` map key in both directions.
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
 * Extracts just the `{ ... }` object-literal portion of
 * `hclEmit.emitGameServerEntry()`'s output — dropping the leading
 * `<name> = ` prefix and the trailing newline — so it can be spliced in as
 * `hclSurgeon.replaceEntry()`'s `newValueHcl` argument, which replaces only
 * the value expression; the `<name> = ` prefix already present in the
 * source HCL is left untouched by `replaceEntry()` itself.
 */
function extractEntryValueHcl(entryAssignmentHcl: string): string {
  const braceStart = entryAssignmentHcl.indexOf('{');
  return entryAssignmentHcl.slice(braceStart).replace(/\n$/, '');
}

/**
 * Default indentation added when splicing a brand-new `game_servers` entry
 * into the map body and no sibling entry's own indentation is available to
 * copy — mirrors `hclEmit.ts`'s private `INDENT` unit (2 spaces) so a fresh
 * splice matches the file's established convention (see the fixtures under
 * `__fixtures__/*.tfvars` and `TfvarsService.write.test.ts`'s `FIXTURE_TFVARS`).
 */
const DEFAULT_ENTRY_INDENT = '  ';

/**
 * Matches a bare (unquoted) HCL identifier — the same shape `hclSurgeon.ts`'s
 * internal lexer (`findTopLevelIdentifier()` / `findEntryInBody()`) requires
 * for a `game_servers` map key to be recognized at all. `insertGameServerEntry()`
 * validates new entry names against this pattern *before* splicing them into
 * the map body: `locateEntry()`'s duplicate check can never match a name
 * containing characters outside this set (its own key-matching regex is the
 * same pattern), so an invalid name would otherwise sail past the "already
 * exists" guard and be written into the HCL verbatim — corrupting the file if
 * it contains structural characters like `{`, `}`, `=`, or a newline.
 */
const HCL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Prefixes every non-empty line of `hcl` with `indent`, re-nesting a
 * fragment that `hclEmit.emitGameServerEntry()` always emits anchored at
 * column 0 so it lines up once spliced one level deeper into the
 * `game_servers` map body (see issue #96 finding: unindented splices produced
 * `terraform fmt`-failing output). Empty lines (e.g. the trailing blank left
 * by splitting a string that ends in `\n`) are left alone so no trailing
 * whitespace is introduced. When `skipFirstLine` is set, the first line is
 * left untouched too — used when that line is spliced inline after an
 * existing `<key> = ` prefix that already sits at the target column, rather
 * than starting a new line of its own.
 */
function indentHclLines(hcl: string, indent: string, skipFirstLine = false): string {
  return hcl
    .split('\n')
    .map((line, i) => (line === '' || (skipFirstLine && i === 0) ? line : `${indent}${line}`))
    .join('\n');
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
   * Adds a brand-new entry to the `game_servers` map (see issue #96). Reads
   * the current raw HCL, splices `name = { ... }` in as the map's first
   * entry via `hclSurgeon.locateMapBody()` + `hclEmit.emitGameServerEntry()`,
   * and writes the result back via {@link writeTfvars} — see that method's
   * doc for the S3-mode conditional-put / `OptimisticLockError` contract.
   * Throws {@link HclSurgeonError} if `name` isn't a valid bare HCL
   * identifier, if `name` already exists in `game_servers`, or if the
   * `game_servers` map itself can't be located in the source HCL.
   *
   * @param name - The `game_servers` map key to add.
   * @param config - The new entry's fields (everything but `name`, which is
   *   the map key rather than an object attribute).
   * @param expectedVersionId - The etag last read (e.g. via {@link getRawHcl}),
   *   used as the S3-mode conditional-put guard; omit to write unconditionally.
   */
  async addGameServer(name: string, config: RawGameServerEntry, expectedVersionId?: string): Promise<void> {
    await this.writeTfvars(expectedVersionId, (hcl) => this.insertGameServerEntry(hcl, name, config));
  }

  /**
   * Replaces an existing `game_servers` entry's value in place (see issue
   * #96). Reads the current raw HCL, replaces `name`'s value via
   * `hclSurgeon.replaceEntry()` with a freshly-serialized
   * `hclEmit.emitGameServerEntry()` object literal — reindented to match
   * `name`'s own line in the source so the replacement's body/closing brace
   * land at the correct nesting depth rather than `emitGameServerEntry()`'s
   * native column-0 formatting — and writes the result back via
   * {@link writeTfvars} — see that method's doc for the S3-mode
   * conditional-put / `OptimisticLockError` contract. Throws
   * {@link HclSurgeonError} if `name` doesn't already exist in `game_servers`.
   *
   * @param name - The `game_servers` map key to update.
   * @param config - The entry's new fields (everything but `name`).
   * @param expectedVersionId - The etag last read (e.g. via {@link getRawHcl}),
   *   used as the S3-mode conditional-put guard; omit to write unconditionally.
   */
  async updateGameServer(name: string, config: RawGameServerEntry, expectedVersionId?: string): Promise<void> {
    await this.writeTfvars(expectedVersionId, (hcl) => this.replaceGameServerEntry(hcl, name, config));
  }

  /**
   * Removes an entry from the `game_servers` map (see issue #96). Reads the
   * current raw HCL, cuts `name`'s entire `key = value` assignment via
   * `hclSurgeon.cutEntry()`, and writes the result back via
   * {@link writeTfvars} — see that method's doc for the S3-mode
   * conditional-put / `OptimisticLockError` contract. Throws
   * {@link HclSurgeonError} if `name` doesn't exist in `game_servers`.
   *
   * @param name - The `game_servers` map key to remove.
   * @param expectedVersionId - The etag last read (e.g. via {@link getRawHcl}),
   *   used as the S3-mode conditional-put guard; omit to write unconditionally.
   */
  async removeGameServer(name: string, expectedVersionId?: string): Promise<void> {
    await this.writeTfvars(expectedVersionId, (hcl) => cutEntry(hcl, 'game_servers', name));
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
   * Shared write path for {@link addGameServer}, {@link updateGameServer},
   * and {@link removeGameServer}: reads the current raw HCL via
   * {@link fetchRawTfvars}, applies `mutate` to it, writes the mutated text
   * back via {@link putRawTfvars} (S3-mode conditional put / local-mode
   * direct write), and invalidates the in-memory `getGameServers()` cache so
   * the next read reflects the write. `mutate` running before the write
   * (rather than concurrently) keeps the S3-mode conditional-put guard
   * meaningful — `expectedVersionId` is checked against the store's
   * current etag at write time, so a conflicting write since `fetchRawTfvars`
   * ran is still caught even though `mutate` itself is synchronous.
   */
  private async writeTfvars(expectedVersionId: string | undefined, mutate: (hcl: string) => string): Promise<void> {
    const { hcl } = await this.fetchRawTfvars();
    const mutatedHcl = mutate(hcl);
    await this.putRawTfvars(mutatedHcl, expectedVersionId);
    this.invalidateCache();
  }

  /**
   * Writes `hcl` back to whichever tfvars source is active, mirroring
   * {@link fetchRawTfvars}'s local-vs-S3 source resolution. In S3 mode,
   * issues a conditional `RemoteFileStore.put()` — passing `expectedVersionId`
   * as `ifMatch` when provided — so a write that raced a concurrent change
   * since the caller's last read is rejected rather than silently
   * overwriting it; the store's cloud-agnostic `RemoteFileConflictError` is
   * caught and re-thrown as an {@link OptimisticLockError} (best-effort
   * populating `currentEtag` from a follow-up `get()`), so every conflict —
   * regardless of the underlying cloud provider — surfaces to callers
   * exclusively as `OptimisticLockError`. In local mode the file is written
   * directly with no conditional guard, since the local filesystem has no
   * etag/versioning concept to condition on (mirroring
   * {@link fetchRawTfvars}'s local-mode `etag`-less read).
   */
  private async putRawTfvars(hcl: string, expectedVersionId?: string): Promise<void> {
    const bucket = this.config.getTfvarsBucket();
    const path = this.config.getTfvarsPath();

    if (bucket) {
      const key = basename(path);
      const body = new TextEncoder().encode(hcl);
      try {
        await this.remoteFileStore.put(key, body, expectedVersionId ? { ifMatch: expectedVersionId } : undefined);
      } catch (err) {
        if (err instanceof RemoteFileConflictError) {
          const current = await this.remoteFileStore.get(key).catch(() => undefined);
          throw new OptimisticLockError(expectedVersionId ?? '', current?.etag);
        }
        throw err;
      }
      return;
    }

    writeFileSync(path, hcl, 'utf-8');
  }

  /**
   * Splices `name = { ... }` into `hcl`'s top-level `game_servers` map as
   * its first entry, via `hclSurgeon.locateMapBody()` (works even when the
   * map is currently empty, unlike `locateEntry()` which requires the key to
   * already exist) + `hclEmit.emitGameServerEntry()`. The emitted block is
   * reindented one level (via {@link indentHclLines}, using
   * {@link DEFAULT_ENTRY_INDENT}) since `emitGameServerEntry()` always
   * formats at column 0 — without this the new entry's key, body, and
   * closing brace would sit at the wrong depth once nested inside the map.
   * The separator between the new entry and whatever already follows
   * `bodyStart` is chosen so exactly one newline separates them — never
   * zero (which would jam the new entry's closing `}` against the map's own
   * `}` when `game_servers` is empty) and never two (which would leave a
   * stray blank line before an existing first entry). Throws
   * {@link HclSurgeonError} if `name` isn't a valid bare HCL identifier (see
   * {@link HCL_IDENTIFIER_PATTERN} — this must be checked *before* the
   * duplicate-key lookup below, since `locateEntry()` can never find an
   * existing entry whose key contains characters outside that pattern and
   * would otherwise let a structurally dangerous name through), if `name` is
   * already present in `game_servers` (use {@link updateGameServer} instead),
   * or if the `game_servers` map can't be located at all in the source HCL.
   */
  private insertGameServerEntry(hcl: string, name: string, config: RawGameServerEntry): string {
    if (!HCL_IDENTIFIER_PATTERN.test(name)) {
      throw new HclSurgeonError(
        `Entry name "${name}" is not a valid HCL identifier — must match ${HCL_IDENTIFIER_PATTERN}.`,
      );
    }

    if (locateEntry(hcl, 'game_servers', name)) {
      throw new HclSurgeonError(`Entry "${name}" already exists in "game_servers" — use updateGameServer() instead.`);
    }

    const mapBody = locateMapBody(hcl, 'game_servers');
    if (!mapBody) {
      throw new HclSurgeonError('Top-level "game_servers" map not found in terraform.tfvars.');
    }

    const entryHcl = indentHclLines(emitGameServerEntry({ name, ...config }), DEFAULT_ENTRY_INDENT).replace(/\n$/, '');
    const rest = hcl.slice(mapBody.bodyStart);
    const separator = /^[ \t]*\r?\n/.test(rest) ? '' : '\n';
    return hcl.slice(0, mapBody.bodyStart) + '\n' + entryHcl + separator + rest;
  }

  /**
   * Replaces `name`'s value inside `hcl`'s top-level `game_servers` map with
   * a freshly-serialized `hclEmit.emitGameServerEntry()` object literal,
   * reindented (via {@link indentHclLines}) to match the indentation of
   * `name`'s own line in the source — `emitGameServerEntry()` always formats
   * at column 0, so without this the replacement's body/closing brace would
   * land at the wrong depth even though its first line (the value's opening
   * `{`) is spliced inline after the existing `name = ` prefix and needs no
   * extra indentation of its own. Falls back to {@link DEFAULT_ENTRY_INDENT}
   * when `name` can't be located — `hclSurgeon.replaceEntry()` below is what
   * actually throws {@link HclSurgeonError} in that case, so the exact
   * fallback value here is never observed by callers.
   */
  private replaceGameServerEntry(hcl: string, name: string, config: RawGameServerEntry): string {
    const span = locateEntry(hcl, 'game_servers', name);
    const entryIndent = span ? /^[ \t]*/.exec(hcl.slice(span.start))![0] : DEFAULT_ENTRY_INDENT;
    const newValueHcl = indentHclLines(
      extractEntryValueHcl(emitGameServerEntry({ name, ...config })),
      entryIndent,
      /* skipFirstLine */ true,
    );
    return replaceEntry(hcl, 'game_servers', name, newValueHcl);
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
