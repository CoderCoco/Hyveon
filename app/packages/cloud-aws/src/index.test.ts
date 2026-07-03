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
 * `.rejects.toThrow(...)`. `AwsCloudProvider`'s workload methods
 * (`startWorkload`/`stopWorkload`/`getWorkloadStatus`) are real `async`
 * implementations, so their "no config supplied" branch is asserted via
 * `.rejects`/`.resolves` instead.
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

  it('should throw a Not implemented error when streamWorkloadLogs is called', () => {
    const controller = new AbortController();
    expect(() => new AwsCloudProvider().streamWorkloadLogs('x', controller.signal)).toThrow(
      'Not implemented',
    );
  });

  it('should throw a Not implemented error when getCostEstimate is called', () => {
    expect(() => new AwsCloudProvider().getCostEstimate()).toThrow('Not implemented');
  });

  it('should throw a Not implemented error when getActualCosts is called', () => {
    const range = { start: new Date(), end: new Date() };
    expect(() => new AwsCloudProvider().getActualCosts(range)).toThrow('Not implemented');
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

  it('should throw a Not implemented error when get is called', () => {
    expect(() => new AwsRemoteFileStore().get('path')).toThrow('Not implemented');
  });

  it('should throw a Not implemented error when put is called', () => {
    expect(() => new AwsRemoteFileStore().put('path', new Uint8Array())).toThrow(
      'Not implemented',
    );
  });

  it('should throw a Not implemented error when listVersions is called', () => {
    expect(() => new AwsRemoteFileStore().listVersions('path')).toThrow('Not implemented');
  });

  it('should export AwsSecretsStore as a constructible class', () => {
    expect(new AwsSecretsStore()).toBeInstanceOf(AwsSecretsStore);
  });

  it('should throw a Not implemented error when get is called', () => {
    expect(() => new AwsSecretsStore().get('name')).toThrow('Not implemented');
  });

  it('should throw a Not implemented error when put is called', () => {
    expect(() => new AwsSecretsStore().put('name', 'value')).toThrow('Not implemented');
  });

  it('should throw a Not implemented error when exists is called', () => {
    expect(() => new AwsSecretsStore().exists('name')).toThrow('Not implemented');
  });
});
