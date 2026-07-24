import { ulid } from 'ulid';
import type { GameServer } from './tfvars.js';

/**
 * The kind of mutation an {@link AuditEntry} records. Mirrors the CRUD verbs
 * exposed by the `game_servers` write endpoints in `@hyveon/desktop-main`,
 * plus `plan` for a dry-run `terraform plan` invocation that touched no
 * infrastructure, `approve` for marking a successful `plan` run approved
 * for a later `apply` (see `TerraformController.approve`, issue #109),
 * `apply` for a `terraform apply` invocation that actually mutated
 * infrastructure (see `TerraformController.apply`, issue #109), and
 * `destroy` for a confirmed `terraform destroy` invocation that was
 * initiated to tear down every managed resource — recorded once the run
 * starts, not once it's confirmed successful (see `TerraformController.destroy`, issue #307).
 */
export type AuditAction = 'add' | 'edit' | 'remove' | 'plan' | 'approve' | 'apply' | 'destroy';

/**
 * A single row in the DynamoDB audit log (`${project_name}-audit` table,
 * `pk = AUDIT`, `sk = ` {@link buildAuditSk}). Records who changed a game
 * server's configuration, what changed, and the resulting `terraform.tfvars`
 * S3 version — see `terraform/aws/audit.tf` for the table definition.
 */
export interface AuditEntry {
  /** Sort key: `<ISO timestamp>#<ULID>` — see {@link buildAuditSk}. */
  sk: string;
  /** ISO-8601 timestamp of the mutation. Duplicated from `sk` for cheap reads without parsing. */
  timestamp: string;
  /** Identifier of the user or system that performed the mutation. */
  actor: string;
  /** The kind of mutation performed. */
  action: AuditAction;
  /** The `game_servers` map key the mutation applied to. */
  game: string;
  /** The game's configuration before the mutation, or `null` for `add`. */
  before: GameServer | null;
  /** The game's configuration after the mutation, or `null` for `remove`. */
  after: GameServer | null;
  /** S3 object version id of `terraform.tfvars` produced by the write, if known. */
  versionId?: string;
}

/**
 * A page of audit entries returned by {@link AuditLogStore.listEntries},
 * newest-first, plus an optional cursor for fetching the next page.
 */
export interface AuditPageResult {
  /** The page of entries, newest-first. */
  entries: AuditEntry[];
  /** Cursor (an {@link AuditEntry.sk} value) to pass as `before` to fetch the next, older page. Absent on the last page. */
  nextBefore?: string;
}

/**
 * Builds a DynamoDB sort key for a new {@link AuditEntry}: the ISO-8601
 * timestamp of `now` followed by a `#`-separated ULID, e.g.
 * `2026-07-17T12:34:56.789Z#01J...`. The ISO prefix keeps entries sorted
 * chronologically within the `AUDIT` partition; the ULID suffix disambiguates
 * entries written within the same millisecond.
 *
 * Pure: takes the timestamp as an (optional) argument rather than reading a
 * clock internally, so callers can pass a fixed `Date` for deterministic
 * ordering/testing.
 *
 * @param now - The timestamp to encode. Defaults to `new Date()`.
 * @returns The `<ISO timestamp>#<ULID>` sort key.
 */
export function buildAuditSk(now: Date = new Date()): string {
  return `${now.toISOString()}#${ulid(now.getTime())}`;
}
