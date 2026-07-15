/**
 * Comment/heredoc/string-aware HCL text splicing for a single named entry
 * inside a top-level `map(object({...}))` variable assignment (e.g.
 * `game_servers = { palworld = {...}, valheim = {...} }`) in a `.tfvars`
 * file — see issue #96.
 *
 * `TfvarsService`'s read path goes through `@cdktf/hcl2json`, which
 * round-trips HCL through a JSON AST and loses comments, heredocs, and
 * formatting. Writing back a mutated entry can't go through that path
 * without corrupting the rest of the file, so this module instead operates
 * directly on the raw HCL text: it locates the byte span of one map entry
 * (`entryKey = <value>`) using a small hand-rolled lexer that understands
 * just enough HCL to correctly skip over `#`/`//` line comments, block
 * comments, quoted strings (including `${...}` interpolation), and
 * `<<IDENT` / `<<-IDENT` heredocs — all of which can legally contain
 * brace-like characters that would otherwise throw off naive bracket
 * counting — without ever re-serializing anything. Every byte outside the
 * located span is therefore guaranteed to be preserved verbatim, including
 * comments, heredoc bodies, and unrelated top-level variables.
 *
 * This module is intentionally low-level: it only *locates*, *cuts*, and
 * *replaces* a single entry's value. Higher-level operations (`addGameServer`,
 * `updateGameServer`, `removeGameServer`, HCL value serialization for a
 * `GameServer` object) are out of scope here and belong in `TfvarsService`.
 */

/**
 * Categorizes why a {@link HclSurgeonError} was thrown, so callers (e.g.
 * `GamesWriteService.createGame()`) can distinguish a name-specific failure
 * from a structural one instead of collapsing every `HclSurgeonError` into
 * the same result shape:
 *  - `'invalid-name'` — the proposed entry key isn't a valid bare HCL
 *    identifier.
 *  - `'duplicate-name'` — the proposed entry key already exists in the map.
 *  - `'structural'` — everything else: the map/entry couldn't be located, or
 *    the source HCL itself is malformed (unterminated bracket/string/heredoc).
 */
export type HclSurgeonErrorReason = 'invalid-name' | 'duplicate-name' | 'structural';

/** Thrown when the requested map/entry can't be located or the source HCL is malformed (unterminated bracket/string/heredoc). See {@link HclSurgeonErrorReason} for the `reason` this carries. */
export class HclSurgeonError extends Error {
  /** Why this error was thrown — see {@link HclSurgeonErrorReason}. Defaults to `'structural'` for call sites that don't have a more specific reason to report. */
  readonly reason: HclSurgeonErrorReason;

  constructor(message: string, reason: HclSurgeonErrorReason = 'structural') {
    super(message);
    this.reason = reason;
  }
}

/**
 * Byte span of a single `entryKey = <value>` assignment inside a map's
 * `{ ... }` body, as located by {@link locateEntry}.
 */
export interface HclEntrySpan {
  /**
   * Start of the *entry*: the beginning of the line containing the entry's
   * key (includes the key's own leading indentation). Comments and blank
   * lines preceding the entry are *not* included — they belong to whatever
   * precedes the entry and are left untouched by {@link cutEntry}.
   */
  start: number;
  /**
   * End of the *entry*: immediately after the value, plus a trailing comma
   * if the source uses one. Does not include the line's trailing newline
   * (that's consumed separately by {@link cutEntry} so a removed entry
   * doesn't leave a blank line behind).
   */
  end: number;
  /** Start of just the value expression (e.g. the `{` of an object literal). */
  valueStart: number;
  /** End of just the value expression, excluding a trailing comma. */
  valueEnd: number;
}

/**
 * If `text[i]` begins a comment, quoted string, or heredoc, returns the
 * index to resume scanning from (past that construct). Otherwise returns
 * `null`, meaning the caller should handle `text[i]` itself. Shared by every
 * scanning function in this module so comment/string/heredoc skipping stays
 * consistent everywhere.
 */
function skipLexicalToken(text: string, i: number): number | null {
  const ch = text[i];
  if (ch === '#') return skipLineComment(text, i);
  if (ch === '/' && text[i + 1] === '/') return skipLineComment(text, i);
  if (ch === '/' && text[i + 1] === '*') return skipBlockComment(text, i);
  if (ch === '"') return skipString(text, i);
  if (ch === '<' && text[i + 1] === '<') return skipHeredoc(text, i);
  return null;
}

/** Returns the index of the newline terminating the `#`/`//` comment starting at `start` (or `text.length` if the file ends first). The newline itself is left for the caller to consume. */
function skipLineComment(text: string, start: number): number {
  const nl = text.indexOf('\n', start);
  return nl === -1 ? text.length : nl;
}

/** Returns the index just past the end of the block comment starting at `start` (or `text.length` if unterminated). */
function skipBlockComment(text: string, start: number): number {
  const end = text.indexOf('*/', start + 2);
  return end === -1 ? text.length : end + 2;
}

/**
 * Returns the index just past the closing `"` of the quoted string starting
 * at `start`, honoring backslash escapes and skipping over balanced
 * `${ ... }` template interpolations (which may themselves contain nested
 * strings/braces) rather than treating their contents as plain string text.
 */
function skipString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    if (ch === '$' && text[i + 1] === '{') {
      i = findMatchingClose(text, i + 1) + 1;
      continue;
    }
    i++;
  }
  return i;
}

/**
 * Returns the index of the newline that terminates the heredoc's closing
 * marker line for the `<<IDENT` / `<<-IDENT` heredoc starting at `start`
 * (or `text.length` if the file ends before a closing marker is found).
 * Honors the `<<-` variant's rule that the closing marker line may be
 * indented; the plain `<<` variant requires the marker at column 0.
 */
function skipHeredoc(text: string, start: number): number {
  let j = start + 2;
  let indented = false;
  if (text[j] === '-') {
    indented = true;
    j++;
  }
  const markerMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(j));
  if (!markerMatch) return j; // Malformed heredoc introducer; bail out conservatively.
  const marker = markerMatch[0];
  j += marker.length;

  const firstBodyLine = text.indexOf('\n', j);
  if (firstBodyLine === -1) return text.length;

  const closeRegex = indented ? new RegExp(`^[ \\t]*${marker}\\s*$`) : new RegExp(`^${marker}\\s*$`);
  let pos = firstBodyLine + 1;
  while (pos <= text.length) {
    const nextNewline = text.indexOf('\n', pos);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    if (closeRegex.test(text.slice(pos, lineEnd))) {
      return lineEnd;
    }
    if (nextNewline === -1) return text.length;
    pos = nextNewline + 1;
  }
  return text.length;
}

/** Skips runs of plain whitespace and comments, returning the index of the next significant character (or `text.length`). */
function skipWhitespaceAndComments(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === '#' || (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*'))) {
      i = skipLexicalToken(text, i) ?? i + 1;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Given `text[openIndex]` is one of `{`, `[`, `(`, returns the index of its
 * matching close bracket, correctly skipping over nested brackets as well
 * as any comments/strings/heredocs encountered along the way. Throws
 * {@link HclSurgeonError} if the source is malformed (mismatched or
 * unterminated bracket).
 */
function findMatchingClose(text: string, openIndex: number): number {
  const open = text[openIndex];
  const expectedClose = open === '{' ? '}' : open === '[' ? ']' : open === '(' ? ')' : null;
  if (!expectedClose) {
    throw new HclSurgeonError(`findMatchingClose called on non-bracket character "${open}" at offset ${openIndex}.`);
  }

  let i = openIndex + 1;
  let depth = 1;
  while (i < text.length) {
    const skipped = skipLexicalToken(text, i);
    if (skipped !== null) {
      i = skipped;
      continue;
    }
    const ch = text[i];
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) {
        if (ch !== expectedClose) {
          throw new HclSurgeonError(
            `Mismatched closing bracket "${ch}" for "${open}" opened at offset ${openIndex} (found at offset ${i}).`,
          );
        }
        return i;
      }
      i++;
      continue;
    }
    i++;
  }
  throw new HclSurgeonError(`Unterminated "${open}" opened at offset ${openIndex} — no matching "${expectedClose}" found.`);
}

/**
 * Scans a top-level `key = <value>` assignment's value, starting at
 * `start`, and returns the index right after it ends: either a `,` at the
 * assignment's own nesting depth, a newline at that depth, or the closing
 * bracket of whatever encloses it — whichever comes first. Nested
 * brackets/comments/strings/heredocs are all skipped correctly along the
 * way so this works for scalar, object, list, and expression values alike.
 */
function skipValue(text: string, start: number): number {
  let i = start;
  let depth = 0;
  while (i < text.length) {
    const skipped = skipLexicalToken(text, i);
    if (skipped !== null) {
      i = skipped;
      continue;
    }
    const ch = text[i];
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && ch === ',') return i;
    if (depth === 0 && ch === '\n') {
      return i > start && text[i - 1] === '\r' ? i - 1 : i;
    }
    i++;
  }
  return i;
}

/**
 * Scans the whole file for a `name = { ... }` assignment whose `name`
 * identifier appears at bracket depth 0 (i.e. it's a genuine top-level
 * `.tfvars` variable, not a same-named nested attribute), and returns the
 * index of the `name` identifier's first character. Returns `null` if no
 * such top-level assignment exists.
 */
function findTopLevelIdentifier(text: string, name: string): number | null {
  let i = 0;
  let depth = 0;
  while (i < text.length) {
    const skipped = skipLexicalToken(text, i);
    if (skipped !== null) {
      i = skipped;
      continue;
    }
    const ch = text[i];
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(i));
      const ident = match ? match[0] : ch;
      if (ident === name) {
        const after = skipWhitespaceAndComments(text, i + ident.length);
        if (text[after] === '=' && text[after + 1] !== '=') {
          return i;
        }
      }
      i += ident.length;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    i++;
  }
  return null;
}

/**
 * Scans a map's `{ ... }` body — `[bodyStart, bodyEnd)`, where `bodyEnd` is
 * the index of the map's own closing `}` — for a `entryKey = <value>`
 * assignment, returning its {@link HclEntrySpan}. Returns `null` if no such
 * key exists directly in the map (nested maps aren't searched).
 */
function findEntryInBody(text: string, bodyStart: number, bodyEnd: number, entryKey: string): HclEntrySpan | null {
  let i = bodyStart;
  while (i < bodyEnd) {
    i = skipWhitespaceAndComments(text, i);
    if (i >= bodyEnd) break;

    const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(i, bodyEnd));
    if (!match) {
      i++;
      continue;
    }
    const keyStart = i;
    const key = match[0];

    const afterKey = skipWhitespaceAndComments(text, i + key.length);
    if (text[afterKey] !== '=' || text[afterKey + 1] === '=') {
      // Not a `key = value` pair — shouldn't happen in a well-formed map;
      // skip past this token defensively rather than looping forever.
      i = afterKey + 1;
      continue;
    }

    const valueStart = skipWhitespaceAndComments(text, afterKey + 1);
    const valueEnd = skipValue(text, valueStart);
    let entryEnd = valueEnd;
    if (text[entryEnd] === ',') entryEnd += 1;

    if (key === entryKey) {
      const priorNewline = Math.max(text.lastIndexOf('\n', keyStart - 1), bodyStart - 1);
      return { start: Math.max(bodyStart, priorNewline + 1), end: entryEnd, valueStart, valueEnd };
    }

    i = entryEnd;
  }
  return null;
}

/**
 * Byte span of a top-level `mapVariable = { ... }` object literal's body, as
 * located by {@link locateMapBody}.
 */
export interface HclMapBodySpan {
  /** Index just past the map's opening `{`. */
  bodyStart: number;
  /** Index of the map's own closing `}`. */
  bodyEnd: number;
}

/**
 * Locates the byte span of a top-level `mapVariable = { ... }` object
 * literal's body — `[bodyStart, bodyEnd)`, where `bodyStart` is just after
 * the opening `{` and `bodyEnd` is the index of the map's own closing `}`.
 * Unlike {@link locateEntry}, this doesn't require any particular entry key
 * to already be present — `TfvarsService.addGameServer()` uses it to find
 * where to splice in a brand-new entry (as the map's first entry, right
 * after `bodyStart`) even when the map is empty. Returns `null` when
 * `mapVariable` isn't found at the top level or isn't assigned an object
 * literal.
 */
export function locateMapBody(hcl: string, mapVariable: string): HclMapBodySpan | null {
  const nameStart = findTopLevelIdentifier(hcl, mapVariable);
  if (nameStart === null) return null;

  let j = skipWhitespaceAndComments(hcl, nameStart + mapVariable.length);
  if (hcl[j] !== '=') return null;
  j = skipWhitespaceAndComments(hcl, j + 1);
  if (hcl[j] !== '{') return null;

  const mapClose = findMatchingClose(hcl, j);
  return { bodyStart: j + 1, bodyEnd: mapClose };
}

/**
 * Locates the byte span of `entryKey`'s `key = <value>` assignment inside
 * the top-level `mapVariable = { ... }` object literal in `hcl`. Returns
 * `null` when `mapVariable` isn't found, isn't assigned an object literal,
 * or doesn't contain `entryKey` directly.
 */
export function locateEntry(hcl: string, mapVariable: string, entryKey: string): HclEntrySpan | null {
  const mapBody = locateMapBody(hcl, mapVariable);
  if (!mapBody) return null;

  return findEntryInBody(hcl, mapBody.bodyStart, mapBody.bodyEnd, entryKey);
}

/**
 * Returns `hcl` with `entryKey`'s entire `key = <value>` assignment removed
 * from `mapVariable`'s object literal (along with a trailing comma and the
 * entry's own line-ending newline, so the removal doesn't leave a blank
 * line behind). Every byte outside the removed span — including comments,
 * heredocs, and other top-level variables — is preserved verbatim. Throws
 * {@link HclSurgeonError} if the entry can't be located.
 */
export function cutEntry(hcl: string, mapVariable: string, entryKey: string): string {
  const span = locateEntry(hcl, mapVariable, entryKey);
  if (!span) {
    throw new HclSurgeonError(`Entry "${entryKey}" not found in "${mapVariable}".`);
  }

  let end = span.end;
  if (hcl[end] === '\r') end++;
  if (hcl[end] === '\n') end++;

  return hcl.slice(0, span.start) + hcl.slice(end);
}

/**
 * Returns `hcl` with `entryKey`'s value replaced by `newValueHcl` (the
 * `entryKey = ` prefix, any trailing comma, and everything else in the file
 * is preserved verbatim). Throws {@link HclSurgeonError} if the entry can't
 * be located.
 */
export function replaceEntry(hcl: string, mapVariable: string, entryKey: string, newValueHcl: string): string {
  const span = locateEntry(hcl, mapVariable, entryKey);
  if (!span) {
    throw new HclSurgeonError(`Entry "${entryKey}" not found in "${mapVariable}".`);
  }

  return hcl.slice(0, span.valueStart) + newValueHcl + hcl.slice(span.valueEnd);
}
