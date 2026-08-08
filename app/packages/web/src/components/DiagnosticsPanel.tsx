import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Filter, Pause, Play, Search } from 'lucide-react';
import { api } from '../api.service.js';
import { Badge } from './ui/badge.component.js';
import { Button } from './ui/button.component.js';
import { Input } from './ui/input.component.js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from './ui/dropdown-menu.component.js';
import { ALL_LOG_LEVELS, LOG_LEVEL_BADGE, detectLogLevel, type LogLevel } from '../lib/log-level.utils.js';

const POLL_INTERVAL_MS = 5_000;

/** A single displayed diagnostics line, with its detected level (if any). */
interface DiagnosticsLine {
  text: string;
  level: LogLevel | null;
}

/** A `diagnostics.tail`/`diagnostics.path` snapshot fetched while paused, awaiting the operator's resume. */
interface PendingSnapshot {
  lines: string[];
  path: string;
}

/** Render a single line, splitting on case-insensitive search matches. Mirrors `/logs`'s `HighlightedLine`. */
function HighlightedLine({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const q = query.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let i = 0;
  const lower = text.toLowerCase();
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parts.push({ text: text.slice(i), match: false });
      break;
    }
    if (idx > i) parts.push({ text: text.slice(i, idx), match: false });
    parts.push({ text: text.slice(idx, idx + q.length), match: true });
    i = idx + q.length;
  }
  return (
    <>
      {parts.map((p, idx) =>
        p.match ? (
          <mark key={idx} className="rounded-[2px] bg-[var(--color-amber)]/40 px-[1px] text-[var(--color-foreground)]">
            {p.text}
          </mark>
        ) : (
          <span key={idx}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** Multi-select dropdown for hiding log levels. Default: nothing hidden. Mirrors `/logs`'s `LevelFilterMenu`. */
function LevelFilterMenu({ hidden, onToggle }: { hidden: Set<LogLevel>; onToggle: (lvl: LogLevel) => void }) {
  const visibleCount = ALL_LOG_LEVELS.length - hidden.size;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" className="gap-1.5">
          <Filter className="h-3.5 w-3.5" />
          Levels
          <span className="text-[var(--color-muted-foreground)]">
            ({visibleCount}/{ALL_LOG_LEVELS.length})
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuLabel>Show levels</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ALL_LOG_LEVELS.map((lvl) => (
          <DropdownMenuCheckboxItem key={lvl} checked={!hidden.has(lvl)} onCheckedChange={() => onToggle(lvl)} onSelect={(e) => e.preventDefault()}>
            <Badge variant={LOG_LEVEL_BADGE[lvl].variant} className="h-4 px-1.5 py-0 text-[10px] leading-4">
              {LOG_LEVEL_BADGE[lvl].label}
            </Badge>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * DiagnosticsPanel — shows the last 500 lines of the app's own local log
 * file (`main-*.log`), polling `diagnostics.tail`/`diagnostics.path` every 5
 * seconds. Brings the same interaction affordances the `/logs` page already
 * has for CloudWatch output: pause/resume, level filter, search-highlight,
 * and autoscroll.
 *
 * `diagnostics.tail` returns the current cumulative tail on every call, not
 * an incremental delta — unlike `/logs`'s streamed chunks, there is no line
 * identity to key an append on. Pausing therefore does not stop polling; it
 * stops the poll response from being *rendered*. Each poll while paused
 * updates only an internal "latest fetched" ref. Resuming replaces the view
 * with that latest snapshot in one step — never by appending successive
 * poll responses to each other, which would duplicate or misorder lines
 * given the snapshot (not delta) shape of the response.
 */
export function DiagnosticsPanel() {
  const [lines, setLines] = useState<string[]>([]);
  const [logPath, setLogPath] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState('');
  const [hiddenLevels, setHiddenLevels] = useState<Set<LogLevel>>(new Set());

  const scrollRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  /** The most recently fetched snapshot while paused, applied on resume. Not rendered until then. */
  const pendingSnapshotRef = useRef<PendingSnapshot | null>(null);

  /** Fetch tail lines and log path, skipping state updates if cancelled. */
  async function fetchData(isCancelled: () => boolean) {
    try {
      const [tailResult, pathResult] = await Promise.all([api.diagnosticsTail(), api.diagnosticsLogPath()]);
      if (isCancelled()) return;
      if (pausedRef.current) {
        pendingSnapshotRef.current = { lines: tailResult.lines, path: pathResult.path };
      } else {
        setLines(tailResult.lines);
        setLogPath(pathResult.path);
      }
      setError(null);
    } catch (err) {
      if (isCancelled()) return;
      setError(err instanceof Error ? err.message : 'Failed to load diagnostics');
    }
  }

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    void (async () => {
      await fetchData(() => cancelled);
      if (cancelled) return;
      setLoading(false);

      intervalId = setInterval(() => {
        if (!cancelled) void fetchData(() => cancelled);
      }, POLL_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, []);

  /** Toggle pause; resuming applies whatever snapshot was fetched most recently while paused, in one step. */
  const handlePauseToggle = useCallback(() => {
    const nowPaused = !pausedRef.current;
    pausedRef.current = nowPaused;
    setPaused(nowPaused);
    if (!nowPaused && pendingSnapshotRef.current) {
      setLines(pendingSnapshotRef.current.lines);
      setLogPath(pendingSnapshotRef.current.path);
      pendingSnapshotRef.current = null;
    }
  }, []);

  const toggleLevel = useCallback((lvl: LogLevel) => {
    setHiddenLevels((prev) => {
      const next = new Set(prev);
      if (next.has(lvl)) next.delete(lvl);
      else next.add(lvl);
      return next;
    });
  }, []);

  // Autoscroll to the bottom whenever lines change — but only while not paused, so a paused view
  // never gets scrolled out from under an operator reading it (lines don't change while paused
  // anyway, but the `paused` guard keeps the intent explicit rather than relying on that side effect).
  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, paused]);

  const classifiedLines = useMemo<DiagnosticsLine[]>(() => lines.map((text) => ({ text, level: detectLogLevel(text) })), [lines]);
  const visibleLines = useMemo(
    () => classifiedLines.filter((l) => !(l.level && hiddenLevels.has(l.level))),
    [classifiedLines, hiddenLevels],
  );

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

      <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search visible lines…"
            className="pl-8"
          />
        </div>
        <LevelFilterMenu hidden={hiddenLevels} onToggle={toggleLevel} />
        <Button variant={paused ? 'default' : 'secondary'} size="sm" onClick={handlePauseToggle} className="ml-auto">
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          {paused ? 'Resume' : 'Pause'}
        </Button>
      </div>

      <div
        ref={scrollRef}
        data-testid="diagnostics-log-box"
        className="h-96 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-[var(--font-mono)] text-xs leading-6 text-[var(--color-muted-foreground)]"
      >
        {visibleLines.length === 0 ? (
          <span className="text-[var(--color-muted-foreground)]">No log lines available.</span>
        ) : (
          visibleLines.map((line, i) => (
            <div key={i} className="flex gap-2 whitespace-pre-wrap break-all">
              {line.level ? (
                <Badge variant={LOG_LEVEL_BADGE[line.level].variant} className="h-4 shrink-0 px-1.5 py-0 text-[10px] leading-4">
                  {LOG_LEVEL_BADGE[line.level].label}
                </Badge>
              ) : (
                <span className="inline-block w-12 shrink-0" aria-hidden />
              )}
              <span className="flex-1">
                <HighlightedLine text={line.text} query={search} />
              </span>
            </div>
          ))
        )}
      </div>

      <div className="text-xs text-[var(--color-muted-foreground)]">
        {visibleLines.length} line{visibleLines.length === 1 ? '' : 's'}
        {hiddenLevels.size > 0 ? ` · ${hiddenLevels.size} level${hiddenLevels.size === 1 ? '' : 's'} hidden` : ''}
        {paused ? ' · paused' : ''}
      </div>
    </div>
  );
}
