/**
 * Zod-backed structural schema + business-rule validator for a single
 * `game_servers` map entry (see `terraform/variables.tf:game_servers` and
 * the {@link GameServer} mirror in `./tfvars.js`).
 *
 * This module is deliberately split in two:
 *  - {@link gameServerSchema} mirrors the Terraform `game_servers` object
 *    type field-for-field (it does NOT include `name` — like the Terraform
 *    object, `name` is the map key, not an attribute of the entry).
 *  - {@link validateGameServer} layers the four custom business rules that
 *    can't be expressed as a pure per-field zod refinement because they
 *    either need the sibling `game_servers` entries (port collisions) or
 *    are cross-cutting checks over the already-typed entry (Fargate
 *    CPU/memory pairing, absolute paths, connect-message placeholders).
 *
 * Intended for both the desktop-main API (validating a proposed tfvars edit
 * before writing it back) and the web client (surfacing the same messages
 * in a form).
 */

import { z } from 'zod';
import type { GameServer, GameServerPort } from './tfvars.js';

/** Zod schema mirroring {@link GameServerPort}. */
export const gameServerPortSchema = z.object({
  container: z.number(),
  protocol: z.string(),
});

/** Zod schema mirroring `GameServerEnvironmentVariable`. */
export const gameServerEnvironmentVariableSchema = z.object({
  name: z.string(),
  value: z.string(),
});

/**
 * Zod schema mirroring `GameServerVolume`. `name` and `container_path` must
 * be non-empty, matching the Terraform validation block on
 * `game_servers` (`terraform/variables.tf`).
 */
export const gameServerVolumeSchema = z.object({
  name: z.string().min(1, 'volumes[].name must not be empty.'),
  container_path: z.string().min(1, 'volumes[].container_path must not be empty.'),
});

/** Zod schema mirroring `GameServerFileSeed`. */
export const gameServerFileSeedSchema = z.object({
  path: z.string(),
  content: z.string().optional(),
  content_base64: z.string().optional(),
  mode: z.string().optional(),
});

/**
 * Zod schema mirroring {@link GameServer} field-for-field, minus `name`
 * (which is the `game_servers` map key, not a Terraform object attribute —
 * see {@link GameServer}'s own doc comment). Enforces only structural/shape
 * rules; the four business rules (Fargate CPU/memory pairing, absolute
 * paths, connect-message placeholders, port collisions) live in
 * {@link validateGameServer} instead, since some of them need sibling
 * `game_servers` entries that a single-entry schema can't see.
 */
export const gameServerSchema = z.object({
  image: z.string(),
  cpu: z.number(),
  memory: z.number(),
  ports: z.array(gameServerPortSchema),
  environment: z.array(gameServerEnvironmentVariableSchema).optional(),
  volumes: z
    .array(gameServerVolumeSchema)
    .min(1, 'Each game server must have at least one volume entry with non-empty name and container_path.'),
  https: z.boolean().optional(),
  connect_message: z.string().optional(),
  file_seeds: z.array(gameServerFileSeedSchema).optional(),
});

/** Structural (name-less) shape validated by {@link gameServerSchema}. */
export type GameServerEntryInput = z.infer<typeof gameServerSchema>;

/**
 * A single validation failure, positioned with a JSON-path-like string
 * (e.g. `volumes[0].container_path`, `ports[1]`, `memory`) so callers can
 * highlight the offending field in a form. Built either from a zod issue's
 * `path` array or from one of the custom business-rule checks below.
 */
export interface GameServerValidationIssue {
  path: string;
  message: string;
}

/** Result of {@link validateGameServer}: either the fully-typed entry, or every issue found. */
export type GameServerValidationResult =
  | { success: true; data: GameServer }
  | { success: false; issues: GameServerValidationIssue[] };

/** Joins a zod issue path (`(string | number)[]`) into a JSON-path-like string, e.g. `['volumes', 0, 'container_path']` → `volumes[0].container_path`. */
function formatPath(path: (string | number)[]): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') {
      return `${acc}[${segment}]`;
    }
    return acc.length > 0 ? `${acc}.${segment}` : segment;
  }, '');
}

/** Converts a raw zod issue into a {@link GameServerValidationIssue}. */
function zodIssueToValidationIssue(issue: z.ZodIssue): GameServerValidationIssue {
  return { path: formatPath(issue.path), message: issue.message };
}

/**
 * The current Fargate CPU → valid memory (MiB) table. `256` only accepts
 * three discrete values; every other tier accepts a stepped range. Source:
 * AWS Fargate task size documentation, mirrored here so tfvars edits are
 * rejected client-side before a `terraform apply` would fail.
 */
const FARGATE_CPU_MEMORY_TABLE: Readonly<
  Record<number, { values: number[] } | { min: number; max: number; step: number }>
> = {
  256: { values: [512, 1024, 2048] },
  512: { min: 1024, max: 4096, step: 1024 },
  1024: { min: 2048, max: 8192, step: 1024 },
  2048: { min: 4096, max: 16384, step: 1024 },
  4096: { min: 8192, max: 30720, step: 1024 },
  8192: { min: 16384, max: 61440, step: 4096 },
  16384: { min: 32768, max: 122880, step: 8192 },
};

/** Human-readable description of the valid memory values/range for a given Fargate `cpu` tier. */
function describeFargateMemoryOptions(cpu: number): string {
  const range = FARGATE_CPU_MEMORY_TABLE[cpu];
  if (!range) {
    return '';
  }
  if ('values' in range) {
    return `${range.values.join(', ')} MiB`;
  }
  return `${range.min}-${range.max} MiB in steps of ${range.step}`;
}

/** Validates the `cpu`/`memory` pairing against the Fargate task-size table. */
function checkFargateCpuMemoryPairing(entry: GameServerEntryInput): GameServerValidationIssue[] {
  const range = FARGATE_CPU_MEMORY_TABLE[entry.cpu];
  if (!range) {
    return [
      {
        path: 'cpu',
        message: `cpu must be one of the supported Fargate CPU units (${Object.keys(FARGATE_CPU_MEMORY_TABLE).join(', ')}), got ${entry.cpu}.`,
      },
    ];
  }

  const isValidMemory =
    'values' in range
      ? range.values.includes(entry.memory)
      : entry.memory >= range.min && entry.memory <= range.max && (entry.memory - range.min) % range.step === 0;

  if (!isValidMemory) {
    return [
      {
        path: 'memory',
        message: `memory ${entry.memory} MiB is not a valid Fargate pairing for cpu=${entry.cpu}; must be ${describeFargateMemoryOptions(entry.cpu)}.`,
      },
    ];
  }

  return [];
}

/** Validates that `volumes[].container_path` and `file_seeds[].path` are absolute (start with `/`). */
function checkAbsolutePaths(entry: GameServerEntryInput): GameServerValidationIssue[] {
  const issues: GameServerValidationIssue[] = [];

  entry.volumes.forEach((volume, index) => {
    if (!volume.container_path.startsWith('/')) {
      issues.push({
        path: `volumes[${index}].container_path`,
        message: `volumes[${index}].container_path must be an absolute path (start with "/"), got "${volume.container_path}".`,
      });
    }
  });

  entry.file_seeds?.forEach((seed, index) => {
    if (!seed.path.startsWith('/')) {
      issues.push({
        path: `file_seeds[${index}].path`,
        message: `file_seeds[${index}].path must be an absolute path (start with "/"), got "${seed.path}".`,
      });
    }
  });

  return issues;
}

/** Placeholder tokens allowed inside `connect_message`, matching the Terraform variable's doc comment. */
const ALLOWED_CONNECT_MESSAGE_PLACEHOLDERS: ReadonlySet<string> = new Set(['host', 'ip', 'port', 'game']);

/** Matches every `{token}` occurrence in a string, capturing the token itself. */
const PLACEHOLDER_TOKEN_PATTERN = /\{([^{}]*)\}/g;

/** Rejects any `{token}` in `connect_message` outside `{host}`/`{ip}`/`{port}`/`{game}`. */
function checkConnectMessagePlaceholders(entry: GameServerEntryInput): GameServerValidationIssue[] {
  if (!entry.connect_message) {
    return [];
  }

  const issues: GameServerValidationIssue[] = [];
  for (const match of entry.connect_message.matchAll(PLACEHOLDER_TOKEN_PATTERN)) {
    const token = match[1] ?? '';
    if (!ALLOWED_CONNECT_MESSAGE_PLACEHOLDERS.has(token)) {
      issues.push({
        path: 'connect_message',
        message: `Unknown placeholder "{${token}}" in connect_message; allowed placeholders are {host}, {ip}, {port}, {game}.`,
      });
    }
  }
  return issues;
}

/** Builds the collision key (`container/protocol`, case-insensitive on protocol) used to detect port clashes. */
function portKey(port: GameServerPort): string {
  return `${port.container}/${port.protocol.toLowerCase()}`;
}

/**
 * Detects container-port collisions both within the proposed entry's own
 * `ports` list and against every other declared `game_servers` entry (the
 * entry being re-validated, identified by `name`, is skipped so editing an
 * already-declared game doesn't collide with itself).
 */
function checkPortCollisions(
  name: string,
  ports: GameServerPort[],
  existingGameServers: GameServer[],
): GameServerValidationIssue[] {
  const issues: GameServerValidationIssue[] = [];
  const seenWithinEntry = new Map<string, number>();

  ports.forEach((port, index) => {
    const key = portKey(port);

    const firstIndex = seenWithinEntry.get(key);
    if (firstIndex !== undefined) {
      issues.push({
        path: `ports[${index}]`,
        message: `Port ${port.container}/${port.protocol} collides with ports[${firstIndex}] in the same game server.`,
      });
    } else {
      seenWithinEntry.set(key, index);
    }

    for (const existing of existingGameServers) {
      if (existing.name === name) {
        continue;
      }
      if (existing.ports.some((existingPort) => portKey(existingPort) === key)) {
        issues.push({
          path: `ports[${index}]`,
          message: `Port ${port.container}/${port.protocol} collides with existing game "${existing.name}".`,
        });
      }
    }
  });

  return issues;
}

/** Narrows `value` to a plain object so `proposed.ports` can be read without a full parse. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validates a proposed `game_servers` entry: structural shape (via
 * {@link gameServerSchema}) plus all four business rules — Fargate
 * CPU/memory pairing, absolute paths for volumes/file_seeds, connect-message
 * placeholder allowlisting, and container-port collisions (within the
 * entry itself and against every other entry in `existingGameServers`).
 *
 * @param name - The `game_servers` map key this entry would be saved under.
 *   Used to build the returned {@link GameServer} on success, and to skip
 *   self-collisions when `existingGameServers` already contains an entry
 *   being edited in place.
 * @param proposed - The candidate entry, typically untrusted input (e.g.
 *   parsed JSON from an API request body).
 * @param existingGameServers - Every other already-declared `game_servers`
 *   entry (as returned by `TfvarsService.getGameServers()`), used for the
 *   cross-game port-collision check.
 */
export function validateGameServer(
  name: string,
  proposed: unknown,
  existingGameServers: GameServer[],
): GameServerValidationResult {
  const issues: GameServerValidationIssue[] = [];

  const parsed = gameServerSchema.safeParse(proposed);
  if (!parsed.success) {
    issues.push(...parsed.error.issues.map(zodIssueToValidationIssue));
  } else {
    issues.push(...checkFargateCpuMemoryPairing(parsed.data));
    issues.push(...checkAbsolutePaths(parsed.data));
    issues.push(...checkConnectMessagePlaceholders(parsed.data));
  }

  // Port-collision detection only needs `ports` to be structurally valid, so
  // run it independently of whether the rest of the entry parsed cleanly.
  const portsResult = z
    .array(gameServerPortSchema)
    .safeParse(isRecord(proposed) ? proposed['ports'] : undefined);
  if (portsResult.success) {
    issues.push(...checkPortCollisions(name, portsResult.data, existingGameServers));
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  // `parsed.success` is guaranteed true here: any structural failure above
  // would have pushed at least one issue and returned early.
  return { success: true, data: { name, ...(parsed as z.SafeParseSuccess<GameServerEntryInput>).data } };
}
