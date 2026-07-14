import { describe, it, expect } from 'vitest';
import { validateGameServer } from './gameServerValidator.js';
import type { GameServer } from './tfvars.js';

/** Build a minimal, fully-valid proposed entry; override any fields per test. */
function makeProposed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    image: 'itzg/minecraft-server',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'data', container_path: '/data' }],
    ...overrides,
  };
}

/** Build a minimal existing GameServer entry (as returned by TfvarsService.getGameServers()); override any fields per test. */
function makeExisting(overrides: Partial<GameServer> = {}): GameServer {
  return {
    name: 'valheim',
    image: 'lloesche/valheim-server',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 2456, protocol: 'udp' }],
    volumes: [{ name: 'data', container_path: '/data' }],
    ...overrides,
  };
}

describe('validateGameServer', () => {
  it('should succeed for a fully valid entry and reattach name onto the returned GameServer', () => {
    const result = validateGameServer('minecraft', makeProposed(), []);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('minecraft');
      expect(result.data.image).toBe('itzg/minecraft-server');
      expect(result.data.cpu).toBe(1024);
      expect(result.data.memory).toBe(2048);
    }
  });

  describe('Fargate cpu/memory pairing', () => {
    it('should accept each of the three discrete memory values for cpu=256', () => {
      for (const memory of [512, 1024, 2048]) {
        const result = validateGameServer('game', makeProposed({ cpu: 256, memory }), []);
        expect(result.success).toBe(true);
      }
    });

    it('should reject a memory value for cpu=256 that is not one of the three discrete values', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 256, memory: 1536 }), []);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'memory')).toBe(true);
      }
    });

    it('should accept memory=2048 for cpu=512 (bottom of the 1024-4096 ranged tier)', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 512, memory: 2048 }), []);
      expect(result.success).toBe(true);
    });

    it('should reject a memory value for cpu=512 that violates the 1024-step boundary', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 512, memory: 2500 }), []);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'memory')).toBe(true);
      }
    });

    it('should accept memory=8192 for cpu=1024 (top of the 2048-8192 ranged tier)', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 1024, memory: 8192 }), []);
      expect(result.success).toBe(true);
    });

    it('should reject a memory value for cpu=1024 that violates the 1024-step boundary', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 1024, memory: 3000 }), []);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'memory')).toBe(true);
      }
    });

    it('should accept memory=16384 for cpu=2048 (top of the 4096-16384 ranged tier)', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 2048, memory: 16384 }), []);
      expect(result.success).toBe(true);
    });

    it('should reject a memory value for cpu=2048 that violates the 1024-step boundary', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 2048, memory: 5000 }), []);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'memory')).toBe(true);
      }
    });

    it('should accept memory=30720 for cpu=4096 (top of the 8192-30720 ranged tier)', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 4096, memory: 30720 }), []);
      expect(result.success).toBe(true);
    });

    it('should reject a memory value for cpu=4096 that violates the 1024-step boundary', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 4096, memory: 8700 }), []);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'memory')).toBe(true);
      }
    });

    it('should accept memory=61440 for cpu=8192 (top of the 16384-61440 ranged tier)', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 8192, memory: 61440 }), []);
      expect(result.success).toBe(true);
    });

    it('should reject a memory value for cpu=8192 that violates the 4096-step boundary', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 8192, memory: 17000 }), []);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'memory')).toBe(true);
      }
    });

    it('should accept memory=122880 for cpu=16384 (top of the 32768-122880 ranged tier)', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 16384, memory: 122880 }), []);
      expect(result.success).toBe(true);
    });

    it('should reject a memory value for cpu=16384 that violates the 8192-step boundary', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 16384, memory: 40000 }), []);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'memory')).toBe(true);
      }
    });

    it('should reject a cpu value that is not one of the supported Fargate CPU units', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 100, memory: 512 }), []);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'cpu')).toBe(true);
      }
    });
  });

  describe('absolute paths', () => {
    it('should accept an absolute volumes[].container_path and file_seeds[].path', () => {
      const result = validateGameServer(
        'game',
        makeProposed({
          volumes: [{ name: 'data', container_path: '/data' }],
          file_seeds: [{ path: '/data/config.yml', content: 'foo: bar' }],
        }),
        [],
      );
      expect(result.success).toBe(true);
    });

    it('should reject a relative volumes[].container_path', () => {
      const result = validateGameServer(
        'game',
        makeProposed({ volumes: [{ name: 'data', container_path: 'data' }] }),
        [],
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'volumes[0].container_path')).toBe(true);
      }
    });

    it('should reject a relative file_seeds[].path', () => {
      const result = validateGameServer(
        'game',
        makeProposed({ file_seeds: [{ path: 'config.yml', content: 'foo: bar' }] }),
        [],
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'file_seeds[0].path')).toBe(true);
      }
    });
  });

  describe('connect_message placeholders', () => {
    it('should accept all four allowed placeholder tokens', () => {
      const result = validateGameServer(
        'game',
        makeProposed({ connect_message: 'Connect at {host}:{port} ({ip}) to play {game}.' }),
        [],
      );
      expect(result.success).toBe(true);
    });

    it('should reject an unknown placeholder token', () => {
      const result = validateGameServer('game', makeProposed({ connect_message: 'Connect at {password}' }), []);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'connect_message')).toBe(true);
      }
    });
  });

  describe('port collisions', () => {
    it('should reject two ports within the proposed entry that collide on container/protocol', () => {
      const result = validateGameServer(
        'game',
        makeProposed({
          ports: [
            { container: 25565, protocol: 'tcp' },
            { container: 25565, protocol: 'TCP' },
          ],
        }),
        [],
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'ports[1]')).toBe(true);
      }
    });

    it('should reject a proposed port that collides with an existing game server', () => {
      const existing = makeExisting({ name: 'valheim', ports: [{ container: 25565, protocol: 'tcp' }] });
      const result = validateGameServer(
        'minecraft',
        makeProposed({ ports: [{ container: 25565, protocol: 'tcp' }] }),
        [existing],
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'ports[0]' && i.message.includes('valheim'))).toBe(true);
      }
    });

    it('should not collide with itself when re-validating an already-declared game under its own name', () => {
      const existing = makeExisting({ name: 'minecraft', ports: [{ container: 25565, protocol: 'tcp' }] });
      const result = validateGameServer(
        'minecraft',
        makeProposed({ ports: [{ container: 25565, protocol: 'tcp' }] }),
        [existing],
      );
      expect(result.success).toBe(true);
    });

    it('should not report a false collision when the same container number is used by a different protocol', () => {
      // `existing` (default valheim fixture) declares container 2456/udp; the proposed entry
      // reuses container 2456 but on tcp, which must not be treated as a collision.
      const existing = makeExisting();
      const result = validateGameServer(
        'minecraft',
        makeProposed({
          ports: [
            { container: 2456, protocol: 'tcp' },
            { container: 25565, protocol: 'udp' },
          ],
        }),
        [existing],
      );
      expect(result.success).toBe(true);
    });
  });

  describe('structural (zod) failures', () => {
    it('should surface a missing required field with its JSON-path issue.path', () => {
      const proposed = makeProposed();
      delete (proposed as Record<string, unknown>)['image'];
      const result = validateGameServer('game', proposed, []);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'image')).toBe(true);
      }
    });

    it('should surface a mistyped field with its JSON-path issue.path', () => {
      const result = validateGameServer('game', makeProposed({ cpu: 'not-a-number' }), []);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'cpu')).toBe(true);
      }
    });

    it('should reject an empty volumes array', () => {
      const result = validateGameServer('game', makeProposed({ volumes: [] }), []);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'volumes')).toBe(true);
      }
    });
  });
});
