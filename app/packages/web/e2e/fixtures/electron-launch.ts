/**
 * Reusable helpers for the Playwright `electron` project.
 *
 * Provides two exports:
 *
 * - `launchElectron()` — launches the packaged Electron app via
 *   `_electron.launch()` using the `electronMain` / `electronEnv` values
 *   from the playwright config, and returns `{ app, win }` where `win` is the
 *   first-opened `Page`.
 *
 * - `applyGsdMocks(win, opts)` — seeds `window.gsd.__test.mock()` for every
 *   IPC channel the dashboard and its shared provider stack consume, using the
 *   same `StubOptions` shape and `game-data` fixture constants that the
 *   Chromium tier uses for `page.route()` stubs. Designed to be called inside
 *   a `beforeEach` or at the top of a test body, before navigating to a page.
 */

import type { Page } from '@playwright/test';
import { _electron } from '@playwright/test';
import { electronMain, electronEnv } from '../../playwright.config.js';
import type { StubOptions } from './index.js';
import {
  ENV_DATA,
  STOPPED_GAME,
  COST_DATA,
  WATCHDOG_CONFIG,
  CONFIGURED_DISCORD_CONFIG,
  makeActualCosts,
} from './game-data.js';
import type {
  GameStatus,
  ActionResult,
  CostEstimates,
  ActualCosts,
  EnvInfo,
  WatchdogConfig,
  DiscordConfigRedacted,
} from './index.js';
import type { ElectronApplication } from 'playwright-core';

// ---------------------------------------------------------------------------
// launchElectron
// ---------------------------------------------------------------------------

/** Return value of {@link launchElectron}. */
export interface ElectronHandle {
  /** The `ElectronApplication` instance — close it in the test's `finally` block. */
  app: ElectronApplication;
  /** The first opened `Page` (the renderer window). */
  win: Page;
}

/**
 * Launches the packaged Electron app and waits for the first `BrowserWindow`.
 *
 * Uses the `electronMain` entry-point and `electronEnv` (which includes
 * `HYVEON_TEST_MODE=1`) exported from the playwright config, so all Electron
 * e2e specs go through the same launch configuration without duplicating it.
 *
 * @example
 * ```ts
 * test('should show the dashboard', async () => {
 *   const { app, win } = await launchElectron();
 *   try {
 *     await applyGsdMocks(win, { statuses: [RUNNING_GAME] });
 *     await win.goto('/');
 *     // ...assertions...
 *   } finally {
 *     await app.close();
 *   }
 * });
 * ```
 */
export async function launchElectron(): Promise<ElectronHandle> {
  const app = await _electron.launch({ args: [electronMain], env: electronEnv });
  const win = await app.firstWindow();
  return { app, win };
}

// ---------------------------------------------------------------------------
// applyGsdMocks
// ---------------------------------------------------------------------------

/**
 * Seeds `window.gsd.__test.mock()` for every IPC channel the dashboard and
 * its shared provider stack call at startup.
 *
 * Mirrors the defaults and per-spec overrides of `stubApis` so the same
 * `StubOptions` vocabulary works for both the Chromium and Electron tiers.
 * Must be called **before** the renderer navigates to the page under test
 * (i.e. before `win.goto()`), because the preload consults the mock registry
 * on each `invoke()` call.
 *
 * The following channels are mocked:
 * - `env.get`         → `EnvInfo`
 * - `games.status`    → `GameStatus[]`
 * - `games.list`      → `{ games: string[] }`
 * - `costs.estimate`  → `CostEstimates`
 * - `costs.actual`    → `ActualCosts` (receives the `days` argument)
 * - `games.start`     → `ActionResult`
 * - `games.stop`      → `ActionResult`
 * - `discord.getConfig` → `DiscordConfigRedacted`
 * - `config.get`      → `WatchdogConfig`
 *
 * @param win  - The Playwright `Page` for the Electron renderer window.
 * @param opts - Per-spec overrides; uses the same defaults as `stubApis`.
 */
export async function applyGsdMocks(win: Page, opts: StubOptions = {}): Promise<void> {
  const statuses: GameStatus[] = opts.statuses ?? [STOPPED_GAME];
  const costs: CostEstimates = opts.costs ?? COST_DATA;
  const env: EnvInfo = opts.env ?? ENV_DATA;
  const config: WatchdogConfig = opts.config ?? WATCHDOG_CONFIG;
  const startResult: ActionResult = opts.startResult ?? { success: true, message: 'Started' };
  const discord: DiscordConfigRedacted = opts.discord ?? CONFIGURED_DISCORD_CONFIG;
  const games: string[] = opts.games ?? statuses.map((s) => s.game);
  const actualCostsFn: (days: number) => ActualCosts =
    typeof opts.actualCosts === 'function'
      ? opts.actualCosts
      : opts.actualCosts !== undefined
        ? () => opts.actualCosts as ActualCosts
        : (days) => makeActualCosts(days);

  // Playwright serialises the `evaluate` callback to source and re-evaluates
  // it in the browser context, so we snapshot all values into plain objects
  // and pass them as a single serialisable argument.
  await win.evaluate(
    ({
      envData,
      statusList,
      gameList,
      costEstimates,
      startRes,
      discordConfig,
      watchdogConfig,
      actualCostsMap,
    }: {
      envData: EnvInfo;
      statusList: GameStatus[];
      gameList: string[];
      costEstimates: CostEstimates;
      startRes: ActionResult;
      discordConfig: DiscordConfigRedacted;
      watchdogConfig: WatchdogConfig;
      actualCostsMap: Record<string, ActualCosts>;
    }) => {
      const gsd = (window as Record<string, unknown>)['gsd'] as {
        __test: { mock: (channel: string, handler: unknown) => void };
      };

      gsd.__test.mock('env.get', () => Promise.resolve(envData));
      gsd.__test.mock('games.status', () => Promise.resolve(statusList));
      gsd.__test.mock('games.list', () => Promise.resolve({ games: gameList }));
      gsd.__test.mock('costs.estimate', () => Promise.resolve(costEstimates));
      gsd.__test.mock('costs.actual', (days: unknown) => {
        const d = typeof days === 'number' ? days : 7;
        const key = String(d);
        return Promise.resolve(actualCostsMap[key] ?? actualCostsMap['7']);
      });
      gsd.__test.mock('games.start', () => Promise.resolve(startRes));
      gsd.__test.mock('games.stop', () => Promise.resolve({ success: true, message: 'Stopped' }));
      gsd.__test.mock('discord.getConfig', () => Promise.resolve(discordConfig));
      gsd.__test.mock('config.get', () => Promise.resolve(watchdogConfig));
    },
    {
      envData: env,
      statusList: statuses,
      gameList: games,
      costEstimates: costs,
      startRes: startResult,
      discordConfig: discord,
      watchdogConfig: config,
      // Pre-compute the costs.actual responses for the query windows the Costs
      // page uses (7 and 14 days) so the callback in the browser can do a
      // synchronous map lookup without calling back into Node.
      actualCostsMap: { '7': actualCostsFn(7), '14': actualCostsFn(14) },
    },
  );
}
