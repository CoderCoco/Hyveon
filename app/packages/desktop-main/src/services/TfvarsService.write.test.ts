/**
 * Write-path tests for `TfvarsService` (see issue #96) — `addGameServer`,
 * `updateGameServer`, and `removeGameServer`. Directly covers the three
 * issue #96 acceptance checkboxes:
 *
 *  1. Byte preservation — adding/editing/removing one game preserves the
 *     rest of the file byte-for-byte (modulo the touched block).
 *  2. Concurrent writes — a second write that races a first (stale etag)
 *     fails with a clear error rather than silently overwriting.
 *  3. `OptimisticLockError` is structured (`expectedEtag` / `currentEtag`)
 *     so the UI can display "remote moved — refresh".
 *
 * `locateMapBody`/`locateEntry` (from `hclSurgeon.ts`, already exhaustively
 * unit-tested in `hclSurgeon.test.ts`) are used here only to compute the
 * expected prefix/suffix byte spans against the fixture — the same
 * production code `TfvarsService` itself calls — so these tests verify the
 * *service*-level read → mutate → write wiring, not re-derive the lexer's
 * comment/string/heredoc-skipping logic (that's `hclSurgeon.test.ts`'s job).
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RemoteFileStore } from '@hyveon/shared';
import { OptimisticLockError, RemoteFileConflictError } from '@hyveon/shared';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { TfvarsService } from './TfvarsService.js';
import { ConfigService } from './ConfigService.js';
import { locateEntry, locateMapBody } from './hclSurgeon.js';

/** Strongly-typed mock handles for the `fs` module. */
const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);

/**
 * A `terraform.tfvars` fixture with a leading comment, non-`game_servers`
 * top-level variables, and two `game_servers` entries (one with its own
 * leading comment) — enough surrounding content to meaningfully assert that
 * a write only touches the entry it targets.
 */
const FIXTURE_TFVARS = `# managed by hyveon — see docs/docs/guides/s3-tfvars.md
aws_region   = "us-east-1"
project_name = "game-servers"

game_servers = {
  # palworld: main community server
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

/** A new entry's config used by the `addGameServer` tests. */
const NEW_ENTRY_CONFIG = {
  image: 'ryshe/terraria',
  cpu: 512,
  memory: 1024,
  ports: [{ container: 7777, protocol: 'tcp' }],
  volumes: [{ name: 'world', container_path: '/config' }],
};

/** A replacement entry's config used by the `updateGameServer` tests. */
const UPDATED_ENTRY_CONFIG = {
  image: 'thijsvanloef/palworld-server-docker:v2',
  cpu: 4096,
  memory: 16384,
  ports: [{ container: 8211, protocol: 'udp' }],
  volumes: [{ name: 'saves', container_path: '/palworld' }],
};

/** Fake `RemoteFileStore` whose `get`/`put` are directly-controllable mocks. */
function makeRemoteFileStore(): RemoteFileStore & {
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
 * Builds a `ConfigService` stub exposing just the methods `TfvarsService`
 * reads. `bucket: null` selects local mode; any non-null string selects S3
 * mode.
 */
function makeConfig(opts: { bucket?: string | null; path?: string }): ConfigService {
  const stub: Partial<ConfigService> = {
    getTfvarsBucket: () => opts.bucket ?? null,
    getTfvarsPath: () => opts.path ?? '/repo/terraform/terraform.tfvars',
    readEnvTfvarsCacheTtlMs: () => 30000,
  };
  return stub as ConfigService;
}

describe('TfvarsService write path', () => {
  let remoteFileStore: RemoteFileStore & { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    remoteFileStore = makeRemoteFileStore();
    vi.clearAllMocks();
  });

  describe('byte preservation (local mode)', () => {
    it('should preserve every byte outside the game_servers map body verbatim when addGameServer splices in a new entry', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_TFVARS);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      await service.addGameServer('terraria', NEW_ENTRY_CONFIG);

      expect(mockWrite).toHaveBeenCalledTimes(1);
      const written = mockWrite.mock.calls[0]![1] as string;

      const mapBody = locateMapBody(FIXTURE_TFVARS, 'game_servers')!;
      // Everything up to and including the map's opening `{` — the leading
      // comment, aws_region, project_name — is untouched.
      expect(written.slice(0, mapBody.bodyStart)).toBe(FIXTURE_TFVARS.slice(0, mapBody.bodyStart));
      // Everything from the map's opening `{` onward in the source — the
      // existing palworld/valheim entries, their comment, and the closing
      // braces — reappears verbatim as a suffix of the write, after the
      // newly-spliced entry.
      expect(written.endsWith(FIXTURE_TFVARS.slice(mapBody.bodyStart))).toBe(true);
      expect(written).toContain('terraria = {');
    });

    it('should preserve every byte outside the replaced value when updateGameServer replaces an existing entry', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_TFVARS);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      await service.updateGameServer('palworld', UPDATED_ENTRY_CONFIG);

      expect(mockWrite).toHaveBeenCalledTimes(1);
      const written = mockWrite.mock.calls[0]![1] as string;

      const span = locateEntry(FIXTURE_TFVARS, 'game_servers', 'palworld')!;
      const prefix = FIXTURE_TFVARS.slice(0, span.valueStart);
      const suffix = FIXTURE_TFVARS.slice(span.valueEnd);

      // Everything before palworld's value (leading comment, aws_region,
      // project_name, the `# palworld: ...` comment, `palworld = `) is
      // untouched...
      expect(written.startsWith(prefix)).toBe(true);
      // ...and everything after it (the trailing comma/newline, the entire
      // valheim entry, and the map/file's closing braces) is untouched.
      expect(written.endsWith(suffix)).toBe(true);
      expect(written).toContain('thijsvanloef/palworld-server-docker:v2');
      // The untouched valheim entry survives byte-for-byte.
      const valheimSpan = locateEntry(FIXTURE_TFVARS, 'game_servers', 'valheim')!;
      expect(written).toContain(FIXTURE_TFVARS.slice(valheimSpan.start, valheimSpan.end));
    });

    it('should preserve every byte outside the removed entry when removeGameServer cuts an entry', async () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(FIXTURE_TFVARS);

      const service = new TfvarsService(makeConfig({ bucket: null }), remoteFileStore);
      await service.removeGameServer('palworld');

      expect(mockWrite).toHaveBeenCalledTimes(1);
      const written = mockWrite.mock.calls[0]![1] as string;

      const span = locateEntry(FIXTURE_TFVARS, 'game_servers', 'palworld')!;
      let cutEnd = span.end;
      if (FIXTURE_TFVARS[cutEnd] === '\r') cutEnd++;
      if (FIXTURE_TFVARS[cutEnd] === '\n') cutEnd++;
      const expected = FIXTURE_TFVARS.slice(0, span.start) + FIXTURE_TFVARS.slice(cutEnd);

      expect(written).toBe(expected);
      // The entry assignment itself is gone (its leading comment, which
      // `cutEntry` deliberately leaves untouched since it precedes rather
      // than belongs to the entry span, is expected to remain — see
      // `hclSurgeon.ts`'s `HclEntrySpan.start` doc comment).
      expect(written).not.toContain('palworld = {');
      expect(written).toContain('valheim = {');
      expect(written).toContain('aws_region   = "us-east-1"');
    });
  });

  describe('concurrent writes (S3 mode)', () => {
    it('should fail the second of two concurrent writes with a clear OptimisticLockError, not silently overwrite the first', async () => {
      // Both writers read the same starting etag...
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_TFVARS),
        etag: 'etag-1',
      });
      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      // ...the first writer's conditional put succeeds and moves the remote
      // etag forward...
      remoteFileStore.put.mockResolvedValueOnce({ etag: 'etag-2' });
      await service.updateGameServer('palworld', UPDATED_ENTRY_CONFIG, 'etag-1');
      expect(remoteFileStore.put).toHaveBeenCalledWith('terraform.tfvars', expect.any(Uint8Array), {
        ifMatch: 'etag-1',
      });

      // ...so the second writer's conditional put — still guarded by the
      // now-stale `etag-1` it read before the first write landed — is
      // rejected by the store rather than clobbering the first writer's change.
      remoteFileStore.put.mockRejectedValueOnce(
        new RemoteFileConflictError('terraform.tfvars', 'Conflicting write detected.', 'etag-1'),
      );
      remoteFileStore.get.mockResolvedValueOnce({
        body: new TextEncoder().encode(FIXTURE_TFVARS),
        etag: 'etag-2',
      });

      await expect(
        service.removeGameServer('valheim', 'etag-1'),
      ).rejects.toThrow(OptimisticLockError);
    });

    it('should throw OptimisticLockError (not a raw RemoteFileConflictError) when the store rejects a conditional put', async () => {
      remoteFileStore.get.mockResolvedValue({
        body: new TextEncoder().encode(FIXTURE_TFVARS),
        etag: 'etag-1',
      });
      remoteFileStore.put.mockRejectedValue(
        new RemoteFileConflictError('terraform.tfvars', 'Conflicting write detected.', 'etag-stale'),
      );

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      await expect(
        service.addGameServer('terraria', NEW_ENTRY_CONFIG, 'etag-stale'),
      ).rejects.toBeInstanceOf(OptimisticLockError);
      await expect(mockWrite).not.toHaveBeenCalled();
    });
  });

  describe('structured lock error', () => {
    it('should carry the expected and current etags so callers can display "remote moved — refresh"', async () => {
      remoteFileStore.get
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(FIXTURE_TFVARS),
          etag: 'etag-stale',
        })
        // Follow-up get() TfvarsService issues after the conflict, to report
        // the current etag on the thrown error.
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(FIXTURE_TFVARS),
          etag: 'etag-current',
        });
      remoteFileStore.put.mockRejectedValue(
        new RemoteFileConflictError('terraform.tfvars', 'Conflicting write detected.', 'etag-stale'),
      );

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      let caught: unknown;
      try {
        await service.updateGameServer('palworld', UPDATED_ENTRY_CONFIG, 'etag-stale');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(OptimisticLockError);
      const lockError = caught as OptimisticLockError;
      expect(lockError.expectedEtag).toBe('etag-stale');
      expect(lockError.currentEtag).toBe('etag-current');
      expect(lockError.message).toMatch(/etag-stale/);
    });

    it('should still populate expectedEtag (with currentEtag undefined) when the follow-up get() itself fails', async () => {
      remoteFileStore.get.mockResolvedValueOnce({
        body: new TextEncoder().encode(FIXTURE_TFVARS),
        etag: 'etag-stale',
      });
      remoteFileStore.put.mockRejectedValue(
        new RemoteFileConflictError('terraform.tfvars', 'Conflicting write detected.', 'etag-stale'),
      );
      // Follow-up get() (to resolve the current etag for the error) fails too.
      remoteFileStore.get.mockRejectedValueOnce(new Error('network error'));

      const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

      let caught: unknown;
      try {
        await service.removeGameServer('valheim', 'etag-stale');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(OptimisticLockError);
      const lockError = caught as OptimisticLockError;
      expect(lockError.expectedEtag).toBe('etag-stale');
      expect(lockError.currentEtag).toBeUndefined();
    });
  });
});
