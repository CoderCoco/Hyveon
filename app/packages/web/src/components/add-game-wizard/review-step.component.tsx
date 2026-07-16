import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card.component';
import type { WizardDraft } from './wizard-form.utils.js';

/** Props for {@link ReviewStep}. */
export interface ReviewStepProps {
  /** The fully-assembled wizard draft to summarize before submit. */
  draft: WizardDraft;
  /** Server-side error message from a failed submit attempt (e.g. a name collision), surfaced above the summary so the operator can fix and retry without losing the draft. Submit/navigation controls themselves live in the wizard shell's footer, not here. */
  submitError?: string | null;
}

/** One label/value pair in a summary section. */
function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="text-[var(--color-muted-foreground)]">{label}</span>
      <span className="font-[var(--font-mono)] text-right text-[var(--color-foreground)] break-all">{value}</span>
    </div>
  );
}

/**
 * Final step of the add-game wizard (#99): renders a read-only summary of
 * every field entered across the Identity, Resources, Networking, and
 * Storage steps. Optional fields that were left blank — `connect_message`
 * and `file_seeds` — are omitted entirely rather than shown with a
 * placeholder, so the summary only surfaces what the operator actually
 * configured. A `submitError` from a failed submit attempt (surfaced by the
 * wizard container after `POST /api/games` fails) is rendered as an alert
 * below the summary so the draft isn't lost. This component is purely
 * presentational — Submit/navigation controls are owned exclusively by the
 * wizard shell's footer, not by this step.
 */
export function ReviewStep({ draft, submitError = null }: ReviewStepProps) {
  const hasConnectMessage = draft.connect_message.trim().length > 0;
  const hasFileSeeds = draft.file_seeds.length > 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <SummaryRow label="Name" value={draft.name || '—'} />
          <SummaryRow label="Image" value={draft.image || '—'} />
          {hasConnectMessage && <SummaryRow label="Connect message" value={draft.connect_message} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resources</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <SummaryRow label="CPU" value={draft.cpu ?? '—'} />
          <SummaryRow label="Memory" value={draft.memory ?? '—'} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Networking</CardTitle>
        </CardHeader>
        <CardContent>
          {draft.ports.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No ports configured.</p>
          ) : (
            <ul className="space-y-1">
              {draft.ports.map((port, index) => (
                <li key={index} className="flex items-center justify-between gap-4 py-1 text-sm">
                  <span className="font-[var(--font-mono)]">{port.container ?? '—'}</span>
                  <span className="uppercase text-[var(--color-muted-foreground)]">{port.protocol}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {draft.volumes.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No volumes configured.</p>
          ) : (
            <ul className="space-y-1">
              {draft.volumes.map((volume, index) => (
                <li key={index} className="flex items-center justify-between gap-4 py-1 text-sm">
                  <span>{volume.name}</span>
                  <span className="font-[var(--font-mono)] text-[var(--color-muted-foreground)]">
                    {volume.container_path}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {hasFileSeeds && (
            <div>
              <h4 className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1">
                File seeds
              </h4>
              <ul className="space-y-1">
                {draft.file_seeds.map((seed, index) => (
                  <li key={index} className="font-[var(--font-mono)] text-sm">
                    {seed.path}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {submitError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-red)] bg-[var(--color-red)]/10 px-3 py-2 text-sm text-[var(--color-red)]"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          {submitError}
        </div>
      )}
    </div>
  );
}
