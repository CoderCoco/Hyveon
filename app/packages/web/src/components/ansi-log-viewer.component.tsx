import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils.utils.js';

/** A single line of output from a streamed `terraform` subcommand run. Mirrors `TerraformRunChunk`. */
export interface AnsiLogChunk {
  stream: 'stdout' | 'stderr';
  line: string;
}

/** One SGR-styled run of text within a single log line. */
export interface AnsiSegment {
  text: string;
  bold: boolean;
  /** Tailwind text-color class for this run's foreground color, or `null` for the default. */
  colorClass: string | null;
}

/** Matches an SGR ("Select Graphic Rendition") ANSI escape sequence, e.g. `\x1b[1;32m`. */
// eslint-disable-next-line no-control-regex -- \x1b (ESC) is the literal byte terraform's colorized output uses to start every SGR sequence.
const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

/**
 * Maps the 16 standard SGR foreground color codes (30-37 normal, 90-97
 * bright) onto this app's existing `--color-*` design tokens — the closest
 * available token per hue, since the palette has no dedicated blue/yellow.
 */
const FG_COLOR_CLASS: Record<number, string> = {
  30: 'text-[var(--color-muted-foreground)]',
  31: 'text-[var(--color-red)]',
  32: 'text-[var(--color-green)]',
  33: 'text-[var(--color-amber)]',
  34: 'text-[var(--color-primary-light)]',
  35: 'text-[var(--color-pink)]',
  36: 'text-[var(--color-cyan)]',
  37: 'text-[var(--color-foreground)]',
  90: 'text-[var(--color-muted-foreground)]',
  91: 'text-[var(--color-red)]',
  92: 'text-[var(--color-green)]',
  93: 'text-[var(--color-amber)]',
  94: 'text-[var(--color-primary-light)]',
  95: 'text-[var(--color-pink)]',
  96: 'text-[var(--color-cyan-light)]',
  97: 'text-[var(--color-foreground)]',
};

/**
 * Parses a single line of `terraform` output containing SGR ANSI escape
 * codes into an ordered list of styled segments. Supports the subset
 * `terraform`'s own colorized output actually emits: the 16 standard
 * foreground colors, bold (`1`) / normal-intensity (`22`), and reset
 * (`0`/`39`). Unrecognized SGR codes are ignored rather than rejected, so an
 * unsupported sequence degrades to plain, unstyled text instead of throwing.
 */
export function parseAnsiLine(line: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let bold = false;
  let colorClass: string | null = null;
  let lastIndex = 0;

  const pattern = new RegExp(SGR_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const text = line.slice(lastIndex, match.index);
    if (text) segments.push({ text, bold, colorClass });

    const codes = match[1] === '' ? [0] : match[1]!.split(';').map(Number);
    for (const code of codes) {
      if (code === 0) {
        bold = false;
        colorClass = null;
      } else if (code === 1) {
        bold = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 39) {
        colorClass = null;
      } else if (code in FG_COLOR_CLASS) {
        colorClass = FG_COLOR_CLASS[code]!;
      }
    }
    lastIndex = pattern.lastIndex;
  }

  const rest = line.slice(lastIndex);
  if (rest || segments.length === 0) segments.push({ text: rest, bold, colorClass });
  return segments;
}

/** Props for {@link AnsiLogViewer}. */
export interface AnsiLogViewerProps {
  /** Ordered log chunks to render — appending to this array renders new lines below the existing ones. */
  chunks: AnsiLogChunk[];
  className?: string;
  /** Message shown in place of the log box while `chunks` is empty. */
  emptyMessage?: string;
}

/** Scroll distance (px) from the bottom within which the viewer still counts as "pinned to bottom". */
const BOTTOM_PIN_THRESHOLD_PX = 24;

/**
 * Renders streamed `terraform` output chunks as ANSI-colored HTML, in order,
 * inside a scrollable box.
 *
 * Auto-scrolls to the bottom as new chunks arrive. Scrolling away from the
 * bottom pauses auto-scroll until the user scrolls back down themselves —
 * genuine scroll-position detection (distinct from `LogsPage`'s explicit
 * Pause/Resume toggle), matching how a terminal typically behaves: stick to
 * the bottom unless the operator has manually scrolled up to read something.
 */
export function AnsiLogViewer({ chunks, className, emptyMessage = 'Waiting for output…' }: AnsiLogViewerProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  useEffect(() => {
    const el = boxRef.current;
    if (pinnedToBottom && el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chunks, pinnedToBottom]);

  function handleScroll() {
    const el = boxRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distanceFromBottom <= BOTTOM_PIN_THRESHOLD_PX);
  }

  return (
    <div
      ref={boxRef}
      onScroll={handleScroll}
      data-testid="ansi-log-viewer"
      className={cn(
        'min-h-[200px] max-h-[480px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-[var(--font-mono)] text-xs leading-6 text-[var(--color-muted-foreground)]',
        className,
      )}
    >
      {chunks.length === 0 ? (
        <div className="text-[var(--color-muted-foreground)]">{emptyMessage}</div>
      ) : (
        chunks.map((chunk, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {parseAnsiLine(chunk.line).map((seg, j) => (
              <span key={j} className={cn(seg.colorClass, seg.bold && 'font-bold')}>
                {seg.text}
              </span>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
