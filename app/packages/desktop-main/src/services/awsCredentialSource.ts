import { logger } from '../logger.js';
import type { ElectronStoreService } from './ElectronStoreService.js';

/**
 * Thrown by {@link resolveAwsCredentialSource} when
 * {@link ElectronStoreService.getPastedCredentials} throws while decrypting a
 * stored pasted-credentials entry — Electron's `safeStorage.decryptString`
 * throws its own raw `Error` for a corrupt or foreign ciphertext blob (e.g.
 * encrypted on a different machine or OS user account; the same underlying
 * condition `PulumiWorkspaceService.resolveStoredPassphrase` already
 * classifies as `'existing-stack-decrypt-failed'` for the passphrase case).
 * That raw error has no distinguishing type of its own, so a caller further
 * up the stack that classifies failures by `instanceof` (see
 * `PulumiService.classifyGetOrCreateStackFailure`) has no way to tell it
 * apart from a genuine mid-operation Pulumi engine failure — this wraps it in
 * a typed class so callers CAN, and never has to also cover
 * `SafeStorageService.decrypt`'s OTHER failure mode (a merely-unavailable
 * keychain, which decrypts to garbage silently rather than throwing — see
 * that method's own remarks) since that path never reaches this catch at
 * all.
 */
export class AwsPastedCredentialDecryptError extends Error {
  constructor(
    public readonly profile: string,
    public readonly cause: unknown,
  ) {
    super(
      `Cannot decrypt the stored pasted-credentials entry for AWS profile "${profile}" — the ciphertext may be ` +
        'corrupted, or encrypted on a different machine or OS user account. Re-enter the credentials via the ' +
        'wizard (or Settings → AWS Resources) to replace the stored entry.',
    );
    this.name = 'AwsPastedCredentialDecryptError';
  }
}

/**
 * The wizard's chosen AWS credential source, resolved from
 * `ElectronStoreService`'s `aws: { region, profile }` selection plus the
 * pasted-credentials map (`creds.aws.<profileName>`) — the single shared
 * decision `BootstrapService` and `IamCheckService` both otherwise need to
 * make privately as `resolveClientConfig`. There is no discriminator field in
 * the store: a stored `profile` name either IS a real
 * `~/.aws` profile or a `creds.aws.<profileName>` pasted entry, distinguished
 * only by whether {@link ElectronStoreService.getPastedCredentials} finds a
 * match — the pasted lookup always wins when both could apply, matching the
 * three services' pre-existing behaviour.
 */
export type AwsCredentialSource =
  /** No profile is stored at all — the wizard's credentials step has not run, or was skipped. */
  | { readonly kind: 'none' }
  /** `profile` resolved to a pasted-credentials entry — decrypted plaintext keys, never a provider function. */
  | { readonly kind: 'pasted'; readonly profile: string; readonly accessKeyId: string; readonly secretAccessKey: string }
  /** `profile` did not resolve to a pasted entry — treated as a real `~/.aws` CLI profile name. */
  | { readonly kind: 'profile'; readonly profile: string };

/**
 * Resolves which AWS credential source the wizard's credentials step
 * selected, without shaping the result for any particular consumer.
 * {@link BootstrapService}/{@link IamCheckService} turn this into an AWS SDK
 * `{ region, credentials }` client config; `PulumiCredentialResolver.ts`
 * turns it into engine `envVars`. Both transforms are consumer-specific —
 * this function only makes the *decision* once, so it is never duplicated a
 * third time.
 *
 * @remarks
 * Deliberately takes no `region` and returns none — `region` is a separate,
 * independent field on the store's `aws` object that each consumer already
 * has its own requirements around (e.g. `BootstrapCredentialsNotConfiguredError`
 * when absent); folding it in here would force every caller through this
 * function's error handling for a concern unrelated to *which credentials* to use.
 *
 * @throws {@link AwsPastedCredentialDecryptError} if `profile` resolves to a
 *   pasted-credentials entry whose stored ciphertext can't be decrypted (see
 *   that class's own doc comment) — wraps `ElectronStoreService.getPastedCredentials`'s
 *   raw, untyped throw so callers that classify failures by type (e.g.
 *   `PulumiService.classifyGetOrCreateStackFailure`) can distinguish it from
 *   an unrelated failure.
 */
export function resolveAwsCredentialSource(store: ElectronStoreService): AwsCredentialSource {
  logger.debug('resolveAwsCredentialSource: resolving active AWS credential source');
  const profile = store.get('aws')?.profile;
  if (!profile) {
    logger.debug('resolveAwsCredentialSource: resolved to "none" — no profile stored');
    return { kind: 'none' };
  }
  let pasted: { accessKeyId: string; secretAccessKey: string; region?: string } | undefined;
  try {
    pasted = store.getPastedCredentials(profile);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('resolveAwsCredentialSource: failed to decrypt stored pasted-credentials entry', {
      profile,
      error: message,
    });
    throw new AwsPastedCredentialDecryptError(profile, err);
  }
  if (pasted) {
    logger.debug('resolveAwsCredentialSource: resolved to "pasted" credentials entry', { profile });
    return { kind: 'pasted', profile, accessKeyId: pasted.accessKeyId, secretAccessKey: pasted.secretAccessKey };
  }
  logger.debug('resolveAwsCredentialSource: resolved to a CLI profile', { profile });
  return { kind: 'profile', profile };
}
