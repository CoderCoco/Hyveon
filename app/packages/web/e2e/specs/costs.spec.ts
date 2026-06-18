import { test, expect, _electron, makeActualCosts, COST_DATA, MULTI_GAME_COST_DATA, STOPPED_GAME } from '../fixtures/index.js';
import { electronMain, electronEnv } from '../../playwright.config.js';
import { CostsPage } from '../pages/index.js';
import type { ActualCosts, CostEstimates, GameStatus } from '../fixtures/index.js';

/**
 * Specs for the `/costs` route added in CoderCoco/Hyveon#61.
 *
 * Each test launches its own Electron shell, mocks the three IPC channels
 * consumed by the Costs page (`costs.estimate`, `costs.actual`, `games.status`)
 * via `window.gsd.__test.mock`, then navigates to `/costs` via history injection
 * (`CostsPage.gotoElectron`).
 *
 * Filter / sort exercises pass `MULTI_GAME_COST_DATA` so the table has more
 * than one row to interact with; the default `COST_DATA` only contains
 * `minecraft`.
 */
test.describe('costs page', () => {
  test('should render the cost analysis heading', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      await win.evaluate(
        ({ estimate, statuses }: { estimate: CostEstimates; statuses: GameStatus[] }) => {
          const gsd = (window as Record<string, unknown>)['gsd'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          gsd.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          gsd.__test.mock('costs.actual', (days: unknown) =>
            Promise.resolve({ daily: [], total: 0, currency: 'USD', days: days as number }),
          );
          gsd.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: COST_DATA, statuses: [STOPPED_GAME] },
      );

      await costs.gotoElectron();

      await expect(costs.heading()).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('should display the trailing-window total spend KPI', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      // The page fetches `days*2 = 14` and uses the newer 7 entries as the
      // current window. `makeActualCosts(14)` puts $1.00/day in the second
      // half, so the current total is 7 × $1.00 = $7.00.
      const actual14 = makeActualCosts(14);
      await win.evaluate(
        ({
          estimate,
          statuses,
          actual,
        }: {
          estimate: CostEstimates;
          statuses: GameStatus[];
          actual: ActualCosts;
        }) => {
          const gsd = (window as Record<string, unknown>)['gsd'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          gsd.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          gsd.__test.mock('costs.actual', () => Promise.resolve(actual));
          gsd.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: COST_DATA, statuses: [STOPPED_GAME], actual: actual14 },
      );

      await costs.gotoElectron();

      await expect(costs.totalLabel(7)).toBeVisible();
      await expect(costs.kpiValue('$7.00')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('should render a delta-vs-prior pill', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      // Two-tier daily cost makes current > prior, so the pill shows "vs prior"
      // rather than the "no prior period" fallback.
      const actualCosts14 = makeActualCosts(14);
      await win.evaluate(
        ({
          estimate,
          statuses,
          actual14,
        }: {
          estimate: CostEstimates;
          statuses: GameStatus[];
          actual14: ActualCosts;
        }) => {
          const gsd = (window as Record<string, unknown>)['gsd'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          gsd.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          gsd.__test.mock('costs.actual', () => Promise.resolve(actual14));
          gsd.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: COST_DATA, statuses: [STOPPED_GAME], actual14: actualCosts14 },
      );

      await costs.gotoElectron();

      await expect(costs.deltaPill()).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('should render stacked bar segments for each game', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      const actualCosts14 = makeActualCosts(14);
      await win.evaluate(
        ({
          estimate,
          statuses,
          actual14,
        }: {
          estimate: CostEstimates;
          statuses: GameStatus[];
          actual14: ActualCosts;
        }) => {
          const gsd = (window as Record<string, unknown>)['gsd'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          gsd.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          gsd.__test.mock('costs.actual', () => Promise.resolve(actual14));
          gsd.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: MULTI_GAME_COST_DATA, statuses: [STOPPED_GAME], actual14: actualCosts14 },
      );

      await costs.gotoElectron();

      await expect(costs.chartTitle()).toBeVisible();
      await expect(costs.chartSegment('minecraft').first()).toBeVisible();
      await expect(costs.chartSegment('valheim').first()).toBeVisible();
      await expect(costs.chartSegment('palworld').first()).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('should sort estimates by $/hour descending by default', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      const actualCosts14 = makeActualCosts(14);
      await win.evaluate(
        ({
          estimate,
          statuses,
          actual14,
        }: {
          estimate: CostEstimates;
          statuses: GameStatus[];
          actual14: ActualCosts;
        }) => {
          const gsd = (window as Record<string, unknown>)['gsd'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          gsd.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          gsd.__test.mock('costs.actual', () => Promise.resolve(actual14));
          gsd.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: MULTI_GAME_COST_DATA, statuses: [STOPPED_GAME], actual14: actualCosts14 },
      );

      await costs.gotoElectron();

      const rows = costs.tableRows();
      // Row 0 is the header; rows 1..3 are the games sorted $/hr desc:
      // palworld ($0.32) > valheim ($0.16) > minecraft ($0.08).
      await expect(rows.nth(1)).toContainText('palworld');
      await expect(rows.nth(2)).toContainText('valheim');
      await expect(rows.nth(3)).toContainText('minecraft');
    } finally {
      await app.close();
    }
  });

  test('should re-sort estimates by game name when the Game header is clicked', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      const actualCosts14 = makeActualCosts(14);
      await win.evaluate(
        ({
          estimate,
          statuses,
          actual14,
        }: {
          estimate: CostEstimates;
          statuses: GameStatus[];
          actual14: ActualCosts;
        }) => {
          const gsd = (window as Record<string, unknown>)['gsd'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          gsd.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          gsd.__test.mock('costs.actual', () => Promise.resolve(actual14));
          gsd.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: MULTI_GAME_COST_DATA, statuses: [STOPPED_GAME], actual14: actualCosts14 },
      );

      await costs.gotoElectron();
      await costs.clickSort('Game');

      const rows = costs.tableRows();
      // After clicking Game, default direction is ascending alphabetical.
      await expect(rows.nth(1)).toContainText('minecraft');
      await expect(rows.nth(2)).toContainText('palworld');
      await expect(rows.nth(3)).toContainText('valheim');
    } finally {
      await app.close();
    }
  });

  test('should filter estimates via the search input', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      const actualCosts14 = makeActualCosts(14);
      await win.evaluate(
        ({
          estimate,
          statuses,
          actual14,
        }: {
          estimate: CostEstimates;
          statuses: GameStatus[];
          actual14: ActualCosts;
        }) => {
          const gsd = (window as Record<string, unknown>)['gsd'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          gsd.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          gsd.__test.mock('costs.actual', () => Promise.resolve(actual14));
          gsd.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: MULTI_GAME_COST_DATA, statuses: [STOPPED_GAME], actual14: actualCosts14 },
      );

      await costs.gotoElectron();
      await costs.filter('val');

      await expect(costs.tableCell(/valheim/)).toBeVisible();
      await expect(costs.tableCell(/minecraft/)).toHaveCount(0);
      await expect(costs.tableCell(/palworld/)).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('should switch the active window when clicking 30d', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const costs = new CostsPage(win);

      // Register a days-aware mock: days=14 for the initial 7d view,
      // days=60 for the 30d view. makeActualCosts(N) is called in the
      // Playwright process and the payload is serialised per call.
      const actual14 = makeActualCosts(14);
      const actual60 = makeActualCosts(60);
      await win.evaluate(
        ({
          estimate,
          statuses,
          a14,
          a60,
        }: {
          estimate: CostEstimates;
          statuses: GameStatus[];
          a14: ActualCosts;
          a60: ActualCosts;
        }) => {
          const gsd = (window as Record<string, unknown>)['gsd'] as {
            __test: { mock: (channel: string, handler: unknown) => void };
          };
          gsd.__test.mock('costs.estimate', () => Promise.resolve(estimate));
          gsd.__test.mock('costs.actual', (days: unknown) =>
            Promise.resolve((days as number) >= 30 ? a60 : a14),
          );
          gsd.__test.mock('games.status', () => Promise.resolve(statuses));
        },
        { estimate: COST_DATA, statuses: [STOPPED_GAME], a14: actual14, a60: actual60 },
      );

      await costs.gotoElectron();

      await expect(costs.totalLabel(7)).toBeVisible();
      await costs.selectRange('30d', 30);
      await expect(costs.totalLabel(30)).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
