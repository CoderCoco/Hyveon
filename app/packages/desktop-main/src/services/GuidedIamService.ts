import { Injectable } from '@nestjs/common';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, CreateAccessKeyCommand, DeleteAccessKeyCommand } from '@aws-sdk/client-iam';
import { generateHyveonDeployAllPolicy, generateHyveonSelfRotatePolicy } from '@hyveon/shared';
import { resolveCloudFormationTemplatePath } from '../cloudformationTemplate.js';
import { logger } from '../logger.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';
import { SafeStorageUnavailableError } from './AwsProfileService.js';
import { resolveAwsCredentialSource, type AwsCredentialSource } from './awsCredentialSource.js';
import { verifyAccessKeyWithRetry } from './verifyAccessKeyWithRetry.js';
import { sleep } from './sleep.js';

/** Absolute path to the `dist/services/` directory at runtime. */
const _dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the app root (`app/` in the repo, `/workspace/app/` in Docker).
 * Derived by walking 4 levels up from `dist/services/`, mirroring
 * `ConfigService`'s own `_APP_ROOT` — this file lives at the same depth
 * (`src/services/`, compiled to `dist/services/`).
 * Used only as a private dev-mode fallback inside {@link GuidedIamService.getRenderedTemplatePath}.
 */
const _APP_ROOT = join(_dirname, '..', '..', '..', '..');

/** Result of {@link GuidedIamService.renderTemplate}. */
export interface RenderedTemplateResult {
  /** Absolute path to the rendered `iam-bootstrap.yaml` copy on disk. */
  path: string;
}

/**
 * Result of {@link GuidedIamService.openConsole}. On failure, carries the
 * console `url` back to the caller — a later group's wizard UI displays it
 * as plain text so the operator can open it manually, per the spec's
 * "Browser cannot be opened" scenario. `url` is deliberately absent on the
 * success branch: the caller already has it (it's the same value it passed
 * into {@link GuidedIamService.openConsole}) and doesn't need it echoed back
 * to render a success state.
 */
export type OpenConsoleResult = { opened: true } | { opened: false; url: string };

/** Input to {@link GuidedIamService.intakeBootstrapKey}. */
export interface BootstrapKeyIntakeInput {
  /** Access key ID the operator pasted from the CloudFormation stack outputs. */
  accessKeyId: string;
  /** Secret access key the operator pasted from the CloudFormation stack outputs. */
  secretAccessKey: string;
  /** Region to validate the key pair against. */
  region: string;
}

/** Result of {@link GuidedIamService.intakeBootstrapKey}. */
export interface BootstrapKeyIntakeResult {
  /** AWS account ID resolved from `sts:GetCallerIdentity`. */
  accountId: string;
}

/**
 * Pasted-credentials profile name {@link GuidedIamService.rotate} stages the
 * freshly-minted key pair under (`creds.aws.<profileName>` via
 * {@link ElectronStoreService.setPastedCredentials}), and later activates as
 * `aws.profile`. Deliberately distinct from `AwsProfileService`'s
 * `DEFAULT_PASTED_PROFILE_NAME` (`'hyveon-pasted'`) so a later group can tell
 * guided-sourced credentials apart from manually-pasted ones purely by
 * profile name.
 */
export const GUIDED_PROFILE_NAME = 'hyveon-guided';

/** Input to {@link GuidedIamService.rotate}. */
export interface RotationInput {
  /** Access key ID of the validated bootstrap key (from {@link GuidedIamService.intakeBootstrapKey}). */
  bootstrapAccessKeyId: string;
  /** Secret access key of the validated bootstrap key. */
  bootstrapSecretAccessKey: string;
  /** Region to build every AWS client used during rotation against. */
  region: string;
}

/**
 * Outcome of {@link GuidedIamService.rotate}, modeled as a discriminated
 * union rather than throwing for its two failure branches — both
 * `verification-failed` and `delete-failed` are expected, recoverable states
 * the caller needs to render distinctly, not exceptional control flow. See
 * {@link GuidedIamService.rotate}'s doc comment for exactly which store state
 * each branch leaves behind.
 */
export type RotationResult =
  /** The new key pair is active and the bootstrap key has been revoked. */
  | { status: 'complete' }
  /**
   * `sts:GetCallerIdentity` failed for the newly minted key on every retry
   * attempt (see {@link VERIFY_ACCESS_KEY_RETRY_DELAYS_MS}). Nothing became
   * active (`ElectronStoreService.set('aws', ...)` was never called) and the
   * bootstrap key was never deleted. {@link GuidedIamService.rotate} also
   * attempts to delete the orphaned new key (using the still-valid bootstrap
   * key) before returning this branch, so that a caller-driven retry — which
   * re-runs from step 1 — doesn't collide with IAM's 2-access-key-per-user
   * limit. That cleanup delete is itself best-effort: see `rotate()`'s doc
   * comment for what happens if it also fails.
   */
  | { status: 'verification-failed'; error: string }
  /**
   * `iam:DeleteAccessKey` failed for the bootstrap key. The new key pair IS
   * already active — app functionality is fine going forward — but the
   * bootstrap key is still live and must be revoked manually via `consoleUrl`.
   */
  | { status: 'delete-failed'; consoleUrl: string };

/** Input to {@link GuidedIamService.revokeBootstrapKey}. */
export interface RevokeBootstrapKeyInput {
  /** Access key ID of the still-live bootstrap key to revoke. */
  bootstrapAccessKeyId: string;
  /** Region to build the IAM client against. */
  region: string;
}

/** Result of {@link GuidedIamService.revokeBootstrapKey}. */
export interface RevokeBootstrapKeyResult {
  /** `true` once `iam:DeleteAccessKey` succeeds for the bootstrap key. */
  revoked: boolean;
  /** Present when `revoked` is `false` — a clear, actionable explanation of the refusal or AWS failure. */
  message?: string;
}

/**
 * Drives the first-run guided IAM bootstrap flow: renders the
 * `iam-bootstrap.yaml` CloudFormation template shell (Group 1) with the
 * `HyveonDeployAll`/`HyveonSelfRotate` policy documents substituted in,
 * opens the operator's browser at the CloudFormation console, intakes the
 * resulting bootstrap access key, and performs the mandatory
 * mint-then-revoke rotation onto a freshly-minted key. This service does
 * **not** read `ElectronStoreService.get('aws')` for its own credentials or
 * region — it runs *before* that credential source exists, so every method
 * that talks to AWS takes credentials/region as explicit parameters from
 * its caller.
 */
@Injectable()
export class GuidedIamService {
  /**
   * @param store - Used only by {@link rotate}, to stage the freshly-minted
   *   key pair (`setPastedCredentials`) and, once verified, activate it
   *   (`set('aws', ...)`). Never read for this service's *own* AWS
   *   credentials — see the class doc comment.
   * @param safeStorage - Used only by {@link rotate}'s keychain gate
   *   (`isAvailable()`), checked before any credential is staged. Not used
   *   directly for encryption — `ElectronStoreService.setPastedCredentials`
   *   already gates and applies that internally.
   */
  constructor(
    private readonly store: ElectronStoreService,
    private readonly safeStorage: SafeStorageService,
  ) {}

  /**
   * Renders `iam-bootstrap.yaml` (located via
   * {@link resolveCloudFormationTemplatePath}) by substituting its two
   * literal placeholder tokens with single-line `JSON.stringify()` output
   * from {@link generateHyveonDeployAllPolicy} and
   * {@link generateHyveonSelfRotatePolicy} — deliberately **not**
   * pretty-printed (`null, 2`), since a multi-line JSON string at that YAML
   * position (inline after `PolicyDocument: `) would not parse as valid
   * YAML. The template's `Parameters.UserName` is left untouched: it stays
   * a real CloudFormation stack parameter the operator can override in the
   * console, never a value this service bakes in.
   *
   * Writes the rendered result to disk via
   * {@link getRenderedTemplatePath} and returns the path written.
   *
   * Throws when {@link resolveCloudFormationTemplatePath} finds neither a
   * packaged nor a dev copy of the template — a loud failure rather than
   * silently producing a broken (un-rendered) file.
   */
  renderTemplate(): RenderedTemplateResult {
    const templatePath = resolveCloudFormationTemplatePath();
    if (!templatePath) {
      throw new Error(
        'Cannot render the IAM bootstrap CloudFormation template: iam-bootstrap.yaml was not found ' +
          'under the packaged resources or the dev source tree. Reinstall the app or check out a ' +
          'complete working tree.',
      );
    }

    const rendered = readFileSync(templatePath, 'utf-8')
      .replace('__HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__', JSON.stringify(generateHyveonDeployAllPolicy()))
      .replace('__HYVEON_SELF_ROTATE_POLICY_DOCUMENT__', JSON.stringify(generateHyveonSelfRotatePolicy()));

    const outputPath = this.getRenderedTemplatePath();
    writeFileSync(outputPath, rendered);
    return { path: outputPath };
  }

  /**
   * Build the AWS CloudFormation console URL scoped to the given region,
   * pointing to the "Create stack" page with no pre-filled template URL
   * (the operator uploads the local rendered template file manually via the
   * console's "Upload a template file" option, per the spec's rejection of
   * hosted-template quick-create links).
   *
   * Returns the exact URL shape:
   * `https://<region>.console.aws.amazon.com/cloudformation/home?region=<region>#/stacks/create`
   *
   * This method is pure (no side effects, no IO, no external state
   * dependencies) and is extracted as a separate method so it can be
   * pinned by tests to reject shape regressions.
   *
   * @throws `Error` if `region` doesn't match `/^[a-z0-9-]+$/` — a later
   *   group drives this from an IPC controller fed by the renderer, so
   *   `region` becomes caller-controlled input rather than a value this
   *   service always chooses itself.
   */
  buildCloudFormationConsoleUrl(region: string): string {
    if (!/^[a-z0-9-]+$/.test(region)) {
      throw new Error(`Invalid AWS region: ${region}`);
    }
    return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/create`;
  }

  /**
   * Launch the operator's default browser at `url` (the CloudFormation
   * console page from {@link buildCloudFormationConsoleUrl}) via Electron's
   * `shell.openExternal`. This is the first use of `shell.openExternal` in
   * this codebase, so it follows the same lazy-require Electron-touching
   * seam every other main-process service uses (see
   * {@link SafeStorageService}'s `readIsElectron`/`encryptString` pair):
   * a `process.versions['electron']` guard in {@link readIsElectron}, and
   * the actual `createRequire` + typed destructure call in
   * {@link openExternalUrl}, each a separate `protected` method so tests can
   * stub them without importing the real `electron` module.
   *
   * Never throws: `shell.openExternal` returns a `Promise` in real Electron,
   * so a rejection is awaited inside a `try`/`catch` here rather than left
   * to reject uncaught. On any failure — Electron unavailable, or
   * `openExternalUrl` throwing/rejecting for any reason (permissions, no
   * registered browser handler, etc.) — this resolves to
   * `{ opened: false, url }`, echoing `url` back so the caller (a later
   * group's wizard UI) can fall back to displaying it as plain text for the
   * operator to open manually, per the spec's "Browser cannot be opened"
   * scenario.
   *
   * Rejects a non-`https:` or unparseable `url` the same way — `{ opened: false, url }`,
   * never `openExternalUrl` — since a later group drives this from an IPC
   * controller fed by the renderer, making `url` caller-controlled input
   * rather than always this service's own {@link buildCloudFormationConsoleUrl} output.
   *
   * @param url - The URL to open, typically the result of
   *   {@link buildCloudFormationConsoleUrl}.
   */
  async openConsole(url: string): Promise<OpenConsoleResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { opened: false, url };
    }
    if (parsed.protocol !== 'https:') {
      return { opened: false, url };
    }
    if (!this.readIsElectron()) {
      return { opened: false, url };
    }
    try {
      await this.openExternalUrl(url);
      return { opened: true };
    } catch {
      return { opened: false, url };
    }
  }

  /**
   * Validate an operator-submitted bootstrap access key pair by calling
   * `sts:GetCallerIdentity` with it, returning the resolved AWS account ID
   * on success.
   *
   * Unlike {@link IamCheckService} or `BootstrapService`, which build their
   * AWS clients from the wizard's already-established credential source
   * (`ElectronStoreService.get('aws')`, resolved via
   * `resolveAwsCredentialSource`), this method builds the `STSClient`
   * directly from `input` — this service runs *before* any credential
   * source exists; `input` is the operator's just-pasted bootstrap key, not
   * yet stored anywhere. See {@link createStsClient}.
   *
   * On success, returns `{ accountId }` taken directly from the response's
   * `Account` field — simpler than `IamCheckService`'s ARN-parsing, which
   * exists only because `SimulatePrincipalPolicy`'s `PolicySourceArn`
   * parameter accepts an ARN and nothing else; that need doesn't apply
   * here. Throws a clear error if `Account` is unexpectedly absent from an
   * otherwise-successful response.
   *
   * On failure, the underlying AWS SDK error propagates unchanged (never
   * wrapped in a generic "invalid credentials" message) — the caller needs
   * the real error to explain the failure to the operator.
   *
   * Persists nothing: this method's only job is validation.
   *
   * @param input - The pasted bootstrap key pair and the region to validate
   *   it against.
   */
  async intakeBootstrapKey(input: BootstrapKeyIntakeInput): Promise<BootstrapKeyIntakeResult> {
    logger.debug('GuidedIamService.intakeBootstrapKey: validating pasted bootstrap key', { region: input.region });
    const client = this.createStsClient(input);
    try {
      const response = await client.send(new GetCallerIdentityCommand({}));
      if (!response.Account) {
        throw new Error('sts:GetCallerIdentity did not return an Account for the submitted bootstrap key.');
      }
      return { accountId: response.Account };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('GuidedIamService.intakeBootstrapKey: failed to validate the pasted bootstrap key', {
        region: input.region,
        error: message,
      });
      // Rethrown unchanged (not wrapped) — see this method's doc comment:
      // the caller needs the real AWS SDK error (e.g. its `name`) to explain
      // the failure to the operator, not a generic message.
      throw err;
    }
  }

  /**
   * Performs the mandatory mint-then-revoke rotation of the validated
   * bootstrap key, in this exact sequence (load-bearing — do not reorder):
   *
   * 0. **Keychain gate.** If {@link SafeStorageService.isAvailable} is
   *    `false`, throws {@link SafeStorageUnavailableError} before making any
   *    AWS call or storing anything — pasted-style credentials are never
   *    persisted in plaintext, so this flow has no fallback.
   * 1. `iam:CreateAccessKey` using an IAM client built from the *bootstrap*
   *    key — mints a new key pair for the same IAM user.
   * 2. Stages the new key pair via
   *    {@link ElectronStoreService.setPastedCredentials} under
   *    {@link GUIDED_PROFILE_NAME}. This alone does **not** make the new key
   *    active — `aws.profile` is untouched at this point.
   * 3. Verifies the new key pair with `sts:GetCallerIdentity`, using an STS
   *    client built from the *new* key, retrying with backoff (see
   *    {@link VERIFY_ACCESS_KEY_RETRY_DELAYS_MS}) to absorb the propagation
   *    delay newly minted IAM access keys can have. Once all attempts are
   *    exhausted, best-effort deletes the orphaned new key
   *    (`iam:DeleteAccessKey`, using an IAM client built
   *    from the still-untouched *bootstrap* key — it still has
   *    `HyveonSelfRotate` permissions and nothing has touched it yet) and,
   *    once that delete succeeds, also clears the entry staged under
   *    {@link GUIDED_PROFILE_NAME} in step 2
   *    ({@link ElectronStoreService.deletePastedCredentials}) so the deleted
   *    key's encrypted material doesn't linger in the store. Then returns
   *    `{ status: 'verification-failed', error }` without touching
   *    `aws.profile` and without deleting the bootstrap key itself. This
   *    cleanup is what makes "retrying is safe" actually true: without it,
   *    the orphaned new key would stay live, and a retry's step 1 would hit
   *    IAM's 2-access-key-per-user limit (`LimitExceededException`) since
   *    the account already has both the bootstrap key and the orphan. If the
   *    cleanup delete itself fails, that is logged (no secrets) and
   *    swallowed — `verification-failed` is still returned with the
   *    *original* verification error, not a new/different status; a manual
   *    console cleanup may be needed in that case, and the staged entry is
   *    deliberately left in place too (it still matches the live orphan key).
   * 4. Only once verification succeeds: `ElectronStoreService.set('aws', ...)`
   *    with `profile` set to {@link GUIDED_PROFILE_NAME} — the moment the new
   *    key becomes the active credential source (picked up automatically by
   *    `resolveAwsCredentialSource`, since a stored `profile` that resolves
   *    via `getPastedCredentials` is treated as `kind: 'pasted'`).
   * 5. `iam:DeleteAccessKey` on the *bootstrap* key's `AccessKeyId`, using an
   *    IAM client built from the *new, now-active* key (both keys belong to
   *    the same IAM user, and `HyveonSelfRotate` is attached to the user, not
   *    to a specific key). On failure, returns
   *    `{ status: 'delete-failed', consoleUrl }` — the new key is already
   *    active from step 4 and that is **not** rolled back; the operator must
   *    revoke the still-live bootstrap key manually via `consoleUrl`.
   * 6. On success, returns `{ status: 'complete' }`.
   *
   * Never logs `secretAccessKey` (bootstrap or newly minted) — only
   * non-secret access key IDs and step-progress messages.
   *
   * @param input - The validated bootstrap key pair (from
   *   {@link intakeBootstrapKey}) and the region to build every client
   *   against.
   * @throws {@link SafeStorageUnavailableError} if the OS keychain is
   *   unavailable — nothing is attempted in that case.
   * @throws `Error` if `iam:CreateAccessKey` (step 1) succeeds but its
   *   response is missing `AccessKeyId`/`SecretAccessKey` — an
   *   unrecoverable, unexpected-shape response rather than a modeled
   *   `RotationResult` branch; nothing has been staged or activated yet.
   * @throws Raw, unmodeled AWS SDK errors from `iam:CreateAccessKey` (step
   *   1) itself — e.g. `LimitExceededException` if the account already has
   *   2 access keys, a realistic scenario after a prior `delete-failed`
   *   outcome left both the bootstrap and rotated keys live. Unlike step 3's
   *   `sts:GetCallerIdentity` failure (caught and modeled as
   *   `verification-failed`) or step 5's `iam:DeleteAccessKey` failure
   *   (caught and modeled as `delete-failed`), a step 1 failure is not
   *   caught here at all and propagates straight to the caller, which must
   *   catch it.
   */
  async rotate(input: RotationInput): Promise<RotationResult> {
    logger.debug('GuidedIamService.rotate: starting bootstrap key rotation', { region: input.region });
    if (!this.safeStorage.isAvailable()) {
      throw new SafeStorageUnavailableError();
    }

    // Step 1: mint a new key pair using the bootstrap key.
    const bootstrapClient = this.createIamClient({
      accessKeyId: input.bootstrapAccessKeyId,
      secretAccessKey: input.bootstrapSecretAccessKey,
      region: input.region,
    });
    const createResponse = await bootstrapClient.send(new CreateAccessKeyCommand({}));
    const newKey = createResponse.AccessKey;
    if (!newKey?.AccessKeyId || !newKey.SecretAccessKey) {
      throw new Error('iam:CreateAccessKey did not return a new access key pair for the bootstrap key.');
    }
    logger.info('GuidedIamService.rotate: minted new access key', { accessKeyId: newKey.AccessKeyId });

    // Step 2: stage the new key pair — does not yet activate it.
    this.store.setPastedCredentials(GUIDED_PROFILE_NAME, {
      accessKeyId: newKey.AccessKeyId,
      secretAccessKey: newKey.SecretAccessKey,
      region: input.region,
    });

    const newCreds = { accessKeyId: newKey.AccessKeyId, secretAccessKey: newKey.SecretAccessKey, region: input.region };

    // Step 3: verify the new key pair works before relying on it, retrying
    // with backoff (see VERIFY_ACCESS_KEY_RETRY_DELAYS_MS) since newly
    // minted keys can take a few seconds to propagate across AWS before
    // GetCallerIdentity reliably succeeds for them.
    try {
      const verifyClient = this.createStsClient(newCreds);
      await verifyAccessKeyWithRetry(
        async () => {
          await verifyClient.send(new GetCallerIdentityCommand({}));
        },
        {
          sleep: (ms) => this.sleep(ms),
          onAttemptFailed: (attempt, totalAttempts, attemptErr) => {
            const attemptMessage = attemptErr instanceof Error ? attemptErr.message : String(attemptErr);
            logger.warn('GuidedIamService.rotate: verification attempt failed for newly minted key', {
              accessKeyId: newKey.AccessKeyId,
              attempt,
              totalAttempts,
              error: attemptMessage,
            });
          },
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('GuidedIamService.rotate: verification failed for newly minted key after exhausting all retry attempts', {
        accessKeyId: newKey.AccessKeyId,
        error: message,
      });
      // Best-effort cleanup: delete the orphaned new key using the
      // still-untouched bootstrap key, so a caller-driven retry (which
      // re-runs from step 1) doesn't hit IAM's 2-access-key-per-user limit.
      // A failure here does not change the outcome — the original
      // verification error is still what gets returned.
      try {
        await bootstrapClient.send(new DeleteAccessKeyCommand({ AccessKeyId: newKey.AccessKeyId }));
        this.store.deletePastedCredentials(GUIDED_PROFILE_NAME);
      } catch (cleanupErr) {
        const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        logger.warn('GuidedIamService.rotate: failed to clean up orphaned new key after verification failure — may need manual cleanup', {
          accessKeyId: newKey.AccessKeyId,
          error: cleanupMessage,
        });
      }
      return { status: 'verification-failed', error: message };
    }

    // Step 4: verification succeeded — activate the new key.
    const currentAws = this.store.get('aws') ?? {};
    this.store.set('aws', { ...currentAws, profile: GUIDED_PROFILE_NAME, region: input.region });
    logger.info('GuidedIamService.rotate: activated rotated key as the credential source', {
      profile: GUIDED_PROFILE_NAME,
    });

    // Step 5: revoke the bootstrap key using the new, now-active key.
    try {
      const newIamClient = this.createIamClient(newCreds);
      await newIamClient.send(new DeleteAccessKeyCommand({ AccessKeyId: input.bootstrapAccessKeyId }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('GuidedIamService.rotate: failed to delete bootstrap access key — still active, revoke manually', {
        bootstrapAccessKeyId: input.bootstrapAccessKeyId,
        error: message,
      });
      return { status: 'delete-failed', consoleUrl: this.buildIamSecurityCredentialsConsoleUrl() };
    }

    // Step 6: rotation complete.
    logger.info('GuidedIamService.rotate: rotation complete, bootstrap key revoked', {
      bootstrapAccessKeyId: input.bootstrapAccessKeyId,
    });
    return { status: 'complete' };
  }

  /**
   * Revokes the still-live bootstrap access key via `iam:DeleteAccessKey` —
   * the manual-retry action for {@link rotate}'s `delete-failed` outcome.
   * By the time an operator triggers this, `rotate()` has already minted,
   * staged, and activated a new key pair (step 4 of {@link rotate}); the
   * bootstrap key is the only thing left over, and the operator has no new
   * key material to paste back in for a re-run.
   *
   * This is why this method — unlike every other one on this service, all
   * of which take credentials as explicit input because they run *before*
   * any credential source exists (see the class doc comment) — is the one
   * deliberate exception that legitimately reads
   * {@link ElectronStoreService} via {@link resolveAwsCredentialSource}: by
   * this point in the flow, the credentials it needs (the rotated key) ARE
   * the wizard's already-active credential source, and there is nothing
   * else to pass in.
   *
   * "Usable" here means {@link resolveAwsCredentialSource} resolves to
   * `kind: 'pasted'` **with `profile === {@link GUIDED_PROFILE_NAME}`** — the
   * only shape guaranteed to carry the rotated key's own
   * `accessKeyId`/`secretAccessKey`, which {@link createIamClient}'s existing
   * seam (reused as-is here, not duplicated) then consumes. Every other
   * shape refuses rather than throw: `kind: 'none'` (no credential source
   * configured); `kind: 'profile'` (a `~/.aws` CLI profile *name*, not key
   * material — building a client from it needs a `fromIni`-based path this
   * service has no other need for); and, load-bearing, `kind: 'pasted'`
   * under any *other* profile name. Without that last check, an operator
   * who pastes a manual (non-guided) credential set — or switches to one —
   * between `rotate()`'s `delete-failed` result and triggering this retry
   * would have this method build an IAM client from *that* unrelated
   * pasted key and send `iam:DeleteAccessKey` for `input.bootstrapAccessKeyId`
   * (a value this method takes as-is, sourced from the wizard UI) under it —
   * silently attempting to delete an access key using credentials that have
   * nothing to do with the bootstrap flow. Refusing keeps this method's only
   * side effect scoped to the one credential pair `rotate()` itself just
   * activated. A decrypt failure on a stored pasted entry
   * ({@link AwsPastedCredentialDecryptError}) is caught and folded into the
   * same refusal shape.
   *
   * Never throws: this is a manual-retry UI action invoked from the wizard
   * after a `delete-failed` result, so a crash here would be strictly worse
   * than a clear refusal message the operator can act on (revoking via
   * `rotate()`'s `consoleUrl` instead). Returns `{ revoked: true }` on
   * success; `{ revoked: false, message }` on refusal or AWS failure —
   * `message` is the underlying AWS SDK error's message, unmodified on the
   * AWS-failure branch, matching {@link intakeBootstrapKey}'s convention of
   * never wrapping the real error.
   *
   * @param input - The still-live bootstrap key's access key ID and the
   *   region to build the IAM client against.
   */
  async revokeBootstrapKey(input: RevokeBootstrapKeyInput): Promise<RevokeBootstrapKeyResult> {
    logger.debug('GuidedIamService.revokeBootstrapKey: revoking still-live bootstrap key', {
      bootstrapAccessKeyId: input.bootstrapAccessKeyId,
    });
    let source: AwsCredentialSource;
    try {
      source = resolveAwsCredentialSource(this.store);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { revoked: false, message };
    }

    if (source.kind !== 'pasted' || source.profile !== GUIDED_PROFILE_NAME) {
      const message =
        source.kind === 'none'
          ? 'No active AWS credential source is configured — cannot revoke the bootstrap key automatically. Revoke it manually via the IAM console.'
          : source.kind === 'profile'
            ? 'The active AWS credential source is a CLI profile, not the rotated key pair — cannot revoke the bootstrap key automatically. Revoke it manually via the IAM console.'
            : 'The active AWS credential source is not the rotated guided-provisioning key pair — cannot revoke the bootstrap key automatically. Revoke it manually via the IAM console.';
      return { revoked: false, message };
    }

    try {
      const client = this.createIamClient({
        accessKeyId: source.accessKeyId,
        secretAccessKey: source.secretAccessKey,
        region: input.region,
      });
      await client.send(new DeleteAccessKeyCommand({ AccessKeyId: input.bootstrapAccessKeyId }));
      return { revoked: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('GuidedIamService.revokeBootstrapKey: iam:DeleteAccessKey failed for the bootstrap key', {
        bootstrapAccessKeyId: input.bootstrapAccessKeyId,
        error: message,
      });
      return { revoked: false, message };
    }
  }

  /**
   * Build an `STSClient` directly from an explicit credential/region tuple.
   * Deliberately does **not** read `ElectronStoreService` or use
   * `fromIni`/`resolveAwsCredentialSource` — those resolve the wizard's
   * already-established credential source, which does not exist yet at the
   * point this service runs. Extracted as a protected seam so tests can
   * stub it with `aws-sdk-client-mock`.
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
   * Used only by {@link rotate} — mirrors {@link createStsClient} exactly,
   * see that method's doc comment for why this never reads
   * `ElectronStoreService`/`resolveAwsCredentialSource`. Extracted as a
   * protected seam so tests can stub it with `aws-sdk-client-mock`.
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
   * (`./sleep.js`). Extracted as a protected seam — mirrors
   * {@link createStsClient}/{@link createIamClient} — so tests can stub it to
   * resolve immediately and exercise {@link rotate}'s retry loop without real
   * elapsed wall-clock time. Used only by {@link rotate}, via
   * {@link verifyAccessKeyWithRetry}.
   *
   * @param ms - Milliseconds to sleep for.
   */
  protected sleep(ms: number): Promise<void> {
    return sleep(ms);
  }

  /**
   * Direct link to the IAM console's "My security credentials" page, handed
   * back as `consoleUrl` in {@link rotate}'s `delete-failed` outcome so the
   * operator can revoke the still-live bootstrap key manually. Deliberately
   * account/user-agnostic (no path segment naming a specific IAM user) —
   * cheaper to construct correctly than a user-scoped deep link, and the
   * console redirects to the right place for whichever principal is signed
   * in.
   */
  protected buildIamSecurityCredentialsConsoleUrl(): string {
    return 'https://console.aws.amazon.com/iam/home#/security_credentials';
  }

  /**
   * Returns `true` when `process.versions['electron']` is set, indicating
   * the service is running inside an Electron process. Extracted as a
   * protected method so tests can stub it via `vi.spyOn` without touching
   * `process.versions` directly. Mirrors `SafeStorageService.readIsElectron`
   * exactly.
   */
  protected readIsElectron(): boolean {
    return !!process.versions['electron'];
  }

  /**
   * Calls `shell.openExternal(url)` and awaits its result. Only called after
   * {@link readIsElectron} returns `true`. Extracted as a protected method,
   * lazily requiring `electron` at call-time, so tests can stub it via
   * `vi.spyOn` without importing the native `electron` module and so that
   * importing this file in a plain Node/test context never triggers an
   * unresolved-module error.
   *
   * @param url - The URL to hand to the OS's default browser.
   */
  protected async openExternalUrl(url: string): Promise<void> {
    const _require = createRequire(import.meta.url);
    const { shell } = _require('electron') as { shell: { openExternal(url: string): Promise<void> } };
    await shell.openExternal(url);
  }

  /**
   * Return `process.resourcesPath` when running inside an Electron packaged app,
   * or `undefined` otherwise. Extracted as a protected method so tests can stub
   * it via `vi.spyOn` without touching `process.resourcesPath` directly.
   *
   * Mirrors `ConfigService.readIsPackaged`'s implementation exactly (see that
   * method's doc comment for why `process.resourcesPath` alone cannot be used
   * as the packaged-build guard).
   */
  protected readIsPackaged(): boolean {
    if (!process.versions['electron']) return false;
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { isPackaged: boolean } };
      return electron.app.isPackaged;
    } catch {
      return false;
    }
  }

  /**
   * Return the Electron `userData` directory when running inside an Electron
   * process, or `null` otherwise. The `electron` module is required lazily at
   * call-time (keyed on `process.versions['electron']` being truthy) so that
   * importing this module in a plain Node/test context never triggers an
   * unresolved-module error. Extracted as a protected method so tests can stub
   * it via `vi.spyOn`. Mirrors `ConfigService.readUserDataPath` exactly.
   */
  protected readUserDataPath(): string | null {
    if (!process.versions['electron']) return null;
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { getPath(name: string): string } };
      return electron.app.getPath('userData');
    } catch {
      return null;
    }
  }

  /**
   * Resolve the absolute path {@link renderTemplate} writes the rendered
   * template to (no env-var override here, since this is a scratch render
   * output rather than an operator-configured path), using a
   * packaged/dev-fallback resolution order:
   *  1. Electron packaged app (`readIsPackaged()`) —
   *     `<userData>/iam-bootstrap-rendered.yaml` (a user-writable location
   *     that survives app updates).
   *  2. Dev/test fallback — `<APP_ROOT>/.iam-bootstrap-dev` (git-ignored; a
   *     scratch file, not a committed asset — deliberately outside
   *     `resources/`, which holds the source template Group 1 shipped).
   */
  protected getRenderedTemplatePath(): string {
    if (this.readIsPackaged()) {
      const userData = this.readUserDataPath();
      if (userData) {
        return join(userData, 'iam-bootstrap-rendered.yaml');
      }
    }

    return join(_APP_ROOT, '.iam-bootstrap-dev');
  }
}
