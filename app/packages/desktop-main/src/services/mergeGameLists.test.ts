import { describe, it, expect } from 'vitest';
import type { GameServer } from '@hyveon/shared';
import { mergeGameLists } from './mergeGameLists.js';

/** Minimal, valid `GameServer` fixture for a single declared game. */
function buildGameServer(name: string): GameServer {
  return {
    name,
    image: 'example/image:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'saves', container_path: '/data' }],
  };
}

describe('mergeGameLists', () => {
  it('should mark a game declared-only when it appears only in tfvars', () => {
    const palworld = buildGameServer('palworld');

    const result = mergeGameLists([palworld], []);

    expect(result).toEqual([{ name: 'palworld', declared: true, deployed: false, config: palworld }]);
  });

  it('should mark a game deployed-only when it appears only in tfstate', () => {
    const result = mergeGameLists([], ['minecraft']);

    expect(result).toEqual([{ name: 'minecraft', declared: false, deployed: true }]);
  });

  it('should mark a game as both declared and deployed when it appears in both sources', () => {
    const valheim = buildGameServer('valheim');

    const result = mergeGameLists([valheim], ['valheim']);

    expect(result).toEqual([{ name: 'valheim', declared: true, deployed: true, config: valheim }]);
  });

  it('should merge a mix of declared-only, deployed-only, and both entries without duplicates', () => {
    const declaredOnly = buildGameServer('ark');
    const both = buildGameServer('rust');

    const result = mergeGameLists([declaredOnly, both], ['rust', 'terraria']);

    expect(result).toHaveLength(3);
    expect(result).toEqual(
      expect.arrayContaining([
        { name: 'ark', declared: true, deployed: false, config: declaredOnly },
        { name: 'rust', declared: true, deployed: true, config: both },
        { name: 'terraria', declared: false, deployed: true },
      ]),
    );
  });

  it('should return an empty array when both inputs are empty', () => {
    expect(mergeGameLists([], [])).toEqual([]);
  });

  it('should order results as declared entries first (in tfvars order), then deployed-only entries (in tfstate order)', () => {
    const ark = buildGameServer('ark');
    const rust = buildGameServer('rust');

    const result = mergeGameLists([ark, rust], ['zomboid', 'rust', 'terraria']);

    expect(result).toEqual([
      { name: 'ark', declared: true, deployed: false, config: ark },
      { name: 'rust', declared: true, deployed: true, config: rust },
      { name: 'zomboid', declared: false, deployed: true },
      { name: 'terraria', declared: false, deployed: true },
    ]);
  });
});
