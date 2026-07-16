/**
 * Draft state shape + per-step validation for the add-game wizard (#99).
 *
 * The wizard walks the operator through five steps — identity, resources,
 * networking, storage, review — that together assemble one `game_servers`
 * entry. Rather than re-implement the business rules already enforced
 * server-side, this module builds a proposed entry from the in-progress
 * {@link WizardDraft} and delegates to {@link validateGameServer} (the same
 * zod schema + business-rule validator used by `GamesWriteService`), then
 * buckets the returned issues back onto the step whose fields they belong
 * to via {@link stepForIssuePath}. This keeps the wizard's validation in
 * lockstep with the server without duplicating the rules.
 */

import {
  validateGameServer,
  checkConnectMessagePlaceholders,
  type GameServerValidationIssue,
} from '@hyveon/shared/gameServerValidator';
import type { CreateGamePayload, GameServer } from '../../api.service.js';

/** Ordered steps of the add-game wizard, matching issue #99's scope. */
export const WIZARD_STEPS = ['identity', 'resources', 'networking', 'storage', 'review'] as const;

/** One step of the add-game wizard. */
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Placeholder name used to validate a draft before the operator has typed one, so the port-collision self-exclusion check never accidentally matches a real existing game. */
const DRAFT_NAME_PLACEHOLDER = '__draft__';

/** Bare HCL identifier pattern a `game_servers` map key must match (mirrors `HCL_IDENTIFIER_PATTERN` in `TfvarsService`) — letters, digits, underscores, and hyphens, not starting with a digit. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Draft form of a single `GameServerPort` row. `container` is `null` until the operator fills in the field, so an empty row can be told apart from a mistyped one. */
export interface WizardDraftPort {
  container: number | null;
  protocol: string;
}

/** Draft form of a single `GameServerVolume` row. */
export interface WizardDraftVolume {
  name: string;
  container_path: string;
}

/** Draft form of a single `GameServerFileSeed` row. Empty strings mean "not set" and are stripped before validation/submit. */
export interface WizardDraftFileSeed {
  path: string;
  content: string;
  content_base64: string;
  mode: string;
}

/**
 * In-progress state of the add-game wizard, covering every field across all
 * five steps. Field names mirror `GameServer` (snake_case) since the draft
 * is converted directly into a proposed entry for {@link validateGameServer}.
 */
export interface WizardDraft {
  name: string;
  image: string;
  connect_message: string;
  cpu: number | null;
  memory: number | null;
  ports: WizardDraftPort[];
  volumes: WizardDraftVolume[];
  file_seeds: WizardDraftFileSeed[];
}

/** Builds a blank {@link WizardDraft} — the wizard's initial state before the operator has entered anything. */
export function createEmptyWizardDraft(): WizardDraft {
  return {
    name: '',
    image: '',
    connect_message: '',
    cpu: null,
    memory: null,
    ports: [],
    volumes: [],
    file_seeds: [],
  };
}

/**
 * Converts a declared {@link GameServer} entry into a {@link WizardDraft} —
 * the inverse of {@link draftToPayload}. Used to seed the wizard's edit flow
 * from an existing entry: optional fields (`connect_message`, `file_seeds`
 * and its per-row `content`/`content_base64`/`mode`) fall back to empty
 * strings since the draft's text inputs can't represent `undefined`.
 */
export function draftFromGameServer(game: GameServer): WizardDraft {
  return {
    name: game.name,
    image: game.image,
    connect_message: game.connect_message ?? '',
    cpu: game.cpu,
    memory: game.memory,
    ports: game.ports.map((port) => ({ container: port.container, protocol: port.protocol })),
    volumes: game.volumes.map((volume) => ({ name: volume.name, container_path: volume.container_path })),
    file_seeds: (game.file_seeds ?? []).map((seed) => ({
      path: seed.path,
      content: seed.content ?? '',
      content_base64: seed.content_base64 ?? '',
      mode: seed.mode ?? '',
    })),
  };
}

/**
 * Converts a completed {@link WizardDraft} into the `POST /api/games`
 * (`games.create` IPC) payload — the inverse of {@link draftFromGameServer}.
 * Only called once the Review step's "Submit" button is enabled, which
 * requires {@link validateStep} to report zero issues for `review` — so
 * `cpu`/`memory`/port `container` values are guaranteed non-null at this
 * point; the `?? 0` fallbacks only guard the type checker, they're never
 * expected to fire in practice.
 */
export function draftToPayload(draft: WizardDraft): CreateGamePayload {
  const name = draft.name.trim();
  const connectMessage = draft.connect_message.trim();
  const image = draft.image.trim();

  return {
    name,
    config: {
      image,
      cpu: draft.cpu ?? 0,
      memory: draft.memory ?? 0,
      ports: draft.ports.map((port) => ({ container: port.container ?? 0, protocol: port.protocol })),
      volumes: draft.volumes.map((volume) => ({ name: volume.name, container_path: volume.container_path })),
      connect_message: connectMessage.length > 0 ? connectMessage : undefined,
      file_seeds:
        draft.file_seeds.length > 0
          ? draft.file_seeds.map((seed) => ({
              path: seed.path,
              content: seed.content.length > 0 ? seed.content : undefined,
              content_base64: seed.content_base64.length > 0 ? seed.content_base64 : undefined,
              mode: seed.mode.length > 0 ? seed.mode : undefined,
            }))
          : undefined,
    },
  };
}

/**
 * Maps a validation issue's `path` (e.g. `volumes[0].container_path`,
 * `ports[1]`, `memory`, `name`) to the wizard step whose fields own it, by
 * looking at the first path segment (the field family). Every top-level
 * field on {@link WizardDraft} is covered: `name`/`image`/`connect_message`
 * → identity, `cpu`/`memory` → resources, `ports` → networking,
 * `volumes`/`file_seeds` → storage. Anything unrecognized falls back to
 * `review` so it's still surfaced somewhere rather than silently dropped.
 */
export function stepForIssuePath(path: string): WizardStep {
  const family = path.split(/[.[]/)[0];
  switch (family) {
    case 'name':
    case 'image':
    case 'connect_message':
      return 'identity';
    case 'cpu':
    case 'memory':
      return 'resources';
    case 'ports':
      return 'networking';
    case 'volumes':
    case 'file_seeds':
      return 'storage';
    default:
      return 'review';
  }
}

/**
 * Validates `name` against the rules `TfvarsService.insertGameServerEntry()`
 * enforces server-side: non-empty, a valid bare HCL identifier, and not
 * already used by another declared game. This lives outside
 * {@link validateGameServer} because that function treats `name` purely as
 * the map key for self-exclusion in the port-collision check, not as a
 * field to validate in its own right.
 */
function checkName(name: string, existingGames: GameServer[]): GameServerValidationIssue[] {
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return [{ path: 'name', message: 'Name is required.' }];
  }

  const issues: GameServerValidationIssue[] = [];

  if (!NAME_PATTERN.test(trimmed)) {
    issues.push({
      path: 'name',
      message:
        'Name must start with a letter or underscore and contain only letters, numbers, underscores, and hyphens.',
    });
  }

  if (existingGames.some((game) => game.name === trimmed)) {
    issues.push({ path: 'name', message: `A game named "${trimmed}" already exists.` });
  }

  return issues;
}

/** Converts a {@link WizardDraft} into the plain-object shape {@link validateGameServer} expects for its `proposed` parameter, stripping unset optional fields so they don't trip type checks with empty strings. */
function toProposedEntry(draft: WizardDraft): Record<string, unknown> {
  return {
    image: draft.image.trim(),
    cpu: draft.cpu,
    memory: draft.memory,
    ports: draft.ports.map((port) => ({ container: port.container, protocol: port.protocol })),
    volumes: draft.volumes.map((volume) => ({ name: volume.name, container_path: volume.container_path })),
    connect_message: draft.connect_message.trim().length > 0 ? draft.connect_message : undefined,
    file_seeds:
      draft.file_seeds.length > 0
        ? draft.file_seeds.map((seed) => ({
            path: seed.path,
            content: seed.content.length > 0 ? seed.content : undefined,
            content_base64: seed.content_base64.length > 0 ? seed.content_base64 : undefined,
            mode: seed.mode.length > 0 ? seed.mode : undefined,
          }))
        : undefined,
  };
}

/**
 * Validates `image` isn't blank. The shared `gameServerSchema` types `image`
 * as a plain `z.string()` with no minimum length (an empty string is a valid
 * server-side value structurally), but a blank image reference is never
 * usable, so the wizard enforces non-emptiness itself.
 */
function checkImage(image: string): GameServerValidationIssue[] {
  if (image.trim().length === 0) {
    return [{ path: 'image', message: 'Image is required.' }];
  }
  return [];
}

/**
 * Validates the entire draft: `name` (via {@link checkName}), `image` (via
 * {@link checkImage}), `connect_message` placeholders (via the shared
 * {@link checkConnectMessagePlaceholders}, imported from
 * `@hyveon/shared/gameServerValidator` and run unconditionally here) plus
 * every structural/business rule {@link validateGameServer} enforces
 * (Fargate cpu/memory pairing, absolute volume/file_seed paths, its own
 * internal call to the same connect_message placeholder check, and port
 * collisions — both within the draft's own `ports` list and against
 * `existingGames`). Returns every issue found, unfiltered by step, deduped
 * by `path`+`message` — this only matters because `validateGameServer`'s
 * failure result isn't limited to structural parse failures: a structurally
 * complete draft can still fail on a pure business-rule violation, and in
 * that case `validateGameServer`'s own connect_message placeholder check
 * already ran, so appending our own call unconditionally on
 * `!result.success` would otherwise double up identical issues.
 */
export function validateWizardDraft(draft: WizardDraft, existingGames: GameServer[]): GameServerValidationIssue[] {
  const issues = [...checkName(draft.name, existingGames), ...checkImage(draft.image)];

  const name = draft.name.trim().length > 0 ? draft.name.trim() : DRAFT_NAME_PLACEHOLDER;
  const result = validateGameServer(name, toProposedEntry(draft), existingGames);
  if (!result.success) {
    issues.push(...result.issues);
    // validateGameServer only runs its own connect_message placeholder check
    // once the full entry parses structurally, so a structural failure here
    // (e.g. cpu/memory still null) means that check may never have run. Run
    // the same shared check so an invalid placeholder is still caught on the
    // Identity step; duplicates against an already-run copy are removed below.
    issues.push(...checkConnectMessagePlaceholders(draft.connect_message));
  }

  return dedupeIssues(issues);
}

/**
 * Removes duplicate issues (same `path` and `message`) while preserving
 * first-seen order. Needed because {@link validateWizardDraft} can surface
 * the same `connect_message` placeholder issue twice: once from
 * `validateGameServer`'s own internal call to the shared
 * {@link checkConnectMessagePlaceholders} (when the structural parse
 * succeeded) and once from the unconditional call above (run on any
 * failure, structural or not).
 */
function dedupeIssues(issues: GameServerValidationIssue[]): GameServerValidationIssue[] {
  const seen = new Set<string>();
  const deduped: GameServerValidationIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.path} ${issue.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(issue);
    }
  }
  return deduped;
}

/**
 * Validates the draft and filters the result down to issues belonging to
 * `step` (via {@link stepForIssuePath}), so a step component only sees — and
 * only blocks advancement on — errors in its own fields.
 */
export function validateStep(
  step: WizardStep,
  draft: WizardDraft,
  existingGames: GameServer[],
): GameServerValidationIssue[] {
  if (step === 'review') {
    return validateWizardDraft(draft, existingGames);
  }
  return validateWizardDraft(draft, existingGames).filter((issue) => stepForIssuePath(issue.path) === step);
}

/** Convenience wrapper: `true` when `step` has no outstanding validation issues, so the wizard can gate its "Next" button. */
export function canAdvance(step: WizardStep, draft: WizardDraft, existingGames: GameServer[]): boolean {
  return validateStep(step, draft, existingGames).length === 0;
}

/** Validates the "Identity" step: `name`, `image`, `connect_message`. */
export function validateIdentityStep(draft: WizardDraft, existingGames: GameServer[]): GameServerValidationIssue[] {
  return validateStep('identity', draft, existingGames);
}

/** Validates the "Resources" step: `cpu`/`memory`, including the Fargate cpu/memory pairing rule. */
export function validateResourcesStep(draft: WizardDraft, existingGames: GameServer[]): GameServerValidationIssue[] {
  return validateStep('resources', draft, existingGames);
}

/** Validates the "Networking" step: `ports`, including collisions within the draft and against `existingGames`. */
export function validateNetworkingStep(draft: WizardDraft, existingGames: GameServer[]): GameServerValidationIssue[] {
  return validateStep('networking', draft, existingGames);
}

/** Validates the "Storage" step: `volumes` (including the at-least-one-volume rule) and `file_seeds`. */
export function validateStorageStep(draft: WizardDraft, existingGames: GameServer[]): GameServerValidationIssue[] {
  return validateStep('storage', draft, existingGames);
}

/** Validates the "Review" step: every issue across the whole draft, since review is the final gate before submit. */
export function validateReviewStep(draft: WizardDraft, existingGames: GameServer[]): GameServerValidationIssue[] {
  return validateStep('review', draft, existingGames);
}
