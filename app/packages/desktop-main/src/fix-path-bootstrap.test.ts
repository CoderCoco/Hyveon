import { describe, it, expect, vi, afterEach } from 'vitest';

/*
 * Hoist the mock spy so it is available when vi.mock() factory runs (vi.mock
 * calls are hoisted above regular declarations in compiled output).
 */
const { fixPathMock } = vi.hoisted(() => {
  /** Spy standing in for fix-path's default export (the shell-spawning function). */
  const fixPathMock = vi.fn();
  return { fixPathMock };
});

/**
 * Mock the fix-path ESM module so no real login shell is ever spawned during
 * tests. Its default export is replaced with a vi.fn() we can assert on.
 */
vi.mock('fix-path', () => ({
  default: fixPathMock,
}));

// Import the module under test AFTER mocks are registered.
import { applyFixPath } from './fix-path-bootstrap.js';

describe('applyFixPath', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('should call fix-path when platform is darwin', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });

    applyFixPath();

    expect(vi.mocked(fixPathMock)).toHaveBeenCalledOnce();
  });

  it('should call fix-path when platform is linux', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });

    applyFixPath();

    expect(vi.mocked(fixPathMock)).toHaveBeenCalledOnce();
  });

  it('should NOT call fix-path when platform is win32', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });

    applyFixPath();

    expect(vi.mocked(fixPathMock)).not.toHaveBeenCalled();
  });
});
