import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import type { RunHistoryRecord, RunHistoryStatus, TerraformRunKind } from '@hyveon/desktop-preload';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.component.js';
import { Button } from '../components/ui/button.component.js';
import { Badge } from '../components/ui/badge.component.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.component.js';
import { RunStatusBadge } from '../components/run-status-badge.component.js';
import { RollbackAction, type RollbackResult } from '../components/rollback-action.component.js';

/** Number of run records fetched per page (initial load and each "Load more"). */
const PAGE_SIZE = 25;

/** `kind` filter options, `'all'` meaning no filter is applied. */
type KindFilter = TerraformRunKind | 'all';

/** `status` filter options, `'all'` meaning no filter is applied (i.e. the unfiltered `terraform.runs.list` path). */
type StatusFilter = RunHistoryStatus | 'all';

/** Format an ISO-8601 timestamp as a locale-aware date+time string, falling back to the raw value if unparseable. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Terraform run-history route (`/terraform/history`) — a newest-first table
 * of persisted `terraform` plan/apply/destroy runs backed by
 * `gsd.terraform.runs.list` (issue #111). Supports `kind`/`status` filters
 * and cursor-based "Load more" pagination; clicking a row's kind opens the
 * read-only run-detail view at `/terraform/history/:runId`.
 *
 * Per the design doc, `status` filtering is server-side (the `status-index`
 * GSI), while `kind` filtering is applied client-side to the fetched page —
 * run volume at this project's scale is tiny, so a kind-filtered page can
 * render fewer rows than {@link PAGE_SIZE} without needing a dedicated index.
 */
export function TerraformHistoryPage() {
  const navigate = useNavigate();
  const [records, setRecords] = useState<RunHistoryRecord[]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  /**
   * Monotonically-increasing request generation counter. `loadMore`'s fetch
   * isn't tied to the filter effect below, so without this a "Load more"
   * click followed by a filter change could resolve after the filter effect
   * has already reset `records` — appending a stale-filter page onto the
   * fresh list. Each in-flight request captures the counter's value at
   * dispatch time and only applies its result if it's still current.
   */
  const requestSeqRef = useRef(0);

  useEffect(() => {
    if (!window.gsd) {
      setLoading(false);
      setError('IPC bridge (window.gsd) is not available in this context.');
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    window.gsd.terraform.runs
      .list({ limit: PAGE_SIZE, status: statusFilter === 'all' ? undefined : statusFilter })
      .then((page) => {
        if (requestSeqRef.current !== seq) return;
        setRecords(page.records);
        setNextBefore(page.nextBefore);
      })
      .catch(() => {
        if (requestSeqRef.current === seq) setError('Could not load the run history.');
      })
      .finally(() => {
        if (requestSeqRef.current === seq) setLoading(false);
      });
  }, [statusFilter]);

  const loadMore = useCallback(() => {
    if (!nextBefore || !window.gsd) return;
    const seq = ++requestSeqRef.current;
    setLoadingMore(true);
    setError(null);
    window.gsd.terraform.runs
      .list({ limit: PAGE_SIZE, before: nextBefore, status: statusFilter === 'all' ? undefined : statusFilter })
      .then((page) => {
        if (requestSeqRef.current !== seq) return;
        setRecords((prev) => [...prev, ...page.records]);
        setNextBefore(page.nextBefore);
      })
      .catch(() => {
        if (requestSeqRef.current === seq) setError('Could not load more run history.');
      })
      .finally(() => {
        if (requestSeqRef.current === seq) setLoadingMore(false);
      });
  }, [nextBefore, statusFilter]);

  const visibleRecords = kindFilter === 'all' ? records : records.filter((r) => r.kind === kindFilter);

  /** Routes a confirmed rollback into the plan/apply run view — see `TerraformPage`'s `RollbackNavState`. */
  const handleRolledBack = useCallback(
    ({ versionId, rolledBackFrom }: RollbackResult) => {
      navigate('/terraform', { state: { tfvarsVersionId: versionId, rolledBackFrom } });
    },
    [navigate],
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Run History</h2>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Past `terraform` plan, apply, and destroy runs.
          </p>
        </div>
        <Link to="/terraform" className="text-sm text-[var(--color-primary)] underline underline-offset-2">
          Back to Plan/Apply
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
          Kind
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as KindFilter)}
            className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-foreground)]"
          >
            <option value="all">All</option>
            <option value="plan">Plan</option>
            <option value="apply">Apply</option>
            <option value="destroy">Destroy</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
          Status
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-foreground)]"
          >
            <option value="all">All</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
            <option value="aborted">Aborted</option>
          </select>
        </label>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)]">
            Recent runs
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex h-32 items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)]">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading…
            </div>
          ) : error && records.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-[var(--color-red)]">{error}</div>
          ) : visibleRecords.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-[var(--color-muted-foreground)]">
              No runs match the current filters.
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kind</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Completed</TableHead>
                    <TableHead>Approver</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRecords.map((record) => (
                    <TableRow key={record.sk}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/terraform/history/${record.runId}`}
                            className="capitalize text-[var(--color-primary)] underline underline-offset-2"
                          >
                            {record.kind}
                          </Link>
                          {record.rolledBackFrom && (
                            <Badge variant="cyan" title={`Rollback of apply run ${record.rolledBackFrom}`}>
                              rollback
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <RunStatusBadge status={record.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{formatTimestamp(record.startedAt)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{formatTimestamp(record.completedAt)}</TableCell>
                      <TableCell className="text-xs">{record.approvedBy ?? '—'}</TableCell>
                      <TableCell>
                        {record.kind === 'apply' && record.tfvarsVersionId !== undefined && (
                          <RollbackAction applyRunId={record.runId} onRolledBack={handleRolledBack} />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {error && <p className="mt-3 text-xs text-[var(--color-red)]">{error}</p>}

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
