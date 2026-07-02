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
import { AppLayout, DashboardPage, CostsPage, LogsPage, SettingsPage } from '../pages/index.js';
import { installGsdHttpBridge } from './gsd-http-bridge.js';

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
export { AppLayout, DashboardPage, CostsPage, DiscordPage, LogsPage, SettingsPage } from '../pages/index.js';

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
   * Initial log lines surfaced via `window.gsd.logs.get(game)` (used by the
   * Logs page). Maps game name → seeded lines. Games not present in the map
   * receive an empty buffer.
   *
   * `stubApis` injects a `window.gsd.logs` stub via `addInitScript` so that
   * `LogsPage` can call `window.gsd.logs.get` and `window.gsd.logs.stream`
   * without a real Electron main process. The stream stub is an async iterable
   * that yields nothing, so specs drive off the seeded snapshot only.
   */
  logLines?: Record<string, string[]>;
}

/**
 * Registers Playwright route intercepts for all `/api/*` endpoints used by the
 * dashboard, and injects a `window.gsd.logs` stub via `addInitScript` so the
 * Logs page can call `window.gsd.logs.get` / `window.gsd.logs.stream` without
 * a real Electron main process.
 *
 * Must be called before `page.goto()` in each spec that needs a running UI.
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

  // The web client now talks exclusively to `window.gsd.*`, so install a
  // browser-side bridge that forwards each IPC call to the matching `/api/*`
  // endpoint the route stubs above already answer. Registered before page JS
  // via addInitScript so `window.gsd` exists when app code first runs.
  await page.addInitScript(installGsdHttpBridge);

  // Logs page — override `window.gsd.logs` with a data-backed stub so LogsPage
  // can call `window.gsd.logs.get` / `window.gsd.logs.stream` without a real
  // Electron main process or an HTTP logs route (logs are IPC-only). This runs
  // after the bridge init script and *merges* over it, preserving every other
  // namespace the bridge installed. The seeded logLines map is passed as a
  // serialisable arg.
  //
  // The stream stub is an async generator that yields nothing and returns
  // immediately, so the component's `for await` loop completes without emitting
  // live chunks — specs drive off the seeded snapshot only.
  await page.addInitScript(
    ({ lines }: { lines: Record<string, string[]> }) => {
      const existing = (window as Record<string, unknown>)['gsd'] as Record<string, unknown> | undefined;
      (window as Record<string, unknown>)['gsd'] = {
        ...(existing ?? {}),
        logs: {
          get: (game: string) =>
            Promise.resolve({ game, lines: lines[game] ?? [] }),
          stream: async function* (_game: string, _signal?: AbortSignal) {},
        },
      };
    },
    { lines: logLines },
  );
}

type E2EFixtures = {
  /** Page object for the dashboard route. */
  dashboard: DashboardPage;
  /** Page object for the `/costs` route. */
  costs: CostsPage;
  /** Page object for the `/logs` route. */
  logs: LogsPage;
  /** Page object for the `/settings` route. */
  settings: SettingsPage;
  /** Page object for the persistent nav shell (sidebar + top bar). */
  layout: AppLayout;
};

export const test = base.extend<E2EFixtures>({
  // Every page object wraps the raw `page` fixture directly — there's no
  // token seeding or auth gate to resolve through.
  dashboard: async ({ page }, use) => {
    await use(new DashboardPage(page));
  },
  costs: async ({ page }, use) => {
    await use(new CostsPage(page));
  },
  logs: async ({ page }, use) => {
    await use(new LogsPage(page));
  },
  settings: async ({ page }, use) => {
    await use(new SettingsPage(page));
  },
  layout: async ({ page }, use) => {
    await use(new AppLayout(page));
  },
});

// `_electron` is re-exported so Electron specs import their whole Playwright
// surface (`test`, `expect`, `_electron`) from this single shared entrypoint.
// The extended `test` carries browser-page fixtures, but those are lazy — an
// Electron spec that drives its own `_electron.launch()` and requests no page
// fixtures never instantiates them.
export { expect, _electron } from '@playwright/test';
export type { Page } from '@playwright/test';
export type { ElectronApplication } from 'playwright-core';

export { launchElectron, applyGsdMocks } from './electron-launch.js';
export type { ElectronHandle } from './electron-launch.js';

// Electron IPC mock helpers — seed all Discord channels from a fixture or
// clear the entire mock registry via `window.gsd.__test`.
export { seedDiscordMocks, clearElectronMocks } from './electron-mock.js';
