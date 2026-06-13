// Typed API wrappers — all fetch calls go through here

/** Live status for a single game, as returned by `GET /api/status` and `/api/status/:game`. */
export interface GameStatus {
  game: string;
  state: 'running' | 'starting' | 'stopped' | 'not_deployed' | 'error';
  publicIp?: string;
  hostname?: string;
  taskArn?: string;
  message?: string;
}

/** Result envelope for mutation endpoints (start/stop), with a user-facing message. */
export interface ActionResult {
  success: boolean;
  message: string;
  taskArn?: string;
}

/** Watchdog tuning knobs persisted in `server_config.json` and read/written via `/api/config`. */
export interface WatchdogConfig {
  watchdog_interval_minutes: number;
  watchdog_idle_checks: number;
  watchdog_min_packets: number;
}

/** Per-game Fargate cost breakdown used by `CostsPage` and `GameCard` to surface hourly/monthly estimates. */
export interface GameEstimate {
  vcpu: number;
  memoryGb: number;
  costPerHour: number;
  costPerDay24h: number;
  costPerMonth4hpd: number;
}

/** Aggregate cost estimates returned by `GET /api/costs/estimate`. */
export interface CostEstimates {
  games: Record<string, GameEstimate>;
  totalPerHourIfAllOn: number;
}

/** Actual daily AWS Cost Explorer spend returned by `GET /api/costs/actual`. */
export interface ActualCosts {
  daily: { date: string; cost: number }[];
  total: number;
  currency: string;
  days: number;
  error?: string;
}

/** Status of the FileBrowser helper task per game, returned by `GET /api/files/:game`. */
export interface FileMgrStatus {
  game: string;
  state: 'running' | 'starting' | 'stopped' | 'not_deployed';
  url?: string;
  taskArn?: string;
}

/** Discord slash-command action a user can be permitted to invoke on a game. */
export type DiscordAction = 'start' | 'stop' | 'status';

/** Users and roles with server-wide admin privileges (all commands on all games). */
export interface DiscordAdmins {
  userIds: string[];
  roleIds: string[];
}

/** Per-game permission entry: which users/roles can run which actions on this game. */
export interface DiscordGamePermission {
  userIds: string[];
  roleIds: string[];
  actions: DiscordAction[];
}

/**
 * Discord config returned by `GET /api/discord/config`. Neither the bot token
 * nor the application public key is ever sent to the client — the `*Set`
 * booleans indicate whether each secret is configured in AWS Secrets Manager.
 *
 * `interactionsEndpointUrl` is the Lambda Function URL the operator pastes
 * into the Discord developer portal as the "Interactions Endpoint URL".
 */
export interface DiscordConfigRedacted {
  clientId: string;
  allowedGuilds: string[];
  admins: DiscordAdmins;
  gamePermissions: Record<string, DiscordGamePermission>;
  /** Guild IDs locked in by Terraform — non-removable via the UI. */
  baseAllowedGuilds: string[];
  /** Admin user/role IDs locked in by Terraform — non-removable via the UI. */
  baseAdmins: DiscordAdmins;
  botTokenSet: boolean;
  publicKeySet: boolean;
  interactionsEndpointUrl: string | null;
}

/** Result of a server-side mutation that may surface a human-readable error to the UI. */
export interface DiscordMutationResult {
  success: boolean;
  message: string;
}

/** Environment context returned by `GET /api/env`. */
export interface EnvInfo {
  region: string;
  domain: string;
  environment: string;
}

const TOKEN_STORAGE_KEY = 'apiToken';

/** Read the stored API bearer token from localStorage (returns empty string if unset). */
export function getStoredApiToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Persist the API bearer token for subsequent requests. Clear with `''`. */
export function setStoredApiToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // localStorage unavailable (private mode, etc.); failures are non-fatal — user will just be re-prompted.
  }
}

let unauthorizedHandler: (() => void) | null = null;
/** Register the function called when an `/api/*` request returns 401. The App component sets this on mount. */
export function setUnauthorizedHandler(h: (() => void) | null): void {
  unauthorizedHandler = h;
}

interface PendingRetry {
  url: string;
  init: RequestInit | undefined;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * Requests parked when the server returned 401. They wait for the operator to
 * supply a valid token via `ApiTokenModal`, at which point `retryPendingAfterAuth`
 * re-issues each one with the new bearer.
 */
const pendingRetries: PendingRetry[] = [];

/** Internal sentinel — `request` recognises it and parks the caller's promise; `retryPendingAfterAuth` recognises it on a retry to mark the new token as still bad. */
const UNAUTHORIZED = Symbol('api.unauthorized');

async function fetchWithAuth<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getStoredApiToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    setStoredApiToken('');
    throw UNAUTHORIZED;
  }
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json() as Promise<T>;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  try {
    return await fetchWithAuth<T>(url, init);
  } catch (err) {
    if (err !== UNAUTHORIZED) throw err;
    return new Promise<T>((resolve, reject) => {
      pendingRetries.push({
        url,
        init,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      unauthorizedHandler?.();
    });
  }
}

/**
 * Re-issues every request that was parked on a 401 using the now-current
 * stored token. Called by `ApiTokenModal` after the operator supplies a token.
 *
 * @returns `true` if every retry succeeded (the modal can dismiss);
 *          `false` if any retry returned 401 again (the modal stays open and
 *          shows an inline error). Requests that 401 again stay queued so the
 *          next save attempt retries them.
 */
export async function retryPendingAfterAuth(): Promise<boolean> {
  const queued = pendingRetries.splice(0);
  let allOk = true;
  for (const entry of queued) {
    try {
      const value = await fetchWithAuth(entry.url, entry.init);
      entry.resolve(value);
    } catch (err) {
      if (err === UNAUTHORIZED) {
        allOk = false;
        pendingRetries.push(entry);
      } else {
        entry.reject(err);
      }
    }
  }
  return allOk;
}

export const api = {
  env: () => request<EnvInfo>('/api/env'),
  games: () => request<{ games: string[] }>('/api/games'),
  status: () => request<GameStatus[]>('/api/status'),
  statusGame: (game: string) => request<GameStatus>(`/api/status/${game}`),
  start: (game: string) => request<ActionResult>(`/api/start/${game}`, { method: 'POST' }),
  stop: (game: string) => request<ActionResult>(`/api/stop/${game}`, { method: 'POST' }),
  config: () => request<WatchdogConfig>('/api/config'),
  saveConfig: (cfg: WatchdogConfig) =>
    request<{ success: boolean; config: WatchdogConfig }>('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    }),
  costsEstimate: () => request<CostEstimates>('/api/costs/estimate'),
  costsActual: (days = 7) => request<ActualCosts>(`/api/costs/actual?days=${days}`),
  filesMgrStatus: (game: string) => request<FileMgrStatus>(`/api/files/${game}`),
  filesMgrStart: (game: string) => request<ActionResult>(`/api/files/${game}/start`, { method: 'POST' }),
  filesMgrStop: (game: string) => request<ActionResult>(`/api/files/${game}/stop`, { method: 'POST' }),

  discordConfig: () => request<DiscordConfigRedacted>('/api/discord/config'),
  discordSaveCredentials: (body: { botToken?: string; clientId?: string; publicKey?: string }) =>
    request<{ success: boolean; config: DiscordConfigRedacted }>('/api/discord/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  discordAddGuild: (guildId: string) =>
    request<{ success: boolean; guilds: string[] }>('/api/discord/guilds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guildId }),
    }),
  discordRemoveGuild: (guildId: string) =>
    request<{ success: boolean; guilds: string[] }>(`/api/discord/guilds/${guildId}`, {
      method: 'DELETE',
    }),
  discordRegisterCommands: (guildId: string) =>
    request<DiscordMutationResult>(`/api/discord/guilds/${guildId}/register-commands`, {
      method: 'POST',
    }),
  discordSaveAdmins: (admins: DiscordAdmins) =>
    request<{ success: boolean; admins: DiscordAdmins }>('/api/discord/admins', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(admins),
    }),
  discordSavePermission: (game: string, perm: DiscordGamePermission) =>
    request<{ success: boolean; permissions: Record<string, DiscordGamePermission> }>(
      `/api/discord/permissions/${game}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(perm),
      },
    ),
  discordDeletePermission: (game: string) =>
    request<{ success: boolean; permissions: Record<string, DiscordGamePermission> }>(
      `/api/discord/permissions/${game}`,
      { method: 'DELETE' },
    ),

  diagnosticsTail: () => request<{ lines: string[] }>('/api/diagnostics/tail'),
  diagnosticsLogPath: () => request<{ path: string }>('/api/diagnostics/path'),
};
