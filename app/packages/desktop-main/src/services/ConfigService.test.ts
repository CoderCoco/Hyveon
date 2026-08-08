import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { ConfigService } from './ConfigService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';
import { logger } from '../logger.js';
import type { PulumiService } from './PulumiService.js';
import type { StackOutputs } from '@hyveon/shared';

/**
 * Minimal `PulumiService` stub — `ConfigService`'s own tests never exercise
 * `getStackOutputs()`'s delegation to the real Pulumi stack-outputs read
 * (that's covered by `PulumiService`'s own tests), so this always resolves
 * `null`, matching "nothing deployed".
 */
function makePulumiService(): PulumiService {
  return { getStackOutputs: vi.fn().mockResolvedValue(null) } as unknown as PulumiService;
}

/**
 * Builds a real `ElectronStoreService` (outside Electron, so it's backed by
 * an in-memory `Map` rather than a real on-disk store — no mocking needed)
 * with `bootstrap.configurationBucket` pre-seeded when `configurationBucket`
 * is supplied, mirroring what the First-Run Wizard's bootstrap step would
 * have persisted. Used to construct `ConfigService`, which reads this value
 * via `getConfigurationBucket()`.
 */
function makeElectronStore(configurationBucket?: string): ElectronStoreService {
  const store = new ElectronStoreService(new SafeStorageService());
  if (configurationBucket !== undefined) {
    store.set('bootstrap', { stateBucket: '', configurationBucket });
  }
  return store;
}

describe('ConfigService', () => {
  /** Fresh instance per test; each has its own in-memory stack-outputs cache. */
  let service: ConfigService;

  beforeEach(() => {
    service = new ConfigService(makeElectronStore(), makePulumiService());
  });

  describe('getStackOutputs', () => {
    it('should delegate to PulumiService.getStackOutputs and return its resolved value', async () => {
      const pulumi = makePulumiService();
      const outputs = { awsRegion: 'us-west-2' } as StackOutputs;
      vi.mocked(pulumi.getStackOutputs).mockResolvedValue(outputs);
      const svc = new ConfigService(makeElectronStore(), pulumi);

      await expect(svc.getStackOutputs()).resolves.toBe(outputs);
    });

    it('should return null (never throw) when PulumiService reports nothing deployed', async () => {
      const pulumi = makePulumiService();
      vi.mocked(pulumi.getStackOutputs).mockResolvedValue(null);
      const svc = new ConfigService(makeElectronStore(), pulumi);

      await expect(svc.getStackOutputs()).resolves.toBeNull();
    });

    it('should only call PulumiService.getStackOutputs once across concurrent and repeated calls (cached)', async () => {
      const pulumi = makePulumiService();
      const outputs = { awsRegion: 'us-west-2' } as StackOutputs;
      vi.mocked(pulumi.getStackOutputs).mockResolvedValue(outputs);
      const svc = new ConfigService(makeElectronStore(), pulumi);

      const [a, b] = await Promise.all([svc.getStackOutputs(), svc.getStackOutputs()]);
      await svc.getStackOutputs();

      expect(a).toBe(outputs);
      expect(b).toBe(outputs);
      expect(pulumi.getStackOutputs).toHaveBeenCalledOnce();
    });

    it('should re-call PulumiService.getStackOutputs after invalidateCache', async () => {
      const pulumi = makePulumiService();
      vi.mocked(pulumi.getStackOutputs).mockResolvedValue(null);
      const svc = new ConfigService(makeElectronStore(), pulumi);

      await svc.getStackOutputs();
      svc.invalidateCache();
      await svc.getStackOutputs();

      expect(pulumi.getStackOutputs).toHaveBeenCalledTimes(2);
    });

    it('should not cache a rejected PulumiService.getStackOutputs call, so a subsequent call retries', async () => {
      const pulumi = makePulumiService();
      vi.mocked(pulumi.getStackOutputs)
        .mockRejectedValueOnce(new Error('transient AWS failure'))
        .mockResolvedValueOnce({ awsRegion: 'us-west-2' } as StackOutputs);
      const svc = new ConfigService(makeElectronStore(), pulumi);

      await expect(svc.getStackOutputs()).rejects.toThrow('transient AWS failure');
      await expect(svc.getStackOutputs()).resolves.toEqual({ awsRegion: 'us-west-2' });
      expect(pulumi.getStackOutputs).toHaveBeenCalledTimes(2);
    });

    it('should log an error and reject with a plain Error (never the raw rejection) when PulumiService.getStackOutputs rejects', async () => {
      const pulumi = makePulumiService();
      const rawError = new Error('transient AWS failure');
      vi.mocked(pulumi.getStackOutputs).mockRejectedValueOnce(rawError);
      const svc = new ConfigService(makeElectronStore(), pulumi);
      vi.mocked(logger.error).mockClear();

      const rejection = await svc.getStackOutputs().catch((err: unknown) => err);

      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).not.toBe(rawError);
      expect((rejection as Error).message).toBe('transient AWS failure');
      expect(logger.error).toHaveBeenCalledWith(
        'ConfigService.getStackOutputs: PulumiService.getStackOutputs rejected unexpectedly',
        expect.objectContaining({ error: 'transient AWS failure' }),
      );
    });

    it('should log a debug line noting a cache miss on the first call', async () => {
      const pulumi = makePulumiService();
      vi.mocked(pulumi.getStackOutputs).mockResolvedValue(null);
      const svc = new ConfigService(makeElectronStore(), pulumi);
      vi.mocked(logger.debug).mockClear();

      await svc.getStackOutputs();

      expect(logger.debug).toHaveBeenCalledWith(
        'ConfigService.getStackOutputs: cache miss — fetching stack outputs from PulumiService',
      );
    });

    it('should log a debug line noting a cache hit on a subsequent cached call', async () => {
      const pulumi = makePulumiService();
      vi.mocked(pulumi.getStackOutputs).mockResolvedValue({ awsRegion: 'us-west-2' } as StackOutputs);
      const svc = new ConfigService(makeElectronStore(), pulumi);

      await svc.getStackOutputs();
      vi.mocked(logger.debug).mockClear();
      await svc.getStackOutputs();

      expect(logger.debug).toHaveBeenCalledWith('ConfigService.getStackOutputs: cache hit');
    });

    describe('null-result TTL (self-healing after a transient failure degraded to null)', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it('should serve a cached null without re-calling PulumiService before the TTL elapses', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
        const pulumi = makePulumiService();
        vi.mocked(pulumi.getStackOutputs).mockResolvedValue(null);
        const svc = new ConfigService(makeElectronStore(), pulumi);

        await svc.getStackOutputs();
        vi.setSystemTime(new Date('2026-07-30T00:00:19.999Z')); // just under the 20s TTL
        await expect(svc.getStackOutputs()).resolves.toBeNull();

        expect(pulumi.getStackOutputs).toHaveBeenCalledOnce();
      });

      it('should re-call PulumiService.getStackOutputs once a cached null has expired, without requiring invalidateCache', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
        const pulumi = makePulumiService();
        vi.mocked(pulumi.getStackOutputs).mockResolvedValue(null);
        const svc = new ConfigService(makeElectronStore(), pulumi);

        await svc.getStackOutputs();
        vi.setSystemTime(new Date('2026-07-30T00:00:20.001Z')); // just past the 20s TTL
        await svc.getStackOutputs();

        expect(pulumi.getStackOutputs).toHaveBeenCalledTimes(2);
      });

      it('should recover a real StackOutputs value once the transient failure that produced the cached null clears', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
        const pulumi = makePulumiService();
        const outputs = { awsRegion: 'us-west-2' } as StackOutputs;
        vi.mocked(pulumi.getStackOutputs).mockResolvedValueOnce(null).mockResolvedValueOnce(outputs);
        const svc = new ConfigService(makeElectronStore(), pulumi);

        await expect(svc.getStackOutputs()).resolves.toBeNull();
        vi.setSystemTime(new Date('2026-07-30T00:00:20.001Z'));
        await expect(svc.getStackOutputs()).resolves.toBe(outputs);
      });

      it('should NOT apply the null TTL to a resolved StackOutputs value — it stays cached indefinitely until invalidateCache', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
        const pulumi = makePulumiService();
        const outputs = { awsRegion: 'us-west-2' } as StackOutputs;
        vi.mocked(pulumi.getStackOutputs).mockResolvedValue(outputs);
        const svc = new ConfigService(makeElectronStore(), pulumi);

        await svc.getStackOutputs();
        vi.setSystemTime(new Date('2026-07-30T01:00:00.000Z')); // 1 hour later, well past the null TTL
        await expect(svc.getStackOutputs()).resolves.toBe(outputs);

        expect(pulumi.getStackOutputs).toHaveBeenCalledOnce();
      });

      it('should coalesce concurrent calls onto a single refetch when the cached null has just expired', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
        const pulumi = makePulumiService();
        vi.mocked(pulumi.getStackOutputs).mockResolvedValue(null);
        const svc = new ConfigService(makeElectronStore(), pulumi);

        await svc.getStackOutputs();
        vi.setSystemTime(new Date('2026-07-30T00:00:20.001Z'));

        // Both calls observe the same expired cache entry synchronously
        // (before either's refetch has a chance to settle and update the
        // null-TTL bookkeeping) — they must coalesce onto one underlying
        // call, not each kick off their own.
        await Promise.all([svc.getStackOutputs(), svc.getStackOutputs()]);

        expect(pulumi.getStackOutputs).toHaveBeenCalledTimes(2); // 1 initial + 1 coalesced refetch
      });
    });
  });

  describe('getRegion', () => {
    it('should use aws.region from the electron store when available', () => {
      const store = makeElectronStore();
      store.set('aws', { region: 'ap-south-1' });
      const svc = new ConfigService(store, makePulumiService());
      expect(svc.getRegion()).toBe('ap-south-1');
    });

    it('should fall back to readEnvRegion when no aws.region is stored', () => {
      vi.spyOn(service, 'readEnvRegion').mockReturnValue('eu-west-3');
      expect(service.getRegion()).toBe('eu-west-3');
    });

    it('should fall back to us-east-1 when no aws.region is stored and no env region', () => {
      vi.spyOn(service, 'readEnvRegion').mockReturnValue(undefined);
      expect(service.getRegion()).toBe('us-east-1');
    });
  });

  describe('getActiveCloud', () => {
    it('should return aws', () => {
      expect(service.getActiveCloud()).toBe('aws');
    });
  });

  describe('readEnvConfigCacheTtlMs', () => {
    afterEach(() => {
      delete process.env['CONFIG_CACHE_TTL_MS'];
    });

    it('should default to 30000 when CONFIG_CACHE_TTL_MS is unset', () => {
      delete process.env['CONFIG_CACHE_TTL_MS'];
      expect(service.readEnvConfigCacheTtlMs()).toBe(30000);
    });

    it('should default to 30000 when CONFIG_CACHE_TTL_MS is empty', () => {
      process.env['CONFIG_CACHE_TTL_MS'] = '';
      expect(service.readEnvConfigCacheTtlMs()).toBe(30000);
    });

    it('should parse a valid CONFIG_CACHE_TTL_MS value', () => {
      process.env['CONFIG_CACHE_TTL_MS'] = '60000';
      expect(service.readEnvConfigCacheTtlMs()).toBe(60000);
    });

    it('should default to 30000 and warn when CONFIG_CACHE_TTL_MS is not a number', () => {
      process.env['CONFIG_CACHE_TTL_MS'] = 'not-a-number';
      expect(service.readEnvConfigCacheTtlMs()).toBe(30000);
    });

    it('should default to 30000 when CONFIG_CACHE_TTL_MS is negative', () => {
      process.env['CONFIG_CACHE_TTL_MS'] = '-1';
      expect(service.readEnvConfigCacheTtlMs()).toBe(30000);
    });

    it('should default to 30000 when CONFIG_CACHE_TTL_MS is zero', () => {
      process.env['CONFIG_CACHE_TTL_MS'] = '0';
      expect(service.readEnvConfigCacheTtlMs()).toBe(30000);
    });
  });

  describe('getConfigurationBucket', () => {
    afterEach(() => {
      delete process.env['HYVEON_CONFIG_BUCKET'];
    });

    it('should return the HYVEON_CONFIG_BUCKET env var value when set, even when a configuration bucket is also stored', () => {
      process.env['HYVEON_CONFIG_BUCKET'] = 'my-project-config';
      const configuredService = new ConfigService(makeElectronStore('stored-bucket'), makePulumiService());
      expect(configuredService.getConfigurationBucket()).toBe('my-project-config');
    });

    it('should return the configured bootstrap.configurationBucket from ElectronStoreService when HYVEON_CONFIG_BUCKET is unset', () => {
      const configuredService = new ConfigService(makeElectronStore('operator-configured-bucket'), makePulumiService());
      expect(configuredService.getConfigurationBucket()).toBe('operator-configured-bucket');
    });

    it('should return null when neither the env var nor a stored bootstrap.configurationBucket resolve', () => {
      expect(service.getConfigurationBucket()).toBeNull();
    });
  });
});
