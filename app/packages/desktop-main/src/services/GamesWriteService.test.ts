import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { GameServer } from '@hyveon/shared';
import { OptimisticLockError } from '@hyveon/shared';
import { GamesWriteService } from './GamesWriteService.js';
import type { ConfigService, TfOutputs } from './ConfigService.js';
import type { TfvarsService } from './TfvarsService.js';
import { HclSurgeonError } from './hclSurgeon.js';
import { logger } from '../logger.js';

/** Minimal, valid `GameServer` fixture matching the Fargate cpu/memory pairing table. */
function buildGameServer(name: string, overrides: Partial<GameServer> = {}): GameServer {
  return {
    name,
    image: 'example/image:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'saves', container_path: '/data' }],
    ...overrides,
  };
}

/** Structurally-valid config payload (everything but `name`) for a `CreateGamePayload`/`UpdateGamePayload`. */
function buildConfig(overrides: Partial<Omit<GameServer, 'name'>> = {}): Omit<GameServer, 'name'> {
  const { name: _name, ...config } = buildGameServer('unused', overrides);
  return config;
}

/** Build a ConfigService stub with `invalidateCache`, `getTfOutputs`, and `getTfvarsBucket` pre-wired. */
function makeConfig(options: { outputs?: Partial<TfOutputs> | null; bucket?: string | null } = {}): ConfigService {
  const { outputs = { game_names: [] }, bucket = null } = options;
  return {
    invalidateCache: vi.fn(),
    getTfOutputs: vi.fn().mockReturnValue(outputs),
    getTfvarsBucket: vi.fn().mockReturnValue(bucket),
  } as Partial<ConfigService> as ConfigService;
}

/** Build a TfvarsService stub with every method `GamesWriteService` touches pre-wired to succeed. */
function makeTfvars(declared: GameServer[] = []): TfvarsService {
  return {
    invalidateCache: vi.fn(),
    getGameServers: vi.fn().mockResolvedValue(declared),
    addGameServer: vi.fn().mockResolvedValue(undefined),
    updateGameServer: vi.fn().mockResolvedValue(undefined),
    removeGameServer: vi.fn().mockResolvedValue(undefined),
  } as Partial<TfvarsService> as TfvarsService;
}

describe('GamesWriteService', () => {
  beforeEach(() => {
    vi.mocked(logger.info).mockClear();
  });

  describe('createGame', () => {
    it('should write the new entry and return the updated game plus the refreshed games list on success', async () => {
      const tfvars = makeTfvars();
      const config = makeConfig({ outputs: { game_names: ['minecraft'] } });
      const service = new GamesWriteService(config, tfvars);

      const result = await service.createGame({ name: 'ark', config: buildConfig(), expectedVersionId: 'v1' });

      expect(tfvars.addGameServer).toHaveBeenCalledWith('ark', buildConfig(), 'v1');
      expect(tfvars.invalidateCache).toHaveBeenCalledOnce();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.game).toEqual(buildGameServer('ark'));
        expect(result.games).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'minecraft' })]));
      }
    });

    it('should emit a structured audit log entry noting local mode when no tfvars bucket is configured', async () => {
      const service = new GamesWriteService(makeConfig({ bucket: null }), makeTfvars());

      await service.createGame({ name: 'ark', config: buildConfig() });

      expect(logger.info).toHaveBeenCalledWith('Game server write', { action: 'create', game: 'ark', mode: 'local' });
    });

    it('should emit a structured audit log entry noting s3 mode when a tfvars bucket is configured', async () => {
      const service = new GamesWriteService(makeConfig({ bucket: 'my-bucket' }), makeTfvars());

      await service.createGame({ name: 'ark', config: buildConfig() });

      expect(logger.info).toHaveBeenCalledWith('Game server write', { action: 'create', game: 'ark', mode: 's3' });
    });

    it('should return a validation failure without writing when the proposed config fails business-rule validation', async () => {
      const tfvars = makeTfvars();
      const service = new GamesWriteService(makeConfig(), tfvars);

      const result = await service.createGame({ name: 'ark', config: buildConfig({ cpu: 256, memory: 4096 }) });

      expect(result).toEqual({
        ok: false,
        code: 'validation',
        issues: expect.arrayContaining([expect.objectContaining({ path: 'memory' })]),
      });
      expect(tfvars.addGameServer).not.toHaveBeenCalled();
    });

    it('should return a conflict result with both etags when the write raises OptimisticLockError', async () => {
      const tfvars = makeTfvars();
      tfvars.addGameServer = vi.fn().mockRejectedValue(new OptimisticLockError('old-etag', 'new-etag'));
      const service = new GamesWriteService(makeConfig(), tfvars);

      const result = await service.createGame({ name: 'ark', config: buildConfig(), expectedVersionId: 'old-etag' });

      expect(result).toMatchObject({
        ok: false,
        code: 'conflict',
        expectedVersionId: 'old-etag',
        currentVersionId: 'new-etag',
      });
    });

    it('should return a validation failure with a name-path issue when the entry name already exists', async () => {
      const tfvars = makeTfvars();
      tfvars.addGameServer = vi
        .fn()
        .mockRejectedValue(
          new HclSurgeonError(
            'Entry "ark" already exists in "game_servers" — use updateGameServer() instead.',
            'duplicate-name',
          ),
        );
      const service = new GamesWriteService(makeConfig(), tfvars);

      const result = await service.createGame({ name: 'ark', config: buildConfig() });

      expect(result).toEqual({
        ok: false,
        code: 'validation',
        issues: [{ path: 'name', message: expect.stringContaining('already exists') }],
      });
    });

    it('should return a catch-all error result when the write raises an unexpected error', async () => {
      const tfvars = makeTfvars();
      const originalError = new Error('disk full');
      tfvars.addGameServer = vi.fn().mockRejectedValue(originalError);
      const service = new GamesWriteService(makeConfig(), tfvars);
      const loggerErrorSpy = vi.spyOn(logger, 'error');

      const result = await service.createGame({ name: 'ark', config: buildConfig() });

      expect(result).toEqual({
        ok: false,
        code: 'error',
        message: 'An unexpected error occurred while writing the game server configuration',
      });
      expect(loggerErrorSpy).toHaveBeenCalledWith('Game server write failed', { err: originalError });
    });

    it('should return a catch-all error result (not a name-validation issue) when addGameServer() throws a structural HclSurgeonError', async () => {
      const tfvars = makeTfvars();
      const structuralError = new HclSurgeonError('"game_servers" map not found in tfvars source.');
      tfvars.addGameServer = vi.fn().mockRejectedValue(structuralError);
      const service = new GamesWriteService(makeConfig(), tfvars);
      const loggerErrorSpy = vi.spyOn(logger, 'error');

      const result = await service.createGame({ name: 'ark', config: buildConfig() });

      expect(result).toEqual({
        ok: false,
        code: 'error',
        message: 'An unexpected error occurred while writing the game server configuration',
      });
      expect(loggerErrorSpy).toHaveBeenCalledWith('Game server write failed', { err: structuralError });
    });
  });

  describe('updateGame', () => {
    it('should write the updated entry and return the updated game plus the refreshed games list on success', async () => {
      const tfvars = makeTfvars([buildGameServer('minecraft')]);
      const config = makeConfig({ outputs: { game_names: ['minecraft'] } });
      const service = new GamesWriteService(config, tfvars);
      const newConfig = buildConfig({ cpu: 2048, memory: 4096 });

      const result = await service.updateGame({ name: 'minecraft', config: newConfig, expectedVersionId: 'v1' });

      expect(tfvars.updateGameServer).toHaveBeenCalledWith('minecraft', newConfig, 'v1');
      expect(tfvars.invalidateCache).toHaveBeenCalledOnce();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.game).toEqual(buildGameServer('minecraft', { cpu: 2048, memory: 4096 }));
      }
    });

    it('should return a validation failure without writing when the proposed config fails business-rule validation', async () => {
      const tfvars = makeTfvars([buildGameServer('minecraft')]);
      const service = new GamesWriteService(makeConfig(), tfvars);

      const result = await service.updateGame({
        name: 'minecraft',
        config: buildConfig({ cpu: 256, memory: 4096 }),
      });

      expect(result).toMatchObject({ ok: false, code: 'validation' });
      expect(tfvars.updateGameServer).not.toHaveBeenCalled();
    });

    it('should return a conflict result with both etags when the write raises OptimisticLockError', async () => {
      const tfvars = makeTfvars([buildGameServer('minecraft')]);
      tfvars.updateGameServer = vi.fn().mockRejectedValue(new OptimisticLockError('old-etag', 'new-etag'));
      const service = new GamesWriteService(makeConfig(), tfvars);

      const result = await service.updateGame({
        name: 'minecraft',
        config: buildConfig(),
        expectedVersionId: 'old-etag',
      });

      expect(result).toMatchObject({
        ok: false,
        code: 'conflict',
        expectedVersionId: 'old-etag',
        currentVersionId: 'new-etag',
      });
    });

    it('should return a not_found result when the target game does not exist in game_servers', async () => {
      const tfvars = makeTfvars([buildGameServer('minecraft')]);
      tfvars.updateGameServer = vi.fn().mockRejectedValue(new HclSurgeonError('Entry "ark" not found in "game_servers".'));
      const service = new GamesWriteService(makeConfig(), tfvars);

      const result = await service.updateGame({
        name: 'ark',
        config: buildConfig({ ports: [{ container: 7777, protocol: 'udp' }] }),
      });

      expect(result).toEqual({ ok: false, code: 'not_found', message: expect.stringContaining('not found') });
    });
  });

  describe('deleteGame', () => {
    it('should remove the entry and return the refreshed games list without a game field on success', async () => {
      const tfvars = makeTfvars([buildGameServer('minecraft')]);
      const config = makeConfig({ outputs: { game_names: [] } });
      const service = new GamesWriteService(config, tfvars);

      const result = await service.deleteGame({ name: 'minecraft', expectedVersionId: 'v1' });

      expect(tfvars.removeGameServer).toHaveBeenCalledWith('minecraft', 'v1');
      expect(tfvars.invalidateCache).toHaveBeenCalledOnce();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.game).toBeUndefined();
      }
    });

    it('should emit a structured audit log entry with the game name even though no game object is returned', async () => {
      const tfvars = makeTfvars([buildGameServer('minecraft')]);
      const service = new GamesWriteService(makeConfig({ bucket: 'my-bucket' }), tfvars);

      await service.deleteGame({ name: 'minecraft' });

      expect(logger.info).toHaveBeenCalledWith('Game server write', { action: 'delete', game: 'minecraft', mode: 's3' });
    });

    it('should return a conflict result with both etags when the write raises OptimisticLockError', async () => {
      const tfvars = makeTfvars([buildGameServer('minecraft')]);
      tfvars.removeGameServer = vi.fn().mockRejectedValue(new OptimisticLockError('old-etag', 'new-etag'));
      const service = new GamesWriteService(makeConfig(), tfvars);

      const result = await service.deleteGame({ name: 'minecraft', expectedVersionId: 'old-etag' });

      expect(result).toMatchObject({
        ok: false,
        code: 'conflict',
        expectedVersionId: 'old-etag',
        currentVersionId: 'new-etag',
      });
    });

    it('should return a not_found result when the target game does not exist in game_servers', async () => {
      const tfvars = makeTfvars([]);
      tfvars.removeGameServer = vi.fn().mockRejectedValue(new HclSurgeonError('Entry "ark" not found in "game_servers".'));
      const service = new GamesWriteService(makeConfig(), tfvars);

      const result = await service.deleteGame({ name: 'ark' });

      expect(result).toEqual({ ok: false, code: 'not_found', message: expect.stringContaining('not found') });
    });
  });
});
