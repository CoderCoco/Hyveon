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

/** Fake `RemoteFileStore` whose `get()` is a directly-controllable mock. */
function makeRemoteFileStore(): RemoteFileStore & {
  get: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(),
    put: vi.fn(),
    listVersions: vi.fn(),
  } as unknown as RemoteFileStore & { get: ReturnType<typeof vi.fn> };
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
    it('should return the raw HCL text without a versionId in local mode', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_TFVARS);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      const result = await service.getRawHcl();

      expect(result.hcl).toBe(FIXTURE_TFVARS);
      expect(result.versionId).toBeUndefined();
    });

    it('should return the raw HCL text plus the RemoteFileStore etag as versionId in s3 mode', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_TFVARS),
        etag: 'etag-1',
      });

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);
      const result = await service.getRawHcl();

      expect(result.hcl).toBe(FIXTURE_TFVARS);
      expect(result.versionId).toBe('etag-1');
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

      const service = new TfvarsService(makeConfig({ bucket: null, ttlMs: 30000 }), remoteFileStore);
      const nowSpy = vi.spyOn(service as unknown as { now: () => number }, 'now');
      nowSpy.mockReturnValue(1_000_000);

      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(mockRead).toHaveBeenCalledTimes(1);

      // Fix the underlying source, but stay within the TTL — the negatively
      // cached failure should still be served, not a fresh (now-valid) read.
      mockRead.mockReturnValue(FIXTURE_TFVARS);
      nowSpy.mockReturnValue(1_010_000); // 10s later, well within a 30s TTL
      await expect(service.getGameServers()).resolves.toEqual([]);
      expect(mockRead).toHaveBeenCalledTimes(1);
    });

    it('should retry the source once the TTL has elapsed after a failed parse', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue('this is not { valid hcl @@@');

      const service = new TfvarsService(makeConfig({ bucket: null, ttlMs: 30000 }), remoteFileStore);
      const nowSpy = vi.spyOn(service as unknown as { now: () => number }, 'now');
      nowSpy.mockReturnValue(1_000_000);

      await expect(service.getGameServers()).resolves.toEqual([]);

      mockRead.mockReturnValue(FIXTURE_TFVARS);
      nowSpy.mockReturnValue(1_000_000 + 30001); // just past the 30s TTL
      const result = await service.getGameServers();

      expect(result).toEqual(EXPECTED_GAME_SERVERS);
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

      const service = new TfvarsService(makeConfig({ bucket: null, ttlMs: 30000 }), remoteFileStore);
      const nowSpy = vi.spyOn(service as unknown as { now: () => number }, 'now');
      nowSpy.mockReturnValue(1_000_000);

      const first = await service.getGameServers();
      nowSpy.mockReturnValue(1_010_000); // 10s later, well within a 30s TTL
      const second = await service.getGameServers();

      expect(mockRead).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('should re-read the source once the TTL has elapsed', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_TFVARS);

      const service = new TfvarsService(makeConfig({ bucket: null, ttlMs: 30000 }), remoteFileStore);
      const nowSpy = vi.spyOn(service as unknown as { now: () => number }, 'now');
      nowSpy.mockReturnValue(1_000_000);

      await service.getGameServers();
      nowSpy.mockReturnValue(1_000_000 + 30001); // just past the 30s TTL
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
