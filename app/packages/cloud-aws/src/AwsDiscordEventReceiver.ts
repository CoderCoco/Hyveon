import type { DiscordEventReceiver } from '@hyveon/shared';

/**
 * AWS implementation of the cloud-agnostic {@link DiscordEventReceiver} contract.
 *
 * This is currently a stub — the method throws until the AWS-backed logic
 * (resolving the Lambda/API Gateway interactions endpoint) lands in
 * follow-up tasks. The class exists so the shape of the receiver is fixed
 * early and downstream wiring (DI, module registration) can be built
 * against a real type.
 */
export class AwsDiscordEventReceiver implements DiscordEventReceiver {
  /**
   * Resolves the public URL Discord should send interaction events to.
   */
  getInteractionEndpointUrl(): Promise<string | null> {
    throw new Error('Not implemented: getInteractionEndpointUrl — see Epic #137');
  }
}
