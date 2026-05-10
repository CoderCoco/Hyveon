import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Copy,
  FolderOpen,
  ScrollText,
  CircleCheck,
  CircleX,
  Loader2,
  AlertTriangle,
  PowerOff,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, type GameStatus, type GameEstimate } from '../api.service.js';
import { Card } from '@/components/ui/card.component';
import { Button } from '@/components/ui/button.component';
import { Badge } from '@/components/ui/badge.component';
import { cn } from '@/lib/utils.utils';
import { ConfirmDialog } from './confirm-dialog.component.js';
import { isSuppressed } from '../lib/confirm-skip.utils.js';

interface Props {
  status: GameStatus;
  estimate?: GameEstimate;
  onRefresh: (game: string) => void;
  onOpenFiles: (game: string) => void;
}

type ServerState = GameStatus['state'];

const STATE_LABELS: Record<ServerState, string> = {
  running:      'RUNNING',
  starting:     'STARTING',
  stopped:      'STOPPED',
  not_deployed: 'NOT DEPLOYED',
  error:        'ERROR',
};

/** Map a server state to the badge color variant. */
function badgeVariant(state: ServerState): 'success' | 'warning' | 'destructive' | 'secondary' {
  switch (state) {
    case 'running':      return 'success';
    case 'starting':     return 'warning';
    case 'not_deployed': return 'secondary';
    case 'stopped':      return 'secondary';
    case 'error':        return 'destructive';
  }
}

/** Map a server state to the icon shown next to the badge text. Always aria-hidden — the text label already conveys the state. */
function StateIcon({ state, className }: { state: ServerState; className?: string }) {
  const cls = cn('size-3', className);
  switch (state) {
    case 'running':      return <CircleCheck     className={cls} aria-hidden="true" />;
    case 'starting':     return <Loader2         className={cn(cls, 'motion-safe:animate-spin')} aria-hidden="true" />;
    case 'stopped':      return <PowerOff        className={cls} aria-hidden="true" />;
    case 'not_deployed': return <CircleX         className={cls} aria-hidden="true" />;
    case 'error':        return <AlertTriangle   className={cls} aria-hidden="true" />;
  }
}

/** Tailwind classes for the gradient accent rule that runs along the top of the card. */
function accentRuleClass(state: ServerState): string {
  switch (state) {
    case 'running':
      return 'bg-gradient-to-r from-[var(--color-cyan)] to-[var(--color-green)]';
    case 'starting':
      return 'bg-gradient-to-r from-[var(--color-orange)] to-[var(--color-amber)]';
    case 'error':
      return 'bg-[var(--color-red)]';
    case 'stopped':
    case 'not_deployed':
      return 'bg-[var(--color-border)]';
  }
}

/** Class for the small status dot in the badge — pulses when running, animates when starting. */
function dotClass(state: ServerState): string {
  switch (state) {
    case 'running':      return 'size-1.5 rounded-full bg-[var(--color-green)] shadow-[0_0_6px_var(--color-green)] animate-pulse';
    case 'starting':     return 'size-1.5 rounded-full bg-[var(--color-amber)] animate-pulse';
    case 'error':        return 'size-1.5 rounded-full bg-[var(--color-red)]';
    default:             return 'size-1.5 rounded-full bg-[var(--color-muted-foreground)]';
  }
}

/** Trim an ECS task ARN down to its 8-char short id (last segment of the ARN). */
function taskShortId(taskArn: string | undefined): string {
  if (!taskArn) return '—';
  const tail = taskArn.split('/').pop() ?? taskArn;
  return tail.slice(0, 8);
}

/** Human-readable label for the "Last run" stat: "Live" while running, "Booting" while starting, em-dash otherwise. */
function lastRunLabel(state: ServerState): string {
  switch (state) {
    case 'running':  return 'Live';
    case 'starting': return 'Booting';
    default:         return '—';
  }
}

interface StatRowProps {
  label: string;
  value: string;
  mono?: boolean;
}

function Stat({ label, value, mono }: StatRowProps) {
  return (
    <div>
      <div className="text-[0.65rem] uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1">
        {label}
      </div>
      <div className={cn('text-sm text-[var(--color-foreground)]', mono && 'font-[var(--font-mono)]')}>
        {value}
      </div>
    </div>
  );
}

/**
 * Card for a single game in the dashboard grid. Layout (top to bottom):
 *
 * 1. Gradient top-accent rule colored by state.
 * 2. Header — game name (Outfit 17/700) above hostname (DM Mono) with copy
 *    button, right-aligned status badge (icon + text + pulsing dot).
 * 3. 2×2 stats grid — Last run, Players, $/hr, Task short-id.
 * 4. Actions — Start / Stop primary (gradient) + Files / Logs secondary.
 *
 * After Start/Stop the card schedules a 3-second `onRefresh` to give the
 * backend time to pick up the ECS state change before re-polling
 * `/api/status/:game`.
 */
export function GameCard({ status, estimate, onRefresh, onOpenFiles }: Props) {
  const { game, state } = status;
  const [busy, setBusy] = useState(false);
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const [stateAnnouncement, setStateAnnouncement] = useState('');
  const prevStateRef = useRef(state);

  useEffect(() => {
    if (prevStateRef.current !== state) {
      setStateAnnouncement(`${game} server is now ${STATE_LABELS[state].toLowerCase()}`);
      prevStateRef.current = state;
    }
  }, [state, game]);

  const canStart = state === 'stopped' || state === 'not_deployed';
  const canStop  = state === 'running'  || state === 'starting';

  async function handleStart() {
    setBusy(true);
    try {
      await api.start(game);
      toast.success(`${game} is starting`);
    } catch (err) {
      toast.error(`Failed to start ${game}`, {
        description: err instanceof Error ? err.message : 'An unknown error occurred',
      });
    } finally {
      // Always schedule a refresh even on error — transient failures shouldn't
      // leave the card disabled until reload.
      setTimeout(() => { void onRefresh(game); setBusy(false); }, 3000);
    }
  }

  async function handleStop() {
    setBusy(true);
    try {
      await api.stop(game);
      toast(`${game} stopped`, {
        duration: 5000,
        action: {
          label: 'Undo',
          onClick: () => {
            void api.start(game)
              .then(() => setTimeout(() => onRefresh(game), 3000))
              .catch((err: unknown) => {
                toast.error(`Failed to undo stop of ${game}`, {
                  description: err instanceof Error ? err.message : 'An unknown error occurred',
                });
              });
          },
        },
      });
    } catch (err) {
      toast.error(`Failed to stop ${game}`, {
        description: err instanceof Error ? err.message : 'An unknown error occurred',
      });
    } finally {
      setTimeout(() => { void onRefresh(game); setBusy(false); }, 3000);
    }
  }

  const connectStr = status.hostname ?? status.publicIp ?? null;
  const playersLabel = '—';
  const costPerHourLabel = estimate ? `$${estimate.costPerHour.toFixed(3)}` : '—';

  return (
    <>
      <ConfirmDialog
        open={stopDialogOpen}
        onOpenChange={setStopDialogOpen}
        title={`Stop ${game}?`}
        description="Active sessions will end."
        confirmLabel="Stop server"
        confirmKey="stop-server"
        onConfirm={() => { void handleStop(); }}
      />
      <Card className="relative overflow-hidden p-0 flex flex-col">
        {/* Screen-reader announcement for state transitions */}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{stateAnnouncement}</span>

        {/* Top gradient accent rule */}
        <div className={cn('h-0.5 w-full', accentRuleClass(state))} aria-hidden="true" />

        {/* Header */}
        <div className="px-5 pt-4 pb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-[var(--font-ui)] text-[17px] font-bold capitalize leading-tight text-[var(--color-foreground)]">
              {game}
            </h2>
            <div className="mt-1 flex items-center gap-1.5 min-w-0">
              <span
                className={cn(
                  'font-[var(--font-mono)] text-xs truncate',
                  connectStr ? 'text-[var(--color-cyan-light)]' : 'text-[var(--color-muted-foreground)]',
                )}
              >
                {connectStr ?? 'no hostname'}
              </span>
              {connectStr && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-11 min-w-11 p-0 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                  onClick={() => void navigator.clipboard.writeText(connectStr)}
                  aria-label="Copy connect string"
                >
                  <Copy className="size-3" />
                </Button>
              )}
              {status.publicIp && status.hostname && (
                <span className="font-[var(--font-mono)] text-[0.65rem] text-[var(--color-muted-foreground)] truncate">
                  ({status.publicIp})
                </span>
              )}
            </div>
          </div>
          <Badge variant={badgeVariant(state)} className="shrink-0 gap-1.5 text-[0.65rem]">
            <span className={dotClass(state)} aria-hidden="true" />
            <StateIcon state={state} />
            {STATE_LABELS[state]}
          </Badge>
        </div>

        {/* 2x2 stats grid */}
        <div className="px-5 pb-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[var(--color-border)] pt-4">
          <Stat label="Last run" value={lastRunLabel(state)} />
          <Stat label="Players" value={playersLabel} />
          <Stat label="$ per hour" value={costPerHourLabel} />
          <Stat label="Task" value={taskShortId(status.taskArn)} mono />
        </div>

        {/* Actions */}
        <div className="px-5 pb-4 mt-auto flex flex-wrap gap-2">
          {canStart || !canStop ? (
            <Button
              variant="start"
              size="sm"
              onClick={() => void handleStart()}
              disabled={!canStart || busy}
              aria-busy={busy}
              aria-label={`Start ${game} server`}
              className="flex-1 min-w-[6rem] bg-gradient-to-r from-[var(--color-green)] to-[var(--color-cyan)] hover:brightness-110"
            >
              Start
            </Button>
          ) : (
            <Button
              variant="stop"
              size="sm"
              onClick={() => {
                if (isSuppressed('stop-server')) {
                  void handleStop();
                } else {
                  setStopDialogOpen(true);
                }
              }}
              disabled={!canStop || busy}
              aria-busy={busy}
              aria-label={`Stop ${game} server`}
              className="flex-1 min-w-[6rem] bg-gradient-to-r from-[var(--color-red)] to-[var(--color-pink)] hover:brightness-110"
            >
              Stop
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => onOpenFiles(game)}>
            <FolderOpen className="size-3.5" />
            Files
          </Button>
          <Button variant="secondary" size="sm" asChild>
            <Link to="/logs" state={{ game }} aria-label={`View logs for ${game}`}>
              <ScrollText className="size-3.5" />
              Logs
            </Link>
          </Button>
        </div>
      </Card>
    </>
  );
}
