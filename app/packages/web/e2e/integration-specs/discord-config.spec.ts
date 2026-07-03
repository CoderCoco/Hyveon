import { DiscordController } from '@hyveon/desktop-main/dist/controllers/discord.controller.js';
import { test, expect } from './index.js';

/**
 * Verifies the server-side secret-redaction contract for `DiscordController.getConfig`.
 *
 * `DiscordController.getConfig()` delegates to `DiscordConfigService.getRedacted()`,
 * which returns `botTokenSet`/`publicKeySet` booleans in place of the raw secrets.
 * This spec dispatches directly to the IPC controller and asserts that the raw
 * `botToken` and `publicKey` fields are absent from the response body.
 *
 * DynamoDB and Secrets Manager calls fail gracefully in the test environment
 * (no real AWS credentials), so the service returns an empty config with both
 * `*Set` flags false — which is still sufficient to prove the redaction contract.
 */
test.describe('Discord config — secret redaction', () => {
  test('should never echo the bot token or public key in the config response', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    const body = (await ipc.dispatch(DiscordController, 'getConfig')) as Record<string, unknown>;

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
