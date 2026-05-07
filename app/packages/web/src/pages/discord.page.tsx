import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Check,
  CheckCircle2,
  X,
  ExternalLink,
  AlertCircle,
  ShieldCheck,
  Copy,
  Sparkles,
} from 'lucide-react';
import {
  api,
  type DiscordAction,
  type DiscordAdmins,
  type DiscordConfigRedacted,
  type DiscordGamePermission,
} from '../api.service.js';
import { Button } from '@/components/ui/button.component';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card.component';
import { Badge } from '@/components/ui/badge.component';
import { Input } from '@/components/ui/input.component';
import { Label } from '@/components/ui/label.component';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs.component';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.component';
import { cn } from '@/lib/utils.utils';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { ConfirmDialog } from '../components/confirm-dialog.component.js';
import { isSuppressed } from '../lib/confirm-skip.utils.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const ALL_ACTIONS: DiscordAction[] = ['start', 'stop', 'status'];

/** Validates a Discord snowflake ID (17–20 digit numeric string). */
function isSnowflake(value: string): boolean {
  return SNOWFLAKE_RE.test(value.trim());
}

/**
 * Split a free-form blob (newline / comma / whitespace separated) into a
 * `valid`/`invalid` snowflake bucket. Used for bulk-paste handling.
 */
function parseSnowflakes(input: string): { valid: string[]; invalid: string[] } {
  const tokens = input
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const t of tokens) {
    if (isSnowflake(t)) valid.push(t);
    else invalid.push(t);
  }
  return { valid, invalid };
}

/** Deduplicate, preserving the original order. */
function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Discord settings route (`/discord`).
 *
 * Replaces the old `DiscordPanel` that was crammed into the bottom of the
 * dashboard. Renders a setup wizard for first-time operators, and otherwise
 * a tabbed view: Credentials, Guilds, Admins, and per-game permissions.
 *
 * All persistence still goes through the existing `/api/discord/*` routes —
 * neither the bot token nor the public key is ever echoed back to the client.
 */
export function DiscordPage() {
  const [cfg, setCfg] = useState<DiscordConfigRedacted | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [games, setGames] = useState<string[]>([]);
  const [showWizard, setShowWizard] = useState(false);

  useEffect(() => {
    api.games().then((g) => setGames(g.games)).catch(() => undefined);
  }, []);

  /** Re-fetch the (redacted) Discord config from the API after mutations. */
  async function refresh() {
    try {
      setCfg(await api.discordConfig());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Latch the wizard open on first load when no guilds are configured so the
  // operator can work through each step and see the final green check on step 4.
  useEffect(() => {
    if (cfg && cfg.allowedGuilds.length === 0) {
      setShowWizard(true);
    }
  }, [cfg]);

  const allStepsDone =
    !!cfg?.clientId &&
    !!cfg?.botTokenSet &&
    !!cfg?.publicKeySet &&
    !!cfg?.interactionsEndpointUrl &&
    (cfg?.allowedGuilds.length ?? 0) > 0;

  // Collapse only after the render that shows all four checks — the effect
  // fires after paint so the operator sees step 4 as green before it hides.
  useEffect(() => {
    if (allStepsDone) setShowWizard(false);
  }, [allStepsDone]);

  /**
   * Guard a mutating API call with the `busy` flag and refresh config after
   * it resolves so the UI reflects the server-side change.
   */
  async function wrap<T>(fn: () => Promise<T>, successMsg?: string): Promise<void> {
    setBusy(true);
    try {
      await fn();
      await refresh();
      if (successMsg) toast.success(successMsg);
    } catch (err) {
      toast.error('Action failed', {
        description: err instanceof Error ? err.message : 'An unknown error occurred',
      });
      throw err;
    } finally {
      setBusy(false);
    }
  }

  if (!cfg) {
    return (
      <div className="max-w-5xl mx-auto p-8 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold">Discord</h2>
            <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
              {loadError
                ? 'Discord config unavailable — infrastructure not deployed yet. Run `terraform apply` first.'
                : 'Loading…'}
            </p>
          </div>
          <PollingIndicator />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Discord</h2>
          <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
            Slash-command bot configuration: credentials, guild allowlist, admins, and per-game
            permissions.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <PollingIndicator />
          <ServerlessBadge cfg={cfg} />
        </div>
      </div>

      {showWizard && <SetupWizard cfg={cfg} />}

      <Tabs defaultValue="credentials" className="w-full">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="credentials">Credentials</TabsTrigger>
          <TabsTrigger value="guilds">Guilds</TabsTrigger>
          <TabsTrigger value="admins">Admins</TabsTrigger>
          <TabsTrigger value="permissions">Per-Game Permissions</TabsTrigger>
        </TabsList>

        <TabsContent value="credentials" className="mt-6">
          <CredentialsSection
            cfg={cfg}
            busy={busy}
            onSave={(body) => { void wrap(() => api.discordSaveCredentials(body), 'Credentials saved').catch(() => undefined); }}
          />
        </TabsContent>

        <TabsContent value="guilds" className="mt-6">
          <GuildsSection
            cfg={cfg}
            busy={busy}
            onAdd={(g) => { void wrap(() => api.discordAddGuild(g), 'Guild added').catch(() => undefined); }}
            onRemove={(g) => { void wrap(() => api.discordRemoveGuild(g), 'Guild removed').catch(() => undefined); }}
            onRegister={(g) => wrap(() => api.discordRegisterCommands(g), 'Commands registered')}
          />
        </TabsContent>

        <TabsContent value="admins" className="mt-6">
          <AdminsSection
            cfg={cfg}
            busy={busy}
            onSave={(a) => { void wrap(() => api.discordSaveAdmins(a), 'Admins saved').catch(() => undefined); }}
          />
        </TabsContent>

        <TabsContent value="permissions" className="mt-6">
          <PermissionsSection
            cfg={cfg}
            games={games}
            busy={busy}
            onSave={(game, perm) => { void wrap(() => api.discordSavePermission(game, perm), 'Permissions saved').catch(() => undefined); }}
            onDelete={(game) => { void wrap(() => api.discordDeletePermission(game), 'Permissions cleared').catch(() => undefined); }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Compact header indicator showing whether the serverless bot is fully wired
 * up (both secrets configured + an interactions endpoint URL exists).
 */
function ServerlessBadge({ cfg }: { cfg: DiscordConfigRedacted }) {
  const ready = cfg.botTokenSet && cfg.publicKeySet && !!cfg.interactionsEndpointUrl;
  if (ready) {
    return <Badge variant="success">serverless · ready</Badge>;
  }
  const label = !cfg.interactionsEndpointUrl
    ? 'terraform not applied'
    : !cfg.botTokenSet || !cfg.publicKeySet
      ? 'awaiting credentials'
      : 'incomplete';
  return <Badge variant="warning">{label}</Badge>;
}

/**
 * Setup wizard shown when no guilds are allowlisted. Walks the operator through
 * Discord developer-portal steps with live green checks as each precondition
 * is satisfied (credentials saved, URL copied, guild added).
 */
function SetupWizard({ cfg }: { cfg: DiscordConfigRedacted }) {
  const steps: { label: React.ReactNode; done: boolean }[] = [
    {
      label: (
        <>
          Create an application at{' '}
          <a
            href="https://discord.com/developers/applications"
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-primary-light)] underline-offset-4 hover:underline inline-flex items-center gap-1"
          >
            discord.com/developers/applications
            <ExternalLink className="size-3" />
          </a>
          , add a Bot, and copy the Application ID, Bot Token, and Public Key.
        </>
      ),
      done: !!cfg.clientId,
    },
    {
      label: (
        <>
          Paste those values into the <strong>Credentials</strong> tab below and save. The tokens
          are stored in AWS Secrets Manager — they&apos;re never echoed back.
        </>
      ),
      done: cfg.botTokenSet && cfg.publicKeySet,
    },
    {
      label: (
        <>
          Copy the <strong>Interactions Endpoint URL</strong> from the Credentials tab into the
          same Discord developer portal page.
        </>
      ),
      done: !!cfg.interactionsEndpointUrl,
    },
    {
      label: (
        <>
          Add your server (guild) ID under <strong>Guilds</strong>, then click{' '}
          <em>Register commands</em> on that row.
        </>
      ),
      done: cfg.allowedGuilds.length > 0,
    },
  ];

  return (
    <Card className="border-[var(--color-primary)]/30 bg-gradient-to-br from-[var(--color-primary)]/5 to-transparent">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-[var(--color-primary-light)]" />
          <CardTitle>Get started</CardTitle>
        </div>
        <CardDescription>
          The bot isn&apos;t configured yet. Follow these steps to wire it up.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ol className="space-y-4">
          {steps.map((step, i) => (
            <li key={i} className="flex items-start gap-3 text-sm">
              {step.done ? (
                <CheckCircle2 className="size-4 mt-0.5 shrink-0 text-[var(--color-green)]" />
              ) : (
                <span className="size-4 mt-0.5 shrink-0 rounded-full border border-[var(--color-border)] flex items-center justify-center text-[10px] text-[var(--color-muted-foreground)] leading-none">
                  {i + 1}
                </span>
              )}
              <span className={step.done ? 'text-[var(--color-muted-foreground)] line-through' : 'text-[var(--color-foreground)]'}>
                {step.label}
              </span>
            </li>
          ))}
        </ol>
        <p className="text-xs text-[var(--color-muted-foreground)] border-t border-[var(--color-border)] pt-4">
          Full walkthrough:{' '}
          <a
            href="https://codercoco.github.io/game-server-deploy/setup"
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-primary-light)] underline-offset-4 hover:underline"
          >
            docs/docs/setup.md
          </a>
          .
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Credentials editor — Application (Client) ID, Bot Token, Public Key, plus the
 * read-only Interactions Endpoint URL the operator pastes back into Discord.
 * Token and public key are write-only: leaving the field blank when one is
 * already set preserves the existing value.
 */
function CredentialsSection({
  cfg,
  busy,
  onSave,
}: {
  cfg: DiscordConfigRedacted;
  busy: boolean;
  onSave: (body: { botToken?: string; clientId?: string; publicKey?: string }) => void;
}) {
  const [clientId, setClientId] = useState(cfg.clientId);
  const [clientIdError, setClientIdError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [copied, setCopied] = useState(false);

  /**
   * Validate Client ID as a Discord snowflake before submit. Empty is allowed
   * so operators can save token/public-key updates without retyping the ID,
   * but a non-empty value must match the snowflake shape — `DiscordCommandRegistrar`
   * silently fails to register commands when the stored Client ID is malformed.
   */
  function handleSave() {
    const trimmed = clientId.trim();
    if (trimmed && !isSnowflake(trimmed)) {
      setClientIdError('Client ID must be a 17–20 digit Discord snowflake.');
      return;
    }
    setClientIdError(null);
    onSave({
      clientId: trimmed,
      ...(token ? { botToken: token } : {}),
      ...(publicKey ? { publicKey } : {}),
    });
    setToken('');
    setPublicKey('');
  }

  /** Copy the interactions URL to the clipboard with a brief "Copied" state. */
  function handleCopyUrl() {
    if (!cfg.interactionsEndpointUrl) return;
    void navigator.clipboard.writeText(cfg.interactionsEndpointUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Credentials</CardTitle>
        <CardDescription>
          Stored in AWS Secrets Manager. The token and public key are never sent back to this
          page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="client-id">Application (Client) ID</Label>
          <Input
            id="client-id"
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              if (clientIdError) setClientIdError(null);
            }}
            placeholder="000000000000000000"
            aria-invalid={clientIdError ? 'true' : 'false'}
          />
          {clientIdError && (
            <p className="text-xs text-[var(--color-red)] flex items-center gap-1">
              <AlertCircle className="size-3.5" />
              {clientIdError}
            </p>
          )}
        </div>

        <SecretField
          id="bot-token"
          label="Bot Token"
          alreadySet={cfg.botTokenSet}
          value={token}
          onChange={setToken}
        />

        <SecretField
          id="public-key"
          label="Application Public Key"
          alreadySet={cfg.publicKeySet}
          value={publicKey}
          onChange={setPublicKey}
        />

        <div className="space-y-2">
          <Label>Interactions Endpoint URL</Label>
          {cfg.interactionsEndpointUrl ? (
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] text-xs font-[var(--font-mono)] break-all">
                {cfg.interactionsEndpointUrl}
              </code>
              <Button variant="secondary" size="sm" onClick={handleCopyUrl}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Run <code>terraform apply</code> to provision the Lambda and surface this URL.
            </p>
          )}
        </div>

        <div className="flex justify-end pt-2">
          <Button disabled={busy} onClick={handleSave}>
            Save credentials
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Password-style input with a show/hide eye toggle and a green check next to
 * the label when the secret is already configured server-side. The empty value
 * is treated as "leave existing secret untouched".
 */
function SecretField({
  id,
  label,
  alreadySet,
  value,
  onChange,
}: {
  id: string;
  label: string;
  alreadySet: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        {alreadySet && (
          <span
            className="inline-flex items-center gap-1 text-xs text-[var(--color-green)]"
            aria-label="Already set"
          >
            <Check className="size-3.5" />
            set
          </span>
        )}
      </div>
      <div className="relative">
        <Input
          id={id}
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={alreadySet ? 'Leave blank to keep existing' : 'Paste new value'}
          className="pr-9"
        />
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          aria-label={reveal ? 'Hide value' : 'Show value'}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
        >
          {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {alreadySet && (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Already set — leave blank to keep.
        </p>
      )}
    </div>
  );
}

/**
 * Guild allowlist editor. Each row exposes Register/Remove actions and a
 * "registered this session" badge that flips after the operator clicks
 * Register. Terraform-managed guilds are non-removable but still registerable.
 */
function GuildsSection({
  cfg,
  busy,
  onAdd,
  onRemove,
  onRegister,
}: {
  cfg: DiscordConfigRedacted;
  busy: boolean;
  onAdd: (g: string) => void;
  onRemove: (g: string) => void;
  onRegister: (g: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState<Set<string>>(new Set());
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  // Merge the terraform-managed and dynamic allowlists, deduping by guild ID
  // so a guild that appears in both never renders twice (which would collide
  // React keys and produce conflicting per-row actions). The terraform entry
  // wins so the row is shown as locked.
  const allGuilds = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; locked: boolean }[] = [];
    for (const g of cfg.baseAllowedGuilds) {
      if (!seen.has(g)) {
        seen.add(g);
        out.push({ id: g, locked: true });
      }
    }
    for (const g of cfg.allowedGuilds) {
      if (!seen.has(g)) {
        seen.add(g);
        out.push({ id: g, locked: false });
      }
    }
    return out;
  }, [cfg.allowedGuilds, cfg.baseAllowedGuilds]);

  /** Add a new guild after running snowflake validation; show inline error if malformed. */
  function handleAdd() {
    const id = draft.trim();
    if (!id) return;
    if (!isSnowflake(id)) {
      setError('Guild IDs are 17–20 digit Discord snowflakes.');
      return;
    }
    if (cfg.baseAllowedGuilds.includes(id) || cfg.allowedGuilds.includes(id)) {
      setError('That guild is already allowlisted.');
      return;
    }
    setError(null);
    setDraft('');
    onAdd(id);
  }

  /**
   * Dispatch the register-commands API call, then mark the guild as
   * registered-this-session only if the call resolved successfully. Failures
   * leave the badge in the "not registered" state so the operator can retry.
   */
  async function handleRegister(guildId: string) {
    try {
      await onRegister(guildId);
      setRegistered((prev) => new Set(prev).add(guildId));
    } catch {
      // Stay marked unregistered on failure — the operator can retry.
    }
  }

  /** Bulk-register every allowlisted guild — sequential so partial failures are visible. */
  async function handleRegisterAll() {
    for (const g of allGuilds) {
      await handleRegister(g.id);
    }
  }

  return (
    <>
      <ConfirmDialog
        open={pendingRemoveId !== null}
        onOpenChange={(o) => { if (!o) setPendingRemoveId(null); }}
        title="Remove guild?"
        description="The bot will no longer respond to commands from this guild."
        confirmLabel="Remove guild"
        typeToConfirm={pendingRemoveId ?? ''}
        onConfirm={() => {
          if (pendingRemoveId) void onRemove(pendingRemoveId);
          setPendingRemoveId(null);
        }}
      />
      <Card>
        <CardHeader>
          <CardTitle>Guilds</CardTitle>
          <CardDescription>
            The interactions Lambda rejects commands from any server whose ID isn&apos;t in this
            allowlist. Enable Discord Developer Mode (Settings → Advanced) to copy server IDs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
        <div>
          <Label htmlFor="add-guild" className="mb-2 block">
            Add a guild
          </Label>
          <div className="flex gap-2">
            <Input
              id="add-guild"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAdd();
                }
              }}
              placeholder="Guild (server) ID — 17–20 digits"
              aria-invalid={error ? 'true' : 'false'}
            />
            <Button
              variant="secondary"
              disabled={busy || !draft.trim()}
              onClick={handleAdd}
            >
              Add
            </Button>
          </div>
          {error && (
            <p className="mt-1.5 text-xs text-[var(--color-red)] flex items-center gap-1">
              <AlertCircle className="size-3.5" />
              {error}
            </p>
          )}
        </div>

        {allGuilds.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-foreground)] py-6 text-center">
            No guilds allowlisted yet.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={handleRegisterAll}
              >
                Register commands in all guilds
              </Button>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Guild ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allGuilds.map(({ id, locked }) => (
                  <TableRow key={id}>
                    <TableCell className="font-[var(--font-mono)] text-xs">{id}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {registered.has(id) ? (
                          <Badge variant="success">registered</Badge>
                        ) : (
                          <Badge variant="secondary">not registered</Badge>
                        )}
                        {locked && (
                          <Badge variant="outline" className="text-[0.65rem]">
                            terraform
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => handleRegister(id)}
                        >
                          Register
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || locked}
                          onClick={() => setPendingRemoveId(id)}
                          title={locked ? 'Managed by Terraform — remove via terraform.tfvars' : undefined}
                        >
                          Remove
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  </>
  );
}

/**
 * Server-wide admin editor: chip-based User ID and Role ID lists. Bulk paste
 * (newline / comma / whitespace separated) is normalized to chips on commit.
 */
function AdminsSection({
  cfg,
  busy,
  onSave,
}: {
  cfg: DiscordConfigRedacted;
  busy: boolean;
  onSave: (a: DiscordAdmins) => void;
}) {
  const [userIds, setUserIds] = useState<string[]>(cfg.admins.userIds);
  const [roleIds, setRoleIds] = useState<string[]>(cfg.admins.roleIds);
  const [pendingRemove, setPendingRemove] = useState<{ list: 'user' | 'role'; id: string } | null>(null);
  const hasBaseAdmins =
    cfg.baseAdmins.userIds.length > 0 || cfg.baseAdmins.roleIds.length > 0;

  const dirty =
    JSON.stringify(userIds) !== JSON.stringify(cfg.admins.userIds) ||
    JSON.stringify(roleIds) !== JSON.stringify(cfg.admins.roleIds);

  return (
    <>
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(o) => { if (!o) setPendingRemove(null); }}
        title="Remove admin?"
        description="This ID will no longer have admin-level access."
        confirmLabel="Remove"
        confirmKey="remove-admin"
        onConfirm={() => {
          if (pendingRemove) {
            if (pendingRemove.list === 'user') {
              setUserIds((cur) => cur.filter((v) => v !== pendingRemove.id));
            } else {
              setRoleIds((cur) => cur.filter((v) => v !== pendingRemove.id));
            }
          }
          setPendingRemove(null);
        }}
      />
      <Card>
        <CardHeader>
          <CardTitle>Admins</CardTitle>
          <CardDescription>
            Admins can run every command on every game. Right-click a user or role with Discord
            Developer Mode enabled to copy their ID.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>Admin User IDs</Label>
            <SnowflakeChipsInput
              value={userIds}
              onChange={setUserIds}
              placeholder="Paste or type a user ID, then press Enter"
              onRemoveChip={(id) => {
                if (isSuppressed('remove-admin')) {
                  setUserIds((cur) => cur.filter((v) => v !== id));
                } else {
                  setPendingRemove({ list: 'user', id });
                }
              }}
            />
          </div>
          <div className="space-y-2">
            <Label>Admin Role IDs</Label>
            <SnowflakeChipsInput
              value={roleIds}
              onChange={setRoleIds}
              placeholder="Paste or type a role ID, then press Enter"
              onRemoveChip={(id) => {
                if (isSuppressed('remove-admin')) {
                  setRoleIds((cur) => cur.filter((v) => v !== id));
                } else {
                  setPendingRemove({ list: 'role', id });
                }
              }}
            />
          </div>

          <div className="flex justify-end">
            <Button disabled={busy || !dirty} onClick={() => onSave({ userIds, roleIds })}>
              Save admins
            </Button>
          </div>

          {hasBaseAdmins && (
            <div className="border-t border-[var(--color-border)] pt-4 space-y-3">
              <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
                <ShieldCheck className="size-3.5" />
                Terraform-managed (read-only)
              </div>
              {cfg.baseAdmins.userIds.length > 0 && (
                <div>
                  <Label className="text-xs text-[var(--color-muted-foreground)]">
                    Admin User IDs
                  </Label>
                  <ChipList ids={cfg.baseAdmins.userIds} />
                </div>
              )}
              {cfg.baseAdmins.roleIds.length > 0 && (
                <div>
                  <Label className="text-xs text-[var(--color-muted-foreground)]">
                    Admin Role IDs
                  </Label>
                  <ChipList ids={cfg.baseAdmins.roleIds} />
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/**
 * Read-only badge list; used to display terraform-managed user/role IDs that
 * the operator can't edit from the UI.
 */
function ChipList({ ids }: { ids: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-1">
      {ids.map((id) => (
        <Badge key={id} variant="secondary" className="font-[var(--font-mono)]">
          {id}
        </Badge>
      ))}
    </div>
  );
}

/**
 * Editable chip-input for snowflake IDs. Tokens are committed on Enter, comma,
 * blur, or paste-with-separators. Invalid tokens stay in the draft input with
 * an inline error message; valid tokens turn into removable chips.
 */
function SnowflakeChipsInput({
  value,
  onChange,
  placeholder,
  onRemoveChip,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** When provided, called instead of removing the chip immediately — caller handles confirmation. */
  onRemoveChip?: (id: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  /**
   * Parse the current draft (plus optional pasted text) and commit any valid
   * snowflakes as chips. Invalid tokens are left in the input for the operator
   * to correct.
   */
  function commit(extra?: string) {
    const combined = (draft + (extra ? ' ' + extra : '')).trim();
    if (!combined) return;
    const { valid, invalid } = parseSnowflakes(combined);
    if (valid.length) onChange(uniq([...value, ...valid]));
    setDraft(invalid.join(', '));
    setError(invalid.length ? `Not a snowflake: ${invalid.join(', ')}` : null);
  }

  /** Remove a chip by id. */
  function removeAt(id: string) {
    onChange(value.filter((v) => v !== id));
  }

  return (
    <div>
      <div
        className={cn(
          'flex flex-wrap gap-1.5 p-2 min-h-9 rounded-[var(--radius-sm)] border bg-[var(--color-surface-2)] focus-within:ring-1 focus-within:ring-[var(--color-primary)]',
          error ? 'border-[var(--color-red)]' : 'border-[var(--color-border)]',
        )}
      >
        {value.map((id) => (
          <Badge key={id} variant="secondary" className="font-[var(--font-mono)] gap-1">
            {id}
            <button
              type="button"
              onClick={() => (onRemoveChip ? onRemoveChip(id) : removeAt(id))}
              aria-label={`Remove ${id}`}
              className="hover:text-[var(--color-red)]"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <input
          className="flex-1 min-w-[180px] bg-transparent outline-none text-sm font-[var(--font-mono)] placeholder:text-[var(--color-muted-foreground)]"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Backspace' && !draft && value.length) {
              const last = value[value.length - 1];
              if (onRemoveChip) {
                onRemoveChip(last);
              } else {
                onChange(value.slice(0, -1));
              }
            }
          }}
          onBlur={() => commit()}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (/[\s,\n]/.test(text)) {
              e.preventDefault();
              commit(text);
            }
          }}
          placeholder={placeholder}
        />
      </div>
      {error && (
        <p className="mt-1 text-xs text-[var(--color-red)] flex items-center gap-1">
          <AlertCircle className="size-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Per-game permissions table. Each row is independently editable with its own
 * Save button so operators can tune one game without touching the others.
 */
function PermissionsSection({
  cfg,
  games,
  busy,
  onSave,
  onDelete,
}: {
  cfg: DiscordConfigRedacted;
  games: string[];
  busy: boolean;
  onSave: (game: string, perm: DiscordGamePermission) => void;
  onDelete: (game: string) => void;
}) {
  if (!games.length) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">
          No games configured yet — run <code>terraform apply</code> first.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Per-Game Permissions</CardTitle>
        <CardDescription>
          One row per game. Edit the chips and action checkboxes inline, then Save the row. Clear
          drops the entry entirely.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[140px]">Game</TableHead>
              <TableHead>User IDs</TableHead>
              <TableHead>Role IDs</TableHead>
              <TableHead className="w-[200px]">Allowed actions</TableHead>
              <TableHead className="w-[160px] text-right">Save</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {games.map((game) => {
              const initial =
                cfg.gamePermissions[game] ?? { userIds: [], roleIds: [], actions: [] };
              // Re-key the row whenever the server-side entry changes so the
              // local userIds/roleIds/actions state reinitialises after Save
              // or Clear — without this, clearing leaves the chips and
              // checkboxes from the deleted entry on screen until reload.
              return (
                <PermissionRow
                  key={`${game}:${JSON.stringify(initial)}`}
                  game={game}
                  initial={initial}
                  busy={busy}
                  onSave={(perm) => onSave(game, perm)}
                  onDelete={() => onDelete(game)}
                />
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/**
 * Single editable row in the per-game permissions table. Holds its own draft
 * state so Save/Clear only fire on the row the operator is touching.
 */
function PermissionRow({
  game,
  initial,
  busy,
  onSave,
  onDelete,
}: {
  game: string;
  initial: DiscordGamePermission;
  busy: boolean;
  onSave: (perm: DiscordGamePermission) => void;
  onDelete: () => void;
}) {
  const [userIds, setUserIds] = useState<string[]>(initial.userIds);
  const [roleIds, setRoleIds] = useState<string[]>(initial.roleIds);
  const [actions, setActions] = useState<DiscordAction[]>(initial.actions);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);

  const dirty =
    JSON.stringify(userIds) !== JSON.stringify(initial.userIds) ||
    JSON.stringify(roleIds) !== JSON.stringify(initial.roleIds) ||
    JSON.stringify([...actions].sort()) !== JSON.stringify([...initial.actions].sort());

  /** Toggle an action in or out of the allowed-actions set. */
  function toggle(a: DiscordAction) {
    setActions((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]));
  }

  return (
    <>
      <ConfirmDialog
        open={clearDialogOpen}
        onOpenChange={setClearDialogOpen}
        title={`Clear permissions for ${game}?`}
        description="Per-game permissions will be reset. This is recoverable from infrastructure-as-code."
        confirmLabel="Clear"
        confirmKey="clear-permissions"
        onConfirm={() => { void onDelete(); }}
      />
      <TableRow>
        <TableCell className="font-medium capitalize align-top pt-4">{game}</TableCell>
        <TableCell className="align-top">
          <SnowflakeChipsInput value={userIds} onChange={setUserIds} placeholder="User IDs" />
        </TableCell>
        <TableCell className="align-top">
          <SnowflakeChipsInput value={roleIds} onChange={setRoleIds} placeholder="Role IDs" />
        </TableCell>
        <TableCell className="align-top pt-4">
          <div className="flex flex-col gap-1.5">
            {ALL_ACTIONS.map((a) => (
              <label key={a} className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={actions.includes(a)}
                  onChange={() => toggle(a)}
                  className="size-3.5 rounded border-[var(--color-border)] bg-[var(--color-surface-2)] accent-[var(--color-primary)]"
                />
                <span className="capitalize">{a}</span>
              </label>
            ))}
          </div>
        </TableCell>
        <TableCell className="text-right align-top pt-4">
          <div className="inline-flex flex-col gap-1.5">
            <Button
              size="sm"
              disabled={busy || !dirty}
              onClick={() => onSave({ userIds, roleIds, actions })}
            >
              Save
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (isSuppressed('clear-permissions')) {
                  void onDelete();
                } else {
                  setClearDialogOpen(true);
                }
              }}
            >
              Clear
            </Button>
          </div>
        </TableCell>
      </TableRow>
    </>
  );
}
