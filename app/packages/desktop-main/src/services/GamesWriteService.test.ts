import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { GameServer, StackOutputs } from '@hyveon/shared';
import { OptimisticLockError } from '@hyveon/shared';
import { GamesWriteService } from './GamesWriteService.js';
import type { AuditService } from './AuditService.js';
import type { ConfigService } from './ConfigService.js';
import type { DeploymentConfigService } from './DeploymentConfigService.js';
import { ConfigurationNotConfiguredError, GameServerEntryError } from './DeploymentConfigService.js';
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

/** Build a ConfigService stub with `invalidateCache` and `getStackOutputs` pre-wired. */
function makeConfig(options: { outputs?: Partial<StackOutputs> | null } = {}): ConfigService {
  const { outputs = { gameNames: [] } } = options;
  return {
    invalidateCache: vi.fn(),
    getStackOutputs: vi.fn().mockResolvedValue(outputs),
  } as Partial<ConfigService> as ConfigService;
}

/**
 * Build a DeploymentConfigService stub with every method `GamesWriteService` touches
 * pre-wired to succeed. The write methods (`addGameServer`/`updateGameServer`/
 * `removeGameServer`) resolve to `{ etag, versionId }` matching the real
 * service's return shape, defaulting `versionId` to `'v-new'` so audit
 * assertions have a concrete value to check against.
 */
function makeDeploymentConfig(declared: GameServer[] = [], versionId: string | undefined = 'v-new'): DeploymentConfigService {
  return {
    invalidateCache: vi.fn(),
    getGameServers: vi.fn().mockResolvedValue(declared),
    addGameServer: vi.fn().mockResolvedValue({ etag: 'etag-new', versionId }),
    updateGameServer: vi.fn().mockResolvedValue({ etag: 'etag-new', versionId }),
    removeGameServer: vi.fn().mockResolvedValue({ etag: 'etag-new', versionId }),
  } as Partial<DeploymentConfigService> as DeploymentConfigService;
}

/** Build an AuditService stub with `record()` pre-wired to a no-op `vi.fn()`. */
function makeAudit(): AuditService {
  return {
    record: vi.fn().mockResolvedValue(undefined),
  } as Partial<AuditService> as AuditService;
}

describe('GamesWriteService', () => {
  beforeEach(() => {
    vi.mocked(logger.info).mockClear();
  });

  describe('createGame', () => {
    it('should write the new entry and return the updated game plus the refreshed games list on success', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const config = makeConfig({ outputs: { gameNames: ['minecraft'] } });
      const audit = makeAudit();
      const service = new GamesWriteService(config, deploymentConfig, audit);

      const result = await service.createGame({ name: 'ark', config: buildConfig(), expectedVersionId: 'v1' });

      expect(deploymentConfig.addGameServer).toHaveBeenCalledWith('ark', buildConfig(), 'v1');
      expect(deploymentConfig.invalidateCache).toHaveBeenCalledOnce();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.game).toEqual(buildGameServer('ark'));
        expect(result.games).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'minecraft' })]));
      }
    });

    it('should record an audit entry exactly once with a null before, the validated after, and the write versionId', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);

      await service.createGame({ name: 'ark', config: buildConfig(), expectedVersionId: 'v1' });

      expect(audit.record).toHaveBeenCalledOnce();
      expect(audit.record).toHaveBeenCalledWith({
        action: 'add',
        game: 'ark',
        before: null,
        after: buildGameServer('ark'),
        versionId: 'v-new',
      });
    });

    it('should emit a structured audit log entry noting s3 mode (the only mode; there is no local-file fallback)', async () => {
      const service = new GamesWriteService(makeConfig(), makeDeploymentConfig(), makeAudit());

      await service.createGame({ name: 'ark', config: buildConfig() });

      expect(logger.info).toHaveBeenCalledWith('Game server write', { action: 'create', game: 'ark', mode: 's3' });
    });

    it('should log a debug entry line naming the game being created', async () => {
      const service = new GamesWriteService(makeConfig(), makeDeploymentConfig(), makeAudit());
      const loggerDebugSpy = vi.spyOn(logger, 'debug');

      await service.createGame({ name: 'ark', config: buildConfig() });

      expect(loggerDebugSpy).toHaveBeenCalledWith('GamesWriteService.createGame: creating game server entry', {
        game: 'ark',
      });
    });

    it('should return a validation failure without writing or recording an audit entry when the proposed config fails business-rule validation', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);

      const result = await service.createGame({ name: 'ark', config: buildConfig({ cpu: 256, memory: 4096 }) });

      expect(result).toEqual({
        ok: false,
        code: 'validation',
        issues: expect.arrayContaining([expect.objectContaining({ path: 'memory' })]),
      });
      expect(deploymentConfig.addGameServer).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should return a conflict result without recording an audit entry when the write raises OptimisticLockError', async () => {
      const deploymentConfig = makeDeploymentConfig();
      deploymentConfig.addGameServer = vi.fn().mockRejectedValue(new OptimisticLockError('old-etag', 'new-etag'));
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);

      const result = await service.createGame({ name: 'ark', config: buildConfig(), expectedVersionId: 'old-etag' });

      expect(result).toMatchObject({
        ok: false,
        code: 'conflict',
        expectedVersionId: 'old-etag',
        currentVersionId: 'new-etag',
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should log a warning with both etags when the write raises OptimisticLockError', async () => {
      const deploymentConfig = makeDeploymentConfig();
      deploymentConfig.addGameServer = vi.fn().mockRejectedValue(new OptimisticLockError('old-etag', 'new-etag'));
      const service = new GamesWriteService(makeConfig(), deploymentConfig, makeAudit());
      const loggerWarnSpy = vi.spyOn(logger, 'warn');

      await service.createGame({ name: 'ark', config: buildConfig(), expectedVersionId: 'old-etag' });

      expect(loggerWarnSpy).toHaveBeenCalledWith('Game server write rejected — stale expectedVersionId', {
        message: expect.any(String),
        expectedVersionId: 'old-etag',
        currentVersionId: 'new-etag',
      });
    });

    it('should return a validation failure with a name-path issue without recording an audit entry when the entry name already exists', async () => {
      const deploymentConfig = makeDeploymentConfig();
      deploymentConfig.addGameServer = vi
        .fn()
        .mockRejectedValue(
          new GameServerEntryError(
            'Entry "ark" already exists in "gameServers" — use updateGameServer() instead.',
            'duplicate-name',
          ),
        );
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);

      const result = await service.createGame({ name: 'ark', config: buildConfig() });

      expect(result).toEqual({
        ok: false,
        code: 'validation',
        issues: [{ path: 'name', message: expect.stringContaining('already exists') }],
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should return a catch-all error result without recording an audit entry when the write raises an unexpected error', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const originalError = new Error('disk full');
      deploymentConfig.addGameServer = vi.fn().mockRejectedValue(originalError);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);
      const loggerErrorSpy = vi.spyOn(logger, 'error');

      const result = await service.createGame({ name: 'ark', config: buildConfig() });

      expect(result).toEqual({
        ok: false,
        code: 'error',
        message: 'An unexpected error occurred while writing the game server configuration',
      });
      expect(loggerErrorSpy).toHaveBeenCalledWith('Game server write failed', { err: originalError });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should return a catch-all error result (not a name-validation issue) without recording an audit entry when addGameServer() throws a structural GameServerEntryError', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const structuralError = new GameServerEntryError('"gameServers" map not found in the deployment config JSON.', 'structural');
      deploymentConfig.addGameServer = vi.fn().mockRejectedValue(structuralError);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);
      const loggerErrorSpy = vi.spyOn(logger, 'error');

      const result = await service.createGame({ name: 'ark', config: buildConfig() });

      expect(result).toEqual({
        ok: false,
        code: 'error',
        message: 'An unexpected error occurred while writing the game server configuration',
      });
      expect(loggerErrorSpy).toHaveBeenCalledWith('Game server write failed', { err: structuralError });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should surface a distinct setup_incomplete code (not the generic error code) without recording an audit entry when addGameServer() throws ConfigurationNotConfiguredError', async () => {
      const deploymentConfig = makeDeploymentConfig();
      const notConfiguredError = new ConfigurationNotConfiguredError();
      deploymentConfig.addGameServer = vi.fn().mockRejectedValue(notConfiguredError);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);

      const result = await service.createGame({ name: 'ark', config: buildConfig() });

      expect(result).toEqual({
        ok: false,
        code: 'setup_incomplete',
        message: notConfiguredError.message,
      });
      // Pinned distinctly from the generic catch-all so a caller can tell
      // "setup incomplete" apart from an ordinary unexpected failure.
      expect(result).not.toMatchObject({ code: 'error' });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('updateGame', () => {
    it('should write the updated entry and return the updated game plus the refreshed games list on success', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const config = makeConfig({ outputs: { gameNames: ['minecraft'] } });
      const service = new GamesWriteService(config, deploymentConfig, makeAudit());
      const newConfig = buildConfig({ cpu: 2048, memory: 4096 });

      const result = await service.updateGame({ name: 'minecraft', config: newConfig, expectedVersionId: 'v1' });

      expect(deploymentConfig.updateGameServer).toHaveBeenCalledWith('minecraft', newConfig, 'v1');
      expect(deploymentConfig.invalidateCache).toHaveBeenCalledOnce();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.game).toEqual(buildGameServer('minecraft', { cpu: 2048, memory: 4096 }));
      }
    });

    it('should record an audit entry exactly once with the pre-mutation sibling entry as before, the validated after, and the write versionId', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);
      const newConfig = buildConfig({ cpu: 2048, memory: 4096 });

      await service.updateGame({ name: 'minecraft', config: newConfig, expectedVersionId: 'v1' });

      expect(audit.record).toHaveBeenCalledOnce();
      expect(audit.record).toHaveBeenCalledWith({
        action: 'edit',
        game: 'minecraft',
        before: buildGameServer('minecraft'),
        after: buildGameServer('minecraft', { cpu: 2048, memory: 4096 }),
        versionId: 'v-new',
      });
    });

    it('should return a validation failure without writing or recording an audit entry when the proposed config fails business-rule validation', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);

      const result = await service.updateGame({
        name: 'minecraft',
        config: buildConfig({ cpu: 256, memory: 4096 }),
      });

      expect(result).toMatchObject({ ok: false, code: 'validation' });
      expect(deploymentConfig.updateGameServer).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should return a conflict result without recording an audit entry when the write raises OptimisticLockError', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      deploymentConfig.updateGameServer = vi.fn().mockRejectedValue(new OptimisticLockError('old-etag', 'new-etag'));
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);

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
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should return a not_found result without recording an audit entry when the target game does not exist in gameServers', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      deploymentConfig.updateGameServer = vi.fn().mockRejectedValue(new GameServerEntryError('Entry "ark" not found in "gameServers".', 'not-found'));
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);

      const result = await service.updateGame({
        name: 'ark',
        config: buildConfig({ ports: [{ container: 7777, protocol: 'udp' }] }),
      });

      expect(result).toEqual({ ok: false, code: 'not_found', message: expect.stringContaining('not found') });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should surface a distinct setup_incomplete code (not the generic error code) without recording an audit entry when updateGameServer() throws ConfigurationNotConfiguredError', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const notConfiguredError = new ConfigurationNotConfiguredError();
      deploymentConfig.updateGameServer = vi.fn().mockRejectedValue(notConfiguredError);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);

      const result = await service.updateGame({ name: 'minecraft', config: buildConfig() });

      expect(result).toEqual({ ok: false, code: 'setup_incomplete', message: notConfiguredError.message });
      expect(result).not.toMatchObject({ code: 'error' });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should log a debug entry line naming the game being updated', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const service = new GamesWriteService(makeConfig(), deploymentConfig, makeAudit());
      const loggerDebugSpy = vi.spyOn(logger, 'debug');

      await service.updateGame({ name: 'minecraft', config: buildConfig() });

      expect(loggerDebugSpy).toHaveBeenCalledWith('GamesWriteService.updateGame: updating game server entry', {
        game: 'minecraft',
      });
    });
  });

  describe('deleteGame', () => {
    it('should remove the entry and return the refreshed games list without a game field on success', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const config = makeConfig({ outputs: { gameNames: [] } });
      const service = new GamesWriteService(config, deploymentConfig, makeAudit());

      const result = await service.deleteGame({ name: 'minecraft', expectedVersionId: 'v1' });

      expect(deploymentConfig.removeGameServer).toHaveBeenCalledWith('minecraft', 'v1');
      expect(deploymentConfig.invalidateCache).toHaveBeenCalledOnce();
      expect(config.invalidateCache).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.game).toBeUndefined();
      }
    });

    it('should record an audit entry exactly once with the pre-mutation sibling entry as before, a null after, and the write versionId', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);

      await service.deleteGame({ name: 'minecraft', expectedVersionId: 'v1' });

      expect(audit.record).toHaveBeenCalledOnce();
      expect(audit.record).toHaveBeenCalledWith({
        action: 'remove',
        game: 'minecraft',
        before: buildGameServer('minecraft'),
        after: null,
        versionId: 'v-new',
      });
    });

    it('should emit a structured audit log entry with the game name even though no game object is returned', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const service = new GamesWriteService(makeConfig(), deploymentConfig, makeAudit());

      await service.deleteGame({ name: 'minecraft' });

      expect(logger.info).toHaveBeenCalledWith('Game server write', { action: 'delete', game: 'minecraft', mode: 's3' });
    });

    it('should log a debug entry line naming the game being deleted', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const service = new GamesWriteService(makeConfig(), deploymentConfig, makeAudit());
      const loggerDebugSpy = vi.spyOn(logger, 'debug');

      await service.deleteGame({ name: 'minecraft' });

      expect(loggerDebugSpy).toHaveBeenCalledWith('GamesWriteService.deleteGame: deleting game server entry', {
        game: 'minecraft',
      });
    });

    it('should return a conflict result without recording an audit entry when the write raises OptimisticLockError', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      deploymentConfig.removeGameServer = vi.fn().mockRejectedValue(new OptimisticLockError('old-etag', 'new-etag'));
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);

      const result = await service.deleteGame({ name: 'minecraft', expectedVersionId: 'old-etag' });

      expect(result).toMatchObject({
        ok: false,
        code: 'conflict',
        expectedVersionId: 'old-etag',
        currentVersionId: 'new-etag',
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should return a not_found result without recording an audit entry when the target game does not exist in gameServers', async () => {
      const deploymentConfig = makeDeploymentConfig([]);
      deploymentConfig.removeGameServer = vi.fn().mockRejectedValue(new GameServerEntryError('Entry "ark" not found in "gameServers".', 'not-found'));
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);

      const result = await service.deleteGame({ name: 'ark' });

      expect(result).toEqual({ ok: false, code: 'not_found', message: expect.stringContaining('not found') });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('should surface a distinct setup_incomplete code (not the generic error code) without recording an audit entry when removeGameServer() throws ConfigurationNotConfiguredError', async () => {
      const deploymentConfig = makeDeploymentConfig([buildGameServer('minecraft')]);
      const notConfiguredError = new ConfigurationNotConfiguredError();
      deploymentConfig.removeGameServer = vi.fn().mockRejectedValue(notConfiguredError);
      const audit = makeAudit();
      const service = new GamesWriteService(makeConfig(), deploymentConfig, audit);

      const result = await service.deleteGame({ name: 'minecraft' });

      expect(result).toEqual({ ok: false, code: 'setup_incomplete', message: notConfiguredError.message });
      expect(result).not.toMatchObject({ code: 'error' });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
