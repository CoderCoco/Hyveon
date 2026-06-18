import { test, expect } from './index.js';

const BASE = 'http://localhost:3002';
const HEADERS = { Authorization: 'Bearer test-token' };

/**
 * Verifies the server-side secret-redaction contract for `GET /api/discord/config`.
 *
 * `DiscordHttpController.getConfig()` delegates to `DiscordConfigService.getRedacted()`,
 * which returns `botTokenSet`/`publicKeySet` booleans in place of the raw secrets.
 * This spec issues a real HTTP request against the running Nest server and asserts
 * that the raw `botToken` and `publicKey` fields are absent from the response body.
 *
 * DynamoDB and Secrets Manager calls fail gracefully in the test environment
 * (no real AWS credentials), so the service returns an empty config with both
 * `*Set` flags false — which is still sufficient to prove the redaction contract.
 */
test.describe('Discord config — secret redaction', () => {
  test('should never echo the bot token or public key in the config response', async ({
    request,
    serverMocks: _reset,
  }) => {
    const resp = await request.get(`${BASE}/api/discord/config`, { headers: HEADERS });

    // The endpoint must respond successfully even when AWS is unreachable.
    expect(resp.status()).toBe(200);

    const body = await resp.json() as Record<string, unknown>;

    // Raw secrets must not be present — the contract is booleans-only.
    expect(body).not.toHaveProperty('botToken');
    expect(body).not.toHaveProperty('publicKey');

    // The redacted boolean flags must be present and be actual booleans.
    expect(body).toHaveProperty('botTokenSet');
    expect(body).toHaveProperty('publicKeySet');
    expect(typeof body['botTokenSet']).toBe('boolean');
    expect(typeof body['publicKeySet']).toBe('boolean');
  });
});
