import type { RendererConsoleLevel, RendererLogEntry } from '@hyveon/desktop-preload';

/** How often queued console entries are flushed to the main process. */
const FLUSH_INTERVAL_MS = 2_000;

/** Maximum entries sent in a single flush; anything past this stays queued for a later flush. */
const MAX_BATCH_ENTRIES = 50;

/** Hard cap on entries buffered between flushes, bounding memory if console output bursts faster than the flush interval. */
const MAX_QUEUE_SIZE = 200;

let queue: RendererLogEntry[] = [];
let droppedSinceLastFlush = 0;

/**
 * Entries currently out for delivery in an unsettled `diagnostics.reportLog`
 * call. Reserved against {@link MAX_QUEUE_SIZE} so that if the call fails,
 * the batch is guaranteed room to go back into the queue — without this, a
 * burst of newer entries filling the queue while an older batch is in
 * flight would force the *older* entries to be dropped on retry, breaking
 * oldest-first delivery order.
 */
let inFlightCount = 0;

/** Renders `console.*` arguments the same way they'd read on one log line — strings as-is, everything else stringified. */
function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.stack ?? arg.message;
      try {
        const serialized = JSON.stringify(arg);
        return serialized ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

/**
 * Queues a console entry, dropping (and counting) it once the queue plus
 * whatever is currently {@link inFlightCount} would reach {@link MAX_QUEUE_SIZE}
 * — the reservation guarantees any in-flight batch that later fails always
 * has room to be requeued.
 */
function enqueue(level: RendererConsoleLevel, message: string): void {
  if (queue.length + inFlightCount >= MAX_QUEUE_SIZE) {
    droppedSinceLastFlush += 1;
    return;
  }
  queue.push({ level, message });
}

/**
 * Puts a failed flush's batch back at the front of the queue (oldest first)
 * and restores its dropped-count. Always fits: {@link enqueue} reserves
 * space for in-flight entries via {@link inFlightCount} for exactly this
 * case, so a transient IPC failure never loses entries that were otherwise
 * safely within the queue cap.
 */
function requeueAfterFailedFlush(entries: RendererLogEntry[], droppedCount: number): void {
  queue = [...entries, ...queue];
  droppedSinceLastFlush += droppedCount;
}

/**
 * Sends up to {@link MAX_BATCH_ENTRIES} queued entries to the main process.
 * Anything beyond that per-flush cap stays queued for the next flush rather
 * than being dropped — the queue is already memory-bounded by
 * {@link MAX_QUEUE_SIZE}, so the per-flush cap only paces IPC message size,
 * not total delivery. The batch is reserved against the queue cap via
 * {@link inFlightCount} while its `diagnostics.reportLog` call is pending;
 * if the call rejects (transient failure), the batch is requeued rather
 * than lost.
 */
function flush(): void {
  if (queue.length === 0 && droppedSinceLastFlush === 0) {
    return;
  }
  const entries = queue.slice(0, MAX_BATCH_ENTRIES);
  queue = queue.slice(MAX_BATCH_ENTRIES);
  const droppedCount = droppedSinceLastFlush;
  droppedSinceLastFlush = 0;

  if (typeof window.hyveon?.diagnostics?.reportLog !== 'function') {
    return;
  }
  inFlightCount += entries.length;
  void window.hyveon.diagnostics.reportLog(entries, droppedCount || undefined)?.then(
    () => {
      inFlightCount -= entries.length;
    },
    () => {
      inFlightCount -= entries.length;
      requeueAfterFailedFlush(entries, droppedCount);
    },
  );
}

/**
 * Best-effort forward of a renderer-side error to the main process log.
 * Swallows its own failure (e.g. no `window.hyveon` bridge in a plain
 * browser/test context) — a broken reporting path must never throw on top
 * of the error it was trying to report.
 *
 * @param message - `Error.message`, or a string coercion for non-Error rejections.
 * @param stack - `Error.stack`, when available.
 * @param source - Where the report originated.
 */
export function reportRendererError(
  message: string,
  stack: string | undefined,
  source: 'boundary' | 'window-error' | 'unhandled-rejection',
): void {
  if (typeof window.hyveon?.diagnostics?.reportError !== 'function') {
    return;
  }
  void window.hyveon.diagnostics.reportError(message, stack, source)?.catch(() => undefined);
}

/**
 * Installs `window.onerror`/`unhandledrejection` listeners that forward to
 * {@link reportRendererError}. Call once, before `createRoot(...).render(...)`.
 */
export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (evt) => {
    reportRendererError(evt.message, evt.error?.stack, 'window-error');
  });
  window.addEventListener('unhandledrejection', (evt) => {
    const reason = evt.reason as unknown;
    const message = reason instanceof Error ? reason.message : String(reason);
    reportRendererError(message, reason instanceof Error ? reason.stack : undefined, 'unhandled-rejection');
  });
}

/** Whether {@link installConsoleForwarding} has already wrapped `console.*` in this session. */
let consoleForwardingInstalled = false;

/**
 * Overrides `console.log`/`info`/`warn`/`error` to also forward each call,
 * batched and rate-limited, to the main process log via
 * `window.hyveon.diagnostics.reportLog` — so routine renderer diagnostic
 * output survives into `main-*.log`, not just uncaught errors. The original
 * console output is always preserved; forwarding is purely additive.
 *
 * A no-op when no `window.hyveon` bridge is present (e.g. a plain
 * browser/test context) — `console.*` is left untouched in that case.
 * Call once, alongside {@link installGlobalErrorReporting}.
 */
export function installConsoleForwarding(): void {
  if (consoleForwardingInstalled || typeof window.hyveon?.diagnostics?.reportLog !== 'function') {
    return;
  }
  consoleForwardingInstalled = true;

  (['log', 'info', 'warn', 'error'] as const satisfies RendererConsoleLevel[]).forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      enqueue(level, formatConsoleArgs(args));
    };
  });

  setInterval(flush, FLUSH_INTERVAL_MS);
}
