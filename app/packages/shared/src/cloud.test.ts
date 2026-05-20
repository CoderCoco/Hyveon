import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type {
  CloudProvider,
  CostBreakdown,
  DateRange,
  DiscordEventReceiver,
  LogChunk,
  RemoteFileStore,
  SecretsStore,
  StartOpts,
  WorkloadHandle,
  WorkloadStatus,
} from './cloud.js';

const dir = dirname(fileURLToPath(import.meta.url));

describe('cloud.ts interface file', () => {
  it('should import nothing from @aws-sdk/*', () => {
    const src = readFileSync(resolve(dir, 'cloud.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]@aws-sdk\//);
  });
});

describe('CloudProvider', () => {
  it('should be implementable with a plain object satisfying all six methods', () => {
    /**
     * Compile-time check: this object must satisfy CloudProvider or tsc/vitest
     * will fail. The runtime assertion just confirms the object is truthy.
     */
    const provider = {
      async startWorkload(_game: string, _opts: StartOpts): Promise<WorkloadHandle> {
        return { workloadId: 'test-id' };
      },
      async stopWorkload(_game: string): Promise<void> {},
      async getWorkloadStatus(_game: string): Promise<WorkloadStatus> {
        return { state: 'stopped' };
      },
      async *streamWorkloadLogs(_game: string, _signal: AbortSignal): AsyncIterable<LogChunk> {},
      async getCostEstimate(): Promise<CostBreakdown> {
        return { total: 0, currency: 'USD', breakdown: {} };
      },
      async getActualCosts(_range: DateRange): Promise<CostBreakdown> {
        return { total: 0, currency: 'USD', breakdown: {} };
      },
    } satisfies CloudProvider;

    expect(provider).toBeDefined();
  });
});

describe('SecretsStore', () => {
  it('should be implementable with a plain object satisfying all three methods', () => {
    /**
     * Compile-time check: this object must satisfy SecretsStore or tsc/vitest
     * will fail. The runtime assertion just confirms the object is truthy.
     */
    const store = {
      async get(_name: string): Promise<string | undefined> {
        return 'secret-value';
      },
      async put(_name: string, _value: string): Promise<void> {},
      async exists(_name: string): Promise<boolean> {
        return true;
      },
    } satisfies SecretsStore;

    expect(store).toBeDefined();
  });
});

describe('RemoteFileStore', () => {
  it('should be implementable with a plain object satisfying all three methods', () => {
    /**
     * Compile-time check: this object must satisfy RemoteFileStore or tsc/vitest
     * will fail. The runtime assertion just confirms the object is truthy.
     */
    const store = {
      async get(_path: string): Promise<{ body: Uint8Array; etag: string } | undefined> {
        return { body: new Uint8Array([1, 2, 3]), etag: 'abc123' };
      },
      async put(
        _path: string,
        _body: Uint8Array,
        _opts?: { ifMatch?: string },
      ): Promise<{ etag: string }> {
        return { etag: 'def456' };
      },
      async listVersions(
        _path: string,
      ): Promise<Array<{ versionId: string; lastModified: Date }>> {
        return [{ versionId: 'v1', lastModified: new Date('2026-01-01T00:00:00Z') }];
      },
    } satisfies RemoteFileStore;

    expect(store).toBeDefined();
  });
});

describe('DiscordEventReceiver', () => {
  it('should be implementable with a plain object satisfying getInteractionEndpointUrl', () => {
    /**
     * Compile-time check: this object must satisfy DiscordEventReceiver or tsc/vitest
     * will fail. The runtime assertion just confirms the object is truthy.
     */
    const receiver = {
      async getInteractionEndpointUrl(): Promise<string | null> {
        return 'https://example.execute-api.us-east-1.amazonaws.com/interactions';
      },
    } satisfies DiscordEventReceiver;

    expect(receiver).toBeDefined();
  });
});
