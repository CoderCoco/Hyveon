import { describe, it, expect, vi } from 'vitest';
import type { GameServer, StackOutputs } from '@hyveon/shared';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '../logger.js';
import { DriftService, computeDrift } from './DriftService.js';
import type { ConfigService } from './ConfigService.js';
import type { DeploymentConfigService } from './DeploymentConfigService.js';

/** Minimal, valid `GameServer` fixture for a single declared game. */
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

/** Minimal StackOutputs for DriftService tests. */
const DEFAULT_OUTPUTS: Partial<StackOutputs> = {
  gameNames: ['minecraft'],
  appliedGameServers: {
    minecraft: {
      image: 'example/image:latest',
      cpu: 1024,
      memory: 2048,
      ports: [{ container: 25565, protocol: 'tcp' }],
      volumes: [{ name: 'saves', container_path: '/data' }],
    },
  },
};

/**
 * Build a ConfigService stub. Pass `null` to simulate a pre-deploy state
 * where `getStackOutputs()` resolves to null.
 */
function makeConfig(outputs: Partial<StackOutputs> | null = DEFAULT_OUTPUTS): ConfigService {
  return {
    invalidateCache: vi.fn(),
    getStackOutputs: vi.fn().mockResolvedValue(outputs),
  } as Partial<ConfigService> as ConfigService;
}

/** Build a DeploymentConfigService stub with `invalidateCache` and `getGameServers` pre-wired. */
function makeDeploymentConfig(declared: GameServer[] = []): DeploymentConfigService {
  return {
    invalidateCache: vi.fn(),
    getGameServers: vi.fn().mockResolvedValue(declared),
  } as Partial<DeploymentConfigService> as DeploymentConfigService;
}

describe('computeDrift', () => {
  it('should report pending_create when a declared game is absent from deployedNames', () => {
    const ark = buildGameServer('ark');

    const result = computeDrift([ark], null, []);

    expect(result).toEqual({ entries: [{ game: 'ark', kind: 'pending_create' }] });
  });

  it('should report pending_delete when a deployed game is absent from declared', () => {
    const result = computeDrift([], null, ['minecraft']);

    expect(result).toEqual({ entries: [{ game: 'minecraft', kind: 'pending_delete' }] });
  });

  it('should report config_drift with the exact set of changed fields when declared and applied configs differ', () => {
    const declared = buildGameServer('minecraft', { cpu: 2048, ports: [{ container: 25566, protocol: 'tcp' }] });
    const applied = { image: 'example/image:latest', cpu: 1024, memory: 2048, ports: [{ container: 25565, protocol: 'tcp' }], volumes: [{ name: 'saves', container_path: '/data' }] };

    const result = computeDrift([declared], { minecraft: applied }, ['minecraft']);

    expect(result).toEqual({
      entries: [{ game: 'minecraft', kind: 'config_drift', changedFields: ['cpu', 'ports'] }],
    });
  });

  it('should omit a game entirely when declared and applied configs match on every compared field', () => {
    const minecraft = buildGameServer('minecraft');
    const applied = { image: minecraft.image, cpu: minecraft.cpu, memory: minecraft.memory, ports: minecraft.ports, volumes: minecraft.volumes };

    const result = computeDrift([minecraft], { minecraft: applied }, ['minecraft']);

    expect(result).toEqual({ entries: [] });
  });

  it('should report every declared game as pending_create when nothing is deployed', () => {
    const ark = buildGameServer('ark');
    const rust = buildGameServer('rust');

    const result = computeDrift([ark, rust], null, []);

    expect(result).toEqual({
      entries: [
        { game: 'ark', kind: 'pending_create' },
        { game: 'rust', kind: 'pending_create' },
      ],
    });
  });

  it('should use game_names as the deployed set (not treat it as empty) when applied_game_servers is null but the game is already listed in game_names', () => {
    const minecraft = buildGameServer('minecraft');

    // Simulates DriftService.getDrift() falling back to `game_names` when
    // `applied_game_servers` is null (state predates the output).
    const result = computeDrift([minecraft], null, ['minecraft']);

    expect(result).toEqual({ entries: [] });
  });

  it('should report pending_delete for a game_names-only game even when applied_game_servers is null', () => {
    const result = computeDrift([], null, ['minecraft']);

    expect(result).toEqual({ entries: [{ game: 'minecraft', kind: 'pending_delete' }] });
  });

  it('should not report config_drift for ports/volumes that differ only in element order', () => {
    const declared = buildGameServer('minecraft', {
      ports: [
        { container: 25566, protocol: 'udp' },
        { container: 25565, protocol: 'tcp' },
      ],
      volumes: [
        { name: 'config', container_path: '/config' },
        { name: 'saves', container_path: '/data' },
      ],
    });
    const applied = {
      image: declared.image,
      cpu: declared.cpu,
      memory: declared.memory,
      ports: [
        { container: 25565, protocol: 'tcp' },
        { container: 25566, protocol: 'udp' },
      ],
      volumes: [
        { name: 'saves', container_path: '/data' },
        { name: 'config', container_path: '/config' },
      ],
    };

    const result = computeDrift([declared], { minecraft: applied }, ['minecraft']);

    expect(result).toEqual({ entries: [] });
  });

  it('should order entries as declared config order first, then deployed-only entries in deployedNames order', () => {
    const ark = buildGameServer('ark');

    const result = computeDrift([ark], null, ['zomboid', 'terraria']);

    expect(result).toEqual({
      entries: [
        { game: 'ark', kind: 'pending_create' },
        { game: 'zomboid', kind: 'pending_delete' },
        { game: 'terraria', kind: 'pending_delete' },
      ],
    });
  });

  it.each<[keyof Omit<GameServer, 'name'>, Partial<GameServer>]>([
    ['image', { image: 'other/image:latest' }],
    ['cpu', { cpu: 4096 }],
    ['memory', { memory: 4096 }],
    ['ports', { ports: [{ container: 12345, protocol: 'tcp' }] }],
    ['volumes', { volumes: [{ name: 'other', container_path: '/other' }] }],
  ])('should report config_drift with changedFields: [%s] when only the %s field differs', (field, override) => {
    const declared = buildGameServer('minecraft', override);
    const applied = {
      image: 'example/image:latest',
      cpu: 1024,
      memory: 2048,
      ports: [{ container: 25565, protocol: 'tcp' }],
      volumes: [{ name: 'saves', container_path: '/data' }],
    };

    const result = computeDrift([declared], { minecraft: applied }, ['minecraft']);

    expect(result).toEqual({
      entries: [{ game: 'minecraft', kind: 'config_drift', changedFields: [field] }],
    });
  });

  it('should report a mix of pending_create, config_drift, pending_delete, and in-sync games in a single report', () => {
    const ark = buildGameServer('ark');
    const minecraft = buildGameServer('minecraft', { cpu: 4096 });
    const rust = buildGameServer('rust');
    const appliedMinecraft = { image: minecraft.image, cpu: 1024, memory: minecraft.memory, ports: minecraft.ports, volumes: minecraft.volumes };
    const appliedRust = { image: rust.image, cpu: rust.cpu, memory: rust.memory, ports: rust.ports, volumes: rust.volumes };

    const result = computeDrift(
      [ark, minecraft, rust],
      { minecraft: appliedMinecraft, rust: appliedRust },
      ['minecraft', 'rust', 'zomboid'],
    );

    expect(result).toEqual({
      entries: [
        { game: 'ark', kind: 'pending_create' },
        { game: 'minecraft', kind: 'config_drift', changedFields: ['cpu'] },
        { game: 'zomboid', kind: 'pending_delete' },
      ],
    });
  });
});

describe('DriftService', () => {
  describe('getDrift', () => {
    it('should NOT invalidate the stack-outputs cache — this method backs a 30-second dashboard poll, and eagerly invalidating a cache fronting an expensive Pulumi round-trip would turn an idle dashboard into a steady stream of engine-resolution + S3 calls', async () => {
      const config = makeConfig();
      await new DriftService(makeDeploymentConfig(), config).getDrift();
      expect(config.invalidateCache).not.toHaveBeenCalled();
    });

    it('should invalidate the DeploymentConfigService cache before reading state', async () => {
      const deploymentConfig = makeDeploymentConfig();
      await new DriftService(deploymentConfig, makeConfig()).getDrift();
      expect(deploymentConfig.invalidateCache).toHaveBeenCalledOnce();
    });

    it('should report every declared game as pending_create when the stack has never been applied', async () => {
      const ark = buildGameServer('ark');

      const result = await new DriftService(makeDeploymentConfig([ark]), makeConfig(null)).getDrift();

      expect(result).toEqual({ entries: [{ game: 'ark', kind: 'pending_create' }] });
    });

    it('should not report pending_create for a game already present in game_names when applied_game_servers is null', async () => {
      const minecraft = buildGameServer('minecraft');
      const outputs: Partial<StackOutputs> = { gameNames: ['minecraft'], appliedGameServers: null };

      const result = await new DriftService(makeDeploymentConfig([minecraft]), makeConfig(outputs)).getDrift();

      expect(result).toEqual({ entries: [] });
    });

    it('should report pending_delete from game_names when applied_game_servers is null and the game is no longer declared', async () => {
      const outputs: Partial<StackOutputs> = { gameNames: ['minecraft'], appliedGameServers: null };

      const result = await new DriftService(makeDeploymentConfig([]), makeConfig(outputs)).getDrift();

      expect(result).toEqual({ entries: [{ game: 'minecraft', kind: 'pending_delete' }] });
    });

    it('should report config_drift when the declared config no longer matches the applied config', async () => {
      const minecraft = buildGameServer('minecraft', { cpu: 4096 });

      const result = await new DriftService(makeDeploymentConfig([minecraft]), makeConfig()).getDrift();

      expect(result).toEqual({
        entries: [{ game: 'minecraft', kind: 'config_drift', changedFields: ['cpu'] }],
      });
    });

    it('should report a mixed/degraded report combining pending_create, config_drift, and pending_delete entries', async () => {
      const ark = buildGameServer('ark');
      const minecraft = buildGameServer('minecraft', { cpu: 4096 });
      const outputs: Partial<StackOutputs> = {
        gameNames: ['minecraft', 'zomboid'],
        appliedGameServers: {
          minecraft: {
            image: minecraft.image,
            cpu: 1024,
            memory: minecraft.memory,
            ports: minecraft.ports,
            volumes: minecraft.volumes,
          },
          zomboid: {
            image: 'zomboid/image:latest',
            cpu: 512,
            memory: 1024,
            ports: [],
            volumes: [],
          },
        },
      };

      const result = await new DriftService(makeDeploymentConfig([ark, minecraft]), makeConfig(outputs)).getDrift();

      expect(result).toEqual({
        entries: [
          { game: 'ark', kind: 'pending_create' },
          { game: 'minecraft', kind: 'config_drift', changedFields: ['cpu'] },
          { game: 'zomboid', kind: 'pending_delete' },
        ],
      });
    });

    it('should log a warning and rethrow with just the message when getGameServers fails', async () => {
      vi.mocked(logger.warn).mockClear();
      const deploymentConfig = {
        invalidateCache: vi.fn(),
        getGameServers: vi.fn().mockRejectedValue(new Error('S3 access denied')),
      } as Partial<DeploymentConfigService> as DeploymentConfigService;

      await expect(new DriftService(deploymentConfig, makeConfig()).getDrift()).rejects.toThrow(
        'S3 access denied',
      );

      expect(logger.warn).toHaveBeenCalledWith('DriftService.getDrift: failed to compute drift', {
        error: 'S3 access denied',
      });
    });

    it('should log a warning and rethrow with just the message when getStackOutputs fails', async () => {
      vi.mocked(logger.warn).mockClear();
      const config = {
        invalidateCache: vi.fn(),
        getStackOutputs: vi.fn().mockRejectedValue(new Error('Pulumi engine unavailable')),
      } as Partial<ConfigService> as ConfigService;

      await expect(new DriftService(makeDeploymentConfig([]), config).getDrift()).rejects.toThrow(
        'Pulumi engine unavailable',
      );

      expect(logger.warn).toHaveBeenCalledWith('DriftService.getDrift: failed to compute drift', {
        error: 'Pulumi engine unavailable',
      });
    });
  });
});
