import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MessageHandler } from '@nestjs/microservices';
import { BridgedElectronIPCTransport, registerIpcMainBridges, SELF_BRIDGED_PATTERNS } from './ipc-main-bridge.js';

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before any vi.mock() factory runs.
// ---------------------------------------------------------------------------

/**
 * Captures every `ipcMain.handle` / `ipcMain.removeHandler` call so tests can
 * assert on bridge registration without a real Electron main process.
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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Builds a `BridgedElectronIPCTransport` whose `messagePatternHandlers` map
 * is pre-seeded with a `vi.fn()` NestJS message handler per `patterns`
 * entry, mirroring the shape `Server.addHandler` would populate at runtime.
 */
function makeTransport(patterns: string[]): {
  transport: BridgedElectronIPCTransport;
  handlers: Map<string, MessageHandler>;
} {
  const transport = new BridgedElectronIPCTransport();
  const handlers = transport.messagePatternHandlers;
  for (const pattern of patterns) {
    handlers.set(pattern, vi.fn().mockResolvedValue(undefined));
  }
  return { transport, handlers };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('registerIpcMainBridges', () => {
  // registerIpcMainBridges only wires the bridge when running inside a real
  // Electron main process, detected via `process.versions.electron`. Vitest
  // runs under plain Node where it's undefined, so fake it for the "is
  // Electron" cases and restore afterwards.
  const realElectronVersion = process.versions.electron;
  const setElectron = (value: string | undefined): void => {
    if (value === undefined) {
      delete (process.versions as { electron?: string }).electron;
    } else {
      Object.defineProperty(process.versions, 'electron', { value, configurable: true });
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setElectron('30.0.0');
  });
  afterEach(() => setElectron(realElectronVersion));

  it('should be a silent no-op when not running inside an Electron main process', async () => {
    // Plain-Node runtimes (integration test server, Docker, CI) have no
    // `process.versions.electron`; importing electron there would throw, so
    // the bridge must skip without touching ipcMain at all.
    setElectron(undefined);
    const { transport } = makeTransport(['games.list', 'env.get']);

    await expect(registerIpcMainBridges(transport)).resolves.toBeUndefined();

    expect(mockIpcMainHandle).not.toHaveBeenCalled();
    expect(mockIpcMainRemoveHandler).not.toHaveBeenCalled();
  });

  it('should register a removeHandler-then-handle pair for every non-excluded pattern', async () => {
    const patterns = ['games.list', 'games.status', 'env.get', 'costs.estimate', 'logs.get'];
    const { transport } = makeTransport(patterns);

    await registerIpcMainBridges(transport);

    for (const pattern of patterns) {
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith(pattern);
      expect(mockIpcMainHandle).toHaveBeenCalledWith(pattern, expect.any(Function));
    }
  });

  it('should call removeHandler before handle for each bridged pattern', async () => {
    const { transport } = makeTransport(['games.list']);

    await registerIpcMainBridges(transport);

    const removeCall = mockIpcMainRemoveHandler.mock.invocationCallOrder[0];
    const handleCall = mockIpcMainHandle.mock.invocationCallOrder[0];
    expect(removeCall).toBeLessThan(handleCall);
  });

  it('should invoke the underlying NestJS handler as handler(payload, { evt }) when the ipcMain.handle callback fires', async () => {
    const { transport, handlers } = makeTransport(['games.list']);
    const handler = handlers.get('games.list')!;

    await registerIpcMainBridges(transport);

    const [, registeredCallback] = mockIpcMainHandle.mock.calls.find(
      ([pattern]) => pattern === 'games.list',
    ) as [string, (evt: unknown, payload: unknown) => unknown];

    const fakeEvt = { sender: {} };
    const payload = { some: 'payload' };
    await registeredCallback(fakeEvt, payload);

    expect(handler).toHaveBeenCalledWith(payload, { evt: fakeEvt });
  });

  it('should skip "logs.stream" entirely, leaving it to bridge itself', async () => {
    expect(SELF_BRIDGED_PATTERNS.has('logs.stream')).toBe(true);

    const { transport } = makeTransport(['logs.stream', 'logs.get']);

    await registerIpcMainBridges(transport);

    expect(mockIpcMainRemoveHandler).not.toHaveBeenCalledWith('logs.stream');
    expect(mockIpcMainHandle).not.toHaveBeenCalledWith('logs.stream', expect.any(Function));
    // The sibling pattern on the same map is still bridged normally.
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('logs.get');
    expect(mockIpcMainHandle).toHaveBeenCalledWith('logs.get', expect.any(Function));
  });

  it('should be a no-op when the transport has no registered handlers', async () => {
    const { transport } = makeTransport([]);

    await registerIpcMainBridges(transport);

    expect(mockIpcMainHandle).not.toHaveBeenCalled();
    expect(mockIpcMainRemoveHandler).not.toHaveBeenCalled();
  });
});
