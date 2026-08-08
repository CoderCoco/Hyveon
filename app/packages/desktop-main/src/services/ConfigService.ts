import { Injectable } from '@nestjs/common';
import type { StackOutputs } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { PulumiService } from './PulumiService.js';

/**
 * Default in-memory cache TTL (milliseconds) `DeploymentConfigService` uses for the
 * parsed configuration payload when `CONFIG_CACHE_TTL_MS` is unset or invalid.
 */
const DEFAULT_CONFIG_CACHE_TTL_MS = 30000;

/**
 * Identifier for the cloud provider the app is currently driving. A union
 * type (rather than a bare string) so additional providers can be added
 * without widening every consumer's type to `string`.
 */
export type ActiveCloud = 'aws';

/**
 * Owns every runtime configuration source the management app reads:
 *  - The deployed Pulumi stack's outputs — read via {@link getStackOutputs},
 *    a memoised delegate to {@link PulumiService.getStackOutputs}. Outputs
 *    are always fetched live via the SDK, never from a local state file.
 *  - A handful of process env vars (`AWS_DEFAULT_REGION`).
 *
 * Every other service injects this one instead of touching `process.env`
 * directly, so tests can stub env access cleanly.
 *
 * The watchdog tuning knobs this class used to read/write via a local
 * `server_config.json` were removed (#348): the deployed watchdog Lambda
 * never read that file — its real tunables come from `DeploymentConfig`
 * (see `app/packages/infra/src/lambdas.ts`), edited through
 * `DeploymentSettingsForm` instead.
 */
@Injectable()
export class ConfigService {
  /**
   * `electronStore` is the source of truth for the configured configuration
   * bucket name (`bootstrap.configurationBucket`, written by the First-Run
   * Wizard's bootstrap step — see {@link getConfigurationBucket}) and the
   * wizard-configured AWS region (`aws.region`), which {@link getRegion}
   * reads directly rather than through a deployed stack's outputs (see
   * that method's doc comment for why). `pulumiService` backs
   * {@link getStackOutputs} — see that method's doc comment for why the read
   * is exposed here rather than requiring every caller to depend on
   * `PulumiService` directly.
   */
  constructor(
    private readonly electronStore: ElectronStoreService,
    private readonly pulumiService: PulumiService,
  ) {}

  /**
   * Memoised {@link getStackOutputs} result. Several callers (e.g.
   * `DiscordConfigService.getRedacted()`) read more than one field off "the
   * deployed config" across more than one call into this class, and
   * `getOrCreateStack()` + `stack.outputs()` is an expensive round-trip
   * (engine resolution, passphrase, S3 backend) to pay twice. Stores the
   * in-flight/settled `Promise` itself (not just its resolved value) so
   * concurrent callers during the first read coalesce onto the same request.
   * A *rejected* promise is deliberately NOT cached (see
   * {@link getStackOutputs}) — only a settled `null` ("not deployed") or a
   * real {@link StackOutputs} value are memoised.
   *
   * **Why a settled `null` still needs its own bounded TTL, not indefinite
   * caching:** `PulumiService.getStackOutputs()` degrades EVERY failure to a
   * resolved `null` — a transient S3 blip, an expired credential, a
   * keychain hiccup all look identical to "genuinely not deployed" from
   * here. Caching it indefinitely would let one transient blip wedge the
   * dashboard on "not deployed" forever, especially since the hot poll paths
   * (`GamesController.listGames`/`listStatus`, `DriftService.getDrift`) do
   * not call {@link invalidateCache} on every tick. See
   * {@link STACK_OUTPUTS_NULL_TTL_MS} and {@link getStackOutputs} for the
   * TTL mechanics. A resolved {@link StackOutputs} value has no such
   * problem — a successful read really did observe a deployed stack — so it
   * stays cached with no TTL, cleared only by an explicit
   * {@link invalidateCache} call.
   */
  private stackOutputsCache: Promise<StackOutputs | null> | undefined;

  /** `true` when {@link stackOutputsCache} last settled to `null` — read by {@link getStackOutputs} to decide whether {@link STACK_OUTPUTS_NULL_TTL_MS} applies. */
  private stackOutputsCacheIsNull = false;

  /** `Date.now()` at the moment {@link stackOutputsCache} last settled to `null` — the TTL clock {@link getStackOutputs} checks against {@link STACK_OUTPUTS_NULL_TTL_MS}. Meaningless while {@link stackOutputsCacheIsNull} is `false`. */
  private stackOutputsNullCachedAt = 0;

  /**
   * How long a resolved `null` from {@link getStackOutputs} stays cached
   * before the next call re-checks, rather than serving the stale `null`
   * indefinitely — see {@link stackOutputsCache}'s doc comment for why this
   * exists. 20 seconds: short enough that a transient failure self-heals
   * within roughly one dashboard status-poll cycle
   * (`GAME_STATUS_INTERVAL_MS`, `@hyveon/web`), long enough that it doesn't
   * reintroduce the "expensive round-trip on every poll tick" cost the
   * removal of eager `invalidateCache()` calls on the hot paths was meant to
   * avoid. Deliberately asymmetric with a genuine {@link StackOutputs}
   * value, which has no TTL at all (see that field's doc comment) — a
   * deployed stack doesn't need frequent re-verification, but a "not
   * deployed" reading (which may just be "the last check happened to fail")
   * should keep retrying.
   */
  private static readonly STACK_OUTPUTS_NULL_TTL_MS = 20_000;

  /**
   * Drop the cached {@link getStackOutputs} result. Called from the
   * `/api/games` and `/api/status` handlers so a fresh deploy is picked up
   * without a server restart; tests also call it between scenarios.
   */
  invalidateCache(): void {
    this.stackOutputsCache = undefined;
    this.stackOutputsCacheIsNull = false;
  }

  /**
   * Reads every value the app cares about off the deployed Pulumi stack,
   * fetched live via the SDK rather than from a local state file.
   *
   * A memoised delegate to {@link PulumiService.getStackOutputs} — see that
   * method's doc comment for the full "never deployed yet degrades to
   * `null`, never throws, period" contract and how it's implemented. Exposed
   * here rather than requiring every caller to take a `PulumiService`
   * constructor dependency directly, mirroring how `ConfigService`
   * re-exposes `ElectronStoreService.get('bootstrap')?.configurationBucket`
   * as {@link getConfigurationBucket} instead of making every
   * configuration-bucket reader depend on `ElectronStoreService` directly.
   *
   * Cached via {@link stackOutputsCache} — see that field's doc comment for
   * the coalescing behavior and for why a resolved `null` additionally
   * expires after {@link STACK_OUTPUTS_NULL_TTL_MS} rather than staying
   * cached forever. Cleared unconditionally (both the value and the
   * null-TTL clock) by {@link invalidateCache}.
   */
  async getStackOutputs(): Promise<StackOutputs | null> {
    const cacheIsStale =
      this.stackOutputsCacheIsNull &&
      Date.now() - this.stackOutputsNullCachedAt >= ConfigService.STACK_OUTPUTS_NULL_TTL_MS;

    if (this.stackOutputsCache === undefined || cacheIsStale) {
      logger.debug('ConfigService.getStackOutputs: cache miss — fetching stack outputs from PulumiService');
      // Clear the stale-null flag BEFORE kicking off the refetch (not just
      // after it settles): otherwise a second concurrent call arriving while
      // this refetch is still in flight would see `stackOutputsCacheIsNull`
      // still `true` with its old (expired) timestamp, compute `cacheIsStale`
      // as `true` again, and kick off a REDUNDANT second refetch instead of
      // coalescing onto this one — defeating the whole point of caching the
      // in-flight promise. The `.then()` below sets it back to the real
      // value once this refetch actually settles.
      this.stackOutputsCacheIsNull = false;
      const pending = this.pulumiService.getStackOutputs().then(
        (result) => {
          this.stackOutputsCacheIsNull = result === null;
          this.stackOutputsNullCachedAt = Date.now();
          return result;
        },
        (err: unknown) => {
          // Don't let a transient failure wedge every subsequent call behind
          // a cached rejection — only a settled `null`/`StackOutputs` value
          // is worth memoising. (In practice `PulumiService.getStackOutputs()`
          // itself never rejects — see its own doc comment — so this branch
          // is defensive: it still holds if a future change to that
          // contract, or a bug, ever lets a rejection through here.)
          if (this.stackOutputsCache === pending) {
            this.stackOutputsCache = undefined;
          }
          const message = err instanceof Error ? err.message : String(err);
          logger.error('ConfigService.getStackOutputs: PulumiService.getStackOutputs rejected unexpectedly', {
            error: message,
          });
          throw new Error(message);
        },
      );
      this.stackOutputsCache = pending;
    } else {
      logger.debug('ConfigService.getStackOutputs: cache hit');
    }
    return this.stackOutputsCache;
  }

  /**
   * Read the AWS region hint from the process environment.
   * Extracted so tests can stub env access via `vi.spyOn` instead of
   * mutating `process.env` directly (which is flaky across tests).
   */
  readEnvRegion(): string | undefined {
    return process.env['AWS_DEFAULT_REGION'];
  }

  /**
   * Read the in-memory cache TTL override (milliseconds) from
   * `CONFIG_CACHE_TTL_MS`. Extracted for test-stubbing, mirroring
   * {@link readEnvRegion}.
   *
   * Defaults to {@link DEFAULT_CONFIG_CACHE_TTL_MS} (30s) when the env var is
   * unset, empty, not a finite number, or non-positive (zero included) — the
   * default is applied here rather than pushed onto callers.
   */
  readEnvConfigCacheTtlMs(): number {
    const raw = process.env['CONFIG_CACHE_TTL_MS'];
    if (raw === undefined || raw.length === 0) return DEFAULT_CONFIG_CACHE_TTL_MS;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      logger.warn('Invalid CONFIG_CACHE_TTL_MS value, using default', { raw });
      return DEFAULT_CONFIG_CACHE_TTL_MS;
    }
    return parsed;
  }

  /**
   * Return `process.resourcesPath` when running inside an Electron packaged app,
   * or `undefined` otherwise. Extracted as a protected method so tests can stub
   * it via `vi.spyOn` without touching `process.resourcesPath` directly.
   */
  protected readResourcesPath(): string | undefined {
    return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  }

  /**
   * Resolve the configured S3 configuration bucket name — the sole source of
   * `DeploymentConfigService`'s configuration JSON. Returns `null` when no bucket is
   * configured, which callers MUST treat as "setup incomplete" — there is no
   * local-file fallback (see `DeploymentConfigService.isConfigured()`).
   *
   * Resolution order:
   *  1. `HYVEON_CONFIG_BUCKET` env var — wins when set. A dev/CI convenience
   *     override, not how the packaged app resolves the bucket in normal
   *     operator use.
   *  2. `ElectronStoreService`'s `bootstrap.configurationBucket` — the actual
   *     operator-configured value, submitted by the First-Run Wizard's
   *     bootstrap step (`WizardController.saveState`) and read back via
   *     `WizardController.getState`.
   *  3. `null` — no backend configured.
   */
  getConfigurationBucket(): string | null {
    const envOverride = this.readEnvConfigBucketOverride();
    if (envOverride) return envOverride;

    return this.electronStore.get('bootstrap')?.configurationBucket ?? null;
  }

  /**
   * Read the `HYVEON_CONFIG_BUCKET` override from the process environment.
   * Extracted for test-stubbing, mirroring {@link readEnvRegion}.
   */
  readEnvConfigBucketOverride(): string | undefined {
    return process.env['HYVEON_CONFIG_BUCKET'];
  }

  /**
   * Resolve the AWS region for SDK clients.
   *
   * Prefers the wizard-configured region (`ElectronStoreService`'s
   * `aws.region`, set by the credentials step and used by `BootstrapService`
   * to create the state bucket itself — see that service's own region
   * resolution) so the method can stay synchronous, which matters because it
   * has many synchronous callers across the app (SDK client construction,
   * `cloud-provider.module.ts`'s DI factories) while {@link getStackOutputs}
   * is async-only. The wizard-configured region is known before anything is
   * ever deployed, and for a single-region-per-install app it can never
   * legitimately disagree with the deployed stack's outputs. Falls back to
   * `AWS_DEFAULT_REGION`, then to `us-east-1`.
   */
  getRegion(): string {
    return (
      this.electronStore.get('aws')?.region ??
      this.readEnvRegion() ??
      'us-east-1'
    );
  }

  /**
   * Resolve the cloud provider the app is currently driving. Hardcoded to
   * `'aws'` for now — a config-driven value read from the future
   * electron-store-backed cloud profile will replace this constant once
   * multi-cloud support lands.
   */
  getActiveCloud(): ActiveCloud {
    return 'aws';
  }
}
