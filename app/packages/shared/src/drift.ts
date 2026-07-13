/**
 * Shared types for drift detection — comparing the declared game server
 * configuration (`terraform.tfvars`, via `TfvarsService.getGameServers()`)
 * against the live deployed state (`terraform.tfstate`, via
 * `ConfigService.getTfOutputs()`). See issue #94.
 */

/**
 * Category of mismatch between a game's declared (tfvars) and deployed
 * (tfstate) state.
 *
 * - `pending_create` — declared in tfvars but not yet applied/deployed.
 * - `pending_delete` — deployed but no longer present in tfvars.
 * - `config_drift`   — present in both, but one or more fields (ports,
 *   image, CPU, memory, volume mounts, etc.) differ between the declared
 *   and deployed configuration.
 */
export type DriftKind = 'pending_create' | 'pending_delete' | 'config_drift';

/**
 * Name of a top-level game server config field that can differ between the
 * declared (tfvars) and deployed (tfstate) configuration for a
 * `'config_drift'` finding. Deliberately a closed set of field names — no
 * declared/deployed config payloads are echoed back, only which fields
 * changed.
 */
export type DriftChangedField = 'ports' | 'image' | 'cpu' | 'memory' | 'volumes';

/**
 * A single per-game drift finding, produced by comparing a game's declared
 * tfvars configuration against its live tfstate configuration.
 */
export interface DriftEntry {
  /** Game key (matches the `game_servers` map key / tfstate game name). */
  game: string;
  /** Category of drift detected for this game. */
  kind: DriftKind;
  /**
   * Names of the fields that differ between declared and deployed
   * configuration. Only present when `kind` is `'config_drift'`. No
   * declared/deployed values are included — only the field names.
   */
  changedFields?: DriftChangedField[];
}

/**
 * Aggregate drift report returned by `GET /api/drift`. Lists every game
 * that is out of sync between its declared and deployed configuration;
 * games that are in sync (declared and deployed, with matching config) are
 * omitted entirely.
 */
export interface DriftReport {
  /** Per-game drift findings. Empty when declared and deployed state match. */
  entries: DriftEntry[];
}
