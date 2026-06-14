import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { EnvHttpController } from './env-http.controller.js';
import type { ConfigService, TfOutputs } from '../services/ConfigService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Build a ConfigService stub returning the given (partial) Terraform outputs. */
function makeConfig(outputs: Partial<TfOutputs> | null = null): ConfigService {
  return {
    getTfOutputs: vi.fn().mockReturnValue(outputs),
  } as unknown as ConfigService;
}

describe('EnvHttpController', () => {
  describe('getEnv', () => {
    it('should return region and domain from Terraform outputs', () => {
      const result = new EnvHttpController(
        makeConfig({ aws_region: 'us-east-1', domain_name: 'example.com' }),
      ).getEnv();
      expect(result.region).toBe('us-east-1');
      expect(result.domain).toBe('example.com');
    });

    it('should derive environment as PROD when a domain_name is present', () => {
      const result = new EnvHttpController(
        makeConfig({ aws_region: 'us-east-1', domain_name: 'servers.example.com' }),
      ).getEnv();
      expect(result.environment).toBe('PROD');
    });

    it('should fall back to "local" region and empty domain when Terraform has not been applied', () => {
      const result = new EnvHttpController(makeConfig(null)).getEnv();
      expect(result.region).toBe('local');
      expect(result.domain).toBe('');
      expect(result.environment).toBe('local');
    });

    it('should set environment to "local" when domain_name is an empty string', () => {
      const result = new EnvHttpController(
        makeConfig({ aws_region: 'eu-west-1', domain_name: '' }),
      ).getEnv();
      expect(result.environment).toBe('local');
    });
  });
});
