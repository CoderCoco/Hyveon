import { test, expect } from './index.js';

/** Base URL for direct calls to the Nest test server (bypasses the Vite proxy). */
const ENV_URL = 'http://localhost:3002/api/env';

test.describe('ApiTokenGuard', () => {
  test('should reject requests with no Authorization header with 401', async ({ request, serverMocks: _reset }) => {

    const resp = await request.get(ENV_URL);
    expect(resp.status()).toBe(401);
  });

  test('should reject requests with wrong token with 401', async ({ request, serverMocks: _reset }) => {

    const resp = await request.get(ENV_URL, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(resp.status()).toBe(401);
    const body = await resp.json() as { error?: string };
    expect(body.error).toBe('invalid bearer token');
  });

  test('should allow requests with valid Authorization: Bearer header', async ({ request, serverMocks: _reset }) => {

    const resp = await request.get(ENV_URL, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json() as { region: string };
    expect(body.region).toBe('us-east-1');
  });

  test('should allow requests with valid ?token= query param (SSE fallback)', async ({ request, serverMocks: _reset }) => {

    const resp = await request.get(`${ENV_URL}?token=test-token`);
    expect(resp.status()).toBe(200);
    const body = await resp.json() as { region: string };
    expect(body.region).toBe('us-east-1');
  });
});
