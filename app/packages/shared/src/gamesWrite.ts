/**
 * Request payload and result types shared between the desktop-main
 * `games.create` / `games.update` / `games.delete` IPC handlers (and their
 * HTTP equivalents) and the web client. Keeping these here — rather than in
 * `desktop-main` or `web` — means both sides of the wire agree on the exact
 * discriminated union without either package importing the other.
 */

import type { GameServer, GameListEntry } from './tfvars.js';
import type { GameServerValidationIssue } from './gameServerValidator.js';

/**
 * Successful create/update/delete. `game` is the affected entry's
 * post-write config (omitted for a delete); `games` is the full, freshly
 * merged games list so callers can refresh their view without a second
 * round trip.
 */
export interface GameWriteSuccess {
  ok: true;
  game?: GameServer;
  games: GameListEntry[];
}

/**
 * The write was rejected because the caller's `expectedVersionId` didn't
 * match the current tfvars file version — someone else edited
 * `terraform.tfvars` since the caller last read it. `currentVersionId` lets
 * the caller re-fetch and retry.
 */
export interface GameWriteConflict {
  ok: false;
  code: 'conflict';
  expectedVersionId?: string;
  currentVersionId?: string;
  message: string;
}

/** The proposed `game_servers` entry failed {@link GameServerValidationIssue}-shaped structural or business-rule validation. */
export interface GameWriteValidationFailure {
  ok: false;
  code: 'validation';
  issues: GameServerValidationIssue[];
}

/** The named game does not exist (e.g. update/delete targeting an undeclared game). */
export interface GameWriteNotFound {
  ok: false;
  code: 'not_found';
  message: string;
}

/** Catch-all failure for errors that aren't a conflict, validation failure, or not-found (e.g. filesystem I/O). */
export interface GameWriteFailure {
  ok: false;
  code: 'error';
  message: string;
}

/**
 * Discriminated union returned by the `games.create` / `games.update` /
 * `games.delete` handlers. Discriminate on `ok` first, then `code` for the
 * failure branches.
 */
export type GameWriteResult =
  | GameWriteSuccess
  | GameWriteConflict
  | GameWriteValidationFailure
  | GameWriteNotFound
  | GameWriteFailure;

/**
 * Request payload for `games.create`. `expectedVersionId`, when supplied,
 * is checked against the current tfvars file version and a
 * {@link GameWriteConflict} is returned on mismatch.
 */
export interface CreateGamePayload {
  name: string;
  config: Omit<GameServer, 'name'>;
  expectedVersionId?: string;
}

/**
 * Request payload for `games.update`. Same shape as {@link CreateGamePayload}
 * — `name` identifies the existing game to overwrite with `config`.
 */
export interface UpdateGamePayload {
  name: string;
  config: Omit<GameServer, 'name'>;
  expectedVersionId?: string;
}

/** Request payload for `games.delete`. */
export interface DeleteGamePayload {
  name: string;
  expectedVersionId?: string;
}
