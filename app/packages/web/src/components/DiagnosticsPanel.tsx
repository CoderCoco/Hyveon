import { useEffect, useRef, useState } from 'react';
import { api } from '../api.service.js';

const POLL_INTERVAL_MS = 5_000;

/**
 * DiagnosticsPanel — shows the last 500 lines of the server's diagnostics log
 * file, polls every 5 seconds for new lines, and autoscrolls to the bottom on
 * each refresh. Displays the log file path reported by the server.
 */
export function DiagnosticsPanel() {
  const [lines, setLines] = useState<string[]>([]);
  const [logPath, setLogPath] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  /** Fetch lines (and path on the first call), skipping state updates if cancelled. */
  async function fetchData(isFirstFetch: boolean, isCancelled: () => boolean) {
    try {
      const [tailResult, pathResult] = await Promise.all([
        api.diagnosticsTail(),
        isFirstFetch ? api.diagnosticsLogPath() : Promise.resolve(null),
      ]);
      if (isCancelled()) return;
      setLines(tailResult.lines);
      if (pathResult) setLogPath(pathResult.path);
      setError(null);
    } catch (err) {
      if (isCancelled()) return;
      setError(err instanceof Error ? err.message : 'Failed to load diagnostics');
    } finally {
      if (isFirstFetch && !isCancelled()) setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    void (async () => {
      await fetchData(true, () => cancelled);
      if (cancelled) return;

      intervalId = setInterval(() => {
        if (!cancelled) void fetchData(false, () => cancelled);
      }, POLL_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, []);

  // Autoscroll to the bottom whenever lines change.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  if (loading) {
    return (
      <div
        className="flex items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-muted-foreground)]"
        aria-busy="true"
      >
        Loading diagnostics…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-[var(--radius-sm)] border border-[var(--color-red)]/40 bg-[var(--color-red)]/10 px-3 py-2 text-sm text-[var(--color-red)]"
      >
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {logPath && (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Log file: <span className="font-[var(--font-mono)]">{logPath}</span>
        </p>
      )}
      <div
        ref={scrollRef}
        className="h-96 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-[var(--font-mono)] text-xs leading-6 text-[var(--color-muted-foreground)]"
      >
        {lines.length === 0 ? (
          <span className="text-[var(--color-muted-foreground)]">No log lines available.</span>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
