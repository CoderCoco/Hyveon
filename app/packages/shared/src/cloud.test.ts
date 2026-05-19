import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type {
  CloudProvider,
  CostBreakdown,
  DateRange,
  LogChunk,
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
