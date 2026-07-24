import type { Page, Locator } from '@playwright/test';

/**
 * Page object for the `/terraform/history` route added in issue #111 —
 * the run-listing table (kind/status filters, cursor-based "Load more") and
 * the read-only run-detail view at `/terraform/history/:runId`.
 */
export class TerraformHistoryPage {
  constructor(public readonly page: Page) {}

  /** Navigate to `/terraform/history` directly via URL. */
  async goto(): Promise<void> {
    await this.page.goto('/terraform/history');
  }

  /** Navigate to a single run's read-only detail view directly via URL. */
  async gotoDetail(runId: string): Promise<void> {
    await this.page.goto(`/terraform/history/${runId}`);
  }

  /** "Run History" page heading — used as a "the page mounted" smoke check. */
  heading(): Locator {
    return this.page.getByRole('heading', { name: 'Run History' });
  }

  /** "View history" link on the Plan/Apply page that navigates here. */
  static historyLinkOn(page: Page): Locator {
    return page.getByRole('link', { name: 'View history' });
  }

  // ── Filters ──────────────────────────────────────────────────────────

  /** The `kind` filter `<select>` (All / Plan / Apply / Destroy). */
  kindFilter(): Locator {
    return this.page.getByLabel('Kind');
  }

  /** The `status` filter `<select>` (All / Success / Failed / Aborted). */
  statusFilter(): Locator {
    return this.page.getByLabel('Status');
  }

  // ── Table ────────────────────────────────────────────────────────────

  /** Every row in the run-history table body (excludes the header row). */
  rows(): Locator {
    return this.page.getByRole('row').filter({ hasNot: this.page.getByRole('columnheader') });
  }

  /** The `kind` link for a given `runId`, which navigates to that run's detail view. */
  rowLink(runId: string): Locator {
    return this.page.locator(`a[href="/terraform/history/${runId}"]`);
  }

  /** "Load more" pagination button, present only when a further page is available. */
  loadMoreButton(): Locator {
    return this.page.getByRole('button', { name: /Load more/ });
  }

  /** Empty-state message shown when no runs match the current filters. */
  emptyStateText(): Locator {
    return this.page.getByText(/No runs match the current filters\./);
  }

  // ── Detail view ──────────────────────────────────────────────────────

  /** "Run detail" page heading on `/terraform/history/:runId`. */
  detailHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Run detail' });
  }

  /** Not-found banner shown when no record matches the route's `:runId`. */
  detailNotFoundText(): Locator {
    return this.page.getByText(/No run history record was found for/);
  }

  /** "Back to history" link on the detail view. */
  backToHistoryLink(): Locator {
    return this.page.getByRole('link', { name: 'Back to history' });
  }
}
