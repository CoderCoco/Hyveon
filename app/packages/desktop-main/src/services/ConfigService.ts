import { Injectable } from '@nestjs/common';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';
import { EMBEDDED_TFSTATE } from '../generated/tfstate.js';

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
  discord_bot_token_secret_arn: string;
  discord_public_key_secret_arn: string;
  interactions_invoke_url: string | null;
  discord_interactions_url: string | null;
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
 * Owns every runtime configuration source the management app reads:
 *  - `terraform.tfstate` (outputs of the last `terraform apply`) — parsed
 *    lazily and cached in-memory until {@link ConfigService.invalidateCache}
 *    is called. Path resolved by {@link ConfigService.getTfStatePath}.
 *  - `server_config.json` — the user-editable file holding the watchdog
 *    tunables and the optional API bearer token. Path resolved by
 *    {@link ConfigService.getServerConfigPath}.
 *  - A handful of process env vars (`AWS_DEFAULT_REGION`, `API_TOKEN`).
 *
 * Every other service injects this one instead of touching `process.env` or
 * reading files directly, so tests can stub env/file access cleanly.
 */
@Injectable()
export class ConfigService {
  private tfCache: TfOutputs | null = null;

  /**
   * Drop the cached tfstate parse. Called from the `/api/games` and
   * `/api/status` handlers so a fresh `terraform apply` is picked up without
   * a server restart; tests also call it between scenarios.
   */
  invalidateCache(): void {
    this.tfCache = null;
  }

  /**
   * Parse `terraform/terraform.tfstate` (once, then memoised) and project the
   * pieces the app cares about. Falls back to the state embedded at build time
   * by `scripts/embed-tfstate.mjs` when the runtime file is absent. Returns
   * `null` when neither source is available — callers treat that as "infra not
   * deployed yet" and degrade gracefully.
   */
  getTfOutputs(): TfOutputs | null {
    if (this.tfCache) return this.tfCache;

    type RawState = { outputs?: Record<string, { value: unknown }> };
    let raw: RawState;

    const tfStatePath = this.getTfStatePath();
    if (existsSync(tfStatePath)) {
      try {
        raw = JSON.parse(readFileSync(tfStatePath, 'utf-8')) as RawState;
      } catch (err) {
        logger.error('Failed to parse Terraform state', { err, path: tfStatePath });
        return null;
      }
    } else if (EMBEDDED_TFSTATE) {
      logger.debug('Using build-time embedded Terraform state');
      raw = EMBEDDED_TFSTATE as unknown as RawState;
    } else {
      logger.warn('Terraform state not found', { path: tfStatePath });
      return null;
    }

    try {
      const out = raw.outputs ?? {};
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
        discord_bot_token_secret_arn: get('discord_bot_token_secret_arn', ''),
        discord_public_key_secret_arn: get('discord_public_key_secret_arn', ''),
        interactions_invoke_url: get('interactions_invoke_url', null),
        discord_interactions_url: get('discord_interactions_url', null),
      };

      logger.debug('Loaded Terraform outputs', { games: this.tfCache.game_names });
      return this.tfCache;
    } catch (err) {
      logger.error('Failed to parse Terraform state', { err });
      return null;
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
   * Return `process.resourcesPath` when running inside an Electron packaged app,
   * or `undefined` otherwise. Extracted as a protected method so tests can stub
   * it via `vi.spyOn` without touching `process.resourcesPath` directly.
   */
  protected readResourcesPath(): string | undefined {
    return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as { app: { getPath(name: string): string } };
      return electron.app.getPath('userData');
    } catch {
      return null;
    }
  }

  /**
   * Resolve the absolute path to `terraform.tfstate`.
   *
   * Resolution order:
   *  1. `TF_STATE_PATH` env var — wins when set (useful for CI / Docker volume
   *     mounts).
   *  2. Electron packaged app — `<resourcesPath>/terraform/aws/terraform.tfstate`
   *     (the Electron build copies the Terraform bundle there).
   *  3. Dev/test fallback — repo root `terraform/terraform.tfstate` (same path
   *     the old module-level constant resolved to).
   */
  getTfStatePath(): string {
    const envOverride = process.env['TF_STATE_PATH'];
    if (envOverride) return envOverride;

    const resourcesPath = this.readResourcesPath();
    if (resourcesPath) {
      return join(resourcesPath, 'terraform', 'aws', 'terraform.tfstate');
    }

    // Dev fallback: repo root is one level above _APP_ROOT (app/)
    return join(_APP_ROOT, '..', 'terraform', 'terraform.tfstate');
  }

  /**
   * Resolve the absolute path to `server_config.json`.
   *
   * Resolution order:
   *  1. `SERVER_CONFIG_PATH` env var — wins when set.
   *  2. Electron packaged app — `<userData>/server_config.json` (user-writable
   *     location that survives app updates).
   *  3. Dev/test fallback — `<APP_ROOT>/server_config.json` (same path the old
   *     module-level constant resolved to).
   */
  getServerConfigPath(): string {
    const envOverride = process.env['SERVER_CONFIG_PATH'];
    if (envOverride) return envOverride;

    const userData = this.readUserDataPath();
    if (userData) {
      return join(userData, 'server_config.json');
    }

    return join(_APP_ROOT, 'server_config.json');
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
