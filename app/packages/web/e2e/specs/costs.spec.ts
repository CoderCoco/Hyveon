import { test, expect, stubApis, MULTI_GAME_COST_DATA } from '../fixtures/index.js';

/**
 * Specs for the `/costs` route added in CoderCoco/Hyveon#61.
 * Filter / sort exercises pass `MULTI_GAME_COST_DATA` so the table has more
 * than one row to interact with; the default `COST_DATA` only contains
 * `minecraft`.
 */
test.describe('costs page', () => {
  test('should render the cost analysis heading', async ({ costs }) => {
    await stubApis(costs.page);
    await costs.goto();

    await expect(costs.heading()).toBeVisible();
  });

  test('should display the trailing-window total spend KPI', async ({ costs }) => {
    await stubApis(costs.page);
    await costs.goto();

    await expect(costs.totalLabel(7)).toBeVisible();
    // Page fetches `days*2 = 14` once and uses the newer 7 entries as the
    // current window. `makeActualCosts(14)` puts $1.00/day in the second
    // half, so the current total is 7 × $1.00 = $7.00.
    await expect(costs.page.getByText('$7.00').first()).toBeVisible();
  });

  test('should render a delta-vs-prior pill', async ({ costs }) => {
    await stubApis(costs.page);
    await costs.goto();

    // Two-tier daily cost makes current > prior, so the pill shows the
    // "vs prior" suffix rather than the "no prior period" fallback.
    await expect(costs.page.getByText('vs prior')).toBeVisible();
  });

  test('should render stacked bar segments for each game', async ({ costs }) => {
    await stubApis(costs.page, { costs: MULTI_GAME_COST_DATA });
    await costs.goto();

    await expect(costs.chartTitle()).toBeVisible();
    await expect(costs.chartSegment('minecraft').first()).toBeVisible();
    await expect(costs.chartSegment('valheim').first()).toBeVisible();
    await expect(costs.chartSegment('palworld').first()).toBeVisible();
  });

  test('should sort estimates by $/hour descending by default', async ({ costs }) => {
    await stubApis(costs.page, { costs: MULTI_GAME_COST_DATA });
    await costs.goto();

    const rows = costs.tableRows();
    // Row 0 is the header; rows 1..3 are the games sorted $/hr desc:
    // palworld ($0.32) > valheim ($0.16) > minecraft ($0.08).
    await expect(rows.nth(1)).toContainText('palworld');
    await expect(rows.nth(2)).toContainText('valheim');
    await expect(rows.nth(3)).toContainText('minecraft');
  });

  test('should re-sort estimates by game name when the Game header is clicked', async ({ costs }) => {
    await stubApis(costs.page, { costs: MULTI_GAME_COST_DATA });
    await costs.goto();

    await costs.clickSort('Game');

    const rows = costs.tableRows();
    // After clicking Game, default direction is ascending alphabetical.
    await expect(rows.nth(1)).toContainText('minecraft');
    await expect(rows.nth(2)).toContainText('palworld');
    await expect(rows.nth(3)).toContainText('valheim');
  });

  test('should filter estimates via the search input', async ({ costs }) => {
    await stubApis(costs.page, { costs: MULTI_GAME_COST_DATA });
    await costs.goto();

    await costs.filter('val');

    await expect(costs.page.getByRole('cell', { name: /valheim/ })).toBeVisible();
    await expect(costs.page.getByRole('cell', { name: /minecraft/ })).toHaveCount(0);
    await expect(costs.page.getByRole('cell', { name: /palworld/ })).toHaveCount(0);
  });

  test('should switch the active window when clicking 30d', async ({ costs }) => {
    await stubApis(costs.page);
    await costs.goto();

    await expect(costs.totalLabel(7)).toBeVisible();
    await costs.selectRange('30d', 30);
    await expect(costs.totalLabel(30)).toBeVisible();
  });
});
