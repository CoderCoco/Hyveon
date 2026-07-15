/**
 * Wizard shell for declaring a new `game_servers` entry (#99): a self-contained
 * `<Dialog>` — trigger, five-step navigation, and the submit handler — built
 * from the step components and validation utilities already assembled for
 * this issue (`identity-step`, `resources-step`, `networking-step`,
 * `storage-step`, `review-step`, `wizard-form.utils`).
 *
 * The wizard owns every piece of its own state (open/closed, current step,
 * in-progress {@link WizardDraft}, the existing-games list used for
 * client-side collision checks, and submit status) so it can be dropped in
 * anywhere — e.g. on `/games` — without the caller wiring anything beyond
 * rendering `<AddGameWizard />`.
 *
 * "Next" (or, on the final step, "Submit") is disabled whenever
 * {@link canAdvance} finds outstanding validation issues on the active step,
 * mirroring the same zod schema + business rules the server enforces (see
 * `wizard-form.utils.ts`). On submit, every {@link GameWriteResult} branch is
 * handled explicitly:
 *
 * - `ok: true` — success toast, redirect to `/games/:name`, dialog closes and
 *   the draft resets.
 * - `code: 'validation'` — the dialog stays open; the returned issues are
 *   stored and the wizard jumps to the earliest step whose fields they
 *   belong to (via {@link stepForIssuePath}) so the offending fields render
 *   highlighted.
 * - `code: 'conflict' | 'not_found' | 'error'` — the dialog stays open, the
 *   wizard jumps to the Review step, and the server's message is surfaced
 *   via {@link ReviewStep}'s `submitError` prop.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, Loader2 } from 'lucide-react';
import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import { Button } from '@/components/ui/button.component';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog.component';
import { api, type CreateGamePayload, type GameServer } from '../../api.service.js';
import { IdentityStep } from './identity-step.component.js';
import { ResourcesStep } from './resources-step.component.js';
import { NetworkingStep } from './networking-step.component.js';
import { StorageStep } from './storage-step.component.js';
import { ReviewStep } from './review-step.component.js';
import {
  WIZARD_STEPS,
  canAdvance,
  createEmptyWizardDraft,
  stepForIssuePath,
  validateStep,
  type WizardDraft,
  type WizardStep,
} from './wizard-form.utils.js';

/** Human-readable heading for each {@link WizardStep}, shown in the dialog description. */
const STEP_LABELS: Record<WizardStep, string> = {
  identity: 'Identity',
  resources: 'Resources',
  networking: 'Networking',
  storage: 'Storage',
  review: 'Review',
};

/**
 * Converts a completed {@link WizardDraft} into the `POST /api/games`
 * (`games.create` IPC) payload. Only called once the Review step's "Submit"
 * button is enabled, which requires {@link validateStep} to report zero
 * issues for `review` — so `cpu`/`memory`/port `container` values are
 * guaranteed non-null at this point; the `?? 0` fallbacks only guard the
 * type checker, they're never expected to fire in practice.
 */
function draftToPayload(draft: WizardDraft): CreateGamePayload {
  const name = draft.name.trim();
  const connectMessage = draft.connect_message.trim();
  const image = draft.image.trim();

  return {
    name,
    config: {
      image,
      cpu: draft.cpu ?? 0,
      memory: draft.memory ?? 0,
      ports: draft.ports.map((port) => ({ container: port.container ?? 0, protocol: port.protocol })),
      volumes: draft.volumes.map((volume) => ({ name: volume.name, container_path: volume.container_path })),
      connect_message: connectMessage.length > 0 ? connectMessage : undefined,
      file_seeds:
        draft.file_seeds.length > 0
          ? draft.file_seeds.map((seed) => ({
              path: seed.path,
              content: seed.content.length > 0 ? seed.content : undefined,
              content_base64: seed.content_base64.length > 0 ? seed.content_base64 : undefined,
              mode: seed.mode.length > 0 ? seed.mode : undefined,
            }))
          : undefined,
    },
  };
}

/**
 * Self-contained "Add game" dialog: renders its own trigger button, walks the
 * operator through the five wizard steps, and owns the `games.create` submit
 * handler. See the module doc above for the full submit-result contract.
 */
export function AddGameWizard() {
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [draft, setDraft] = useState<WizardDraft>(createEmptyWizardDraft());
  const [existingGames, setExistingGames] = useState<GameServer[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<GameServerValidationIssue[] | null>(null);

  const step = WIZARD_STEPS[stepIndex];

  // Refreshes the existing-games list (used for name/port collision checks)
  // every time the dialog opens, so a game declared in a previous session
  // is taken into account without requiring a page reload.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .games()
      .then(({ games }) => {
        if (cancelled) return;
        setExistingGames(games.flatMap((entry) => (entry.config ? [entry.config] : [])));
      })
      .catch(() => {
        if (!cancelled) setExistingGames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  /** Resets every piece of wizard state back to a blank first step. */
  function resetWizard() {
    setStepIndex(0);
    setDraft(createEmptyWizardDraft());
    setSubmitError(null);
    setServerIssues(null);
    setSubmitting(false);
  }

  /** Handles the dialog's own open/close, resetting the draft on close. */
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) resetWizard();
  }

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

  const liveIssues = validateStep(step, draft, existingGames);
  const stepIssues = serverIssues
    ? step === 'review'
      ? serverIssues
      : serverIssues.filter((issue) => stepForIssuePath(issue.path) === step)
    : liveIssues;

  const advanceDisabled = !canAdvance(step, draft, existingGames);

  function goNext() {
    setStepIndex((index) => Math.min(index + 1, WIZARD_STEPS.length - 1));
  }

  function goBack() {
    setStepIndex((index) => Math.max(index - 1, 0));
  }

  /**
   * Submits the draft via `api.createGame` and routes every
   * {@link GameWriteResult} branch to the right UI reaction — see the module
   * doc for the full contract.
   */
  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    setServerIssues(null);

    try {
      const payload = draftToPayload(draft);
      const result = await api.createGame(payload);

      if (result.ok) {
        toast.success(`${payload.name} created`);
        handleOpenChange(false);
        navigate(`/games/${payload.name}`);
        return;
      }

      switch (result.code) {
        case 'validation': {
          setServerIssues(result.issues);
          const firstIssuePath = result.issues[0]?.path;
          const targetStep = firstIssuePath ? stepForIssuePath(firstIssuePath) : 'review';
          setStepIndex(WIZARD_STEPS.indexOf(targetStep));
          break;
        }
        case 'conflict':
        case 'not_found':
        case 'error':
          setSubmitError(result.message);
          setStepIndex(WIZARD_STEPS.length - 1);
          break;
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create game.');
      setStepIndex(WIZARD_STEPS.length - 1);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button">
          <Plus />
          Add game
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a game server</DialogTitle>
          <DialogDescription>
            Step {stepIndex + 1} of {WIZARD_STEPS.length}: {STEP_LABELS[step]}
          </DialogDescription>
        </DialogHeader>

        {step === 'identity' && <IdentityStep draft={draft} issues={stepIssues} onChange={patchDraft} />}
        {step === 'resources' && (
          <ResourcesStep cpu={draft.cpu} memory={draft.memory} issues={stepIssues} onChange={patchDraft} />
        )}
        {step === 'networking' && (
          <NetworkingStep ports={draft.ports} issues={stepIssues} onChange={(ports) => patchDraft({ ports })} />
        )}
        {step === 'storage' && <StorageStep draft={draft} issues={stepIssues} onChange={patchDraft} />}
        {step === 'review' && <ReviewStep draft={draft} submitError={submitError} />}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={goBack} disabled={stepIndex === 0 || submitting}>
            Back
          </Button>
          {step === 'review' ? (
            <Button type="button" onClick={handleSubmit} disabled={advanceDisabled || submitting}>
              {submitting && <Loader2 className="animate-spin" />}
              Submit
            </Button>
          ) : (
            <Button type="button" onClick={goNext} disabled={advanceDisabled}>
              Next
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
