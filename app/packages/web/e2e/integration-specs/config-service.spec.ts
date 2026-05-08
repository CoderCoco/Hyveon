import { test, expect } from './index.js';

const BASE = 'http://localhost:3002';
const HEADERS = { Authorization: 'Bearer test-token' };

/**
 * Verifies that ConfigService correctly reads from the synthetic tfstate fixture
 * (`e2e/fixtures/tfstate.fixture.json`) injected via `TF_STATE_PATH` at
 * test-server startup.
 */
test.describe('ConfigService — tfstate fixture', () => {
  test('should return aws_region and domain from tfstate fixture', async ({ request, serverMocks: _ }) => {
    void _;
    const resp = await request.get(`${BASE}/api/env`, { headers: HEADERS });
    expect(resp.status()).toBe(200);
    const body = await resp.json() as { region: string; domain: string; environment: string };
    expect(body.region).toBe('us-east-1');
    expect(body.domain).toBe('test.example.com');
    // 'PROD' is derived when domain_name is non-empty
    expect(body.environment).toBe('PROD');
  });

  test('should return game names from tfstate fixture', async ({ request, serverMocks: _ }) => {
    void _;
    const resp = await request.get(`${BASE}/api/games`, { headers: HEADERS });
    expect(resp.status()).toBe(200);
    const body = await resp.json() as { games: string[] };
    expect(body.games).toEqual(['minecraft', 'valheim']);
  });

  test('should return status entries for all games in tfstate fixture', async ({ request, serverMocks: _ }) => {
    void _;
    const resp = await request.get(`${BASE}/api/status`, { headers: HEADERS });
    expect(resp.status()).toBe(200);
    const statuses = await resp.json() as Array<{ game: string; state: string }>;
    // Default mock state — no queued ListTasks responses → empty taskArns → stopped
    expect(statuses.map((s) => s.game).sort()).toEqual(['minecraft', 'valheim']);
    statuses.forEach((s) => expect(s.state).toBe('stopped'));
  });
});
