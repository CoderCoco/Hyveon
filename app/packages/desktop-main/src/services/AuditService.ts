/**
 * Write/read facade over the cloud-agnostic `AuditLogStore` contract (see
 * `@hyveon/shared/cloud.js`), backing the `game_servers` mutation audit log
 * (`terraform/aws/audit_store.tf`).
 *
 * `record()` is intentionally best-effort: an audit-log write failure (or a
 * not-yet-deployed table) must never block the `game_servers` write it's
 * describing, so every failure path logs a winston warning and returns
 * rather than throwing. `list()` is the read side backing the audit log UI.
 */
import * as os from 'node:os';
import { Inject, Injectable } from '@nestjs/common';
import { buildAuditSk } from '@hyveon/shared';
import type { AuditAction, AuditEntry, AuditLogStore, AuditPageResult, GameServer } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { AUDIT_LOG_STORE } from '../modules/cloud-provider.tokens.js';

/** Default page size for {@link AuditService.list} when `limit` is omitted or invalid. */
const DEFAULT_LIMIT = 25;

/** Maximum page size {@link AuditService.list} will honour, regardless of the requested `limit`. */
const MAX_LIMIT = 100;

/** Input to {@link AuditService.record} — everything about a mutation except who/when, which the service fills in itself. */
export interface RecordAuditEntryParams {
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

/** Input to {@link AuditService.list} — an optional page size and pagination cursor. */
export interface ListAuditEntriesOpts {
  /** Requested page size; clamped to `[1, 100]` and defaulted to `25` when omitted or invalid. */
  limit?: number;
  /** Cursor (an `AuditEntry.sk` value) to fetch the page older than. */
  before?: string;
}

/**
 * Clamps a requested page size to a sane default (25) and hard maximum
 * (100). Falls back to the default for anything non-finite or `<= 0`.
 */
function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(Math.floor(limit), MAX_LIMIT));
}

/**
 * Records `game_servers` mutations to (and lists them back from) the audit
 * DynamoDB table via the injected {@link AuditLogStore}. See the file-level
 * doc comment above for the best-effort-write contract.
 */
@Injectable()
export class AuditService {
  /**
   * `store` is typed against the cloud-agnostic `AuditLogStore` contract
   * (not a concrete AWS class) so this service depends only on the
   * interface; `@Inject(AUDIT_LOG_STORE)` tells Nest which concrete provider
   * (bound by `CloudProviderModule` for whichever cloud is active) to
   * resolve for that parameter, since interfaces don't survive to runtime
   * for Nest's reflection-based DI to key off of.
   */
  constructor(
    private readonly config: ConfigService,
    @Inject(AUDIT_LOG_STORE) private readonly store: AuditLogStore,
  ) {}

  /**
   * Builds an {@link AuditEntry} from `params` (actor from `os.userInfo()`,
   * timestamp/`sk` from the current time) and persists it via
   * `store.putEntry`.
   *
   * Never throws: when `audit_table_name` isn't in the Terraform outputs
   * yet (table not deployed) or `store.putEntry` rejects, a winston warning
   * is logged and the method returns — the caller's own write must not be
   * blocked or failed by an audit-logging problem.
   */
  async record(params: RecordAuditEntryParams): Promise<void> {
    const tableName = this.config.getTfOutputs()?.audit_table_name;
    if (!tableName) {
      logger.warn('AuditService.record: audit_table_name not configured, skipping audit log entry', {
        action: params.action,
        game: params.game,
      });
      return;
    }

    try {
      const now = new Date();
      const entry: AuditEntry = {
        sk: buildAuditSk(now),
        timestamp: now.toISOString(),
        actor: os.userInfo().username,
        action: params.action,
        game: params.game,
        before: params.before,
        after: params.after,
        ...(params.versionId !== undefined ? { versionId: params.versionId } : {}),
      };

      await this.store.putEntry(entry);
    } catch (err) {
      logger.warn('AuditService.record: failed to write audit log entry', {
        err,
        action: params.action,
        game: params.game,
      });
    }
  }

  /**
   * Lists audit entries newest-first, delegating to `store.listEntries`
   * after clamping `opts.limit` via {@link clampLimit}.
   *
   * Mirrors {@link record}'s missing-table guard: when `audit_table_name`
   * isn't in the Terraform outputs yet (table not deployed), a winston
   * warning is logged and an empty page is returned rather than letting
   * `store.listEntries` throw — the always-visible audit page should render
   * its empty state on pre-audit-table deployments, not an error state.
   */
  async list(opts: ListAuditEntriesOpts = {}): Promise<AuditPageResult> {
    const tableName = this.config.getTfOutputs()?.audit_table_name;
    if (!tableName) {
      logger.warn('AuditService.list: audit_table_name not configured, returning empty audit log page');
      return { entries: [] };
    }

    return this.store.listEntries(clampLimit(opts.limit), opts.before);
  }
}
