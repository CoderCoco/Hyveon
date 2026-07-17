/**
 * Tests for `AuditService` — the write/read facade over the cloud-agnostic
 * `AuditLogStore` (a stub here; the real `AwsAuditLogStore` has its own
 * tests under `@hyveon/cloud-aws`). Covers the happy path, the
 * swallow-on-error contract, and the no-table no-op, plus `list()`'s limit
 * clamping.
 */
import * as os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditLogStore, AuditPageResult, GameServer } from '@hyveon/shared';
import { AuditService } from './AuditService.js';
import { ConfigService, type TfOutputs } from './ConfigService.js';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    userInfo: vi.fn(() => ({ username: 'test-actor' })),
  };
});

/** Minimal `TfOutputs` stub exposing just `audit_table_name`. */
const TF: TfOutputs = {
  aws_region: 'us-east-1',
  ecs_cluster_name: '',
  ecs_cluster_arn: '',
  subnet_ids: '',
  security_group_id: '',
  file_manager_security_group_id: '',
  efs_file_system_id: '',
  efs_access_points: {},
  domain_name: '',
  game_names: [],
  alb_dns_name: null,
  acm_certificate_arn: null,
  discord_table_name: '',
  audit_table_name: 'test-audit',
  discord_bot_token_secret_arn: '',
  discord_public_key_secret_arn: '',
  interactions_invoke_url: null,
} as TfOutputs;

/** Minimal valid `GameServer` fixture used to populate `before`/`after`. */
const sampleGameServer: GameServer = {
  name: 'minecraft',
  image: 'itzg/minecraft-server',
  cpu: 1024,
  memory: 2048,
  ports: [{ container: 25565, protocol: 'tcp' }],
  volumes: [{ name: 'data', container_path: '/data' }],
};

const putEntryMock = vi.fn<AuditLogStore['putEntry']>();
const listEntriesMock = vi.fn<AuditLogStore['listEntries']>();

/** Builds an `AuditLogStore`-shaped stub backed by the shared mocks above. */
function makeStore(): AuditLogStore {
  return { putEntry: putEntryMock, listEntries: listEntriesMock };
}

/** Builds an `AuditService` with a `ConfigService` stub returning `outputs` and the given (or default) store stub. */
function makeService(outputs: TfOutputs | null = TF, store: AuditLogStore = makeStore()): AuditService {
  const config = { getTfOutputs: () => outputs } as Partial<ConfigService> as ConfigService;
  return new AuditService(config, store);
}

beforeEach(() => {
  putEntryMock.mockReset();
  listEntriesMock.mockReset();
  vi.mocked(os.userInfo).mockReturnValue({ username: 'test-actor' } as ReturnType<typeof os.userInfo>);
});

describe('AuditService', () => {
  describe('record', () => {
    it('should build an AuditEntry from the actor, timestamp, and sk, and persist it via store.putEntry on the happy path', async () => {
      putEntryMock.mockResolvedValue(undefined);
      const service = makeService();

      await service.record({
        action: 'add',
        game: 'minecraft',
        before: null,
        after: sampleGameServer,
        versionId: 'v1',
      });

      expect(putEntryMock).toHaveBeenCalledTimes(1);
      const entry = putEntryMock.mock.calls[0]?.[0];
      expect(entry).toMatchObject({
        actor: 'test-actor',
        action: 'add',
        game: 'minecraft',
        before: null,
        after: sampleGameServer,
        versionId: 'v1',
      });
      expect(entry?.sk).toEqual(expect.stringContaining(entry?.timestamp ?? ''));
      expect(() => new Date(entry?.timestamp ?? '').toISOString()).not.toThrow();
    });

    it('should swallow a store.putEntry failure and log a warning instead of throwing', async () => {
      putEntryMock.mockRejectedValue(new Error('DynamoDB is down'));
      const service = makeService();

      await expect(
        service.record({ action: 'edit', game: 'minecraft', before: sampleGameServer, after: sampleGameServer }),
      ).resolves.toBeUndefined();

      expect(putEntryMock).toHaveBeenCalledTimes(1);
    });

    it('should no-op without calling store.putEntry when audit_table_name is not configured', async () => {
      const service = makeService(null);

      await expect(
        service.record({ action: 'remove', game: 'minecraft', before: sampleGameServer, after: null }),
      ).resolves.toBeUndefined();

      expect(putEntryMock).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('should delegate to store.listEntries with the default limit of 25 when limit is omitted', async () => {
      const page: AuditPageResult = { entries: [] };
      listEntriesMock.mockResolvedValue(page);
      const service = makeService();

      const result = await service.list();

      expect(listEntriesMock).toHaveBeenCalledWith(25, undefined);
      expect(result).toBe(page);
    });

    it('should clamp a limit above 100 down to the maximum of 100', async () => {
      listEntriesMock.mockResolvedValue({ entries: [] });
      const service = makeService();

      await service.list({ limit: 500, before: 'cursor' });

      expect(listEntriesMock).toHaveBeenCalledWith(100, 'cursor');
    });

    it('should fall back to the default limit when given a non-positive limit', async () => {
      listEntriesMock.mockResolvedValue({ entries: [] });
      const service = makeService();

      await service.list({ limit: 0 });

      expect(listEntriesMock).toHaveBeenCalledWith(25, undefined);
    });
  });
});
