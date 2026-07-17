import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';
import { api, type DriftEntry, type DriftKind } from '../api.service.js';

/** How often the banner re-polls `GET /api/drift` for the current pending-change report. */
const POLL_INTERVAL_MS = 30_000;

/** Per-category count of pending drift entries, keyed by {@link DriftKind}. */
type DriftCounts = Record<DriftKind, number>;

/** Tallies drift entries by their {@link DriftKind}. */
function countByKind(entries: DriftEntry[]): DriftCounts {
  const counts: DriftCounts = { pending_create: 0, pending_delete: 0, config_drift: 0 };
  for (const entry of entries) {
    counts[entry.kind] += 1;
  }
  return counts;
}

/**
 * Builds a stable signature for a drift report so a dismissal can be scoped
 * to "this exact set of findings" — when the underlying report changes (a
 * new pending change appears, or the counts shift), the signature changes
 * too and the banner reappears even though it was previously dismissed.
 */
function signatureFor(entries: DriftEntry[]): string {
  return entries
    .map((entry) => `${entry.game}:${entry.kind}:${(entry.changedFields ?? []).join(',')}`)
    .sort()
    .join('|');
}

/**
 * Persistent dashboard banner — "tfvars edited, n changes pending — run
 * `make apply` to materialize". Polls `GET /api/drift` (the `drift.get` IPC
 * channel) every 30s and is visible whenever the report has at least one
 * entry. See issue #101.
 *
 * - Hidden entirely while no drift is detected, or while the poll fails
 *   (transient IPC/network errors shouldn't flash a broken banner).
 * - Dismissing hides the banner for the current report only — the
 *   dismissal is keyed by a signature of the report's entries, so the next
 *   poll that returns a *different* report reinstates the banner even
 *   though the previous one was dismissed. Dismissal is in-memory only
 *   (component state), so it lasts for the current session and clears on
 *   reload.
 */
export function PendingChangesBanner() {
  const [entries, setEntries] = useState<DriftEntry[] | null>(null);
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null);

  const fetchDrift = useCallback(async (isCancelled: () => boolean) => {
    try {
      const report = await api.drift();
      if (isCancelled()) return;
      setEntries(report.entries);
    } catch {
      if (isCancelled()) return;
      setEntries(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void fetchDrift(() => cancelled);

    const intervalId = setInterval(() => {
      if (!cancelled) void fetchDrift(() => cancelled);
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [fetchDrift]);

  if (!entries || entries.length === 0) return null;

  const signature = signatureFor(entries);
  if (dismissedSignature === signature) return null;

  const counts = countByKind(entries);
  const total = entries.length;

  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-orange)]/40 bg-[var(--color-orange)]/10 px-4 py-3 text-sm text-[var(--color-orange)]"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        <span>
          tfvars edited, {total} change{total === 1 ? '' : 's'} pending — run{' '}
          <code className="font-[var(--font-mono)] text-xs">make apply</code> to materialize
          {' '}
          ({counts.pending_create} to create, {counts.pending_delete} to delete, {counts.config_drift} to update)
        </span>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <Link to="/games" className="underline-offset-4 hover:underline font-medium">
          View pending
        </Link>
        <button
          type="button"
          onClick={() => setDismissedSignature(signature)}
          aria-label="Dismiss pending changes banner"
          className="inline-flex items-center justify-center rounded-md p-1 hover:bg-[var(--color-orange)]/20"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
