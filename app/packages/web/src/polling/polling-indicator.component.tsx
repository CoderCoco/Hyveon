import { RefreshCw } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip.component';
import { cn } from '@/lib/utils.utils';
import { isStale, usePollingState, type PollerState } from './polling-provider.component.js';

interface Props {
  /** Name of the poller in the registry to surface. Defaults to "status". */
  name?: string;
  className?: string;
}

/**
 * "Updated 3s ago" label with a rotating refresh icon that spins while the
 * poller is in-flight. On hover, shows the next-poll countdown. After 2× the
 * interval without a success, switches to a red "Stale" pill that auto-clears
 * on the next successful poll.
 */
export function PollingIndicator({ name = 'status', className }: Props) {
  const { pollers, tick } = usePollingState();
  const state = pollers[name];

  // Reading `tick` keeps the relative-time labels updating once a second
  // without each indicator instance running its own setInterval.
  const now = Date.now();
  void tick;

  if (!state) {
    return (
      <div className={cn('text-xs text-[var(--color-muted-foreground)]', className)}>
        <span>Not polling</span>
      </div>
    );
  }

  const stale = isStale(state, now);

  if (stale) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-red)]/40 bg-[var(--color-red)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-red)]',
          className,
        )}
      >
        {/* Stable text for AT — only changes on stale transition, not every tick */}
        <span className="sr-only">
          {`Polling data is stale${state.lastSuccessAt ? ` — last updated at ${new Date(state.lastSuccessAt).toLocaleTimeString()}` : ''}`}
        </span>
        <span className="size-1.5 rounded-full bg-[var(--color-red)]" aria-hidden="true" />
        <span aria-hidden="true">Stale · last updated {formatAgo(state.lastSuccessAt, now)}</span>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role="status"
            aria-live="polite"
            className={cn(
              'inline-flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]',
              className,
            )}
          >
            {/* Stable text for AT — only changes when lastSuccessAt changes, not every tick */}
            <span className="sr-only">
              {state.lastSuccessAt
                ? `Data updated at ${new Date(state.lastSuccessAt).toLocaleTimeString()}`
                : 'Awaiting first poll'}
            </span>
            <RefreshCw
              className={cn(
                'size-3 text-[var(--color-cyan)]',
                state.loading && 'motion-safe:animate-spin',
              )}
              aria-hidden="true"
            />
            <span aria-hidden="true">Updated {formatAgo(state.lastSuccessAt, now)}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {nextRefreshLabel(state, now)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Format an absolute timestamp as "Xs ago" / "Xm ago" / "—" (when unset).
 * We keep this sub-minute resolution since the poll interval is 20s.
 */
function formatAgo(ts: number | null, now: number): string {
  if (ts === null) return '—';
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  return `${min}m ago`;
}

/** Build the "next refresh in X" tooltip body, falling back to "scheduled" while we wait for the first attempt. */
function nextRefreshLabel(state: PollerState, now: number): string {
  if (state.lastAttemptAt === null) return 'next refresh scheduled';
  const elapsed = now - state.lastAttemptAt;
  const remaining = Math.max(0, state.intervalMs - elapsed);
  const sec = Math.round(remaining / 1000);
  return `next refresh in ${sec}s`;
}
