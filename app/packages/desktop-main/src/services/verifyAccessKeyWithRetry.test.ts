import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { verifyAccessKeyWithRetry, VERIFY_ACCESS_KEY_RETRY_DELAYS_MS } from './verifyAccessKeyWithRetry.js';
import { logger } from '../logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('verifyAccessKeyWithRetry', () => {
  it('should resolve without calling sleep when verify succeeds on the first attempt', async () => {
    const verify = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await verifyAccessKeyWithRetry(verify, { sleep });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('should retry and resolve once verify succeeds on a later attempt, without exceeding the needed number of calls', async () => {
    const verify = vi
      .fn()
      .mockRejectedValueOnce(new Error('not yet'))
      .mockRejectedValueOnce(new Error('still not yet'))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await verifyAccessKeyWithRetry(verify, { sleep });

    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('should call sleep with each configured delay in order between failed attempts', async () => {
    const verify = vi
      .fn()
      .mockRejectedValueOnce(new Error('not yet'))
      .mockRejectedValueOnce(new Error('still not yet'))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await verifyAccessKeyWithRetry(verify, { sleep });

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([
      VERIFY_ACCESS_KEY_RETRY_DELAYS_MS[0],
      VERIFY_ACCESS_KEY_RETRY_DELAYS_MS[1],
    ]);
  });

  it('should not call sleep after the final failed attempt before throwing', async () => {
    const error = new Error('always fails');
    const verify = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(verifyAccessKeyWithRetry(verify, { sleep })).rejects.toThrow(error);

    expect(verify).toHaveBeenCalledTimes(VERIFY_ACCESS_KEY_RETRY_DELAYS_MS.length + 1);
    expect(sleep).toHaveBeenCalledTimes(VERIFY_ACCESS_KEY_RETRY_DELAYS_MS.length);
  });

  it('should throw the original, unwrapped error after exhausting all attempts when verify always fails', async () => {
    const error = new Error('always fails');
    const verify = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(verifyAccessKeyWithRetry(verify, { sleep })).rejects.toBe(error);
  });

  it('should call onAttemptFailed once per failed attempt with the correct 1-based attempt number and totalAttempts', async () => {
    const error = new Error('always fails');
    const verify = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onAttemptFailed = vi.fn();

    await expect(verifyAccessKeyWithRetry(verify, { sleep, onAttemptFailed })).rejects.toThrow(error);

    const totalAttempts = VERIFY_ACCESS_KEY_RETRY_DELAYS_MS.length + 1;
    expect(onAttemptFailed).toHaveBeenCalledTimes(totalAttempts);
    for (let i = 0; i < totalAttempts; i++) {
      expect(onAttemptFailed).toHaveBeenNthCalledWith(i + 1, i + 1, totalAttempts, error);
    }
  });

  it('should not call onAttemptFailed when the first attempt succeeds', async () => {
    const verify = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onAttemptFailed = vi.fn();

    await verifyAccessKeyWithRetry(verify, { sleep, onAttemptFailed });

    expect(onAttemptFailed).not.toHaveBeenCalled();
  });

  it('should honor a custom delaysMs array, deriving totalAttempts as delaysMs.length + 1', async () => {
    const error = new Error('always fails');
    const verify = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const delaysMs = [10, 20];

    await expect(verifyAccessKeyWithRetry(verify, { sleep, delaysMs })).rejects.toThrow(error);

    expect(verify).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([10, 20]);
  });

  it('should default to VERIFY_ACCESS_KEY_RETRY_DELAYS_MS when delaysMs is not supplied', async () => {
    const error = new Error('always fails');
    const verify = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(verifyAccessKeyWithRetry(verify, { sleep })).rejects.toThrow(error);

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([...VERIFY_ACCESS_KEY_RETRY_DELAYS_MS]);
  });

  it('should log a debug entry line with the total attempt count when starting verification', async () => {
    const verify = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await verifyAccessKeyWithRetry(verify, { sleep });

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('verifyAccessKeyWithRetry'),
      expect.objectContaining({ totalAttempts: VERIFY_ACCESS_KEY_RETRY_DELAYS_MS.length + 1 }),
    );
  });

  it('should log a warning with only the error message (never the raw error object) once all attempts are exhausted', async () => {
    const error = new Error('InvalidClientTokenId');
    const verify = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(verifyAccessKeyWithRetry(verify, { sleep })).rejects.toThrow(error);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('exhausted'),
      expect.objectContaining({ error: 'InvalidClientTokenId' }),
    );
  });

  it('should never log the access key or secret access key values (verify never exposes them to this module)', async () => {
    const error = new Error('The security token included in the request is invalid');
    const verify = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const secretMarker = 'AKIDSHOULDNEVERAPPEAR';

    await expect(verifyAccessKeyWithRetry(verify, { sleep })).rejects.toThrow(error);

    const allLogCalls = [
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ];
    expect(JSON.stringify(allLogCalls)).not.toContain(secretMarker);
  });
});
