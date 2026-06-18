import type { Page, Locator } from '@playwright/test';

/** Status-badge labels rendered by the redesigned `GameCard` (issue #60). */
export type ServerStateLabel =
  | 'RUNNING'
  | 'STARTING'
  | 'STOPPED'
  | 'NOT DEPLOYED'
  | 'ERROR';

/**
 * Page object for the dashboard route (`/`). Wraps the KPI strip, the search
 * filter, the GameCard grid, and the per-card action buttons so spec files
 * read as test logic rather than locator soup.
 */
export class DashboardPage {
  constructor(public readonly page: Page) {}

  /** Navigate to the dashboard root. */
  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  // ── GameCard grid ────────────────────────────────────────────────────

  /** `<h3>` element inside a card whose game name matches `name`. */
  gameCardHeading(name: string): Locator {
    return this.page.getByRole('heading', { name });
  }

  /** Status badge by its rendered text label (RUNNING / STOPPED / etc.). */
  statusBadge(state: ServerStateLabel): Locator {
    // exact: true prevents CSS-uppercase KPI labels ("SERVERS RUNNING") from
    // substring-matching when Playwright evaluates innerText.
    return this.page.getByText(state, { exact: true });
  }

  /** Empty-state card heading shown when no games are deployed. */
  emptyConfiguredMessage(): Locator {
    return this.page.getByRole('heading', { name: /no games deployed/i });
  }

  /** "Open setup guide" CTA link inside the no-games card. */
  setupGuideLink(): Locator {
    return this.page.getByRole('link', { name: /open setup guide/i });
  }

  /** "Edit terraform.tfvars" CTA link inside the no-games card. */
  tfvarsLink(): Locator {
    return this.page.getByRole('link', { name: /terraform\.tfvars/i });
  }

  /** Empty-state when the search input filters out every card. */
  emptySearchMessage(): Locator {
    return this.page.getByText(/no games match/i);
  }

  // ── Card action buttons ──────────────────────────────────────────────

  /** IP address / hostname text rendered on a running game card. */
  gameIpAddress(hostname: string): Locator {
    return this.page.getByText(hostname);
  }

  /** Primary CTA shown on a stopped/not-deployed/error card. */
  startButton(): Locator {
    return this.page.getByRole('button', { name: 'Start' });
  }

  /** Primary CTA shown on a running/starting card. */
  stopButton(): Locator {
    return this.page.getByRole('button', { name: 'Stop' });
  }

  /** Confirmation button inside the stop-confirmation dialog. */
  confirmStopButton(): Locator {
    return this.page.getByRole('button', { name: /stop server/i });
  }

  // ── Search filter ────────────────────────────────────────────────────

  /** Search input above the grid that filters by game name or hostname. */
  searchInput(): Locator {
    return this.page.getByLabel('Filter games');
  }

  /** Type into the search input and let React rerender the filtered grid. */
  async filter(query: string): Promise<void> {
    await this.searchInput().fill(query);
  }

  // ── KPI strip ────────────────────────────────────────────────────────

  /** A KPI tile by its label ('Servers running', 'Spend today', etc.). */
  kpiTileLabel(label: string): Locator {
    return this.page.getByText(label);
  }

  /** The "Servers running" KPI value (e.g. "1/2"). */
  serversRunningValue(value: string): Locator {
    return this.page.getByText(value, { exact: true });
  }
}
