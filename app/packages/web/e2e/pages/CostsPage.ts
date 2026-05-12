import type { Page, Locator } from '@playwright/test';

/** Time-range selector options shown above the Costs page header. */
export type CostsRangeLabel = '7d' | '30d';

/**
 * Page object for the `/costs` route added in CoderCoco/Hyveon#61.
 * Wraps the headline KPI, the stacked bar chart, the per-game estimates
 * table, and the time-range selector so spec files read as test logic
 * rather than locator soup.
 */
export class CostsPage {
  constructor(public readonly page: Page) {}

  /** Navigate to `/costs` directly (the route isn't yet linked from the sidebar). */
  async goto(): Promise<void> {
    await this.page.goto('/costs');
  }

  // ── Headline ─────────────────────────────────────────────────────────

  /** "Cost Analysis" page heading — used as a "the page mounted" smoke check. */
  heading(): Locator {
    return this.page.getByRole('heading', { name: 'Cost Analysis' });
  }

  /** "Total spend · trailing N days/day" KPI label, asserted with a regex on `N`. */
  totalLabel(days: number): Locator {
    const unit = days === 1 ? 'day' : 'days';
    return this.page.getByText(new RegExp(`Total spend · trailing ${days} ${unit}`, 'i'));
  }

  /** Delta-vs-prior pill (or the "no prior period" fallback badge). */
  deltaPill(): Locator {
    return this.page.getByText(/vs prior|no prior period/);
  }

  // ── Range selector ───────────────────────────────────────────────────

  /** Time-range button by visible label. Only `7d` / `30d` are rendered — sub-day ranges are intentionally omitted (Cost Explorer is daily-only). */
  rangeButton(label: CostsRangeLabel): Locator {
    return this.page.getByRole('button', { name: label, exact: true });
  }

  /** Click a range button and wait for the page to refetch + re-render. */
  async selectRange(label: CostsRangeLabel, days: number): Promise<void> {
    await this.rangeButton(label).click();
    await this.totalLabel(days).waitFor();
  }

  // ── Stacked bar chart ────────────────────────────────────────────────

  /** Chart-card title — visible whenever the chart is mounted. */
  chartTitle(): Locator {
    return this.page.getByText('Daily spend, stacked by game');
  }

  /**
   * Per-game stacked bar segment matched by its `aria-label`. Each segment
   * is rendered as `aria-label="{game}: ${value}"` so it's reachable by
   * screen readers without needing to hover the Radix tooltip.
   */
  chartSegment(game: string): Locator {
    return this.page.locator(`[aria-label^="${game}: $"]`);
  }

  // ── Estimates table ──────────────────────────────────────────────────

  /** All `<tr>` rows including the header — index 0 is the header, 1.. are games. */
  tableRows(): Locator {
    return this.page.getByRole('row');
  }

  /** Sortable column header button by its visible label (`Game`, `vCPU`, `$/hour`, etc.). */
  sortHeader(label: string): Locator {
    // Anchor to the start of the label so `$/hour` doesn't match `$/hour` *and*
    // `$/hour` substrings inside other headers; `getByRole('button')` already
    // narrows to the table-header buttons so a regex anchor is enough.
    const escaped = label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return this.page.getByRole('button', { name: new RegExp(`^${escaped}`) });
  }

  /** Click a sort header to toggle the active column / direction. */
  async clickSort(label: string): Promise<void> {
    await this.sortHeader(label).click();
  }

  /** Search input above the table that filters rows by game name. */
  filterInput(): Locator {
    return this.page.getByPlaceholder('Filter games…');
  }

  /** Type into the search input and let React rerender the filtered table. */
  async filter(query: string): Promise<void> {
    await this.filterInput().fill(query);
  }
}
