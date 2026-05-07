import {
  test,
  expect,
  stubApis,
  CONFIGURED_DISCORD_CONFIG,
  FIRST_RUN_DISCORD_CONFIG,
  MULTI_GAME_STATUSES,
  STOPPED_GAME,
  VALID_GUILD_ID,
  VALID_GUILD_ID_2,
  VALID_USER_ID,
  AppLayout,
  type DiscordConfigRedacted,
} from '../fixtures/index.js';

test.describe('discord settings', () => {
  test('should show the setup wizard when no guilds and no bot token are configured', async ({
    authedPage: page,
  }) => {
    await stubApis(page, { discord: FIRST_RUN_DISCORD_CONFIG });
    await page.goto('/discord');

    await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();
    await expect(page.getByRole('link', { name: /developers\/applications/i })).toBeVisible();
  });

  test('should hide the setup wizard once a guild is allowlisted', async ({
    authedPage: page,
  }) => {
    await stubApis(page, { discord: CONFIGURED_DISCORD_CONFIG });
    await page.goto('/discord');

    await expect(page.getByRole('heading', { name: 'Discord' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Get started' })).not.toBeVisible();
  });

  test('should render the Credentials tab by default', async ({ authedPage: page }) => {
    await stubApis(page, { discord: CONFIGURED_DISCORD_CONFIG });
    await page.goto('/discord');

    await expect(page.getByLabel('Application (Client) ID')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save credentials' })).toBeVisible();
  });

  test('should show a "set" indicator when the bot token is already configured', async ({
    authedPage: page,
  }) => {
    await stubApis(page, { discord: CONFIGURED_DISCORD_CONFIG });
    await page.goto('/discord');

    // Both the green-check badge (aria-label) and the helper text render when
    // the secret is already set server-side.
    await expect(page.locator('[aria-label="Already set"]').first()).toBeVisible();
    await expect(page.getByText('Already set — leave blank to keep').first()).toBeVisible();
  });

  test('should toggle bot-token visibility when the eye icon is clicked', async ({
    authedPage: page,
  }) => {
    await stubApis(page, { discord: CONFIGURED_DISCORD_CONFIG });
    await page.goto('/discord');

    const tokenField = page.locator('#bot-token');
    await expect(tokenField).toHaveAttribute('type', 'password');

    await page.getByRole('button', { name: 'Show value' }).first().click();
    await expect(tokenField).toHaveAttribute('type', 'text');

    await page.getByRole('button', { name: 'Hide value' }).first().click();
    await expect(tokenField).toHaveAttribute('type', 'password');
  });

  test('should never echo the bot token or public key in the config response', async ({
    authedPage: page,
  }) => {
    await stubApis(page, { discord: CONFIGURED_DISCORD_CONFIG });

    const responsePromise = page.waitForResponse('**/api/discord/config');
    await page.goto('/discord');
    const response = await responsePromise;

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('botToken');
    expect(body).not.toHaveProperty('publicKey');
    expect(body).toHaveProperty('botTokenSet');
    expect(body).toHaveProperty('publicKeySet');
  });

  test('should switch to the Guilds tab when clicked', async ({ authedPage: page }) => {
    await stubApis(page, { discord: CONFIGURED_DISCORD_CONFIG });
    await page.goto('/discord');

    await page.getByRole('tab', { name: 'Guilds' }).click();
    await expect(page.getByLabel('Add a guild')).toBeVisible();
  });

  test('should reject a malformed guild snowflake with an inline error', async ({
    authedPage: page,
  }) => {
    await stubApis(page, { discord: CONFIGURED_DISCORD_CONFIG });

    let addCalled = false;
    await page.route('**/api/discord/guilds', (route) => {
      if (route.request().method() === 'POST') addCalled = true;
      return route.fulfill({
        json: { success: true, guilds: CONFIGURED_DISCORD_CONFIG.allowedGuilds },
      });
    });

    await page.goto('/discord');
    await page.getByRole('tab', { name: 'Guilds' }).click();

    await page.getByLabel('Add a guild').fill('not-a-snowflake');
    await page.getByRole('button', { name: 'Add' }).click();

    await expect(page.getByText(/17.20 digit Discord snowflakes/i)).toBeVisible();
    expect(addCalled).toBe(false);
  });

  test('should POST a valid snowflake to /api/discord/guilds', async ({ authedPage: page }) => {
    await stubApis(page, { discord: CONFIGURED_DISCORD_CONFIG });

    let postedBody: Record<string, unknown> | null = null;
    await page.route('**/api/discord/guilds', async (route) => {
      if (route.request().method() === 'POST') {
        postedBody = route.request().postDataJSON() as Record<string, unknown>;
      }
      await route.fulfill({
        json: { success: true, guilds: [...CONFIGURED_DISCORD_CONFIG.allowedGuilds, VALID_GUILD_ID_2] },
      });
    });

    await page.goto('/discord');
    await page.getByRole('tab', { name: 'Guilds' }).click();
    await page.getByLabel('Add a guild').fill(VALID_GUILD_ID_2);
    await page.getByRole('button', { name: 'Add' }).click();

    await expect.poll(() => postedBody).toEqual({ guildId: VALID_GUILD_ID_2 });
  });

  test('should list configured guilds in the Guilds table', async ({ authedPage: page }) => {
    await stubApis(page, { discord: CONFIGURED_DISCORD_CONFIG });
    await page.goto('/discord');
    await page.getByRole('tab', { name: 'Guilds' }).click();

    for (const id of CONFIGURED_DISCORD_CONFIG.allowedGuilds) {
      await expect(page.getByRole('cell', { name: id })).toBeVisible();
    }
  });

  test('should mark a guild as registered after a successful register-commands call', async ({
    authedPage: page,
  }) => {
    await stubApis(page, { discord: CONFIGURED_DISCORD_CONFIG });
    await page.goto('/discord');
    await page.getByRole('tab', { name: 'Guilds' }).click();

    const row = page.getByRole('row').filter({ hasText: VALID_GUILD_ID });
    await expect(row.getByText('not registered')).toBeVisible();

    await row.getByRole('button', { name: 'Register' }).click();

    await expect(row.getByText('registered', { exact: true })).toBeVisible();
    await expect(row.getByText('not registered')).toHaveCount(0);
  });

  test('should reject adding a guild that is already allowlisted', async ({
    authedPage: page,
  }) => {
    await stubApis(page, { discord: CONFIGURED_DISCORD_CONFIG });

    let addCalled = false;
    await page.route('**/api/discord/guilds', (route) => {
      if (route.request().method() === 'POST') addCalled = true;
      return route.fulfill({
        json: { success: true, guilds: CONFIGURED_DISCORD_CONFIG.allowedGuilds },
      });
    });

    await page.goto('/discord');
    await page.getByRole('tab', { name: 'Guilds' }).click();

    // VALID_GUILD_ID is already in allowedGuilds — adding it again would
    // create a duplicate row with a colliding React key.
    await page.getByLabel('Add a guild').fill(VALID_GUILD_ID);
    await page.getByRole('button', { name: 'Add' }).click();

    await expect(page.getByText(/already allowlisted/i)).toBeVisible();
    expect(addCalled).toBe(false);
  });

  test('should leave a guild not-registered when register-commands fails', async ({
    authedPage: page,
  }) => {
    await stubApis(page, { discord: CONFIGURED_DISCORD_CONFIG });

    // Override the success stub from stubApis so the register-commands call
    // returns 500 and the wrap()-driven Promise rejects. Tracks the call so
    // the assertion can wait until after the failure resolves.
    let registerCalled = false;
    await page.route('**/api/discord/guilds/*/register-commands', (route) => {
      registerCalled = true;
      return route.fulfill({ status: 500, json: { error: 'discord rejected' } });
    });

    await page.goto('/discord');
    await page.getByRole('tab', { name: 'Guilds' }).click();

    const row = page.getByRole('row').filter({ hasText: VALID_GUILD_ID });
    await expect(row.getByText('not registered')).toBeVisible();

    await row.getByRole('button', { name: 'Register' }).click();

    await expect.poll(() => registerCalled).toBe(true);

    // Badge must stay in the not-registered state — the optimistic-success
    // flip would otherwise lie about a registration that never happened.
    await expect(row.getByText('not registered')).toBeVisible();
    await expect(row.getByText('registered', { exact: true })).toHaveCount(0);
  });

  test('should render a row per game in the per-game permissions table', async ({
    authedPage: page,
  }) => {
    await stubApis(page, {
      discord: CONFIGURED_DISCORD_CONFIG,
      statuses: MULTI_GAME_STATUSES,
    });
    await page.goto('/discord');
    await page.getByRole('tab', { name: 'Per-Game Permissions' }).click();

    for (const s of MULTI_GAME_STATUSES) {
      await expect(page.getByRole('cell', { name: s.game, exact: true })).toBeVisible();
    }
  });

  test('should reset chips on a permission row after Clear', async ({ authedPage: page }) => {
    const withPerms: DiscordConfigRedacted = {
      ...CONFIGURED_DISCORD_CONFIG,
      gamePermissions: {
        minecraft: { userIds: [VALID_USER_ID], roleIds: [], actions: ['start'] },
      },
    };
    const withoutPerms = CONFIGURED_DISCORD_CONFIG;

    await stubApis(page, { discord: withPerms, statuses: [STOPPED_GAME] });

    // After the DELETE lands, swap the GET stub so the next refresh() returns
    // the cleared config — that's when the row's local state must reset.
    let cleared = false;
    await page.route('**/api/discord/permissions/*', (route) => {
      if (route.request().method() === 'DELETE') cleared = true;
      return route.fulfill({
        json: {
          success: true,
          permissions: cleared ? withoutPerms.gamePermissions : withPerms.gamePermissions,
        },
      });
    });
    await page.route('**/api/discord/config', (route) => {
      if (route.request().method() === 'PUT') {
        return route.fulfill({ json: { success: true, config: cleared ? withoutPerms : withPerms } });
      }
      return route.fulfill({ json: cleared ? withoutPerms : withPerms });
    });

    await page.goto('/discord');
    await page.getByRole('tab', { name: 'Per-Game Permissions' }).click();

    const row = page.getByRole('row').filter({ hasText: 'minecraft' });
    await expect(row.getByText(VALID_USER_ID)).toBeVisible();

    await row.getByRole('button', { name: 'Clear' }).click();

    // Without the re-key fix, the deleted user-ID chip would linger here
    // because PermissionRow's local state is keyed only by game name.
    await expect(row.getByText(VALID_USER_ID)).toHaveCount(0);
  });

  test('should show the not-deployed empty state when /api/discord/config 404s', async ({
    authedPage: page,
  }) => {
    // Override stubApis so /api/discord/config returns 404 — the page should
    // surface the friendly "infrastructure not deployed yet" state.
    await stubApis(page, { statuses: [STOPPED_GAME] });
    await page.route('**/api/discord/config', (route) =>
      route.fulfill({ status: 404, json: { error: 'not deployed' } }),
    );

    await page.goto('/discord');
    await expect(page.getByText(/infrastructure not deployed yet/i)).toBeVisible();
  });

  test('should show a success toast after saving credentials', async ({ authedPage: page }) => {
    await stubApis(page, { discord: CONFIGURED_DISCORD_CONFIG });
    await page.goto('/discord');

    // Credentials tab is the default — wait for the form to be ready.
    await expect(page.getByRole('button', { name: 'Save credentials' })).toBeVisible();
    await page.getByRole('button', { name: 'Save credentials' }).click();

    const layout = new AppLayout(page);
    await expect(layout.toastMessage('Credentials saved')).toBeVisible();
  });
});
