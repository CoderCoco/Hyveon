/**
 * Round-trip tests for `hclEmit.ts` — every `GameServer` field emitted by
 * `emitGameServerEntry()` must survive being parsed back through
 * `@cdktf/hcl2json`'s real `parse()` (not mocked, since the whole point of
 * this module is producing text that parser can consume) and deep-equal the
 * input config.
 */
import { describe, it, expect } from 'vitest';
import { parse as parseHcl } from '@cdktf/hcl2json';
import type { GameServer } from '@hyveon/shared';
import { emitGameServerEntry } from './hclEmit.js';

/**
 * Parses a single emitted `<name> = { ... }` attribute assignment by
 * splicing it into a `game_servers = { ... }` wrapper block (mirroring how
 * the surrounding tfvars file embeds it) and returns the decoded entry for
 * `name`.
 */
async function roundTrip(entryText: string, name: string): Promise<unknown> {
  const wrapped = `game_servers = {\n${entryText}\n}\n`;
  const parsed = (await parseHcl('terraform.tfvars', wrapped)) as {
    game_servers: Record<string, unknown>;
  };
  return parsed.game_servers[name];
}

describe('emitGameServerEntry', () => {
  it('should round-trip a full-featured config with ports, environment, volumes, https, connect_message, and multiline file_seeds', async () => {
    const entry: GameServer = {
      name: 'palworld',
      image: 'thijsvanloef/palworld-server-docker:latest',
      cpu: 2048,
      memory: 8192,
      ports: [
        { container: 8211, protocol: 'udp' },
        { container: 27015, protocol: 'udp' },
      ],
      environment: [
        { name: 'PLAYERS', value: '16' },
        { name: 'SERVER_NAME', value: 'My Server' },
      ],
      volumes: [{ name: 'saves', container_path: '/palworld' }],
      https: true,
      connect_message: 'Connect to {host}:{port}',
      file_seeds: [
        {
          path: '/palworld/config/PalWorldSettings.ini',
          content: '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None)\nLine3=done\n',
          mode: '0644',
        },
        {
          path: '/palworld/config/seed.bin',
          content_base64: 'aGVsbG8gd29ybGQ=',
        },
      ],
    };

    const emitted = emitGameServerEntry(entry);
    const result = await roundTrip(emitted, entry.name);

    const { name: _name, ...expectedAttributes } = entry;
    expect(result).toEqual(expectedAttributes);
  });

  it('should escape literal template interpolation and directive sequences so they are never evaluated by the HCL template engine', async () => {
    // `@cdktf/hcl2json` never unescapes a `$${`/`%%{` escape sequence back
    // down to a single `${`/`%{` when marshalling its JSON output — it
    // preserves the doubled form verbatim (confirmed empirically: escaping
    // `${` as `$${` and re-parsing yields `$${` again, not `${`). So the
    // correctness bar `quote()` must clear is *not* exact byte equality to
    // the pre-escape input for these two characters — it's that the escaped
    // sequences are never evaluated as real HCL template interpolation
    // (`${100}` collapsing to `100`) or directives (`%{if true}yes%{endif}`
    // collapsing to `yes`), which is exactly the corruption this fix
    // prevents. `expected` below reflects that: every field matches the
    // input verbatim except `connect_message` and the `file_seeds` content,
    // where the `$`/`%` immediately before every literal `{` comes back
    // doubled, matching the escaped source text `quote()` emitted.
    const entry: GameServer = {
      name: 'valheim',
      image: 'lloesche/valheim-server',
      cpu: 1024,
      memory: 2048,
      ports: [{ container: 2456, protocol: 'udp' }],
      volumes: [],
      connect_message: 'cost is ${100} and %{if true}yes%{endif} literally',
      file_seeds: [
        {
          path: '/valheim/config/note.txt',
          content: 'price: ${5}\ndirective: %{for x in y}${x}%{endfor}\n',
        },
      ],
    };

    const emitted = emitGameServerEntry(entry);
    const result = await roundTrip(emitted, entry.name);

    const { name: _name, ...expectedAttributes } = entry;
    expect(result).toEqual({
      ...expectedAttributes,
      connect_message: 'cost is $${100} and %%{if true}yes%%{endif} literally',
      file_seeds: [
        {
          path: '/valheim/config/note.txt',
          content: 'price: $${5}\ndirective: %%{for x in y}$${x}%%{endfor}\n',
        },
      ],
    });

    // The critical assertions: no template evaluation and no directive
    // execution happened. Prior to the fix, `${100}` silently evaluated
    // away to the bare number `100` (losing the surrounding `${...}` text
    // entirely) — this confirms the `100` and `if true`/`yes`/`endif` text
    // all still appear intact, just behind the doubled escape marker.
    const roundTripped = result as GameServer;
    expect(roundTripped.connect_message).toContain('$${100}');
    expect(roundTripped.connect_message).toContain('%%{if true}yes%%{endif}');
  });
});
