import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, type AuditEntry } from '../api.service.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.component';
import { Button } from '@/components/ui/button.component';
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.component';
import { AuditEntryRow } from '../components/audit-entry-row.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';

/** Number of audit entries fetched per page (initial load and each "Load more"). */
const PAGE_SIZE = 25;

/**
 * Audit log route (`/audit`). Fetches the newest {@link PAGE_SIZE} entries on
 * mount, renders them as expandable rows (see {@link AuditEntryRow}) showing
 * the before/after `terraform.tfvars` diff for each mutation, and paginates
 * older entries via a "Load more" button that passes the previous page's
 * `nextBefore` cursor back to `api.audit()`.
 */
export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .audit({ limit: PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setEntries(page.entries);
        setNextBefore(page.nextBefore);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the audit log.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMore = useCallback(() => {
    if (!nextBefore) return;
    setLoadingMore(true);
    setError(null);
    api
      .audit({ limit: PAGE_SIZE, before: nextBefore })
      .then((page) => {
        setEntries((prev) => [...prev, ...page.entries]);
        setNextBefore(page.nextBefore);
      })
      .catch(() => {
        setError('Could not load more audit entries.');
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [nextBefore]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Audit Log</h2>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Who changed which game&apos;s configuration, and what changed.
          </p>
        </div>
        <PollingIndicator />
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)]">
            Recent changes
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex h-32 items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)]">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading…
            </div>
          ) : error && entries.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-[var(--color-red)]">
              {error}
            </div>
          ) : entries.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-[var(--color-muted-foreground)]">
              No audit entries yet.
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Game</TableHead>
                    <TableHead>Version</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => (
                    <AuditEntryRow key={entry.sk} entry={entry} />
                  ))}
                </TableBody>
              </Table>

              {error && (
                <p className="mt-3 text-xs text-[var(--color-red)]">{error}</p>
              )}

              {nextBefore && (
                <div className="mt-4 flex justify-center">
                  <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                        Loading…
                      </>
                    ) : (
                      'Load more'
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
