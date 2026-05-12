import { useState } from 'react';
import { Eye, EyeOff, ExternalLink } from 'lucide-react';
import { retryPendingAfterAuth, setStoredApiToken } from '../api.service.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.component';
import { Input } from './ui/input.component';
import { Label } from './ui/label.component';
import { Button } from './ui/button.component';

const MIN_TOKEN_LENGTH = 16;
const DOCS_URL =
  'https://codercoco.github.io/Hyveon/setup#api-token';

/**
 * Blocking dialog shown when the API rejects a request with 401. The operator
 * pastes the bearer token (`API_TOKEN` env var or `api_token` from
 * `app/server_config.json`) and we retry every parked request with the new
 * token. On success the dialog dismisses; on a second 401 we surface an inline
 * error inside the modal instead of the user being silently re-prompted.
 *
 * Validation only catches obvious paste mistakes (empty / whitespace / too
 * short) — token correctness is verified by the server's 401 response.
 */
export function ApiTokenModal({ open, onSuccess }: { open: boolean; onSuccess: () => void }) {
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(value: string): string | null {
    if (!value) return 'Token cannot be empty.';
    if (/\s/.test(value)) return 'Token cannot contain whitespace.';
    if (value.length < MIN_TOKEN_LENGTH) {
      return `Token must be at least ${MIN_TOKEN_LENGTH} characters.`;
    }
    return null;
  }

  function onTokenChange(value: string) {
    setToken(value);
    setServerError(null);
    if (validationError) setValidationError(validate(value));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const error = validate(token);
    setValidationError(error);
    if (error) return;
    setSubmitting(true);
    setServerError(null);
    setStoredApiToken(token);
    try {
      const ok = await retryPendingAfterAuth();
      if (ok) {
        setToken('');
        onSuccess();
      } else {
        setServerError(
          'Invalid token — check `app/server_config.json` or `API_TOKEN`.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open}>
      <DialogContent
        className="max-w-md [&>button.absolute]:hidden"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>API token required</DialogTitle>
            <DialogDescription>
              The dashboard API is gated behind a bearer token. It&apos;s stored
              in your browser&apos;s local storage; clear browser data to revoke.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="api-token">Token</Label>
            <div className="relative">
              <Input
                id="api-token"
                type={showToken ? 'text' : 'password'}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => onTokenChange(e.target.value)}
                placeholder="Paste API token"
                aria-invalid={Boolean(validationError || serverError)}
                aria-describedby={
                  validationError
                    ? 'api-token-validation'
                    : serverError
                    ? 'api-token-server'
                    : undefined
                }
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowToken((s) => !s)}
                aria-label={showToken ? 'Hide token' : 'Show token'}
                aria-pressed={showToken}
                className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary)]"
              >
                {showToken ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            {validationError && (
              <p
                id="api-token-validation"
                className="text-sm text-[var(--color-red)]"
                role="alert"
              >
                {validationError}
              </p>
            )}
            {serverError && (
              <p
                id="api-token-server"
                className="text-sm text-[var(--color-red)]"
                role="alert"
              >
                {serverError}
              </p>
            )}
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-[var(--color-primary-light)] underline-offset-4 hover:underline"
            >
              Where do I find this?
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={submitting || !token}>
              {submitting ? 'Verifying…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
