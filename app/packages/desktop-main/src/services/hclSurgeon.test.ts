/**
 * Unit tests for `hclSurgeon.ts` — the comment/heredoc/string-aware splice
 * engine that locates, cuts, and replaces a single `entryKey = <value>`
 * assignment inside a top-level `mapVariable = { ... }` object literal.
 *
 * The engine's entire reason for existing is that it must never re-serialize
 * anything: every byte outside the located span has to survive verbatim.
 * The `cutEntry`/`replaceEntry` specs below therefore don't just assert on
 * the returned string's *content* — they slice the untouched portions of
 * both the input and the output and assert exact string equality (`toBe`)
 * between them, which is the byte-for-byte guarantee the module promises.
 */
import { describe, it, expect } from 'vitest';
import { HclSurgeonError, locateEntry, cutEntry, replaceEntry } from './hclSurgeon.js';
import type { HclEntrySpan } from './hclSurgeon.js';

/**
 * A literal `$` spliced into the fixture template literals below via
 * `${DOLLAR}{...}` instead of the escape sequence `\${...}`. CodeQL's
 * js/useless-regexp-character-escape query misfires on `\$` inside a
 * template literal (it's meaningful there — it suppresses interpolation —
 * even though the same escape would be a no-op in a plain string or
 * outside a regex character class), so this sidesteps the false positive
 * while producing byte-identical fixture text.
 */
const DOLLAR = '$';

/**
 * A representative `.tfvars`-shaped fixture: a top-level `other_var` before
 * the map, a `game_servers = { ... }` map with three entries (one preceded
 * by a line comment, one whose value contains a brace-laden indented
 * heredoc, and one whose value contains a `${...}` string interpolation),
 * and a top-level `trailing_var` after the map. Exercises every lexical
 * construct the splice engine has to skip over correctly in one file.
 */
const FIXTURE = `# top-level comment
other_var = "unchanged"

game_servers = {
  # comment before palworld
  palworld = {
    image = "palworld/image:latest"
    cpu   = 2048
  }

  valheim = {
    image = "valheim/image:latest"
    note  = <<-EOT
      This is a heredoc with a brace { inside it }.
      EOT
  }

  minecraft = {
    image = "minecraft/image:latest"
    msg   = "cost is ${DOLLAR}{100} literally"
  }
}

trailing_var = true
`;

/** Narrows a possibly-`null` {@link HclEntrySpan} for use in a test body, failing fast with a clear message if the entry wasn't located. */
function requireSpan(span: HclEntrySpan | null): HclEntrySpan {
  if (!span) throw new Error('Expected locateEntry() to find the entry, but it returned null.');
  return span;
}

describe('locateEntry', () => {
  it('should locate an entry by key inside a map with multiple entries', () => {
    const span = requireSpan(locateEntry(FIXTURE, 'game_servers', 'palworld'));
    expect(FIXTURE.slice(span.start, span.end)).toContain('palworld = {');
    expect(FIXTURE.slice(span.valueStart, span.valueEnd)).toContain('image = "palworld/image:latest"');
  });

  it('should return null when the map variable does not exist', () => {
    expect(locateEntry(FIXTURE, 'no_such_map', 'palworld')).toBeNull();
  });

  it('should return null when the map variable is assigned a non-object value', () => {
    const hcl = 'game_servers = "just a string"\n';
    expect(locateEntry(hcl, 'game_servers', 'palworld')).toBeNull();
  });

  it('should return null when entryKey is not present in the map', () => {
    expect(locateEntry(FIXTURE, 'game_servers', 'terraria')).toBeNull();
  });

  it('should skip a leading comment before the entry key when locating its span', () => {
    const span = requireSpan(locateEntry(FIXTURE, 'game_servers', 'palworld'));
    // The preceding "# comment before palworld" line belongs to whatever
    // precedes the entry, so `start` must land on the `palworld` key's own
    // line (after its indentation), not on the comment line.
    expect(FIXTURE.slice(0, span.start)).toContain('# comment before palworld');
    expect(FIXTURE.slice(span.start).trimStart().startsWith('palworld')).toBe(true);
  });

  it('should ignore a same-named identifier nested inside another map (not top-level)', () => {
    const hcl = `other_map = {
  game_servers = "decoy, not the real map"
}

game_servers = {
  real_key = {
    value = 1
  }
}
`;
    const span = requireSpan(locateEntry(hcl, 'game_servers', 'real_key'));
    expect(hcl.slice(span.valueStart, span.valueEnd)).toContain('value = 1');
  });

  it('should not mistake an equality comparison (==) for an assignment', () => {
    const hcl = `game_servers == 5

game_servers = {
  foo = { a = 1 }
}
`;
    const span = requireSpan(locateEntry(hcl, 'game_servers', 'foo'));
    expect(hcl.slice(span.valueStart, span.valueEnd)).toBe('{ a = 1 }');
  });

  it('should correctly span an entry whose value contains a heredoc with brace-like characters', () => {
    const span = requireSpan(locateEntry(FIXTURE, 'game_servers', 'valheim'));
    const valueText = FIXTURE.slice(span.valueStart, span.valueEnd);
    expect(valueText).toContain('<<-EOT');
    expect(valueText).toContain('This is a heredoc with a brace { inside it }.');
    expect(valueText.trimEnd().endsWith('}')).toBe(true);
  });

  it('should correctly span an entry whose value contains a string with ${...} interpolation', () => {
    const span = requireSpan(locateEntry(FIXTURE, 'game_servers', 'minecraft'));
    const valueText = FIXTURE.slice(span.valueStart, span.valueEnd);
    expect(valueText).toContain('cost is ${100} literally');
    expect(valueText.trimEnd().endsWith('}')).toBe(true);
  });

  it('should skip over nested braces inside a ${...} interpolation without miscounting', () => {
    const hcl = `game_servers = {
  foo = {
    msg = "value ${DOLLAR}{func({a = 1, b = [1, 2, 3]})}"
    after = "still inside foo"
  }

  bar = {
    value = 2
  }
}
`;
    const span = requireSpan(locateEntry(hcl, 'game_servers', 'bar'));
    expect(hcl.slice(span.valueStart, span.valueEnd)).toBe('{\n    value = 2\n  }');
  });

  it('should skip over a block comment containing brace-like characters', () => {
    const hcl = `game_servers = {
  /* this comment contains a brace { and a bracket ] just to be tricky */
  foo = {
    value = 1
  }
}
`;
    const span = requireSpan(locateEntry(hcl, 'game_servers', 'foo'));
    expect(hcl.slice(span.valueStart, span.valueEnd)).toBe('{\n    value = 1\n  }');
  });

  it('should include a trailing comma in the entry end when the source uses one', () => {
    const hcl = `game_servers = {
  foo = { a = 1 },
  bar = { b = 2 }
}
`;
    const span = requireSpan(locateEntry(hcl, 'game_servers', 'foo'));
    expect(hcl[span.end - 1]).toBe(',');
  });

  it('should not include a comma in the entry end for the last entry in the map', () => {
    const span = requireSpan(locateEntry(FIXTURE, 'game_servers', 'minecraft'));
    expect(FIXTURE[span.end]).not.toBe(',');
  });

  it('should throw HclSurgeonError for an unterminated map body', () => {
    const hcl = `game_servers = {
  foo = 1
`;
    expect(() => locateEntry(hcl, 'game_servers', 'foo')).toThrow(HclSurgeonError);
  });

  it('should throw HclSurgeonError for a mismatched closing bracket around the map body', () => {
    const hcl = `game_servers = {
  foo = 1
]
`;
    expect(() => locateEntry(hcl, 'game_servers', 'foo')).toThrow(HclSurgeonError);
  });
});

describe('cutEntry', () => {
  it('should remove an entry and preserve every byte before and after it verbatim', () => {
    const span = requireSpan(locateEntry(FIXTURE, 'game_servers', 'valheim'));
    let cutEnd = span.end;
    if (FIXTURE[cutEnd] === '\r') cutEnd++;
    if (FIXTURE[cutEnd] === '\n') cutEnd++;

    const result = cutEntry(FIXTURE, 'game_servers', 'valheim');

    expect(result.slice(0, span.start)).toBe(FIXTURE.slice(0, span.start));
    expect(result.slice(span.start)).toBe(FIXTURE.slice(cutEnd));
    expect(result).not.toContain('valheim');
  });

  it('should not leave a blank line behind when removing an entry with no blank-line separators', () => {
    const hcl = `game_servers = {
  foo = { a = 1 }
  bar = { b = 2 }
  baz = { c = 3 }
}
`;

    const result = cutEntry(hcl, 'game_servers', 'bar');

    expect(result).toBe(`game_servers = {
  foo = { a = 1 }
  baz = { c = 3 }
}
`);
  });

  it('should remove the last entry (no trailing comma) without corrupting the closing brace', () => {
    const span = requireSpan(locateEntry(FIXTURE, 'game_servers', 'minecraft'));
    let cutEnd = span.end;
    if (FIXTURE[cutEnd] === '\r') cutEnd++;
    if (FIXTURE[cutEnd] === '\n') cutEnd++;

    const result = cutEntry(FIXTURE, 'game_servers', 'minecraft');

    expect(result.slice(0, span.start)).toBe(FIXTURE.slice(0, span.start));
    expect(result.slice(span.start)).toBe(FIXTURE.slice(cutEnd));
    expect(result).not.toContain('minecraft');
    expect(result).toContain('trailing_var = true');
  });

  it('should preserve comments, heredocs, and unrelated top-level variables when cutting an entry', () => {
    const result = cutEntry(FIXTURE, 'game_servers', 'palworld');
    expect(result).toContain('# top-level comment');
    expect(result).toContain('other_var = "unchanged"');
    expect(result).toContain('<<-EOT');
    expect(result).toContain('This is a heredoc with a brace { inside it }.');
    expect(result).toContain('trailing_var = true');
    expect(result).not.toContain('palworld/image:latest');
  });

  it('should throw HclSurgeonError when the entry does not exist', () => {
    expect(() => cutEntry(FIXTURE, 'game_servers', 'terraria')).toThrow(HclSurgeonError);
  });

  it('should throw HclSurgeonError when the map variable does not exist', () => {
    expect(() => cutEntry(FIXTURE, 'no_such_map', 'palworld')).toThrow(HclSurgeonError);
  });
});

describe('replaceEntry', () => {
  it('should replace only the value expression and preserve everything outside it verbatim', () => {
    const span = requireSpan(locateEntry(FIXTURE, 'game_servers', 'palworld'));
    const newValue = '{\n    image = "palworld/image:v2"\n    cpu   = 4096\n  }';

    const result = replaceEntry(FIXTURE, 'game_servers', 'palworld', newValue);

    expect(result.slice(0, span.valueStart)).toBe(FIXTURE.slice(0, span.valueStart));
    expect(result.slice(span.valueStart, span.valueStart + newValue.length)).toBe(newValue);
    expect(result.slice(span.valueStart + newValue.length)).toBe(FIXTURE.slice(span.valueEnd));
  });

  it('should preserve comments, heredocs, and other entries when replacing an unrelated entry', () => {
    const newValue = '{\n    image = "minecraft/image:v2"\n  }';
    const result = replaceEntry(FIXTURE, 'game_servers', 'minecraft', newValue);

    expect(result).toContain('# top-level comment');
    expect(result).toContain('# comment before palworld');
    expect(result).toContain('<<-EOT');
    expect(result).toContain('This is a heredoc with a brace { inside it }.');
    expect(result).toContain('trailing_var = true');
    expect(result).toContain('minecraft/image:v2');
    expect(result).not.toContain('minecraft/image:latest');
  });

  it('should throw HclSurgeonError when the entry does not exist', () => {
    expect(() => replaceEntry(FIXTURE, 'game_servers', 'terraria', '{}')).toThrow(HclSurgeonError);
  });

  it('should throw HclSurgeonError when the map variable does not exist', () => {
    expect(() => replaceEntry(FIXTURE, 'no_such_map', 'palworld', '{}')).toThrow(HclSurgeonError);
  });
});
