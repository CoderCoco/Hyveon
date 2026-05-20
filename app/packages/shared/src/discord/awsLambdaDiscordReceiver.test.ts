import { describe, it, expect } from 'vitest';
import { AwsLambdaDiscordReceiver } from './awsLambdaDiscordReceiver.js';

describe('AwsLambdaDiscordReceiver', () => {
  it('should return the url when discord_interactions_url is set', async () => {
    const url = 'https://abc123.execute-api.us-east-1.amazonaws.com/interactions';
    const receiver = new AwsLambdaDiscordReceiver({ discord_interactions_url: url });
    expect(await receiver.getInteractionEndpointUrl()).toBe(url);
  });

  it('should return null when discord_interactions_url is null', async () => {
    const receiver = new AwsLambdaDiscordReceiver({ discord_interactions_url: null });
    expect(await receiver.getInteractionEndpointUrl()).toBeNull();
  });

  it('should return null when discord_interactions_url is not provided', async () => {
    const receiver = new AwsLambdaDiscordReceiver({ discord_interactions_url: undefined });
    expect(await receiver.getInteractionEndpointUrl()).toBeNull();
  });
});
