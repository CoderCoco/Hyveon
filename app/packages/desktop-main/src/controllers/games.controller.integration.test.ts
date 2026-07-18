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
  writeFileSync: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readFileSync, existsSync, writeFileSync } from 'fs';
import type { RemoteFileStore } from '@hyveon/shared';
import { RemoteFileConflictError } from '@hyveon/shared';
import { GamesController } from './games.controller.js';
import { TfvarsService } from '../services/TfvarsService.js';
import { GamesWriteService } from '../services/GamesWriteService.js';
import type { ConfigService, TfOutputs } from '../services/ConfigService.js';
import type { EcsService } from '../services/EcsService.js';
import type { AuditService } from '../services/AuditService.js';

/** Strongly-typed mock handles for the `fs` module. */
const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);

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
  const store: Partial<RemoteFileStore> = {
    get: vi.fn(),
    put: vi.fn(),
    listVersions: vi.fn(),
  };
  return store as RemoteFileStore;
}

/**
 * Builds a `RemoteFileStore` stub whose `get`/`put` remain directly-controllable
 * `vi.fn()` spies (unlike {@link makeRemoteFileStore}, which erases the mock
 * type) — used by the S3-mode conflict spec below to queue per-call
 * responses, mirroring `TfvarsService.write.test.ts`'s `makeRemoteFileStore()`.
 */
function makeSpyableRemoteFileStore(): RemoteFileStore & {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
} {
  const store: Partial<RemoteFileStore> = {
    get: vi.fn(),
    put: vi.fn(),
    listVersions: vi.fn(),
  };
  return store as RemoteFileStore & { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
}

/**
 * Builds a `ConfigService` stub exposing just what `TfvarsService`/`GamesController`
 * read. `bucket` defaults to `null` (local mode); pass a bucket name to
 * select S3 mode for the conflict spec below.
 */
function makeConfig(gameNames: string[], bucket: string | null = null): ConfigService {
  const outputs: Partial<TfOutputs> = { game_names: gameNames };
  const config: Partial<ConfigService> = {
    invalidateCache: vi.fn(),
    getTfOutputs: vi.fn().mockReturnValue(outputs),
    getTfvarsBucket: () => bucket,
    getTfvarsPath: () => '/repo/terraform/terraform.tfvars',
    readEnvTfvarsCacheTtlMs: () => 30000,
  };
  return config as ConfigService;
}

/** Minimal `EcsService` stub — none of the specs in this file call it, but the constructor requires it. */
function makeEcs(): EcsService {
  return {} as EcsService;
}

/** Minimal `AuditService` stub — none of the specs in this file assert on it, but `GamesWriteService`'s constructor requires it. */
function makeAudit(): AuditService {
  return { record: vi.fn().mockResolvedValue(undefined) } as Partial<AuditService> as AuditService;
}

/** Valid, structurally-distinct config used by the `games.create` specs below (a different game from `ark`). */
const VALID_MINECRAFT_CONFIG = {
  image: 'example/minecraft-server:latest',
  cpu: 1024,
  memory: 2048,
  ports: [{ container: 25565, protocol: 'tcp' }],
  volumes: [{ name: 'saves', container_path: '/data' }],
};

/** Replacement fields for the `ark` entry used by the `games.update` spec below — deliberately different from {@link EXPECTED_ARK_CONFIG}. */
const UPDATED_ARK_CONFIG = {
  image: 'example/ark-server:v2',
  cpu: 4096,
  memory: 16384,
  ports: [{ container: 7777, protocol: 'udp' }],
  volumes: [{ name: 'saves', container_path: '/ark' }],
};

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

/**
 * Write-then-read round trip specs (see issue #98): a real `GamesWriteService`
 * (wired to the same real `TfvarsService` + mocked `fs` used above) performs
 * the `games.create` / `games.update` / `games.delete` mutation, and a
 * subsequent `listGames()` call — re-reading through the same mocked `fs`,
 * seeded with the HCL the write actually produced — proves the mutation is
 * visible in the merged games list end-to-end, not just asserted against the
 * `GameWriteResult` return value in isolation.
 *
 * `mockRead`/`mockWrite` are backed by a single mutable `currentHcl` string
 * per test: `mockWrite` overwrites it on every call and `mockRead` always
 * returns whatever it currently holds, so `GamesWriteService`'s own
 * post-write `tfvars.getGameServers()` call (inside `successResult()`) sees
 * the mutation immediately — matching how the real filesystem behaves —
 * rather than requiring a manual `mockRead.mockReturnValue(...)` reset after
 * the fact.
 */
describe('GamesController + GamesWriteService write-then-list round trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should rewrite the tfvars HCL and show the new game as declared on a subsequent games.list when games.create writes a valid entry', async () => {
    let currentHcl = TFVARS_DECLARING_ARK;
    mockExists.mockReturnValue(true);
    mockRead.mockImplementation(() => currentHcl);
    mockWrite.mockImplementation((_path, data) => {
      currentHcl = data as string;
    });

    const config = makeConfig([]);
    const tfvars = new TfvarsService(config, makeRemoteFileStore());
    const gamesWrite = new GamesWriteService(config, tfvars, makeAudit());
    const controller = new GamesController(config, makeEcs(), tfvars, gamesWrite);

    const createResult = await controller.createGame({ name: 'minecraft', config: VALID_MINECRAFT_CONFIG });

    expect(createResult.ok).toBe(true);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(currentHcl).toContain('minecraft = {');
    if (createResult.ok) {
      expect(createResult.game).toEqual({ name: 'minecraft', ...VALID_MINECRAFT_CONFIG });
      expect(createResult.games).toHaveLength(2);
      expect(createResult.games).toEqual(
        expect.arrayContaining([
          { name: 'ark', declared: true, deployed: false, config: EXPECTED_ARK_CONFIG },
          {
            name: 'minecraft',
            declared: true,
            deployed: false,
            config: { name: 'minecraft', ...VALID_MINECRAFT_CONFIG },
          },
        ]),
      );
    }

    const listResult = await controller.listGames();

    expect(listResult.games).toHaveLength(2);
    expect(listResult.games).toEqual(
      expect.arrayContaining([
        { name: 'ark', declared: true, deployed: false, config: EXPECTED_ARK_CONFIG },
        {
          name: 'minecraft',
          declared: true,
          deployed: false,
          config: { name: 'minecraft', ...VALID_MINECRAFT_CONFIG },
        },
      ]),
    );
  });

  it("should replace the entry's fields in the emitted HCL and show them updated on a subsequent games.list when games.update writes a valid config", async () => {
    let currentHcl = TFVARS_DECLARING_ARK;
    mockExists.mockReturnValue(true);
    mockRead.mockImplementation(() => currentHcl);
    mockWrite.mockImplementation((_path, data) => {
      currentHcl = data as string;
    });

    const config = makeConfig([]);
    const tfvars = new TfvarsService(config, makeRemoteFileStore());
    const gamesWrite = new GamesWriteService(config, tfvars, makeAudit());
    const controller = new GamesController(config, makeEcs(), tfvars, gamesWrite);

    const updateResult = await controller.updateGame({ name: 'ark', config: UPDATED_ARK_CONFIG });

    expect(updateResult.ok).toBe(true);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(currentHcl).toContain('example/ark-server:v2');
    expect(currentHcl).not.toContain(EXPECTED_ARK_CONFIG.image);
    if (updateResult.ok) {
      expect(updateResult.game).toEqual({ name: 'ark', ...UPDATED_ARK_CONFIG });
      expect(updateResult.games).toEqual([
        { name: 'ark', declared: true, deployed: false, config: { name: 'ark', ...UPDATED_ARK_CONFIG } },
      ]);
    }

    const listResult = await controller.listGames();

    expect(listResult).toEqual({
      games: [{ name: 'ark', declared: true, deployed: false, config: { name: 'ark', ...UPDATED_ARK_CONFIG } }],
    });
  });

  it('should remove the entry so it no longer appears on a subsequent games.list when games.delete succeeds', async () => {
    let currentHcl = TFVARS_DECLARING_ARK;
    mockExists.mockReturnValue(true);
    mockRead.mockImplementation(() => currentHcl);
    mockWrite.mockImplementation((_path, data) => {
      currentHcl = data as string;
    });

    const config = makeConfig([]);
    const tfvars = new TfvarsService(config, makeRemoteFileStore());
    const gamesWrite = new GamesWriteService(config, tfvars, makeAudit());
    const controller = new GamesController(config, makeEcs(), tfvars, gamesWrite);

    const deleteResult = await controller.deleteGame({ name: 'ark' });

    expect(deleteResult.ok).toBe(true);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(currentHcl).not.toContain('ark = {');
    if (deleteResult.ok) {
      expect(deleteResult.game).toBeUndefined();
      expect(deleteResult.games).toEqual([]);
    }

    const listResult = await controller.listGames();

    expect(listResult).toEqual({ games: [] });
  });
});

/**
 * Failure-path specs for `games.create` (see issue #98): a business-rule
 * validation failure (Fargate cpu/memory mismatch) must write nothing, and a
 * stale S3-mode etag must surface as a `'conflict'` result carrying the
 * store's current version id — exercised against a real `GamesWriteService`
 * + `TfvarsService`, with only the `RemoteFileStore` stubbed to simulate the
 * conflicting write (mirroring `TfvarsService.write.test.ts`'s S3-mode specs).
 */
describe('GamesController + GamesWriteService games.create failure paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should surface code 'validation' with a per-field issue and write nothing when the proposed config has a Fargate cpu/memory mismatch", async () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(TFVARS_DECLARING_ARK);

    const config = makeConfig([]);
    const tfvars = new TfvarsService(config, makeRemoteFileStore());
    const gamesWrite = new GamesWriteService(config, tfvars, makeAudit());
    const controller = new GamesController(config, makeEcs(), tfvars, gamesWrite);

    const result = await controller.createGame({
      name: 'invalid-pairing',
      // cpu=256 only pairs with memory 512/1024/2048 MiB — 4096 is not a valid pairing.
      config: { ...VALID_MINECRAFT_CONFIG, cpu: 256, memory: 4096 },
    });

    expect(result).toEqual({
      ok: false,
      code: 'validation',
      issues: expect.arrayContaining([expect.objectContaining({ path: 'memory' })]),
    });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("should surface code 'conflict' with the current version id when an S3-mode write hits a stale etag", async () => {
    const remoteFileStore = makeSpyableRemoteFileStore();
    remoteFileStore.get
      // 1st get(): GamesWriteService.createGame()'s sibling lookup (getGameServers()).
      .mockResolvedValueOnce({ body: new TextEncoder().encode(TFVARS_DECLARING_ARK), etag: 'etag-1' })
      // 2nd get(): TfvarsService.writeTfvars()'s fetchRawTfvars() before mutating.
      .mockResolvedValueOnce({ body: new TextEncoder().encode(TFVARS_DECLARING_ARK), etag: 'etag-1' })
      // 3rd+ get(): the follow-up read TfvarsService issues after the conflict, to report the current etag.
      .mockResolvedValue({ body: new TextEncoder().encode(TFVARS_DECLARING_ARK), etag: 'etag-2' });
    remoteFileStore.put.mockRejectedValue(
      new RemoteFileConflictError('terraform.tfvars', 'Conflicting write detected.', 'etag-1'),
    );

    const config = makeConfig([], 'my-tfvars-bucket');
    const tfvars = new TfvarsService(config, remoteFileStore);
    const gamesWrite = new GamesWriteService(config, tfvars, makeAudit());
    const controller = new GamesController(config, makeEcs(), tfvars, gamesWrite);

    const result = await controller.createGame({
      name: 'minecraft',
      config: VALID_MINECRAFT_CONFIG,
      expectedVersionId: 'etag-1',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'conflict',
      expectedVersionId: 'etag-1',
      currentVersionId: 'etag-2',
    });
  });
});
