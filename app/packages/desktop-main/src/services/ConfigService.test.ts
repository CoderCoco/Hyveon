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

  describe('path resolution', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env['TF_STATE_PATH'];
      delete process.env['SERVER_CONFIG_PATH'];
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
  });
});
