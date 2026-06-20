import type { Page, Locator } from '@playwright/test';

/**
 * Page object for the Discord settings route (`/discord`). Wraps all
 * locators used by the discord spec so no `page.getByX` calls appear
 * inline in the spec file.
 */
export class DiscordPage {
  constructor(public readonly page: Page) {}

  /**
   * Navigate to `/discord` using a two-step `history.pushState` / `PopStateEvent`
   * pattern so React Router re-renders at the correct route without a full page
   * reload. A direct `page.goto('/discord')` would resolve against the `file://`
   * base URL used by `loadFile()` and produce `file:///discord`, which matches no
   * route.
   *
   * Step 1 pushes to `/` to unmount any previously mounted Discord component;
   * Step 2 pushes to `/discord` so the component mounts fresh with mocks already
   * in place for the global polling providers and the Discord page's own effects.
   */
  async goto(): Promise<void> {
    // Step 1 — unmount any previously mounted Discord page.
    await this.page.evaluate(() => {
      window.history.pushState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    // Step 2 — navigate to /discord so the component mounts with mocks in place.
    await this.page.evaluate(() => {
      window.history.pushState({}, '', '/discord');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
  }

  // ── Page-level headings ──────────────────────────────────────────────

  /** The main "Discord" page heading shown when the bot is configured. */
  pageHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Discord' });
  }

  /** The "Get started" wizard heading shown on first-run / unconfigured state. */
  wizardHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Get started' });
  }

  // ── Setup wizard ─────────────────────────────────────────────────────

  /** Link to the Discord developer applications portal inside the wizard. */
  developerPortalLink(): Locator {
    return this.page.getByRole('link', { name: /developers\/applications/i });
  }

  /**
   * The wizard step text that describes pasting credentials. Struck-through
   * (CSS `text-decoration-line: line-through`) once the step is complete.
   */
  credentialsWizardStep(): Locator {
    return this.page.getByText(/Paste those values into the/i);
  }

  /** Friendly "infrastructure not deployed yet" empty state text. */
  notDeployedMessage(): Locator {
    return this.page.getByText(/infrastructure not deployed yet/i);
  }

  // ── Tabs ─────────────────────────────────────────────────────────────

  /** The "Guilds" tab button. */
  guildsTab(): Locator {
    return this.page.getByRole('tab', { name: 'Guilds' });
  }

  /** The "Per-Game Permissions" tab button. */
  perGamePermissionsTab(): Locator {
    return this.page.getByRole('tab', { name: 'Per-Game Permissions' });
  }

  // ── Credentials tab ──────────────────────────────────────────────────

  /** The "Application (Client) ID" labelled input on the Credentials tab. */
  clientIdField(): Locator {
    return this.page.getByLabel('Application (Client) ID');
  }

  /** "Save credentials" submit button on the Credentials tab. */
  saveCredentialsButton(): Locator {
    return this.page.getByRole('button', { name: 'Save credentials' });
  }

  /**
   * The first green-check badge with `aria-label="Already set"` indicating a
   * secret is already stored server-side.
   */
  alreadySetBadge(): Locator {
    return this.page.locator('[aria-label="Already set"]').first();
  }

  /** The first helper text "Already set — leave blank to keep". */
  alreadySetHelperText(): Locator {
    return this.page.getByText('Already set — leave blank to keep').first();
  }

  /** The bot-token password/text input (id `bot-token`). */
  botTokenField(): Locator {
    return this.page.locator('#bot-token');
  }

  /** The first "Show value" toggle button for a secret field. */
  showSecretButton(): Locator {
    return this.page.getByRole('button', { name: 'Show value' }).first();
  }

  /** The first "Hide value" toggle button for a secret field. */
  hideSecretButton(): Locator {
    return this.page.getByRole('button', { name: 'Hide value' }).first();
  }

  // ── Guilds tab ───────────────────────────────────────────────────────

  /** The "Add a guild" labelled input on the Guilds tab. */
  addGuildInput(): Locator {
    return this.page.getByLabel('Add a guild');
  }

  /** The "Add" submit button next to the add-guild input. */
  addGuildButton(): Locator {
    return this.page.getByRole('button', { name: 'Add' });
  }

  /**
   * Inline validation error shown when a non-snowflake value is entered.
   * Text matches `/17.20 digit Discord snowflakes/i`.
   */
  snowflakeValidationError(): Locator {
    return this.page.getByText(/17.20 digit Discord snowflakes/i);
  }

  /**
   * Inline error shown when the entered guild ID is already allowlisted.
   * Text matches `/already allowlisted/i`.
   */
  alreadyAllowlistedError(): Locator {
    return this.page.getByText(/already allowlisted/i);
  }

  /** A cell in the guilds table whose text matches the given guild ID. */
  guildCell(guildId: string): Locator {
    return this.page.getByRole('cell', { name: guildId });
  }

  /** The table row that contains the given guild ID text. */
  guildRow(guildId: string): Locator {
    return this.page.getByRole('row').filter({ hasText: guildId });
  }

  /**
   * The "not registered" status text inside the guild row for the given ID.
   * Scoped to the matching row so assertions are unambiguous when multiple
   * guilds are listed.
   */
  guildRowNotRegisteredBadge(guildId: string): Locator {
    return this.guildRow(guildId).getByText('not registered');
  }

  /**
   * The "registered" (exact) status text inside the guild row for the given
   * ID. Uses `exact: true` to avoid matching "not registered".
   */
  guildRowRegisteredBadge(guildId: string): Locator {
    return this.guildRow(guildId).getByText('registered', { exact: true });
  }

  /** The "Register" action button inside the guild row for the given ID. */
  guildRowRegisterButton(guildId: string): Locator {
    return this.guildRow(guildId).getByRole('button', { name: 'Register' });
  }

  // ── Per-game permissions tab ─────────────────────────────────────────

  /**
   * A cell in the per-game permissions table whose text exactly matches the
   * given game name.
   */
  gamePermissionCell(game: string): Locator {
    return this.page.getByRole('cell', { name: game, exact: true });
  }

  /** The table row in the per-game permissions table for the given game. */
  permissionsRow(game: string): Locator {
    return this.page.getByRole('row').filter({ hasText: game });
  }

  /**
   * A chip/text element inside the per-game permissions row showing the given
   * user ID.
   */
  permissionsRowUserId(game: string, userId: string): Locator {
    return this.permissionsRow(game).getByText(userId);
  }

  /** The "Clear" action button inside the per-game permissions row for a game. */
  permissionsRowClearButton(game: string): Locator {
    return this.permissionsRow(game).getByRole('button', { name: 'Clear' });
  }
}
