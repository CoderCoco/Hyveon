import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { GamesHttpController } from './games-http.controller.js';
import type { ConfigService, TfOutputs } from '../services/ConfigService.js';
import type { EcsService } from '../services/EcsService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Minimal TfOutputs for HTTP-shim tests. */
const DEFAULT_OUTPUTS: Partial<TfOutputs> = {
  game_names: ['minecraft', 'valheim'],
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

/** Build an EcsService stub with mutation and query methods pre-wired to succeed. */
function makeEcs(): EcsService {
  return {
    getStatus: vi.fn().mockResolvedValue({ game: 'minecraft', state: 'stopped' }),
    start: vi.fn().mockResolvedValue({ success: true, message: 'Task launched' }),
    stop: vi.fn().mockResolvedValue({ success: true, message: 'Task stopped' }),
  } as unknown as EcsService;
}

describe('GamesHttpController', () => {
  describe('listGames', () => {
    it('should invalidate the tfstate cache before reading game names', () => {
      const config = makeConfig();
      new GamesHttpController(config, makeEcs()).listGames();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
    });

    it('should return game names from Terraform outputs', () => {
      const result = new GamesHttpController(makeConfig(), makeEcs()).listGames();
      expect(result).toEqual({ games: ['minecraft', 'valheim'] });
    });

    it('should return an empty games array when Terraform has not been applied yet', () => {
      const result = new GamesHttpController(makeConfig(null), makeEcs()).listGames();
      expect(result).toEqual({ games: [] });
    });
  });

  describe('listStatus', () => {
    it('should invalidate cache before querying ECS', async () => {
      const config = makeConfig();
      await new GamesHttpController(config, makeEcs()).listStatus();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
    });

    it('should query ECS status for every game in the Terraform outputs', async () => {
      const ecs = makeEcs();
      await new GamesHttpController(makeConfig(), ecs).listStatus();
      expect(ecs.getStatus).toHaveBeenCalledWith('minecraft');
      expect(ecs.getStatus).toHaveBeenCalledWith('valheim');
    });

    it('should return an empty array when tfstate is absent', async () => {
      const result = await new GamesHttpController(makeConfig(null), makeEcs()).listStatus();
      expect(result).toEqual([]);
    });

    it('should return status entries in the same order as game_names', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.getStatus).mockImplementation(async (g) => ({ game: g, state: 'stopped' as const }));
      const result = await new GamesHttpController(makeConfig(), ecs).listStatus();
      expect(result.map((s) => s.game)).toEqual(['minecraft', 'valheim']);
    });
  });

  describe('getStatus', () => {
    it('should delegate to EcsService without invalidating the tfstate cache', async () => {
      const config = makeConfig();
      const ecs = makeEcs();
      await new GamesHttpController(config, ecs).getStatus('minecraft');
      expect(config.invalidateCache).not.toHaveBeenCalled();
      expect(ecs.getStatus).toHaveBeenCalledWith('minecraft');
    });

    it('should return the status provided by EcsService', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.getStatus).mockResolvedValue({ game: 'minecraft', state: 'running' });
      const result = await new GamesHttpController(makeConfig(), ecs).getStatus('minecraft');
      expect(result).toEqual({ game: 'minecraft', state: 'running' });
    });
  });

  describe('start', () => {
    it('should delegate to EcsService.start with the requested game name', async () => {
      const ecs = makeEcs();
      await new GamesHttpController(makeConfig(), ecs).start('valheim');
      expect(ecs.start).toHaveBeenCalledWith('valheim');
    });

    it('should return the result from EcsService.start', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.start).mockResolvedValue({ success: true, message: 'running', taskArn: 'arn:task' });
      const result = await new GamesHttpController(makeConfig(), ecs).start('minecraft');
      expect(result).toMatchObject({ success: true, taskArn: 'arn:task' });
    });
  });

  describe('stop', () => {
    it('should delegate to EcsService.stop with the requested game name', async () => {
      const ecs = makeEcs();
      await new GamesHttpController(makeConfig(), ecs).stop('minecraft');
      expect(ecs.stop).toHaveBeenCalledWith('minecraft');
    });

    it('should return the result from EcsService.stop', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.stop).mockResolvedValue({ success: true, message: 'stopped' });
      const result = await new GamesHttpController(makeConfig(), ecs).stop('minecraft');
      expect(result).toMatchObject({ success: true, message: 'stopped' });
    });
  });
});
