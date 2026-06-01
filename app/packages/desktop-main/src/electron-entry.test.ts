import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * Spy variables must be hoisted before vi.mock() factories run, because
 * vi.mock() calls are lifted to the top of the compiled output above regular
 * declarations.
 */
const {
  mockLoadURL,
  mockLoadFile,
  mockQuit,
  mockOn,
  mockWhenReady,
  MockBrowserWindow,
  mockGetAllWindows,
  bootstrapMock,
  whenReadyCallbacks,
  onCallbacks,
} = vi.hoisted(() => {
  const mockLoadURL = vi.fn().mockResolvedValue(undefined);
  const mockLoadFile = vi.fn().mockResolvedValue(undefined);
  const mockQuit = vi.fn();
  const mockGetAllWindows = vi.fn().mockReturnValue([]);

  /**
   * Collects every callback passed to `app.whenReady().then(cb)`.
   * Tests can fire them on demand by calling `whenReadyCallbacks[n]()`.
   */
  const whenReadyCallbacks: Array<() => void> = [];

  /**
   * Collects every callback registered via `app.on(event, cb)` keyed by
   * event name, so tests can trigger lifecycle events synchronously.
   */
  const onCallbacks: Record<string, () => void> = {};

  const mockOn = vi.fn((event: string, cb: () => void) => {
    onCallbacks[event] = cb;
  });

  /**
   * Returns a thenable that stores the `.then()` callback instead of
   * resolving it, giving tests full control over when the ready handler fires.
   */
  const mockWhenReady = vi.fn(() => ({
    then: (cb: () => void) => {
      whenReadyCallbacks.push(cb);
      return { then: vi.fn() };
    },
  }));

  /** Spy BrowserWindow constructor whose instances expose controlled load fns. */
  const MockBrowserWindow = vi.fn().mockImplementation(() => ({
    loadURL: mockLoadURL,
    loadFile: mockLoadFile,
  }));

  /** `BrowserWindow.getAllWindows()` static method used by the activate handler. */
  MockBrowserWindow.getAllWindows = mockGetAllWindows;

  /** Spy for `bootstrap` imported from `./main.js`. */
  const bootstrapMock = vi.fn().mockResolvedValue(undefined);

  return {
    mockLoadURL,
    mockLoadFile,
    mockQuit,
    mockOn,
    mockWhenReady,
    MockBrowserWindow,
    mockGetAllWindows,
    bootstrapMock,
    whenReadyCallbacks,
    onCallbacks,
  };
});

vi.mock('electron', () => ({
  app: {
    whenReady: mockWhenReady,
    on: mockOn,
    quit: mockQuit,
  },
  BrowserWindow: MockBrowserWindow,
}));

vi.mock('./main.js', () => ({
  bootstrap: bootstrapMock,
}));

/** Flush the micro-task / timer queue so async chains fully settle. */
async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('electron-entry', () => {
  beforeEach(() => {
    mockLoadURL.mockResolvedValue(undefined);
    mockLoadFile.mockResolvedValue(undefined);
    mockQuit.mockImplementation(() => undefined);
    bootstrapMock.mockResolvedValue(undefined);
    mockGetAllWindows.mockReturnValue([]);

    // Re-apply the BrowserWindow constructor implementation in case clearMocks
    // cleared it between tests (clearMocks resets call history and return value
    // queues; mockImplementation persists, but we re-set to be defensive).
    MockBrowserWindow.mockImplementation(() => ({
      loadURL: mockLoadURL,
      loadFile: mockLoadFile,
    }));

    // Re-apply mockOn and mockWhenReady implementations so callback capturing
    // works correctly after clearMocks resets the call history.
    mockOn.mockImplementation((event: string, cb: () => void) => {
      onCallbacks[event] = cb;
    });
    mockWhenReady.mockImplementation(() => ({
      then: (cb: () => void) => {
        whenReadyCallbacks.push(cb);
        return { then: vi.fn() };
      },
    }));

    // Reset the callback queues so each test starts clean.
    whenReadyCallbacks.length = 0;
    for (const key of Object.keys(onCallbacks)) {
      delete onCallbacks[key];
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should call bootstrap() inside the app.whenReady() callback', async () => {
    vi.resetModules();
    delete process.env['ELECTRON_RENDERER_URL'];

    await import('./electron-entry.js');
    await flushPromises();

    // Fire the whenReady callback that the module registered at import time.
    expect(whenReadyCallbacks).toHaveLength(1);
    whenReadyCallbacks[0]!();
    await flushPromises();

    expect(bootstrapMock).toHaveBeenCalledOnce();
  });

  it('should call win.loadURL() with the dev server URL when ELECTRON_RENDERER_URL is set', async () => {
    vi.resetModules();
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173';

    await import('./electron-entry.js');
    await flushPromises();

    expect(whenReadyCallbacks).toHaveLength(1);
    whenReadyCallbacks[0]!();
    await flushPromises();

    expect(mockLoadURL).toHaveBeenCalledOnce();
    expect(mockLoadURL).toHaveBeenCalledWith('http://localhost:5173');
    expect(mockLoadFile).not.toHaveBeenCalled();
  });

  it('should call win.loadFile() with the production renderer path when ELECTRON_RENDERER_URL is not set', async () => {
    vi.resetModules();
    delete process.env['ELECTRON_RENDERER_URL'];

    await import('./electron-entry.js');
    await flushPromises();

    expect(whenReadyCallbacks).toHaveLength(1);
    whenReadyCallbacks[0]!();
    await flushPromises();

    expect(mockLoadFile).toHaveBeenCalledOnce();
    expect(mockLoadURL).not.toHaveBeenCalled();

    // The path must end with the standard electron-vite renderer bundle location.
    const calledPath = mockLoadFile.mock.calls[0]?.[0] as string;
    expect(calledPath).toMatch(/renderer[/\\]index\.html$/);
  });

  it('should call app.quit() on window-all-closed for non-macOS platforms', async () => {
    vi.resetModules();
    delete process.env['ELECTRON_RENDERER_URL'];

    await import('./electron-entry.js');
    await flushPromises();

    const handler = onCallbacks['window-all-closed'];
    expect(handler).toBeDefined();

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    handler!();

    expect(mockQuit).toHaveBeenCalledOnce();

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('should NOT call app.quit() on window-all-closed on macOS', async () => {
    vi.resetModules();
    delete process.env['ELECTRON_RENDERER_URL'];

    await import('./electron-entry.js');
    await flushPromises();

    const handler = onCallbacks['window-all-closed'];
    expect(handler).toBeDefined();

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    handler!();

    expect(mockQuit).not.toHaveBeenCalled();

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });
});
