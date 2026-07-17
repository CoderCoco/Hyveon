/**
 * Flat edit form for an already-declared `game_servers` entry (#100).
 *
 * Reuses the same draft shape and step components built for the add wizard
 * (#99, see `../add-game-wizard/`) — {@link IdentityStep}, `ResourcesStep`,
 * `NetworkingStep`, `StorageStep` — but renders every section stacked in one
 * flat view instead of walking the operator through them one at a time,
 * since the issue is scoped as "reuses most of the wizard from the prior
 * issue but as a flat form (not stepwise)".
 *
 * Differences from the add wizard's submit flow:
 *
 * - The `name` field is rendered read-only (`IdentityStep`'s `nameDisabled`
 *   prop): renaming a declared game is a delete+recreate, not an update, so
 *   it's out of scope for this form.
 * - Submits via `api.updateGame` (`PATCH /api/games/:name` over IPC) instead
 *   of `api.createGame`, and the draft is validated against every *other*
 *   declared game (the entry being edited is excluded from the collision
 *   list by name, mirroring `checkPortCollisions`'s own self-exclusion in
 *   `@hyveon/shared/gameServerValidator`).
 * - `environment`/`https` aren't covered by the wizard's draft shape (#99
 *   never built fields for them), so whatever the declaration already had is
 *   carried forward unmodified in the submitted payload rather than being
 *   silently dropped.
 *
 * Every {@link GameWriteResult} branch on submit is handled the same way the
 * add wizard handles it: `ok: true` invokes `onSaved` with the fresh result;
 * `code: 'validation'` re-renders the same fields with server-reported
 * issues (the draft is never reset, so the operator doesn't lose their
 * edits); `code: 'conflict' | 'not_found' | 'error'` surfaces the server's
 * message as an inline alert, again without touching the draft.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import { Button } from '@/components/ui/button.component';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.component';
import { api, type GameServer, type GameWriteSuccess, type UpdateGamePayload } from '../../api.service.js';
import { IdentityStep } from '../add-game-wizard/identity-step.component.js';
import { ResourcesStep } from '../add-game-wizard/resources-step.component.js';
import { NetworkingStep } from '../add-game-wizard/networking-step.component.js';
import { StorageStep } from '../add-game-wizard/storage-step.component.js';
import { draftFromGameServer, draftToPayload, validateStep, type WizardDraft } from '../add-game-wizard/wizard-form.utils.js';

/** Props for {@link EditGameForm}. */
export interface EditGameFormProps {
  /** The declared game to prefill the form from. */
  game: GameServer;
  /** Called with the successful write result once `api.updateGame` resolves `ok: true`. */
  onSaved?: (result: GameWriteSuccess) => void;
}

/**
 * Self-contained "Edit game" form: prefills a {@link WizardDraft} from
 * `game`, renders every wizard step flattened in one view (name read-only),
 * and owns its own `games.update` submit handler. See the module doc above
 * for the full submit-result contract.
 */
export function EditGameForm({ game, onSaved }: EditGameFormProps) {
  const [draft, setDraft] = useState<WizardDraft>(() => draftFromGameServer(game));
  const [existingGames, setExistingGames] = useState<GameServer[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<GameServerValidationIssue[] | null>(null);

  // Guards against setting state from a stale `api.games()`/`api.updateGame()`
  // response after this form has unmounted (e.g. the operator navigated away
  // mid-request).
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // Refreshes the list of every other declared game (used for the
  // cross-game port-collision check) on mount, mirroring the add wizard's
  // own `api.games()` effect. The entry being edited is excluded by name so
  // it never collides with its own, unchanged ports.
  useEffect(() => {
    let cancelled = false;
    api
      .games()
      .then(({ games }) => {
        if (cancelled || !mountedRef.current) return;
        setExistingGames(
          games.flatMap((entry) => (entry.config && entry.config.name !== game.name ? [entry.config] : [])),
        );
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) setExistingGames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [game.name]);

  /**
   * Applies a partial patch to the draft. Any stale server-reported error
   * state is cleared, since the operator is actively fixing the draft that
   * produced it.
   */
  function patchDraft(patch: Partial<WizardDraft>) {
    setServerIssues(null);
    setSubmitError(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  const liveIssues = validateStep('review', draft, existingGames);
  const issues = serverIssues ?? liveIssues;
  const saveDisabled = issues.length > 0 || submitting;

  /**
   * Submits the draft via `api.updateGame` and routes every
   * {@link GameWriteResult} branch to the right UI reaction — see the module
   * doc for the full contract. On any failure branch the draft is left
   * untouched so the operator doesn't lose their edits.
   */
  async function handleSave() {
    setSubmitting(true);
    setSubmitError(null);
    setServerIssues(null);

    try {
      const { config } = draftToPayload(draft);
      const payload: UpdateGamePayload = {
        name: game.name,
        // `environment`/`https` aren't editable fields on this form (the
        // wizard draft never had a place for them) — carry the existing
        // declaration's values forward so saving other fields doesn't wipe
        // them out.
        config: { ...config, environment: game.environment, https: game.https },
      };
      const result = await api.updateGame(payload);

      if (!mountedRef.current) return;

      if (result.ok) {
        onSaved?.(result);
        return;
      }

      switch (result.code) {
        case 'validation':
          setServerIssues(result.issues);
          break;
        case 'conflict':
        case 'not_found':
        case 'error':
          setSubmitError(result.message);
          break;
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setSubmitError(err instanceof Error ? err.message : 'Failed to update game.');
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent>
          <IdentityStep draft={draft} issues={issues} onChange={patchDraft} nameDisabled />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resources</CardTitle>
        </CardHeader>
        <CardContent>
          <ResourcesStep cpu={draft.cpu} memory={draft.memory} issues={issues} onChange={patchDraft} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Networking</CardTitle>
        </CardHeader>
        <CardContent>
          <NetworkingStep ports={draft.ports} issues={issues} onChange={(ports) => patchDraft({ ports })} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storage</CardTitle>
        </CardHeader>
        <CardContent>
          <StorageStep draft={draft} issues={issues} onChange={patchDraft} />
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

      <p className="text-xs text-[var(--color-muted-foreground)]">
        Saving only updates <code>terraform.tfvars</code> — run <code>make tf-apply</code> to apply this change to
        the live server.
      </p>

      <Button type="button" onClick={handleSave} disabled={saveDisabled}>
        {submitting && <Loader2 className="animate-spin" />}
        Save changes
      </Button>
    </div>
  );
}
