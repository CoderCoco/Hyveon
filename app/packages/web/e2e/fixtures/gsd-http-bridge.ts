/**
 * Browser-side test shim that installs `window.gsd` as a thin HTTP forwarder.
 *
 * Production builds receive `window.gsd` from the Electron preload script, but
 * the Playwright tiers run the web bundle in a plain browser with no Electron
 * host. Since `api.service.ts` now talks exclusively to `window.gsd.*`, this
 * shim re-routes each IPC-shaped call back to the matching `/api/*` HTTP
 * endpoint — which is exactly what both tiers already provide: tier-1 e2e
 * intercepts `/api/*` with `page.route`, and tier-2 integration proxies it to
 * the real Nest server. That keeps every existing stub and HTTP-contract
 * assertion working unchanged while the app speaks IPC.
 *
 * Pass this function (not a call to it) to `page.addInitScript` so it runs in
 * the browser before any app code:
 *
 * ```ts
 * await page.addInitScript(installGsdHttpBridge);
 * ```
 *
 * It is intentionally self-contained — it closes over no module-scope bindings —
 * because Playwright serialises it to source and re-evaluates it in the page.
 * The bearer token is read from `localStorage` on every call, mirroring the
 * old `fetchWithAuth`, so it picks up whatever the `authedPage` fixture seeded.
 */
export function installGsdHttpBridge(): void {
  const authHeader = (): Record<string, string> => {
    const token = localStorage.getItem('apiToken') ?? '';
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await fetch(path, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), ...authHeader() },
    });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  };

  const post = (path: string): Promise<unknown> => call(path, { method: 'POST' });
  const del = (path: string): Promise<unknown> => call(path, { method: 'DELETE' });
  const withBody = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  (window as Record<string, unknown>)['gsd'] = {
    env: { get: () => call('/api/env') },
    games: {
      list: () => call('/api/games'),
      status: () => call('/api/status'),
      getStatus: (game: string) => call(`/api/status/${game}`),
      start: (game: string) => post(`/api/start/${game}`),
      stop: (game: string) => post(`/api/stop/${game}`),
    },
    costs: {
      estimate: () => call('/api/costs/estimate'),
      actual: (days = 7) => call(`/api/costs/actual?days=${days}`),
    },
    files: {
      list: (game: string) => call(`/api/files/${game}`),
      start: (game: string) => post(`/api/files/${game}/start`),
      stop: (game: string) => post(`/api/files/${game}/stop`),
    },
    discord: {
      getConfig: () => call('/api/discord/config'),
      putConfig: (body: unknown) => call('/api/discord/config', withBody('PUT', body)),
      addGuild: (guildId: string) => call('/api/discord/guilds', withBody('POST', { guildId })),
      removeGuild: (guildId: string) => del(`/api/discord/guilds/${guildId}`),
      registerCommands: (guildId: string) => post(`/api/discord/guilds/${guildId}/register-commands`),
      putAdmins: (body: unknown) => call('/api/discord/admins', withBody('PUT', body)),
      putPermission: (game: string, body: unknown) =>
        call(`/api/discord/permissions/${game}`, withBody('PUT', body)),
      deletePermission: (game: string) => del(`/api/discord/permissions/${game}`),
    },
    config: {
      get: () => call('/api/config'),
      update: (body: unknown) => call('/api/config', withBody('POST', body)),
    },
    diagnostics: {
      tail: () => call('/api/diagnostics/tail'),
      path: () => call('/api/diagnostics/path'),
    },
    // Logs are IPC-only in production with no HTTP route; tier-1 overrides this
    // with a data-backed stub (see `stubApis`) and no tier-2 spec visits /logs,
    // so this forwarder exists only for shape completeness.
    logs: {
      get: (game: string, limit?: number) =>
        call(`/api/logs/${game}${limit ? `?limit=${limit}` : ''}`),
      stream: async function* () {},
    },
  };
}
