/**
 * Tests for `TfvarsService` — the local-vs-S3 tfvars reader/parser.
 *
 * `@cdktf/hcl2json` (the underlying HCL→JSON parser) is exercised for real
 * here rather than mocked, since it's the whole point of the service; only
 * the filesystem, the injected `RemoteFileStore`, and `ConfigService` are
 * stubbed.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RemoteFileStore } from '@hyveon/shared';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { readFileSync, existsSync } from 'fs';
import { TfvarsService } from './TfvarsService.js';
import { ConfigService } from './ConfigService.js';
import { logger } from '../logger.js';

/** Strongly-typed mock handles for the `fs` module. */
const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);

// `vi.mock('fs', ...)` above replaces the module for every specifier that
// resolves to it — including 'node:fs' — so a plain `import { readFileSync }
// from 'node:fs'` would still return the mock. `vi.importActual` bypasses the
// mock entirely and gives back the real module, which is what's needed to
// load the `__fixtures__/*.tfvars` files verbatim from disk below instead of
// duplicating their contents as inline template literals.
const { readFileSync: readFixtureFile } = await vi.importActual<typeof import('fs')>('fs');

/** A minimal, valid `terraform.tfvars` fixture defining a single game server. */
const FIXTURE_TFVARS = `
aws_region   = "us-east-1"
project_name = "game-servers"

game_servers = {
  palworld = {
    image  = "thijsvanloef/palworld-server-docker:latest"
    cpu    = 2048
    memory = 8192
    ports = [
      { container = 8211,  protocol = "udp" },
      { container = 27015, protocol = "udp" },
    ]
    environment = [
      { name = "PLAYERS", value = "16" },
    ]
    volumes = [
      { name = "saves", container_path = "/palworld" },
    ]
    https           = false
    connect_message = "Connect to {host}:{port}"
  }
}
`;

/** Expected `GameServer[]` produced by parsing `FIXTURE_TFVARS`. */
const EXPECTED_GAME_SERVERS = [
  {
    name: 'palworld',
    image: 'thijsvanloef/palworld-server-docker:latest',
    cpu: 2048,
    memory: 8192,
    ports: [
      { container: 8211, protocol: 'udp' },
      { container: 27015, protocol: 'udp' },
    ],
    environment: [{ name: 'PLAYERS', value: '16' }],
    volumes: [{ name: 'saves', container_path: '/palworld' }],
    https: false,
    connect_message: 'Connect to {host}:{port}',
  },
];

/** A `terraform.tfvars` fixture defining two entries in `game_servers`. */
const FIXTURE_MULTIPLE_GAMES = `
game_servers = {
  palworld = {
    image  = "thijsvanloef/palworld-server-docker:latest"
    cpu    = 2048
    memory = 8192
    ports = [
      { container = 8211, protocol = "udp" },
    ]
    volumes = [
      { name = "saves", container_path = "/palworld" },
    ]
  }
  valheim = {
    image  = "lloesche/valheim-server"
    cpu    = 1024
    memory = 4096
    ports = [
      { container = 2456, protocol = "udp" },
    ]
    volumes = [
      { name = "saves", container_path = "/config" },
    ]
  }
}
`;

/** Expected `GameServer[]` produced by parsing `FIXTURE_MULTIPLE_GAMES`. */
const EXPECTED_MULTIPLE_GAME_SERVERS = [
  {
    name: 'palworld',
    image: 'thijsvanloef/palworld-server-docker:latest',
    cpu: 2048,
    memory: 8192,
    ports: [{ container: 8211, protocol: 'udp' }],
    volumes: [{ name: 'saves', container_path: '/palworld' }],
  },
  {
    name: 'valheim',
    image: 'lloesche/valheim-server',
    cpu: 1024,
    memory: 4096,
    ports: [{ container: 2456, protocol: 'udp' }],
    volumes: [{ name: 'saves', container_path: '/config' }],
  },
];

/**
 * `terraform.tfvars` fixture defining two entries (`minecraft`, `terraria`)
 * with only the required `GameServer` fields (`image`, `cpu`, `memory`,
 * `ports`, `volumes`) — every optional field (`environment`, `https`,
 * `connect_message`, `file_seeds`) is omitted entirely. Read from disk via
 * the real `fs` (see `readFixtureFile` above) rather than duplicated inline,
 * so this exercises the actual `__fixtures__/optional-omitted.tfvars` file.
 */
const FIXTURE_OMITTED_OPTIONALS = readFixtureFile(
  new URL('./__fixtures__/optional-omitted.tfvars', import.meta.url),
  'utf-8',
);

/** Expected `GameServer[]` produced by parsing `FIXTURE_OMITTED_OPTIONALS`. */
const EXPECTED_OMITTED_OPTIONALS_GAME_SERVERS = [
  {
    name: 'minecraft',
    image: 'itzg/minecraft-server',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'world', container_path: '/data' }],
  },
  {
    name: 'terraria',
    image: 'ryshe/terraria',
    cpu: 512,
    memory: 1024,
    ports: [{ container: 7777, protocol: 'tcp' }],
    volumes: [{ name: 'world', container_path: '/config' }],
  },
];

/**
 * `terraform.tfvars` fixture exercising the harder HCL constructs
 * `TfvarsService` must tolerate: line comments (`#` and `//`), a block
 * comment, a heredoc `file_seeds` content string, multiple games, and (on
 * the `valheim` entry) Terraform expressions — arithmetic, a for-expression,
 * a ternary, and `format()` calls. Read from disk via the real `fs` (see
 * `readFixtureFile` above) rather than duplicated inline, so this exercises
 * the actual `__fixtures__/complex.tfvars` file.
 */
const FIXTURE_COMPLEX = readFixtureFile(new URL('./__fixtures__/complex.tfvars', import.meta.url), 'utf-8');

/**
 * Expected `GameServer[]` produced by parsing `FIXTURE_COMPLEX`.
 *
 * `@cdktf/hcl2json` does not evaluate Terraform expressions — it only
 * converts HCL syntax to JSON. So on the `valheim` entry, fields written as
 * expressions (`cpu = 1024 * 2`, `ports = [for p in ... ]`,
 * `https = length(...) > 0 ? true : false`, `connect_message = format(...)`)
 * come back as the literal, unevaluated `"${...}"` strings verified below —
 * not the numeric/boolean values a full Terraform evaluation would produce.
 * The `palworld` entry uses plain literals throughout, so it asserts
 * fully-typed values as usual.
 */
const EXPECTED_COMPLEX_GAME_SERVERS = [
  {
    name: 'palworld',
    image: 'thijsvanloef/palworld-server-docker:latest',
    cpu: 2048,
    memory: 8192,
    ports: [
      { container: 8211, protocol: 'udp' },
      { container: 27015, protocol: 'udp' },
    ],
    environment: [
      { name: 'PLAYERS', value: '16' },
      { name: 'SERVER_NAME', value: 'My Palworld Server' },
    ],
    volumes: [
      { name: 'saves', container_path: '/palworld' },
      { name: 'mods', container_path: '/palworld/mods' },
    ],
    https: false,
    connect_message: 'Connect to {host}:{port}',
    file_seeds: [
      {
        path: '/palworld/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini',
        content:
          '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None,DayTimeSpeedRate=1.0,NightTimeSpeedRate=1.0)\n',
      },
      {
        path: '/palworld/Pal/Content/Paks/MyMod.pak',
        content_base64: 'UEsDBBQAAAAIAAAAIQAAAAAAAAAAAAAAAAAA',
        mode: '0644',
      },
    ],
  },
  {
    name: 'valheim',
    image: 'lloesche/valheim-server',
    // Unevaluated Terraform expressions — see the doc comment above.
    cpu: '${1024 * 2}',
    memory: '${4096 + 2048}',
    ports: '${[for p in [2456, 2457, 2458] : { container = p, protocol = "udp" }]}',
    environment: [{ name: 'SERVER_NAME', value: '${format("%s-valheim", "hyveon")}' }],
    volumes: [{ name: 'saves', container_path: '/config' }],
    https: '${length("valheim") > 0 ? true : false}',
    connect_message: '${format("Connect via %s", "the Discord bot")}',
  },
];

/** Fake `RemoteFileStore` whose `get()` is a directly-controllable mock. */
function makeRemoteFileStore(): RemoteFileStore & {
  get: ReturnType<typeof vi.fn>;
} {
  const store: Partial<RemoteFileStore> = {
    get: vi.fn(),
    put: vi.fn(),
    listVersions: vi.fn(),
  };
  return store as RemoteFileStore & { get: ReturnType<typeof vi.fn> };
}

/**
 * Test-only subclass exposing a directly-controllable `now()` mock, so tests
 * can simulate TTL expiry without real timers. Avoids reaching into
 * `TfvarsService`'s protected `now()` via an `as unknown as { now }` cast.
 */
class TestableTfvarsService extends TfvarsService {
  /** Mock backing `now()`; call `nowMock.mockReturnValue(...)` to control the clock. */
  readonly nowMock = vi.fn<[], number>(() => Date.now());

  protected override now(): number {
    return this.nowMock();
  }
}

/**
 * Builds a `ConfigService` stub exposing just the methods `TfvarsService`
 * reads. `bucket: null` selects local mode; any non-null string selects S3
 * mode.
 */
function makeConfig(opts: {
  bucket?: string | null;
  path?: string;
  ttlMs?: number;
}): ConfigService {
  const stub: Partial<ConfigService> = {
    getTfvarsBucket: () => opts.bucket ?? null,
    getTfvarsPath: () => opts.path ?? '/repo/terraform/terraform.tfvars',
    readEnvTfvarsCacheTtlMs: () => opts.ttlMs ?? 30000,
  };
  return stub as ConfigService;
}

describe('TfvarsService', () => {
  let remoteFileStore: RemoteFileStore & { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    remoteFileStore = makeRemoteFileStore();
    vi.clearAllMocks();
  });

  describe('local mode', () => {
    it('should parse a fixture tfvars file into a GameServer[] matching the terraform/variables.tf shape', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_TFVARS);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_GAME_SERVERS);
      expect(remoteFileStore.get).not.toHaveBeenCalled();
    });

    it('should read from ConfigService.getTfvarsPath()', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_TFVARS);

      const service = new TfvarsService(
        makeConfig({ bucket: null, path: '/custom/terraform.tfvars' }),
        remoteFileStore,
      );
      await service.getGameServers();

      expect(mockExists).toHaveBeenCalledWith('/custom/terraform.tfvars');
      expect(mockRead).toHaveBeenCalledWith('/custom/terraform.tfvars', 'utf-8');
    });

    it('should return an empty array and log when the local tfvars file does not exist', async () => {
      mockExists.mockReturnValue(false);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });

    it('should return an empty array and log when the tfvars file has no game_servers key', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('aws_region = "us-east-1"\n');

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('getRawHcl', () => {
    it('should return the raw HCL text without an etag in local mode', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_TFVARS);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      const result = await service.getRawHcl();

      expect(result.hcl).toBe(FIXTURE_TFVARS);
      expect(result.etag).toBeUndefined();
    });

    it('should return the raw HCL text plus the RemoteFileStore etag in s3 mode', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_TFVARS),
        etag: 'etag-1',
      });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      const result = await service.getRawHcl();

      expect(result.hcl).toBe(FIXTURE_TFVARS);
      expect(result.etag).toBe('etag-1');
    });

    it('should reject when the tfvars source is unreadable, unlike getGameServers', async () => {
      mockExists.mockReturnValue(false);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.getRawHcl()).rejects.toThrow(/not found/);
    });
  });

  describe('s3 mode', () => {
    it('should parse tfvars fetched from the stubbed RemoteFileStore into a GameServer[] matching the terraform/variables.tf shape', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_TFVARS),
        etag: 'etag-1',
      });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_GAME_SERVERS);
      expect(mockRead).not.toHaveBeenCalled();
    });

    it('should fetch the object keyed by the tfvars path basename', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_TFVARS),
        etag: 'etag-1',
      });

      const service = new TfvarsService(
        makeConfig({ bucket: 'my-tfvars-bucket', path: '/repo/terraform/terraform.tfvars' }),
        remoteFileStore,
      );
      await service.getGameServers();

      expect(remoteFileStore.get).toHaveBeenCalledWith('terraform.tfvars');
    });

    it('should return an empty array and log when the remote tfvars object does not exist', async () => {
      remoteFileStore.get.mockResolvedValue(undefined);

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('parse errors', () => {
    it('should return an empty array and log when the tfvars text is malformed HCL', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('this is not { valid hcl @@@');

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });

    it('should negatively cache a failed parse, so the next call within the TTL does not retry the source', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('this is not { valid hcl @@@');

      const service = new TestableTfvarsService(makeConfig({ bucket: null, ttlMs: 30000 }), remoteFileStore);
      service.nowMock.mockReturnValue(1_000_000);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(mockRead).toHaveBeenCalledTimes(1);

      // Fix the underlying source, but stay within the TTL — the negatively
      // cached failure should still be served, not a fresh (now-valid) read.
      mockRead.mockReturnValue(FIXTURE_TFVARS);
      service.nowMock.mockReturnValue(1_010_000); // 10s later, well within a 30s TTL
      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(mockRead).toHaveBeenCalledTimes(1);
    });

    it('should retry the source once the TTL has elapsed after a failed parse', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('this is not { valid hcl @@@');

      const service = new TestableTfvarsService(makeConfig({ bucket: null, ttlMs: 30000 }), remoteFileStore);
      service.nowMock.mockReturnValue(1_000_000);

      await expect(service.getGameServers()).resolves.toEqual([]);

      mockRead.mockReturnValue(FIXTURE_TFVARS);
      service.nowMock.mockReturnValue(1_000_000 + 30001); // just past the 30s TTL
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_GAME_SERVERS);
    });
  });

  describe('parsing breadth', () => {
    it('should parse multiple game_servers entries into a GameServer[] with one element per entry', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_MULTIPLE_GAMES);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_MULTIPLE_GAME_SERVERS);
    });

    it('should parse an entry with every optional field omitted, leaving them undefined rather than throwing', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_OMITTED_OPTIONALS);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_OMITTED_OPTIONALS_GAME_SERVERS);
      for (const entry of result) {
        expect(entry.environment).toBeUndefined();
        expect(entry.https).toBeUndefined();
        expect(entry.connect_message).toBeUndefined();
        expect(entry.file_seeds).toBeUndefined();
      }
    });

    it('should parse the complex fixture covering comments, a heredoc, and both file_seeds variants, and leave the valheim entry\'s Terraform expressions as literal unevaluated strings', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_COMPLEX);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_COMPLEX_GAME_SERVERS);
    });

    it('should return an empty array and log a warning when the tfvars file is completely empty', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('');

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('should be a cache miss on the first call, reading the source once', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_TFVARS);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      await service.getGameServers();

      expect(mockRead).toHaveBeenCalledTimes(1);
    });

    it('should be a cache hit on a second call within the TTL, not re-reading the source', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_TFVARS);

      const service = new TestableTfvarsService(makeConfig({ bucket: null, ttlMs: 30000 }), remoteFileStore);
      service.nowMock.mockReturnValue(1_000_000);

      const first = await service.getGameServers();
      service.nowMock.mockReturnValue(1_010_000); // 10s later, well within a 30s TTL
      const second = await service.getGameServers();

      expect(mockRead).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('should re-read the source once the TTL has elapsed', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_TFVARS);

      const service = new TestableTfvarsService(makeConfig({ bucket: null, ttlMs: 30000 }), remoteFileStore);
      service.nowMock.mockReturnValue(1_000_000);

      await service.getGameServers();
      service.nowMock.mockReturnValue(1_000_000 + 30001); // just past the 30s TTL
      await service.getGameServers();

      expect(mockRead).toHaveBeenCalledTimes(2);
    });

    it('should re-read the source immediately after invalidateCache', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_TFVARS);

      const service = new TfvarsService(makeConfig({ bucket: null, ttlMs: 30000 }), remoteFileStore);

      await service.getGameServers();
      service.invalidateCache();
      await service.getGameServers();

      expect(mockRead).toHaveBeenCalledTimes(2);
    });
  });
});
