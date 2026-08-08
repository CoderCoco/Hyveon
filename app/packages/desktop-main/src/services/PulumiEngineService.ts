import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
// The explicit `/index.js` is required, not cosmetic — see `spike/pulumiSpike.ts`'s
// comment on this same import: the main bundle is ESM, `@pulumi/pulumi` is
// externalized, and `@pulumi/pulumi` is CommonJS with no `exports` map, so the
// bare directory specifier `@pulumi/pulumi/automation` fails with
// `ERR_UNSUPPORTED_DIR_IMPORT` in the packaged app.
import { PulumiCommand } from '@pulumi/pulumi/automation/index.js';
import { PULUMI_ENGINE_VERSION } from '@hyveon/shared';
import { SemVer } from 'semver';
import { logger } from '../logger.js';

/**
 * Narrows an unknown thrown value to a human-readable message for the
 * provisioning error classes below.
 */
function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The distinct phases the `pulumi-engine-runtime` delta spec's "Provider
 * plugins are reported as their own phase" scenario names: engine
 * provisioning itself, provider plugin download, and the infrastructure
 * operation (`preview`/`up`/`destroy`/`refresh`) that follows.
 * {@link PulumiEngineService.resolve} only ever fires `'engine'`;
 * `'plugins'`/`'operation'` are fired by its callers — see
 * `PulumiService.initializeStack`'s own TSDoc, "The three phases, and why
 * 'plugins' needs an explicit step here".
 */
export type PulumiProvisioningPhase = 'engine' | 'plugins' | 'operation';

/** Whether a {@link PulumiProvisioningPhase} is beginning or has settled (success or failure alike). */
export type PulumiPhaseStatus = 'start' | 'end';

/**
 * Coarse start/end progress reporting for a {@link PulumiProvisioningPhase} —
 * see {@link PulumiEngineService.resolve}'s TSDoc for why this is coarse
 * (start/end only, no granular percentage) rather than fine-grained: neither
 * `PulumiCommand.install()` nor the underlying `get.pulumi.com` install
 * script exposes a progress hook this service could forward.
 */
export type PulumiPhaseCallback = (phase: PulumiProvisioningPhase, status: PulumiPhaseStatus) => void;

/**
 * Thrown by {@link PulumiEngineService.resolve} when the pinned engine
 * version can't be provisioned because `get.pulumi.com` (or the release
 * asset it redirects to) couldn't be reached — matched from the SDK's own
 * `download()` failure messages (`"Failed to download ..."` /
 * `"Timed out downloading ..."`) and from common DNS/connection errno codes
 * surfaced by the install script's own network calls. Distinct from
 * {@link PulumiEngineIntegrityError} (a download that completed but didn't
 * verify) and {@link PulumiEngineCacheWriteError} (the cache directory itself
 * can't be written to). Surfaced to the wizard and the Plan/Apply page per
 * the "Provisioning fails with no network" scenario, with a retry offered —
 * see {@link PulumiEngineService.resolve}'s TSDoc for why a failed attempt is
 * never memoized.
 */
export class PulumiEngineNetworkError extends Error {
  constructor(
    public readonly root: string,
    public readonly cause: unknown,
  ) {
    super(
      `Failed to reach get.pulumi.com while provisioning the Pulumi engine into "${root}": ` +
        describeCause(cause),
    );
    this.name = 'PulumiEngineNetworkError';
  }
}

/**
 * Thrown by {@link PulumiEngineService.resolve} when the pinned engine
 * downloaded but failed to install or verify — the install script exited
 * non-zero for a reason other than a recognised network failure, or the
 * resulting binary reports a version other than the exact pin (see
 * {@link PulumiEngineService.assertExactPin}, which guards against
 * `PulumiCommand`'s own version check being a minimum-version check rather
 * than an exact match — see the file-level TSDoc). Distinct from
 * {@link PulumiEngineNetworkError} (no connection was made at all) and
 * {@link PulumiEngineCacheWriteError} (the cache directory itself is
 * unwritable). A failed install never leaves anything at the final install
 * directory — see {@link PulumiEngineService.installFresh}'s TSDoc for the
 * staging-then-rename guarantee this relies on.
 */
export class PulumiEngineIntegrityError extends Error {
  constructor(
    public readonly root: string,
    public readonly cause: unknown,
  ) {
    super(
      `Pulumi engine download or verification failed while installing into "${root}": ` +
        describeCause(cause),
    );
    this.name = 'PulumiEngineIntegrityError';
  }
}

/**
 * Thrown by {@link PulumiEngineService.resolve} when the engine cache
 * directory under Electron `userData` (or its parent) can't be written to —
 * e.g. `EACCES`/`EPERM`/`EROFS`/`ENOSPC` raised while creating the cache
 * root or renaming a verified staging install into place. Distinct from
 * {@link PulumiEngineNetworkError} and {@link PulumiEngineIntegrityError},
 * which both assume the cache directory itself is writable.
 */
export class PulumiEngineCacheWriteError extends Error {
  constructor(
    public readonly root: string,
    public readonly cause: unknown,
  ) {
    super(`Pulumi engine cache directory "${root}" is not writable: ${describeCause(cause)}`);
    this.name = 'PulumiEngineCacheWriteError';
  }
}

/**
 * Thrown internally by {@link PulumiEngineService.assertExactPin} when a
 * resolved `PulumiCommand`'s reported version isn't exactly the pin. Not
 * exported — every call site catches and re-classifies it into one of the
 * three typed provisioning errors above via {@link classifyProvisioningError}
 * (fresh-install path) or treats it as positive evidence of a bad cache
 * entry via {@link isProvablyBadCacheEntry} (cache-reuse path). Kept as a
 * distinct class specifically so {@link isProvablyBadCacheEntry} can
 * distinguish "the binary ran and definitively reported the wrong version"
 * (provable) from "the binary couldn't be run at all" (ambiguous — see that
 * function's TSDoc) via `instanceof` rather than by parsing a message.
 */
class PulumiEnginePinMismatchError extends Error {
  constructor(root: string, actual: SemVer | null, expected: SemVer) {
    super(`engine at "${root}" reports version "${String(actual)}", expected exactly "${expected.toString()}"`);
    this.name = 'PulumiEnginePinMismatchError';
  }
}

/**
 * Matches an SDK `download()` failure message ending in an HTTP status code
 * (`": 404 Not Found"`) — `automation/download.js` uses the same
 * `"Failed to download <url>: ..."` prefix for both "the server couldn't be
 * reached at all" (network) and "the server responded with a non-2xx
 * status" (not a network problem — the server was reached). Used by
 * {@link isNetworkFailureMessage} to exclude the latter.
 */
const HTTP_STATUS_SUFFIX_PATTERN = /:\s*\d{3}\b/;

/**
 * Matches unambiguous network/DNS/connection/timeout signals: the SDK's own
 * `download()` timeout message and common errno strings a genuinely
 * unreachable host's failure tends to surface in an install script's
 * stderr. Deliberately excludes a bare `network` alternative — that
 * over-matched arbitrary install-script stderr that happened to mention the
 * word for an unrelated reason.
 */
const NETWORK_ERRNO_PATTERN = /timed out downloading|enotfound|econnrefused|etimedout|eai_again|enetunreach|econnreset/i;

/**
 * Matches the SDK's `download()` failure message prefix
 * (`"Failed to download <url>: ..."`), which covers both a true network
 * failure and a reachable-but-non-2xx HTTP response — see
 * {@link HTTP_STATUS_SUFFIX_PATTERN}, which {@link isNetworkFailureMessage}
 * uses to tell them apart.
 */
const DOWNLOAD_FAILURE_PREFIX_PATTERN = /failed to download/i;

/**
 * True when `message` describes a genuine network/DNS/connection failure
 * (as opposed to, e.g., a reachable server responding 404, or an unrelated
 * install-script failure) — see {@link classifyProvisioningError}.
 */
function isNetworkFailureMessage(message: string): boolean {
  if (NETWORK_ERRNO_PATTERN.test(message)) return true;
  return DOWNLOAD_FAILURE_PREFIX_PATTERN.test(message) && !HTTP_STATUS_SUFFIX_PATTERN.test(message);
}

/** `NodeJS.ErrnoException` codes treated as an unwritable cache directory. */
const CACHE_WRITE_ERRNO_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC']);

/**
 * Classifies a failure raised while installing the engine (either from
 * `PulumiCommand.install()`/`PulumiCommand.get()` themselves, or from the
 * `mkdirSync`/`renameSync` calls around them) into one of the three typed
 * provisioning errors the spec requires distinct handling for. Checked in
 * order: a version mismatch is always an integrity failure (the binary ran
 * fine, it's just the wrong one); filesystem errno codes are checked next
 * since they're unambiguous signals straight from Node; a message-pattern
 * match is only consulted for errors that carry neither (e.g. the SDK's own
 * pre-script `download()` failure, or the install script's own non-zero
 * exit, whose `CommandError` carries stdout/stderr text but no errno code).
 * Anything that matches none of the above is treated as an integrity
 * failure — the conservative default, since silently mis-reporting a real
 * integrity failure as "no network" would send an operator chasing their
 * connection instead of retrying (which self-heals a rare misclassification
 * either way, since a failed attempt is never memoized).
 */
function classifyProvisioningError(err: unknown, root: string): Error {
  if (err instanceof PulumiEnginePinMismatchError) {
    return new PulumiEngineIntegrityError(root, err);
  }
  const errno = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : undefined;
  if (errno && CACHE_WRITE_ERRNO_CODES.has(errno)) {
    return new PulumiEngineCacheWriteError(root, err);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (isNetworkFailureMessage(message)) {
    return new PulumiEngineNetworkError(root, err);
  }
  return new PulumiEngineIntegrityError(root, err);
}

/**
 * True when `err` is positive evidence that a cache entry is actually
 * invalid — a confirmed exact-version mismatch, the binary genuinely
 * missing (`ENOENT`), or the SDK's own "couldn't parse the version" failure
 * (the binary ran and returned unparseable output) — as opposed to an
 * *ambiguous* exec failure (`EBUSY`/`ETXTBSY`/antivirus interference/a
 * transient spawn error) that says nothing about whether the install itself
 * is actually bad. {@link PulumiEngineService.tryReuseCached} only deletes a
 * cache entry outright when this returns `true`; on an ambiguous failure it
 * leaves the entry in place and lets {@link PulumiEngineService.installFresh}'s
 * swap-aside handle it safely instead. Mirrors the "provable ownership"
 * standard the `pulumi-engine-runtime` spec's stale-lock-recovery
 * requirement applies to a different resource: don't destroy something on
 * an absence of proof, only on positive evidence.
 */
function isProvablyBadCacheEntry(err: unknown): boolean {
  if (err instanceof PulumiEnginePinMismatchError) return true;
  const errno = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : undefined;
  if (errno === 'ENOENT') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /failed to parse pulumi cli version/i.test(message);
}

/**
 * Removes a directory tree best-effort, logging (rather than throwing) if
 * cleanup itself fails. Used to discard a failed/corrupt staging
 * install, a provably-bad cache entry, an unverifiable post-rename install,
 * a superseded (swapped-aside) prior install, and a superseded pinned
 * version during pruning.
 *
 * Calls `rmSync` unconditionally with `force: true` rather than gating on an
 * `existsSync` check first — `force: true` already swallows a missing path,
 * so the extra check would only add a syscall (and a TOCTOU gap) without
 * changing the outcome: the path may or may not exist by the time this
 * runs, and either way this call is a safe no-op or a real cleanup.
 */
function removeDirBestEffort(path: string, context: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    logger.error('Failed to clean up Pulumi engine directory', { path, context, err });
  }
}

/**
 * Resolves a usable Pulumi engine (`PulumiCommand`) without requiring the
 * operator to install anything, per the `pulumi-engine-runtime` delta spec's
 * "App-managed engine provisioning" and "Pinned engine version" requirements.
 * Installs {@link PULUMI_ENGINE_VERSION} into an app-owned directory under
 * Electron `userData` — never `~/.pulumi` — and never probes `PATH` for a
 * `pulumi` binary.
 *
 * Construction is synchronous and never throws — no filesystem or network
 * work happens until {@link resolve} is first called — so `PulumiEngineModule`
 * can be imported by `AppModule` unconditionally even on a machine with no
 * engine and no network, per the "Container builds without an engine"
 * scenario.
 *
 * ## Version-namespaced cache, not detect-and-clear
 *
 * `PulumiCommand.get()`/`PulumiCommand.install()` (see
 * `node_modules/@pulumi/pulumi/automation/cmd.js`) validate an existing
 * installation with a **minimum**-version check, not an exact-match check:
 * `install()` first tries `get({ root })`, and if the binary there already
 * satisfies `>= opts.version` (same major), it's accepted as-is — a *newer*
 * cached version at the same `root` would silently be reused instead of the
 * exact pin. Rather than detecting a stale version at a single fixed `root`
 * and clearing it before installing (which would also mean trusting the
 * install script downloaded from `get.pulumi.com` to overwrite cleanly, an
 * undocumented behaviour of a script this codebase doesn't control), each
 * pinned version gets its own install directory: `<cacheRoot>/versions/<pin>`.
 * A "stale version in the cache" can then never be *the same directory* as
 * the pin's directory, so there's nothing to detect or clear — the pinned
 * version's directory either holds exactly that version (verified below) or
 * doesn't exist yet. This mirrors the SDK's own default root layout
 * (`$HOME/.pulumi/versions/$VERSION`), just relocated under `userData`.
 * {@link assertExactPin} additionally guards against the minimum-check
 * behaviour above at both the cache-hit and fresh-install paths, in case a
 * directory is ever manually tampered with. {@link pruneOldVersions} keeps
 * this from growing unbounded across pin bumps.
 *
 * ## No partial-install reuse
 *
 * {@link installFresh} never installs directly into the pin's final
 * directory. It installs into a sibling staging directory
 * (`<cacheRoot>/versions/.staging-<uuid>`), and only `renameSync`s it into
 * the final `<cacheRoot>/versions/<pin>` path once `PulumiCommand.install()`
 * has resolved *and* {@link assertExactPin} has verified the installed
 * binary reports exactly the pinned version. An interrupted or corrupted
 * install (network drop mid-download, a script that exits non-zero, a
 * binary that fails to execute) therefore never touches the final directory
 * at all — it only ever leaves debris in the staging directory, which is
 * removed via {@link removeDirBestEffort}. The re-verification `get()` call
 * *after* the rename is itself wrapped too: if it fails, the just-renamed
 * directory is removed rather than left at the final path for a later call
 * to treat as valid — and, if this was a swap-aside (see below) rather than
 * an install into a previously-empty `root`, the prior occupant is restored
 * from the trash directory instead of leaving `root` empty — and the
 * failure is classified the same way every other provisioning failure is. A
 * later call (or this one's caller, if a restore succeeded) sees either no
 * directory at the pinned path or the restored prior install, and
 * reprovisions from scratch only in the former case, satisfying the
 * "Interrupted download leaves no usable partial" scenario structurally
 * rather than via an `existsSync` staleness check that a partial write
 * could fool.
 *
 * ## Swap-aside, not delete-then-install
 *
 * {@link tryReuseCached} only deletes a cache entry outright when it has
 * positive evidence the entry is bad (see {@link isProvablyBadCacheEntry}).
 * On an *ambiguous* verification failure (the binary couldn't be exec'd for
 * a reason that says nothing about whether it's actually corrupt — a
 * transient spawn failure, antivirus interference, a locked file) it leaves
 * the entry in place and returns `null`, so {@link installFresh} still
 * attempts a fresh install. That means `installFresh` can encounter a
 * `root` that's already occupied by an entry nobody has condemned yet. It
 * handles this by swapping, not deleting: once a fresh install to staging is
 * verified, any existing occupant of `root` is `renameSync`'d aside to a
 * sibling `.trash-<uuid>` directory *first*, then the verified staging
 * install is `renameSync`'d into `root`. A same-parent `renameSync` is
 * atomic, so `root` is never observed empty between the two renames. This
 * means a possibly-still-good install is never destroyed before its
 * replacement is known to succeed — if the fresh install to staging itself
 * fails, `root` (and whatever ambiguous-but-possibly-fine entry occupies it)
 * is never touched at all, since the swap only runs after that install is
 * verified.
 *
 * The trash directory itself is *not* removed the moment the swap completes
 * — it's kept until the post-rename re-verification `get()` (see "No
 * partial-install reuse" above) confirms the newly-swapped-in install
 * actually works. If that verification fails instead, the trashed entry is
 * `renameSync`'d back into `root` rather than discarded, so a transient
 * failure at this last step can't leave the app with neither the old nor
 * the new install — only once verification succeeds is the trash directory
 * finally removed.
 *
 * ## Memoization that survives a failed attempt
 *
 * {@link resolve} memoizes the in-flight *promise*, so concurrent callers
 * share exactly one provisioning attempt whether it ultimately succeeds or
 * fails (verified in `PulumiEngineService.test.ts` by asserting
 * `PulumiCommand.install` is called exactly once across concurrent
 * `resolve()` calls, in both the success and failure case). A **rejected**
 * attempt is deliberately not left memoized: the field is reset to `null`
 * the moment the shared promise rejects, so the *next* `resolve()` call
 * (after this one has settled) starts a fresh provisioning attempt instead
 * of replaying the same stale rejection forever — engine provisioning
 * failures (no network, a momentarily locked cache directory) are often
 * transient, and the "Provisioning fails with no network" scenario
 * explicitly requires "a retry is offered" — a retry that only re-attempts
 * anything if the failure wasn't memoized.
 */
@Injectable()
export class PulumiEngineService {
  /** In-flight or last-successful provisioning attempt; see the class TSDoc's memoization section. */
  private resolution: Promise<PulumiCommand> | null = null;

  /**
   * The resolved engine's version string, set once {@link resolve} has
   * successfully completed at least once. `null` before the first
   * successful resolution. Backs {@link getResolvedVersion} — the "Resolved
   * version is observable" scenario's accessor.
   */
  private resolvedVersion: string | null = null;

  /**
   * Resolves a `PulumiCommand` pointed at the pinned engine version,
   * provisioning it into the `userData`-rooted cache on first call and
   * memoizing the result for the lifetime of this instance — see the class
   * TSDoc for the full memoization, versioning, and atomicity guarantees.
   * Rejects with {@link PulumiEngineNetworkError}, {@link PulumiEngineIntegrityError},
   * or {@link PulumiEngineCacheWriteError} if provisioning fails; a rejected
   * attempt is not memoized, so the next call retries from scratch.
   *
   * @param onPhase - Phase-reporting extension point. When supplied, this
   *   call reports `('engine', 'start')` synchronously before doing anything
   *   else, and `('engine', 'end')` once *this specific call's* returned
   *   promise settles — whether it settles by resolving (this call
   *   provisioned fresh, or joined/reused an already-resolved or in-flight
   *   attempt) or by rejecting. Reporting is per-call, not per-provisioning-
   *   attempt: two concurrent `resolve(onPhase)` callers each get their own
   *   `start`/`end` pair even though (per the memoization guarantee above)
   *   only one `PulumiCommand.install()` actually runs — from each caller's
   *   own point of view, it genuinely was waiting on the engine phase for
   *   that whole span, which is what the spec's "reports provisioning
   *   progress to the caller" language asks for.
   *
   * ## Why 'engine' is coarse, and why this method never fires 'plugins'/'operation'
   *
   * `PulumiCommand.install()` (`@pulumi/pulumi/automation/cmd.js`) offers no
   * output or progress hook of its own, so `'engine'` is necessarily coarse
   * start/end, never a percentage or byte count.
   *
   * This method never invokes `'plugins'` (provider plugin download) or
   * `'operation'` (the `preview`/`up`/`destroy`/`refresh` itself) — those are
   * fired by `PulumiService`, the caller that actually runs those operations.
   * `PulumiWorkspaceService.getOrCreateStack` only reaches
   * `LocalWorkspace.createOrSelectStack` (`stack select`/`stack init`), which
   * never needs a provider plugin, so there is no plugin-download event in
   * this method's own call path for this callback to observe. This method's
   * `onPhase` parameter and the {@link PulumiProvisioningPhase} type are only
   * the "callback plumbing exists and is wired through" half of the full
   * three-phase contract; firing `'plugins'`/`'operation'` is
   * `PulumiService.initializeStack`'s job — see that method's own TSDoc.
   */
  resolve(onPhase?: PulumiPhaseCallback): Promise<PulumiCommand> {
    onPhase?.('engine', 'start');
    if (!this.resolution) {
      this.resolution = this.provision().catch((err: unknown) => {
        this.resolution = null;
        throw err;
      });
    }
    return this.resolution.then(
      (command) => {
        onPhase?.('engine', 'end');
        return command;
      },
      (err: unknown) => {
        onPhase?.('engine', 'end');
        throw err;
      },
    );
  }

  /**
   * The pinned engine version this service provisions — re-exported from
   * `@hyveon/shared` for convenience so callers only need `PulumiEngineService`.
   */
  getPinnedVersion(): string {
    return PULUMI_ENGINE_VERSION;
  }

  /**
   * The resolved engine's version string once {@link resolve} has completed
   * successfully at least once, or `null` before that (including while a
   * first resolution is still in flight). Always equal to
   * {@link getPinnedVersion} once set — {@link assertExactPin} guarantees
   * {@link resolve} never resolves to anything other than the pinned
   * version.
   */
  getResolvedVersion(): string | null {
    return this.resolvedVersion;
  }

  /**
   * Runs the actual provisioning attempt {@link resolve} memoizes: reuse a
   * verified cache entry at the pin's version-namespaced directory, or
   * install fresh into it. Records {@link resolvedVersion} only once a
   * `PulumiCommand` has been obtained and verified.
   */
  private async provision(): Promise<PulumiCommand> {
    const pin = new SemVer(PULUMI_ENGINE_VERSION);
    const root = this.getEngineInstallRoot(pin);
    const startedAt = Date.now();
    logger.info('PulumiEngineService: resolving Pulumi engine', { pin: pin.toString(), root });

    const cached = await this.tryReuseCached(root, pin);
    const command = cached ?? (await this.installFresh(root, pin));

    this.resolvedVersion = command.version ? command.version.toString() : null;
    logger.info('PulumiEngineService: Pulumi engine resolved', {
      pin: pin.toString(),
      root,
      cacheHit: cached !== null,
      elapsedMs: Date.now() - startedAt,
    });
    return command;
  }

  /**
   * Attempts to reuse an already-installed engine at `root`. Returns `null`
   * (never throws) when nothing is installed there yet, or when what's
   * there fails verification — but only *deletes* the entry when
   * {@link isProvablyBadCacheEntry} confirms the failure is positive
   * evidence of corruption, not merely an inconclusive exec failure. See
   * the class TSDoc's "Swap-aside, not delete-then-install" section for why
   * an ambiguous failure is left in place rather than removed.
   */
  private async tryReuseCached(root: string, pin: SemVer): Promise<PulumiCommand | null> {
    if (!existsSync(root)) return null;

    try {
      const command = await PulumiCommand.get({ root, version: pin, skipVersionCheck: false });
      this.assertExactPin(command, pin, root);
      return command;
    } catch (err) {
      if (isProvablyBadCacheEntry(err)) {
        logger.warn('Pulumi engine cache entry is provably invalid — discarding and reprovisioning', {
          root,
          err,
        });
        removeDirBestEffort(root, 'provably invalid cache entry');
      } else {
        logger.warn(
          'Pulumi engine cache entry failed an ambiguous, possibly-transient check — leaving it in ' +
            'place and reprovisioning fresh; a successful reprovision will swap it aside rather than lose it',
          { root, err },
        );
      }
      return null;
    }
  }

  /**
   * Installs the pinned engine into a fresh staging directory, verifies it,
   * and only then swaps it into `root` — see the class TSDoc's "No
   * partial-install reuse" and "Swap-aside, not delete-then-install"
   * sections for the guarantees this ordering provides. Throws
   * {@link PulumiEngineNetworkError}, {@link PulumiEngineIntegrityError}, or
   * {@link PulumiEngineCacheWriteError} (via {@link classifyProvisioningError})
   * on any failure, after best-effort cleanup of whatever this call itself
   * touched. On success, prunes superseded pinned versions via
   * {@link pruneOldVersions}.
   */
  private async installFresh(root: string, pin: SemVer): Promise<PulumiCommand> {
    // Parent of the pin's own directory (`<engineCacheRoot>/versions`) — the
    // staging directory below is created as its sibling, not inside `root`
    // itself, so `root` is never observed to exist until the rename below
    // makes it appear atomically, fully installed.
    const versionsDir = dirname(root);
    try {
      mkdirSync(versionsDir, { recursive: true });
    } catch (err) {
      logger.error('PulumiEngineService: failed to create the Pulumi engine versions directory', {
        versionsDir,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new PulumiEngineCacheWriteError(versionsDir, err);
    }

    const stagingDir = join(versionsDir, `.staging-${randomUUID()}`);
    try {
      const installed = await PulumiCommand.install({ version: pin, root: stagingDir, skipVersionCheck: false });
      this.assertExactPin(installed, pin, stagingDir);
    } catch (err) {
      removeDirBestEffort(stagingDir, 'failed install');
      const classified = classifyProvisioningError(err, versionsDir);
      logger.error('PulumiEngineService: failed to install the pinned Pulumi engine', {
        stagingDir,
        error: classified.message,
      });
      throw classified;
    }

    // Swap the verified staging install into place. `root` may already be
    // occupied by an entry `tryReuseCached` deliberately left in place
    // rather than deleting on inconclusive evidence — move it aside first
    // rather than deleting it before the new install is confirmed to
    // succeed. Both renames are same-parent (`versionsDir`), so each is
    // atomic: `root` is never observed empty or partially written.
    const trashDir = existsSync(root) ? join(versionsDir, `.trash-${randomUUID()}`) : null;
    try {
      if (trashDir) renameSync(root, trashDir);
      renameSync(stagingDir, root);
    } catch (err) {
      logger.error('PulumiEngineService: failed to swap the verified Pulumi engine install into place', {
        root,
        stagingDir,
        error: err instanceof Error ? err.message : String(err),
      });
      removeDirBestEffort(stagingDir, 'failed rename into place');
      // Best-effort restore: if the prior occupant was already moved aside
      // but the swap didn't complete, put it back rather than leaving
      // `root` empty — this is exactly the "don't destroy a good install
      // before the new one is known to succeed" guarantee the swap exists
      // for.
      if (trashDir && existsSync(trashDir) && !existsSync(root)) {
        try {
          renameSync(trashDir, root);
        } catch (restoreErr) {
          logger.error('Failed to restore prior Pulumi engine install after a failed swap', {
            root,
            trashDir,
            restoreErr,
          });
        }
      }
      throw new PulumiEngineCacheWriteError(versionsDir, err);
    }
    // `trashDir` is deliberately NOT removed yet. The swap has completed on
    // disk, but the new install at `root` still has to survive the
    // post-rename re-verification below before it's trusted — removing the
    // prior occupant here would defeat the entire point of swapping instead
    // of deleting (see the class TSDoc's "Swap-aside, not delete-then-
    // install" section): a verification failure a few lines down would then
    // leave neither the old nor the new install standing.

    // The `PulumiCommand` returned by `install()` above still points at the
    // now-renamed-away staging path — re-resolve a fresh one against the
    // final `root`. This call is itself wrapped: a failure here means a
    // verified-good install just got renamed into place but then failed to
    // resolve again (e.g. a transient exec failure immediately after the
    // move) — that must not let a raw SDK error escape with an unvalidated
    // install left sitting at the final path for a later `tryReuseCached`
    // to stumble on. If a prior occupant is still parked in `trashDir`
    // (never touched above), it's restored to `root` rather than leaving the
    // app with no engine at all — the same "don't destroy a good install
    // before the replacement is confirmed" guarantee the swap exists for,
    // just extended one step further to cover this verification too.
    let final: PulumiCommand;
    try {
      final = await PulumiCommand.get({ root, version: pin, skipVersionCheck: false });
      this.assertExactPin(final, pin, root);
    } catch (err) {
      const classified = classifyProvisioningError(err, versionsDir);
      logger.error('PulumiEngineService: post-rename verification of the installed Pulumi engine failed', {
        root,
        error: classified.message,
      });
      removeDirBestEffort(root, 'failed post-rename verification');
      if (trashDir) {
        try {
          renameSync(trashDir, root);
        } catch (restoreErr) {
          logger.error('Failed to restore prior Pulumi engine install after post-rename verification failed', {
            root,
            trashDir,
            restoreErr,
          });
        }
      }
      throw classified;
    }

    if (trashDir) removeDirBestEffort(trashDir, 'superseded by a fresh verified install');
    this.pruneOldVersions(versionsDir, root);
    return final;
  }

  /**
   * Throws {@link PulumiEnginePinMismatchError} unless `command.version` is
   * defined and exactly equal to `pin` — guards against
   * `PulumiCommand.get()`/`install()`'s own check being a minimum-version
   * check rather than an exact match, per the class TSDoc's "Version-
   * namespaced cache" section.
   */
  private assertExactPin(command: PulumiCommand, pin: SemVer, root: string): void {
    if (!command.version || command.version.compare(pin) !== 0) {
      throw new PulumiEnginePinMismatchError(root, command.version, pin);
    }
  }

  /**
   * Best-effort removes every entry directly under `versionsDir` other than
   * the current pin's own directory (`keepRoot`) and any in-flight
   * `.staging-`/`.trash-` directory — version-namespacing (see the class
   * TSDoc) solved staleness by never reusing an old pin's directory, but
   * without pruning the cache would otherwise grow by a few hundred MB on
   * every pin bump for the lifetime of the installation. Called once per
   * successful provisioning, right after a new pin's directory is confirmed
   * installed and verified. Never throws — a pruning failure (including
   * failing to even list `versionsDir`) is logged and otherwise ignored,
   * since failing to reclaim disk space is not a reason to fail
   * provisioning that already succeeded.
   */
  private pruneOldVersions(versionsDir: string, keepRoot: string): void {
    let entries: string[];
    try {
      entries = readdirSync(versionsDir);
    } catch (err) {
      logger.warn('Failed to list Pulumi engine versions directory for pruning', { versionsDir, err });
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.staging-') || entry.startsWith('.trash-')) continue;
      const entryPath = join(versionsDir, entry);
      if (entryPath === keepRoot) continue;
      removeDirBestEffort(entryPath, 'superseded pinned version');
    }
  }

  /**
   * Resolves the version-namespaced install directory for `pin`:
   * `<cacheRoot>/versions/<pin>`. See {@link getEngineCacheRoot} for how
   * `cacheRoot` itself is resolved.
   */
  private getEngineInstallRoot(pin: SemVer): string {
    return join(this.getEngineCacheRoot(), 'versions', pin.toString());
  }

  /**
   * Resolves the root cache directory the engine (and, per-version, every
   * pin this service has ever provisioned) is installed under. Mirrors
   * `ConfigService.getRunsDir()`'s resolution order:
   *
   *  1. `HYVEON_PULUMI_ENGINE_DIR` env var — wins when set, resolved against
   *     `process.cwd()` so a relative override behaves predictably in
   *     dev/test. Prefixed `HYVEON_` (rather than a bare `PULUMI_ENGINE_DIR`)
   *     so it can't collide with a variable Pulumi's own CLI or SDK might
   *     introduce.
   *  2. Electron `userData` directory (`<userData>/pulumi`) — the app-owned
   *     location the spec requires ("never `~/.pulumi`"), available whenever
   *     this process is running inside Electron (see {@link resolveUserDataPath}).
   *  3. OS temp directory (`<os.tmpdir()>/hyveon-pulumi-engine`) fallback —
   *     used in plain-Node/test contexts where no Electron `userData` path
   *     exists.
   */
  private getEngineCacheRoot(): string {
    const envOverride = process.env['HYVEON_PULUMI_ENGINE_DIR'];
    if (envOverride) return resolve(envOverride);

    const userData = this.resolveUserDataPath();
    if (userData) return join(userData, 'pulumi');

    return join(tmpdir(), 'hyveon-pulumi-engine');
  }

  /**
   * Returns the Electron `userData` directory when running inside an
   * Electron process, or `null` otherwise. Duplicates
   * `ConfigService.readUserDataPath()`'s exact seam (lazy `createRequire`,
   * guarded on `process.versions['electron']`, `try/catch → null`) rather
   * than injecting `ConfigService` to reuse it: that accessor is `protected`
   * on `ConfigService` today (widening it to `public` would broaden that
   * service's surface for a single caller outside its own concern —
   * Pulumi workspace paths — and `PulumiEngineService` has no other
   * reason to depend on `ConfigService` at all), and duplicating ten lines
   * keeps this service's constructor dependency-free, which is what makes
   * "construction is synchronous and never throws" trivially true rather
   * than something that depends on `ConfigService`'s own constructor
   * behaviour. `protected` (not `private`) so a test subclass can override
   * it to `public`, mirroring `ConfigService.test.ts`'s `TestableConfigService`.
   */
  protected resolveUserDataPath(): string | null {
    if (!process.versions['electron']) return null;
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { getPath(name: string): string } };
      return electron.app.getPath('userData');
    } catch {
      return null;
    }
  }
}
