import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGlobalErrorReporting, reportRendererError } from './report-renderer-error.utils.js';
import type { RendererLogEntry } from '@hyveon/desktop-preload';

const MODULE_PATH = './report-renderer-error.utils.js';

/** Install a `window.hyveon` stub whose `diagnostics.reportError` is a spy. */
function stubBridge(reportError: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('hyveon', { diagnostics: { reportError } });
}

describe('reportRendererError', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should call window.hyveon.diagnostics.reportError with the given arguments', () => {
    const reportError = vi.fn().mockResolvedValue(undefined);
    stubBridge(reportError);

    reportRendererError('boom', 'Error: boom\n  at x', 'boundary');

    expect(reportError).toHaveBeenCalledWith('boom', 'Error: boom\n  at x', 'boundary');
  });

  it('should not throw when window.hyveon is undefined', () => {
    vi.stubGlobal('hyveon', undefined);

    expect(() => reportRendererError('boom', undefined, 'window-error')).not.toThrow();
  });

  it('should not throw when window.hyveon.diagnostics is undefined', () => {
    vi.stubGlobal('hyveon', {});

    expect(() => reportRendererError('boom', undefined, 'window-error')).not.toThrow();
  });

  it('should swallow a rejection from window.hyveon.diagnostics.reportError', async () => {
    const reportError = vi.fn().mockRejectedValue(new Error('ipc unavailable'));
    stubBridge(reportError);

    expect(() => reportRendererError('boom', undefined, 'unhandled-rejection')).not.toThrow();
    // Let the rejected promise's .catch(() => undefined) settle before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('installGlobalErrorReporting', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should forward a window error event to reportRendererError', () => {
    const reportError = vi.fn().mockResolvedValue(undefined);
    stubBridge(reportError);
    installGlobalErrorReporting();

    const error = new Error('render crashed');
    window.dispatchEvent(new ErrorEvent('error', { message: 'render crashed', error }));

    expect(reportError).toHaveBeenCalledWith('render crashed', error.stack, 'window-error');
  });

  it('should forward an unhandledrejection event with an Error reason', () => {
    const reportError = vi.fn().mockResolvedValue(undefined);
    stubBridge(reportError);
    installGlobalErrorReporting();

    const reason = new Error('promise blew up');
    const event = new Event('unhandledrejection') as PromiseRejectionEvent & { reason: unknown };
    Object.defineProperty(event, 'reason', { value: reason });
    window.dispatchEvent(event);

    expect(reportError).toHaveBeenCalledWith('promise blew up', reason.stack, 'unhandled-rejection');
  });

  it('should coerce a non-Error unhandledrejection reason to a string message with no stack', () => {
    const reportError = vi.fn().mockResolvedValue(undefined);
    stubBridge(reportError);
    installGlobalErrorReporting();

    const event = new Event('unhandledrejection') as PromiseRejectionEvent & { reason: unknown };
    Object.defineProperty(event, 'reason', { value: 'plain string rejection' });
    window.dispatchEvent(event);

    expect(reportError).toHaveBeenCalledWith('plain string rejection', undefined, 'unhandled-rejection');
  });
});

describe('installConsoleForwarding', () => {
  const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error'] as const;
  const originalConsole: Record<(typeof CONSOLE_LEVELS)[number], (...args: unknown[]) => void> = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    CONSOLE_LEVELS.forEach((level) => {
      console[level] = originalConsole[level];
    });
  });

  it('should leave console methods untouched when no bridge is present', async () => {
    vi.stubGlobal('hyveon', undefined);
    const { installConsoleForwarding } = await import(MODULE_PATH);
    const before = console.log;

    installConsoleForwarding();

    expect(console.log).toBe(before);
  });

  it('should still invoke the original console method after installing', async () => {
    vi.stubGlobal('hyveon', { diagnostics: { reportLog: vi.fn().mockResolvedValue(undefined) } });
    const spy = vi.fn();
    console.log = spy;
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    console.log('hello world');

    expect(spy).toHaveBeenCalledWith('hello world');
  });

  it('should forward a console.log call to diagnostics.reportLog on the next flush', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    console.log('hello world');
    expect(reportLog).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledWith([{ level: 'log', message: 'hello world' }], undefined);
  });

  it('should join multiple console arguments and stringify non-string values', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    console.warn('count is', 42, { ok: true });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledWith([{ level: 'warn', message: 'count is 42 {"ok":true}' }], undefined);
  });

  it('should cap entries sent in one flush and retain the rest for the next flush', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    for (let i = 0; i < 60; i += 1) {
      console.log(`entry ${i}`);
    }
    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledTimes(1);
    const [firstEntries, firstDropped] = reportLog.mock.calls[0] as [unknown[], number | undefined];
    expect(firstEntries).toHaveLength(50);
    expect(firstDropped).toBeUndefined();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledTimes(2);
    const [secondEntries, secondDropped] = reportLog.mock.calls[1] as [unknown[], number | undefined];
    expect(secondEntries).toHaveLength(10);
    expect(secondDropped).toBeUndefined();
  });

  it('should not call reportLog on a flush with nothing queued', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).not.toHaveBeenCalled();
  });

  it('should render an Error argument using its stack', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);
    const error = new Error('boom');

    installConsoleForwarding();
    console.error(error);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledWith([{ level: 'error', message: error.stack }], undefined);
  });

  it('should fall back to an Error argument\'s message when it has no stack', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);
    const error = new Error('boom');
    error.stack = undefined;

    installConsoleForwarding();
    console.error(error);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledWith([{ level: 'error', message: 'boom' }], undefined);
  });

  it('should fall back to String(arg) when an argument cannot be JSON.stringify-d', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    installConsoleForwarding();
    console.log(circular);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledWith([{ level: 'log', message: String(circular) }], undefined);
  });

  it('should preserve an undefined argument instead of dropping it from the message', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    console.log('value:', undefined);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledWith([{ level: 'log', message: 'value: undefined' }], undefined);
  });

  it('should drop entries once the queue is full and count them as dropped on the next flush', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    for (let i = 0; i < 210; i += 1) {
      console.log(`entry ${i}`);
    }
    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledTimes(1);
    const [entries, droppedCount] = reportLog.mock.calls[0] as [unknown[], number | undefined];
    // 200 queue slots filled; the 10 further calls drop at enqueue time.
    // The flush limit sends 50 entries and retains the rest for later flushes.
    expect(entries).toHaveLength(50);
    expect(droppedCount).toBe(10);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(reportLog).toHaveBeenCalledTimes(4);
  });

  it('should skip forwarding on a flush when the bridge disappears after install', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    console.log('queued before bridge disappears');
    vi.stubGlobal('hyveon', undefined);

    await expect(vi.advanceTimersByTimeAsync(2_000)).resolves.not.toThrow();
    expect(reportLog).not.toHaveBeenCalled();
  });

  it('should not throw when diagnostics.reportLog rejects', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockRejectedValue(new Error('ipc unavailable'));
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    console.error('boom');

    await expect(vi.advanceTimersByTimeAsync(2_000)).resolves.not.toThrow();
  });

  it('should requeue a failed flush and resend it on the next flush', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockRejectedValueOnce(new Error('ipc unavailable')).mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    console.log('first attempt fails');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledTimes(2);
    expect(reportLog).toHaveBeenLastCalledWith([{ level: 'log', message: 'first attempt fails' }], undefined);
  });

  it('should restore the dropped count from a failed flush and combine it with later drops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reportLog = vi.fn().mockRejectedValueOnce(new Error('ipc unavailable')).mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    for (let i = 0; i < 205; i += 1) {
      console.log(`entry ${i}`);
    }
    // First flush: sends 50, queue holds 150, 5 were dropped at enqueue time (queue cap 200). Fails.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reportLog).toHaveBeenCalledTimes(1);

    // Second flush: the failed 50 are requeued ahead of the 150 already queued (all fit under the
    // 200 cap), so this flush resends the same first 50 along with the earlier drop count.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reportLog).toHaveBeenCalledTimes(2);
    const [, secondDropped] = reportLog.mock.calls[1] as [unknown[], number | undefined];
    expect(secondDropped).toBe(5);
  });

  it('should reserve queue capacity for in-flight entries so a failed batch is never lost to newer entries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let rejectFirstAttempt: (err: unknown) => void = () => undefined;
    const firstAttempt = new Promise<void>((_resolve, reject) => {
      rejectFirstAttempt = reject;
    });
    const reportLog = vi.fn().mockReturnValueOnce(firstAttempt).mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', { diagnostics: { reportLog } });
    const { installConsoleForwarding } = await import(MODULE_PATH);

    installConsoleForwarding();
    console.log('will fail and be requeued');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reportLog).toHaveBeenCalledTimes(1);

    // The first attempt is still pending (its 1 entry is reserved against the queue cap). Filling
    // the queue with 200 more entries can therefore only fit 199 of them — the 200th is dropped —
    // rather than the in-flight entry losing its spot once it comes back.
    for (let i = 0; i < 200; i += 1) {
      console.log(`filler ${i}`);
    }

    rejectFirstAttempt(new Error('ipc unavailable'));
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(reportLog).toHaveBeenCalledTimes(2);
    const [secondEntries, secondDropped] = reportLog.mock.calls[1] as [RendererLogEntry[], number | undefined];
    expect(secondEntries[0]).toEqual({ level: 'log', message: 'will fail and be requeued' });
    expect(secondDropped).toBe(1);
  });
});
