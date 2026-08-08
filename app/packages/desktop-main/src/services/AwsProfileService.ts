import { homedir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { parseKnownFiles } from '@smithy/shared-ini-file-loader';
import type { ParsedIniData } from '@smithy/types';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, CreateAccessKeyCommand, DeleteAccessKeyCommand } from '@aws-sdk/client-iam';
import { logger } from '../logger.js';
import { SafeStorageService } from './SafeStorageService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveAwsCredentialSource } from './awsCredentialSource.js';
import { verifyAccessKeyWithRetry } from './verifyAccessKeyWithRetry.js';
import { sleep } from './sleep.js';

/**
 * Summary of a single AWS CLI profile discovered in `~/.aws/credentials` or
 * `~/.aws/config`. Deliberately minimal — never carries
 * `aws_access_key_id`/`aws_secret_access_key` or any other sensitive field,
 * so this shape is safe to send over IPC to the renderer.
 */
export interface AwsProfileSummary {
  profileName: string;
  region?: string;
}

/** Default profile name used for the wizard's "paste keys instead" flow when the operator doesn't supply one. */
export const DEFAULT_PASTED_PROFILE_NAME = 'hyveon-pasted';

/** Plaintext input to {@link AwsProfileService.savePastedCredentials}. */
export interface SavePastedCredentialsInput {
  /** Defaults to {@link DEFAULT_PASTED_PROFILE_NAME} when omitted. */
  profileName?: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

/**
 * Thrown by {@link AwsProfileService.savePastedCredentials} when the OS
 * keychain (via `SafeStorageService`) is unavailable. Pasted credentials are
 * never persisted in plaintext, so this flow has no fallback — the caller
 * must surface the error and refuse to save rather than silently degrading
 * (unlike `ElectronStoreService`'s generic encrypted accessors, which
 * transparently degrade to plaintext outside Electron for convenience in
 * tests/CI).
 */
export class SafeStorageUnavailableError extends Error {
  constructor() {
    super(
      'Cannot save pasted AWS credentials: the OS keychain (safeStorage) is unavailable. ' +
        'Pasted keys are never stored in plaintext — pick an existing AWS CLI profile instead.',
    );
    this.name = 'SafeStorageUnavailableError';
  }
}

/**
 * Thrown by {@link AwsProfileService.savePastedCredentials} when
 * `accessKeyId` or `secretAccessKey` is blank/whitespace-only — nothing is
 * persisted in that case.
 */
export class InvalidPastedCredentialsError extends Error {
  constructor(field: 'accessKeyId' | 'secretAccessKey') {
    super(`Cannot save pasted AWS credentials: "${field}" must not be blank.`);
    this.name = 'InvalidPastedCredentialsError';
  }
}

/**
 * Thrown by {@link AwsProfileService.rotateActiveCredentials} when the
 * active credential source (per {@link resolveAwsCredentialSource}) is not
 * `kind: 'pasted'`. `AwsProfileService` persists pasted keys
 * (`creds.aws.<profileName>`, via `SafeStorageService` encryption) — it does
 * not, and cannot, own or rewrite a `~/.aws/credentials` file for a
 * `kind: 'profile'` source (a real AWS CLI profile the operator manages
 * themselves), and a `kind: 'none'` source means the wizard's credentials
 * step has not run at all. Thrown before any AWS call is made in either
 * case. The remediation clause differs by `kind` — a `'profile'` source
 * already IS one the operator controls, so telling them to "pick a profile
 * you control" would be circular; they need to rotate it themselves outside
 * this app instead.
 */
export class UnsupportedCredentialSourceError extends Error {
  constructor(kind: 'profile' | 'none') {
    const remediation =
      kind === 'profile'
        ? "rotate that profile's keys yourself via the AWS CLI or console"
        : "complete the wizard's credentials step, or re-run guided provisioning";
    super(`Rotation is only supported for pasted or guided credential sources — ${remediation}.`);
    this.name = 'UnsupportedCredentialSourceError';
  }
}

/**
 * Outcome of {@link AwsProfileService.rotateActiveCredentials}, modeled as a
 * discriminated union rather than throwing for its two expected failure
 * branches — both `verification-failed` and `delete-failed` are recoverable
 * states the caller needs to render distinctly, not exceptional control
 * flow. Named distinctly from `GuidedIamService`'s exported `RotationResult`
 * to avoid a name collision should a caller ever import both rotation
 * methods in the same file; the two types otherwise share the same shape by
 * design — see {@link AwsProfileService.rotateActiveCredentials}'s doc
 * comment for how the two *methods* differ despite the shared shape.
 */
export type AwsProfileRotationResult =
  /** The new key pair is stored/active and the old key has been revoked. */
  | { status: 'complete' }
  /**
   * `sts:GetCallerIdentity` failed for the newly minted key on every retry
   * attempt (see {@link VERIFY_ACCESS_KEY_RETRY_DELAYS_MS}). The stored
   * credentials were never overwritten — the previously active key remains
   * stored and in the keychain. See
   * {@link AwsProfileService.rotateActiveCredentials}'s doc comment for the
   * orphan-cleanup this branch performs before returning.
   */
  | { status: 'verification-failed'; error: string }
  /**
   * `iam:DeleteAccessKey` failed for the old key. The new key pair IS
   * already stored/active — app functionality is fine going forward — but
   * the old key is still live and must be revoked manually via `consoleUrl`.
   */
  | { status: 'delete-failed'; consoleUrl: string };

/**
 * Discovers AWS CLI profiles for the first-run wizard's credentials step
 * (see `openspec/changes/add-first-run-wizard`). Delegates parsing to
 * `@smithy/shared-ini-file-loader`'s `parseKnownFiles` — the same loader the
 * AWS SDK for JS itself uses to resolve profiles — rather than hand-rolling
 * INI parsing, so profile discovery matches `aws configure list-profiles`
 * semantics (config-file `[profile <name>]` sections normalized to
 * `<name>`, both files merged into one profile map).
 */
@Injectable()
export class AwsProfileService {
  constructor(
    private readonly safeStorage: SafeStorageService,
    private readonly store: ElectronStoreService,
  ) {}

  /**
   * Lists every profile found across `~/.aws/credentials` and
   * `~/.aws/config`, sorted alphabetically by name. Only `profileName` and
   * `region` are read out of each profile's parsed fields — every other
   * field (including credential material) is left untouched.
   *
   * @throws `Error` if {@link parseFiles} rejects for a reason other than
   *   missing files (which `parseKnownFiles` already degrades to an empty
   *   map) — the underlying failure is logged via `logger.warn` first, and
   *   only its message (never the raw error object) is rethrown.
   */
  async listProfiles(): Promise<AwsProfileSummary[]> {
    logger.debug('AwsProfileService.listProfiles: reading AWS CLI profiles from disk');
    let parsed: ParsedIniData;
    try {
      parsed = await this.parseFiles();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('AwsProfileService.listProfiles: failed to parse ~/.aws/credentials or ~/.aws/config', {
        error: message,
      });
      throw new Error(`Failed to read AWS CLI profiles: ${message}`);
    }
    return Object.keys(parsed)
      .sort((a, b) => a.localeCompare(b))
      .map((profileName) => {
        const region = parsed[profileName]?.['region'];
        return region ? { profileName, region } : { profileName };
      });
  }

  /**
   * Saves pasted AWS credentials from the wizard's "paste keys instead" flow.
   * Defaults `profileName` to {@link DEFAULT_PASTED_PROFILE_NAME} when
   * omitted. Throws {@link SafeStorageUnavailableError} — without writing
   * anything — when the OS keychain is unavailable, rather than falling
   * back to plaintext storage.
   *
   * @returns The profile name the credentials were saved under.
   */
  savePastedCredentials(input: SavePastedCredentialsInput): { profileName: string } {
    if (!this.safeStorage.isAvailable()) {
      throw new SafeStorageUnavailableError();
    }
    if (!input.accessKeyId.trim()) throw new InvalidPastedCredentialsError('accessKeyId');
    if (!input.secretAccessKey.trim()) throw new InvalidPastedCredentialsError('secretAccessKey');
    const profileName = input.profileName?.trim() || DEFAULT_PASTED_PROFILE_NAME;
    this.store.setPastedCredentials(profileName, {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      region: input.region,
    });
    return { profileName };
  }

  /**
   * Rotates the access key pair behind whatever credential source is
   * currently active — a general-purpose "rotate whatever is currently
   * active" capability (e.g. a future Settings "rotate key" affordance; out
   * of scope here, just the service method). This is distinct from, and
   * shares no code with, {@link GuidedIamService.rotate}: that method
   * performs a one-time mint-then-revoke rotation of a freshly pasted
   * CloudFormation *bootstrap* key during first-run guided provisioning,
   * establishing a brand-new active credential source where none existed
   * before. This method instead replaces the key material behind a source
   * that is *already* the active one, in place, under the same profile name
   * — no separate "activate" write is needed. The two are independent
   * siblings that happen to share the same mint-verify-swap-revoke shape;
   * this method mirrors {@link GuidedIamService.rotate}'s pattern closely
   * (same discriminated-union approach, same explicit-credentials AWS client
   * construction seam style, and — critically — the same
   * orphan-cleanup-on-verification-failure behavior), but never calls it and
   * is never called by it.
   *
   * Only a `kind: 'pasted'` active source (see
   * {@link resolveAwsCredentialSource}) is rotatable — see
   * {@link UnsupportedCredentialSourceError}'s doc comment for why
   * `kind: 'profile'`/`kind: 'none'` are refused.
   *
   * Sequence (load-bearing — do not reorder):
   * 0. **Keychain gate.** If {@link SafeStorageService.isAvailable} is
   *    `false`, throws {@link SafeStorageUnavailableError} before making any
   *    AWS call or resolving anything else — mirrors
   *    {@link GuidedIamService.rotate}'s own step 0 and
   *    {@link savePastedCredentials}'s gate, both guarding the exact same
   *    hazard: `ElectronStoreService.setPastedCredentials` calls
   *    `SafeStorageService.encrypt` unconditionally, and `encrypt` silently
   *    degrades to returning plaintext (with only a logged warning, never a
   *    throw) when the keychain is unavailable. Without this gate, a
   *    keychain that locks mid-rotation — after step 0's resolve/decrypt of
   *    the *current* credentials succeeded, but before step 4's
   *    `setPastedCredentials` call — would silently write the brand-new
   *    secret access key to the electron-store JSON file in plaintext, and
   *    step 5 would then delete the old key, leaving the operator's only
   *    valid credential both leaked to disk and (once the keychain becomes
   *    available again) undecryptable.
   * 1. Resolve the active source via {@link resolveAwsCredentialSource}. If
   *    not `kind: 'pasted'`, throws {@link UnsupportedCredentialSourceError}
   *    before any AWS call is made.
   * 2. `iam:CreateAccessKey` using an IAM client built from the *current*
   *    (about-to-be-superseded) key pair.
   * 3. Verifies the new key pair with `sts:GetCallerIdentity`, using an STS
   *    client built from the *new* key, retrying with backoff (see
   *    {@link VERIFY_ACCESS_KEY_RETRY_DELAYS_MS}) to absorb the propagation
   *    delay newly minted IAM access keys can have. Once all attempts are
   *    exhausted, best-effort deletes the
   *    orphaned new key (`iam:DeleteAccessKey`, using an IAM client built
   *    from the still-valid *current* key — nothing has touched it yet),
   *    then returns `{ status: 'verification-failed', error }` without
   *    overwriting the stored credentials — the previously stored key
   *    remains active and in the keychain. This cleanup is what makes a
   *    caller-driven retry safe: without it, the orphaned new key would stay
   *    live, and a retry's step 2 would hit IAM's 2-access-key-per-user
   *    limit (`LimitExceededException`). If the cleanup delete itself fails,
   *    that is logged (no secrets) and swallowed — `verification-failed` is
   *    still returned with the *original* verification error, not a
   *    new/different status; a manual console cleanup may be needed in that
   *    case.
   * 4. Only once verification succeeds:
   *    {@link ElectronStoreService.setPastedCredentials} overwrites the
   *    stored entry under the *same* profile name (in-place rotation;
   *    `aws.profile` already points at this profile).
   * 5. `iam:DeleteAccessKey` on the *old* (now-superseded) key's
   *    `AccessKeyId`, using an IAM client built from the *new* key pair
   *    (both keys belong to the same IAM user). On failure, returns
   *    `{ status: 'delete-failed', consoleUrl }` — the new key is already
   *    stored/active from step 4 and that is **not** rolled back; the
   *    operator must revoke the still-live old key manually via
   *    `consoleUrl`. Never reports overall success in this case.
   * 6. On success, returns `{ status: 'complete' }`.
   *
   * Never logs `secretAccessKey` (current or newly minted) — only
   * non-secret access key IDs and step-progress messages.
   *
   * @throws {@link SafeStorageUnavailableError} if the OS keychain is
   *   unavailable — nothing is attempted in that case (step 0).
   * @throws {@link UnsupportedCredentialSourceError} if the active source is
   *   not `kind: 'pasted'` (step 1).
   * @throws {@link AwsPastedCredentialDecryptError} (from
   *   {@link resolveAwsCredentialSource}, step 1) if the stored
   *   pasted-credentials entry can't be decrypted.
   * @throws `Error` if no region is configured for the active source — checked
   *   as `aws.region`, falling back to the pasted entry's own `region` (both
   *   are truthy-checked, since an empty string is as unusable as `undefined`)
   *   — or if `iam:CreateAccessKey` (step 2) succeeds but its response is
   *   missing `AccessKeyId`/`SecretAccessKey` — neither is a modeled
   *   {@link AwsProfileRotationResult} branch; nothing has been overwritten
   *   in either case.
   * @throws Raw, unmodeled AWS SDK errors from `iam:CreateAccessKey` (step
   *   2) itself propagate straight to the caller, which must catch it.
   */
  async rotateActiveCredentials(): Promise<AwsProfileRotationResult> {
    logger.debug('AwsProfileService.rotateActiveCredentials: starting active credential rotation');
    if (!this.safeStorage.isAvailable()) {
      throw new SafeStorageUnavailableError();
    }

    const source = resolveAwsCredentialSource(this.store);
    if (source.kind !== 'pasted') {
      throw new UnsupportedCredentialSourceError(source.kind);
    }

    const region = this.store.get('aws')?.region || this.store.get('creds')?.aws?.[source.profile]?.region;
    if (!region) {
      throw new Error('Cannot rotate AWS credentials: no region is configured for the active credential source.');
    }

    const { profile, accessKeyId: currentAccessKeyId, secretAccessKey: currentSecretAccessKey } = source;
    const currentClient = this.createIamClient({
      accessKeyId: currentAccessKeyId,
      secretAccessKey: currentSecretAccessKey,
      region,
    });

    // Step 2: mint a new key pair using the current key.
    const createResponse = await currentClient.send(new CreateAccessKeyCommand({}));
    const newKey = createResponse.AccessKey;
    if (!newKey?.AccessKeyId || !newKey.SecretAccessKey) {
      throw new Error('iam:CreateAccessKey did not return a new access key pair for the current key.');
    }
    logger.info('AwsProfileService.rotateActiveCredentials: minted new access key', {
      accessKeyId: newKey.AccessKeyId,
    });
    const newAccessKeyId = newKey.AccessKeyId;
    const newSecretAccessKey = newKey.SecretAccessKey;

    // Step 3: verify the new key pair works before relying on it, retrying
    // with backoff (see VERIFY_ACCESS_KEY_RETRY_DELAYS_MS) — mirrors
    // GuidedIamService.rotate's own step 3 exactly.
    try {
      const verifyClient = this.createStsClient({ accessKeyId: newAccessKeyId, secretAccessKey: newSecretAccessKey, region });
      await verifyAccessKeyWithRetry(
        async () => {
          await verifyClient.send(new GetCallerIdentityCommand({}));
        },
        {
          sleep: (ms) => this.sleep(ms),
          onAttemptFailed: (attempt, totalAttempts, attemptErr) => {
            const attemptMessage = attemptErr instanceof Error ? attemptErr.message : String(attemptErr);
            logger.warn('AwsProfileService.rotateActiveCredentials: verification attempt failed for newly minted key', {
              accessKeyId: newAccessKeyId,
              attempt,
              totalAttempts,
              error: attemptMessage,
            });
          },
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('AwsProfileService.rotateActiveCredentials: verification failed for newly minted key after exhausting all retry attempts', {
        accessKeyId: newAccessKeyId,
        error: message,
      });
      // Best-effort cleanup: delete the orphaned new key using the
      // still-untouched current key, so a caller-driven retry (which
      // re-runs from step 2) doesn't hit IAM's 2-access-key-per-user limit.
      // A failure here does not change the outcome — the original
      // verification error is still what gets returned.
      try {
        await currentClient.send(new DeleteAccessKeyCommand({ AccessKeyId: newAccessKeyId }));
      } catch (cleanupErr) {
        const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        logger.warn(
          'AwsProfileService.rotateActiveCredentials: failed to clean up orphaned new key after verification failure — may need manual cleanup',
          { accessKeyId: newAccessKeyId, error: cleanupMessage },
        );
      }
      return { status: 'verification-failed', error: message };
    }

    // Step 4: verification succeeded — overwrite the stored credentials in place.
    this.store.setPastedCredentials(profile, { accessKeyId: newAccessKeyId, secretAccessKey: newSecretAccessKey, region });
    logger.info('AwsProfileService.rotateActiveCredentials: stored rotated key in place', { profile });

    // Step 5: revoke the old key using the new key's client.
    try {
      const newClient = this.createIamClient({ accessKeyId: newAccessKeyId, secretAccessKey: newSecretAccessKey, region });
      await newClient.send(new DeleteAccessKeyCommand({ AccessKeyId: currentAccessKeyId }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('AwsProfileService.rotateActiveCredentials: failed to delete old access key — still active, revoke manually', {
        oldAccessKeyId: currentAccessKeyId,
        error: message,
      });
      return { status: 'delete-failed', consoleUrl: this.buildIamSecurityCredentialsConsoleUrl() };
    }

    // Step 6: rotation complete.
    logger.info('AwsProfileService.rotateActiveCredentials: rotation complete, old key revoked', {
      oldAccessKeyId: currentAccessKeyId,
    });
    return { status: 'complete' };
  }

  /**
   * Build an `STSClient` directly from an explicit credential/region tuple.
   * Used only by {@link rotateActiveCredentials} — deliberately does not
   * read `ElectronStoreService`/`resolveAwsCredentialSource` internally,
   * since the caller must build clients from *both* the current and the
   * newly minted key pair within the same rotation, not just "whichever is
   * active". Mirrors `GuidedIamService.createStsClient` exactly. Extracted
   * as a protected seam so tests can stub it with `aws-sdk-client-mock`.
   *
   * @param creds - Explicit access key ID, secret access key, and region.
   */
  protected createStsClient(creds: { accessKeyId: string; secretAccessKey: string; region: string }): STSClient {
    return new STSClient({
      region: creds.region,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    });
  }

  /**
   * Build an `IAMClient` directly from an explicit credential/region tuple.
   * Used only by {@link rotateActiveCredentials} — mirrors
   * {@link createStsClient} exactly, see that method's doc comment for why
   * this never reads `ElectronStoreService`/`resolveAwsCredentialSource`
   * internally. Extracted as a protected seam so tests can stub it with
   * `aws-sdk-client-mock`.
   *
   * @param creds - Explicit access key ID, secret access key, and region.
   */
  protected createIamClient(creds: { accessKeyId: string; secretAccessKey: string; region: string }): IAMClient {
    return new IAMClient({
      region: creds.region,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    });
  }

  /**
   * Sleep for `ms` milliseconds, delegating to the shared `sleep` utility
   * (`./sleep.js`). Extracted as a protected seam — rather than calling
   * that utility directly from {@link rotateActiveCredentials} — so tests
   * can stub it to resolve immediately and exercise the retry loop without
   * real elapsed wall-clock time. Used only by
   * {@link rotateActiveCredentials}, via {@link verifyAccessKeyWithRetry}.
   * Mirrors `GuidedIamService.sleep`.
   *
   * @param ms - Milliseconds to sleep for.
   */
  protected sleep(ms: number): Promise<void> {
    return sleep(ms);
  }

  /**
   * Direct link to the IAM console's "My security credentials" page, handed
   * back as `consoleUrl` in {@link rotateActiveCredentials}'s
   * `delete-failed` outcome so the operator can revoke the still-live old
   * key manually. Deliberately account/user-agnostic (no path segment
   * naming a specific IAM user) — cheaper to construct correctly than a
   * user-scoped deep link, and the console redirects to the right place for
   * whichever principal is signed in. Mirrors
   * `GuidedIamService.buildIamSecurityCredentialsConsoleUrl` exactly (kept
   * as a separate copy, not shared, per this method's "never call
   * `GuidedIamService`" constraint).
   */
  protected buildIamSecurityCredentialsConsoleUrl(): string {
    return 'https://console.aws.amazon.com/iam/home#/security_credentials';
  }

  /**
   * Parses `~/.aws/credentials` and `~/.aws/config` (merged the same way the
   * AWS CLI does). Missing files degrade to an empty map rather than
   * throwing — `parseKnownFiles` swallows `ENOENT` internally. `ignoreCache`
   * is always set so a profile added after the app started is picked up on
   * the next call rather than serving the loader's internal file cache.
   */
  protected async parseFiles(): Promise<ParsedIniData> {
    const home = this.homeDir();
    return parseKnownFiles({
      filepath: join(home, '.aws', 'credentials'),
      configFilepath: join(home, '.aws', 'config'),
      ignoreCache: true,
    });
  }

  /**
   * Returns the current user's home directory. Extracted as a protected
   * seam so tests can point at a fixture directory instead of the real
   * `~/.aws` files.
   */
  protected homeDir(): string {
    return homedir();
  }
}
