import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';
import { api, type DriftEntry, type DriftKind } from '../api.service.js';

/** How often the banner re-polls `GET /api/drift` for the current pending-change report. */
const POLL_INTERVAL_MS = 30_000;

/**
 * `sessionStorage` key used to persist the dismissed report's signature so
 * the dismissal survives Dashboard \<-\> Games navigation (which unmounts and
 * remounts this component) without leaking across browser sessions.
 */
const DISMISSED_SIGNATURE_STORAGE_KEY = 'hyveon.pendingChangesBanner.dismissedSignature';

/** Reads the persisted dismissed signature, tolerating unavailable/blocked storage. */
function readDismissedSignature(): string | null {
  try {
    return sessionStorage.getItem(DISMISSED_SIGNATURE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persists (or clears, when `signature` is `null`) the dismissed signature. */
function writeDismissedSignature(signature: string | null): void {
  try {
    if (signature === null) {
      sessionStorage.removeItem(DISMISSED_SIGNATURE_STORAGE_KEY);
    } else {
      sessionStorage.setItem(DISMISSED_SIGNATURE_STORAGE_KEY, signature);
    }
  } catch {
    // sessionStorage unavailable (e.g. privacy mode) — dismissal just won't persist.
  }
}

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
 *   though the previous one was dismissed. The dismissal is persisted in
 *   `sessionStorage` (not component state), so it survives Dashboard
 *   \<-\> Games navigation — which unmounts and remounts this component — while
 *   still clearing on tab close/reload. A poll that returns a clean (empty)
 *   report clears the stored dismissal outright, so a later recurrence of
 *   the same signature isn't silently swallowed.
 */
export function PendingChangesBanner() {
  const [entries, setEntries] = useState<DriftEntry[] | null>(null);
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(() =>
    readDismissedSignature(),
  );

  /**
   * Monotonically increasing id for the in-flight `api.drift()` request.
   * `setInterval` can fire a new poll while a previous one is still
   * pending; comparing against this ref before calling `setEntries`
   * ensures an older response that resolves late can never clobber a
   * newer one (stale counts / a resurrected dismissed banner).
   */
  const latestRequestIdRef = useRef(0);

  const fetchDrift = useCallback(async (isCancelled: () => boolean) => {
    const requestId = ++latestRequestIdRef.current;
    try {
      const report = await api.drift();
      if (isCancelled() || requestId !== latestRequestIdRef.current) return;
      setEntries(report.entries);
      if (report.entries.length === 0) {
        // Clean report — clear any stored dismissal so a later recurrence
        // of an identical signature isn't mistaken for one already seen.
        writeDismissedSignature(null);
        setDismissedSignature(null);
      }
    } catch {
      if (isCancelled() || requestId !== latestRequestIdRef.current) return;
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
          onClick={() => {
            writeDismissedSignature(signature);
            setDismissedSignature(signature);
          }}
          aria-label="Dismiss pending changes banner"
          className="inline-flex items-center justify-center rounded-md p-1 hover:bg-[var(--color-orange)]/20"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
