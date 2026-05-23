import { describe, it, expect } from 'vitest';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

/**
 * Re-import logger module fresh for each test that cares about the singleton
 * state.  We use a plain import at the top for the factory tests; the
 * singleton re-assignment tests use the same module reference.
 */
import { createLogger, logger as initialLogger } from './logger.js';

describe('createLogger', () => {
  it('should return a winston.Logger instance', () => {
    const result = createLogger('/tmp/test-logs');
    // Winston's createLogger returns a DerivedLogger that extends EventEmitter.
    // Check the duck-typed API surface rather than constructor identity, which
    // can differ when the same package is loaded from two module cache entries.
    expect(typeof result.info).toBe('function');
    expect(typeof result.error).toBe('function');
    expect(typeof result.debug).toBe('function');
    expect(Array.isArray(result.transports)).toBe(true);
  });

  it('should include a DailyRotateFile transport in the transports array', () => {
    const result = createLogger('/tmp/test-logs');
    const hasRotate = result.transports.some((t) => t instanceof DailyRotateFile);
    expect(hasRotate).toBe(true);
  });

  it('should include a Console transport in the transports array', () => {
    const result = createLogger('/tmp/test-logs');
    const hasConsole = result.transports.some(
      (t) => t instanceof winston.transports.Console,
    );
    expect(hasConsole).toBe(true);
  });

  it('should configure the DailyRotateFile transport with the provided logDir', () => {
    const logDir = '/tmp/my-custom-log-dir';
    const result = createLogger(logDir);
    const rotateTransport = result.transports.find(
      (t) => t instanceof DailyRotateFile,
    ) as InstanceType<typeof DailyRotateFile> | undefined;

    expect(rotateTransport).toBeDefined();
    // The `dirname` option is stored as `options.dirname` on the transport.
    const opts = (rotateTransport as unknown as { options: { dirname: string } })
      .options;
    expect(opts.dirname).toBe(logDir);
  });
});

describe('logger singleton', () => {
  it('should reassign the exported logger binding when createLogger is called', async () => {
    // Capture the initial (console-only) reference.
    const beforeCall = initialLogger;

    // createLogger mutates the exported binding.
    const returned = createLogger('/tmp/test-logs-singleton');

    // The returned value and the freshly-imported binding must be the same object.
    // We re-import via the same module to read the live binding.
    const { logger: afterCall } = await import('./logger.js');
    expect(afterCall).toBe(returned);
    // And it must differ from the pre-call fallback logger.
    expect(afterCall).not.toBe(beforeCall);
  });
});
