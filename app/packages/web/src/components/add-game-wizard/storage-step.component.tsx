/**
 * "Storage" step of the add-game wizard (#99): editable `volumes` rows
 * (`name` + `container_path`) plus fully-optional `file_seeds` rows (`path`
 * + `content` + `content_base64` + `mode`).
 *
 * The server requires at least one volume
 * (`gameServerSchema.volumes.min(1)`, see `gameServerValidator.ts`), so the
 * "Remove" button on the last remaining volume row is disabled — unlike
 * `file_seeds`, which are genuinely optional and can be removed down to
 * zero rows.
 *
 * Purely presentational, mirroring the rest of the wizard's "lift state up
 * to the draft" pattern: every add/remove/edit is expressed as a
 * `{ volumes }` or `{ file_seeds }` patch passed to `onChange`. Validation
 * issues are supplied by the caller (typically `validateStorageStep()`) and
 * matched back to the row/field they belong to by exact path —
 * `volumes[0].container_path`, `file_seeds[1].path`, or the array-level
 * `volumes` issue for the min-1 rule.
 */

import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import { Button } from '@/components/ui/button.component';
import { Input } from '@/components/ui/input.component';
import { Label } from '@/components/ui/label.component';
import { cn } from '@/lib/utils.utils';
import type { WizardDraft, WizardDraftFileSeed, WizardDraftVolume } from './wizard-form.utils.js';

/** Blank row appended by the "Add volume" button. */
const EMPTY_VOLUME: WizardDraftVolume = { name: '', container_path: '' };

/** Blank row appended by the "Add file seed" button. */
const EMPTY_FILE_SEED: WizardDraftFileSeed = { path: '', content: '', content_base64: '', mode: '' };

/** Props for {@link StorageStep}. */
export interface StorageStepProps {
  /** The wizard's in-progress draft; only `volumes`/`file_seeds` are read here. */
  draft: WizardDraft;
  /** Validation issues for this step (e.g. from `validateStorageStep()`), positioned via `volumes`/`volumes[N].field`/`file_seeds[N].field` paths. */
  issues: GameServerValidationIssue[];
  /** Called with a partial patch of the changed field whenever the operator adds, removes, or edits a row. */
  onChange: (patch: Partial<Pick<WizardDraft, 'volumes' | 'file_seeds'>>) => void;
}

/** Finds the message (if any) whose issue path is exactly `path`. */
function messageFor(issues: GameServerValidationIssue[], path: string): string | undefined {
  return issues.find((issue) => issue.path === path)?.message;
}

/**
 * Row editor for the wizard's "Storage" step: a `volumes` list (at least one
 * row required, enforced by disabling the last row's remove button) and an
 * optional `file_seeds` list.
 */
export function StorageStep({ draft, issues, onChange }: StorageStepProps) {
  const { volumes, file_seeds: fileSeeds } = draft;

  const volumesArrayError = messageFor(issues, 'volumes');

  function addVolume() {
    onChange({ volumes: [...volumes, { ...EMPTY_VOLUME }] });
  }

  function removeVolume(index: number) {
    if (volumes.length <= 1) return;
    onChange({ volumes: volumes.filter((_, i) => i !== index) });
  }

  function updateVolume(index: number, patch: Partial<WizardDraftVolume>) {
    onChange({ volumes: volumes.map((volume, i) => (i === index ? { ...volume, ...patch } : volume)) });
  }

  function addFileSeed() {
    onChange({ file_seeds: [...fileSeeds, { ...EMPTY_FILE_SEED }] });
  }

  function removeFileSeed(index: number) {
    onChange({ file_seeds: fileSeeds.filter((_, i) => i !== index) });
  }

  function updateFileSeed(index: number, patch: Partial<WizardDraftFileSeed>) {
    onChange({ file_seeds: fileSeeds.map((seed, i) => (i === index ? { ...seed, ...patch } : seed)) });
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Volumes</h3>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Every game server needs at least one EFS-backed volume for its save data.
          </p>
        </div>

        {volumesArrayError && (
          <p role="alert" className="text-xs text-[var(--color-red)]">
            {volumesArrayError}
          </p>
        )}

        <div className="space-y-3">
          {volumes.map((volume, index) => {
            const nameError = messageFor(issues, `volumes[${index}].name`);
            const pathError = messageFor(issues, `volumes[${index}].container_path`);
            const canRemove = volumes.length > 1;

            return (
              <div
                key={index}
                data-testid={`volume-row-${index}`}
                className="flex items-end gap-3 rounded-[var(--radius-sm)] border border-[var(--color-border)] p-3"
              >
                <div className="flex-1 space-y-1">
                  <Label htmlFor={`volume-name-${index}`}>Volume name</Label>
                  <Input
                    id={`volume-name-${index}`}
                    value={volume.name}
                    placeholder="data"
                    onChange={(event) => updateVolume(index, { name: event.target.value })}
                  />
                  {nameError && (
                    <p role="alert" className="text-xs text-[var(--color-red)]">
                      {nameError}
                    </p>
                  )}
                </div>

                <div className="flex-1 space-y-1">
                  <Label htmlFor={`volume-path-${index}`}>Container path</Label>
                  <Input
                    id={`volume-path-${index}`}
                    value={volume.container_path}
                    placeholder="/data"
                    onChange={(event) => updateVolume(index, { container_path: event.target.value })}
                  />
                  {pathError && (
                    <p role="alert" className="text-xs text-[var(--color-red)]">
                      {pathError}
                    </p>
                  )}
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canRemove}
                  aria-label={canRemove ? `Remove volume ${index + 1}` : `Remove volume ${index + 1} (at least one volume is required)`}
                  onClick={() => removeVolume(index)}
                >
                  Remove
                </Button>
              </div>
            );
          })}
        </div>

        <Button type="button" variant="secondary" size="sm" onClick={addVolume}>
          Add volume
        </Button>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-foreground)]">File seeds</h3>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Optional — files written into a volume the first time the server starts.
          </p>
        </div>

        {fileSeeds.length === 0 && (
          <p className="text-xs text-[var(--color-muted-foreground)]">No file seeds configured.</p>
        )}

        <div className="space-y-3">
          {fileSeeds.map((seed, index) => {
            const pathError = messageFor(issues, `file_seeds[${index}].path`);
            const contentError = messageFor(issues, `file_seeds[${index}].content`);
            const base64Error = messageFor(issues, `file_seeds[${index}].content_base64`);
            const modeError = messageFor(issues, `file_seeds[${index}].mode`);

            return (
              <div
                key={index}
                data-testid={`file-seed-row-${index}`}
                className={cn(
                  'space-y-3 rounded-[var(--radius-sm)] border p-3',
                  pathError ? 'border-[var(--color-red)]' : 'border-[var(--color-border)]',
                )}
              >
                <div className="flex items-end gap-3">
                  <div className="flex-1 space-y-1">
                    <Label htmlFor={`file-seed-path-${index}`}>Path</Label>
                    <Input
                      id={`file-seed-path-${index}`}
                      value={seed.path}
                      placeholder="/data/config.yml"
                      onChange={(event) => updateFileSeed(index, { path: event.target.value })}
                    />
                    {pathError && (
                      <p role="alert" className="text-xs text-[var(--color-red)]">
                        {pathError}
                      </p>
                    )}
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Remove file seed ${index + 1}`}
                    onClick={() => removeFileSeed(index)}
                  >
                    Remove
                  </Button>
                </div>

                <div className="space-y-1">
                  <Label htmlFor={`file-seed-content-${index}`}>Content</Label>
                  <textarea
                    id={`file-seed-content-${index}`}
                    value={seed.content}
                    placeholder="Plain-text file contents"
                    rows={3}
                    onChange={(event) => updateFileSeed(index, { content: event.target.value })}
                    className="flex w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm text-[var(--color-foreground)] font-[var(--font-mono)] placeholder:text-[var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary)]"
                  />
                  {contentError && (
                    <p role="alert" className="text-xs text-[var(--color-red)]">
                      {contentError}
                    </p>
                  )}
                </div>

                <div className="flex gap-3">
                  <div className="flex-1 space-y-1">
                    <Label htmlFor={`file-seed-base64-${index}`}>Content (base64)</Label>
                    <Input
                      id={`file-seed-base64-${index}`}
                      value={seed.content_base64}
                      placeholder="Base64-encoded binary contents"
                      onChange={(event) => updateFileSeed(index, { content_base64: event.target.value })}
                    />
                    {base64Error && (
                      <p role="alert" className="text-xs text-[var(--color-red)]">
                        {base64Error}
                      </p>
                    )}
                  </div>

                  <div className="w-28 space-y-1">
                    <Label htmlFor={`file-seed-mode-${index}`}>Mode</Label>
                    <Input
                      id={`file-seed-mode-${index}`}
                      value={seed.mode}
                      placeholder="0644"
                      onChange={(event) => updateFileSeed(index, { mode: event.target.value })}
                    />
                    {modeError && (
                      <p role="alert" className="text-xs text-[var(--color-red)]">
                        {modeError}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <Button type="button" variant="secondary" size="sm" onClick={addFileSeed}>
          Add file seed
        </Button>
      </section>
    </div>
  );
}
