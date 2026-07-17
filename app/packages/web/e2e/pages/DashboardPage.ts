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

  /**
   * Show the dashboard inside the Electron shell, where `page.goto('/')` is an
   * invalid URL — the packaged app loads from a `file://` origin with no
   * dev-server base. Instead of navigating by URL this:
   *
   *  1. Returns to the `/` route via in-app history navigation (a full reload
   *     would re-run the preload and wipe the `window.gsd.__test` mock registry
   *     that the test just seeded), so it works even after a sidebar-nav test
   *     left the app on another route.
   *  2. Clicks the top-bar "Refresh all" button. The app-level status poller
   *     fires once at launch — before the test registers its IPC mocks — so the
   *     grid must be re-fetched for the seeded `games.status` mock to take
   *     effect.
   *
   * Call after `applyGsdMocks()` so the mocks are in place before the refresh.
   */
  async gotoElectron(): Promise<void> {
    await this.page.evaluate(() => {
      window.history.pushState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    });
    // Wait for the launch-time status poll to settle before refreshing. While
    // a poll is in flight the registry's `inFlight` guard would silently drop
    // a `refreshAll()`, so the seeded mock would never be re-fetched. The
    // top-bar button mirrors that state via `aria-busy`, so it's a reliable
    // "the poller is idle" signal to gate the click on.
    await this.page.waitForFunction(() => {
      const btn = document.querySelector('button[aria-label="Refresh all"]');
      return btn !== null && !btn.hasAttribute('disabled') && btn.getAttribute('aria-busy') === 'false';
    });
    await this.page.getByRole('button', { name: 'Refresh all' }).click();
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

  // ── Pending changes banner (issue #101) ──────────────────────────────

  /** The `PendingChangesBanner` container (`role="status"`), when it's visible. */
  pendingChangesBanner(): Locator {
    return this.page.getByRole('status').filter({ hasText: 'tfvars edited' });
  }

  /** "View pending" link inside the banner, which routes to `/games`. */
  viewPendingLink(): Locator {
    return this.pendingChangesBanner().getByRole('link', { name: 'View pending' });
  }

  /** Dismiss ("X") button inside the banner. */
  dismissBannerButton(): Locator {
    return this.page.getByRole('button', { name: 'Dismiss pending changes banner' });
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
