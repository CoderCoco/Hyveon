/**
 * Serializes a single `GameServer` entry into a Terraform (HCL2) attribute
 * assignment of the form `<name> = { ... }`, suitable for splicing into the
 * `game_servers` map in `terraform.tfvars` (see issue #96 — the AST-mutation
 * logic that actually splices this text into the surrounding file is a
 * separate task; this module is a pure `GameServer -> string` formatter with
 * no knowledge of the surrounding file).
 *
 * The emitted text is a syntactically complete, independently-parseable HCL
 * fragment: parsing it on its own via `@cdktf/hcl2json`'s `parse()` and
 * taking `result[entry.name]` reproduces every field of `entry` (minus
 * `name` itself, which is the map key rather than an object attribute —
 * mirroring `TfvarsService.parseGameServers()`'s flattening in reverse).
 */
import type {
  GameServer,
  GameServerEnvironmentVariable,
  GameServerFileSeed,
  GameServerPort,
  GameServerVolume,
} from '@hyveon/shared';

/** Indentation unit used for every nesting level in the emitted block. */
const INDENT = '  ';

/**
 * Quotes and escapes a string for use as an HCL2 string literal. Handles the
 * escape sequences HCL2's quoted-string grammar recognises (backslash,
 * double quote, and the common whitespace controls) plus the two sequences
 * that would otherwise be parsed as template interpolation (`${...}`) or a
 * template directive (`%{...}`) — escaping them as `$${` / `%%{` keeps the
 * literal text intact instead of triggering HCL's template engine.
 *
 * Escaping embedded newlines as `\n` (rather than emitting a heredoc) is
 * what lets `file_seeds[].content` carry arbitrary multiline text through a
 * single quoted-string attribute — HCL2 quoted strings can't contain a raw
 * newline, but the `\n` escape round-trips through `@cdktf/hcl2json` back to
 * a real newline character.
 */
function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\$\{/g, () => '$${')
    .replace(/%\{/g, () => '%%{');
  return `"${escaped}"`;
}

/** Emits a `{ container = 8211, protocol = "udp" }` single-line object. */
function emitPort(port: GameServerPort): string {
  return `{ container = ${port.container}, protocol = ${quote(port.protocol)} }`;
}

/** Emits a `{ name = "PLAYERS", value = "16" }` single-line object. */
function emitEnvironmentVariable(env: GameServerEnvironmentVariable): string {
  return `{ name = ${quote(env.name)}, value = ${quote(env.value)} }`;
}

/** Emits a `{ name = "saves", container_path = "/palworld" }` single-line object. */
function emitVolume(volume: GameServerVolume): string {
  return `{ name = ${quote(volume.name)}, container_path = ${quote(volume.container_path)} }`;
}

/**
 * Emits a bracketed list of single-line inline objects (used for `ports`,
 * `environment`, and `volumes`), one element per line at `indent`, or `[]`
 * when `items` is empty.
 */
function emitInlineList<T>(items: T[], format: (item: T) => string, indent: string): string {
  if (items.length === 0) {
    return '[]';
  }
  const body = items.map((item) => `${indent}${INDENT}${format(item)},`).join('\n');
  return `[\n${body}\n${indent}]`;
}

/**
 * Emits `file_seeds` as one expanded block per entry (rather than the
 * single-line style used for ports/environment/volumes) so long or
 * multiline `content`/`content_base64` values stay on their own attribute
 * line instead of producing an unreadably long inline object. Optional
 * `content` / `content_base64` / `mode` attributes are only emitted when
 * present, so the round-tripped object doesn't gain spurious keys.
 */
function emitFileSeeds(fileSeeds: GameServerFileSeed[], indent: string): string {
  if (fileSeeds.length === 0) {
    return '[]';
  }
  const inner = indent + INDENT;
  const attrIndent = inner + INDENT;
  const blocks = fileSeeds.map((seed) => {
    const attrs: string[] = [`path = ${quote(seed.path)}`];
    if (seed.content !== undefined) {
      attrs.push(`content = ${quote(seed.content)}`);
    }
    if (seed.content_base64 !== undefined) {
      attrs.push(`content_base64 = ${quote(seed.content_base64)}`);
    }
    if (seed.mode !== undefined) {
      attrs.push(`mode = ${quote(seed.mode)}`);
    }
    const attrLines = attrs.map((attr) => `${attrIndent}${attr}`).join('\n');
    return `${inner}{\n${attrLines}\n${inner}}`;
  });
  return `[\n${blocks.join(',\n')},\n${indent}]`;
}

/**
 * Serializes `entry` into a standalone `<name> = { ... }` HCL2 attribute
 * assignment. Optional fields (`environment`, `https`, `connect_message`,
 * `file_seeds`) are only emitted when defined on `entry`, so parsing the
 * result back doesn't introduce keys the input didn't have. See the
 * file-level doc comment for the full round-trip contract.
 */
export function emitGameServerEntry(entry: GameServer): string {
  const indent = INDENT;
  const lines: string[] = [`${entry.name} = {`];

  lines.push(`${indent}image  = ${quote(entry.image)}`);
  lines.push(`${indent}cpu    = ${entry.cpu}`);
  lines.push(`${indent}memory = ${entry.memory}`);
  lines.push(`${indent}ports = ${emitInlineList(entry.ports, emitPort, indent)}`);

  if (entry.environment !== undefined) {
    lines.push(`${indent}environment = ${emitInlineList(entry.environment, emitEnvironmentVariable, indent)}`);
  }

  lines.push(`${indent}volumes = ${emitInlineList(entry.volumes, emitVolume, indent)}`);

  if (entry.https !== undefined) {
    lines.push(`${indent}https = ${entry.https}`);
  }

  if (entry.connect_message !== undefined) {
    lines.push(`${indent}connect_message = ${quote(entry.connect_message)}`);
  }

  if (entry.file_seeds !== undefined) {
    lines.push(`${indent}file_seeds = ${emitFileSeeds(entry.file_seeds, indent)}`);
  }

  lines.push('}');
  return lines.join('\n') + '\n';
}
