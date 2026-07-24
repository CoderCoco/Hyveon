import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import type { RunHistoryRecord } from '@hyveon/desktop-preload';
import type { AnsiLogChunk } from '../components/ansi-log-viewer.component.js';
import { AnsiLogViewer } from '../components/ansi-log-viewer.component.js';
import { RunStatusBadge } from '../components/run-status-badge.component.js';
import { ErrorBanner } from './terraform.page.js';

/**
 * Number of the most recent run records searched for a `runId` match on
 * this page's direct-navigation/refresh path (see {@link useHistoryRecord}).
 * Mirrors the history list page's own client-side-kind-filter trade-off:
 * run volume at this project's scale is expected to stay well under this
 * ceiling, so a single page covers it without a dedicated get-by-id API.
 */
const LOOKUP_PAGE_SIZE = 200;

/** Resolves the {@link RunHistoryRecord} for `runId` by searching the most recent page of `gsd.terraform.runs.list`. */
function useHistoryRecord(runId: string | undefined): {
  record: RunHistoryRecord | null | undefined;
  loading: boolean;
} {
  const [record, setRecord] = useState<RunHistoryRecord | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setRecord(undefined);
    if (!runId || !window.gsd) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    window.gsd.terraform.runs
      .list({ limit: LOOKUP_PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setRecord(page.records.find((r) => r.runId === runId) ?? null);
      })
      .catch(() => {
        if (!cancelled) setRecord(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return { record, loading };
}

/** Splits raw log text into `AnsiLogChunk`s (one per line) so persisted log text can render through the same `AnsiLogViewer` streamed chunks use. */
function textToChunks(text: string): AnsiLogChunk[] {
  return text.split('\n').map((line) => ({ stream: 'stdout' as const, line }));
}

/** Which source a run-detail page's log ultimately resolved from — see the log-source ladder in `useRunLogLadder`. */
type LogSource = 'stream' | 'inline' | 'url' | 'none';

/**
 * Resolves a finished run's captured log via the fallback ladder: replay via
 * `gsd.terraform.runs.streamLogs` when local run artifacts still exist,
 * otherwise the persisted record's `logInline` text, otherwise a presigned
 * URL fetched via `gsd.terraform.runs.logUrl(record.logS3Key)`.
 */
function useRunLogLadder(runId: string | undefined, record: RunHistoryRecord | null | undefined): {
  chunks: AnsiLogChunk[];
  source: LogSource;
  loading: boolean;
} {
  const [chunks, setChunks] = useState<AnsiLogChunk[]>([]);
  const [source, setSource] = useState<LogSource>('none');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setChunks([]);
    setSource('none');
    if (!runId || !record || !window.gsd) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const streamed: AnsiLogChunk[] = [];
        for await (const chunk of window.gsd!.terraform.runs.streamLogs(runId)) {
          if (cancelled) return;
          streamed.push(chunk);
        }
        if (cancelled) return;
        if (streamed.length > 0) {
          setChunks(streamed);
          setSource('stream');
          return;
        }
      } catch {
        // Local run artifacts (<runsDir>/<runId>) are gone — fall through to
        // the persisted record's inline/offloaded log below.
      }
      if (cancelled) return;

      if (record.logInline) {
        setChunks(textToChunks(record.logInline));
        setSource('inline');
        return;
      }

      if (record.logS3Key) {
        try {
          const url = await window.gsd!.terraform.runs.logUrl(record.logS3Key);
          const res = await fetch(url);
          const text = await res.text();
          if (cancelled) return;
          setChunks(textToChunks(text));
          setSource('url');
        } catch {
          if (!cancelled) setSource('none');
        }
        return;
      }

      setSource('none');
    })().finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [runId, record]);

  return { chunks, source, loading };
}

/** Format an ISO-8601 timestamp as a locale-aware date+time string, falling back to the raw value if unparseable. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Read-only run-detail route (`/terraform/history/:runId`) — shows a single
 * persisted `terraform` run's status and captured log, reusing the live
 * Plan/Apply page's `AnsiLogViewer`/`ErrorBanner` components (issue #111).
 * Never offers Approve/Apply controls: every record in history describes a
 * finished (terminal) run — a `RunRecord` is only ever persisted once its
 * subcommand has closed.
 */
export function TerraformRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const { record, loading: recordLoading } = useHistoryRecord(runId);
  const { chunks, source, loading: logLoading } = useRunLogLadder(runId, record);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Run detail</h2>
          <p className="text-sm text-[var(--color-muted-foreground)]">{runId}</p>
        </div>
        <Link to="/terraform/history" className="text-sm text-[var(--color-primary)] underline underline-offset-2">
          Back to history
        </Link>
      </div>

      {recordLoading ? (
        <div className="flex h-32 items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)]">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading…
        </div>
      ) : !record ? (
        <ErrorBanner message={`No run history record was found for "${runId}".`} />
      ) : (
        <section className="flex flex-col gap-3" aria-label="Run detail">
          <div className="flex flex-wrap items-center gap-3">
            <span className="capitalize text-sm font-medium text-[var(--color-foreground)]">{record.kind}</span>
            <RunStatusBadge status={record.status} />
            <span className="text-xs text-[var(--color-muted-foreground)]">
              Started {formatTimestamp(record.startedAt)} — completed {formatTimestamp(record.completedAt)}
            </span>
          </div>

          {record.approvedBy && (
            <p className="text-sm text-[var(--color-foreground)]">
              Approved by <strong>{record.approvedBy}</strong>
              {record.approvedAt && <> at {formatTimestamp(record.approvedAt)}</>}
            </p>
          )}

          {logLoading ? (
            <div className="flex h-32 items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)]">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading log…
            </div>
          ) : (
            <>
              <AnsiLogViewer chunks={chunks} emptyMessage="No log is available for this run." />
              {source === 'none' && chunks.length === 0 && (
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  This run has no replayable, inline, or offloaded log.
                </p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
