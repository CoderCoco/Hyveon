import type { Page, Locator } from '@playwright/test';

/** Drift-status chip labels rendered by `GameStatusBadges` (issue #93). */
export type DriftLabel = 'In sync' | 'Pending deploy' | 'Undeclared';

/**
 * Page object for the read-only Games routes added in issue #93: the
 * declared/deployed drift table at `/games` and the per-game detail view at
 * `/games/:name`. Wraps both routes' locators so spec files read as test
 * logic rather than locator soup.
 */
export class GamesPage {
  constructor(public readonly page: Page) {}

  /** Navigate to the games list route. */
  async goto(): Promise<void> {
    await this.page.goto('/games');
  }

  /** Navigate directly to a game's detail route. */
  async gotoDetail(name: string): Promise<void> {
    await this.page.goto(`/games/${name}`);
  }

  // ── List page (`/games`) ─────────────────────────────────────────────

  /** "Games" page heading — used as a "the list page mounted" smoke check. */
  heading(): Locator {
    return this.page.getByRole('heading', { name: 'Games', level: 2 });
  }

  /** Empty-state message shown when no games are declared or deployed. */
  emptyStateMessage(): Locator {
    return this.page.getByText('No games declared or deployed yet.');
  }

  /** Row link to a game's detail route, by game name. */
  gameLink(name: string): Locator {
    return this.page.getByRole('link', { name });
  }

  /** Click a game's row link and wait for the detail route to load. */
  async openGame(name: string): Promise<void> {
    await this.gameLink(name).click();
    await this.page.waitForURL((url) => url.pathname === `/games/${name}`);
  }

  /** All table rows including the header — index 0 is the header, 1.. are games. */
  tableRows(): Locator {
    return this.page.getByRole('row');
  }

  /**
   * A `<td>` or `<th>` cell whose accessible name matches `name` (string or
   * regex). Pass a `RegExp` for partial matches.
   */
  tableCell(name: string | RegExp): Locator {
    return this.page.getByRole('cell', { name });
  }

  /** Drift-status chip by its rendered label ("In sync" / "Pending deploy" / "Undeclared"). */
  driftChip(label: DriftLabel): Locator {
    return this.page.getByText(label, { exact: true });
  }

  // ── Detail page (`/games/:name`) ─────────────────────────────────────

  /** "Back to games" link at the top of the detail page. */
  backLink(): Locator {
    return this.page.getByRole('link', { name: /back to games/i });
  }

  /** Detail-page `<h2>` heading — the game name (page-level, not a panel title). */
  detailHeading(name: string): Locator {
    return this.page.getByRole('heading', { name, level: 2, exact: true });
  }

  /** "No such game" message shown when `:name` matches no merged entry. */
  notFoundMessage(name: string): Locator {
    return this.page.getByText(new RegExp(`No game named\\s+"${name}"\\s+was found`, 'i'));
  }

  /** Ghost-row message shown when a game is deployed but has no declared config. */
  ghostMessage(): Locator {
    return this.page.getByText(/deployed but has no entry in/i);
  }

  /** Config panel `<h3>` card title by its visible label ("Container", "Ports", "Volumes", ...). */
  panelTitle(label: string): Locator {
    return this.page.getByRole('heading', { name: label, level: 3, exact: true });
  }

  /** File-seeds `<summary>` toggle text, e.g. "2 files seeded at task start". */
  fileSeedsSummary(count: number): Locator {
    return this.page.getByText(new RegExp(`${count} file${count === 1 ? '' : 's'} seeded at task start`));
  }

  /** Connect-message panel body text. */
  connectMessage(text: string): Locator {
    return this.page.getByText(text);
  }
}
