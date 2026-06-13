import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { GamesController } from './games.controller.js';
import type { ConfigService, TfOutputs } from '../services/ConfigService.js';
import type { EcsService } from '../services/EcsService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Minimal TfOutputs for games-controller tests. */
const DEFAULT_OUTPUTS: Partial<TfOutputs> = {
  game_names: ['minecraft', 'palworld'],
};

/**
 * Build a ConfigService stub. Pass `null` to simulate a pre-apply state
 * where `getTfOutputs()` returns null.
 */
function makeConfig(outputs: Partial<TfOutputs> | null = DEFAULT_OUTPUTS): ConfigService {
  return {
    invalidateCache: vi.fn(),
    getTfOutputs: vi.fn().mockReturnValue(outputs),
  } as unknown as ConfigService;
}

/** Build an EcsService stub with all mutation methods pre-wired to succeed. */
function makeEcs(): EcsService {
  return {
    getStatus: vi.fn().mockResolvedValue({ game: 'minecraft', state: 'stopped' }),
    start: vi.fn().mockResolvedValue({ success: true, message: 'Task launched' }),
    stop: vi.fn().mockResolvedValue({ success: true, message: 'Task stopped' }),
  } as unknown as EcsService;
}

/**
 * The metadata key NestJS stores on each method decorated with
 * `@MessagePattern`. Asserting this value is the only automated guard
 * that prevents a typo in the controller from silently breaking IPC —
 * calling the method directly (as every other test does) would succeed
 * regardless of what string is registered with the transport.
 */
const PATTERN_METADATA_KEY = 'microservices:pattern';

describe('GamesController', () => {
  describe('@MessagePattern channel names', () => {
    it('should register listGames on the "games.list" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, GamesController.prototype.listGames);
      expect(pattern).toEqual(['games.list']);
    });

    it('should register listStatus on the "games.status" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, GamesController.prototype.listStatus);
      expect(pattern).toEqual(['games.status']);
    });

    it('should register getStatus on the "games.getStatus" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, GamesController.prototype.getStatus);
      expect(pattern).toEqual(['games.getStatus']);
    });

    it('should register start on the "games.start" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, GamesController.prototype.start);
      expect(pattern).toEqual(['games.start']);
    });

    it('should register stop on the "games.stop" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, GamesController.prototype.stop);
      expect(pattern).toEqual(['games.stop']);
    });
  });

  describe('listGames', () => {
    it('should invalidate the tfstate cache before reading game names', () => {
      const config = makeConfig();
      new GamesController(config, makeEcs()).listGames();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
    });

    it('should return the game names from Terraform outputs', () => {
      const result = new GamesController(makeConfig(), makeEcs()).listGames();
      expect(result).toEqual({ games: ['minecraft', 'palworld'] });
    });

    it('should return an empty games array when Terraform has not been applied yet', () => {
      const result = new GamesController(makeConfig(null), makeEcs()).listGames();
      expect(result).toEqual({ games: [] });
    });
  });

  describe('listStatus', () => {
    it('should invalidate cache before querying ECS', async () => {
      const config = makeConfig();
      await new GamesController(config, makeEcs()).listStatus();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
    });

    it('should query ECS status for every game in the Terraform outputs', async () => {
      const ecs = makeEcs();
      await new GamesController(makeConfig(), ecs).listStatus();
      expect(ecs.getStatus).toHaveBeenCalledWith('minecraft');
      expect(ecs.getStatus).toHaveBeenCalledWith('palworld');
    });

    it('should return an empty array when tfstate is absent', async () => {
      const result = await new GamesController(makeConfig(null), makeEcs()).listStatus();
      expect(result).toEqual([]);
    });

    it('should return status entries in the same order as game_names', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.getStatus).mockImplementation(async (g) => ({ game: g, state: 'stopped' as const }));
      const result = await new GamesController(makeConfig(), ecs).listStatus();
      expect(result.map((s) => s.game)).toEqual(['minecraft', 'palworld']);
    });
  });

  describe('getStatus', () => {
    it('should delegate to EcsService without invalidating the tfstate cache via the IPC transport', async () => {
      const config = makeConfig();
      const ecs = makeEcs();
      // Simulates ElectronIPCTransport: @Payload() delivers the game name as the sole argument.
      await new GamesController(config, ecs).getStatus('minecraft');
      expect(config.invalidateCache).not.toHaveBeenCalled();
      expect(ecs.getStatus).toHaveBeenCalledWith('minecraft');
    });

    it('should return whatever EcsService returns via the IPC transport', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.getStatus).mockResolvedValue({ game: 'minecraft', state: 'running' });
      // Simulates ElectronIPCTransport: @Payload() delivers the game name as the sole argument.
      const result = await new GamesController(makeConfig(), ecs).getStatus('minecraft');
      expect(result).toEqual({ game: 'minecraft', state: 'running' });
    });
  });

  describe('start', () => {
    it('should delegate to EcsService.start with the game name received via the IPC payload', async () => {
      const ecs = makeEcs();
      // Simulates ElectronIPCTransport: @Payload() delivers the game name as the sole argument.
      await new GamesController(makeConfig(), ecs).start('palworld');
      expect(ecs.start).toHaveBeenCalledWith('palworld');
    });

    it('should return the result from EcsService.start via the IPC transport', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.start).mockResolvedValue({ success: true, message: 'running', taskArn: 'arn:task' });
      // Simulates ElectronIPCTransport: @Payload() delivers the game name as the sole argument.
      const result = await new GamesController(makeConfig(), ecs).start('minecraft');
      expect(result).toMatchObject({ success: true, taskArn: 'arn:task' });
    });
  });

  describe('stop', () => {
    it('should delegate to EcsService.stop with the game name received via the IPC payload', async () => {
      const ecs = makeEcs();
      // Simulates ElectronIPCTransport: @Payload() delivers the game name as the sole argument.
      await new GamesController(makeConfig(), ecs).stop('minecraft');
      expect(ecs.stop).toHaveBeenCalledWith('minecraft');
    });

    it('should return the result from EcsService.stop via the IPC transport', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.stop).mockResolvedValue({ success: true, message: 'stopped' });
      // Simulates ElectronIPCTransport: @Payload() delivers the game name as the sole argument.
      const result = await new GamesController(makeConfig(), ecs).stop('minecraft');
      expect(result).toMatchObject({ success: true, message: 'stopped' });
    });
  });
});
