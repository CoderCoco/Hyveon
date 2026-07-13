import { Injectable } from '@nestjs/common';
import type { DriftChangedField, DriftEntry, DriftReport, GameServer } from '@hyveon/shared';
import { ConfigService } from './ConfigService.js';
import { TfvarsService } from './TfvarsService.js';

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
 * The `'ports'` and `'volumes'` fields are HCL lists whose element order can
 * shift between a `terraform.tfvars` edit and the last-applied snapshot (or
 * vice versa) without the *set* of ports/volumes actually changing — e.g. an
 * operator reordering entries in the tfvars file. Comparison for these two
 * fields is therefore order-insensitive: array values are sorted by their
 * JSON representation before the equality check. All other compared fields
 * use `value` as-is (order-sensitive, which is correct for scalars).
 */
function normalizeForComparison(field: DriftChangedField, value: unknown): unknown {
  if ((field === 'ports' || field === 'volumes') && Array.isArray(value)) {
    return [...value].map((entry) => JSON.stringify(entry)).sort();
  }
  return value;
}

/**
 * Compares a declared game's tfvars config against its applied (last
 * `terraform apply`d) config and returns the list of {@link COMPARED_FIELDS}
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
 * (`TfvarsService.getGameServers()`), the applied game config snapshot
 * (`ConfigService.getTfOutputs()?.applied_game_servers`), and the
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
 * `applied` is `null` when `terraform.tfstate` has no `applied_game_servers`
 * output yet (state predates the output, or `terraform apply` hasn't run
 * since it was added). In that case `deployedNames` is expected to fall back
 * to `tfOutputs.game_names` (the caller's responsibility — see
 * {@link DriftService.getDrift}), so games already known to be deployed via
 * `game_names` are still correctly excluded from `'pending_create'` and
 * still produce `'pending_delete'` entries when no longer declared, even
 * though there's no applied config to diff for `'config_drift'`.
 *
 * Ordering is deterministic: entries appear in `declared` (tfvars) order
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
 * (`terraform.tfvars`, via {@link TfvarsService.getGameServers}) and the
 * applied configuration Terraform last wrote to `terraform.tfstate` (via
 * {@link ConfigService.getTfOutputs}'s `applied_game_servers` and
 * `game_names` outputs). See issue #94.
 *
 * All comparison logic lives in the pure, exported {@link computeDrift}
 * function — this service is a thin I/O wrapper that fetches the inputs and
 * delegates.
 */
@Injectable()
export class DriftService {
  constructor(
    private readonly tfvars: TfvarsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Returns the current {@link DriftReport} — see {@link computeDrift} for
   * the classification rules. Invalidates the tfstate cache and the
   * `TfvarsService` cache first (mirroring `GamesController.listGames()`) so
   * a fresh `terraform apply` / tfvars edit is reflected without having to
   * restart the server. Backs the `GET /api/drift` route.
   */
  async getDrift(): Promise<DriftReport> {
    this.config.invalidateCache();
    this.tfvars.invalidateCache();
    const declared = await this.tfvars.getGameServers();
    const tfOutputs = this.config.getTfOutputs();
    const applied = tfOutputs?.applied_game_servers ?? null;
    const deployedNames = tfOutputs?.applied_game_servers
      ? Object.keys(tfOutputs.applied_game_servers)
      : (tfOutputs?.game_names ?? []);
    return computeDrift(declared, applied, deployedNames);
  }
}
