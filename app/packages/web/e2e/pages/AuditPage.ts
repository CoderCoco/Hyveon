import type { Page, Locator } from '@playwright/test';

/**
 * Page object for the `/audit` route added in issue #102. Wraps the audit
 * log table's summary rows (rendered by `AuditEntryRow`), the expand/collapse
 * toggle, the before/after diff detail row, and the "Load more" pagination
 * button so spec files read as test logic rather than locator soup.
 */
export class AuditPage {
  constructor(public readonly page: Page) {}

  /** Navigate to `/audit` directly via URL. */
  async goto(): Promise<void> {
    await this.page.goto('/audit');
  }

  /** "Audit Log" page heading — used as a "the page mounted" smoke check. */
  heading(): Locator {
    return this.page.getByRole('heading', { name: 'Audit Log', level: 2 });
  }

  /** Empty-state message shown when there are no audit entries. */
  emptyStateMessage(): Locator {
    return this.page.getByText('No audit entries yet.');
  }

  /**
   * The nth summary row (0-indexed, newest first) rendered by
   * `AuditEntryRow`. Scoped to `tr` elements containing an
   * `aria-expanded` button — only the summary row's expand/collapse
   * toggle carries that attribute in production (the expanded detail row
   * has no such button), so this stays stable whether or not other rows
   * are currently expanded.
   */
  entryRow(n: number): Locator {
    return this.page.locator('tr:has(button[aria-expanded])').nth(n);
  }

  /** Expand/collapse toggle button inside the nth summary row. */
  expandButton(n: number): Locator {
    return this.entryRow(n).getByRole('button', { name: /(expand|collapse) diff/i });
  }

  /** Click the nth summary row's expand/collapse toggle. */
  async expandRow(n: number): Promise<void> {
    await this.expandButton(n).click();
  }

  /**
   * The expanded before/after diff row, rendered as the `<tr>` immediately
   * following the nth summary row once it's expanded. Contains two `<pre>`
   * blocks with the raw JSON `before`/`after` config.
   */
  detailRow(n: number): Locator {
    return this.entryRow(n).locator('xpath=following-sibling::tr[1]');
  }

  /** "Load more" pagination button, visible while a `nextBefore` cursor is present. */
  loadMoreButton(): Locator {
    return this.page.getByRole('button', { name: 'Load more' });
  }
}
