import { describe, expect, it } from 'vitest';
import { OptimisticLockError } from './errors.js';

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
