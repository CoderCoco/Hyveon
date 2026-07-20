import { describe, expect, it } from 'vitest';
import { OptimisticLockError, RunLockHeldError } from './errors.js';
import type { RunLock } from './runs.js';

/** A minimal {@link RunLock} fixture for {@link RunLockHeldError} tests. */
const sampleLock: RunLock = {
  runId: 'run-1',
  kind: 'apply',
  initiator: 'alice',
  acquiredAt: '2026-07-20T12:00:00.000Z',
  expiresAt: '2026-07-20T12:30:00.000Z',
};

describe('OptimisticLockError', () => {
  it('should be importable from @hyveon/shared and be an instance of Error', () => {
    const error = new OptimisticLockError('expected-etag');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(OptimisticLockError);
  });

  it('should set name to OptimisticLockError', () => {
    const error = new OptimisticLockError('expected-etag', 'current-etag');

    expect(error.name).toBe('OptimisticLockError');
  });

  it('should round-trip both the expected and current etag through the constructor', () => {
    const error = new OptimisticLockError('expected-etag', 'current-etag');

    expect(error.expectedEtag).toBe('expected-etag');
    expect(error.currentEtag).toBe('current-etag');
  });

  it('should leave currentEtag undefined when it is not supplied', () => {
    const error = new OptimisticLockError('expected-etag');

    expect(error.expectedEtag).toBe('expected-etag');
    expect(error.currentEtag).toBeUndefined();
  });

  it('should derive a default message noting the remote etag is unknown when currentEtag is not supplied', () => {
    const error = new OptimisticLockError('expected-etag');

    expect(error.message).toContain('expected-etag');
    expect(error.message).toContain('unknown');
  });

  it('should use a custom message when one is provided', () => {
    const error = new OptimisticLockError('expected-etag', 'current-etag', 'remote moved — refresh');

    expect(error.message).toBe('remote moved — refresh');
  });

  it('should derive a default message from both etags when none is provided', () => {
    const error = new OptimisticLockError('expected-etag', 'current-etag');

    expect(error.message).toContain('expected-etag');
    expect(error.message).toContain('current-etag');
  });
});

describe('RunLockHeldError', () => {
  it('should be importable from @hyveon/shared and be an instance of Error', () => {
    const error = new RunLockHeldError(sampleLock);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RunLockHeldError);
  });

  it('should set name to RunLockHeldError', () => {
    const error = new RunLockHeldError(sampleLock);

    expect(error.name).toBe('RunLockHeldError');
  });

  it('should carry the current lock through the constructor', () => {
    const error = new RunLockHeldError(sampleLock);

    expect(error.lock).toEqual(sampleLock);
  });

  it('should derive a default message noting the initiator, kind, and runId when none is provided', () => {
    const error = new RunLockHeldError(sampleLock);

    expect(error.message).toContain('alice');
    expect(error.message).toContain('apply');
    expect(error.message).toContain('run-1');
  });

  it('should use a custom message when one is provided', () => {
    const error = new RunLockHeldError(sampleLock, 'a run is already in progress');

    expect(error.message).toBe('a run is already in progress');
  });
});
