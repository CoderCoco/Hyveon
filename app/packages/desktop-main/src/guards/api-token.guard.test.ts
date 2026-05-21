import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

import { ApiTokenGuard } from './api-token.guard.js';
import type { ConfigService } from '../services/ConfigService.js';

/** Build a stub `ConfigService` whose `getApiToken()` returns the supplied value. */
function makeConfig(token: string | null | (() => string | null)): ConfigService {
  const get = typeof token === 'function' ? token : (): string | null => token;
  return { getApiToken: get } as Partial<ConfigService> as ConfigService;
}

/**
 * Build a minimal `ExecutionContext` whose `switchToHttp().getRequest()`
 * returns a stub request with the supplied headers. Sufficient for the
 * guard's behavioral assertions — the guard only touches `headers`, `path`,
 * and `method`.
 */
function makeContext(
  headers: Record<string, string | undefined> = {},
  type: 'http' | 'rpc' = 'http',
): ExecutionContext {
  const req = { headers, path: '/api/status', method: 'GET' };
  return {
    getType: () => type,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

describe('ApiTokenGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('non-HTTP context (IPC microservice)', () => {
    it('should pass through without checking headers when context type is rpc', () => {
      const guard = new ApiTokenGuard(makeConfig('secret'));
      expect(guard.canActivate(makeContext({}, 'rpc'))).toBe(true);
    });
  });

  describe('no token configured', () => {
    it('should pass the request through and log a warning the first time', () => {
      const guard = new ApiTokenGuard(makeConfig(null));
      expect(guard.canActivate(makeContext())).toBe(true);
    });

    it('should warn only once across many requests', async () => {
      const { logger } = await import('../logger.js');
      const guard = new ApiTokenGuard(makeConfig(null));
      for (let i = 0; i < 5; i++) {
        guard.canActivate(makeContext());
      }
      expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    });
  });

  describe('token configured', () => {
    it('should 401 when no Authorization header is present', () => {
      const guard = new ApiTokenGuard(makeConfig('secret'));
      try {
        guard.canActivate(makeContext());
        expect.fail('expected UnauthorizedException');
      } catch (err) {
        expect(err).toBeInstanceOf(UnauthorizedException);
        expect((err as UnauthorizedException).getResponse()).toEqual({
          error: 'missing bearer token',
        });
      }
    });

    it('should 401 when Authorization is not a Bearer scheme', () => {
      const guard = new ApiTokenGuard(makeConfig('secret'));
      expect(() => guard.canActivate(makeContext({ authorization: 'Basic abc' }))).toThrow(
        UnauthorizedException,
      );
    });

    it('should 401 on a mismatched bearer token', () => {
      const guard = new ApiTokenGuard(makeConfig('secret'));
      try {
        guard.canActivate(makeContext({ authorization: 'Bearer wrong' }));
        expect.fail('expected UnauthorizedException');
      } catch (err) {
        expect(err).toBeInstanceOf(UnauthorizedException);
        expect((err as UnauthorizedException).getResponse()).toEqual({
          error: 'invalid bearer token',
        });
      }
    });

    it('should pass the request through when the bearer token matches', () => {
      const guard = new ApiTokenGuard(makeConfig('secret'));
      expect(guard.canActivate(makeContext({ authorization: 'Bearer secret' }))).toBe(true);
    });

    it('should tolerate extra whitespace around the bearer token', () => {
      const guard = new ApiTokenGuard(makeConfig('secret'));
      expect(guard.canActivate(makeContext({ authorization: 'Bearer   secret  ' }))).toBe(true);
    });

    it('should re-resolve the token on every call (so rotation takes effect live)', () => {
      let current: string | null = 'first';
      const guard = new ApiTokenGuard(makeConfig(() => current));

      expect(guard.canActivate(makeContext({ authorization: 'Bearer first' }))).toBe(true);

      current = 'second';
      expect(() =>
        guard.canActivate(makeContext({ authorization: 'Bearer first' })),
      ).toThrow(UnauthorizedException);

      expect(guard.canActivate(makeContext({ authorization: 'Bearer second' }))).toBe(true);
    });
  });
});
