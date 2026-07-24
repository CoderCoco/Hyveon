import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, Play, RotateCcw, ShieldCheck } from 'lucide-react';
import type { RunDetailStatus, TerraformPlanPayload, TerraformRunChunk, TerraformRunRecord } from '@hyveon/desktop-preload';
import { Button } from '../components/ui/button.component.js';
import { Badge } from '../components/ui/badge.component.js';
import { AnsiLogViewer } from '../components/ansi-log-viewer.component.js';

/**
 * `location.state` shape the rollback flow (#112) navigates to `/terraform`
 * with, from a confirmed rollback in `/terraform/history` — see
 * `RollbackAction`. `tfvarsVersionId` is the freshly-restored head version to
 * plan against; `rolledBackFrom` is the apply run it was restored from, sent
 * straight through to `gsd.terraform.plan` so the resulting plan's persisted
 * record carries the same tag.
 */
interface RollbackNavState {
  tfvarsVersionId: string;
  rolledBackFrom: string;
}

/** Type guard for {@link RollbackNavState} — `location.state` is `unknown` until narrowed. */
function isRollbackNavState(state: unknown): state is RollbackNavState {
  return (
    typeof state === 'object' &&
    state !== null &&
    typeof (state as Partial<RollbackNavState>).tfvarsVersionId === 'string' &&
    typeof (state as Partial<RollbackNavState>).rolledBackFrom === 'string'
  );
}

/**
 * Mirrors `APPROVAL_WINDOW_MS` in `@hyveon/shared/runs.ts` — that constant is
 * the source of truth for how long the backend honors an approval before
 * `terraform.apply` rejects it. Duplicated here (rather than importing
 * `@hyveon/shared` into the renderer bundle) purely to drive the staleness
 * countdown; the backend's own check is what's actually authoritative.
 */
const APPROVAL_WINDOW_MS = 15 * 60 * 1000;

/** Mirrors `isApprovalExpired` in `@hyveon/shared/runs.ts` for the same reason as {@link APPROVAL_WINDOW_MS}. */
function isApprovalExpired(approvedAt: string, now: number): boolean {
  return now >= new Date(approvedAt).getTime() + APPROVAL_WINDOW_MS;
}

/** Mirrors `PLAN_SUMMARY_PATTERN` in `TerraformService.ts` — scans streamed plan output for the resource-change summary. */
const PLAN_SUMMARY_PATTERN = /Plan:\s*(\d+) to add,\s*(\d+) to change,\s*(\d+) to destroy\./;

/** Mirrors `APPLY_SUMMARY_PATTERN` in `TerraformService.ts` — scans streamed apply output for the resource-change summary. */
const APPLY_SUMMARY_PATTERN = /Apply complete!\s*Resources:\s*(\d+) added,\s*(\d+) changed,\s*(\d+) destroyed\./;

interface ChangeSummary {
  add: number;
  change: number;
  destroy: number;
}

/** Scans streamed `plan` output chunks for Terraform's `Plan: N to add, N to change, N to destroy.` summary line. */
function parsePlanSummary(chunks: TerraformRunChunk[]): ChangeSummary | null {
  for (const chunk of chunks) {
    const m = PLAN_SUMMARY_PATTERN.exec(chunk.line);
    if (m) return { add: Number(m[1]), change: Number(m[2]), destroy: Number(m[3]) };
  }
  return null;
}

/** Scans streamed `apply` output chunks for Terraform's `Apply complete! Resources: N added, N changed, N destroyed.` summary line. */
function parseApplySummary(chunks: TerraformRunChunk[]): ChangeSummary | null {
  for (const chunk of chunks) {
    const m = APPLY_SUMMARY_PATTERN.exec(chunk.line);
    if (m) return { add: Number(m[1]), change: Number(m[2]), destroy: Number(m[3]) };
  }
  return null;
}

/** Live state of a single streamed `terraform` run, backed by `gsd.terraform.runs.streamLogs`. */
interface RunLogState {
  chunks: TerraformRunChunk[];
  /** True once the stream's `for await` loop has completed — the run reached a terminal status (or the run was never attached). */
  ended: boolean;
}

/**
 * Attaches to `gsd.terraform.runs.streamLogs(runId)` for the lifetime of
 * `runId`, accumulating chunks in order. Mirrors `LogsPage`'s
 * `for await` + `AbortController`-in-a-ref streaming idiom. Re-attaches
 * automatically if `runId` changes; tears the previous subscription down
 * first.
 */
function useTerraformRunLog(runId: string | null): RunLogState {
  const [chunks, setChunks] = useState<TerraformRunChunk[]>([]);
  const [ended, setEnded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    setChunks([]);
    setEnded(false);

    if (!runId || !window.gsd) return;

    const ac = new AbortController();
    abortRef.current = ac;
    let cancelled = false;

    void (async () => {
      try {
        for await (const chunk of window.gsd!.terraform.runs.streamLogs(runId, ac.signal)) {
          if (cancelled) break;
          setChunks((prev) => [...prev, chunk]);
        }
      } catch {
        // The run's own failure is already visible in the accumulated log
        // output and surfaced via the follow-up `runs.get` status check —
        // nothing further to report here.
      } finally {
        if (!cancelled) setEnded(true);
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [runId]);

  return { chunks, ended };
}

/** Subcommand name a BUSY rejection reports as already holding the shared workspace. */
type Conflict = 'init' | 'plan' | 'apply' | 'destroy';

/** Lock banner shown when a plan/apply submission was rejected because the shared Terraform workspace is busy. */
function BusyBanner({ conflict }: { conflict: Conflict }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-amber)]/40 bg-[var(--color-amber)]/10 px-3 py-2 text-sm text-[var(--color-amber)]"
    >
      Workspace busy — a <code className="font-[var(--font-mono)]">terraform {conflict}</code> run is already in
      progress. Try again once it finishes.
    </div>
  );
}

/** Inline, non-conflict submission/approval error banner. Reused by the read-only history detail view. */
export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-[var(--radius-sm)] border border-[var(--color-red)]/40 bg-[var(--color-red)]/10 px-3 py-2 text-sm text-[var(--color-red)]"
    >
      {message}
    </div>
  );
}

/** Resource-change summary badges shared by the plan and apply views. */
function ChangeSummaryBadges({ summary }: { summary: ChangeSummary }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Badge variant="cyan">{summary.add} to add</Badge>
      <Badge variant="warning">{summary.change} to change</Badge>
      <Badge variant="destructive">{summary.destroy} to destroy</Badge>
    </div>
  );
}

/**
 * Terraform plan/apply route (`/terraform`) — lets an operator trigger
 * `terraform plan`, watch its live ANSI output, review the resource-change
 * summary, approve the plan, and run the plan-hash-gated `terraform apply`,
 * all over the `gsd.terraform.*` IPC surface shipped by epic #138. Surfaces
 * BUSY (shared-workspace conflict) and non-conflict submission errors inline
 * rather than failing silently.
 */
export function TerraformPage() {
  const location = useLocation();
  const rollbackState = isRollbackNavState(location.state) ? location.state : null;
  /** Guards against re-submitting the rollback plan if this component re-renders while the same `location.state` is still present. */
  const rollbackConsumedRef = useRef(false);

  const [planRunId, setPlanRunId] = useState<string | null>(null);
  const [planConflict, setPlanConflict] = useState<Conflict | null>(null);
  const [planSubmitError, setPlanSubmitError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);

  const [planStatus, setPlanStatus] = useState<RunDetailStatus | null>(null);
  const [planRecord, setPlanRecord] = useState<TerraformRunRecord | null>(null);

  const [approval, setApproval] = useState<{ approvedBy: string; approvedAt: string } | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  const [applyRunId, setApplyRunId] = useState<string | null>(null);
  const [applyConflict, setApplyConflict] = useState<Conflict | null>(null);
  const [applySubmitError, setApplySubmitError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const [applyStatus, setApplyStatus] = useState<RunDetailStatus | null>(null);

  const [now, setNow] = useState(() => Date.now());

  const planLog = useTerraformRunLog(planRunId);
  const applyLog = useTerraformRunLog(applyRunId);

  const planSummary = useMemo(() => parsePlanSummary(planLog.chunks), [planLog.chunks]);
  const applySummary = useMemo(() => parseApplySummary(applyLog.chunks), [applyLog.chunks]);

  // Tick every 30s so the approval-staleness hint stays roughly fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Once the plan's log stream ends, fetch its terminal status/record —
  // `awaiting_approval` is only derivable once the process has closed.
  useEffect(() => {
    if (!planRunId || !planLog.ended || !window.gsd) return;
    let cancelled = false;
    void (async () => {
      const result = await window.gsd!.terraform.runs.get(planRunId);
      if (cancelled) return;
      if (result.found) {
        setPlanStatus(result.status);
        setPlanRecord(result.record ?? null);
      } else {
        setPlanSubmitError(`Plan run "${planRunId}" could not be found after it finished.`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [planRunId, planLog.ended]);

  useEffect(() => {
    if (!applyRunId || !applyLog.ended || !window.gsd) return;
    let cancelled = false;
    void (async () => {
      const result = await window.gsd!.terraform.runs.get(applyRunId);
      if (cancelled) return;
      if (result.found) setApplyStatus(result.status);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyRunId, applyLog.ended]);

  const submitPlan = useCallback((payload?: TerraformPlanPayload) => {
    if (!window.gsd) {
      setPlanSubmitError('IPC bridge (window.gsd) is not available in this context.');
      return;
    }
    setPlanning(true);
    setPlanConflict(null);
    setPlanSubmitError(null);
    void (async () => {
      try {
        const ack = await window.gsd!.terraform.plan(payload);
        if (ack.started && ack.runId) {
          setPlanRunId(ack.runId);
          setPlanStatus(null);
          setPlanRecord(null);
          setApproval(null);
          setApproveError(null);
          setApplyRunId(null);
          setApplyStatus(null);
        } else {
          if (ack.conflict) setPlanConflict(ack.conflict);
          setPlanSubmitError(ack.error ?? 'terraform plan could not be started.');
        }
      } catch (err) {
        setPlanSubmitError(err instanceof Error ? err.message : String(err));
      } finally {
        setPlanning(false);
      }
    })();
  }, []);

  // Auto-submits the tagged rollback plan once, when arriving from a
  // confirmed rollback in history (see RollbackNavState) — the restore write
  // already happened before this navigation, so the plan just needs to run
  // against the new head with `rolledBackFrom` set for provenance.
  useEffect(() => {
    if (!rollbackState || rollbackConsumedRef.current) return;
    rollbackConsumedRef.current = true;
    submitPlan({ tfvarsVersionId: rollbackState.tfvarsVersionId, rolledBackFrom: rollbackState.rolledBackFrom });
  }, [rollbackState, submitPlan]);

  const submitApprove = useCallback(() => {
    if (!window.gsd || !planRunId) return;
    setApproving(true);
    setApproveError(null);
    void (async () => {
      try {
        const ack = await window.gsd!.terraform.approve({ planRunId });
        if (ack.approved && ack.approvedBy && ack.approvedAt) {
          setApproval({ approvedBy: ack.approvedBy, approvedAt: ack.approvedAt });
          toast.success('Plan approved');
        } else {
          setApproveError(ack.error ?? 'Approval failed.');
        }
      } catch (err) {
        setApproveError(err instanceof Error ? err.message : String(err));
      } finally {
        setApproving(false);
      }
    })();
  }, [planRunId]);

  const submitApply = useCallback(() => {
    if (!window.gsd || !planRunId || !planRecord?.planHash) return;
    setApplying(true);
    setApplyConflict(null);
    setApplySubmitError(null);
    void (async () => {
      try {
        const ack = await window.gsd!.terraform.apply({ planRunId, planHash: planRecord.planHash! });
        if (ack.started && ack.runId) {
          setApplyRunId(ack.runId);
          setApplyStatus(null);
        } else {
          if (ack.conflict) setApplyConflict(ack.conflict);
          setApplySubmitError(ack.error ?? 'terraform apply could not be started.');
        }
      } catch (err) {
        setApplySubmitError(err instanceof Error ? err.message : String(err));
      } finally {
        setApplying(false);
      }
    })();
  }, [planRunId, planRecord]);

  const startOver = useCallback(() => {
    setPlanRunId(null);
    setPlanStatus(null);
    setPlanRecord(null);
    setApproval(null);
    setApproveError(null);
    setApplyRunId(null);
    setApplyStatus(null);
    setApplySubmitError(null);
    setPlanSubmitError(null);
  }, []);

  useEffect(() => {
    if (applyStatus === 'success') toast.success('terraform apply complete');
  }, [applyStatus]);

  const awaitingApproval = planStatus === 'awaiting_approval';
  const planFinished = planStatus !== null;
  const planFailed = planStatus === 'failed' || planStatus === 'aborted';
  const approvalExpired = approval ? isApprovalExpired(approval.approvedAt, now) : false;
  const canApply = Boolean(approval) && !approvalExpired && Boolean(planRecord?.planHash) && !applyRunId;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Terraform</h2>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Plan, review, and apply infrastructure changes directly from the app.
          </p>
        </div>
        <Link
          to="/terraform/history"
          className="text-sm text-[var(--color-primary)] underline underline-offset-2"
        >
          View history
        </Link>
      </div>

      {!planRunId && (
        <div className="flex flex-col gap-3">
          <Button onClick={() => submitPlan()} disabled={planning}>
            {planning ? <Loader2 className="animate-spin" /> : <Play />}
            Run plan
          </Button>
          {planConflict && <BusyBanner conflict={planConflict} />}
          {planSubmitError && <ErrorBanner message={planSubmitError} />}
        </div>
      )}

      {planRunId && (
        <section className="flex flex-col gap-3" aria-label="Plan run">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-[var(--color-foreground)]">Plan</h3>
            {planSummary && <ChangeSummaryBadges summary={planSummary} />}
          </div>

          {planRecord?.rolledBackFrom && (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Rollback of{' '}
              <Link
                to={`/terraform/history/${planRecord.rolledBackFrom}`}
                className="text-[var(--color-primary)] underline underline-offset-2"
              >
                apply run {planRecord.rolledBackFrom}
              </Link>
            </p>
          )}

          <AnsiLogViewer chunks={planLog.chunks} emptyMessage="Waiting for plan output…" />

          {planFailed && (
            <ErrorBanner
              message={`terraform plan ${planStatus === 'aborted' ? 'was aborted' : 'failed'} — see the log above for details.`}
            />
          )}

          {planFinished && !planFailed && !approval && (
            <div className="flex flex-col gap-2">
              <Button onClick={submitApprove} disabled={approving || !awaitingApproval}>
                {approving ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                Approve plan
              </Button>
              {approveError && <ErrorBanner message={approveError} />}
            </div>
          )}

          {approval && (
            <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <p className="text-sm text-[var(--color-foreground)]">
                Approved by <strong>{approval.approvedBy}</strong> at{' '}
                {new Date(approval.approvedAt).toLocaleString()}
                {approvalExpired ? (
                  <span className="ml-2 text-[var(--color-amber)]">— approval expired, re-approve to apply</span>
                ) : (
                  <span className="ml-2 text-[var(--color-muted-foreground)]">
                    — expires {new Date(new Date(approval.approvedAt).getTime() + APPROVAL_WINDOW_MS).toLocaleTimeString()}
                  </span>
                )}
              </p>

              {approvalExpired && (
                <Button onClick={submitApprove} disabled={approving} variant="secondary" className="self-start">
                  {approving ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                  Re-approve
                </Button>
              )}

              {!applyRunId && (
                <div className="flex flex-col gap-2">
                  <Button onClick={submitApply} disabled={applying || !canApply} className="self-start">
                    {applying ? <Loader2 className="animate-spin" /> : <Play />}
                    Apply
                  </Button>
                  {applyConflict && <BusyBanner conflict={applyConflict} />}
                  {applySubmitError && <ErrorBanner message={applySubmitError} />}
                </div>
              )}
            </div>
          )}

          {applyRunId && (
            <section className="flex flex-col gap-3" aria-label="Apply run">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-[var(--color-foreground)]">Apply</h3>
                {applySummary && <ChangeSummaryBadges summary={applySummary} />}
              </div>

              <AnsiLogViewer chunks={applyLog.chunks} emptyMessage="Waiting for apply output…" />

              {applyStatus === 'failed' || applyStatus === 'aborted' ? (
                <ErrorBanner
                  message={`terraform apply ${applyStatus === 'aborted' ? 'was aborted' : 'failed'} — see the log above for details.`}
                />
              ) : null}

              {applyStatus === 'success' && (
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-green)]/40 bg-[var(--color-green)]/10 px-3 py-2 text-sm text-[var(--color-green)]"
                >
                  <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                  Apply complete.
                  <Link to="/" className="ml-1 underline underline-offset-2">
                    View dashboard
                  </Link>
                </div>
              )}
            </section>
          )}

          {(planFailed || applyStatus === 'success' || applyStatus === 'failed' || applyStatus === 'aborted') && (
            <Button onClick={startOver} variant="secondary" className="self-start">
              <RotateCcw />
              Start over
            </Button>
          )}
        </section>
      )}
    </div>
  );
}
