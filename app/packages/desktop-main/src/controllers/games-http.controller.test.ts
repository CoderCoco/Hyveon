import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ConflictException, HttpException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import type { GameServer, GameWriteResult } from '@hyveon/shared';
import { GamesHttpController } from './games-http.controller.js';
import type { ConfigService, TfOutputs } from '../services/ConfigService.js';
import type { EcsService } from '../services/EcsService.js';
import type { TfvarsService } from '../services/TfvarsService.js';
import type { GamesWriteService } from '../services/GamesWriteService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Minimal TfOutputs for HTTP-shim tests. */
const DEFAULT_OUTPUTS: Partial<TfOutputs> = {
  game_names: ['minecraft', 'valheim'],
};

/** Minimal, valid `GameServer` fixture for a single declared game. */
function buildGameServer(name: string): GameServer {
  return {
    name,
    image: 'example/image:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'saves', container_path: '/data' }],
  };
}

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

/**
 * Build a TfvarsService stub with `invalidateCache` and `getGameServers`
 * pre-wired. Defaults to an empty declared list so `listGames` tests that
 * don't care about the declared view can ignore it.
 */
function makeTfvars(declared: GameServer[] = []): TfvarsService {
  return {
    invalidateCache: vi.fn(),
    getGameServers: vi.fn().mockResolvedValue(declared),
  } as Partial<TfvarsService> as TfvarsService;
}

/** Build a GamesWriteService stub with all three write methods pre-wired to spies. */
function makeGamesWrite(): GamesWriteService {
  return {
    createGame: vi.fn(),
    updateGame: vi.fn(),
    deleteGame: vi.fn(),
  } as unknown as GamesWriteService;
}

/** Build a successful `GameWriteResult` for use in write-endpoint tests. */
function buildWriteSuccess(game?: GameServer): GameWriteResult {
  return { ok: true, game, games: [] };
}

/** Build a controller instance with default (unused) collaborators, wired to the given `GamesWriteService` stub. */
function makeController(gamesWrite: GamesWriteService): GamesHttpController {
  return new GamesHttpController(makeConfig(), makeEcs(), makeTfvars(), gamesWrite);
}

describe('GamesHttpController', () => {
  describe('listGames', () => {
    it('should invalidate the tfstate cache before reading game names', async () => {
      const config = makeConfig();
      await new GamesHttpController(config, makeEcs(), makeTfvars(), makeGamesWrite()).listGames();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
    });

    it('should invalidate the TfvarsService cache before reading game names', async () => {
      const tfvars = makeTfvars();
      await new GamesHttpController(makeConfig(), makeEcs(), tfvars, makeGamesWrite()).listGames();
      expect(tfvars.invalidateCache).toHaveBeenCalledOnce();
    });

    it('should return the merged declared/deployed games list', async () => {
      const valheim = buildGameServer('valheim');
      const result = await new GamesHttpController(
        makeConfig(),
        makeEcs(),
        makeTfvars([valheim]),
        makeGamesWrite(),
      ).listGames();
      expect(result).toEqual({
        games: [
          { name: 'valheim', declared: true, deployed: true, config: valheim },
          { name: 'minecraft', declared: false, deployed: true },
        ],
      });
    });

    it('should return an empty games array when Terraform has not been applied yet and nothing is declared', async () => {
      const result = await new GamesHttpController(
        makeConfig(null),
        makeEcs(),
        makeTfvars(),
        makeGamesWrite(),
      ).listGames();
      expect(result).toEqual({ games: [] });
    });
  });

  describe('listStatus', () => {
    it('should invalidate cache before querying ECS', async () => {
      const config = makeConfig();
      await new GamesHttpController(config, makeEcs(), makeTfvars(), makeGamesWrite()).listStatus();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
    });

    it('should invalidate the TfvarsService cache before querying ECS', async () => {
      const tfvars = makeTfvars();
      await new GamesHttpController(makeConfig(), makeEcs(), tfvars, makeGamesWrite()).listStatus();
      expect(tfvars.invalidateCache).toHaveBeenCalledOnce();
    });

    it('should query ECS status for every game in the Terraform outputs', async () => {
      const ecs = makeEcs();
      await new GamesHttpController(makeConfig(), ecs, makeTfvars(), makeGamesWrite()).listStatus();
      expect(ecs.getStatus).toHaveBeenCalledWith('minecraft');
      expect(ecs.getStatus).toHaveBeenCalledWith('valheim');
    });

    it('should return an empty array when tfstate is absent', async () => {
      const result = await new GamesHttpController(
        makeConfig(null),
        makeEcs(),
        makeTfvars(),
        makeGamesWrite(),
      ).listStatus();
      expect(result).toEqual([]);
    });

    it('should return status entries in the same order as game_names', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.getStatus).mockImplementation(async (g) => ({ game: g, state: 'stopped' as const }));
      const result = await new GamesHttpController(makeConfig(), ecs, makeTfvars(), makeGamesWrite()).listStatus();
      expect(result.map((s) => s.game)).toEqual(['minecraft', 'valheim']);
    });
  });

  describe('getStatus', () => {
    it('should delegate to EcsService without invalidating the tfstate cache', async () => {
      const config = makeConfig();
      const ecs = makeEcs();
      await new GamesHttpController(config, ecs, makeTfvars(), makeGamesWrite()).getStatus('minecraft');
      expect(config.invalidateCache).not.toHaveBeenCalled();
      expect(ecs.getStatus).toHaveBeenCalledWith('minecraft');
    });

    it('should return the status provided by EcsService', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.getStatus).mockResolvedValue({ game: 'minecraft', state: 'running' });
      const result = await new GamesHttpController(makeConfig(), ecs, makeTfvars(), makeGamesWrite()).getStatus(
        'minecraft',
      );
      expect(result).toEqual({ game: 'minecraft', state: 'running' });
    });
  });

  describe('start', () => {
    it('should delegate to EcsService.start with the requested game name', async () => {
      const ecs = makeEcs();
      await new GamesHttpController(makeConfig(), ecs, makeTfvars(), makeGamesWrite()).start('valheim');
      expect(ecs.start).toHaveBeenCalledWith('valheim');
    });

    it('should return the result from EcsService.start', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.start).mockResolvedValue({ success: true, message: 'running', taskArn: 'arn:task' });
      const result = await new GamesHttpController(makeConfig(), ecs, makeTfvars(), makeGamesWrite()).start(
        'minecraft',
      );
      expect(result).toMatchObject({ success: true, taskArn: 'arn:task' });
    });
  });

  describe('stop', () => {
    it('should delegate to EcsService.stop with the requested game name', async () => {
      const ecs = makeEcs();
      await new GamesHttpController(makeConfig(), ecs, makeTfvars(), makeGamesWrite()).stop('minecraft');
      expect(ecs.stop).toHaveBeenCalledWith('minecraft');
    });

    it('should return the result from EcsService.stop', async () => {
      const ecs = makeEcs();
      vi.mocked(ecs.stop).mockResolvedValue({ success: true, message: 'stopped' });
      const result = await new GamesHttpController(makeConfig(), ecs, makeTfvars(), makeGamesWrite()).stop(
        'minecraft',
      );
      expect(result).toMatchObject({ success: true, message: 'stopped' });
    });
  });

  describe('createGame', () => {
    it('should forward the If-Match header as expectedVersionId', async () => {
      const gamesWrite = makeGamesWrite();
      vi.mocked(gamesWrite.createGame).mockResolvedValue(buildWriteSuccess(buildGameServer('valheim')));
      const config = buildGameServer('valheim');
      await makeController(gamesWrite).createGame({ name: 'valheim', config }, 'etag-1');
      expect(gamesWrite.createGame).toHaveBeenCalledWith({
        name: 'valheim',
        config,
        expectedVersionId: 'etag-1',
      });
    });

    it('should forward undefined expectedVersionId when no If-Match header is sent', async () => {
      const gamesWrite = makeGamesWrite();
      vi.mocked(gamesWrite.createGame).mockResolvedValue(buildWriteSuccess());
      const config = buildGameServer('valheim');
      await makeController(gamesWrite).createGame({ name: 'valheim', config });
      expect(gamesWrite.createGame).toHaveBeenCalledWith(
        expect.objectContaining({ expectedVersionId: undefined }),
      );
    });

    it('should return the success body with status 200 semantics when the write succeeds', async () => {
      const gamesWrite = makeGamesWrite();
      const success = buildWriteSuccess(buildGameServer('valheim'));
      vi.mocked(gamesWrite.createGame).mockResolvedValue(success);
      const result = await makeController(gamesWrite).createGame({
        name: 'valheim',
        config: buildGameServer('valheim'),
      });
      expect(result).toEqual(success);
    });

    it('should throw ConflictException with both version ids when the result code is conflict', async () => {
      const gamesWrite = makeGamesWrite();
      vi.mocked(gamesWrite.createGame).mockResolvedValue({
        ok: false,
        code: 'conflict',
        expectedVersionId: 'stale',
        currentVersionId: 'fresh',
        message: 'stale tfvars version',
      });
      const controller = makeController(gamesWrite);
      await expect(
        controller.createGame({ name: 'valheim', config: buildGameServer('valheim') }, 'stale'),
      ).rejects.toThrow(ConflictException);
      await expect(
        controller.createGame({ name: 'valheim', config: buildGameServer('valheim') }, 'stale'),
      ).rejects.toMatchObject({
        response: { currentVersionId: 'fresh', expectedVersionId: 'stale' },
      });
    });

    it('should throw an HttpException with status 422 and the issues array when the result code is validation', async () => {
      const gamesWrite = makeGamesWrite();
      vi.mocked(gamesWrite.createGame).mockResolvedValue({
        ok: false,
        code: 'validation',
        issues: [{ path: 'name', message: 'name is required' }],
      });
      const controller = makeController(gamesWrite);
      await expect(controller.createGame({ name: '', config: buildGameServer('valheim') })).rejects.toThrow(
        HttpException,
      );
      await expect(controller.createGame({ name: '', config: buildGameServer('valheim') })).rejects.toMatchObject({
        status: 422,
        response: { issues: [{ path: 'name', message: 'name is required' }] },
      });
    });

    it('should throw InternalServerErrorException when the result code is error', async () => {
      const gamesWrite = makeGamesWrite();
      vi.mocked(gamesWrite.createGame).mockResolvedValue({
        ok: false,
        code: 'error',
        message: 'disk full',
      });
      await expect(
        makeController(gamesWrite).createGame({ name: 'valheim', config: buildGameServer('valheim') }),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('updateGame', () => {
    it('should forward the route param name, body config, and If-Match header to GamesWriteService.updateGame', async () => {
      const gamesWrite = makeGamesWrite();
      vi.mocked(gamesWrite.updateGame).mockResolvedValue(buildWriteSuccess(buildGameServer('valheim')));
      const config = buildGameServer('valheim');
      await makeController(gamesWrite).updateGame('valheim', { config }, 'etag-2');
      expect(gamesWrite.updateGame).toHaveBeenCalledWith({
        name: 'valheim',
        config,
        expectedVersionId: 'etag-2',
      });
    });

    it('should return the success body when the write succeeds', async () => {
      const gamesWrite = makeGamesWrite();
      const success = buildWriteSuccess(buildGameServer('valheim'));
      vi.mocked(gamesWrite.updateGame).mockResolvedValue(success);
      const result = await makeController(gamesWrite).updateGame('valheim', { config: buildGameServer('valheim') });
      expect(result).toEqual(success);
    });

    it('should throw NotFoundException when the result code is not_found', async () => {
      const gamesWrite = makeGamesWrite();
      vi.mocked(gamesWrite.updateGame).mockResolvedValue({
        ok: false,
        code: 'not_found',
        message: 'no such game',
      });
      await expect(
        makeController(gamesWrite).updateGame('missing', { config: buildGameServer('missing') }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException when the result code is conflict', async () => {
      const gamesWrite = makeGamesWrite();
      vi.mocked(gamesWrite.updateGame).mockResolvedValue({
        ok: false,
        code: 'conflict',
        expectedVersionId: 'stale',
        currentVersionId: 'fresh',
        message: 'stale tfvars version',
      });
      await expect(
        makeController(gamesWrite).updateGame('valheim', { config: buildGameServer('valheim') }, 'stale'),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw an HttpException with status 422 when the result code is validation', async () => {
      const gamesWrite = makeGamesWrite();
      vi.mocked(gamesWrite.updateGame).mockResolvedValue({
        ok: false,
        code: 'validation',
        issues: [{ path: 'ports', message: 'port collision' }],
      });
      await expect(
        makeController(gamesWrite).updateGame('valheim', { config: buildGameServer('valheim') }),
      ).rejects.toMatchObject({ status: 422 });
    });

    it('should throw InternalServerErrorException when the result code is error', async () => {
      const gamesWrite = makeGamesWrite();
      vi.mocked(gamesWrite.updateGame).mockResolvedValue({ ok: false, code: 'error', message: 'io error' });
      await expect(
        makeController(gamesWrite).updateGame('valheim', { config: buildGameServer('valheim') }),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('deleteGame', () => {
    it('should forward the route param name and If-Match header to GamesWriteService.deleteGame', async () => {
      const gamesWrite = makeGamesWrite();
      vi.mocked(gamesWrite.deleteGame).mockResolvedValue(buildWriteSuccess());
      await makeController(gamesWrite).deleteGame('valheim', 'etag-3');
      expect(gamesWrite.deleteGame).toHaveBeenCalledWith({ name: 'valheim', expectedVersionId: 'etag-3' });
    });

    it('should return the success body when the delete succeeds', async () => {
      const gamesWrite = makeGamesWrite();
      const success = buildWriteSuccess();
      vi.mocked(gamesWrite.deleteGame).mockResolvedValue(success);
      const result = await makeController(gamesWrite).deleteGame('valheim');
      expect(result).toEqual(success);
    });

    it('should throw NotFoundException when the result code is not_found', async () => {
      const gamesWrite = makeGamesWrite();
      vi.mocked(gamesWrite.deleteGame).mockResolvedValue({ ok: false, code: 'not_found', message: 'no such game' });
      await expect(makeController(gamesWrite).deleteGame('missing')).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException with both version ids when the result code is conflict', async () => {
      const gamesWrite = makeGamesWrite();
      vi.mocked(gamesWrite.deleteGame).mockResolvedValue({
        ok: false,
        code: 'conflict',
        expectedVersionId: 'stale',
        currentVersionId: 'fresh',
        message: 'stale tfvars version',
      });
      await expect(makeController(gamesWrite).deleteGame('valheim', 'stale')).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(makeController(gamesWrite).deleteGame('valheim', 'stale')).rejects.toMatchObject({
        response: { currentVersionId: 'fresh', expectedVersionId: 'stale' },
      });
    });

    it('should throw InternalServerErrorException when the result code is error', async () => {
      const gamesWrite = makeGamesWrite();
      vi.mocked(gamesWrite.deleteGame).mockResolvedValue({ ok: false, code: 'error', message: 'io error' });
      await expect(makeController(gamesWrite).deleteGame('valheim')).rejects.toThrow(InternalServerErrorException);
    });
  });
});
