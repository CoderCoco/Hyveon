import { AlertCircle } from 'lucide-react';
import { Label } from '@/components/ui/label.component';
import { Input } from '@/components/ui/input.component';
import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import type { WizardDraft } from './wizard-form.utils.js';

/** Props for {@link IdentityStep}. */
export interface IdentityStepProps {
  /** The wizard's in-progress draft; only `name`/`image`/`connect_message` are read here. */
  draft: WizardDraft;
  /** Validation issues for the whole draft — filtered by `path` to find the message for each field. */
  issues: GameServerValidationIssue[];
  /** Called with a partial patch of the changed field whenever the operator edits a field. */
  onChange: (patch: Partial<Pick<WizardDraft, 'name' | 'image' | 'connect_message'>>) => void;
  /**
   * Renders the Name field as read-only. `name` is the `game_servers` map
   * key — the add wizard lets the operator choose it, but the edit form
   * (#100) reuses this step to edit an already-declared game and must not
   * let the operator rename it in place (that's a delete+recreate, not an
   * update). Defaults to `false` so the add wizard's behaviour is unchanged.
   */
  nameDisabled?: boolean;
}

/**
 * First step of the add-game wizard (#99): the operator names the new
 * `game_servers` entry, points at the container image to run, and optionally
 * writes a `connect_message` shown to Discord users after `/server-start`.
 * Purely presentational — the parent wizard owns the draft state and passes
 * down validation issues computed via `validateIdentityStep` (see wizard-form.utils.ts).
 *
 * Also reused, flattened alongside the other step components, by the edit
 * form (#100) — see the `nameDisabled` prop.
 */
export function IdentityStep({ draft, issues, onChange, nameDisabled = false }: IdentityStepProps) {
  const errorFor = (path: string) => issues.find((issue) => issue.path === path)?.message;

  return (
    <div className="space-y-5">
      <Field
        id="wizard-identity-name"
        label="Name"
        value={draft.name}
        placeholder="minecraft"
        error={errorFor('name')}
        disabled={nameDisabled}
        onChange={(value) => onChange({ name: value })}
      />
      <Field
        id="wizard-identity-image"
        label="Image"
        value={draft.image}
        placeholder="itzg/minecraft-server"
        error={errorFor('image')}
        onChange={(value) => onChange({ image: value })}
      />
      <Field
        id="wizard-identity-connect-message"
        label="Connect message"
        value={draft.connect_message}
        placeholder="Connect at {ip}:25565"
        error={errorFor('connect_message')}
        onChange={(value) => onChange({ connect_message: value })}
      />
    </div>
  );
}

/** A single labeled text input with an optional path-matched validation error rendered underneath. */
function Field({
  id,
  label,
  value,
  placeholder,
  error,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  error?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={error ? `${id}-error` : undefined}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-[var(--color-red)] flex items-center gap-1">
          <AlertCircle className="size-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}
