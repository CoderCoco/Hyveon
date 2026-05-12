import type { Page, Locator } from '@playwright/test';

/** Detected log level — drives the per-line badge color and the Levels filter. */
export type LogLevelLabel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

/**
 * Page object for the `/logs` route added in CoderCoco/Hyveon#63.
 * Wraps the LIVE/PAUSED pill, the searchable game combobox, the in-stream
 * search input, the Levels multi-select, the autoscroll toggle, the
 * Pause/Resume button, the log box, and the footer line-count summary so
 * spec files read as test logic rather than locator soup.
 */
export class LogsPage {
  constructor(public readonly page: Page) {}

  /** Navigate to `/logs` directly. */
  async goto(): Promise<void> {
    await this.page.goto('/logs');
  }

  // ── Header ───────────────────────────────────────────────────────────

  /** "Server Logs" heading — used as a "the page mounted" smoke check. */
  heading(): Locator {
    return this.page.getByRole('heading', { name: 'Server Logs' });
  }

  /**
   * The LIVE/PAUSED status pill. Exact-match prevents the badge from
   * substring-matching incidental words ("Lively", "Alive") inside log
   * lines.
   */
  liveBadge(): Locator {
    return this.page.getByText('Live', { exact: true });
  }

  /** Counterpart to `liveBadge()` — visible while the stream is paused. */
  pausedBadge(): Locator {
    return this.page.getByText('Paused', { exact: true });
  }

  // ── Toolbar ──────────────────────────────────────────────────────────

  /**
   * Game combobox trigger. The `aria-label` always starts with
   * `"Game selector"` so the regex matches regardless of which game is
   * currently selected.
   */
  gameComboboxTrigger(): Locator {
    return this.page.getByRole('button', { name: /^Game selector/ });
  }

  /** Search input rendered inside the combobox popover after it opens. */
  gameSearchInput(): Locator {
    return this.page.getByPlaceholder('Search games…');
  }

  /** Filtered game item inside the open popover, by game name. */
  gameOption(name: string): Locator {
    return this.page.getByRole('button', { name, exact: true });
  }

  /**
   * Open the combobox, type into the search filter, and click the
   * matching game option. The trigger collapses on selection.
   */
  async selectGame(name: string): Promise<void> {
    await this.gameComboboxTrigger().click();
    await this.gameSearchInput().fill(name);
    await this.gameOption(name).click();
  }

  /** In-stream search input that highlights matches in the visible buffer. */
  searchInput(): Locator {
    return this.page.getByPlaceholder('Search visible buffer…');
  }

  /** Type into the in-stream search input and let React re-render highlights. */
  async search(query: string): Promise<void> {
    await this.searchInput().fill(query);
  }

  /**
   * Levels multi-select trigger. The button label reads `Levels (N/4)`,
   * so a `/Levels/` regex matches no matter how many levels are currently
   * shown — narrow with `levelsTriggerWithCount` for an exact count.
   */
  levelsTrigger(): Locator {
    return this.page.getByRole('button', { name: /Levels/ });
  }

  /** Levels trigger asserted to display a specific visible-count (e.g. `3/4`). */
  levelsTriggerWithCount(visible: number, total = 4): Locator {
    // The button's accessible name is the visible text "Levels (V/T)". Exact
    // match on a literal string avoids constructing a dynamic regex (and the
    // CodeQL "incomplete string escaping" alert that comes with it).
    return this.page.getByRole('button', { name: `Levels (${visible}/${total})`, exact: true });
  }

  /** Checkbox item inside the open Levels menu, by level label. */
  levelMenuItem(level: LogLevelLabel): Locator {
    return this.page.getByRole('menuitemcheckbox', { name: level });
  }

  /**
   * Open the Levels menu, toggle a level off (or on), and dismiss the menu
   * with Escape so subsequent assertions aren't obscured by the popover.
   * The menu stays open by design (`onSelect` preventDefault) so we close
   * it explicitly here.
   */
  async toggleLevel(level: LogLevelLabel): Promise<void> {
    await this.levelsTrigger().click();
    await this.levelMenuItem(level).click();
    await this.page.keyboard.press('Escape');
  }

  /** Autoscroll checkbox — wrapped in a `<label>` with text "Autoscroll". */
  autoscrollCheckbox(): Locator {
    return this.page.getByLabel('Autoscroll');
  }

  /** Pause/Resume button. The accessible name flips with the state. */
  pauseButton(): Locator {
    return this.page.getByRole('button', { name: 'Pause' });
  }

  /** Counterpart to `pauseButton()` — visible while the stream is paused. */
  resumeButton(): Locator {
    return this.page.getByRole('button', { name: 'Resume' });
  }

  // ── Log stream ───────────────────────────────────────────────────────

  /**
   * A `<mark>` highlight rendered by the in-stream search. Without a
   * search query active the page contains zero `<mark>` elements, so this
   * is a stable signal for "search-highlighting is working".
   */
  highlightMarks(): Locator {
    return this.page.locator('mark');
  }

  /** A specific search highlight by exact matched text. */
  highlightMark(text: string): Locator {
    return this.page.locator('mark', { hasText: text });
  }

  /**
   * The first level badge of a given level inside the log box. Each
   * matching line renders one badge; this picks the first occurrence
   * which is enough to assert "this level was detected at all".
   */
  levelBadge(level: LogLevelLabel): Locator {
    return this.page.getByText(level, { exact: true }).first();
  }

  // ── Footer ───────────────────────────────────────────────────────────

  /**
   * Footer summary line — `<N> lines · oldest <age>` plus optional
   * "<K> levels hidden" / "buffered N" suffixes. `count` anchors the
   * regex to the start so unrelated `5` substrings elsewhere don't
   * match.
   */
  footerLineCount(count: number): Locator {
    return this.page.getByText(new RegExp(`^${count} lines? · oldest `));
  }
}
