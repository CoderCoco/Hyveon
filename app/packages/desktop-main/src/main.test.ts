import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * Declare spy variables via vi.hoisted() so they are initialised before the
 * vi.mock() factory functions run (vi.mock calls are hoisted to the top of the
 * compiled output, above regular const/let declarations).
 */
const { ElectronIPCTransportMock, fakeApp, createMicroserviceMock, applyFixPathMock, mockApp, createLoggerMock } = vi.hoisted(() => {
  /** Fake NestJS microservice app returned by `NestFactory.createMicroservice`. */
  const fakeApp = { listen: vi.fn().mockResolvedValue(undefined) };
  /** Spy constructor for ElectronIPCTransport — tracks `new` invocations. */
  const ElectronIPCTransportMock = vi.fn().mockImplementation(() => ({}));
  /** Spy for `NestFactory.createMicroservice`. */
  const createMicroserviceMock = vi.fn().mockResolvedValue(fakeApp);
  /** Spy for `applyFixPath` — verifies the fix-path bootstrap is called during startup. */
  const applyFixPathMock = vi.fn();
  /** Fake Electron `app` object with a `getPath` spy. */
  const mockApp = { getPath: vi.fn().mockReturnValue('/fake/userData') };
  /** Spy for `createLogger` — verifies the file logger is initialised before bootstrap. */
  const createLoggerMock = vi.fn();
  return { ElectronIPCTransportMock, fakeApp, createMicroserviceMock, applyFixPathMock, mockApp, createLoggerMock };
});

vi.mock('electron', () => ({
  app: mockApp,
}));

vi.mock('./logger.js', () => ({
  createLogger: createLoggerMock,
}));

vi.mock('nestjs-electron-ipc-transport', () => ({
  ElectronIPCTransport: ElectronIPCTransportMock,
}));

vi.mock('@nestjs/core', () => ({
  NestFactory: {
    createMicroservice: createMicroserviceMock,
  },
}));

/**
 * Stub AppModule so the deep Nest module graph (which requires the generated
 * tfstate file and AWS service dependencies) is never traversed during this
 * unit test.
 */
vi.mock('./app.module.js', () => ({
  AppModule: class AppModule {},
}));

vi.mock('./fix-path-bootstrap.js', () => ({
  applyFixPath: applyFixPathMock,
}));

describe('main bootstrap', () => {
  beforeEach(() => {
    /*
     * clearMocks: true (in vitest.config.ts) clears mock implementations before
     * each test. Re-apply the return values here so they are set when main.ts
     * executes during the test body.
     */
    ElectronIPCTransportMock.mockImplementation(() => ({}));
    createMicroserviceMock.mockResolvedValue(fakeApp);
    fakeApp.listen.mockResolvedValue(undefined);
    applyFixPathMock.mockImplementation(() => undefined);
    mockApp.getPath.mockReturnValue('/fake/userData');
    createLoggerMock.mockImplementation(() => undefined);
    // Simulate an Electron main-process environment so the module-level guard passes.
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, electron: '36.0.0' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should throw a clear error when not running inside an Electron main process', async () => {
    vi.stubGlobal('process', { ...process, versions: {} });
    vi.resetModules();
    await expect(import('./main.js')).rejects.toThrow('Electron main process');
  });

  it('should bootstrap as a NestJS microservice using ElectronIPCTransport', async () => {
    /*
     * Reset the module registry so re-importing main.ts forces the module to
     * re-execute (and thus `void bootstrap()` fires again) after clearMocks has
     * reset spy counters. vi.mock() registrations survive vi.resetModules(), so
     * all stubs remain active.
     */
    vi.resetModules();
    await import('./main.js');

    // Flush the event loop so the async bootstrap chain fully resolves.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const { AppModule } = await import('./app.module.js');

    // ElectronIPCTransport should have been constructed with `new`.
    expect(ElectronIPCTransportMock).toHaveBeenCalledOnce();

    // createMicroservice should have been called with AppModule and a strategy option.
    expect(createMicroserviceMock).toHaveBeenCalledOnce();
    const [calledModule, calledOptions] = createMicroserviceMock.mock.calls[0] as [
      unknown,
      { strategy: unknown },
    ];
    expect(calledModule).toBe(AppModule);
    expect(calledOptions).toHaveProperty('strategy');
    // The strategy passed to createMicroservice should be the value returned by
    // `new ElectronIPCTransport()` — i.e. the object the mock constructor produced.
    expect(calledOptions.strategy).toBe(ElectronIPCTransportMock.mock.results[0].value);

    // listen() should have been called on the fake app.
    expect(fakeApp.listen).toHaveBeenCalledOnce();
  });

  it('should call applyFixPath during bootstrap', async () => {
    vi.resetModules();
    await import('./main.js');

    // Flush the event loop so the async bootstrap chain fully resolves.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // applyFixPath must be invoked exactly once before NestFactory.createMicroservice.
    expect(applyFixPathMock).toHaveBeenCalledTimes(1);
  });

  it('should resolve userData path and initialise the file logger before bootstrap', async () => {
    vi.resetModules();
    await import('./main.js');

    // Flush the event loop so the async bootstrap chain fully resolves.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Electron app.getPath should have been called with 'userData' to derive the log directory.
    expect(mockApp.getPath).toHaveBeenCalledWith('userData');

    // createLogger must have been called with the userData/logs path before NestFactory boots.
    expect(createLoggerMock).toHaveBeenCalledWith('/fake/userData/logs');
  });
});
