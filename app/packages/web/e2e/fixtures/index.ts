import { test as base, type Page } from '@playwright/test';
import type {
  GameStatus,
  CostEstimates,
  EnvInfo,
  ActionResult,
  WatchdogConfig,
  ActualCosts,
  DiscordConfigRedacted,
} from '@/api.js';
import {
  ENV_DATA,
  STOPPED_GAME,
  COST_DATA,
  WATCHDOG_CONFIG,
  CONFIGURED_DISCORD_CONFIG,
  makeActualCosts,
} from './game-data.js';
import { AppLayout, AuthGatePage, DashboardPage, CostsPage, LogsPage, SettingsPage } from '../pages/index.js';

export type {
  GameStatus,
  CostEstimates,
  EnvInfo,
  WatchdogConfig,
  ActualCosts,
  DiscordConfigRedacted,
};
export {
  ENV_DATA,
  STOPPED_GAME,
  RUNNING_GAME,
  MULTI_GAME_STATUSES,
  COST_DATA,
  MULTI_GAME_COST_DATA,
  WATCHDOG_CONFIG,
  ACTUAL_COSTS,
  makeActualCosts,
  FIRST_RUN_DISCORD_CONFIG,
  CONFIGURED_DISCORD_CONFIG,
  VALID_GUILD_ID,
  VALID_GUILD_ID_2,
  VALID_USER_ID,
  SAMPLE_LOG_LINES,
} from './game-data.js';
export { AppLayout, AuthGatePage, DashboardPage, CostsPage, LogsPage, SettingsPage } from '../pages/index.js';

/** Per-spec overrides for the default `/api/*` stubs registered by `stubApis`. */
export interface StubOptions {
  /** Game statuses returned by `GET /api/status`. Defaults to `[STOPPED_GAME]`. */
  statuses?: GameStatus[];
  /** Cost estimates returned by `GET /api/costs/estimate`. */
  costs?: CostEstimates;
  /**
   * Either a fixed `ActualCosts` payload returned for every `GET /api/costs/actual`
   * call, or a builder receiving the `days` query param so a spec can return
   * different totals per window (the Costs page calls both `days` and `days*2`).
   * Defaults to `makeActualCosts(days)` so the prior-period delta is non-zero.
   */
  actualCosts?: ActualCosts | ((days: number) => ActualCosts);
  /** Env info returned by `GET /api/env`. */
  env?: EnvInfo;
  /** Watchdog config returned by `GET /api/config`. */
  config?: WatchdogConfig;
  /** Override for `POST /api/start/:game` response. */
  startResult?: ActionResult;
  /**
   * Discord config returned by `GET /api/discord/config`. Defaults to
   * `CONFIGURED_DISCORD_CONFIG` so non-Discord specs hitting `/discord` (e.g.
   * sidebar nav) don't trip the catch-all 404 handler. Pass
   * `FIRST_RUN_DISCORD_CONFIG` to exercise the setup wizard.
   */
  discord?: DiscordConfigRedacted;
  /**
   * Game names returned by `GET /api/games` (used by the Logs page).
   * Defaults to the names derived from `statuses`. Override when the Logs
   * page should expose games that aren't part of `statuses`.
   */
  games?: string[];
  /**
   * Initial log lines returned by `GET /api/logs/:game` (used by the Logs
   * page). Maps game name → seeded lines. Games not present in the map
   * receive an empty buffer. The SSE stream at `/api/logs/:game/stream` is
   * always aborted so EventSource gives up immediately and tests don't hang
   * on a never-ending response.
   */
  logLines?: Record<string, string[]>;
}

/**
 * Registers Playwright route intercepts for all `/api/*` endpoints used by the
 * dashboard. Call before `page.goto()` in each spec that needs a running UI.
 *
 * Playwright matches routes in REVERSE registration order (last-registered
 * wins), so we register the catch-all FIRST and the specific stubs after —
 * that way `/api/status` hits the specific handler, while `/api/anything-else`
 * falls through to the catch-all 404 so missing stubs surface as fast failures
 * instead of hangs.
 */
export async function stubApis(page: Page, opts: StubOptions = {}): Promise<void> {
  const statuses = opts.statuses ?? [STOPPED_GAME];
  const costs = opts.costs ?? COST_DATA;
  const env = opts.env ?? ENV_DATA;
  const config = opts.config ?? WATCHDOG_CONFIG;
  const startResult: ActionResult = opts.startResult ?? { success: true, message: 'Started' };
  const discord = opts.discord ?? CONFIGURED_DISCORD_CONFIG;
  const games = opts.games ?? statuses.map((s) => s.game);
  const logLines = opts.logLines ?? {};
  const actualCostsFn: (days: number) => ActualCosts =
    typeof opts.actualCosts === 'function'
      ? opts.actualCosts
      : opts.actualCosts !== undefined
        ? () => opts.actualCosts as ActualCosts
        : (days) => makeActualCosts(days);

  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, json: { error: 'not stubbed' } })
  );

  await page.route('**/api/env', (route) => route.fulfill({ json: env }));

  await page.route('**/api/status', (route) => route.fulfill({ json: statuses }));

  await page.route('**/api/status/*', (route) => {
    const game = new URL(route.request().url()).pathname.split('/').pop()!;
    const s = statuses.find((x) => x.game === game) ?? statuses[0];
    return route.fulfill({ json: s });
  });

  await page.route('**/api/games', (route) => route.fulfill({ json: { games } }));

  await page.route('**/api/costs/estimate', (route) => route.fulfill({ json: costs }));

  // Trailing `*` matches the `?days=N` query string — Playwright globs are
  // matched against the full URL, and `*` (= `[^/]*`) covers query payloads
  // that never contain a slash.
  await page.route('**/api/costs/actual*', (route) => {
    const days = parseInt(new URL(route.request().url()).searchParams.get('days') ?? '7', 10);
    return route.fulfill({ json: actualCostsFn(days) });
  });

  await page.route('**/api/config', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ json: { success: true, config } });
    }
    return route.fulfill({ json: config });
  });

  await page.route('**/api/start/*', (route) => route.fulfill({ json: startResult }));

  await page.route('**/api/stop/*', (route) =>
    route.fulfill({ json: { success: true, message: 'Stopped' } as ActionResult })
  );

  // Discord — read endpoint plus permissive write endpoints. Specs that need
  // to assert request bodies should override these with their own page.route().
  await page.route('**/api/discord/config', (route) => {
    if (route.request().method() === 'PUT') {
      return route.fulfill({ json: { success: true, config: discord } });
    }
    return route.fulfill({ json: discord });
  });
  await page.route('**/api/discord/guilds', (route) =>
    route.fulfill({ json: { success: true, guilds: discord.allowedGuilds } }),
  );
  await page.route('**/api/discord/guilds/*', (route) =>
    route.fulfill({ json: { success: true, guilds: discord.allowedGuilds } }),
  );
  await page.route('**/api/discord/guilds/*/register-commands', (route) =>
    route.fulfill({ json: { success: true, message: 'Registered' } }),
  );
  await page.route('**/api/discord/admins', (route) =>
    route.fulfill({ json: { success: true, admins: discord.admins } }),
  );
  await page.route('**/api/discord/permissions/*', (route) =>
    route.fulfill({ json: { success: true, permissions: discord.gamePermissions } }),
  );

  // Logs page — the SSE stream is aborted so EventSource gives up immediately.
  // Specs that need to drive the stream can override this route after stubApis().
  // The `/stream*` glob is registered AFTER `/api/logs/*` so it wins for SSE
  // URLs (Playwright matches routes in reverse registration order).
  await page.route('**/api/logs/*', (route) => {
    const url = new URL(route.request().url());
    const game = url.pathname.split('/').pop()!;
    return route.fulfill({ json: { game, lines: logLines[game] ?? [] } });
  });
  await page.route('**/api/logs/*/stream*', (route) => route.abort());
}

type E2EFixtures = {
  /**
   * A page with `apiToken` pre-seeded in localStorage so every navigation
   * starts authenticated. Use this in specs that need raw page access (e.g.
   * to call `stubApis` or `addInitScript`); prefer `dashboard` / `costs` /
   * `layout` for higher-level interactions.
   */
  authedPage: Page;
  /** Page object for the dashboard route — use in any authed-dashboard spec. */
  dashboard: DashboardPage;
  /** Page object for the `/costs` route — use in any authed-costs spec. */
  costs: CostsPage;
  /** Page object for the `/logs` route — use in any authed-logs spec. */
  logs: LogsPage;
  /** Page object for the `/settings` route — use in any authed-settings spec. */
  settings: SettingsPage;
  /** Page object for the persistent nav shell (sidebar + top bar). */
  layout: AppLayout;
  /** Page object for the API-token modal — use in auth-gate specs. */
  authGate: AuthGatePage;
};

export const test = base.extend<E2EFixtures>({
  authedPage: async ({ page }, use) => {
    await page.addInitScript(() => {
      localStorage.setItem('apiToken', 'test-token');
    });
    await use(page);
  },
  // `dashboard` and `costs` depend on `authedPage` because every authed-route
  // spec wants the token pre-seeded. `layout` and `authGate` depend on the raw
  // `page` so auth-gate specs (which exercise the unauthenticated state) can
  // use them without dragging the init script along.
  dashboard: async ({ authedPage }, use) => {
    await use(new DashboardPage(authedPage));
  },
  costs: async ({ authedPage }, use) => {
    await use(new CostsPage(authedPage));
  },
  logs: async ({ authedPage }, use) => {
    await use(new LogsPage(authedPage));
  },
  settings: async ({ authedPage }, use) => {
    await use(new SettingsPage(authedPage));
  },
  layout: async ({ page }, use) => {
    await use(new AppLayout(page));
  },
  authGate: async ({ page }, use) => {
    await use(new AuthGatePage(page));
  },
});

export { expect } from '@playwright/test';
