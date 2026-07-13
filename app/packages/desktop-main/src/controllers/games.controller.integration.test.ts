/**
 * Integration test for `GamesController.listGames()` — exercises a *real*
 * `TfvarsService` (parsing real HCL via `@cdktf/hcl2json`, exactly as
 * `TfvarsService.test.ts` does) wired into a real `GamesController`, with
 * only the filesystem, `RemoteFileStore`, and `ConfigService` stubbed. This
 * complements `games.controller.test.ts` (which stubs `TfvarsService`
 * entirely) by proving the merged `GameListEntry[]` shape produced by
 * `mergeGameLists` (see issue #92) holds up end-to-end when the declared view
 * comes from genuine tfvars parsing rather than a canned fixture array.
 *
 * Covers all three merge states surfaced by `mergeGameLists`:
 *  - declared-only (tfvars has an entry with no matching tfstate game name)
 *  - deployed-only (tfstate has a game name with no matching tfvars entry)
 *  - both (a game name present in both the parsed tfvars and tfstate outputs)
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readFileSync, existsSync } from 'fs';
import type { RemoteFileStore } from '@hyveon/shared';
import { GamesController } from './games.controller.js';
import { TfvarsService } from '../services/TfvarsService.js';
import type { ConfigService, TfOutputs } from '../services/ConfigService.js';
import type { EcsService } from '../services/EcsService.js';

/** Strongly-typed mock handles for the `fs` module. */
const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);

/**
 * Real tfvars HCL text declaring a single game, `ark`. Reused across
 * scenarios; each scenario controls which tfstate `game_names` overlap with
 * it to drive the merge state under test.
 */
const TFVARS_DECLARING_ARK = `
aws_region   = "us-east-1"
project_name = "game-servers"

game_servers = {
  ark = {
    image  = "example/ark-server:latest"
    cpu    = 2048
    memory = 8192
    ports = [
      { container = 7777, protocol = "udp" },
    ]
    volumes = [
      { name = "saves", container_path = "/ark" },
    ]
  }
}
`;

/** Expected `GameServer` shape parsed out of {@link TFVARS_DECLARING_ARK}. */
const EXPECTED_ARK_CONFIG = {
  name: 'ark',
  image: 'example/ark-server:latest',
  cpu: 2048,
  memory: 8192,
  ports: [{ container: 7777, protocol: 'udp' }],
  volumes: [{ name: 'saves', container_path: '/ark' }],
};

/** Fake `RemoteFileStore` — unused in local mode but required by the constructor. */
function makeRemoteFileStore(): RemoteFileStore {
  return {
    get: vi.fn(),
    put: vi.fn(),
    listVersions: vi.fn(),
  } as unknown as RemoteFileStore;
}

/** Builds a `ConfigService` stub exposing just what `TfvarsService`/`GamesController` read. */
function makeConfig(gameNames: string[]): ConfigService {
  const outputs: Partial<TfOutputs> = { game_names: gameNames };
  return {
    invalidateCache: vi.fn(),
    getTfOutputs: vi.fn().mockReturnValue(outputs),
    getTfvarsBucket: () => null,
    getTfvarsPath: () => '/repo/terraform/terraform.tfvars',
    readEnvTfvarsCacheTtlMs: () => 30000,
  } as unknown as ConfigService;
}

/** Minimal `EcsService` stub — `listGames()` never calls it, but the constructor requires it. */
function makeEcs(): EcsService {
  return {} as EcsService;
}

describe('GamesController + TfvarsService integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should report a game as declared-only when it exists in tfvars but not in tfstate', async () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(TFVARS_DECLARING_ARK);

    const config = makeConfig([]); // nothing deployed yet
    const tfvars = new TfvarsService(config, makeRemoteFileStore());
    const controller = new GamesController(config, makeEcs(), tfvars);

    const result = await controller.listGames();

    expect(result).toEqual({
      games: [{ name: 'ark', declared: true, deployed: false, config: EXPECTED_ARK_CONFIG }],
    });
  });

  it('should report a game as deployed-only when it exists in tfstate but not in tfvars', async () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(TFVARS_DECLARING_ARK); // declares "ark" only

    const config = makeConfig(['minecraft']); // deployed game name unrelated to tfvars
    const tfvars = new TfvarsService(config, makeRemoteFileStore());
    const controller = new GamesController(config, makeEcs(), tfvars);

    const result = await controller.listGames();

    expect(result).toEqual({
      games: [
        { name: 'ark', declared: true, deployed: false, config: EXPECTED_ARK_CONFIG },
        { name: 'minecraft', declared: false, deployed: true },
      ],
    });
  });

  it('should report a game as both declared and deployed when its name is present in tfvars and tfstate', async () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(TFVARS_DECLARING_ARK);

    const config = makeConfig(['ark']); // same name as the declared tfvars entry
    const tfvars = new TfvarsService(config, makeRemoteFileStore());
    const controller = new GamesController(config, makeEcs(), tfvars);

    const result = await controller.listGames();

    expect(result).toEqual({
      games: [{ name: 'ark', declared: true, deployed: true, config: EXPECTED_ARK_CONFIG }],
    });
  });
});
