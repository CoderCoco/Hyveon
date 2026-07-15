/**
 * "Networking" step of the add-game wizard (#99) — a row editor for
 * {@link WizardDraftPort} entries (`container` port + `protocol`). Each row
 * exposes a container-port number input and a protocol select, plus a
 * "Remove" button; a trailing "Add port" button appends a blank row.
 *
 * The component itself holds no state — every edit (add/remove/edit) is
 * expressed as a brand-new `ports` array passed to `onChange`, mirroring the
 * rest of the wizard's "lift state up to the draft" pattern (see
 * `wizard-form.utils.ts`). Validation issues are supplied by the caller
 * (typically `validateNetworkingStep()`); a `ports[N]`-pathed issue
 * highlights only that row, via {@link stepForIssuePath}'s sibling
 * path-indexing scheme (`ports[0]`, `ports[1]`, ...).
 */

import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import { Button } from '@/components/ui/button.component';
import { Input } from '@/components/ui/input.component';
import { Label } from '@/components/ui/label.component';
import { cn } from '@/lib/utils.utils';
import type { WizardDraftPort } from './wizard-form.utils.js';

/** Protocol options offered in each row's dropdown; `game_servers[].ports[].protocol` is a plain string server-side, but only these two are meaningful for an ECS/Fargate task definition. */
const PROTOCOL_OPTIONS = ['tcp', 'udp'] as const;

/** Blank row appended by the "Add port" button. */
const EMPTY_PORT: WizardDraftPort = { container: null, protocol: 'tcp' };

/** Props for {@link NetworkingStep}. */
export interface NetworkingStepProps {
  /** Current draft port rows. */
  ports: WizardDraftPort[];
  /** Validation issues for this step (e.g. from `validateNetworkingStep()`), positioned via `ports[N]` / `ports[N].field` paths. */
  issues: GameServerValidationIssue[];
  /** Called with the full replacement `ports` array on every add/remove/edit. */
  onChange: (ports: WizardDraftPort[]) => void;
}

/** Finds the issue (if any) whose path is exactly `ports[index]`, i.e. a row-level (not field-level) error. */
function rowError(issues: GameServerValidationIssue[], index: number): GameServerValidationIssue | undefined {
  return issues.find((issue) => issue.path === `ports[${index}]`);
}

/**
 * Row editor for the wizard's "Networking" step. Renders one row per port
 * with a container-port input, protocol select, and remove button, plus an
 * "Add port" button that appends {@link EMPTY_PORT}.
 */
export function NetworkingStep({ ports, issues, onChange }: NetworkingStepProps) {
  function addRow() {
    onChange([...ports, { ...EMPTY_PORT }]);
  }

  function removeRow(index: number) {
    onChange(ports.filter((_, i) => i !== index));
  }

  function updateRow(index: number, patch: Partial<WizardDraftPort>) {
    onChange(ports.map((port, i) => (i === index ? { ...port, ...patch } : port)));
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Networking</h3>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Declare every container port the server listens on.
        </p>
      </div>

      {ports.length === 0 && (
        <p className="text-xs text-[var(--color-muted-foreground)]">No ports configured yet.</p>
      )}

      <div className="space-y-3">
        {ports.map((port, index) => {
          const issue = rowError(issues, index);
          return (
            <div
              key={index}
              data-testid={`port-row-${index}`}
              className={cn(
                'flex items-end gap-3 rounded-[var(--radius-sm)] border p-3',
                issue ? 'border-[var(--color-red)]' : 'border-[var(--color-border)]',
              )}
            >
              <div className="flex-1">
                <Label htmlFor={`port-container-${index}`}>Container port</Label>
                <Input
                  id={`port-container-${index}`}
                  type="number"
                  value={port.container ?? ''}
                  onChange={(event) => {
                    const raw = event.target.value;
                    updateRow(index, { container: raw === '' ? null : Number(raw) });
                  }}
                />
              </div>

              <div className="flex-1">
                <Label htmlFor={`port-protocol-${index}`}>Protocol</Label>
                <select
                  id={`port-protocol-${index}`}
                  value={port.protocol}
                  onChange={(event) => updateRow(index, { protocol: event.target.value })}
                  className="flex h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[var(--color-foreground)]"
                >
                  {PROTOCOL_OPTIONS.map((protocol) => (
                    <option key={protocol} value={protocol}>
                      {protocol.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>

              <Button type="button" variant="outline" size="sm" onClick={() => removeRow(index)}>
                Remove
              </Button>

              {issue && (
                <p role="alert" className="w-full text-xs text-[var(--color-red)]">
                  {issue.message}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <Button type="button" variant="secondary" size="sm" onClick={addRow}>
        Add port
      </Button>
    </div>
  );
}
