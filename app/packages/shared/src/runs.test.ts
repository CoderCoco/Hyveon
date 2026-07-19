import { describe, it, expect } from 'vitest';
import { buildRunSk, deriveRunStatus } from './runs.js';

describe('buildRunSk', () => {
  it('should join startedAt and runId with a hash separator', () => {
    const sk = buildRunSk('2026-07-17T12:34:56.789Z', 'run-123');
    expect(sk).toBe('2026-07-17T12:34:56.789Z#run-123');
  });

  it('should prefix the sort key with the exact startedAt string it was given', () => {
    const startedAt = '2020-01-01T00:00:00.000Z';
    const sk = buildRunSk(startedAt, 'abc');
    expect(sk.startsWith(`${startedAt}#`)).toBe(true);
  });

  it('should suffix the sort key with the exact runId it was given', () => {
    const sk = buildRunSk('2020-01-01T00:00:00.000Z', 'run-xyz');
    expect(sk.endsWith('#run-xyz')).toBe(true);
  });

  it('should produce sort keys that sort chronologically for increasing startedAt values', () => {
    const earlier = buildRunSk('2026-01-01T00:00:00.000Z', 'a');
    const later = buildRunSk('2026-06-01T00:00:00.000Z', 'a');
    expect(earlier < later).toBe(true);
  });

  it('should not mutate any shared state across calls (pure)', () => {
    const first = buildRunSk('2026-07-17T12:34:56.789Z', 'run-1');
    const second = buildRunSk('2026-07-17T12:34:56.789Z', 'run-1');
    expect(first).toBe(second);
  });
});

describe('deriveRunStatus', () => {
  it('should return success when exitCode is 0', () => {
    expect(deriveRunStatus(0)).toBe('success');
  });

  it('should return failed when exitCode is a non-zero number', () => {
    expect(deriveRunStatus(1)).toBe('failed');
  });

  it('should return aborted when exitCode is null (e.g. killed via abort signal)', () => {
    expect(deriveRunStatus(null)).toBe('aborted');
  });
});
