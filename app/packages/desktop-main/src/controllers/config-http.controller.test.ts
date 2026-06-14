import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ConfigHttpController } from './config-http.controller.js';
import type { ConfigService, WatchdogConfig } from '../services/ConfigService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Default watchdog settings used by most tests. */
const DEFAULT_CONFIG: WatchdogConfig = {
  watchdog_interval_minutes: 15,
  watchdog_idle_checks: 4,
  watchdog_min_packets: 100,
};

/** Build a ConfigService stub wired up with the provided watchdog config. */
function makeConfig(current: WatchdogConfig = DEFAULT_CONFIG): ConfigService {
  return {
    getConfig: vi.fn().mockReturnValue(current),
    saveConfig: vi.fn(),
  } as unknown as ConfigService;
}

describe('ConfigHttpController', () => {
  describe('get', () => {
    it('should return the current watchdog config from ConfigService', () => {
      const result = new ConfigHttpController(makeConfig()).get();
      expect(result).toEqual(DEFAULT_CONFIG);
    });
  });

  describe('update', () => {
    it('should merge a partial body with the current config and return success', () => {
      const config = makeConfig();
      const result = new ConfigHttpController(config).update({ watchdog_interval_minutes: 30 });
      expect(result.success).toBe(true);
      expect(result.config.watchdog_interval_minutes).toBe(30);
      // Fields not in the body should retain their current values.
      expect(result.config.watchdog_idle_checks).toBe(4);
      expect(result.config.watchdog_min_packets).toBe(100);
    });

    it('should persist the merged config to disk via ConfigService.saveConfig', () => {
      const config = makeConfig();
      new ConfigHttpController(config).update({ watchdog_idle_checks: 6 });
      expect(config.saveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ watchdog_idle_checks: 6 }),
      );
    });

    it('should leave all fields unchanged when the body is empty', () => {
      const config = makeConfig();
      const result = new ConfigHttpController(config).update({});
      expect(result.config).toEqual(DEFAULT_CONFIG);
    });

    it('should update all three fields at once when all are supplied', () => {
      const config = makeConfig();
      const result = new ConfigHttpController(config).update({
        watchdog_interval_minutes: 5,
        watchdog_idle_checks: 2,
        watchdog_min_packets: 50,
      });
      expect(result.config).toEqual({
        watchdog_interval_minutes: 5,
        watchdog_idle_checks: 2,
        watchdog_min_packets: 50,
      });
    });
  });
});
