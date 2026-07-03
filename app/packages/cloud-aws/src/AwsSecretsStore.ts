import type { SecretsStore } from '@hyveon/shared';

/**
 * AWS implementation of the cloud-agnostic {@link SecretsStore} contract.
 *
 * This is currently a stub — every method throws until the AWS SDK-backed
 * logic (Secrets Manager) lands in follow-up tasks. The class exists so the
 * shape of the store is fixed early and downstream wiring (DI, module
 * registration) can be built against a real type.
 */
export class AwsSecretsStore implements SecretsStore {
  /**
   * Retrieves the value of a secret by name.
   *
   * @param _name - The name of the secret to retrieve.
   */
  get(_name: string): Promise<string | undefined> {
    throw new Error('Not implemented: get — see Epic #137');
  }

  /**
   * Creates or updates the value of a secret.
   *
   * @param _name - The name of the secret to write.
   * @param _value - The value to store.
   */
  put(_name: string, _value: string): Promise<void> {
    throw new Error('Not implemented: put — see Epic #137');
  }

  /**
   * Checks whether a secret with the given name exists.
   *
   * @param _name - The name of the secret to check.
   */
  exists(_name: string): Promise<boolean> {
    throw new Error('Not implemented: exists — see Epic #137');
  }
}
