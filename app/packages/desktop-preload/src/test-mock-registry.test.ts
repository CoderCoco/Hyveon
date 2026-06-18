import { afterEach, describe, expect, it, vi } from 'vitest';
import { register, lookup, clear, buildMockGsd } from './test-mock-registry.js';
import type { GsdGamesApi, GsdEnvApi } from './gsd-api.js';

/** Minimal stub for GsdGamesApi — only the methods the registry tests need. */
function makeGamesStub(): GsdGamesApi {
  return {
    list: vi.fn().mockResolvedValue({ games: [] }),
    status: vi.fn().mockResolvedValue([]),
    getStatus: vi.fn().mockResolvedValue({ game: 'minecraft', state: 'stopped' }),
    start: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
    stop: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
  };
}

/** Minimal stub for GsdEnvApi. */
function makeEnvStub(): GsdEnvApi {
  return {
    get: vi.fn().mockResolvedValue({ region: 'us-east-1', domain: 'example.com', environment: 'dev' }),
  };
}

afterEach(() => {
  clear();
});

describe('register and lookup', () => {
  it('should return the registered mock when looked up by namespace', () => {
    const games = makeGamesStub();
    register('games', games);
    expect(lookup('games')).toBe(games);
  });

  it('should return undefined for a namespace that has not been registered', () => {
    expect(lookup('env')).toBeUndefined();
  });

  it('should overwrite an earlier mock when register is called twice for the same namespace', () => {
    const first = makeGamesStub();
    const second = makeGamesStub();
    register('games', first);
    register('games', second);
    expect(lookup('games')).toBe(second);
    expect(lookup('games')).not.toBe(first);
  });

  it('should support registering and looking up multiple namespaces independently', () => {
    const games = makeGamesStub();
    const env = makeEnvStub();
    register('games', games);
    register('env', env);
    expect(lookup('games')).toBe(games);
    expect(lookup('env')).toBe(env);
  });
});

describe('clear', () => {
  it('should remove all registered mocks so every subsequent lookup returns undefined', () => {
    register('games', makeGamesStub());
    register('env', makeEnvStub());
    clear();
    expect(lookup('games')).toBeUndefined();
    expect(lookup('env')).toBeUndefined();
  });

  it('should be safe to call when the registry is already empty', () => {
    expect(() => clear()).not.toThrow();
  });
});

describe('buildMockGsd', () => {
  it('should return an object containing only the namespaces that have been registered', () => {
    const games = makeGamesStub();
    register('games', games);
    const gsd = buildMockGsd();
    expect(gsd.games).toBe(games);
    expect(gsd.env).toBeUndefined();
  });

  it('should return an empty object when the registry has been cleared', () => {
    register('games', makeGamesStub());
    clear();
    expect(buildMockGsd()).toEqual({});
  });
});
