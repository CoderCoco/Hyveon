import { Injectable } from '@nestjs/common';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import type { GameServer } from '@hyveon/shared';
import { logger } from '../logger.js';

/** Absolute path to the `dist/services/` directory at runtime. */
const _dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the app root (`app/` in the repo, `/workspace/app/` in Docker).
 * Derived by walking 4 levels up from `dist/services/`.
 * Used only as a private dev-mode fallback inside instance methods — callers
 * should use `getTfStatePath()` / `getServerConfigPath()` instead.
 */
const _APP_ROOT = join(_dirname, '..', '..', '..', '..');

/**
 * Shape of the subset of Terraform root outputs the management app consumes.
 * Mirrors the `output` blocks in `terraform/*.tf`; add fields here (and in
 * `getTfOutputs()` below) when a new output becomes a dependency.
 */
export interface TfOutputs {
  aws_region: string;
  ecs_cluster_name: string;
  ecs_cluster_arn: string;
  subnet_ids: string;
  security_group_id: string;
  file_manager_security_group_id: string;
  efs_file_system_id: string;
  efs_access_points: Record<string, string>;
  domain_name: string;
  game_names: string[];
  alb_dns_name: string | null;
  acm_certificate_arn: string | null;
  discord_table_name: string;
  audit_table_name: string;
  discord_bot_token_secret_arn: string;
  discord_public_key_secret_arn: string;
  interactions_invoke_url: string | null;
  discord_interactions_url: string | null;
  /**
   * Full per-game `game_servers` configuration as last applied by Terraform
   * (the `applied_game_servers` sensitive output — see `terraform/aws/outputs.tf`),
   * keyed by game name. Used for drift detection: field-level comparison
   * against the currently declared tfvars config (see `@hyveon/shared/drift.ts`).
   * `null` when the output is absent (e.g. state predates this output, or
   * `terraform apply` hasn't run since it was added).
   */
  applied_game_servers: Record<string, Omit<GameServer, 'name'>> | null;
}

/**
 * User-editable watchdog tuning knobs persisted to `server_config.json`.
 * Consumed by the watchdog Lambda via Terraform variables; the UI only
 * displays/edits them — changes require `terraform apply` to take effect.
 */
export interface WatchdogConfig {
  watchdog_interval_minutes: number;
  watchdog_idle_checks: number;
  watchdog_min_packets: number;
}

const DEFAULT_CONFIG: WatchdogConfig = {
  watchdog_interval_minutes: 15,
  watchdog_idle_checks: 4,
  watchdog_min_packets: 100,
};

/**
 * Default in-memory cache TTL (milliseconds) `TfvarsService` uses for the
 * parsed tfvars payload when `TFVARS_CACHE_TTL_MS` is unset or invalid.
 */
const DEFAULT_TFVARS_CACHE_TTL_MS = 30000;

/**
 * Identifier for the cloud provider the app is currently driving. A union
 * type (rather than a bare string) so additional providers can be added
 * without widening every consumer's type to `string`.
 */
export type ActiveCloud = 'aws';

/**
 * Owns every runtime configuration source the management app reads:
 *  - `terraform.tfstate` — parsed lazily and cached until
 *    {@link ConfigService.invalidateCache} is called. Path resolved by
 *    {@link ConfigService.getTfStatePath}.
 *  - `server_config.json` — user-editable watchdog tunables and optional API
 *    bearer token. Path resolved by {@link ConfigService.getServerConfigPath}.
 *  - A handful of process env vars (`AWS_DEFAULT_REGION`, `API_TOKEN`).
 *
 * Both path resolvers follow the same three-tier priority:
 *  1. Env var override (`TF_STATE_PATH` / `SERVER_CONFIG_PATH`) — always wins.
 *  2. Electron packaged build (`electron.app.isPackaged`) — uses Electron-specific
 *     paths (`resourcesPath` for tfstate, `userData` for server config).
 *  3. Dev/test fallback — repo-relative paths when not in a packaged build.
 *
 * Every other service injects this one instead of touching `process.env` or
 * reading files directly, so tests can stub env/file access cleanly.
 */
@Injectable()
export class ConfigService {
  /**
   * Memoised tfstate projection. Tri-state: `undefined` means "not loaded yet",
   * `null` means "loaded, but no usable state" (absent/empty/placeholder), and
   * an object is a parsed projection. Caching `null` matters because callers on
   * polling paths (e.g. status) hit this every tick — without it, an undeployed
   * stack would re-read the file and re-log a warning on every call.
   */
  private tfCache: TfOutputs | null | undefined = undefined;

  /**
   * Drop the cached tfstate parse. Called from the `/api/games` and
   * `/api/status` handlers so a fresh `terraform apply` is picked up without
   * a server restart; tests also call it between scenarios.
   */
  invalidateCache(): void {
    this.tfCache = undefined;
  }

  /**
   * Parse `terraform/terraform.tfstate` (once, then memoised) and project the
   * pieces the app cares about. Returns `null` when the runtime file is absent
   * — callers treat that as "infra not deployed yet" and degrade gracefully.
   */
  getTfOutputs(): TfOutputs | null {
    if (this.tfCache !== undefined) return this.tfCache;

    type RawState = { outputs?: Record<string, { value: unknown }> };
    let raw: RawState;

    const tfStatePath = this.getTfStatePath();
    if (existsSync(tfStatePath)) {
      try {
        raw = JSON.parse(readFileSync(tfStatePath, 'utf-8')) as RawState;
      } catch (err) {
        logger.error('Failed to parse Terraform state', { err, path: tfStatePath });
        return (this.tfCache = null);
      }
      if (raw === null || raw === undefined) {
        logger.warn('Terraform state file is empty or null', { path: tfStatePath });
        return (this.tfCache = null);
      }
    } else {
      logger.warn('Terraform state not found', { path: tfStatePath });
      return (this.tfCache = null);
    }

    try {
      if (!raw.outputs) {
        logger.warn('Terraform state has no outputs — infra not yet deployed', { path: tfStatePath });
        return (this.tfCache = null);
      }

      const out = raw.outputs;
      const get = <T>(key: string, fallback: T): T =>
        key in out ? (out[key]!.value as T) : fallback;

      this.tfCache = {
        aws_region: get('aws_region', 'us-east-1'),
        ecs_cluster_name: get('ecs_cluster_name', ''),
        ecs_cluster_arn: get('ecs_cluster_arn', ''),
        subnet_ids: get('subnet_ids', ''),
        security_group_id: get('security_group_id', ''),
        file_manager_security_group_id: get('file_manager_security_group_id', ''),
        efs_file_system_id: get('efs_file_system_id', ''),
        efs_access_points: get('efs_access_points', {}),
        domain_name: get('domain_name', ''),
        game_names: get('game_names', []),
        alb_dns_name: get('alb_dns_name', null),
        acm_certificate_arn: get('acm_certificate_arn', null),
        discord_table_name: get('discord_table_name', ''),
        audit_table_name: get('audit_table_name', ''),
        discord_bot_token_secret_arn: get('discord_bot_token_secret_arn', ''),
        discord_public_key_secret_arn: get('discord_public_key_secret_arn', ''),
        interactions_invoke_url: get('interactions_invoke_url', null),
        discord_interactions_url: get('discord_interactions_url', null),
        applied_game_servers: get('applied_game_servers', null),
      };

      logger.debug('Loaded Terraform outputs', { games: this.tfCache.game_names });
      return this.tfCache;
    } catch (err) {
      logger.error('Failed to parse Terraform state', { err });
      return (this.tfCache = null);
    }
  }

  /**
   * Read the AWS region hint from the process environment.
   * Extracted so tests can stub env access via `vi.spyOn` instead of
   * mutating `process.env` directly (which is flaky across tests).
   */
  readEnvRegion(): string | undefined {
    return process.env['AWS_DEFAULT_REGION'];
  }

  /** Read the API bearer token from `API_TOKEN`. Extracted for test-stubbing. */
  readEnvApiToken(): string | undefined {
    return process.env['API_TOKEN'];
  }

  /**
   * Read the tfvars in-memory cache TTL override (milliseconds) from
   * `TFVARS_CACHE_TTL_MS`. Extracted for test-stubbing, mirroring
   * {@link readEnvRegion} / {@link readEnvApiToken}.
   *
   * Defaults to {@link DEFAULT_TFVARS_CACHE_TTL_MS} (30s) when the env var is
   * unset, empty, not a finite number, or non-positive (zero included) — the
   * default is applied here rather than pushed onto callers.
   */
  readEnvTfvarsCacheTtlMs(): number {
    const raw = process.env['TFVARS_CACHE_TTL_MS'];
    if (raw === undefined || raw.length === 0) return DEFAULT_TFVARS_CACHE_TTL_MS;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      logger.warn('Invalid TFVARS_CACHE_TTL_MS value, using default', { raw });
      return DEFAULT_TFVARS_CACHE_TTL_MS;
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
   * Return whether the app is running as a packaged Electron build
   * (`electron.app.isPackaged`). `process.resourcesPath` is set in both dev
   * and packaged Electron processes, so it cannot be used as a packaged-build
   * guard — this method is the reliable alternative. Extracted as a protected
   * method so tests can stub it via `vi.spyOn`.
   */
  protected readIsPackaged(): boolean {
    if (!process.versions['electron']) return false;
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { isPackaged: boolean } };
      return electron.app.isPackaged;
    } catch {
      return false;
    }
  }

  /**
   * Return the Electron `userData` directory when running inside an Electron
   * process, or `null` otherwise. The `electron` module is required lazily at
   * call-time (keyed on `process.versions['electron']` being truthy) so that
   * importing this module in a plain Node/test context never triggers an
   * unresolved-module error. Extracted as a protected method so tests can stub
   * it via `vi.spyOn`.
   */
  protected readUserDataPath(): string | null {
    if (!process.versions['electron']) return null;
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { getPath(name: string): string } };
      return electron.app.getPath('userData');
    } catch {
      return null;
    }
  }

  /**
   * Resolve the absolute path to `terraform.tfstate`.
   *
   * Resolution order:
   *  1. `TF_STATE_PATH` env var — wins when set.
   *  2. Electron packaged app (`app.isPackaged`) — `<resourcesPath>/terraform/aws/terraform.tfstate`.
   *  3. Dev/test fallback — repo root `terraform/terraform.tfstate`.
   */
  getTfStatePath(): string {
    const envOverride = process.env['TF_STATE_PATH'];
    if (envOverride) return envOverride;

    if (this.readIsPackaged()) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return join(this.readResourcesPath()!, 'terraform', 'aws', 'terraform.tfstate');
    }

    // Dev fallback: repo root is one level above _APP_ROOT (app/)
    return join(_APP_ROOT, '..', 'terraform', 'terraform.tfstate');
  }

  /**
   * Resolve the absolute path to `server_config.json`.
   *
   * Resolution order:
   *  1. `SERVER_CONFIG_PATH` env var — wins when set.
   *  2. Electron packaged app (`app.isPackaged`) — `<userData>/server_config.json`
   *     (user-writable location that survives app updates).
   *  3. Dev/test fallback — `<APP_ROOT>/server_config.json`.
   */
  getServerConfigPath(): string {
    const envOverride = process.env['SERVER_CONFIG_PATH'];
    if (envOverride) return envOverride;

    if (this.readIsPackaged()) {
      const userData = this.readUserDataPath();
      if (userData) {
        return join(userData, 'server_config.json');
      }
    }

    return join(_APP_ROOT, 'server_config.json');
  }

  /**
   * Resolve the absolute path to the local fallback copy of
   * `terraform.tfvars`. This is the file `TfvarsService` reads/writes when
   * running in "local" mode — i.e. no S3 tfvars backend is configured (see
   * {@link getTfvarsBucket}). See `docs/docs/guides/s3-tfvars.md` for the
   * local-vs-S3 tradeoff this mirrors.
   *
   * Resolution order (identical in structure to {@link getTfStatePath}):
   *  1. `TFVARS_PATH` env var — wins when set.
   *  2. Electron packaged app (`app.isPackaged`) — `<resourcesPath>/terraform/terraform.tfvars`.
   *  3. Dev/test fallback — repo root `terraform/terraform.tfvars`.
   */
  getTfvarsPath(): string {
    const envOverride = process.env['TFVARS_PATH'];
    if (envOverride) return envOverride;

    if (this.readIsPackaged()) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return join(this.readResourcesPath()!, 'terraform', 'terraform.tfvars');
    }

    // Dev fallback: repo root is one level above _APP_ROOT (app/)
    return join(_APP_ROOT, '..', 'terraform', 'terraform.tfvars');
  }

  /**
   * Resolve the S3 bucket name backing the optional versioned tfvars store
   * described in `docs/docs/guides/s3-tfvars.md`. Returns `null` when no S3
   * backend is configured, which callers treat as "local mode" — read/write
   * {@link getTfvarsPath} directly instead.
   *
   * Resolution order (mirrors the `--bucket` fallback chain in
   * `scripts/tfvars-sync.ts` and the `Makefile` targets it generates):
   *  1. `GSD_TFVARS_BUCKET` env var — wins when set.
   *  2. The nearest `.gsd/tfvars-bucket` marker file, found by walking up
   *     from `process.cwd()` toward the filesystem root — written by
   *     `setup.sh`'s S3 bootstrap or `init-parent.ts bootstrap --s3-tfvars`.
   *     Matches `findBucketMarker()` in `scripts/tfvars-sync.ts` so the CLI
   *     and the app agree on which marker file wins regardless of the
   *     directory the app happens to be launched from.
   *  3. `null` — no backend configured.
   */
  getTfvarsBucket(): string | null {
    const envOverride = process.env['GSD_TFVARS_BUCKET'];
    if (envOverride) return envOverride;

    const markerPath = this.findTfvarsBucketMarker(process.cwd());
    if (!markerPath) return null;

    try {
      const contents = readFileSync(markerPath, 'utf-8').trim();
      return contents.length > 0 ? contents : null;
    } catch (err) {
      logger.warn('Could not read .gsd/tfvars-bucket marker file', { err, path: markerPath });
      return null;
    }
  }

  /**
   * Walk up from `startDir` toward the filesystem root looking for a
   * `.gsd/tfvars-bucket` marker file, one directory at a time. Mirrors
   * `findBucketMarker()` in `scripts/tfvars-sync.ts` so both the CLI and the
   * app resolve to the same marker file. Returns the marker file's absolute
   * path once found, or `undefined` if the filesystem root is reached
   * without a match.
   */
  private findTfvarsBucketMarker(startDir: string): string | undefined {
    let dir = startDir;
    while (true) {
      const markerPath = join(dir, '.gsd', 'tfvars-bucket');
      if (existsSync(markerPath)) return markerPath;

      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }

  /**
   * Token required on every `/api/*` request's `Authorization: Bearer <token>` header.
   *
   * Resolution order:
   *  1. Env var `API_TOKEN` — wins when set, including when explicitly set to an
   *     empty string. Empty is normalized to `null` (treated as "no token
   *     configured") so setting `API_TOKEN=""` does not fall back to the file.
   *  2. `api_token` field in `server_config.json`.
   *
   * Returns `null` when no token is configured. The auth middleware + startup
   * check interpret null differently depending on environment:
   *  - `NODE_ENV=production` → `index.ts` refuses to start. An empty env var
   *    is therefore NOT a supported "auth disabled" mode in production.
   *  - development → the middleware logs a warning and allows unauthenticated
   *    requests so local iteration isn't blocked.
   */
  getApiToken(): string | null {
    const env = this.readEnvApiToken();
    if (env !== undefined) {
      return env.length > 0 ? env : null;
    }
    const serverConfigPath = this.getServerConfigPath();
    if (!existsSync(serverConfigPath)) return null;
    try {
      const raw = JSON.parse(readFileSync(serverConfigPath, 'utf-8')) as { api_token?: unknown };
      return typeof raw.api_token === 'string' && raw.api_token.length > 0 ? raw.api_token : null;
    } catch (err) {
      logger.warn('Could not read api_token from config file', { err });
      return null;
    }
  }

  /**
   * Resolve the AWS region for SDK clients. Prefers the region Terraform
   * provisioned into (so the app always points at the real infra), falls
   * back to `AWS_DEFAULT_REGION`, then to `us-east-1`.
   */
  getRegion(): string {
    return (
      this.getTfOutputs()?.aws_region ??
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

  /**
   * Load the watchdog tunables from `server_config.json`, merged over the
   * built-in defaults so partially-populated files still work. Returns a
   * fresh object on every call — safe for callers to mutate.
   */
  getConfig(): WatchdogConfig {
    const serverConfigPath = this.getServerConfigPath();
    if (!existsSync(serverConfigPath)) return { ...DEFAULT_CONFIG };
    try {
      const saved = JSON.parse(readFileSync(serverConfigPath, 'utf-8')) as Partial<WatchdogConfig>;
      return { ...DEFAULT_CONFIG, ...saved };
    } catch (err) {
      logger.warn('Could not read config file, using defaults', { err });
      return { ...DEFAULT_CONFIG };
    }
  }

  /**
   * Persist the full watchdog config to `server_config.json`. Note: the
   * watchdog Lambda only reads these values via Terraform variables, so a
   * save here is not effective until the next `terraform apply`.
   */
  saveConfig(config: WatchdogConfig): void {
    writeFileSync(this.getServerConfigPath(), JSON.stringify(config, null, 2));
    logger.info('Config saved', config);
  }
}
