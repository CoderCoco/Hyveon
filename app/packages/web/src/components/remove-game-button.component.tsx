import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import { api } from '../api.service.js';
import { Button } from '@/components/ui/button.component';
import { Input } from '@/components/ui/input.component';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog.component';

interface Props {
  /** Name of the `game_servers` entry to remove — must be typed exactly to enable the confirm button. */
  game: string;
}

/**
 * Destructive "Remove game" button for a single declared `game_servers`
 * entry. Modeled on the type-to-confirm pattern in `ConfirmDialog`, but built
 * directly on the AlertDialog primitives so the dialog body can also surface
 * the `terraform.tfvars` / `make tf-apply` hint next to the type-to-confirm
 * input — `ConfirmDialog`'s `description` prop is plain text and can't carry
 * that richer content.
 *
 * `api.deleteGame` only rewrites `terraform.tfvars` — it does NOT run
 * `terraform apply`, so the underlying AWS resources (task definition, EFS
 * access point, security group rules, etc.) stay live until an operator
 * applies the change. The dialog calls this out explicitly so the action
 * isn't mistaken for a full teardown.
 *
 * On a successful delete the operator is redirected to `/games` since the
 * detail route for the now-removed game no longer has anything to show.
 */
export function RemoveGameButton({ game }: Props) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  const confirmDisabled = typed !== game;

  /** Resets the typed confirmation value whenever the dialog closes, so a stale value isn't shown on reopen. */
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setTyped('');
  }

  async function handleConfirm() {
    try {
      const result = await api.deleteGame({ name: game });
      if (result.ok) {
        toast.success(`${game} removed from terraform.tfvars`);
        navigate('/games');
        return;
      }
      const description =
        result.code === 'validation' ? result.issues.map((i) => i.message).join(' ') : result.message;
      toast.error(`Failed to remove ${game}`, { description });
    } catch (err) {
      toast.error(`Failed to remove ${game}`, {
        description: err instanceof Error ? err.message : 'An unknown error occurred',
      });
    }
  }

  return (
    <>
      <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
        <Trash2 />
        Remove game
      </Button>
      <AlertDialog open={open} onOpenChange={handleOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {game}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the <code className="font-[var(--font-mono)] text-xs">{game}</code> entry from{' '}
              <code className="font-[var(--font-mono)] text-xs">terraform.tfvars</code>. The deployed AWS
              resources stay live until an operator applies the change from the{' '}
              <Link to="/terraform" className="underline underline-offset-2">
                Terraform
              </Link>{' '}
              page.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={game}
            className="font-[var(--font-mono)]"
            aria-label="Type the game name to confirm"
          />

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirm()} disabled={confirmDisabled}>
              Remove game
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
