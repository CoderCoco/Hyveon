import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { AuditEntry, GameServer } from '@hyveon/shared';
import { AwsAuditLogStore } from './AwsAuditLogStore.js';

/** Typed stand-in for the DynamoDB document client SDK. */
const ddbMock = mockClient(DynamoDBDocumentClient);

/**
 * Build an {@link AwsAuditLogStore} whose config-resolution callback returns
 * a fixed table name/region, avoiding any need to read/mutate `process.env`
 * in tests.
 */
function makeStore(tableName = 'hyveon-audit', region = 'us-east-1'): AwsAuditLogStore {
  return new AwsAuditLogStore(() => ({ tableName, region }));
}

/** Minimal valid `GameServer` fixture used to populate `before`/`after`. */
const sampleGameServer: GameServer = {
  name: 'minecraft',
  image: 'itzg/minecraft-server',
  cpu: 1024,
  memory: 2048,
  ports: [{ container: 25565, protocol: 'tcp' }],
  volumes: [{ name: 'data', container_path: '/data' }],
};

/** Builds a sample {@link AuditEntry}, overridable per-test. */
function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    sk: '2026-07-17T00:00:00.000Z#01J000000000000000000000',
    timestamp: '2026-07-17T00:00:00.000Z',
    actor: 'alice',
    action: 'add',
    game: 'minecraft',
    before: null,
    after: sampleGameServer,
    ...overrides,
  };
}

describe('AwsAuditLogStore', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  describe('putEntry', () => {
    it('should send a PutCommand with pk AUDIT, the entry sk, and before/after serialized as JSON strings', async () => {
      ddbMock.on(PutCommand).resolves({});

      const store = makeStore();
      const entry = makeEntry({
        before: { ...sampleGameServer, cpu: 512 },
        after: sampleGameServer,
      });
      await store.putEntry(entry);

      const calls = ddbMock.commandCalls(PutCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.TableName).toBe('hyveon-audit');
      expect(input.Item).toEqual({
        pk: 'AUDIT',
        sk: entry.sk,
        timestamp: entry.timestamp,
        actor: entry.actor,
        action: entry.action,
        game: entry.game,
        before: JSON.stringify({ ...sampleGameServer, cpu: 512 }),
        after: JSON.stringify(sampleGameServer),
      });
    });

    it('should write null (not the string "null") for before/after when the entry field is null', async () => {
      ddbMock.on(PutCommand).resolves({});

      const store = makeStore();
      const entry = makeEntry({ action: 'remove', before: sampleGameServer, after: null });
      await store.putEntry(entry);

      const input = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(input.Item?.['before']).toBe(JSON.stringify(sampleGameServer));
      expect(input.Item?.['after']).toBeNull();
    });

    it('should include versionId on the written item when present on the entry', async () => {
      ddbMock.on(PutCommand).resolves({});

      const store = makeStore();
      const entry = makeEntry({ versionId: 'v-123' });
      await store.putEntry(entry);

      const input = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
      expect(input.Item?.['versionId']).toBe('v-123');
    });
  });

  describe('listEntries', () => {
    it('should query pk = AUDIT newest-first with the given Limit and no sk condition on the first page', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const store = makeStore();
      await store.listEntries(20);

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.TableName).toBe('hyveon-audit');
      expect(input.KeyConditionExpression).toBe('pk = :pk');
      expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'AUDIT' });
      expect(input.ScanIndexForward).toBe(false);
      expect(input.Limit).toBe(20);
    });

    it('should return an empty page with no nextBefore when the table is empty', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const store = makeStore();
      const result = await store.listEntries(20);

      expect(result).toEqual({ entries: [] });
    });

    it('should deserialize before/after from JSON strings and omit nextBefore when no more rows exist', async () => {
      const entry = makeEntry();
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            pk: 'AUDIT',
            sk: entry.sk,
            timestamp: entry.timestamp,
            actor: entry.actor,
            action: entry.action,
            game: entry.game,
            before: null,
            after: JSON.stringify(sampleGameServer),
          },
        ],
      });

      const store = makeStore();
      const result = await store.listEntries(20);

      expect(result.nextBefore).toBeUndefined();
      expect(result.entries).toEqual([entry]);
    });

    it('should add sk < before to the KeyConditionExpression when a cursor is given', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const store = makeStore();
      await store.listEntries(20, 'cursor-sk');

      const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
      expect(input.KeyConditionExpression).toBe('pk = :pk AND sk < :before');
      expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'AUDIT', ':before': 'cursor-sk' });
    });

    it('should return nextBefore set to the oldest entry in the page when DynamoDB reports a LastEvaluatedKey', async () => {
      const first = makeEntry({ sk: 'sk-1' });
      const second = makeEntry({ sk: 'sk-2' });
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { pk: 'AUDIT', ...first, after: JSON.stringify(sampleGameServer) },
          { pk: 'AUDIT', ...second, after: JSON.stringify(sampleGameServer) },
        ],
        LastEvaluatedKey: { pk: 'AUDIT', sk: 'sk-2' },
      });

      const store = makeStore();
      const result = await store.listEntries(2);

      expect(result.nextBefore).toBe('sk-2');
      expect(result.entries.map((e) => e.sk)).toEqual(['sk-1', 'sk-2']);
    });
  });
});
