import type { DiscordEventReceiver } from '@hyveon/shared';

/**
 * Minimal subset of Terraform-derived configuration this receiver needs.
 */
export interface AwsDiscordEventReceiverConfig {
  /** The API Gateway/Lambda invoke URL Discord should POST interactions to,
   *  or `null`/`undefined` when no endpoint has been provisioned yet. */
  interactionsInvokeUrl: string | null | undefined;
}

/**
 * AWS implementation of the cloud-agnostic {@link DiscordEventReceiver} contract.
 *
 * Resolves the interactions endpoint URL from a `getConfig` callback,
 * mirroring `AwsCloudProvider`/`AwsSecretsStore`'s `getConfig` callback
 * pattern so a value that changes between calls (e.g. re-applied Terraform
 * state) is always read fresh rather than captured once at construction.
 * Callers typically source `interactionsInvokeUrl` from
 * `ConfigService.getTfOutputs()`'s `interactions_invoke_url` field (parsed
 * from `terraform.tfstate`, S3 backend), the same Terraform-derived value
 * `DiscordConfigService` reads elsewhere.
 */
export class AwsDiscordEventReceiver implements DiscordEventReceiver {
  /**
   * @param getConfig - Resolves the current Terraform-derived configuration
   *   on every call. Omit when no interactions endpoint is available yet
   *   (e.g. before `terraform apply` has run) — {@link getInteractionEndpointUrl}
   *   resolves to `null` rather than throwing in that case.
   */
  constructor(
    private readonly getConfig?: () => AwsDiscordEventReceiverConfig | null | undefined,
  ) {}

  /**
   * Resolves the public URL Discord should send interaction events to.
   *
   * @returns A promise that resolves to the interactions endpoint URL, or
   *   `null` when no `getConfig` callback was supplied, the callback itself
   *   returns `null`/`undefined`, or the resolved config's
   *   `interactionsInvokeUrl` field is `null`/`undefined`. Never throws.
   */
  async getInteractionEndpointUrl(): Promise<string | null> {
    return this.getConfig?.()?.interactionsInvokeUrl ?? null;
  }
}
