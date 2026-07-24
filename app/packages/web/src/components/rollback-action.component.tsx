import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from './ui/button.component.js';
import { ConfirmDialog } from './confirm-dialog.component.js';

/** Result of a confirmed rollback, handed to {@link RollbackActionProps.onRolledBack}. */
export interface RollbackResult {
  /** The freshly-restored tfvars version, to plan against. */
  versionId: string;
  /** The apply run the restored version was resolved from — tags the resulting plan. */
  rolledBackFrom: string;
}

interface RollbackActionProps {
  /** The `runId` of the apply run to roll back. */
  applyRunId: string;
  /** Called once the rollback is confirmed and the historic tfvars version has been restored as the new head. */
  onRolledBack: (result: RollbackResult) => void;
}

/** Format an ISO-8601 timestamp as a locale-aware date+time string, falling back to the raw value if unparseable. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * "Rollback" action for an apply row in `/terraform/history` (issue #112).
 * Two-step flow, mirroring the backend's resolve-then-confirm split so
 * nothing is written until the operator has seen the target version:
 *
 * 1. Clicking the button calls `gsd.terraform.rollback.resolve` (read-only)
 *    to identify the tfvars version that was live before this apply run, and
 *    opens a {@link ConfirmDialog} naming it.
 * 2. Confirming calls `gsd.terraform.rollback.confirm`, which restores that
 *    version's content as a new head. On success, {@link onRolledBack} fires
 *    with the new version id so the caller can route into the plan/apply
 *    run view with it (see `TerraformPage`'s `RollbackNavState`).
 *
 * A failure at either step — including "no earlier version exists" / "the
 * historic version has expired" — is surfaced inline via `role="alert"` and
 * never triggers `onRolledBack`; nothing is written on a resolve failure,
 * and the confirm step's own backend re-resolution means nothing is written
 * on a confirm failure either.
 */
export function RollbackAction({ applyRunId, onRolledBack }: RollbackActionProps) {
  const [resolving, setResolving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState<{ versionId: string; lastModified: string } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    if (!window.gsd) {
      setError('IPC bridge (window.gsd) is not available in this context.');
      return;
    }
    setError(null);
    setResolving(true);
    void (async () => {
      try {
        const ack = await window.gsd!.terraform.rollback.resolve({ applyRunId });
        if (ack.resolved && ack.versionId && ack.lastModified) {
          setTarget({ versionId: ack.versionId, lastModified: ack.lastModified });
          setDialogOpen(true);
        } else {
          setError(ack.error ?? 'Could not resolve a rollback target.');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setResolving(false);
      }
    })();
  }

  function handleConfirm() {
    if (!window.gsd) return;
    setConfirming(true);
    void (async () => {
      try {
        const ack = await window.gsd!.terraform.rollback.confirm({ applyRunId });
        if (ack.confirmed && ack.versionId) {
          setDialogOpen(false);
          onRolledBack({ versionId: ack.versionId, rolledBackFrom: applyRunId });
        } else {
          setError(ack.error ?? 'Could not restore the historic tfvars version.');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setConfirming(false);
      }
    })();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" size="sm" onClick={handleClick} disabled={resolving}>
        {resolving ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : 'Rollback'}
      </Button>

      {error && (
        <p role="alert" className="text-xs text-[var(--color-red)]">
          {error}
        </p>
      )}

      {target && (
        <ConfirmDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title="Roll back tfvars?"
          description={
            `This restores tfvars version ${target.versionId} (last modified ${formatTimestamp(target.lastModified)}) ` +
            'as the new head, then queues a plan against it. The current head is not deleted — history is append-only.'
          }
          onConfirm={handleConfirm}
          confirmLabel={confirming ? 'Rolling back…' : 'Roll back'}
        />
      )}
    </div>
  );
}
