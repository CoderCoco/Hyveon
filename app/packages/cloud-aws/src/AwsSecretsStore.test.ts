import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import { SECRET_PLACEHOLDER } from '@hyveon/shared';
import { AwsSecretsStore } from './AwsSecretsStore.js';

/** Typed stand-in for the AWS Secrets Manager SDK client. */
const secretsMock = mockClient(SecretsManagerClient);

/**
 * Build an {@link AwsSecretsStore} whose region-resolution callback returns a
 * fixed region, avoiding any need to read/mutate `process.env` in tests.
 */
function makeStore(region = 'us-east-1'): AwsSecretsStore {
  return new AwsSecretsStore(() => region);
}

describe('AwsSecretsStore', () => {
  beforeEach(() => {
    secretsMock.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('get', () => {
    it('should return the trimmed secret value on a successful lookup', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({ SecretString: '  real-value  ' });

      const store = makeStore();
      await expect(store.get('my-secret')).resolves.toBe('real-value');

      const input = secretsMock.commandCalls(GetSecretValueCommand)[0]!.args[0].input;
      expect(input.SecretId).toBe('my-secret');
    });

    it('should return undefined when the secret does not exist (ResourceNotFoundException)', async () => {
      secretsMock
        .on(GetSecretValueCommand)
        .rejects(new ResourceNotFoundException({ message: 'not found', $metadata: {} }));

      const store = makeStore();
      await expect(store.get('missing-secret')).resolves.toBeUndefined();
    });

    it('should rethrow errors other than ResourceNotFoundException', async () => {
      secretsMock.on(GetSecretValueCommand).rejects(new Error('throttled'));

      const store = makeStore();
      await expect(store.get('my-secret')).rejects.toThrow('throttled');
    });

    it('should return undefined when SecretString is empty/whitespace-only', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({ SecretString: '   ' });

      const store = makeStore();
      await expect(store.get('my-secret')).resolves.toBeUndefined();
    });

    it('should return undefined when SecretString is undefined', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({});

      const store = makeStore();
      await expect(store.get('my-secret')).resolves.toBeUndefined();
    });

    it('should return undefined when the secret still holds the Terraform placeholder', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({ SecretString: SECRET_PLACEHOLDER });

      const store = makeStore();
      await expect(store.get('my-secret')).resolves.toBeUndefined();
    });

    it('should cache a resolved value so repeated get() calls only hit Secrets Manager once', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({ SecretString: 'cached-value' });

      const store = makeStore();
      await store.get('my-secret');
      await store.get('my-secret');
      await store.get('my-secret');

      expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    });

    it('should re-fetch once the 5-minute cache TTL has expired', async () => {
      vi.useFakeTimers();
      secretsMock
        .on(GetSecretValueCommand)
        .resolvesOnce({ SecretString: 'first-value' })
        .resolves({ SecretString: 'second-value' });

      const store = makeStore();
      await expect(store.get('my-secret')).resolves.toBe('first-value');

      // Advance just past the 5-minute cache TTL.
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      await expect(store.get('my-secret')).resolves.toBe('second-value');
      expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    });

    it('should not return an unrelated cached value for a different secret name', async () => {
      secretsMock
        .on(GetSecretValueCommand, { SecretId: 'secret-a' })
        .resolves({ SecretString: 'value-a' });
      secretsMock
        .on(GetSecretValueCommand, { SecretId: 'secret-b' })
        .resolves({ SecretString: 'value-b' });

      const store = makeStore();
      expect(await store.get('secret-a')).toBe('value-a');
      expect(await store.get('secret-b')).toBe('value-b');
    });
  });

  describe('put', () => {
    it('should write the trimmed value under the given SecretId', async () => {
      secretsMock.on(PutSecretValueCommand).resolves({});

      const store = makeStore();
      await store.put('my-secret', '  new-value  ');

      const calls = secretsMock.commandCalls(PutSecretValueCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.SecretId).toBe('my-secret');
      expect(calls[0]!.args[0].input.SecretString).toBe('new-value');
    });

    it('should invalidate that name\'s cache entry so the next get() re-fetches', async () => {
      secretsMock
        .on(GetSecretValueCommand)
        .resolvesOnce({ SecretString: 'old-value' })
        .resolvesOnce({ SecretString: 'new-value' });
      secretsMock.on(PutSecretValueCommand).resolves({});

      const store = makeStore();
      expect(await store.get('my-secret')).toBe('old-value');
      await store.put('my-secret', 'new-value');
      expect(await store.get('my-secret')).toBe('new-value');
    });
  });

  describe('exists', () => {
    it('should return true when get() resolves a value', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({ SecretString: 'a-value' });

      const store = makeStore();
      await expect(store.exists('my-secret')).resolves.toBe(true);
    });

    it('should return false when get() resolves undefined', async () => {
      secretsMock
        .on(GetSecretValueCommand)
        .rejects(new ResourceNotFoundException({ message: 'not found', $metadata: {} }));

      const store = makeStore();
      await expect(store.exists('missing-secret')).resolves.toBe(false);
    });
  });

  describe('region resolution', () => {
    it('should build the Secrets Manager client with the region returned by the getRegion callback', async () => {
      let observedRegion: string | undefined;
      secretsMock.on(GetSecretValueCommand).callsFake(async (_input, getClient) => {
        observedRegion = await getClient().config.region();
        return { SecretString: 'a-value' };
      });

      const store = makeStore('eu-west-1');
      await store.get('my-secret');

      expect(observedRegion).toBe('eu-west-1');
    });

    it('should resolve the region freshly on every call, picking up a region change between calls', async () => {
      const regions = ['us-east-1', 'eu-west-1'];
      let call = 0;
      const observedRegions: string[] = [];
      secretsMock.on(GetSecretValueCommand).callsFake(async (_input, getClient) => {
        observedRegions.push(await getClient().config.region());
        return { SecretString: 'a-value' };
      });

      const store = new AwsSecretsStore(() => regions[call++] ?? 'us-east-1');
      // Distinct names avoid the get() cache short-circuiting the second fetch.
      await store.get('secret-a');
      await store.get('secret-b');

      expect(observedRegions).toEqual(['us-east-1', 'eu-west-1']);
    });
  });
});
