import { Injectable } from '@nestjs/common';
import type { DriftChangedField, DriftEntry, DriftReport, GameServer } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { DeploymentConfigService } from './DeploymentConfigService.js';

/**
 * Config fields compared for a `'config_drift'` finding, paired with the
 * accessor used to pull that field off a declared/applied `GameServer`-shaped
 * object. Order here determines the order `changedFields` is reported in.
 */
const COMPARED_FIELDS: { field: DriftChangedField; get: (g: Omit<GameServer, 'name'>) => unknown }[] = [
  { field: 'image', get: (g) => g.image },
  { field: 'cpu', get: (g) => g.cpu },
  { field: 'memory', get: (g) => g.memory },
  { field: 'ports', get: (g) => g.ports },
  { field: 'volumes', get: (g) => g.volumes },
];

/**
 * Deep-equality check via JSON serialization. Sufficient for the plain
 * JSON-ish `GameServer` field values (`string`, `number`, and arrays of
 * plain objects) compared here — no need for a general-purpose deep-equal.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Deterministically stringifies a value for order-insensitive comparison,
 * recursively sorting object keys so that two objects differing only in key
 * order (e.g. `{container, protocol}` vs `{protocol, container}`, as HCL/JSON
 * key order isn't guaranteed to be stable) produce identical strings. Arrays
 * preserve their element order — only object *key* order is canonicalized.
 */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The `'ports'` and `'volumes'` fields are JSON arrays whose element order can
 * shift between a `deployment-config.json` edit and the last-applied snapshot
 * (or vice versa) without the *set* of ports/volumes actually changing — e.g.
 * an operator reordering entries in the declared config. Comparison for these
 * two fields is therefore order-insensitive: array values are sorted by their
 * canonical (key-order-independent) string representation before the
 * equality check, so key-order-only differences within each entry (e.g. from
 * how the declared and applied sides independently serialize equivalent
 * JSON) don't falsely trigger drift. All other compared fields use `value`
 * as-is (order-sensitive, which is correct for scalars).
 */
function normalizeForComparison(field: DriftChangedField, value: unknown): unknown {
  if ((field === 'ports' || field === 'volumes') && Array.isArray(value)) {
    return [...value].map((entry) => canonicalStringify(entry)).sort();
  }
  return value;
}

/**
 * Compares a declared game's config against its applied (last
 * successfully-applied) config and returns the list of {@link COMPARED_FIELDS}
 * that differ, in declaration order. Empty when the two configs match on
 * every compared field. `ports`/`volumes` comparisons are order-insensitive
 * — see {@link normalizeForComparison}.
 */
function changedFields(
  declared: Omit<GameServer, 'name'>,
  applied: Omit<GameServer, 'name'>,
): DriftChangedField[] {
  return COMPARED_FIELDS.filter(
    ({ field, get }) =>
      !deepEqual(normalizeForComparison(field, get(declared)), normalizeForComparison(field, get(applied))),
  ).map(({ field }) => field);
}

/**
 * Pure computation of a {@link DriftReport} from a declared game list
 * (`DeploymentConfigService.getGameServers()`), the applied game config snapshot
 * (`ConfigService.getStackOutputs()?.appliedGameServers`), and the
 * authoritative set of deployed game names (`deployedNames`, mirroring the
 * `deployed` parameter of `mergeGameLists()` in `./mergeGameLists.ts`). No
 * I/O — safe to unit test directly.
 *
 * Per-game classification (see `@hyveon/shared/drift.ts` for the full
 * contract):
 *  - Declared but absent from `deployedNames` → `'pending_create'`.
 *  - Present in `deployedNames` but absent from `declared` → `'pending_delete'`.
 *  - Present in both `declared` and `applied`, with any of
 *    `image`/`cpu`/`memory`/`ports`/`volumes` differing → `'config_drift'`,
 *    with `changedFields` listing exactly which fields differ.
 *  - Present in both with every compared field matching → no entry (in
 *    sync games are omitted from the report entirely).
 *
 * `applied` is `null` when the deployed stack has no `appliedGameServers`
 * output yet (state predates the output, or nothing has been applied since
 * it was added). In that case `deployedNames` is expected to fall back
 * to `stackOutputs.gameNames` (the caller's responsibility — see
 * {@link DriftService.getDrift}), so games already known to be deployed via
 * `game_names` are still correctly excluded from `'pending_create'` and
 * still produce `'pending_delete'` entries when no longer declared, even
 * though there's no applied config to diff for `'config_drift'`.
 *
 * Ordering is deterministic: entries appear in `declared` config order
 * first, followed by any deployed-only entries (`'pending_delete'`) in the
 * order they appear in `deployedNames`.
 */
export function computeDrift(
  declared: GameServer[],
  applied: Record<string, Omit<GameServer, 'name'>> | null,
  deployedNames: string[],
): DriftReport {
  const appliedMap = applied ?? {};
  const deployedSet = new Set(deployedNames);
  const declaredNames = new Set(declared.map((g) => g.name));
  const entries: DriftEntry[] = [];

  for (const game of declared) {
    if (!deployedSet.has(game.name)) {
      entries.push({ game: game.name, kind: 'pending_create' });
      continue;
    }

    const appliedEntry = appliedMap[game.name];
    if (!appliedEntry) {
      continue;
    }

    const diffs = changedFields(game, appliedEntry);
    if (diffs.length > 0) {
      entries.push({ game: game.name, kind: 'config_drift', changedFields: diffs });
    }
  }

  for (const name of deployedNames) {
    if (!declaredNames.has(name)) {
      entries.push({ game: name, kind: 'pending_delete' });
    }
  }

  return { entries };
}

/**
 * Computes drift between the declared game server configuration
 * (`deployment-config.json`, via {@link DeploymentConfigService.getGameServers}) and the
 * applied configuration last written to the deployed Pulumi stack (via
 * {@link ConfigService.getStackOutputs}'s `appliedGameServers` and
 * `gameNames` outputs). See issue #94.
 *
 * All comparison logic lives in the pure, exported {@link computeDrift}
 * function — this service is a thin I/O wrapper that fetches the inputs and
 * delegates.
 */
@Injectable()
export class DriftService {
  constructor(
    private readonly deploymentConfig: DeploymentConfigService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Returns the current {@link DriftReport} — see {@link computeDrift} for
   * the classification rules. Invalidates only the `DeploymentConfigService` cache
   * (cheap — an in-memory S3 object cache with its own short TTL), NOT
   * {@link ConfigService}'s stack-outputs cache: this method backs
   * `PendingChangesBanner`'s 30-second `GET /api/drift` poll
   * (`POLL_INTERVAL_MS`), and `ConfigService.getStackOutputs()` is a
   * genuinely expensive round-trip (Pulumi engine resolution, passphrase, S3
   * backend) — eagerly invalidating that cache on every poll tick would turn
   * an idle dashboard into a steady stream of engine-resolution + S3 calls,
   * and risks the DIY backend's write lock if the "no-create" guarantee on a
   * passphrase-but-no-real-stack edge case ever misfires (see
   * `PulumiService.getStackOutputs`'s doc comment). The stack-outputs cache
   * is invalidated on write instead, not on every read here.
   */
  async getDrift(): Promise<DriftReport> {
    logger.debug('DriftService.getDrift: computing deployment drift');
    try {
      this.deploymentConfig.invalidateCache();
      const declared = await this.deploymentConfig.getGameServers();
      const stackOutputs = await this.config.getStackOutputs();
      const applied = stackOutputs?.appliedGameServers ?? null;
      const deployedNames = stackOutputs?.appliedGameServers
        ? Object.keys(stackOutputs.appliedGameServers)
        : (stackOutputs?.gameNames ?? []);
      return computeDrift(declared, applied, deployedNames);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('DriftService.getDrift: failed to compute drift', { error: message });
      throw new Error(message);
    }
  }
}
