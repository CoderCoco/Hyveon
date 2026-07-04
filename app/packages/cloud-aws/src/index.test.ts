import { describe, it, expect } from 'vitest';
import {
  AwsCloudProvider,
  AwsDiscordEventReceiver,
  AwsRemoteFileStore,
  AwsSecretsStore,
} from './index.js';

/**
 * Smoke test for the `@hyveon/cloud-aws` barrel export. Verifies that every
 * AWS-backed class is re-exported from the package root so consumers can
 * `import { AwsCloudProvider } from '@hyveon/cloud-aws'` without reaching
 * into individual source files.
 *
 * Most stub methods are declared with `Promise<...>` / `AsyncIterable<...>`
 * return types, but throw synchronously (they aren't `async` functions), so
 * those assertions use `expect(() => ...).toThrow(...)` rather than
 * `.rejects.toThrow(...)`. `AwsCloudProvider`'s workload and cost-estimate
 * methods (`startWorkload`/`stopWorkload`/`getWorkloadStatus`/
 * `streamWorkloadLogs`/`getCostEstimate`) are real `async`/async-generator
 * implementations, so their "no config supplied" branch is asserted via
 * `.rejects`/`.resolves` instead. `getActualCosts` performs a real Cost
 * Explorer call with no config-driven guard, so it isn't exercised by this
 * barrel-export smoke test — see `AwsCloudProvider.test.ts` for its coverage.
 * `AwsSecretsStore` is likewise a real Secrets-Manager-backed implementation
 * rather than a stub, so only its constructibility is asserted here — see
 * `AwsSecretsStore.test.ts` for behavioural coverage of `get`/`put`/`exists`.
 * `AwsRemoteFileStore` is also a real S3-backed implementation rather than a
 * stub; its "no bucket configured" guard is asserted here via `.rejects` (all
 * three methods are `async` and reject rather than throw synchronously), and
 * behavioural coverage of `get`/`put`/`listVersions` against a mocked S3
 * client lives in `AwsRemoteFileStore.test.ts`.
 */
describe('cloud-aws barrel export', () => {
  it('should export AwsCloudProvider as a constructible class', () => {
    expect(new AwsCloudProvider()).toBeInstanceOf(AwsCloudProvider);
  });

  it('should reject with a "Terraform not applied" error when startWorkload is called without config', async () => {
    await expect(new AwsCloudProvider().startWorkload('x', {})).rejects.toThrow(
      "Terraform not applied. Run 'terraform apply' first.",
    );
  });

  it('should reject with a "Terraform not applied" error when stopWorkload is called without config', async () => {
    await expect(new AwsCloudProvider().stopWorkload('x')).rejects.toThrow('Terraform not applied.');
  });

  it('should return a not_deployed status when getWorkloadStatus is called without config', async () => {
    await expect(new AwsCloudProvider().getWorkloadStatus('x')).resolves.toEqual({
      state: 'not_deployed',
      message: 'Run terraform apply first.',
    });
  });

  it('should reject with a "Terraform not applied" error when streamWorkloadLogs is iterated without config', async () => {
    const controller = new AbortController();
    await expect(
      (async () => {
        for await (const _chunk of new AwsCloudProvider().streamWorkloadLogs('x', controller.signal)) {
          // draining the generator triggers the guard check on first iteration
        }
      })(),
    ).rejects.toThrow("Terraform not applied. Run 'terraform apply' first.");
  });

  it('should return a zeroed CostBreakdown when getCostEstimate is called without config', async () => {
    await expect(new AwsCloudProvider().getCostEstimate()).resolves.toEqual({
      total: 0,
      currency: 'USD',
      breakdown: {},
    });
  });

  it('should export AwsDiscordEventReceiver as a constructible class', () => {
    expect(new AwsDiscordEventReceiver()).toBeInstanceOf(AwsDiscordEventReceiver);
  });

  it('should throw a Not implemented error when getInteractionEndpointUrl is called', () => {
    expect(() => new AwsDiscordEventReceiver().getInteractionEndpointUrl()).toThrow(
      'Not implemented',
    );
  });

  it('should export AwsRemoteFileStore as a constructible class', () => {
    expect(new AwsRemoteFileStore()).toBeInstanceOf(AwsRemoteFileStore);
  });

  it('should reject with a "bucket not configured" error when get is called without config', async () => {
    await expect(new AwsRemoteFileStore().get('path')).rejects.toThrow('bucket not configured');
  });

  it('should reject with a "bucket not configured" error when put is called without config', async () => {
    await expect(new AwsRemoteFileStore().put('path', new Uint8Array())).rejects.toThrow(
      'bucket not configured',
    );
  });

  it('should reject with a "bucket not configured" error when listVersions is called without config', async () => {
    await expect(new AwsRemoteFileStore().listVersions('path')).rejects.toThrow(
      'bucket not configured',
    );
  });

  it('should export AwsSecretsStore as a constructible class', () => {
    expect(new AwsSecretsStore()).toBeInstanceOf(AwsSecretsStore);
  });
});
