import type { ElectronStoreService } from './ElectronStoreService.js';
import { logger } from '../logger.js';
import { resolveAwsCredentialSource } from './awsCredentialSource.js';

/**
 * Thrown by {@link resolveCredentialEnvVars} when the wizard's credentials
 * step has never selected an AWS credential source at all (no `profile`
 * stored under `aws.profile`) — see the `pulumi-engine-runtime` delta spec's
 * "Wizard-selected credentials reach the engine" requirement: "The engine
 * MUST NOT be left to resolve credentials through its own default chain,
 * because that silently ignores the operator's choice." Falling through to
 * `LocalWorkspaceOptions.envVars` without any credential keys at all would do
 * exactly that (the engine would fall back to its own default AWS credential
 * chain), so this is a hard failure rather than an empty `envVars` object.
 */
export class PulumiCredentialsNotConfiguredError extends Error {
  constructor() {
    super(
      'Cannot run this Pulumi operation: no AWS credential source is configured. ' +
        'Complete the credentials step of the wizard (or Settings → AWS Resources) before running ' +
        'infrastructure operations.',
    );
    this.name = 'PulumiCredentialsNotConfiguredError';
  }
}

/**
 * `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` — the
 * pasted-keys credential variables. Cleared (see {@link resolveCredentialEnvVars})
 * whenever the named-profile path is selected, per the spec's "Ambient keys
 * cannot override a selected profile" scenario.
 */
const PASTED_KEY_ENV_VARS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'] as const;

/**
 * `AWS_PROFILE`/`AWS_DEFAULT_PROFILE` — the named-profile credential
 * variables. Cleared (see {@link resolveCredentialEnvVars}) whenever the
 * pasted-keys path is selected, per the spec's "Ambient profile cannot
 * override pasted keys" scenario.
 */
const PROFILE_ENV_VARS = ['AWS_PROFILE', 'AWS_DEFAULT_PROFILE'] as const;

/** Builds a `Record<string, ''>` clearing every key in `keys` — see {@link resolveCredentialEnvVars}. */
function clearedEnvVars(keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, '']));
}

/**
 * Resolves the wizard-selected AWS credential source
 * ({@link resolveAwsCredentialSource}) into the exact `envVars` overlay
 * {@link PulumiWorkspaceService.getOrCreateStack} merges into the engine's
 * environment via `PulumiWorkspaceInput.credentialEnvVars` — named profile
 * via `AWS_PROFILE`, or the main-process-decrypted pasted keys via
 * `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` — satisfying the
 * `pulumi-engine-runtime` delta spec's "Wizard-selected credentials reach the
 * engine" requirement.
 *
 * @remarks
 * ## Exclusivity / clearing (spec-mandated, not optional)
 *
 * The selected source's variables are set, and the *other* source's
 * variables are explicitly set to `''` in the same returned object — never
 * merely omitted. This matters because the seam's `envVars` become an
 * `execa` `env` option with `extendEnv: true` (the SDK's default — see
 * `node_modules/execa/index.js`'s `getEnv` function, which spreads
 * `process.env` first and the `env` option second when `extendEnv` is
 * true), several layers down (`LocalWorkspace.runPulumiCmd` →
 * `PulumiCommand.run` → `exec` → `execa(command, args, opts)`, all in
 * `@pulumi/pulumi/automation/localWorkspace.js` and `.../cmd.js`). The
 * final child environment is therefore `process.env` spread first, then
 * our `envVars` spread on top — a plain
 * shallow spread, keyed by name, with no special-casing of `''`. A key this
 * function omits is not present in `ourEnvVars` at all, so the spread leaves
 * whatever ambient value `process.env` had for that key completely
 * untouched — an operator's shell `AWS_PROFILE`, a launcher's stray
 * `AWS_ACCESS_KEY_ID`, etc. would silently outrank the wizard's selection.
 * Supplying the key with value `''` instead means the key IS present in
 * `ourEnvVars`, so the spread's later `...ourEnvVars` always wins for that
 * key regardless of what `process.env` held — this is what "cleared, not
 * merely omitted" means at the mechanism level, and is exactly what
 * `PulumiWorkspaceService.test.ts`'s "should support clearing an inherited
 * variable via an explicit empty string" test already exercises for the
 * seam side of this contract.
 *
 * `''` is "present but empty", not "absent from the process' environment
 * table" — this function cannot make the child process's `getenv()` return
 * `NULL` for a cleared key (that would require actually deleting the key
 * from `process.env` before every spawn, which is outside what this
 * store-reading resolver does, and outside what `execa`'s public API
 * supports either). It relies instead on well-documented downstream
 * behaviour: both the AWS SDK for Go (used by the `pulumi` CLI binary and
 * its provider plugins) and the AWS SDK for JavaScript resolve
 * `AWS_PROFILE`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` by checking for a
 * *non-empty* string, not merely a *set* one, so `''` is treated the same as
 * "not set" by every consumer these variables are meant for. This function's
 * own tests prove the mechanism up to "the final merged environment object
 * has `''` for the cleared key, not the ambient value" (see
 * `PulumiCredentialResolver.test.ts`'s spawn-based proof) — proving the
 * `pulumi` binary's own AWS SDK-for-Go credential chain treats that `''` as
 * absent would require running the real binary during a `preview`/`up`
 * operation, which is `PulumiService`'s territory, not this resolver's.
 *
 * ## What is logged, and what never is
 *
 * This function logs only the resolved credential SOURCE kind (`'profile'` /
 * `'pasted'`, or a warning when none is configured) via
 * `logger.debug`/`logger.warn` — never a profile name, access key id, secret
 * access key, or any other value read from `store`.
 * `PulumiCredentialResolver.test.ts`'s "credential source is logged without
 * secret values" describe block asserts this directly. The meaningful proof
 * that the *values themselves* never reach the log is
 * `PulumiWorkspaceService.test.ts`'s "should never pass the resolved
 * pasted-key values to any logger call" test, which exercises this
 * function's real output flowing through `getOrCreateStack` and inspects
 * every logger call the service makes while doing so. Neither test covers
 * `PulumiService.preview`/`.up`, which stream real CLI stdout/stderr —
 * scrubbing that streamed output is `PulumiService`'s own responsibility, not
 * something this function's code path touches.
 *
 * @throws {@link PulumiCredentialsNotConfiguredError} when no credential
 *   source is selected at all (`resolveAwsCredentialSource` returns `'none'`).
 */
export function resolveCredentialEnvVars(store: ElectronStoreService): Record<string, string> {
  let source: ReturnType<typeof resolveAwsCredentialSource>;
  try {
    source = resolveAwsCredentialSource(store);
  } catch (err) {
    logger.warn('resolveCredentialEnvVars: failed to resolve the AWS credential source', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  switch (source.kind) {
    case 'none':
      logger.warn('resolveCredentialEnvVars: no AWS credential source is configured');
      throw new PulumiCredentialsNotConfiguredError();
    case 'profile':
      logger.debug('resolveCredentialEnvVars: resolved credential source', { source: 'profile' });
      return {
        AWS_PROFILE: source.profile,
        ...clearedEnvVars(PASTED_KEY_ENV_VARS),
      };
    case 'pasted':
      logger.debug('resolveCredentialEnvVars: resolved credential source', { source: 'pasted' });
      return {
        AWS_ACCESS_KEY_ID: source.accessKeyId,
        AWS_SECRET_ACCESS_KEY: source.secretAccessKey,
        // The paste flow has no session-token field of its own to set
        // (`ElectronStoreService.getPastedCredentials` only ever returns
        // `accessKeyId`/`secretAccessKey`) — but an ambient `AWS_SESSION_TOKEN`
        // (e.g. from an `aws sso`/assume-role shell session the app was
        // launched from) MUST still be cleared here, not merely left unset.
        // Left uncleared, the final env would carry the wizard's long-term
        // pasted keys alongside an inherited *temporary* session token for a
        // different identity — AWS rejects that combination outright
        // ("security token included in the request is invalid"), and the
        // failure would be unexplainable to the operator. See
        // `PulumiCredentialResolver.test.ts`'s pasted-path exclusivity test.
        AWS_SESSION_TOKEN: '',
        ...clearedEnvVars(PROFILE_ENV_VARS),
      };
  }
}
