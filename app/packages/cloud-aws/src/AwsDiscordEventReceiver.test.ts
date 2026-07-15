import { describe, it, expect } from 'vitest';
import { AwsDiscordEventReceiver } from './AwsDiscordEventReceiver.js';

describe('AwsDiscordEventReceiver', () => {
  describe('getInteractionEndpointUrl', () => {
    it('should return the interactionsInvokeUrl from the resolved config', async () => {
      const receiver = new AwsDiscordEventReceiver(() => ({
        interactionsInvokeUrl: 'https://example.execute-api.us-east-1.amazonaws.com/interactions',
      }));

      await expect(receiver.getInteractionEndpointUrl()).resolves.toBe(
        'https://example.execute-api.us-east-1.amazonaws.com/interactions',
      );
    });

    it('should return null when no getConfig callback was supplied', async () => {
      const receiver = new AwsDiscordEventReceiver();

      await expect(receiver.getInteractionEndpointUrl()).resolves.toBeNull();
    });

    it('should return null when the getConfig callback itself returns null', async () => {
      const receiver = new AwsDiscordEventReceiver(() => null);

      await expect(receiver.getInteractionEndpointUrl()).resolves.toBeNull();
    });

    it('should return null when the resolved config\'s interactionsInvokeUrl is undefined', async () => {
      const receiver = new AwsDiscordEventReceiver(() => ({ interactionsInvokeUrl: undefined }));

      await expect(receiver.getInteractionEndpointUrl()).resolves.toBeNull();
    });

    it('should resolve the config freshly on every call, picking up a value change between calls', async () => {
      const urls: Array<string | null | undefined> = [
        null,
        'https://example.execute-api.us-east-1.amazonaws.com/interactions',
      ];
      let call = 0;
      const receiver = new AwsDiscordEventReceiver(() => ({
        interactionsInvokeUrl: urls[call++],
      }));

      await expect(receiver.getInteractionEndpointUrl()).resolves.toBeNull();
      await expect(receiver.getInteractionEndpointUrl()).resolves.toBe(
        'https://example.execute-api.us-east-1.amazonaws.com/interactions',
      );
    });
  });
});
