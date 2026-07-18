import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { ConfigService } from './ConfigService.js';

/** Strongly-typed mock handles for the `fs` module. */
const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);

/**
 * Build a Terraform state file payload from an `outputs` map.
 * Mirrors the shape that `terraform.tfstate` uses on disk.
 */
function makeState(outputs: Record<string, { value: unknown }>): string {
  return JSON.stringify({ outputs });
}

describe('ConfigService', () => {
  /** Fresh instance per test; each has its own in-memory tfstate cache. */
  let service: ConfigService;

  beforeEach(() => {
    service = new ConfigService();
  });

  describe('getTfOutputs', () => {
    it('should return null when the state file is absent', () => {
      mockExists.mockReturnValue(false);
      expect(service.getTfOutputs()).toBeNull();
    });

    it('should return null when the state file contains the literal null', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('null');
      expect(service.getTfOutputs()).toBeNull();
    });

    it('should return null when the state file has no outputs key', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('{}');
      expect(service.getTfOutputs()).toBeNull();
    });

    it('should parse outputs and fill defaults for missing keys', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        makeState({
          aws_region: { value: 'us-west-2' },
          ecs_cluster_name: { value: 'my-cluster' },
          game_names: { value: ['minecraft', 'factorio'] },
        }),
      );

      const outputs = service.getTfOutputs();
      expect(outputs).not.toBeNull();
      expect(outputs!.aws_region).toBe('us-west-2');
      expect(outputs!.ecs_cluster_name).toBe('my-cluster');
      expect(outputs!.game_names).toEqual(['minecraft', 'factorio']);
      expect(outputs!.subnet_ids).toBe('');
      expect(outputs!.alb_dns_name).toBeNull();
      expect(outputs!.efs_access_points).toEqual({});
      expect(outputs!.applied_game_servers).toBeNull();
    });

    it('should parse applied_game_servers when the output is present', () => {
      mockExists.mockReturnValue(true);
      const appliedGameServers = {
        minecraft: {
          image: 'itzg/minecraft-server',
          cpu: 1024,
          memory: 2048,
          ports: [{ container: 25565, protocol: 'tcp' }],
          volumes: [{ name: 'data', container_path: '/data' }],
        },
      };
      mockRead.mockReturnValue(
        makeState({
          applied_game_servers: { value: appliedGameServers },
        }),
      );

      const outputs = service.getTfOutputs();
      expect(outputs!.applied_game_servers).toEqual(appliedGameServers);
    });

    it('should default applied_game_servers to null when the output is missing', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(makeState({ aws_region: { value: 'us-west-2' } }));

      expect(service.getTfOutputs()!.applied_game_servers).toBeNull();
    });

    it('should apply the fallback aws_region when outputs omit it', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(makeState({}));
      expect(service.getTfOutputs()!.aws_region).toBe('us-east-1');
    });

    it('should cache parsed outputs across calls', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(makeState({ aws_region: { value: 'eu-central-1' } }));

      service.getTfOutputs();
      service.getTfOutputs();

      expect(mockRead).toHaveBeenCalledTimes(1);
    });

    it('should cache a null result so an undeployed stack is not re-read on every call', () => {
      mockExists.mockReturnValue(false);

      expect(service.getTfOutputs()).toBeNull();
      expect(service.getTfOutputs()).toBeNull();

      expect(mockExists).toHaveBeenCalledTimes(1);
    });

    it('should re-read after invalidateCache when the previous result was null', () => {
      mockExists.mockReturnValue(false);
      expect(service.getTfOutputs()).toBeNull();

      service.invalidateCache();
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(makeState({ aws_region: { value: 'eu-west-1' } }));

      expect(service.getTfOutputs()!.aws_region).toBe('eu-west-1');
    });

    it('should force a re-read after invalidateCache', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(makeState({ aws_region: { value: 'a' } }));

      service.getTfOutputs();
      service.invalidateCache();
      mockRead.mockReturnValue(makeState({ aws_region: { value: 'b' } }));

      expect(service.getTfOutputs()!.aws_region).toBe('b');
      expect(mockRead).toHaveBeenCalledTimes(2);
    });

    it('should return null when the state file contains invalid JSON', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('not-json{');
      expect(service.getTfOutputs()).toBeNull();
    });

    it('should parse audit_table_name when the output is present', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        makeState({
          audit_table_name: { value: 'hyveon-audit' },
        }),
      );

      expect(service.getTfOutputs()!.audit_table_name).toBe('hyveon-audit');
    });

    it('should default audit_table_name to an empty string when the output is missing', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(makeState({ aws_region: { value: 'us-west-2' } }));

      expect(service.getTfOutputs()!.audit_table_name).toBe('');
    });
  });

  describe('getRegion', () => {
    it('should use aws_region from outputs when available', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(makeState({ aws_region: { value: 'ap-south-1' } }));
      expect(service.getRegion()).toBe('ap-south-1');
    });

    it('should fall back to readEnvRegion when outputs unavailable', () => {
      mockExists.mockReturnValue(false);
      vi.spyOn(service, 'readEnvRegion').mockReturnValue('eu-west-3');
      expect(service.getRegion()).toBe('eu-west-3');
    });

    it('should fall back to us-east-1 when no outputs and no env region', () => {
      mockExists.mockReturnValue(false);
      vi.spyOn(service, 'readEnvRegion').mockReturnValue(undefined);
      expect(service.getRegion()).toBe('us-east-1');
    });
  });

  describe('getActiveCloud', () => {
    it('should return aws', () => {
      expect(service.getActiveCloud()).toBe('aws');
    });
  });

  describe('getApiToken', () => {
    it('should return the token from API_TOKEN env when set', () => {
      vi.spyOn(service, 'readEnvApiToken').mockReturnValue('env-tok');
      expect(service.getApiToken()).toBe('env-tok');
    });

    it('should treat an explicitly-empty API_TOKEN env var as no token', () => {
      vi.spyOn(service, 'readEnvApiToken').mockReturnValue('');
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(JSON.stringify({ api_token: 'file-tok' }));
      // Env wins, even when empty — user intentionally disabled auth via env.
      expect(service.getApiToken()).toBeNull();
    });

    it('should fall back to server_config.json.api_token when env is unset', () => {
      vi.spyOn(service, 'readEnvApiToken').mockReturnValue(undefined);
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(JSON.stringify({ api_token: 'file-tok' }));
      expect(service.getApiToken()).toBe('file-tok');
    });

    it('should return null when neither env nor file has a token', () => {
      vi.spyOn(service, 'readEnvApiToken').mockReturnValue(undefined);
      mockExists.mockReturnValue(false);
      expect(service.getApiToken()).toBeNull();
    });

    it('should return null when the config file is malformed', () => {
      vi.spyOn(service, 'readEnvApiToken').mockReturnValue(undefined);
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('{bad');
      expect(service.getApiToken()).toBeNull();
    });

    it('should return null when the api_token field is not a string', () => {
      vi.spyOn(service, 'readEnvApiToken').mockReturnValue(undefined);
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(JSON.stringify({ api_token: 12345 }));
      expect(service.getApiToken()).toBeNull();
    });
  });

  describe('getConfig', () => {
    it('should return defaults when the config file is missing', () => {
      mockExists.mockReturnValue(false);
      expect(service.getConfig()).toEqual({
        watchdog_interval_minutes: 15,
        watchdog_idle_checks: 4,
        watchdog_min_packets: 100,
      });
    });

    it('should merge saved config over defaults', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        JSON.stringify({ watchdog_idle_checks: 10, watchdog_min_packets: 250 }),
      );
      expect(service.getConfig()).toEqual({
        watchdog_interval_minutes: 15,
        watchdog_idle_checks: 10,
        watchdog_min_packets: 250,
      });
    });

    it('should return defaults when the config file is malformed', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('{bad json');
      const config = service.getConfig();
      expect(config.watchdog_interval_minutes).toBe(15);
      expect(config.watchdog_idle_checks).toBe(4);
      expect(config.watchdog_min_packets).toBe(100);
    });
  });

  describe('saveConfig', () => {
    it('should write JSON-stringified config to disk', () => {
      const config = {
        watchdog_interval_minutes: 30,
        watchdog_idle_checks: 6,
        watchdog_min_packets: 500,
      };
      service.saveConfig(config);
      expect(mockWrite).toHaveBeenCalledTimes(1);
      const [, payload] = mockWrite.mock.calls[0]!;
      expect(JSON.parse(payload as string)).toEqual(config);
    });
  });

  describe('readEnvTfvarsCacheTtlMs', () => {
    afterEach(() => {
      delete process.env['TFVARS_CACHE_TTL_MS'];
    });

    it('should default to 30000 when TFVARS_CACHE_TTL_MS is unset', () => {
      delete process.env['TFVARS_CACHE_TTL_MS'];
      expect(service.readEnvTfvarsCacheTtlMs()).toBe(30000);
    });

    it('should default to 30000 when TFVARS_CACHE_TTL_MS is empty', () => {
      process.env['TFVARS_CACHE_TTL_MS'] = '';
      expect(service.readEnvTfvarsCacheTtlMs()).toBe(30000);
    });

    it('should parse a valid TFVARS_CACHE_TTL_MS value', () => {
      process.env['TFVARS_CACHE_TTL_MS'] = '60000';
      expect(service.readEnvTfvarsCacheTtlMs()).toBe(60000);
    });

    it('should default to 30000 and warn when TFVARS_CACHE_TTL_MS is not a number', () => {
      process.env['TFVARS_CACHE_TTL_MS'] = 'not-a-number';
      expect(service.readEnvTfvarsCacheTtlMs()).toBe(30000);
    });

    it('should default to 30000 when TFVARS_CACHE_TTL_MS is negative', () => {
      process.env['TFVARS_CACHE_TTL_MS'] = '-1';
      expect(service.readEnvTfvarsCacheTtlMs()).toBe(30000);
    });

    it('should default to 30000 when TFVARS_CACHE_TTL_MS is zero', () => {
      process.env['TFVARS_CACHE_TTL_MS'] = '0';
      expect(service.readEnvTfvarsCacheTtlMs()).toBe(30000);
    });
  });

  describe('path resolution', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env['TF_STATE_PATH'];
      delete process.env['SERVER_CONFIG_PATH'];
      delete process.env['TFVARS_PATH'];
      delete process.env['GSD_TFVARS_BUCKET'];
    });

    it('should return packaged tfstate path when readIsPackaged returns true', () => {
      type Internals = { readIsPackaged: () => boolean; readResourcesPath: () => string | undefined };
      vi.spyOn(service as unknown as Internals, 'readIsPackaged').mockReturnValue(true);
      vi.spyOn(service as unknown as Internals, 'readResourcesPath').mockReturnValue('/fake/resources');
      expect(service.getTfStatePath()).toBe(
        path.join('/fake/resources', 'terraform', 'aws', 'terraform.tfstate'),
      );
    });

    it('should return the repo-relative fallback when readIsPackaged returns false', () => {
      vi.spyOn(service as unknown as { readIsPackaged: () => boolean }, 'readIsPackaged').mockReturnValue(false);
      const result = service.getTfStatePath();
      expect(result).toMatch(/terraform[/\\]terraform\.tfstate$/);
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('should return the TF_STATE_PATH env var value when set', () => {
      process.env['TF_STATE_PATH'] = '/custom/state/terraform.tfstate';
      expect(service.getTfStatePath()).toBe('/custom/state/terraform.tfstate');
    });

    it('should return packaged server_config path when readIsPackaged returns true', () => {
      type Internals = { readIsPackaged: () => boolean; readUserDataPath: () => string | null };
      vi.spyOn(service as unknown as Internals, 'readIsPackaged').mockReturnValue(true);
      vi.spyOn(service as unknown as Internals, 'readUserDataPath').mockReturnValue('/fake/userData');
      expect(service.getServerConfigPath()).toBe(
        path.join('/fake/userData', 'server_config.json'),
      );
    });

    it('should return the repo-relative fallback when readIsPackaged returns false', () => {
      vi.spyOn(service as unknown as { readIsPackaged: () => boolean }, 'readIsPackaged').mockReturnValue(false);
      const result = service.getServerConfigPath();
      expect(result).toMatch(/server_config\.json$/);
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('should return the TFVARS_PATH env var value when set', () => {
      process.env['TFVARS_PATH'] = '/custom/tfvars/terraform.tfvars';
      expect(service.getTfvarsPath()).toBe('/custom/tfvars/terraform.tfvars');
    });

    it('should return packaged tfvars path when readIsPackaged returns true', () => {
      type Internals = { readIsPackaged: () => boolean; readResourcesPath: () => string | undefined };
      vi.spyOn(service as unknown as Internals, 'readIsPackaged').mockReturnValue(true);
      vi.spyOn(service as unknown as Internals, 'readResourcesPath').mockReturnValue('/fake/resources');
      expect(service.getTfvarsPath()).toBe(
        path.join('/fake/resources', 'terraform', 'terraform.tfvars'),
      );
    });

    it('should return the repo-relative tfvars fallback when readIsPackaged returns false', () => {
      vi.spyOn(service as unknown as { readIsPackaged: () => boolean }, 'readIsPackaged').mockReturnValue(false);
      const result = service.getTfvarsPath();
      expect(result).toMatch(/terraform[/\\]terraform\.tfvars$/);
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('should return the GSD_TFVARS_BUCKET env var value when set', () => {
      process.env['GSD_TFVARS_BUCKET'] = 'my-project-tfvars';
      expect(service.getTfvarsBucket()).toBe('my-project-tfvars');
    });

    it('should return the marker file contents when GSD_TFVARS_BUCKET is unset', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('marker-bucket-name\n');
      expect(service.getTfvarsBucket()).toBe('marker-bucket-name');
    });

    it('should walk up from a nested cwd to find the marker file at an ancestor directory', () => {
      const repoRoot = path.join(path.sep, 'repo');
      const nestedCwd = path.join(repoRoot, 'app', 'packages', 'desktop-main');
      const markerPath = path.join(repoRoot, '.gsd', 'tfvars-bucket');

      vi.spyOn(process, 'cwd').mockReturnValue(nestedCwd);
      mockExists.mockImplementation((p) => p === markerPath);
      mockRead.mockReturnValue('nested-bucket-name');

      expect(service.getTfvarsBucket()).toBe('nested-bucket-name');
      expect(mockRead).toHaveBeenCalledWith(markerPath, 'utf-8');
    });

    it('should return null when neither the env var nor the marker file resolve', () => {
      mockExists.mockReturnValue(false);
      expect(service.getTfvarsBucket()).toBeNull();
    });

    it('should return null when the marker file is empty', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('   ');
      expect(service.getTfvarsBucket()).toBeNull();
    });

    it('should return null and warn when the marker file cannot be read', () => {
      mockExists.mockReturnValue(true);
      mockRead.mockImplementation(() => {
        throw new Error('EACCES');
      });
      expect(service.getTfvarsBucket()).toBeNull();
    });
  });
});
