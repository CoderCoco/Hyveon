import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerraformController } from './terraform.controller.js';
import { TerraformInitError, type TerraformInitConfig, type TerraformRunChunk } from '../services/TerraformService.js';
import type { TerraformService } from '../services/TerraformService.js';

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before any vi.mock() factory runs.
// ---------------------------------------------------------------------------

/**
 * Captures every `ipcMain.handle`/`ipcMain.removeHandler` call so tests can
 * assert on routing registration without a real Electron main process.
 */
const { mockIpcMainHandle, mockIpcMainRemoveHandler } = vi.hoisted(() => {
  const mockIpcMainHandle = vi.fn();
  const mockIpcMainRemoveHandler = vi.fn();
  return { mockIpcMainHandle, mockIpcMainRemoveHandler };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
    removeHandler: mockIpcMainRemoveHandler,
  },
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A minimal backend config payload shared across test cases. */
const CONFIG: TerraformInitConfig = {
  bucket: 'hyveon-tf-state',
  region: 'us-east-1',
  dynamodbTable: 'hyveon-tf-locks',
};

/** Build a TerraformService stub whose `init` yields nothing by default. */
function makeTerraform(): TerraformService {
  const stub: Partial<TerraformService> = {
    init: vi.fn().mockImplementation(async function* () { /* empty */ }),
  };
  return stub as TerraformService;
}

/**
 * Build a minimal `IpcMainInvokeEvent` stub with a controlled `sender`
 * (WebContents). Tests can inspect calls on `sender.send` and control the
 * return value of `sender.isDestroyed()`.
 */
function makeCtx(isDestroyed = false) {
  const sender = {
    send: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(isDestroyed),
    // `TerraformController.init` registers a `'destroyed'` listener (and
    // removes it once the run settles) so it can abort immediately when the
    // WebContents goes away instead of only checking `isDestroyed()` between
    // chunks.
    once: vi.fn(),
    removeListener: vi.fn(),
  };
  const ctx: { evt: { sender: typeof sender } } = { evt: { sender } };
  return { ctx, sender };
}

/** Flush the microtask queue so async fire-and-forget loops fully settle. */
function flushPromises(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * The metadata key NestJS stores on each method decorated with
 * `@MessagePattern`. Asserting this value guards against typos in the
 * channel name that would silently break IPC routing.
 */
const PATTERN_METADATA_KEY = 'microservices:pattern';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('TerraformController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // @MessagePattern channel name registration
  // -------------------------------------------------------------------------

  describe('@MessagePattern channel names', () => {
    it('should register init on the "terraform.init" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, TerraformController.prototype.init);
      expect(pattern).toEqual(['terraform.init']);
    });
  });

  // -------------------------------------------------------------------------
  // onModuleInit — ipcMain.handle bridge for terraform.init
  // -------------------------------------------------------------------------

  describe('onModuleInit', () => {
    // onModuleInit only wires the bridge when running inside a real Electron
    // main process, detected via `process.versions.electron`. Vitest runs under
    // plain Node where it's undefined, so fake it for the "is Electron" cases
    // and restore afterwards.
    const realElectronVersion = process.versions.electron;
    const setElectron = (value: string | undefined): void => {
      if (value === undefined) {
        delete (process.versions as { electron?: string }).electron;
      } else {
        Object.defineProperty(process.versions, 'electron', { value, configurable: true });
      }
    };
    beforeEach(() => setElectron('30.0.0'));
    afterEach(() => setElectron(realElectronVersion));

    it('should skip the ipcMain bridge when not running inside an Electron main process', async () => {
      // Plain-Node runtimes (integration test server, Docker, CI) have no
      // `process.versions.electron`; importing electron there would throw, so
      // the bridge must be skipped without touching ipcMain at all.
      setElectron(undefined);
      await new TerraformController(makeTerraform()).onModuleInit();
      expect(mockIpcMainHandle).not.toHaveBeenCalled();
      expect(mockIpcMainRemoveHandler).not.toHaveBeenCalled();
    });

    it('should register ipcMain.handle for "terraform.init" so ipcRenderer.invoke can resolve', async () => {
      await new TerraformController(makeTerraform()).onModuleInit();
      expect(mockIpcMainHandle).toHaveBeenCalledWith('terraform.init', expect.any(Function));
    });

    it('should remove any existing "terraform.init" handler before registering so hot-reload re-bootstrap does not throw', async () => {
      // A second bootstrap (hot-reload / dev restart) would otherwise hit
      // "Attempted to register a second handler for 'terraform.init'".
      // Clearing the handler first keeps re-registration idempotent.
      await new TerraformController(makeTerraform()).onModuleInit();
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('terraform.init');
      expect(mockIpcMainRemoveHandler.mock.invocationCallOrder[0]).toBeLessThan(
        mockIpcMainHandle.mock.invocationCallOrder[0],
      );
    });
  });

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  describe('init', () => {
    it('should return { started: true } immediately without waiting for the run to settle', async () => {
      // TerraformService.init never yields/returns on its own here, so if
      // init() awaited the whole loop synchronously this call would hang.
      const terraform = makeTerraform();
      // eslint-disable-next-line require-yield -- generator intentionally never yields/returns to prove init() doesn't await it
      vi.mocked(terraform.init).mockImplementation(async function* () {
        await new Promise<void>(() => { /* never resolves */ });
      });
      const { ctx } = makeCtx();

      const result = await new TerraformController(terraform).init(CONFIG, ctx);

      expect(result).toEqual({ started: true, streamId: expect.any(String) });
    });

    it('should send each yielded chunk to the renderer via sender.send, in order', async () => {
      const chunks: TerraformRunChunk[] = [
        { stream: 'stdout', line: 'Initializing the backend...' },
        { stream: 'stdout', line: 'Initializing provider plugins...' },
        { stream: 'stdout', line: 'Terraform has been successfully initialized!' },
      ];
      async function* yieldChunks() {
        for (const chunk of chunks) yield chunk;
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.init).mockImplementation(yieldChunks);
      const { ctx, sender } = makeCtx();

      await new TerraformController(terraform).init(CONFIG, ctx);
      await flushPromises();

      const chunkCalls = sender.send.mock.calls.filter(([channel]) => channel === 'terraform.init.chunk');
      // Every chunk payload is tagged with the same per-call streamId so the
      // renderer (and a rejected concurrent call) can tell which run it
      // belongs to.
      const streamIds = new Set(chunkCalls.map(([, payload]) => (payload as { streamId: string }).streamId));
      expect(streamIds.size).toBe(1);
      expect(chunkCalls.map(([, payload]) => (payload as { chunk: TerraformRunChunk }).chunk)).toEqual(chunks);
    });

    it('should forward the config payload and an AbortSignal to TerraformService.init', async () => {
      const terraform = makeTerraform();
      const { ctx } = makeCtx();

      await new TerraformController(terraform).init(CONFIG, ctx);
      await flushPromises();

      expect(terraform.init).toHaveBeenCalledWith(CONFIG, expect.any(AbortSignal));
    });

    it('should send an end message with exitCode 0 and no error when the run succeeds', async () => {
      async function* empty() { /* no chunks, generator returns normally */ }
      const terraform = makeTerraform();
      vi.mocked(terraform.init).mockImplementation(empty);
      const { ctx, sender } = makeCtx();

      await new TerraformController(terraform).init(CONFIG, ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith('terraform.init.end', { streamId: expect.any(String), exitCode: 0 });
      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'terraform.init.end');
      expect(endCall?.[1]).not.toHaveProperty('error');
    });

    it('should send an end message with the process exit code and a stringified error on TerraformInitError', async () => {
      async function* failsWithExitCode(): AsyncGenerator<TerraformRunChunk> {
        yield { stream: 'stderr', line: 'Error configuring backend "s3"' };
        throw new TerraformInitError(1);
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.init).mockImplementation(failsWithExitCode);
      const { ctx, sender } = makeCtx();

      await new TerraformController(terraform).init(CONFIG, ctx);
      await flushPromises();

      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'terraform.init.end');
      expect(endCall?.[1]).toMatchObject({ exitCode: 1 });
      expect(String(endCall?.[1]?.error)).toContain('terraform init exited with code 1');
    });

    it('should send an end message with a null exitCode for a non-process failure (e.g. binary not found)', async () => {
      // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate a pre-spawn failure
      async function* failsWithoutExitCode(): AsyncGenerator<TerraformRunChunk> {
        throw new Error('terraform binary not found on PATH');
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.init).mockImplementation(failsWithoutExitCode);
      const { ctx, sender } = makeCtx();

      await new TerraformController(terraform).init(CONFIG, ctx);
      await flushPromises();

      const endCall = sender.send.mock.calls.find(([channel]) => channel === 'terraform.init.end');
      expect(endCall?.[1]).toMatchObject({ exitCode: null });
      expect(String(endCall?.[1]?.error)).toContain('terraform binary not found on PATH');
    });

    it('should not send further chunks or an end message once the WebContents is destroyed', async () => {
      async function* twoLines(): AsyncGenerator<TerraformRunChunk> {
        yield { stream: 'stdout', line: 'first' };
        yield { stream: 'stdout', line: 'second' };
      }
      const terraform = makeTerraform();
      vi.mocked(terraform.init).mockImplementation(twoLines);
      // Simulate WebContents already destroyed before the loop runs.
      const { ctx, sender } = makeCtx(true);

      await new TerraformController(terraform).init(CONFIG, ctx);
      await flushPromises();

      expect(sender.send).not.toHaveBeenCalled();
    });

    it('should reject with { started: false, error } and never call TerraformService.init when the payload fails validation', async () => {
      const terraform = makeTerraform();
      const { ctx, sender } = makeCtx();
      const invalidConfig = { bucket: '', region: 'us-east-1', dynamodbTable: 'hyveon-tf-locks' };

      const result = await new TerraformController(terraform).init(invalidConfig, ctx);
      await flushPromises();

      expect(result.started).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(terraform.init).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });
  });
});
