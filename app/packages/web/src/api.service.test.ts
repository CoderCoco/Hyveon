import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getStoredApiToken,
  setStoredApiToken,
  setUnauthorizedHandler,
  retryPendingAfterAuth,
  api,
} from './api.service.js';

// jsdom provides localStorage, but we replace it with a controlled stub so
// tests are isolated from each other's stored tokens.
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: () => { store = {}; },
  };
})();

beforeEach(() => {
  localStorageMock.clear();
  localStorageMock.getItem.mockClear();
  localStorageMock.setItem.mockClear();
  localStorageMock.removeItem.mockClear();
  vi.stubGlobal('localStorage', localStorageMock);
  setStoredApiToken('');
  setUnauthorizedHandler(null);
});

afterEach(async () => {
  // Drain any requests that were parked by a 401 and not resolved by the test
  // itself, so they don't leak into the next test's pendingRetries queue.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true, json: () => Promise.resolve(null) }));
  await retryPendingAfterAuth();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getStoredApiToken / setStoredApiToken', () => {
  it('should return an empty string when no token has been stored', () => {
    expect(getStoredApiToken()).toBe('');
  });

  it('should persist and retrieve a non-empty token', () => {
    setStoredApiToken('my-api-token');
    expect(getStoredApiToken()).toBe('my-api-token');
  });

  it('should remove the stored token when called with an empty string', () => {
    setStoredApiToken('tok');
    setStoredApiToken('');
    expect(getStoredApiToken()).toBe('');
  });

  it('should return empty string when localStorage.getItem throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('unavailable'); },
    });
    expect(getStoredApiToken()).toBe('');
  });

  it('should silently ignore setItem errors (e.g. private browsing quota)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceeded'); },
      removeItem: () => { throw new Error('unavailable'); },
    });
    expect(() => setStoredApiToken('tok')).not.toThrow();
    expect(() => setStoredApiToken('')).not.toThrow();
  });
});

describe('successful requests', () => {
  it('should include the stored token as a Bearer Authorization header', async () => {
    setStoredApiToken('secret-key');
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ games: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.games();

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer secret-key');
  });

  it('should omit the Authorization header when no token is stored', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ games: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.games();

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBeNull();
  });

  it('should throw an Error on a non-401 HTTP error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 500, ok: false }));
    await expect(api.status()).rejects.toThrow('API error 500');
  });
});

describe('api endpoint methods', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({}),
    }));
  });

  it('should call GET /api/env for api.env()', async () => {
    await api.env();
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/env');
  });

  it('should call GET /api/games for api.games()', async () => {
    await api.games();
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/games');
  });

  it('should call GET /api/status for api.status()', async () => {
    await api.status();
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/status');
  });

  it('should call GET /api/status/:game for api.statusGame()', async () => {
    await api.statusGame('minecraft');
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/status/minecraft');
  });

  it('should call POST /api/start/:game for api.start()', async () => {
    await api.start('minecraft');
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/start/minecraft');
    expect(init?.method).toBe('POST');
  });

  it('should call POST /api/stop/:game for api.stop()', async () => {
    await api.stop('palworld');
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/stop/palworld');
    expect(init?.method).toBe('POST');
  });

  it('should call GET /api/costs/estimate for api.costsEstimate()', async () => {
    await api.costsEstimate();
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/costs/estimate');
  });

  it('should include the days query parameter for api.costsActual()', async () => {
    await api.costsActual(14);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/costs/actual?days=14');
  });

  it('should call GET /api/files/:game for api.filesMgrStatus()', async () => {
    await api.filesMgrStatus('minecraft');
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/files/minecraft');
  });

  it('should call POST /api/discord/guilds for api.discordAddGuild()', async () => {
    await api.discordAddGuild('G1');
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/discord/guilds');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ guildId: 'G1' });
  });

  it('should call DELETE /api/discord/guilds/:guildId for api.discordRemoveGuild()', async () => {
    await api.discordRemoveGuild('G1');
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/discord/guilds/G1');
    expect(init?.method).toBe('DELETE');
  });
});

describe('401 retry queue', () => {
  it('should invoke the unauthorized handler and park the request when a 401 is received', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    // First call returns 401; the mock will be replaced before retrying.
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ status: 401, ok: false })
        .mockResolvedValue({ status: 200, ok: true, json: () => Promise.resolve([]) }),
    );

    const pending = api.status();
    // Allow microtasks to flush so the 401 is processed and the handler fires.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledOnce();

    // Replay with a new token — all queued requests should succeed.
    setStoredApiToken('fresh-token');
    const allOk = await retryPendingAfterAuth();
    expect(allOk).toBe(true);
    await expect(pending).resolves.toEqual([]);
  });

  it('should return true immediately when there are no queued requests', async () => {
    expect(await retryPendingAfterAuth()).toBe(true);
  });

  it('should return false and re-queue requests that receive a second 401 on retry', async () => {
    setUnauthorizedHandler(null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401, ok: false }));

    // Fire a request that will 401 and get queued.
    const p = api.status().catch(() => { /* intentionally swallowed */ });
    await new Promise<void>((r) => setTimeout(r, 0));

    // The retry also 401s — retryPendingAfterAuth should signal failure.
    const allOk = await retryPendingAfterAuth();
    expect(allOk).toBe(false);

    // Clean up: drain the queue so it doesn't bleed into other tests.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true, json: () => Promise.resolve([]) }));
    await retryPendingAfterAuth();
    await p;
  });
});
