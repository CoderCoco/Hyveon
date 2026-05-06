import { useState, useEffect } from 'react';
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
import { Input } from '@/components/ui/input.component';
import { suppress } from '../lib/confirm-skip.utils.js';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  /** Label for the confirm button. Defaults to "Confirm". */
  confirmLabel?: string;
  /**
   * When provided, shows a "Don't ask again for this session" checkbox.
   * The key is stored in the module-level session store so the caller can
   * bypass opening the dialog on future clicks via `isSuppressed(confirmKey)`.
   */
  confirmKey?: string;
  /**
   * When provided, shows a text input; the confirm button stays disabled
   * until the typed value exactly matches this string (e.g. a guild ID).
   */
  typeToConfirm?: string;
}

/**
 * Generic confirmation dialog for destructive actions. Wraps shadcn AlertDialog
 * with optional type-to-confirm input and "don't ask again" session suppression.
 * ESC, focus-trap, and reduce-motion are handled by Radix automatically.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  confirmLabel = 'Confirm',
  confirmKey,
  typeToConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [skipSession, setSkipSession] = useState(false);

  useEffect(() => {
    if (!open) {
      setTyped('');
      setSkipSession(false);
    }
  }, [open]);

  const confirmDisabled = typeToConfirm !== undefined && typed !== typeToConfirm;

  function handleConfirm() {
    if (confirmKey && skipSession) suppress(confirmKey);
    onConfirm();
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {typeToConfirm !== undefined && (
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={typeToConfirm}
            className="font-[var(--font-mono)]"
            aria-label="Type to confirm"
          />
        )}

        {confirmKey && (
          <label className="flex items-center gap-2 text-sm text-[var(--color-muted-foreground)] cursor-pointer">
            <input
              type="checkbox"
              checked={skipSession}
              onChange={(e) => setSkipSession(e.target.checked)}
              className="size-3.5 rounded"
            />
            Don&apos;t ask again for this session
          </label>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={confirmDisabled}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
