import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Filter, Pause, Play, Search } from 'lucide-react';
import type { HyveonStreamHandle, LogChunk } from '@hyveon/desktop-preload';
import { api } from '../api.service.js';
import { Badge } from '../components/ui/badge.component.js';
import { Button } from '../components/ui/button.component.js';
import { Input } from '../components/ui/input.component.js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from '../components/ui/dropdown-menu.component.js';
import { GameCombobox } from '../components/game-combobox.component.js';
import { cn } from '../lib/utils.utils.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { ALL_LOG_LEVELS, LOG_LEVEL_BADGE, detectLogLevel, type LogLevel } from '../lib/log-level.utils.js';

const MAX_LINES = 1000;
const AGE_TICK_MS = 10_000;

interface LogLine {
  text: string;
  level: LogLevel | null;
  receivedAt: number;
}

/** Shape of the react-router navigation state `GameCard` passes via `<Link to="/logs" state={{ game }}>`. */
interface LogsNavState {
  game?: string;
}

/**
 * Reads the `game` field off a react-router `location.state` value, if
 * present and a string. `location.state` is typed `unknown` by react-router,
 * so this narrows it defensively rather than trusting an unchecked cast.
 */
function gameFromLocationState(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const game = (state as LogsNavState).game;
  return typeof game === 'string' ? game : null;
}

/** Format a millisecond age as a compact "Xs ago" / "Xm ago" / "Xh ago" string. */
function formatAge(ms: number): string {
  if (ms < 1000) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/** Render a single line, splitting on case-insensitive search matches. */
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
          <mark
            key={idx}
            className="rounded-[2px] bg-[var(--color-amber)]/40 px-[1px] text-[var(--color-foreground)]"
          >
            {p.text}
          </mark>
        ) : (
          <span key={idx}>{p.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Logs route (`/logs`) — full-page tailing of CloudWatch logs for a single
 * game. Fetches an initial snapshot via `window.hyveon.logs.get`, then consumes
 * a live IPC stream via `for await (… of window.hyveon.logs.stream(game))`,
 * cancelling by calling the returned {@link HyveonStreamHandle}'s `cancel()`.
 * Surfaces the stream through:
 *
 *   - Initial game selection: preselects the game named in the incoming
 *     `location.state.game` (set by `GameCard`'s "Logs" link) once the games
 *     list resolves, provided that game is actually present in the list;
 *     otherwise falls back to the first game in the list.
 *   - A LIVE/PAUSED status badge (pulsing cyan / muted slate).
 *   - A searchable game selector that resets the buffer on switch.
 *   - Per-line color-coded level badges (INFO/WARN/ERROR/DEBUG) detected via
 *     a simple word-boundary regex; falls back to plain text if not detected.
 *   - An in-stream search input that highlights matches in the visible buffer
 *     without filtering them out.
 *   - A multi-select level filter that hides whole levels (default: all on).
 *   - An autoscroll toggle (default on; off freezes scroll position).
 *   - A footer summary: line count + age of the oldest visible line.
 *
 * Pause buffers incoming lines; Resume flushes the buffer into the visible
 * stream — same behaviour as the previous panel.
 */
export function LogsPage() {
  const location = useLocation();
  // Captured once on mount — the game named in the incoming navigation state
  // (e.g. a GameCard's "Logs" link), used only to pick the *initial* selected
  // game once the list resolves. Kept in a ref (not a dependency) so later
  // location changes on this same route instance never re-trigger the
  // preselection logic and fight a selection the user has since made.
  const preselectedGameRef = useRef(gameFromLocationState(location.state));
  const [games, setGames] = useState<string[]>([]);
  const [selectedGame, setSelectedGame] = useState<string>('');
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const [search, setSearch] = useState('');
  const [hiddenLevels, setHiddenLevels] = useState<Set<LogLevel>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lazy initialiser: `useState(Date.now())` would read the clock on every
  // render (the value is discarded after the first), which makes the render
  // impure. The function form is only invoked on mount.
  const [now, setNow] = useState(() => Date.now());
  const [bufferedCount, setBufferedCount] = useState(0);

  const boxRef = useRef<HTMLDivElement>(null);
  /** The in-flight log stream handle; calling `cancel()` on it also tells the main process to stop tailing. */
  const streamRef = useRef<HyveonStreamHandle<LogChunk> | null>(null);
  const pausedRef = useRef(false);
  const bufferRef = useRef<LogLine[]>([]);

  const appendLine = useCallback((text: string) => {
    const entry: LogLine = { text, level: detectLogLevel(text), receivedAt: Date.now() };
    if (pausedRef.current) {
      bufferRef.current.push(entry);
      setBufferedCount(bufferRef.current.length);
      return;
    }
    setLines((prev) => {
      const next = [...prev, entry];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.cancel();
    streamRef.current = null;
  }, []);

  const startStream = useCallback(
    (game: string) => {
      if (!window.hyveon) {
        setError('IPC bridge (window.hyveon) is not available in this context.');
        return;
      }
      stopStream();
      const handle = window.hyveon.logs.stream(game);
      streamRef.current = handle;

      void (async () => {
        try {
          for await (const chunk of handle) {
            appendLine(chunk);
          }
        } catch (err: unknown) {
          // `cancel()` completes the iteration normally (no throw) — a thrown
          // error here is a genuine stream failure. Still, ignore it if this
          // stream has since been superseded (or torn down) by a newer call,
          // whose own error/success state has already taken over the UI.
          if (streamRef.current !== handle) return;
          const message = err instanceof Error ? err.message : String(err);
          setError(`Stream ended with error: ${message}`);
        }
      })();
    },
    [stopStream, appendLine],
  );

  const handlePauseToggle = useCallback(() => {
    const nowPaused = !pausedRef.current;
    pausedRef.current = nowPaused;
    setPaused(nowPaused);
    if (!nowPaused && bufferRef.current.length > 0) {
      const buffered = bufferRef.current;
      bufferRef.current = [];
      setBufferedCount(0);
      setLines((prev) => {
        const next = [...prev, ...buffered];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    }
  }, []);

  /**
   * Switch the tailed game, clearing everything that described the previous
   * one: rendered lines, the paused-while-buffering queue, the paused flag
   * and any stream error. The subsequent `selectedGame` effect re-seeds and
   * re-subscribes.
   */
  const selectGame = useCallback((game: string) => {
    setSelectedGame(game);
    setLines([]);
    bufferRef.current = [];
    setBufferedCount(0);
    pausedRef.current = false;
    setPaused(false);
    setError(null);
  }, []);

  // Load the games list once (this page is reachable independently of the dashboard).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.games();
        if (cancelled) return;
        const names = res.games.map((g) => g.name);
        setGames(names);
        if (names.length > 0) {
          const preselected = preselectedGameRef.current;
          const initial = preselected && names.includes(preselected) ? preselected : names[0]!;
          setSelectedGame((cur) => cur || initial);
        }
      } catch {
        if (!cancelled) setError('Could not load games.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // (Re)start the stream when the game changes. The buffer/paused/error reset
  // that used to open this effect now lives in `selectGame` below: clearing
  // the previous game's view is a consequence of the user picking a new one,
  // so it belongs in that event handler rather than in an effect reacting to
  // the state change afterwards (`react-hooks/set-state-in-effect`).
  useEffect(() => {
    if (!selectedGame) return;

    let cancelled = false;
    void (async () => {
      if (!window.hyveon) {
        if (!cancelled) setError('IPC bridge (window.hyveon) is not available in this context.');
        return;
      }
      try {
        const data = await window.hyveon.logs.get(selectedGame);
        if (cancelled) return;
        const seeded: LogLine[] = data.lines.map((text) => ({
          text,
          level: detectLogLevel(text),
          receivedAt: Date.now(),
        }));
        setLines(seeded);
        startStream(selectedGame);
      } catch {
        if (!cancelled) {
          setError('Could not load initial logs; trying live stream.');
          startStream(selectedGame);
        }
      }
    })();

    return () => {
      cancelled = true;
      stopStream();
    };
  }, [selectedGame, startStream, stopStream]);

  // Tick the "age" footer so it stays roughly fresh without re-rendering on every line.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Autoscroll: only stick to the bottom when both the toggle is on and we're
  // not paused. Turning autoscroll off freezes the current scroll position.
  useEffect(() => {
    if (autoscroll && !paused && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [lines, autoscroll, paused]);

  const visibleLines = useMemo(
    () => lines.filter((l) => !(l.level && hiddenLevels.has(l.level))),
    [lines, hiddenLevels],
  );

  const oldest = visibleLines[0];
  const ageLabel = oldest ? formatAge(now - oldest.receivedAt) : null;

  const toggleLevel = (lvl: LogLevel) => {
    setHiddenLevels((prev) => {
      const next = new Set(prev);
      if (next.has(lvl)) next.delete(lvl);
      else next.add(lvl);
      return next;
    });
  };

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4">
      {/* Header — title + LIVE/PAUSED badge */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Server Logs</h2>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            CloudWatch tail for the selected game. Pause to inspect; resume to flush the buffer.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <PollingIndicator />
          <LiveBadge paused={paused} />
        </div>
      </div>

      {/* Controls row */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          {/* Game selector — always visible */}
          <GameCombobox games={games} value={selectedGame} onChange={selectGame} />

          {/* Filter toggle — only on mobile (md:hidden) */}
          <Button
            variant="secondary"
            size="sm"
            className="md:hidden min-h-11"
            onClick={() => setFiltersOpen((o) => !o)}
            aria-expanded={filtersOpen}
          >
            <Filter className="h-3.5 w-3.5" />
            Filters
            {hiddenLevels.size > 0 && (
              <span className="ml-1 text-[var(--color-primary-light)]">({hiddenLevels.size} hidden)</span>
            )}
          </Button>

          {/* Desktop: inline filter controls — hidden on mobile (hidden md:contents) */}
          <div className="hidden md:contents">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search visible buffer…"
                className="pl-8"
              />
            </div>
            <LevelFilterMenu hidden={hiddenLevels} onToggle={toggleLevel} />
            <label className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm text-[var(--color-foreground)]">
              <input
                type="checkbox"
                checked={autoscroll}
                onChange={(e) => setAutoscroll(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--color-primary)]"
              />
              Autoscroll
            </label>
          </div>

          {/* Pause/Resume — always visible, pushed to the right */}
          <Button
            variant={paused ? 'default' : 'secondary'}
            size="sm"
            onClick={handlePauseToggle}
            className="ml-auto"
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </div>

        {/* Mobile collapsible filter drawer */}
        {filtersOpen && (
          <div
            id="logs-filters"
            className="md:hidden flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
          >
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search visible buffer…"
                className="pl-8 w-full"
              />
            </div>
            <LevelFilterMenu hidden={hiddenLevels} onToggle={toggleLevel} />
            <label className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm text-[var(--color-foreground)]">
              <input
                type="checkbox"
                checked={autoscroll}
                onChange={(e) => setAutoscroll(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--color-primary)]"
              />
              Autoscroll
            </label>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-red)]/40 bg-[var(--color-red)]/10 px-3 py-2 text-sm text-[var(--color-red)]">
          {error}
        </div>
      )}

      {/* Log stream */}
      <div
        ref={boxRef}
        className="min-h-[300px] flex-1 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-[var(--font-mono)] text-xs leading-6 text-[var(--color-muted-foreground)]"
      >
        {visibleLines.length === 0 ? (
          <div className="text-[var(--color-muted-foreground)]">
            {selectedGame ? 'Waiting for log lines…' : 'Select a game to start tailing.'}
          </div>
        ) : (
          visibleLines.map((line, i) => (
            <div key={i} className="flex gap-2 whitespace-pre-wrap break-all">
              {line.level ? (
                <Badge
                  variant={LOG_LEVEL_BADGE[line.level].variant}
                  className="h-4 shrink-0 px-1.5 py-0 text-[10px] leading-4"
                >
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

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
        <span>
          {visibleLines.length} line{visibleLines.length === 1 ? '' : 's'}
          {ageLabel ? ` · oldest ${ageLabel}` : ''}
          {hiddenLevels.size > 0 ? ` · ${hiddenLevels.size} level${hiddenLevels.size === 1 ? '' : 's'} hidden` : ''}
        </span>
        <span className="font-[var(--font-mono)]">
          {paused && bufferedCount > 0 ? `buffered ${bufferedCount}` : ''}
        </span>
      </div>
    </div>
  );
}

/** Pill that flips between pulsing-cyan LIVE and muted-slate PAUSED. */
function LiveBadge({ paused }: { paused: boolean }) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wider',
        paused
          ? 'border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-muted-foreground)]'
          : 'border-[var(--color-cyan)]/40 bg-[var(--color-cyan)]/10 text-[var(--color-cyan)]',
      )}
    >
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          paused ? 'bg-[var(--color-muted-foreground)]' : 'bg-[var(--color-cyan)] animate-pulse',
        )}
      />
      {paused ? 'Paused' : 'Live'}
    </div>
  );
}

/** Multi-select dropdown for hiding log levels. Default: nothing hidden. */
function LevelFilterMenu({
  hidden,
  onToggle,
}: {
  hidden: Set<LogLevel>;
  onToggle: (lvl: LogLevel) => void;
}) {
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
          <DropdownMenuCheckboxItem
            key={lvl}
            checked={!hidden.has(lvl)}
            onCheckedChange={() => onToggle(lvl)}
            onSelect={(e) => e.preventDefault()}
          >
            <Badge
              variant={LOG_LEVEL_BADGE[lvl].variant}
              className="h-4 px-1.5 py-0 text-[10px] leading-4"
            >
              {LOG_LEVEL_BADGE[lvl].label}
            </Badge>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
