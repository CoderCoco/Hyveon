import { describe, it, expect } from 'vitest';
import {
  buildRunSk,
  computeRunDetailStatus,
  deriveRunStatus,
  isRunLockExpired,
  isApprovalExpired,
  APPROVAL_WINDOW_MS,
  type RunLock,
} from './runs.js';

/**
 * Builds a minimal input for {@link computeRunDetailStatus}, overriding only
 * the fields a given test cares about. Defaults describe a finished,
 * successful `apply` run with no plan artifact.
 */
function buildStatusInput(
  overrides: Partial<Parameters<typeof computeRunDetailStatus>[0]> = {},
): Parameters<typeof computeRunDetailStatus>[0] {
  return {
    isInFlight: false,
    kind: 'apply',
    exitCode: 0,
    planArtifactExists: false,
    ...overrides,
  };
}

/**
 * Builds a minimal {@link RunLock} fixture for {@link isRunLockExpired}
 * tests, overriding only the fields a given test cares about.
 */
function buildLock(overrides: Partial<RunLock> = {}): RunLock {
  return {
    runId: 'run-1',
    kind: 'apply',
    initiator: 'alice',
    acquiredAt: '2026-07-20T12:00:00.000Z',
    expiresAt: '2026-07-20T12:30:00.000Z',
    ...overrides,
  };
}

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

describe('isRunLockExpired', () => {
  it('should return false when now is before expiresAt', () => {
    const lock = buildLock({ expiresAt: '2026-07-20T12:30:00.000Z' });
    const now = new Date('2026-07-20T12:15:00.000Z');

    expect(isRunLockExpired(lock, now)).toBe(false);
  });

  it('should return true when now is after expiresAt', () => {
    const lock = buildLock({ expiresAt: '2026-07-20T12:30:00.000Z' });
    const now = new Date('2026-07-20T12:45:00.000Z');

    expect(isRunLockExpired(lock, now)).toBe(true);
  });

  it('should return true when now exactly equals expiresAt', () => {
    const lock = buildLock({ expiresAt: '2026-07-20T12:30:00.000Z' });
    const now = new Date('2026-07-20T12:30:00.000Z');

    expect(isRunLockExpired(lock, now)).toBe(true);
  });

  it('should default now to the current time when it is not supplied', () => {
    const pastLock = buildLock({ expiresAt: '2000-01-01T00:00:00.000Z' });
    const futureLock = buildLock({ expiresAt: '2999-01-01T00:00:00.000Z' });

    expect(isRunLockExpired(pastLock)).toBe(true);
    expect(isRunLockExpired(futureLock)).toBe(false);
  });
});

describe('isApprovalExpired', () => {
  const approvedAt = '2026-07-20T12:00:00.000Z';

  it('should return false when now is before approvedAt plus the approval window', () => {
    const now = new Date(new Date(approvedAt).getTime() + APPROVAL_WINDOW_MS - 1);

    expect(isApprovalExpired(approvedAt, now)).toBe(false);
  });

  it('should return true when now is after approvedAt plus the approval window', () => {
    const now = new Date(new Date(approvedAt).getTime() + APPROVAL_WINDOW_MS + 1);

    expect(isApprovalExpired(approvedAt, now)).toBe(true);
  });

  it('should return true when now exactly equals approvedAt plus the approval window', () => {
    const now = new Date(new Date(approvedAt).getTime() + APPROVAL_WINDOW_MS);

    expect(isApprovalExpired(approvedAt, now)).toBe(true);
  });

  it('should default now to the current time when it is not supplied', () => {
    const longAgo = new Date(Date.now() - APPROVAL_WINDOW_MS - 1000).toISOString();
    const justNow = new Date().toISOString();

    expect(isApprovalExpired(longAgo)).toBe(true);
    expect(isApprovalExpired(justNow)).toBe(false);
  });
});

describe('computeRunDetailStatus', () => {
  it('should return running when isInFlight is true regardless of the other fields', () => {
    const input = buildStatusInput({
      isInFlight: true,
      kind: 'plan',
      exitCode: 0,
      planArtifactExists: true,
    });

    expect(computeRunDetailStatus(input)).toBe('running');
  });

  it('should return awaiting_approval for a successful plan whose artifact still exists', () => {
    const input = buildStatusInput({ kind: 'plan', exitCode: 0, planArtifactExists: true });

    expect(computeRunDetailStatus(input)).toBe('awaiting_approval');
  });

  it('should not return awaiting_approval for a successful plan whose artifact no longer exists', () => {
    const input = buildStatusInput({ kind: 'plan', exitCode: 0, planArtifactExists: false });

    expect(computeRunDetailStatus(input)).toBe('success');
  });

  it('should return success for a successful apply', () => {
    const input = buildStatusInput({ kind: 'apply', exitCode: 0, planArtifactExists: false });

    expect(computeRunDetailStatus(input)).toBe('success');
  });

  it('should return failed for a run with a non-zero exit code', () => {
    const input = buildStatusInput({ kind: 'apply', exitCode: 1, planArtifactExists: false });

    expect(computeRunDetailStatus(input)).toBe('failed');
  });

  it('should return aborted for a run with a null exit code', () => {
    const input = buildStatusInput({ kind: 'destroy', exitCode: null, planArtifactExists: false });

    expect(computeRunDetailStatus(input)).toBe('aborted');
  });

  it('should not rewrite a failed or aborted plan to awaiting_approval', () => {
    const failedPlan = buildStatusInput({ kind: 'plan', exitCode: 1, planArtifactExists: true });
    const abortedPlan = buildStatusInput({ kind: 'plan', exitCode: null, planArtifactExists: true });

    expect(computeRunDetailStatus(failedPlan)).toBe('failed');
    expect(computeRunDetailStatus(abortedPlan)).toBe('aborted');
  });
});
