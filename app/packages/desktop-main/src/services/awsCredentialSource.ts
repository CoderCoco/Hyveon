import { fromIni } from '@aws-sdk/credential-providers';
import type { ElectronStoreService } from './ElectronStoreService.js';

/** Static access-key/secret pair, as accepted by every `@aws-sdk/client-*` `credentials` field. */
export interface StaticAwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * The `credentials` value every `@aws-sdk/client-*` constructor accepts —
 * static keys for a pasted profile, `fromIni`'s provider function for a
 * real `~/.aws` profile, or `undefined` (SDK falls back to its own default
 * provider chain) when no profile is stored yet.
 */
export type AwsClientCredentials = StaticAwsCredentials | ReturnType<typeof fromIni> | undefined;

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
  const profile = store.get('aws')?.profile;
  if (!profile) {
    return { kind: 'none' };
  }
  let pasted: { accessKeyId: string; secretAccessKey: string; region?: string } | undefined;
  try {
    pasted = store.getPastedCredentials(profile);
  } catch (err) {
    throw new AwsPastedCredentialDecryptError(profile, err);
  }
  if (pasted) {
    return { kind: 'pasted', profile, accessKeyId: pasted.accessKeyId, secretAccessKey: pasted.secretAccessKey };
  }
  return { kind: 'profile', profile };
}

/**
 * Converts {@link resolveAwsCredentialSource}'s result into the `credentials`
 * value an `@aws-sdk/client-*` constructor accepts. Every `@hyveon/cloud-aws`
 * store, plus `EcsService`/`Ec2Service`, otherwise construct their client
 * with `{ region }` alone — the SDK then falls back to
 * `fromNodeProviderChain()`, which resolves nothing in a GUI-launched
 * Electron process (this app's credentials live encrypted in
 * `ElectronStoreService`, never in env vars or `~/.aws`), throwing
 * `CredentialsProviderError`. This is the same static-keys-or-`fromIni`
 * branching {@link IamCheckService.buildClientConfig} already uses for the
 * wizard's own IAM/STS clients, extracted so every other AWS-SDK-client
 * owner in `desktop-main` can share it instead of re-deriving it.
 *
 * @param store - The store to resolve the credential source from, passed to
 *   {@link resolveAwsCredentialSource}.
 * @returns Static keys for a pasted profile, `fromIni({ profile })` for a
 *   real `~/.aws` profile, or `undefined` when no profile is stored yet (the
 *   wizard's credentials step hasn't run — callers already surface a clear
 *   "not configured" error for this case elsewhere and don't rely on this
 *   function to distinguish it).
 * @throws {@link AwsPastedCredentialDecryptError} — see
 *   {@link resolveAwsCredentialSource}.
 */
export function resolveAwsClientCredentials(store: ElectronStoreService): AwsClientCredentials {
  return resolveAwsClientCredentialsWithSignature(store).credentials;
}

/** {@link resolveAwsClientCredentialsWithSignature}'s return shape. */
export interface ResolvedAwsClientCredentials {
  /** The `credentials` value to hand to an `@aws-sdk/client-*` constructor. */
  readonly credentials: AwsClientCredentials;
  /**
   * A cheap, comparable fingerprint of `credentials` — changes whenever the
   * wizard's stored AWS profile selection, pasted key, or credential kind
   * changes, and stays stable otherwise.
   */
  readonly signature: string;
}

/**
 * Same resolution as {@link resolveAwsClientCredentials}, plus a comparable
 * `signature` string callers can cache alongside a lazily-constructed AWS SDK
 * client to detect a credentials change and rebuild it.
 *
 * `credentials` itself can't be used for that comparison: the `'profile'`
 * case returns `fromIni({ profile })`, which allocates a new provider
 * function on every call, so `!==` would always report "changed" even when
 * the profile is the same, while a naive cache that ignores `credentials`
 * entirely (comparing only `region`, as every AWS-SDK-client owner in this
 * codebase did before this field existed) never notices a same-region
 * credential rotation at all and keeps signing requests with the old key
 * until the process restarts.
 *
 * @param store - The store to resolve the credential source from, passed to
 *   {@link resolveAwsCredentialSource}.
 * @throws {@link AwsPastedCredentialDecryptError} — see
 *   {@link resolveAwsCredentialSource}.
 */
export function resolveAwsClientCredentialsWithSignature(store: ElectronStoreService): ResolvedAwsClientCredentials {
  const source = resolveAwsCredentialSource(store);
  switch (source.kind) {
    case 'none':
      return { credentials: undefined, signature: 'none' };
    case 'pasted':
      return {
        credentials: { accessKeyId: source.accessKeyId, secretAccessKey: source.secretAccessKey },
        signature: `pasted:${source.profile}:${source.accessKeyId}`,
      };
    case 'profile':
      return { credentials: fromIni({ profile: source.profile }), signature: `profile:${source.profile}` };
  }
}
