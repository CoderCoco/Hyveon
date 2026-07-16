import { describe, it, expect } from 'vitest';
import {
  createEmptyWizardDraft,
  stepForIssuePath,
  validateWizardDraft,
  validateIdentityStep,
  validateResourcesStep,
  validateNetworkingStep,
  validateStorageStep,
  validateReviewStep,
  canAdvance,
  type WizardDraft,
} from './wizard-form.utils.js';
import type { GameServer } from '../../api.service.js';

/** Builds a fully-valid draft; override any fields per test. */
function makeValidDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return {
    name: 'minecraft',
    image: 'itzg/minecraft-server',
    connect_message: '',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'data', container_path: '/data' }],
    file_seeds: [],
    ...overrides,
  };
}

/** Builds a minimal existing declared GameServer entry; override any fields per test. */
function makeExistingGame(overrides: Partial<GameServer> = {}): GameServer {
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

describe('createEmptyWizardDraft', () => {
  it('should return a blank draft with empty strings, null cpu/memory, and empty arrays', () => {
    expect(createEmptyWizardDraft()).toEqual({
      name: '',
      image: '',
      connect_message: '',
      cpu: null,
      memory: null,
      ports: [],
      volumes: [],
      file_seeds: [],
    });
  });
});

describe('stepForIssuePath', () => {
  it.each([
    ['name', 'identity'],
    ['image', 'identity'],
    ['connect_message', 'identity'],
    ['cpu', 'resources'],
    ['memory', 'resources'],
    ['ports', 'networking'],
    ['ports[0]', 'networking'],
    ['ports[1].protocol', 'networking'],
    ['volumes', 'storage'],
    ['volumes[0].container_path', 'storage'],
    ['file_seeds', 'storage'],
    ['file_seeds[0].path', 'storage'],
  ] as const)('should map path %s to the %s step', (path, step) => {
    expect(stepForIssuePath(path)).toBe(step);
  });

  it('should fall back to the review step for an unrecognized field family', () => {
    expect(stepForIssuePath('somethingUnknown')).toBe('review');
  });
});

describe('validateWizardDraft', () => {
  it('should return no issues for a fully valid draft', () => {
    expect(validateWizardDraft(makeValidDraft(), [])).toEqual([]);
  });
});

describe('validateIdentityStep', () => {
  it('should flag a blank name as required', () => {
    const issues = validateIdentityStep(makeValidDraft({ name: '' }), []);
    expect(issues).toContainEqual({ path: 'name', message: 'Name is required.' });
  });

  it('should flag a name containing invalid characters', () => {
    const issues = validateIdentityStep(makeValidDraft({ name: 'my game!' }), []);
    expect(issues.some((issue) => issue.path === 'name')).toBe(true);
  });

  it('should flag a name that collides with an already-declared game', () => {
    const issues = validateIdentityStep(makeValidDraft({ name: 'valheim' }), [makeExistingGame({ name: 'valheim' })]);
    expect(issues.some((issue) => issue.path === 'name' && issue.message.includes('already exists'))).toBe(true);
  });

  it('should flag a blank image', () => {
    const issues = validateIdentityStep(makeValidDraft({ image: '' }), []);
    expect(issues.some((issue) => issue.path === 'image')).toBe(true);
  });

  it('should flag an unknown connect_message placeholder', () => {
    const issues = validateIdentityStep(makeValidDraft({ connect_message: 'Connect via {password}' }), []);
    expect(issues.some((issue) => issue.path === 'connect_message')).toBe(true);
  });

  it('should flag an unknown connect_message placeholder even when cpu/memory/volumes are still unset', () => {
    // Regression test: on a fresh Identity step, cpu/memory are null and
    // volumes is empty, so validateGameServer's structural schema parse
    // fails before it ever reaches its own connect_message check. The
    // wizard must still catch a bad placeholder here rather than letting
    // Next stay enabled and only surfacing (or not surfacing) the problem
    // at Review.
    const issues = validateIdentityStep(
      makeValidDraft({ connect_message: 'Connect via {password}', cpu: null, memory: null, volumes: [] }),
      [],
    );
    expect(issues.some((issue) => issue.path === 'connect_message')).toBe(true);
  });

  it('should pass a clean identity step', () => {
    expect(validateIdentityStep(makeValidDraft(), [])).toEqual([]);
  });

  it('should not report resources/networking/storage issues even when those fields are invalid', () => {
    const issues = validateIdentityStep(makeValidDraft({ cpu: null, ports: [], volumes: [] }), []);
    expect(issues).toEqual([]);
  });
});

describe('validateResourcesStep', () => {
  it('should flag a missing cpu', () => {
    const issues = validateResourcesStep(makeValidDraft({ cpu: null }), []);
    expect(issues.some((issue) => issue.path === 'cpu')).toBe(true);
  });

  it('should flag a missing memory', () => {
    const issues = validateResourcesStep(makeValidDraft({ memory: null }), []);
    expect(issues.some((issue) => issue.path === 'memory')).toBe(true);
  });

  it('should flag a memory value that is not a valid Fargate pairing for the chosen cpu', () => {
    const issues = validateResourcesStep(makeValidDraft({ cpu: 256, memory: 1536 }), []);
    expect(issues.some((issue) => issue.path === 'memory')).toBe(true);
  });

  it('should flag a cpu value outside the supported Fargate tiers', () => {
    const issues = validateResourcesStep(makeValidDraft({ cpu: 100, memory: 512 }), []);
    expect(issues.some((issue) => issue.path === 'cpu')).toBe(true);
  });

  it('should pass a clean resources step', () => {
    expect(validateResourcesStep(makeValidDraft(), [])).toEqual([]);
  });
});

describe('validateNetworkingStep', () => {
  it('should flag two ports within the draft that collide on container/protocol', () => {
    const issues = validateNetworkingStep(
      makeValidDraft({
        ports: [
          { container: 25565, protocol: 'tcp' },
          { container: 25565, protocol: 'TCP' },
        ],
      }),
      [],
    );
    expect(issues.some((issue) => issue.path === 'ports[1]')).toBe(true);
  });

  it('should flag a port that collides with an already-declared game (cross-game collision)', () => {
    const existing = makeExistingGame({ name: 'valheim', ports: [{ container: 25565, protocol: 'tcp' }] });
    const issues = validateNetworkingStep(
      makeValidDraft({ name: 'minecraft', ports: [{ container: 25565, protocol: 'tcp' }] }),
      [existing],
    );
    expect(issues.some((issue) => issue.path === 'ports[0]' && issue.message.includes('valheim'))).toBe(true);
  });

  it('should not flag a self-collision when re-validating an already-declared game under its own name', () => {
    const existing = makeExistingGame({ name: 'minecraft', ports: [{ container: 25565, protocol: 'tcp' }] });
    const issues = validateNetworkingStep(
      makeValidDraft({ name: 'minecraft', ports: [{ container: 25565, protocol: 'tcp' }] }),
      [existing],
    );
    expect(issues).toEqual([]);
  });

  it('should pass a clean networking step', () => {
    expect(validateNetworkingStep(makeValidDraft(), [])).toEqual([]);
  });

  it('should not report identity/resources/storage issues even when those fields are invalid', () => {
    const issues = validateNetworkingStep(makeValidDraft({ name: '', cpu: null, volumes: [] }), []);
    expect(issues).toEqual([]);
  });
});

describe('validateStorageStep', () => {
  it('should flag an empty volumes array (volumes-min-1 rule)', () => {
    const issues = validateStorageStep(makeValidDraft({ volumes: [] }), []);
    expect(issues.some((issue) => issue.path === 'volumes')).toBe(true);
  });

  it('should flag a relative volumes[].container_path', () => {
    const issues = validateStorageStep(makeValidDraft({ volumes: [{ name: 'data', container_path: 'data' }] }), []);
    expect(issues.some((issue) => issue.path === 'volumes[0].container_path')).toBe(true);
  });

  it('should flag a relative file_seeds[].path', () => {
    const issues = validateStorageStep(
      makeValidDraft({ file_seeds: [{ path: 'config.yml', content: 'foo: bar', content_base64: '', mode: '' }] }),
      [],
    );
    expect(issues.some((issue) => issue.path === 'file_seeds[0].path')).toBe(true);
  });

  it('should pass a clean storage step', () => {
    expect(validateStorageStep(makeValidDraft(), [])).toEqual([]);
  });
});

describe('validateReviewStep', () => {
  it('should aggregate issues from every step', () => {
    // `name` (checked outside the shared schema) and `volumes` (a zod
    // structural failure) are both evaluated regardless of whether the rest
    // of the entry parses, so combining them here proves aggregation works
    // across the "always runs" and "schema-gated" halves of validateWizardDraft.
    const issues = validateReviewStep(makeValidDraft({ name: '', volumes: [] }), []);
    expect(issues.some((issue) => issue.path === 'name')).toBe(true);
    expect(issues.some((issue) => issue.path === 'volumes')).toBe(true);
  });

  it('should pass a clean review step', () => {
    expect(validateReviewStep(makeValidDraft(), [])).toEqual([]);
  });
});

describe('canAdvance', () => {
  it('should return true for a step with no outstanding issues', () => {
    expect(canAdvance('resources', makeValidDraft(), [])).toBe(true);
  });

  it('should return false for a step with an outstanding issue', () => {
    expect(canAdvance('resources', makeValidDraft({ cpu: null }), [])).toBe(false);
  });
});
