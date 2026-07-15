/**
 * Write-side orchestrator for the `games.create` / `games.update` /
 * `games.delete` IPC channels (and their HTTP equivalents) — see issue #98.
 *
 * Each operation follows the same shape:
 *  1. Validate the proposed entry via `validateGameServer()` (skipped for
 *     `deleteGame`, which has no config to validate), using the current
 *     declared `game_servers` list (`TfvarsService.getGameServers()`) as the
 *     sibling set for the cross-game port-collision check.
 *  2. Delegate the actual HCL mutation to `TfvarsService.addGameServer()` /
 *     `updateGameServer()` / `removeGameServer()`, forwarding
 *     `expectedVersionId` so the S3-mode conditional-put guard is honoured.
 *  3. Translate the handful of error shapes those calls can throw into the
 *     matching `GameWriteResult` failure variant (see the per-method docs
 *     below for the exact mapping).
 *  4. On success, invalidate both the `TfvarsService` and `ConfigService`
 *     caches, emit a structured audit log entry, and return the updated game
 *     plus a freshly `mergeGameLists()`d games list so callers can refresh
 *     their view without a second round trip.
 */
import { Injectable } from '@nestjs/common';
import type { CreateGamePayload, DeleteGamePayload, GameServer, GameWriteResult, UpdateGamePayload } from '@hyveon/shared';
import { OptimisticLockError, validateGameServer } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { TfvarsService } from './TfvarsService.js';
import { HclSurgeonError } from './hclSurgeon.js';
import { mergeGameLists } from './mergeGameLists.js';

/** The three write operations this service performs — used to tag the audit log entry. */
type GameWriteAction = 'create' | 'update' | 'delete';

/**
 * Validates and writes `game_servers` create/update/delete requests — see
 * the file-level doc comment above for the full flow. A thin orchestration
 * layer over `TfvarsService` (the actual HCL mutation) and
 * `validateGameServer` (the shared structural/business-rule validator);
 * holds no state of its own.
 */
@Injectable()
export class GamesWriteService {
  constructor(
    private readonly config: ConfigService,
    private readonly tfvars: TfvarsService,
  ) {}

  /**
   * Adds a brand-new `game_servers` entry. Validates `payload.config` via
   * `validateGameServer()` against every currently-declared game (so a port
   * collision against an existing game is caught), then delegates to
   * `TfvarsService.addGameServer()`.
   *
   * Failure mapping:
   *  - Structural/business-rule validation failure → `{ code: 'validation' }`
   *    with the full issue list.
   *  - `OptimisticLockError` (stale `expectedVersionId`) → `{ code: 'conflict' }`
   *    with both etags.
   *  - `HclSurgeonError` with `reason: 'invalid-name'` or `'duplicate-name'`
   *    (the proposed name is malformed, or already exists in `game_servers`) →
   *    `{ code: 'validation' }` with a single `path: 'name'` issue.
   *  - `HclSurgeonError` with `reason: 'structural'` (e.g. the `game_servers`
   *    map itself can't be located in the source HCL) → the catch-all
   *    `{ code: 'error' }`, since it isn't a name problem at all.
   */
  async createGame(payload: CreateGamePayload): Promise<GameWriteResult> {
    const siblings = await this.tfvars.getGameServers();
    const validation = validateGameServer(payload.name, payload.config, siblings);
    if (!validation.success) {
      return { ok: false, code: 'validation', issues: validation.issues };
    }

    const { name, ...config } = validation.data;
    try {
      await this.tfvars.addGameServer(name, config, payload.expectedVersionId);
    } catch (err) {
      if (err instanceof OptimisticLockError) {
        return this.conflictResult(err);
      }
      if (err instanceof HclSurgeonError && (err.reason === 'invalid-name' || err.reason === 'duplicate-name')) {
        return { ok: false, code: 'validation', issues: [{ path: 'name', message: err.message }] };
      }
      return this.errorResult(err);
    }

    return this.successResult('create', name, validation.data);
  }

  /**
   * Replaces an existing `game_servers` entry's value in place. Validates
   * `payload.config` via `validateGameServer()` against every declared game
   * (the entry being edited is skipped for self-collisions by
   * `validateGameServer()` itself), then delegates to
   * `TfvarsService.updateGameServer()`.
   *
   * Failure mapping:
   *  - Structural/business-rule validation failure → `{ code: 'validation' }`
   *    with the full issue list.
   *  - `OptimisticLockError` (stale `expectedVersionId`) → `{ code: 'conflict' }`
   *    with both etags.
   *  - `HclSurgeonError` (`payload.name` doesn't exist in `game_servers`) →
   *    `{ code: 'not_found' }`.
   */
  async updateGame(payload: UpdateGamePayload): Promise<GameWriteResult> {
    const siblings = await this.tfvars.getGameServers();
    const validation = validateGameServer(payload.name, payload.config, siblings);
    if (!validation.success) {
      return { ok: false, code: 'validation', issues: validation.issues };
    }

    const { name, ...config } = validation.data;
    try {
      await this.tfvars.updateGameServer(name, config, payload.expectedVersionId);
    } catch (err) {
      if (err instanceof OptimisticLockError) {
        return this.conflictResult(err);
      }
      if (err instanceof HclSurgeonError) {
        return { ok: false, code: 'not_found', message: err.message };
      }
      return this.errorResult(err);
    }

    return this.successResult('update', name, validation.data);
  }

  /**
   * Removes a `game_servers` entry. Skips `validateGameServer()` entirely —
   * there's no proposed config to validate — and delegates straight to
   * `TfvarsService.removeGameServer()`.
   *
   * Failure mapping:
   *  - `OptimisticLockError` (stale `expectedVersionId`) → `{ code: 'conflict' }`
   *    with both etags.
   *  - `HclSurgeonError` (`payload.name` doesn't exist in `game_servers`) →
   *    `{ code: 'not_found' }`.
   */
  async deleteGame(payload: DeleteGamePayload): Promise<GameWriteResult> {
    try {
      await this.tfvars.removeGameServer(payload.name, payload.expectedVersionId);
    } catch (err) {
      if (err instanceof OptimisticLockError) {
        return this.conflictResult(err);
      }
      if (err instanceof HclSurgeonError) {
        return { ok: false, code: 'not_found', message: err.message };
      }
      return this.errorResult(err);
    }

    return this.successResult('delete', payload.name);
  }

  /**
   * Shared success path for all three operations: invalidates both the
   * `TfvarsService` and `ConfigService` caches so the next read reflects the
   * write, emits a structured audit log entry (action, game name, and
   * whether the write went to the S3 tfvars backend or the local file — see
   * `ConfigService.getTfvarsBucket()`), and builds the refreshed
   * `mergeGameLists()` list. `game` is omitted for `'delete'`, matching
   * `GameWriteSuccess.game`'s "omitted for a delete" contract — `name` is
   * passed separately so the audit entry still records which game was
   * affected even when there's no `game` object to pull it from.
   */
  private async successResult(action: GameWriteAction, name: string, game?: GameServer): Promise<GameWriteResult> {
    this.tfvars.invalidateCache();
    this.config.invalidateCache();

    logger.info('Game server write', {
      action,
      game: name,
      mode: this.config.getTfvarsBucket() ? 's3' : 'local',
    });

    const declared = await this.tfvars.getGameServers();
    const outputs = this.config.getTfOutputs();
    const games = mergeGameLists(declared, outputs?.game_names ?? []);

    return { ok: true, game, games };
  }

  /** Builds a `GameWriteConflict` from a caught {@link OptimisticLockError}, forwarding both etags. */
  private conflictResult(err: OptimisticLockError): GameWriteResult {
    return {
      ok: false,
      code: 'conflict',
      expectedVersionId: err.expectedEtag,
      currentVersionId: err.currentEtag,
      message: err.message,
    };
  }

  /**
   * Builds the catch-all `GameWriteFailure` for any error that isn't a
   * conflict/validation/not-found (e.g. filesystem I/O). Logs the original
   * error server-side but returns a stable, generic message to the caller —
   * the raw error can contain filesystem paths or other infra details that
   * shouldn't be forwarded verbatim as an HTTP 500 body.
   */
  private errorResult(err: unknown): GameWriteResult {
    logger.error('Game server write failed', { err });
    return { ok: false, code: 'error', message: 'An unexpected error occurred while writing the game server configuration' };
  }
}
