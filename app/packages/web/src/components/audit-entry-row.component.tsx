import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AuditAction, AuditEntry } from '../api.service.js';
import { Badge } from '@/components/ui/badge.component';
import { Button } from '@/components/ui/button.component';
import { TableCell, TableRow } from '@/components/ui/table.component';
import { cn } from '@/lib/utils.utils';

/** Maps an {@link AuditAction} to the badge color variant used in the audit log. */
const ACTION_BADGE_VARIANT: Record<AuditAction, 'success' | 'warning' | 'destructive'> = {
  add: 'success',
  edit: 'warning',
  remove: 'destructive',
};

/** Format an ISO-8601 timestamp as a locale-aware date+time string, falling back to the raw value if unparseable. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Pretty-print a `before`/`after` config for the expanded diff view, or `'null'` when absent. */
function formatDiffValue(value: unknown): string {
  return value === null || value === undefined ? 'null' : JSON.stringify(value, null, 2);
}

/**
 * One row in the `/audit` table. Always shows the summary columns
 * (timestamp, actor, action, game, version id); clicking the row (or its
 * chevron) expands a second row underneath showing the raw `before`/`after`
 * JSON diff in two side-by-side `<pre>` blocks.
 */
export function AuditEntryRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((e) => !e);

  return (
    <>
      <TableRow
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        className="cursor-pointer"
      >
        <TableCell className="w-8">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            aria-label={expanded ? 'Collapse diff' : 'Expand diff'}
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
          >
            {expanded ? (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden="true" />
            )}
          </Button>
        </TableCell>
        <TableCell className="font-[var(--font-mono)] text-xs whitespace-nowrap">
          {formatTimestamp(entry.timestamp)}
        </TableCell>
        <TableCell>{entry.actor}</TableCell>
        <TableCell>
          <Badge variant={ACTION_BADGE_VARIANT[entry.action]} className="capitalize">
            {entry.action}
          </Badge>
        </TableCell>
        <TableCell className="capitalize">{entry.game}</TableCell>
        <TableCell className="font-[var(--font-mono)] text-xs text-[var(--color-muted-foreground)]">
          {entry.versionId ?? '—'}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="bg-[var(--color-surface-2)]/50">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-muted-foreground)]">
                  Before
                </div>
                <pre
                  className={cn(
                    'overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs',
                  )}
                >
                  {formatDiffValue(entry.before)}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-muted-foreground)]">
                  After
                </div>
                <pre
                  className={cn(
                    'overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs',
                  )}
                >
                  {formatDiffValue(entry.after)}
                </pre>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
